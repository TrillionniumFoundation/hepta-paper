import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  executeAutonomousResearchOnlineSchemaTransition,
  inspectAutonomousResearchOnlineSchemaTransitionReadiness,
  planAutonomousResearchOnlineSchemaTransition,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition.mjs';
import {
  autonomousResearchOnlineSchemaTransitionControlPaths,
  readAutonomousResearchOnlineSchemaTransitionJson,
  writeAutonomousResearchOnlineSchemaTransitionJson,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-state-repository.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import { fileSha256HashSync } from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import {
  assertAutonomousResearchOnlineSchemaTransitionFinalizeRequest,
  assertAutonomousResearchOnlineSchemaTransitionObserveRequest,
  assertAutonomousResearchOnlineSchemaTransitionReserveRequest,
  verifyAutonomousResearchOnlineSchemaTransitionFinalization,
  verifyAutonomousResearchOnlineSchemaTransitionObservation,
  verifyAutonomousResearchOnlineSchemaTransitionReservation,
} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  parseAutonomousResearchOnlineSchemaTransitionArguments,
  runAutonomousResearchOnlineSchemaTransition,
} from '../bin/autonomous-research-online-schema-transition.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const stateDatabaseManifest = JSON.parse(fs.readFileSync(path.join(
  repositoryRoot,
  'paper-core',
  'config',
  'autonomous-research-state-databases.v1.json',
), 'utf8'));
const H = (label) => hashRecord('AutonomousResearchOnlineSchemaTransitionTest', { label });

function sqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function isTransitionSchemaObject(name) {
  return name.includes('autonomous_research_online_')
    || name === 'idx_autonomous_research_online_mutation_marker_head';
}

function createBusinessDatabase(candidate, definition) {
  fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(candidate);
  try {
    database.exec(`
PRAGMA journal_mode=DELETE;
PRAGMA foreign_keys=ON;
CREATE TABLE fixture_anchor(id TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO fixture_anchor(id,value) VALUES('fixture','ready');
`);
    for (const schemaObject of definition.requiredSchemaObjects) {
      const [type, name] = schemaObject.split(':');
      if (isTransitionSchemaObject(name)) continue;
      const identifier = sqlIdentifier(name);
      if (type === 'table') {
        database.exec(`CREATE TABLE ${identifier}(id TEXT PRIMARY KEY);`);
      } else if (type === 'index') {
        database.exec(`CREATE INDEX ${identifier} ON fixture_anchor(value);`);
      } else if (type === 'trigger') {
        database.exec(`CREATE TRIGGER ${identifier} BEFORE UPDATE ON fixture_anchor
          BEGIN SELECT 1; END;`);
      } else if (type === 'view') {
        database.exec(`CREATE VIEW ${identifier} AS SELECT id,value FROM fixture_anchor;`);
      } else {
        throw new Error(`unsupported_schema_transition_fixture_object:${schemaObject}`);
      }
    }
    database.exec('PRAGMA user_version=1;');
  } finally {
    database.close();
  }
  fs.chmodSync(candidate, 0o600);
}

function fixture(context) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-online-schema-transition-'));
  const runtimeRoot = path.join(parent, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const databasePaths = stateDatabaseManifest.databases.map((definition) => {
    const relativePath = definition.cardinality === 'per-paper'
      ? definition.relativePathPattern.replace('{paperId}', 'paper-alpha')
      : definition.relativePath;
    const candidate = path.join(runtimeRoot, relativePath);
    createBusinessDatabase(candidate, definition);
    return candidate;
  });
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, runtimeRoot, databasePaths };
}

function controlledClock() {
  let current = new Date('2026-07-19T04:00:00.000Z');
  return Object.freeze({
    now: () => new Date(current),
    advance(milliseconds) { current = new Date(current.getTime() + milliseconds); },
  });
}

function createAuthority(runtimeRoot) {
  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  if (inventory.instances.length !== stateDatabaseManifest.databases.length) {
    throw new Error(`schema_transition_fixture_inventory:${JSON.stringify(inventory)}`);
  }
  const trust = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityTrust',
    authorityId: 'schema-transition-test-authority',
    keyId: 'schema-transition-test-key',
    scopeId: 'schema-transition-test-scope',
    databaseScopeHash: inventory.databaseScopeHash,
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(
      AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    ),
    maximumReservationLeaseMs: 300000,
    maximumObservationAgeMs: 60000,
  });
  const calls = { reserve: 0, finalize: 0, observe: 0 };
  const verifySignature = () => true;
  const client = Object.freeze({
    trust,
    reserveSchemaTransition({ request, now }) {
      calls.reserve += 1;
      assertAutonomousResearchOnlineSchemaTransitionReserveRequest(request, { trust });
      const issuedAt = now.toISOString();
      return Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineSchemaTransitionReservationReceipt',
        status: 'autonomous_research_online_schema_transition_reserved',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchOnlineSchemaTransitionReserveRequest', request),
        reservationId: 'schema-transition-reservation-1',
        protocol: request.protocol,
        scopeId: request.scopeId,
        databaseScopeHash: request.databaseScopeHash,
        writerManifestHash: request.writerManifestHash,
        stateDatabaseManifestHash: request.stateDatabaseManifestHash,
        transitionInventoryHash: request.transitionInventoryHash,
        schemaBundleHash: request.schemaBundleHash,
        authorityJournalSchemaContractId: request.authorityJournalSchemaContractId,
        authorityJournalSchemaHash: request.authorityJournalSchemaHash,
        markerSchemaHash: request.markerSchemaHash,
        transitionId: request.transitionId,
        instances: request.instances,
        databaseGenesis: Object.freeze(request.instances.map((instance, index) => Object.freeze({
          databaseRole: instance.databaseRole,
          databaseInstanceId: instance.databaseInstanceId,
          schemaContractId: instance.schemaContractId,
          schemaHash: instance.expectedPostSchemaHash,
          globalSequence: 0,
          globalHash: H('genesis-global'),
          databaseSequence: 0,
          databaseHash: H(`genesis-database:${index}`),
          stateHash: H(`genesis-state:${index}`),
        }))),
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + request.requestedLeaseMs).toISOString(),
        allRegisteredMutationsFenced: true,
        quiescenceMode: 'scope-wide-no-new-reservations-until-finalize-or-expiry',
        signature: 'test-signature',
      });
    },
    verifyStoredReservation({ receipt, request, now }) {
      return verifyAutonomousResearchOnlineSchemaTransitionReservation({
        receipt, request, trust, now, verifySignature,
      });
    },
    verifyHistoricalReservation({ receipt, request }) {
      return verifyAutonomousResearchOnlineSchemaTransitionReservation({
        receipt, request, trust, now: new Date(receipt.issuedAt), verifySignature,
      });
    },
    finalizeSchemaTransition({ request, reservation, now }) {
      calls.finalize += 1;
      assertAutonomousResearchOnlineSchemaTransitionFinalizeRequest(request, reservation);
      const receipt = Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineSchemaTransitionFinalizationReceipt',
        status: 'autonomous_research_online_schema_transition_finalized',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchOnlineSchemaTransitionFinalizeRequest', request),
        protocol: request.protocol,
        scopeId: request.scopeId,
        databaseScopeHash: request.databaseScopeHash,
        writerManifestHash: request.writerManifestHash,
        transitionId: request.transitionId,
        transitionInventoryHash: request.transitionInventoryHash,
        schemaBundleHash: request.schemaBundleHash,
        reservationId: request.reservationId,
        reservationReceiptHash: request.reservationReceiptHash,
        postInventoryHash: request.postInventoryHash,
        installations: request.installations,
        globalSequence: 1,
        globalHash: H('final-global'),
        finalizedAt: now.toISOString(),
        allRegisteredMutationsFencedThroughFinalize: true,
        signature: 'test-signature',
      });
      assert.equal(verifyAutonomousResearchOnlineSchemaTransitionFinalization({
        receipt, request, reservation, trust, now, verifySignature,
      }), true);
      return receipt;
    },
    verifyHistoricalFinalization({ receipt, request, reservation }) {
      return verifyAutonomousResearchOnlineSchemaTransitionFinalization({
        receipt, request, reservation, trust,
        now: new Date(receipt.finalizedAt), verifySignature,
      });
    },
    observeSchemaTransition({ request, now }) {
      calls.observe += 1;
      assertAutonomousResearchOnlineSchemaTransitionObserveRequest(request, { trust });
      const observedAt = now.toISOString();
      const receipt = Object.freeze({
        version: 1,
        kind: 'AutonomousResearchOnlineSchemaTransitionObservationReceipt',
        status: 'autonomous_research_online_schema_transition_observed_finalized',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchOnlineSchemaTransitionObserveRequest', request),
        protocol: request.protocol,
        scopeId: request.scopeId,
        databaseScopeHash: request.databaseScopeHash,
        writerManifestHash: request.writerManifestHash,
        transitionId: request.transitionId,
        transitionInventoryHash: request.transitionInventoryHash,
        schemaBundleHash: request.schemaBundleHash,
        finalizationReceiptHash: request.finalizationReceiptHash,
        postInventoryHash: request.postInventoryHash,
        transitionState: 'finalized',
        globalSequence: 1,
        globalHash: H('final-global'),
        observedAt,
        expiresAt: new Date(Date.parse(observedAt) + 60000).toISOString(),
        signature: 'test-signature',
      });
      assert.equal(verifyAutonomousResearchOnlineSchemaTransitionObservation({
        receipt, request, trust, now, verifySignature,
      }), true);
      return receipt;
    },
    verifyHistoricalObservation({ receipt, request }) {
      return verifyAutonomousResearchOnlineSchemaTransitionObservation({
        receipt, request, trust,
        now: new Date(receipt.observedAt), verifySignature,
      });
    },
  });
  return Object.freeze({ client, calls });
}

function transitionInput(setup, clock, authority) {
  return Object.freeze({
    runtimeRoot: setup.runtimeRoot,
    stateDatabaseManifest,
    writerManifest: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    authorityProcessConfigurationPath: '/pinned/test-authority-process.json',
    clock,
    createAuthorityClient: () => authority.client,
  });
}

function mutated(value, mutate) {
  const candidate = structuredClone(value);
  mutate(candidate);
  return candidate;
}

function assertSchemaTransitionContractsFailClosed({ audit, trust, now }) {
  const invalidTrust = [
    ['version', (value) => { value.version = 2; }],
    ['kind', (value) => { value.kind = 'WrongTrust'; }],
    ['authority id', (value) => { value.authorityId = 'x'; }],
    ['key id', (value) => { value.keyId = 'x'; }],
    ['scope id', (value) => { value.scopeId = 'x'; }],
    ['database scope hash', (value) => { value.databaseScopeHash = 'invalid'; }],
    ['writer manifest hash', (value) => { value.writerManifestHash = 'invalid'; }],
    ['reservation lease type', (value) => { value.maximumReservationLeaseMs = 1.5; }],
    ['reservation lease floor', (value) => { value.maximumReservationLeaseMs = 999; }],
    ['observation age type', (value) => { value.maximumObservationAgeMs = 1.5; }],
    ['observation age floor', (value) => { value.maximumObservationAgeMs = 999; }],
  ];
  for (const [name, mutate] of invalidTrust) {
    assert.throws(() => assertAutonomousResearchOnlineSchemaTransitionReserveRequest(
      audit.reserveRequest,
      { trust: mutated(trust, mutate) },
    ), /authority_trust_invalid/, name);
  }

  const invalidReserveRequests = [
    ['keys', (value) => { value.unexpected = true; }],
    ['version', (value) => { value.version = 2; }],
    ['kind', (value) => { value.kind = 'WrongReserveRequest'; }],
    ['protocol', (value) => { value.protocol = 'wrong'; }],
    ['scope', (value) => { value.scopeId = 'wrong-scope'; }],
    ['database scope', (value) => { value.databaseScopeHash = H('wrong-scope'); }],
    ['writer manifest', (value) => { value.writerManifestHash = H('wrong-writer'); }],
    ['state manifest', (value) => { value.stateDatabaseManifestHash = 'invalid'; }],
    ['inventory hash', (value) => { value.transitionInventoryHash = 'invalid'; }],
    ['schema bundle', (value) => { value.schemaBundleHash = 'invalid'; }],
    ['journal contract', (value) => { value.authorityJournalSchemaContractId = 'x'; }],
    ['journal schema', (value) => { value.authorityJournalSchemaHash = 'invalid'; }],
    ['marker schema', (value) => { value.markerSchemaHash = 'invalid'; }],
    ['transition id', (value) => { value.transitionId = 'invalid'; }],
    ['instances type', (value) => { value.instances = null; }],
    ['instance keys', (value) => { value.instances[0].unexpected = true; }],
    ['instance role', (value) => { value.instances[0].databaseRole = 'wrong-role'; }],
    ['instance id', (value) => { value.instances[0].databaseInstanceId = 'x'; }],
    ['duplicate instance id', (value) => {
      value.instances[1].databaseInstanceId = value.instances[0].databaseInstanceId;
    }],
    ['instance path', (value) => { value.instances[0].sourceRelativePath = '/absolute'; }],
    ['instance contract', (value) => { value.instances[0].schemaContractId = 'x'; }],
    ['instance pre-schema', (value) => { value.instances[0].preSchemaHash = 'invalid'; }],
    ['instance post-schema', (value) => {
      value.instances[0].expectedPostSchemaHash = 'invalid';
    }],
    ['instance source hash', (value) => { value.instances[0].sourceSha256 = 'invalid'; }],
    ['instance identity', (value) => {
      value.instances[0].sourceFileIdentityHash = 'invalid';
    }],
    ['instance ordering', (value) => {
      [value.instances[0], value.instances[1]] = [value.instances[1], value.instances[0]];
    }],
    ['role closure', (value) => {
      value.instances[0].databaseRole = value.instances[1].databaseRole;
    }],
    ['requested at', (value) => { value.requestedAt = 'invalid'; }],
    ['lease integer', (value) => { value.requestedLeaseMs = 1.5; }],
    ['lease floor', (value) => { value.requestedLeaseMs = 999; }],
    ['lease ceiling', (value) => {
      value.requestedLeaseMs = trust.maximumReservationLeaseMs + 1;
    }],
    ['window integer', (value) => { value.requiredExecutionWindowMs = 1.5; }],
    ['window floor', (value) => { value.requiredExecutionWindowMs = 999; }],
    ['window ceiling', (value) => {
      value.requiredExecutionWindowMs = value.requestedLeaseMs + 1;
    }],
  ];
  for (const [name, mutate] of invalidReserveRequests) {
    assert.throws(() => assertAutonomousResearchOnlineSchemaTransitionReserveRequest(
      mutated(audit.reserveRequest, mutate),
      { trust },
    ), /reserve_request_invalid/, name);
  }

  const invalidReservations = [
    ['keys', (value) => { value.unexpected = true; }],
    ['version', (value) => { value.version = 2; }],
    ['kind', (value) => { value.kind = 'WrongReservation'; }],
    ['status', (value) => { value.status = 'wrong'; }],
    ['reservation id', (value) => { value.reservationId = 'x'; }],
    ['request hash', (value) => { value.requestHash = H('wrong-request'); }],
    ['mirrored field', (value) => { value.schemaBundleHash = H('wrong-schema'); }],
    ['instances', (value) => { value.instances = []; }],
    ['genesis length', (value) => { value.databaseGenesis = []; }],
    ['genesis keys', (value) => { value.databaseGenesis[0].unexpected = true; }],
    ['genesis role', (value) => { value.databaseGenesis[0].databaseRole = 'wrong'; }],
    ['genesis instance', (value) => { value.databaseGenesis[0].databaseInstanceId = 'wrong'; }],
    ['genesis contract', (value) => { value.databaseGenesis[0].schemaContractId = 'wrong'; }],
    ['genesis schema', (value) => { value.databaseGenesis[0].schemaHash = H('wrong'); }],
    ['genesis global sequence', (value) => { value.databaseGenesis[0].globalSequence = 1; }],
    ['genesis global hash', (value) => { value.databaseGenesis[0].globalHash = 'invalid'; }],
    ['genesis database sequence', (value) => {
      value.databaseGenesis[0].databaseSequence = 1;
    }],
    ['genesis database hash', (value) => {
      value.databaseGenesis[0].databaseHash = 'invalid';
    }],
    ['genesis state hash', (value) => { value.databaseGenesis[0].stateHash = 'invalid'; }],
    ['fence', (value) => { value.allRegisteredMutationsFenced = false; }],
    ['quiescence', (value) => { value.quiescenceMode = 'wrong'; }],
    ['issued at', (value) => { value.issuedAt = 'invalid'; }],
    ['expires at', (value) => { value.expiresAt = 'invalid'; }],
    ['future issue', (value) => {
      value.issuedAt = new Date(now.getTime() + 6000).toISOString();
    }],
    ['expired', (value) => { value.expiresAt = now.toISOString(); }],
    ['nonpositive lifetime', (value) => { value.expiresAt = value.issuedAt; }],
    ['excess lifetime', (value) => {
      value.expiresAt = new Date(
        Date.parse(value.issuedAt) + audit.reserveRequest.requestedLeaseMs + 1,
      ).toISOString();
    }],
    ['authority', (value) => { value.authorityId = 'wrong-authority'; }],
    ['key', (value) => { value.keyId = 'wrong-key'; }],
  ];
  for (const [name, mutate] of invalidReservations) {
    assert.equal(verifyAutonomousResearchOnlineSchemaTransitionReservation({
      receipt: mutated(audit.reservation, mutate),
      request: audit.reserveRequest,
      trust,
      now,
      verifySignature: () => true,
    }), false, name);
  }
  assert.equal(verifyAutonomousResearchOnlineSchemaTransitionReservation({
    receipt: audit.reservation,
    request: audit.reserveRequest,
    trust,
    now,
    verifySignature: () => false,
  }), false, 'reservation signature');

  const invalidFinalizeRequests = [
    ['keys', (value) => { value.unexpected = true; }],
    ['version', (value) => { value.version = 2; }],
    ['kind', (value) => { value.kind = 'WrongFinalizeRequest'; }],
    ['protocol', (value) => { value.protocol = 'wrong'; }],
    ['scope', (value) => { value.scopeId = 'wrong'; }],
    ['database scope', (value) => { value.databaseScopeHash = H('wrong'); }],
    ['writer manifest', (value) => { value.writerManifestHash = H('wrong'); }],
    ['transition', (value) => { value.transitionId = H('wrong'); }],
    ['inventory', (value) => { value.transitionInventoryHash = H('wrong'); }],
    ['schema bundle', (value) => { value.schemaBundleHash = H('wrong'); }],
    ['reservation', (value) => { value.reservationId = 'wrong'; }],
    ['reservation hash', (value) => { value.reservationReceiptHash = H('wrong'); }],
    ['post inventory', (value) => { value.postInventoryHash = 'invalid'; }],
    ['installations length', (value) => { value.installations = []; }],
    ['installation keys', (value) => { value.installations[0].unexpected = true; }],
    ['installation role', (value) => { value.installations[0].databaseRole = 'wrong'; }],
    ['installation instance', (value) => {
      value.installations[0].databaseInstanceId = 'wrong';
    }],
    ['installation contract', (value) => {
      value.installations[0].schemaContractId = 'wrong';
    }],
    ['installation pre-schema', (value) => {
      value.installations[0].preSchemaHash = H('wrong');
    }],
    ['installation post-schema', (value) => {
      value.installations[0].postSchemaHash = H('wrong');
    }],
    ['installation hash', (value) => { value.installations[0].installationHash = H('wrong'); }],
    ['completed at', (value) => { value.completedAt = 'invalid'; }],
  ];
  for (const [name, mutate] of invalidFinalizeRequests) {
    assert.throws(() => assertAutonomousResearchOnlineSchemaTransitionFinalizeRequest(
      mutated(audit.finalizeRequest, mutate),
      audit.reservation,
    ), /finalize_request_invalid/, name);
  }

  const invalidObserveRequests = [
    ['keys', (value) => { value.unexpected = true; }],
    ['version', (value) => { value.version = 2; }],
    ['kind', (value) => { value.kind = 'WrongObserveRequest'; }],
    ['protocol', (value) => { value.protocol = 'wrong'; }],
    ['scope', (value) => { value.scopeId = 'wrong'; }],
    ['database scope', (value) => { value.databaseScopeHash = H('wrong'); }],
    ['writer manifest', (value) => { value.writerManifestHash = H('wrong'); }],
    ['transition', (value) => { value.transitionId = 'invalid'; }],
    ['inventory', (value) => { value.transitionInventoryHash = 'invalid'; }],
    ['schema bundle', (value) => { value.schemaBundleHash = 'invalid'; }],
    ['finalization', (value) => { value.finalizationReceiptHash = 'invalid'; }],
    ['post inventory', (value) => { value.postInventoryHash = 'invalid'; }],
    ['nonce', (value) => { value.nonce = 'x'; }],
    ['requested at', (value) => { value.requestedAt = 'invalid'; }],
  ];
  for (const [name, mutate] of invalidObserveRequests) {
    assert.throws(() => assertAutonomousResearchOnlineSchemaTransitionObserveRequest(
      mutated(audit.observeRequest, mutate),
      { trust },
    ), /observe_request_invalid/, name);
  }
  assert.equal(verifyAutonomousResearchOnlineSchemaTransitionReservation({
    receipt: audit.reservation,
    request: audit.reserveRequest,
    trust,
    now: now.toISOString(),
    verifySignature: () => true,
  }), true);
  assert.throws(() => verifyAutonomousResearchOnlineSchemaTransitionReservation({
    receipt: audit.reservation,
    request: audit.reserveRequest,
    trust,
    now: 'invalid',
    verifySignature: () => true,
  }), /schema_transition_now_required/);
}

test('maintenance CLI defaults to plan and double-gates every execute path', (context) => {
  const setup = fixture(context);
  const authorityPath = path.join(setup.parent, 'authority-process.json');
  const parsed = parseAutonomousResearchOnlineSchemaTransitionArguments([
    '--runtime-root', setup.runtimeRoot,
    '--authority-process-config', authorityPath,
  ]);
  assert.equal(parsed.action, 'plan');
  assert.equal(parsed.execute, false);
  assert.throws(() => parseAutonomousResearchOnlineSchemaTransitionArguments([
    '--action', 'execute', '--authority-process-config', authorityPath,
    '--transition-id', H('cli-transition'),
  ]), /execute_confirmation_required/);
  assert.throws(() => parseAutonomousResearchOnlineSchemaTransitionArguments([
    '--action', 'plan', '--execute', '--authority-process-config', authorityPath,
  ]), /execute_action_required/);
  assert.throws(() => parseAutonomousResearchOnlineSchemaTransitionArguments([
    '--action', 'execute', '--execute', '--authority-process-config', authorityPath,
  ]), /transition_id_required/);

  const calls = [];
  const report = runAutonomousResearchOnlineSchemaTransition({
    argv: ['--runtime-root', setup.runtimeRoot, '--authority-process-config', authorityPath],
    root: repositoryRoot,
    composeService() {
      return Object.freeze({
        plan() { calls.push('plan'); return Object.freeze({ ready: true, mode: 'plan' }); },
        execute() { calls.push('execute'); return Object.freeze({ ready: true, mode: 'execute' }); },
      });
    },
  });
  assert.deepEqual(report, { ready: true, mode: 'plan' });
  assert.deepEqual(calls, ['plan']);

  const blocked = spawnSync(process.execPath, [
    'paper-core/bin/autonomous-research-online-schema-transition.mjs',
    '--action', 'execute', '--runtime-root', setup.runtimeRoot,
    '--authority-process-config', authorityPath,
    '--transition-id', H('cli-transition'),
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /execute_confirmation_required/);
  assert.equal(fs.existsSync(path.join(
    setup.runtimeRoot, 'autonomous-research', 'online-schema-transition',
  )), false);
});

test('schema transition plan simulates the complete closed inventory without writes', (context) => {
  const setup = fixture(context);
  const clock = controlledClock();
  const authority = createAuthority(setup.runtimeRoot);
  const before = setup.databasePaths.map(fileSha256HashSync);
  const report = planAutonomousResearchOnlineSchemaTransition(
    transitionInput(setup, clock, authority),
  );
  assert.equal(report.status, 'autonomous_research_online_schema_transition_plan_ready');
  assert.equal(report.ready, true);
  assert.equal(report.plan.instances.length, stateDatabaseManifest.databases.length);
  assert.match(report.plan.transitionId, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(setup.databasePaths.map(fileSha256HashSync), before);
  assert.deepEqual(authority.calls, { reserve: 0, finalize: 0, observe: 0 });
  const paths = autonomousResearchOnlineSchemaTransitionControlPaths(setup.runtimeRoot, {
    create: false,
  });
  assert.equal(fs.existsSync(paths.controlRoot), false);
});

test('execute installs all schemas and emits a live-verifiable audit receipt', (context) => {
  const setup = fixture(context);
  const clock = controlledClock();
  const authority = createAuthority(setup.runtimeRoot);
  const input = transitionInput(setup, clock, authority);
  const planned = planAutonomousResearchOnlineSchemaTransition(input);
  assert.throws(() => executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: H('wrong-transition'),
  }), /expected_transition_id_mismatch/);
  assert.equal(fs.existsSync(path.join(
    setup.runtimeRoot, 'autonomous-research', 'online-schema-transition',
  )), false);
  const report = executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: planned.plan.transitionId,
  });
  assert.equal(report.status, 'autonomous_research_online_schema_transition_ready');
  assert.equal(report.installedDatabaseCount, stateDatabaseManifest.databases.length);
  assert.equal(report.receipt.transitionId, planned.plan.transitionId);
  assert.match(report.receipt.schemaTransitionReceiptHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(authority.calls, { reserve: 1, finalize: 1, observe: 1 });
  assertSchemaTransitionContractsFailClosed({
    audit: report.receipt,
    trust: authority.client.trust,
    now: clock.now(),
  });
  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  assert.equal(inventory.status, 'autonomous_research_state_database_inventory_ready');
  assert.deepEqual(inventory.blockers, []);

  const readiness = inspectAutonomousResearchOnlineSchemaTransitionReadiness(input);
  assert.equal(readiness.status, 'autonomous_research_online_schema_transition_ready');
  assert.equal(readiness.schemaTransitionReceiptHash, report.receipt.schemaTransitionReceiptHash);
  const paths = autonomousResearchOnlineSchemaTransitionControlPaths(setup.runtimeRoot, {
    create: false,
  });
  assert.deepEqual(readAutonomousResearchOnlineSchemaTransitionJson(paths.finalReceiptPath),
    report.receipt);
  writeAutonomousResearchOnlineSchemaTransitionJson(paths.finalReceiptPath, {
    ...report.receipt,
    schemaTransitionReceiptHash: H('tampered-receipt'),
  });
  assert.throws(
    () => inspectAutonomousResearchOnlineSchemaTransitionReadiness(input),
    /audit_receipt_invalid/,
  );
});

test('crash after a committed instance resumes under the stored signed reservation', (context) => {
  const setup = fixture(context);
  const clock = controlledClock();
  const authority = createAuthority(setup.runtimeRoot);
  const input = transitionInput(setup, clock, authority);
  const planned = planAutonomousResearchOnlineSchemaTransition(input);
  assert.throws(() => executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: planned.plan.transitionId,
    faultInjector(event) {
      if (event.point === 'after_instance_commit' && event.completedCount === 1) {
        throw new Error('schema_transition_test_crash');
      }
    },
  }), /schema_transition_test_crash/);
  const paths = autonomousResearchOnlineSchemaTransitionControlPaths(setup.runtimeRoot, {
    create: false,
  });
  const interrupted = readAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath);
  assert.equal(interrupted.phase, 'installing');
  assert.equal(interrupted.installations.length, 1);
  assert.equal(authority.calls.reserve, 1);

  const resumePlan = planAutonomousResearchOnlineSchemaTransition(input);
  assert.equal(resumePlan.status, 'autonomous_research_online_schema_transition_resume_ready');
  assert.deepEqual(resumePlan.completedInstanceIds,
    interrupted.installations.map((entry) => entry.databaseInstanceId));
  clock.advance(1000);
  const resumed = executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: planned.plan.transitionId,
  });
  assert.equal(resumed.status, 'autonomous_research_online_schema_transition_ready');
  assert.equal(resumed.installedDatabaseCount, stateDatabaseManifest.databases.length);
  assert.equal(authority.calls.reserve, 1);
  assert.equal(authority.calls.finalize, 1);
});
