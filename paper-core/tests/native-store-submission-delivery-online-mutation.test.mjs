import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
} from '../../paper-adapters/automation/autonomous-research-online-authority-journal.mjs';
import {
  createExternallyFencedSqliteMutationCoordinator,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator.mjs';
import {
  NATIVE_STORE_DATABASE_INSTANCE_ID,
  NATIVE_STORE_SCHEMA_CONTRACT_ID,
} from '../../paper-adapters/persistence/native-store-online-mutation-plan.mjs';
import {
  createDefaultPaperStore,
} from '../../paper-adapters/persistence/store-provider.mjs';
import {
  createSqliteReceiptLedger,
} from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import {
  createExternallyFencedNativeSqliteStore,
} from '../../paper-adapters/persistence/sqlite-store.mjs';
import {
  NATIVE_STORE_SUBMISSION_DELIVERY_MUTATION_PLANS,
  NATIVE_STORE_SUBMISSION_DELIVERY_WRITER_ID,
  NATIVE_STORE_SUBMISSION_DELIVERY_WRITER_PLAN_HASH,
} from '../../paper-adapters/persistence/native-store-submission-delivery-mutation-plan.mjs';
import {
  createSqliteSubmissionDeliveryStore,
} from '../../paper-adapters/submission/sqlite-delivery-store.mjs';
import {
  createAutonomousSubmissionOutboxRepository,
} from '../../paper-adapters/automation/autonomous-submission-outbox-repository.mjs';
import {
  createAutonomousSubmissionDispatchAuthority,
} from '../../paper-composition/automation/autonomous-submission-dispatch-authority-composition.mjs';
import {
  autonomousSubmissionSideEffectReservationHash,
} from '../../paper-domain/automation/autonomous-submission-delivery-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  requestFixture as autonomousSubmissionRequestFixture,
} from './autonomous-submission-durable-outbox-fixtures.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-07-18T12:00:00.000Z');
const H = (label) => hashRecord('NativeStoreSubmissionDeliveryMutationTest', { label });
const submissionRequestVerifier = Object.freeze({
  version: 1,
  kind: 'AutonomousSubmissionRequestVerifier',
  verify(request) {
    const { requestHash, ...payload } = request || {};
    return requestHash === hashRecord('AutonomousSubmissionRequest', payload);
  },
  verifyHumanAuthorization() { return true; },
});

const SOURCE_ENTRYPOINTS = Object.freeze({
  'paper-adapters/submission/sqlite-delivery-consumption-operations.mjs': Object.freeze([
    'advanceResponseCursor', 'claimNextResponse', 'completeResponseConsumption', 'release',
  ]),
  'paper-adapters/submission/sqlite-delivery-outbox-operations.mjs': Object.freeze([
    'acquireReleaseLock', 'claimPending', 'enqueue', 'enqueueAuthorized',
    'heartbeatClaim', 'recoverPending', 'registerProviderCapability',
  ]),
  'paper-adapters/automation/autonomous-submission-outbox-repository.mjs': Object.freeze([
    'prepareAutonomousSubmission', 'beginAutonomousSubmissionAttempt',
    'recordAutonomousSubmissionOutcome',
  ]),
  'paper-adapters/submission/sqlite-delivery-redrive-operations.mjs': Object.freeze([
    'deadLetter', 'enqueueRedrive', 'reviewAmbiguousResult', 'scheduleRedrive',
  ]),
  'paper-adapters/submission/sqlite-delivery-response-operations.mjs': Object.freeze([
    'quarantineInvalidIntake', 'recordResponse',
  ]),
});

function writerManifest() {
  const integrated = Object.entries(SOURCE_ENTRYPOINTS).flatMap(
    ([sourceFile, entrypoints]) => entrypoints.map((entrypoint) => Object.freeze({
      operationId: `native-store.${sourceFile.endsWith('/autonomous-submission-outbox-repository.mjs')
        ? 'delivery-outbox-operations'
        : path.basename(sourceFile, '.mjs').replace(/^sqlite-/, '')}.${entrypoint}.v1`,
      databaseRole: 'native-store',
      sourceFile,
      entrypoint,
      mutationClass: /claim|release|recover|heartbeat/i.test(entrypoint)
        ? 'lease-or-budget-dml' : 'business-dml',
      protocolStatus: AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS,
      coordinatorIntegrated: true,
    })),
  );
  const pending = AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES
    .filter((databaseRole) => databaseRole !== 'native-store')
    .map((databaseRole) => Object.freeze({
      operationId: `${databaseRole}.pending.v1`,
      databaseRole,
      sourceFile: `paper-adapters/automation/${databaseRole}-pending.mjs`,
      entrypoint: 'pending',
      mutationClass: 'schema-or-genesis-ddl',
      protocolStatus: AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
      coordinatorIntegrated: false,
    }));
  return Object.freeze({
    version: 1,
    kind: AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
    manifestId: 'native-store-submission-delivery-test-v1',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    requiredDatabaseRoles: Object.freeze([...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort()),
    writers: Object.freeze([Object.freeze({
      writerId: NATIVE_STORE_SUBMISSION_DELIVERY_WRITER_ID,
      databaseRoles: Object.freeze(['native-store']),
      operationIds: Object.freeze(Object.keys(
        NATIVE_STORE_SUBMISSION_DELIVERY_MUTATION_PLANS,
      ).sort()),
      implementationHash: NATIVE_STORE_SUBMISSION_DELIVERY_WRITER_PLAN_HASH,
      protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    })]),
    operations: Object.freeze([...integrated, ...pending]),
    coverage: Object.freeze({
      requiredRoleCount: AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length,
      coveredRoleCount: 1,
      coveredDatabaseRoles: Object.freeze(['native-store']),
      percent: Number((100 / AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length).toFixed(2)),
    }),
  });
}

function exactSchemaHash(database) {
  const rows = database.prepare(`
SELECT type,name,tbl_name,coalesce(sql,'') AS sql
FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'
ORDER BY type,name,tbl_name,sql;
`).all().map((row) => ({ ...row }));
  return hashRecord('AutonomousResearchStateDatabaseSchema', rows);
}

function provisionDatabase(databasePath, trust, root) {
  const offline = createDefaultPaperStore({ root, dbPath: databasePath });
  offline.close();
  const database = new DatabaseSync(databasePath);
  for (const statement of AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS) {
    database.exec(statement);
  }
  const schemaHash = exactSchemaHash(database);
  database.prepare(`
INSERT INTO autonomous_research_online_mutation_authority_metadata(
  singleton,schema_version,protocol,database_role,database_instance_id,
  schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,
  genesis_global_sequence,genesis_global_hash,genesis_database_sequence,
  genesis_database_hash,genesis_state_hash,provisioned_at
) VALUES(1,1,?,?,?,?,?,?,?,?,?,?,?,?,?);
`).run(
    AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    'native-store',
    NATIVE_STORE_DATABASE_INSTANCE_ID,
    NATIVE_STORE_SCHEMA_CONTRACT_ID,
    schemaHash,
    trust.databaseScopeHash,
    trust.writerManifestHash,
    0,
    H('genesis-global'),
    0,
    H('genesis-database'),
    H('genesis-state'),
    NOW.toISOString(),
  );
  database.close();
  return schemaHash;
}

function fakeAuthority(trust, schemaHash) {
  const calls = [];
  let failFinalize = false;
  let sequence = 0;
  let reservation = null;
  let head = Object.freeze({
    globalSequence: 0,
    globalHash: H('genesis-global'),
    databaseSequence: 0,
    databaseHash: H('genesis-database'),
    stateHash: H('genesis-state'),
  });
  const client = Object.freeze({
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    trust,
    observeCurrentHead({ request }) {
      calls.push(Object.freeze({ method: 'head', request }));
      return Object.freeze({
        globalSequence: head.globalSequence,
        globalHash: head.globalHash,
        databaseHeads: Object.freeze([Object.freeze({
          databaseRole: 'native-store',
          databaseInstanceId: NATIVE_STORE_DATABASE_INSTANCE_ID,
          sequence: head.databaseSequence,
          hash: head.databaseHash,
          schemaHash,
          stateHash: head.stateHash,
        })]),
      });
    },
    reserveMutation({ request }) {
      calls.push(Object.freeze({ method: 'reserve', request }));
      sequence += 1;
      reservation = Object.freeze({
        ...request,
        kind: 'AutonomousResearchOnlineMutationReservationReceipt',
        status: 'autonomous_research_online_mutation_reserved',
        authorityId: 'authority:native-submission-test',
        keyId: 'key:native-submission-test',
        requestHash: hashRecord('AutonomousResearchOnlineMutationReserveRequest', request),
        reservationId: `reservation:native-submission:${sequence}`,
        globalSequence: request.globalPreviousSequence + 1,
        globalHash: H(`global:${sequence}`),
        databaseSequence: request.databasePreviousSequence + 1,
        databaseHash: H(`database:${sequence}`),
        issuedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        signature: 'dGVzdA==',
      });
      return reservation;
    },
    verifyStoredReservation() { return true; },
    resolveMutationAttempt() { return reservation; },
    finalizeMutation({ request, reservation: reserved, now }) {
      calls.push(Object.freeze({ method: 'finalize', request }));
      if (failFinalize) throw new Error('simulated_submission_finalize_outage');
      head = Object.freeze({
        globalSequence: reserved.globalSequence,
        globalHash: reserved.globalHash,
        databaseSequence: reserved.databaseSequence,
        databaseHash: reserved.databaseHash,
        stateHash: reserved.postStateHash,
      });
      return Object.freeze({
        ...request,
        kind: 'AutonomousResearchOnlineMutationFinalizationReceipt',
        status: 'autonomous_research_online_mutation_finalized',
        authorityId: 'authority:native-submission-test',
        keyId: 'key:native-submission-test',
        requestHash: hashRecord('AutonomousResearchOnlineMutationFinalizeRequest', request),
        sideEffectPermitHash: H(`permit:${reserved.reservationId}`),
        finalizedAt: new Date(now || NOW).toISOString(),
        signature: 'dGVzdA==',
      });
    },
    abortMutation({ request }) {
      calls.push(Object.freeze({ method: 'abort', request }));
      return Object.freeze({
        ...request,
        kind: 'AutonomousResearchOnlineMutationAbortReceipt',
        status: 'autonomous_research_online_mutation_aborted',
        authorityId: 'authority:native-submission-test',
        keyId: 'key:native-submission-test',
        requestHash: hashRecord('AutonomousResearchOnlineMutationAbortRequest', request),
        abortedAt: NOW.toISOString(),
        signature: 'dGVzdA==',
      });
    },
  });
  return Object.freeze({
    calls,
    client,
    setFailFinalize(value) { failFinalize = Boolean(value); },
  });
}

function readyCoordinator(configured) {
  const coveredDatabaseRoles = Object.freeze(['native-store']);
  return Object.freeze({
    implemented: true,
    protocol: configured.protocol,
    coveredDatabaseRoles,
    executeMutation(input) { return configured.executeMutation(input); },
    recoverPendingMutations(input) { return configured.recoverPendingMutations(input); },
    inspectStatus() {
      return Object.freeze({
        version: 1,
        kind: 'ExternallyFencedSqliteMutationCoordinatorStatus',
        status: 'externally_fenced_sqlite_mutation_coordinator_ready',
        implemented: true,
        coveredDatabaseRoles,
        blockers: Object.freeze([]),
      });
    },
  });
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-native-submission-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'hepta-paper.sqlite');
  const manifest = writerManifest();
  const trust = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
    authorityId: 'authority:native-submission-test',
    keyId: 'key:native-submission-test',
    scopeId: 'scope:native-submission-test',
    databaseScopeHash: H('database-scope'),
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(manifest),
    maximumReservationLeaseMs: 60_000,
    maximumObservationAgeMs: 60_000,
  });
  const schemaHash = provisionDatabase(databasePath, trust, root);
  const authority = fakeAuthority(trust, schemaHash);
  const configured = createExternallyFencedSqliteMutationCoordinator({
    authorityClient: authority.client,
    authorityTrust: trust,
    manifest,
    operationPlans: NATIVE_STORE_SUBMISSION_DELIVERY_MUTATION_PLANS,
    databaseInstances: Object.freeze([Object.freeze({
      databaseRole: 'native-store',
      databaseInstanceId: NATIVE_STORE_DATABASE_INSTANCE_ID,
      schemaHash,
    })]),
    clock: { now: () => NOW },
  });
  const store = createExternallyFencedNativeSqliteStore({
    dbPath: databasePath,
    mutationCoordinator: readyCoordinator(configured),
    databaseInstanceId: NATIVE_STORE_DATABASE_INSTANCE_ID,
    schemaContractId: NATIVE_STORE_SCHEMA_CONTRACT_ID,
    writerId: NATIVE_STORE_SUBMISSION_DELIVERY_WRITER_ID,
    operationIds: Object.keys(NATIVE_STORE_SUBMISSION_DELIVERY_MUTATION_PLANS),
  });
  t.after(() => store.close());
  return { authority, databasePath, store };
}

function observedStore(store, observation, { throwAfterCallback = false } = {}) {
  return Object.freeze(Object.assign(Object.create(store), {
    mutate(input) {
      observation.mutateCalls += 1;
      return store.mutate({
        ...input,
        mutate(transaction) {
          observation.callbackCalls += 1;
          const value = input.mutate(transaction);
          if (throwAfterCallback) throw new Error('simulated_submission_candidate_failure');
          return value;
        },
      });
    },
  }));
}

function delivery(store) {
  const clock = Object.freeze({
    now: () => NOW,
    nowIso: () => NOW.toISOString(),
  });
  return createSqliteSubmissionDeliveryStore({
    store,
    receiptLedger: createSqliteReceiptLedger({ store, clock }),
    clock,
  });
}

function dispatchAuthorization(label) {
  return Object.freeze({
    status: 'submission_dispatch_authorization_ready',
    submissionDispatchAuthorizationHash: `dispatch:${label}`,
    provider: 'provider:test',
    accountId: 'account:test',
    nonce: `nonce:${label}`,
    attempt: 1,
  });
}

function fullyAuthorizedDispatch(label) {
  return Object.freeze({
    ...dispatchAuthorization(label),
    submissionDispatchAuthorizationHash: H(`dispatch:${label}`),
    replayKey: H(`replay:${label}`),
    actionScopeKey: H(`action:${label}`),
    dispatchCycleHash: H(`cycle:${label}`),
    liveAuthorizationHash: H(`authorization:${label}`),
    responseDueAt: '2026-07-18T13:00:00.000Z',
    providerCapabilityVerificationReceiptHash: H(`capability:${label}`),
    portalRoute: '/submission-test',
  });
}

test('submission strict native store rejects unactivated coordination before filesystem I/O', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-native-submission-blocked-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, 'must-not-exist');
  const configured = Object.freeze({
    implemented: true,
    coveredDatabaseRoles: Object.freeze(['native-store']),
    executeMutation() { throw new Error('must_not_execute'); },
    recoverPendingMutations() { throw new Error('must_not_recover'); },
    inspectStatus() {
      return Object.freeze({
        status: 'externally_fenced_sqlite_mutation_coordinator_configured',
        implemented: true,
        coveredDatabaseRoles: Object.freeze(['native-store']),
        blockers: Object.freeze(['runtime_activation_required']),
      });
    },
  });
  assert.throws(() => createExternallyFencedNativeSqliteStore({
    dbPath: path.join(parent, 'hepta-paper.sqlite'),
    mutationCoordinator: configured,
    databaseInstanceId: NATIVE_STORE_DATABASE_INSTANCE_ID,
    schemaContractId: NATIVE_STORE_SCHEMA_CONTRACT_ID,
    writerId: NATIVE_STORE_SUBMISSION_DELIVERY_WRITER_ID,
    operationIds: Object.keys(NATIVE_STORE_SUBMISSION_DELIVERY_MUTATION_PLANS),
  }), /native_store_external_mutation_coordinator_required/);
  assert.equal(fs.existsSync(parent), false);
});

test('all submission plans pass operation-scoped surface inspection on the real v24 schema', (t) => {
  const { store } = setup(t);
  for (const operationId of Object.keys(NATIVE_STORE_SUBMISSION_DELIVERY_MUTATION_PLANS)) {
    const receipt = store.mutate({
      operationId,
      authorizationReceiptHashes: [],
      sideEffectReservationHashes: [],
      mutate: () => operationId,
    });
    assert.equal(receipt.status, 'externally_fenced_sqlite_mutation_no_change');
    assert.equal(receipt.value, operationId);
  }
});

test('strict submission plans atomically bind authorization and prepared ledger rows', (t) => {
  const { authority, store } = setup(t);
  const api = delivery(store);
  const authorization = fullyAuthorizedDispatch('atomic');
  const message = api.enqueueAuthorized({
    paperId: 'paper:atomic',
    dispatchAuthorization: authorization,
    payload: { packageHash: H('package:atomic') },
  });
  assert.equal(message.message_id, `submission:${authorization.submissionDispatchAuthorizationHash}`);
  assert.equal(store.query(`SELECT count(*) AS count FROM submission_outbox
    WHERE paper_id='paper:atomic'`).rows[0].count, 1);
  assert.equal(store.query(`SELECT count(*) AS count FROM submission_authorization_consumptions
    WHERE paper_id='paper:atomic'`).rows[0].count, 1);
  assert.equal(store.query(`SELECT count(*) AS count FROM submission_release_locks
    WHERE paper_id='paper:atomic'`).rows[0].count, 1);
  assert.deepEqual(
    authority.calls.find((call) => call.method === 'reserve')
      .request.authorizationReceiptHashes,
    [authorization.liveAuthorizationHash],
  );

  const quarantine = api.quarantineInvalidIntake({
    messageId: message.message_id,
    payload: { invalid: true },
    failureCodes: ['simulated_invalid_boundary'],
  });
  assert.equal(quarantine.status, 'submission_intake_quarantined');
  assert.equal(store.query(`SELECT count(*) AS count FROM submission_intake_quarantine
    WHERE message_id=?`, [message.message_id]).rows[0].count, 1);
  assert.equal(store.query(`SELECT count(*) AS count FROM receipt_ledger
    WHERE kind='SubmissionIntakeQuarantineReceipt'`).rows[0].count, 1);
});

test('strict autonomous outbox finalizes durable intent before issuing side-effect permit', (t) => {
  const { authority, store } = setup(t);
  const authorizationNow = new Date('2026-07-19T02:00:00.000Z');
  const clock = Object.freeze({
    now: () => authorizationNow,
    nowIso: () => authorizationNow.toISOString(),
  });
  const submissionDispatchAuthority = createAutonomousSubmissionDispatchAuthority();
  const api = createAutonomousSubmissionOutboxRepository({
    store,
    receiptLedger: createSqliteReceiptLedger({ store, clock }),
    clock,
    submissionRequestVerifier,
    dispatchCapability: submissionDispatchAuthority.outbox,
  });
  const request = autonomousSubmissionRequestFixture();
  const prepared = api.prepareAutonomousSubmission({
    request,
    portalId: request.portalId,
  });
  assert.equal(prepared.stateReceipt.state, 'prepared');
  const dispatching = api.beginAutonomousSubmissionAttempt({
    request,
    portalId: request.portalId,
  });
  assert.equal(dispatching.stateReceipt.state, 'dispatching');
  assert.match(dispatching.sideEffectPermitHash, /^sha256:[0-9a-f]{64}$/);
  const reserve = authority.calls.filter((call) => call.method === 'reserve').at(-1);
  assert.deepEqual(reserve.request.sideEffectReservationHashes, [
    autonomousSubmissionSideEffectReservationHash(request, {
      requestVerifier: submissionRequestVerifier,
    }),
  ]);
  assert.equal(store.query(`SELECT count(*) AS count FROM submission_outbox
    WHERE paper_id=? AND status='in_flight'`, [request.paperId]).rows[0].count, 1);
  assert.equal(store.query(`SELECT count(*) AS count FROM receipt_ledger
    WHERE stream='autonomous-submission-delivery' AND paper_id=?`,
  [request.paperId]).rows[0].count, 2);
});

test('submission candidate fault rolls back before authority reservation', (t) => {
  const { authority, store } = setup(t);
  const observation = { mutateCalls: 0, callbackCalls: 0 };
  const candidate = observedStore(store, observation, { throwAfterCallback: true });
  assert.throws(() => delivery(candidate).enqueue({
    paperId: 'paper:fault',
    dispatchAuthorization: dispatchAuthorization('fault'),
    payload: { packageHash: H('package:fault') },
  }), /simulated_submission_candidate_failure/);
  assert.deepEqual(observation, { mutateCalls: 1, callbackCalls: 1 });
  assert.equal(store.query(`SELECT count(*) AS count FROM submission_outbox
    WHERE paper_id='paper:fault'`).rows[0].count, 0);
  assert.deepEqual(authority.calls.map((call) => call.method), ['head']);
});

test('submission pending finalization recovery never replays committed DML', (t) => {
  const { authority, store } = setup(t);
  const observation = { mutateCalls: 0, callbackCalls: 0 };
  const candidate = observedStore(store, observation);
  authority.setFailFinalize(true);
  assert.throws(() => delivery(candidate).enqueue({
    paperId: 'paper:pending',
    dispatchAuthorization: dispatchAuthorization('pending'),
    payload: { packageHash: H('package:pending') },
  }), (error) => (
    error.message === 'externally_fenced_sqlite_mutation_committed_finalization_pending'
      && error.committed === true
  ));
  assert.equal(store.query(`SELECT count(*) AS count FROM submission_outbox
    WHERE paper_id='paper:pending'`).rows[0].count, 1);
  assert.deepEqual(observation, { mutateCalls: 1, callbackCalls: 1 });
  authority.setFailFinalize(false);
  const recovered = store.recoverPendingMutations();
  assert.equal(recovered.recoveredReservationIds.length, 1);
  assert.equal(store.query(`SELECT count(*) AS count FROM submission_outbox
    WHERE paper_id='paper:pending'`).rows[0].count, 1);
  assert.deepEqual(observation, { mutateCalls: 1, callbackCalls: 1 });
  assert.deepEqual(authority.calls.map((call) => call.method), [
    'head', 'reserve', 'finalize', 'finalize',
  ]);
});
