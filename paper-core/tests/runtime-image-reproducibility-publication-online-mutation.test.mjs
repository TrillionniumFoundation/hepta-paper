import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createRuntimeImageReproducibilityReceiptRepository,
} from '../../paper-adapters/automation/runtime-image-reproducibility-receipt-repository.mjs';
import {
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_ROLE,
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_MUTATION_PLANS,
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_OPERATION_ID,
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_ID,
  RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_PLAN_HASH,
  createOfflineRuntimeImageReproducibilityPublicationMutationCoordinator,
} from '../../paper-adapters/automation/runtime-image-reproducibility-publication-mutation-plan.mjs';
import {
  externallyFencedSqliteWriterPlanHash,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-plan.mjs';
import {
  composeRuntimeImageReproducibilityVerification,
} from '../../paper-composition/automation/runtime-image-reproducibility-composition.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('RuntimePublicationOnlineMutationTest', { label });

function receipt(label, issuedAt = '2026-07-18T08:00:00.000Z') {
  const payload = Object.freeze({
    version: 1,
    kind: 'RuntimeImageReproducibilityReceipt',
    label,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + 60 * 60 * 1_000).toISOString(),
  });
  return Object.freeze({
    ...payload,
    runtimeImageReproducibilityReceiptHash: hashRecord(
      'RuntimeImageReproducibilityReceipt',
      payload,
    ),
  });
}

const acceptingVerifier = (candidate) => Object.freeze({
  ready: true,
  receiptAccepted: true,
  receiptHash: candidate.runtimeImageReproducibilityReceiptHash,
});

function installFinalizedMirrorPermit(database, call) {
  database.exec(`CREATE TABLE IF NOT EXISTS autonomous_research_online_mutation_authority_marker(
    reservation_id TEXT PRIMARY KEY,database_role TEXT NOT NULL,
    database_instance_id TEXT NOT NULL,operation_id TEXT NOT NULL,
    database_sequence INTEGER NOT NULL,reserve_request_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS autonomous_research_online_mutation_finalization_receipt(
    reservation_id TEXT PRIMARY KEY,side_effect_permit_hash TEXT NOT NULL,
    finalization_receipt_json TEXT NOT NULL
  ) STRICT;`);
  database.prepare(`INSERT OR IGNORE INTO autonomous_research_online_mutation_authority_marker(
    reservation_id,database_role,database_instance_id,operation_id,database_sequence,
    reserve_request_json
  ) VALUES(?,?,?,?,?,?)`).run(
    'reservation:runtime-publication:test',
    RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_ROLE,
    RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_ROLE,
    RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_OPERATION_ID,
    1,
    JSON.stringify({ sideEffectReservationHashes: call.sideEffectReservationHashes }),
  );
  database.prepare(`INSERT OR IGNORE INTO
    autonomous_research_online_mutation_finalization_receipt(
      reservation_id,side_effect_permit_hash,finalization_receipt_json
    ) VALUES(?,?,?)`).run(
    'reservation:runtime-publication:test',
    H('side-effect-permit'),
    JSON.stringify({
      reservationId: 'reservation:runtime-publication:test',
      sideEffectPermitHash: H('side-effect-permit'),
    }),
  );
}

function coordinator({ mode = 'finalized', calls = [] } = {}) {
  const local = createOfflineRuntimeImageReproducibilityPublicationMutationCoordinator();
  let pendingCall = null;
  const coveredDatabaseRoles = Object.freeze([
    RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_ROLE,
  ]);
  return Object.freeze({
    implemented: true,
    coveredDatabaseRoles,
    executeMutation(input) {
      calls.push(Object.freeze({
        databaseRole: input.databaseRole,
        databaseInstanceId: input.databaseInstanceId,
        schemaContractId: input.schemaContractId,
        writerId: input.writerId,
        operationId: input.operationId,
        authorizationReceiptHashes: Object.freeze([...input.authorizationReceiptHashes]),
        sideEffectReservationHashes: Object.freeze([
          ...input.sideEffectReservationHashes,
        ]),
      }));
      const committed = local.executeMutation(input);
      if (mode === 'finalization-pending') {
        pendingCall = calls.at(-1);
        const error = new Error(
          'externally_fenced_sqlite_mutation_committed_finalization_pending',
        );
        error.committed = true;
        error.reservationId = 'reservation:runtime-publication:test';
        throw error;
      }
      return Object.freeze({
        ...committed,
        kind: 'ExternallyFencedSqliteMutationReceipt',
        status: 'externally_fenced_sqlite_mutation_finalized',
        reservationId: 'reservation:runtime-publication:test',
        sideEffectPermitHash: mode === 'no-permit' ? null : H('side-effect-permit'),
      });
    },
    recoverPendingMutations({ database } = {}) {
      const recoveredReservationIds = [];
      if (pendingCall) {
        installFinalizedMirrorPermit(database, pendingCall);
        pendingCall = null;
        recoveredReservationIds.push('reservation:runtime-publication:test');
      }
      return Object.freeze({
        version: 1,
        kind: 'ExternallyFencedSqliteMutationRecoveryReceipt',
        status: 'externally_fenced_sqlite_mutation_recovery_complete',
        recoveredReservationIds: Object.freeze(recoveredReservationIds),
      });
    },
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

function fixture(t, { mode = 'finalized' } = {}) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-publish-online-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const provisioner = createRuntimeImageReproducibilityReceiptRepository({
    runtimeRoot,
    receiptVerifier: acceptingVerifier,
  });
  provisioner.provision();
  const calls = [];
  const repository = createRuntimeImageReproducibilityReceiptRepository({
    runtimeRoot,
    receiptVerifier: acceptingVerifier,
    offlineProvision: false,
    mutationCoordinator: coordinator({ mode, calls }),
    requireExternallyFencedMutations: true,
  });
  return { calls, repository, runtimeRoot };
}

test('runtime publication strict mode rejects DDL and unactivated coordinators before I/O',
  async (t) => {
  const runtimeRoot = path.join(os.tmpdir(), `hepta-runtime-publish-missing-${process.pid}`);
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  assert.throws(() => createRuntimeImageReproducibilityReceiptRepository({
    runtimeRoot,
    offlineProvision: true,
    mutationCoordinator: coordinator(),
    requireExternallyFencedMutations: true,
  }), /external_mutation_coordinator_required/);
  assert.equal(fs.existsSync(runtimeRoot), false);
  const configured = coordinator();
  const unactivated = Object.freeze({
    ...configured,
    inspectStatus: () => Object.freeze({
      version: 1,
      kind: 'ExternallyFencedSqliteMutationCoordinatorStatus',
      status: 'externally_fenced_sqlite_mutation_coordinator_configured',
      implemented: true,
      coveredDatabaseRoles: configured.coveredDatabaseRoles,
      blockers: Object.freeze([
        'autonomous_research_online_mutation_runtime_activation_required',
      ]),
    }),
  });
  let processCalls = 0;
  await assert.rejects(() => composeRuntimeImageReproducibilityVerification({
    action: 'publish',
    runtimeRoot,
    publicationMutationCoordinator: unactivated,
    publicationOfflineProvision: false,
    requireExternallyFencedPublication: true,
    runProcess() { processCalls += 1; },
  }), /external_mutation_coordinator_required/);
  assert.equal(processCalls, 0);
  assert.equal(fs.existsSync(runtimeRoot), false);
  assert.throws(() => externallyFencedSqliteWriterPlanHash({
    writerId: RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_ID,
    operationPlans: [{
      version: 1,
      operationId: RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_OPERATION_ID,
      statements: [{
        statementId: 'runtime-publication.ddl.v1',
        mode: 'run',
        sql: 'CREATE TABLE forbidden(id INTEGER PRIMARY KEY)',
      }],
    }],
  }), /statement_plan_invalid/);
});

test('publish uses one pinned DML plan and mirrors only after a finalized permit', (t) => {
  const { calls, repository } = fixture(t);
  const candidate = receipt('finalized');
  const publication = repository.publish({ receipt: candidate, now: new Date(candidate.issuedAt) });
  assert.equal(publication.receiptHash, candidate.runtimeImageReproducibilityReceiptHash);
  assert.equal(publication.mirrorSideEffectPermitHash, H('side-effect-permit'));
  assert.equal(repository.read().receipt.runtimeImageReproducibilityReceiptHash,
    candidate.runtimeImageReproducibilityReceiptHash);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    databaseRole: RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_ROLE,
    databaseInstanceId: RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_ROLE,
    schemaContractId: 'runtime-reproducibility-publication-schema-v1',
    writerId: RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_ID,
    operationId: RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_OPERATION_ID,
    authorizationReceiptHashes: [],
    sideEffectReservationHashes: [calls[0].sideEffectReservationHashes[0]],
  });
  assert.match(calls[0].sideEffectReservationHashes[0], /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_MUTATION_PLANS), [
    RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_OPERATION_ID,
  ]);
  assert.equal(
    RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_WRITER_PLAN_HASH,
    'sha256:28c42dadbc9796829c6e4aaf4c3a5b51b933a5d1b82d1cb2be990bc22c0fc7df',
  );
});

test('finalization pending and missing permits never write the JSON mirror', (t) => {
  for (const mode of ['finalization-pending', 'no-permit']) {
    const { repository } = fixture(t, { mode });
    const candidate = receipt(mode);
    let failure;
    try { repository.publish({ receipt: candidate, now: new Date(candidate.issuedAt) }); }
    catch (error) { failure = error; }
    assert.equal(failure?.committed, true, mode);
    assert.equal(fs.existsSync(repository.receiptPath), false, mode);
    const database = new DatabaseSync(repository.databasePath, { readOnly: true });
    try {
      assert.equal(database.prepare(
        'SELECT receipt_hash FROM runtime_image_reproducibility_receipt WHERE singleton_id=1',
      ).get().receipt_hash, candidate.runtimeImageReproducibilityReceiptHash);
    } finally { database.close(); }
  }
});

test('a post-finalize mirror failure is side-effect-only retryable without replaying DML', (t) => {
  const { calls, repository, runtimeRoot } = fixture(t);
  fs.mkdirSync(repository.receiptPath);
  const candidate = receipt('mirror-retry');
  let failure;
  try { repository.publish({ receipt: candidate, now: new Date(candidate.issuedAt) }); }
  catch (error) { failure = error; }
  assert.match(failure?.message || '', /committed_mirror_pending/);
  assert.equal(failure?.committed, true);
  assert.equal(failure?.retryableSideEffectOnly, true);
  assert.equal(calls.length, 1);
  fs.rmSync(repository.receiptPath, { recursive: true, force: true });
  const database = new DatabaseSync(repository.databasePath);
  try {
    database.exec(`CREATE TABLE autonomous_research_online_mutation_authority_marker(
      reservation_id TEXT PRIMARY KEY,database_role TEXT NOT NULL,
      database_instance_id TEXT NOT NULL,operation_id TEXT NOT NULL,
      database_sequence INTEGER NOT NULL,reserve_request_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE autonomous_research_online_mutation_finalization_receipt(
      reservation_id TEXT PRIMARY KEY,side_effect_permit_hash TEXT NOT NULL,
      finalization_receipt_json TEXT NOT NULL
    ) STRICT;`);
    database.prepare(`INSERT INTO autonomous_research_online_mutation_authority_marker(
      reservation_id,database_role,database_instance_id,operation_id,database_sequence,
      reserve_request_json
    ) VALUES(?,?,?,?,?,?)`).run(
      'reservation:runtime-publication:test',
      RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_ROLE,
      RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_DATABASE_ROLE,
      RUNTIME_IMAGE_REPRODUCIBILITY_PUBLICATION_OPERATION_ID,
      1,
      JSON.stringify({
        sideEffectReservationHashes: calls[0].sideEffectReservationHashes,
      }),
    );
    database.prepare(`INSERT INTO
      autonomous_research_online_mutation_finalization_receipt(
        reservation_id,side_effect_permit_hash,finalization_receipt_json
      ) VALUES(?,?,?)`).run(
      'reservation:runtime-publication:test',
      H('side-effect-permit'),
      JSON.stringify({
        reservationId: 'reservation:runtime-publication:test',
        sideEffectPermitHash: H('side-effect-permit'),
      }),
    );
  } finally { database.close(); }
  const restarted = createRuntimeImageReproducibilityReceiptRepository({
    runtimeRoot,
    receiptVerifier: acceptingVerifier,
    offlineProvision: false,
    mutationCoordinator: coordinator(),
    requireExternallyFencedMutations: true,
  });
  const reconciliation = restarted.reconcileMirror();
  assert.equal(reconciliation.receiptHash,
    candidate.runtimeImageReproducibilityReceiptHash);
  assert.equal(reconciliation.sideEffectPermitHash, H('side-effect-permit'));
  assert.equal(calls.length, 1);
  assert.equal(restarted.read().receipt.runtimeImageReproducibilityReceiptHash,
    candidate.runtimeImageReproducibilityReceiptHash);
});

test('finalization pending recovers in the same process without replaying publication DML',
  (t) => {
  const { calls, repository } = fixture(t, { mode: 'finalization-pending' });
  const candidate = receipt('same-process-finalization-recovery');
  let failure;
  try { repository.publish({ receipt: candidate, now: new Date(candidate.issuedAt) }); }
  catch (error) { failure = error; }
  assert.equal(failure?.committed, true);
  assert.equal(calls.length, 1);
  const recovery = repository.recoverPendingPublication();
  assert.equal(
    recovery.status,
    'runtime_image_reproducibility_pending_publication_recovered',
  );
  assert.deepEqual(recovery.recoveredReservationIds, [
    'reservation:runtime-publication:test',
  ]);
  assert.equal(calls.length, 1);
  assert.equal(
    repository.read().receipt.runtimeImageReproducibilityReceiptHash,
    candidate.runtimeImageReproducibilityReceiptHash,
  );
});
