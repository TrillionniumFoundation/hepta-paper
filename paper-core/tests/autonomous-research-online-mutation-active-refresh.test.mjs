import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_RELATIVE_PATH,
  createAutonomousResearchOnlineAuthorityEvidenceCacheReader,
  createAutonomousResearchOnlineAuthorityEvidenceCacheWriter,
} from '../../paper-adapters/automation/autonomous-research-online-authority-evidence-cache.mjs';
import {
  refreshAutonomousResearchOnlineMutationAuthorityEvidence,
} from '../../paper-adapters/automation/autonomous-research-online-mutation-active-refresh.mjs';
import {
  inspectAutonomousResearchOnlineMutationPassiveEvidence,
} from '../../paper-adapters/automation/autonomous-research-online-mutation-passive-inspection.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_CONTRACT_HASH,
} from '../../paper-domain/automation/autonomous-research-online-authority-evidence-cache-contract.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = '2026-07-18T08:00:00.000Z';
const EXPIRES_AT = '2026-07-18T08:05:00.000Z';
const H = (label) => hashRecord('AutonomousResearchOnlineActiveRefreshTest', { label });

function inventory() {
  return Object.freeze({
    status: 'autonomous_research_state_database_inventory_ready',
    databaseScopeHash: H('database-scope'),
    instances: Object.freeze(AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.map((role) => Object.freeze({
      role,
      instanceId: role,
      schemaHash: H(`schema:${role}`),
    }))),
  });
}

function staticInspection() {
  return Object.freeze({
    status: 'autonomous_research_online_writer_static_coverage_complete',
    blockers: Object.freeze([]),
    astGateReceiptHash: H('ast-gate'),
    codeProvenanceHash: H('code-provenance'),
    operationCount: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST.operations.length,
    operationIds: Object.freeze(AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST.operations
      .map((operation) => operation.operationId).sort()),
  });
}

function fakeAuthorityClient({
  inspectedInventory,
  unstableFirstAttempt = false,
  globalSequence = 10,
  globalHash = H('global-head'),
  expiresAt = EXPIRES_AT,
} = {}) {
  const calls = [];
  const trust = Object.freeze({
    scopeId: 'test-scope',
    databaseScopeHash: inspectedInventory.databaseScopeHash,
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(
      AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    ),
  });
  const heads = Object.freeze(inspectedInventory.instances.map((entry) => Object.freeze({
    databaseRole: entry.role,
    databaseInstanceId: entry.instanceId,
    sequence: 0,
    hash: H(`head:${entry.instanceId}`),
    schemaHash: entry.schemaHash,
    stateHash: H(`state:${entry.instanceId}`),
  })).sort((left, right) => left.databaseInstanceId.localeCompare(right.databaseInstanceId)));
  let challengeCalls = 0;
  const client = Object.freeze({
    trust,
    observeCurrentHead({ request }) {
      calls.push(request);
      return Object.freeze({
        kind: 'AutonomousResearchOnlineMutationCurrentHeadReceipt',
        authorityId: 'authority:test',
        keyId: 'key:test',
        requestHash: hashRecord('AutonomousResearchOnlineMutationCurrentHeadRequest', request),
        globalSequence,
        globalHash,
        databaseHeads: heads,
        observedAt: NOW,
        expiresAt,
      });
    },
    observeScope({ request }) {
      calls.push(request);
      return Object.freeze({
        ...request,
        kind: 'AutonomousResearchOnlineMutationScopeReceipt',
        authorityId: 'authority:test',
        keyId: 'key:test',
        requestHash: hashRecord('AutonomousResearchOnlineMutationScopeRequest', request),
        globalSequence,
        globalHash,
        observedAt: NOW,
        expiresAt,
      });
    },
    challengeActiveAuthority({ request }) {
      calls.push(request);
      challengeCalls += 1;
      return Object.freeze({
        kind: 'AutonomousResearchOnlineMutationActiveChallengeReceipt',
        authorityId: 'authority:test',
        keyId: 'key:test',
        requestHash: hashRecord(
          'AutonomousResearchOnlineMutationActiveChallengeRequest', request,
        ),
        globalSequence: unstableFirstAttempt && challengeCalls === 1
          ? globalSequence + 1 : globalSequence,
        globalHash: unstableFirstAttempt && challengeCalls === 1
          ? H('unstable-head') : globalHash,
        databaseHeads: heads,
        challengeNonce: request.challengeNonce,
        challengedAt: NOW,
        expiresAt,
      });
    },
  });
  return { client, calls };
}

function refresh(runtimeRoot, inspectedInventory, authority, extra = {}) {
  return refreshAutonomousResearchOnlineMutationAuthorityEvidence({
    workspaceRoot: '/workspace',
    runtimeRoot,
    inventory: inspectedInventory,
    authorityProcessConfigurationPath: '/authority-process.json',
    clock: { now: () => new Date(NOW) },
    createAuthorityClient: () => authority.client,
    inspectStaticCoverage: staticInspection,
    ...extra,
  });
}

function cachePath(runtimeRoot) {
  return path.join(
    runtimeRoot,
    ...AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_RELATIVE_PATH.split('/'),
  );
}

function rawCacheDocument(runtimeRoot) {
  return JSON.parse(fs.readFileSync(cachePath(runtimeRoot), 'utf8'));
}

function writeCache(runtimeRoot, receipt, inspectedInventory, expiresAt = EXPIRES_AT) {
  return createAutonomousResearchOnlineAuthorityEvidenceCacheWriter({
    runtimeRoot,
  }).recordActiveAuthorityEvidence({
    activeRefreshReceipt: receipt,
    databaseScopeHash: inspectedInventory.databaseScopeHash,
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(
      AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    ),
    expiresAt,
  });
}

function readCache(runtimeRoot, inspectedInventory, now = new Date(NOW)) {
  return createAutonomousResearchOnlineAuthorityEvidenceCacheReader({
    runtimeRoot,
  }).readPassiveAuthorityEvidence({
    databaseScopeHash: inspectedInventory.databaseScopeHash,
    writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(
      AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    ),
    now,
  });
}

test('active refresh is no-write and an explicit derived cache round-trips signed evidence', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-online-refresh-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const inspectedInventory = inventory();
  const authority = fakeAuthorityClient({ inspectedInventory, unstableFirstAttempt: true });
  const receipt = refresh(runtimeRoot, inspectedInventory, authority);
  assert.equal(receipt.externalActionPerformed, true);
  assert.equal(receipt.linearizationAttemptCount, 2);
  assert.equal(receipt.journalRecorded, false);
  assert.equal(receipt.journalReceipt, null);
  assert.equal(authority.calls.length, 6);
  assert.equal(fs.existsSync(cachePath(runtimeRoot)), false);

  const writeReceipt = writeCache(runtimeRoot, receipt, inspectedInventory);
  assert.equal(writeReceipt.status, 'autonomous_research_online_authority_evidence_cache_recorded');
  assert.equal(fs.statSync(cachePath(runtimeRoot)).mode & 0o777, 0o400);
  const evidence = readCache(runtimeRoot, inspectedInventory);
  assert.equal(evidence.externalActionPerformed, false);
  assert.equal(evidence.cacheRole, 'passive-status-only-never-mutation-authorization');
  assert.equal(evidence.currentHead.receipt.globalSequence, 10);
  assert.equal(evidence.activeChallenge.receipt.challengeNonce, authority.calls[5].challengeNonce);
});

test('cache replacement rejects sequence, time, and same-sequence hash rollback', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-online-refresh-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const inspectedInventory = inventory();
  const receipt = ({
    globalSequence, globalHash, recordedAt, expiresAt = EXPIRES_AT,
  }) => refresh(
    runtimeRoot,
    inspectedInventory,
    fakeAuthorityClient({ inspectedInventory, globalSequence, globalHash, expiresAt }),
    { clock: { now: () => new Date(recordedAt) } },
  );
  const current = receipt({
    globalSequence: 20,
    globalHash: H('monotonic-head-20'),
    recordedAt: '2026-07-18T08:01:00.000Z',
  });
  writeCache(runtimeRoot, current, inspectedInventory);
  assert.doesNotThrow(() => writeCache(runtimeRoot, current, inspectedInventory));

  assert.throws(() => writeCache(runtimeRoot, receipt({
    globalSequence: 19,
    globalHash: H('monotonic-head-19'),
    recordedAt: '2026-07-18T08:02:00.000Z',
  }), inspectedInventory),
  /autonomous_research_online_authority_evidence_cache_global_sequence_rollback/);
  assert.throws(() => writeCache(runtimeRoot, receipt({
    globalSequence: 20,
    globalHash: H('equivocated-head-20'),
    recordedAt: '2026-07-18T08:02:00.000Z',
  }), inspectedInventory),
  /autonomous_research_online_authority_evidence_cache_global_hash_conflict/);
  assert.throws(() => writeCache(runtimeRoot, receipt({
    globalSequence: 21,
    globalHash: H('monotonic-head-21'),
    recordedAt: '2026-07-18T08:00:00.000Z',
  }), inspectedInventory),
  /autonomous_research_online_authority_evidence_cache_recorded_at_rollback/);
  assert.throws(() => writeCache(runtimeRoot, receipt({
    globalSequence: 21,
    globalHash: H('monotonic-head-21'),
    recordedAt: '2026-07-18T08:02:00.000Z',
    expiresAt: '2026-07-18T08:04:00.000Z',
  }), inspectedInventory, '2026-07-18T08:04:00.000Z'),
  /autonomous_research_online_authority_evidence_cache_expiry_rollback/);
  assert.throws(() => writeCache(runtimeRoot, receipt({
    globalSequence: 21,
    globalHash: H('monotonic-head-21'),
    recordedAt: '2026-07-18T08:02:00.000Z',
  }), inspectedInventory),
  /autonomous_research_online_authority_evidence_cache_expiry_rollback/);

  const stored = rawCacheDocument(runtimeRoot);
  assert.equal(stored.authorityGlobalSequence, 20);
  assert.equal(stored.authorityGlobalHash, H('monotonic-head-20'));
  assert.equal(stored.recordedAt, '2026-07-18T08:01:00.000Z');
  assert.equal(fs.readdirSync(path.dirname(cachePath(runtimeRoot)))
    .some((name) => name.includes('.hepta-materialization.lock')), false);

  writeCache(runtimeRoot, receipt({
    globalSequence: 20,
    globalHash: H('monotonic-head-20'),
    recordedAt: '2026-07-18T08:03:00.000Z',
    expiresAt: '2026-07-18T08:06:00.000Z',
  }), inspectedInventory, '2026-07-18T08:06:00.000Z');
  assert.equal(rawCacheDocument(runtimeRoot).recordedAt, '2026-07-18T08:03:00.000Z');
  assert.equal(rawCacheDocument(runtimeRoot).expiresAt, '2026-07-18T08:06:00.000Z');
});

test('cache replacement lock rejects a writer inside the read-to-rename window', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-online-refresh-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const inspectedInventory = inventory();
  const outerReceipt = refresh(
    runtimeRoot,
    inspectedInventory,
    fakeAuthorityClient({
      inspectedInventory,
      globalSequence: 20,
      globalHash: H('concurrent-head-20'),
    }),
    { clock: { now: () => new Date('2026-07-18T08:01:00.000Z') } },
  );
  const competingReceipt = refresh(
    runtimeRoot,
    inspectedInventory,
    fakeAuthorityClient({
      inspectedInventory,
      globalSequence: 19,
      globalHash: H('concurrent-head-19'),
    }),
    { clock: { now: () => new Date('2026-07-18T08:02:00.000Z') } },
  );
  const renameSync = fs.renameSync;
  let injected = false;
  let contentionError = null;
  fs.renameSync = (from, to) => {
    if (!injected
      && String(from).includes('.current.json.hepta-')
      && String(to).endsWith('/current.json')) {
      injected = true;
      try { writeCache(runtimeRoot, competingReceipt, inspectedInventory); }
      catch (error) { contentionError = error; }
    }
    return renameSync(from, to);
  };
  t.after(() => { fs.renameSync = renameSync; });

  writeCache(runtimeRoot, outerReceipt, inspectedInventory);
  assert.equal(injected, true);
  assert.match(
    contentionError?.message || '',
    /scoped_materialization_destination_locked:current\.json/,
  );
  assert.equal(rawCacheDocument(runtimeRoot).authorityGlobalSequence, 20);
});

test('passive anti-rollback inspection verifies the scoped cache without external action', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-online-refresh-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const inspectedInventory = inventory();
  const authority = fakeAuthorityClient({ inspectedInventory });
  const receipt = refresh(runtimeRoot, inspectedInventory, authority, {
    workspaceRoot: process.cwd(),
    inspectStaticCoverage: undefined,
  });
  writeCache(runtimeRoot, receipt, inspectedInventory);
  const coveredDatabaseRoles = Object.freeze([
    ...AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST.coverage.coveredDatabaseRoles,
  ]);
  const verifier = Object.freeze({
    configurationHash: H('authority-configuration'),
    trust: Object.freeze({
      databaseScopeHash: inspectedInventory.databaseScopeHash,
      writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(
        AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
      ),
    }),
    verifyCurrentHead: () => true,
    verifyActiveChallenge: () => true,
    verifyScope: () => true,
  });
  const inspection = inspectAutonomousResearchOnlineMutationPassiveEvidence({
    workspaceRoot: process.cwd(),
    runtimeRoot,
    inventory: inspectedInventory,
    authorityConfigurationPath: '/authority-public.json',
    now: new Date(NOW),
    coordinatorStatus: Object.freeze({
      implemented: true,
      status: 'externally_fenced_sqlite_mutation_coordinator_ready',
      coveredDatabaseRoles,
      blockers: Object.freeze([]),
    }),
    createReceiptVerifier: () => verifier,
  });
  assert.equal(inspection.status, 'autonomous_research_online_anti_rollback_ready');
  assert.equal(inspection.inspectionMode, 'passive-signed-receipt-validation');
  assert.equal(inspection.externalActionPerformed, false);
  assert.equal(
    inspection.journalSchemaContractHash,
    AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_EVIDENCE_CACHE_CONTRACT_HASH,
  );
});

test('an unstable broker head is fail-closed and creates no cache', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-online-refresh-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const inspectedInventory = inventory();
  const authority = fakeAuthorityClient({ inspectedInventory, unstableFirstAttempt: true });
  assert.throws(
    () => refresh(runtimeRoot, inspectedInventory, authority, { maximumLinearizationAttempts: 1 }),
    /autonomous_research_online_mutation_active_refresh_head_unstable/,
  );
  assert.equal(fs.existsSync(cachePath(runtimeRoot)), false);
});

test('legacy callers cannot request a pre-validation journal write', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-online-refresh-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const inspectedInventory = inventory();
  const authority = fakeAuthorityClient({ inspectedInventory });
  assert.throws(
    () => refresh(runtimeRoot, inspectedInventory, authority, { recordJournalEvidence: true }),
    /autonomous_research_online_mutation_active_refresh_configuration_invalid/,
  );
  assert.equal(authority.calls.length, 0);
});

test('cache reader rejects content tampering even when permissions are restored', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-online-refresh-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const inspectedInventory = inventory();
  const receipt = refresh(
    runtimeRoot,
    inspectedInventory,
    fakeAuthorityClient({ inspectedInventory }),
  );
  writeCache(runtimeRoot, receipt, inspectedInventory);
  fs.chmodSync(cachePath(runtimeRoot), 0o600);
  fs.writeFileSync(cachePath(runtimeRoot), '{"version":1}\n');
  fs.chmodSync(cachePath(runtimeRoot), 0o400);
  assert.throws(
    () => readCache(runtimeRoot, inspectedInventory),
    /autonomous_research_online_authority_evidence_cache_refresh_invalid/,
  );
});

test('cache writer rejects a symlink target and unsafe existing permissions', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-online-refresh-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const inspectedInventory = inventory();
  const receipt = refresh(
    runtimeRoot,
    inspectedInventory,
    fakeAuthorityClient({ inspectedInventory }),
  );
  fs.mkdirSync(path.dirname(cachePath(runtimeRoot)), { recursive: true, mode: 0o700 });
  const outside = path.join(runtimeRoot, 'outside.json');
  fs.writeFileSync(outside, '{}\n', { mode: 0o600 });
  fs.symlinkSync(outside, cachePath(runtimeRoot));
  assert.throws(
    () => writeCache(runtimeRoot, receipt, inspectedInventory),
    /scoped_materialization_destination_unsafe/,
  );
  fs.unlinkSync(cachePath(runtimeRoot));
  writeCache(runtimeRoot, receipt, inspectedInventory);
  fs.chmodSync(cachePath(runtimeRoot), 0o600);
  assert.throws(
    () => writeCache(runtimeRoot, receipt, inspectedInventory),
    /autonomous_research_online_authority_evidence_cache_file_unsafe/,
  );
});

test('passive cache use fails closed after its signed evidence window expires', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-online-refresh-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const inspectedInventory = inventory();
  const receipt = refresh(
    runtimeRoot,
    inspectedInventory,
    fakeAuthorityClient({ inspectedInventory }),
  );
  writeCache(runtimeRoot, receipt, inspectedInventory);
  assert.throws(
    () => readCache(runtimeRoot, inspectedInventory, new Date(EXPIRES_AT)),
    /autonomous_research_online_authority_evidence_cache_invalid/,
  );
});
