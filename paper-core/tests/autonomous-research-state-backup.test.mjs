import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  autonomousResearchStateBackupAuthorityReceiptHash,
  autonomousResearchStateBackupAuthoritySignaturePayload,
  createAutonomousResearchStateBackupAuthorityProcessClient,
} from '../../paper-adapters/automation/autonomous-research-state-backup-authority.mjs';
import {
  createAutonomousResearchStateBackup,
  drillAutonomousResearchStateRestore,
  resolveLatestAutonomousResearchStateBackupSources,
} from '../../paper-adapters/automation/autonomous-research-state-backup-repository.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {
  composeAutonomousResearchStateBackupService,
} from '../../paper-composition/bootstrap/autonomous-research-state-backup-composition.mjs';
import { fileSha256HashSync } from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import {
  assertAutonomousResearchStateDatabaseManifest,
  autonomousResearchStateBackupBundleManifestHash,
  autonomousResearchStateDatabaseManifestHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const stateDatabaseManifest = JSON.parse(fs.readFileSync(path.join(
  repositoryRoot,
  'paper-core',
  'config',
  'autonomous-research-state-databases.v1.json',
), 'utf8'));

function createDatabase(candidate, marker, requiredSchemaObjects = []) {
  fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(candidate);
  try {
    database.exec(`
PRAGMA foreign_keys=ON;
CREATE TABLE parent(id TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE child(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL REFERENCES parent(id));
INSERT INTO parent(id,value) VALUES('subject','${marker}');
INSERT INTO child(id,parent_id) VALUES('child','subject');
PRAGMA user_version=1;
`);
    for (const schemaObject of requiredSchemaObjects) {
      const [type, name] = schemaObject.split(':');
      const identifier = `"${name}"`;
      if (type === 'table') {
        database.exec(`CREATE TABLE ${identifier}(id TEXT PRIMARY KEY);`);
      } else if (type === 'index') {
        database.exec(`CREATE INDEX ${identifier} ON parent(value);`);
      } else if (type === 'trigger') {
        database.exec(`CREATE TRIGGER ${identifier} BEFORE UPDATE ON parent BEGIN SELECT 1; END;`);
      } else if (type === 'view') {
        database.exec(`CREATE VIEW ${identifier} AS SELECT id,value FROM parent;`);
      } else {
        throw new Error(`unsupported_test_schema_object:${schemaObject}`);
      }
    }
  } finally { database.close(); }
}

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-state-backup-'));
  const runtimeRoot = path.join(parent, 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'paper-automation.sqlite'), '', { mode: 0o600 });
  const databasePaths = stateDatabaseManifest.databases.map((definition, index) => {
    const relative = definition.cardinality === 'per-paper'
      ? definition.relativePathPattern.replace('{paperId}', 'paper-alpha')
      : definition.relativePath;
    const candidate = path.join(runtimeRoot, relative);
    createDatabase(candidate, `db-${index + 1}`, definition.requiredSchemaObjects);
    return candidate;
  });
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, runtimeRoot, databasePaths };
}

function createAuthority(clock) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const trust = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateBackupAuthorityTrust',
    authorityId: 'test-authority',
    keyId: 'test-key-1',
    publicKey,
    maximumReservationLeaseMs: 60000,
    maximumHeadObservationAgeMs: 60000,
  });
  let headSequence = 41;
  let headHash = hashRecord('TestAuthorityHead', { headSequence });
  let reservation = null;
  const sign = (payload) => Object.freeze({
    ...payload,
    signature: crypto.sign(
      null,
      Buffer.from(autonomousResearchStateBackupAuthoritySignaturePayload(payload), 'utf8'),
      privateKey,
    ).toString('base64'),
  });
  const client = Object.freeze({
    reserveSnapshot(request) {
      const issuedAt = clock.now().toISOString();
      reservation = sign({
        version: 1,
        kind: 'AutonomousResearchStateBackupAuthorityReservation',
        status: 'autonomous_research_state_backup_authority_reserved',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchStateBackupAuthorityReserveRequest', request),
        reservationId: 'reservation-0001',
        inventoryHash: request.inventoryHash,
        databaseScopeHash: request.databaseScopeHash,
        databaseInstanceIds: [...request.databaseInstanceIds].sort(),
        headSequence,
        headHash,
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + 60000).toISOString(),
        mutationFenceProtocol: 'external-linearizable-reserve-apply-finalize-v1',
        allRegisteredMutationsFenced: true,
      });
      return reservation;
    },
    finalizeSnapshot(request) {
      return sign({
        version: 1,
        kind: 'AutonomousResearchStateBackupAuthorityFinalization',
        status: 'autonomous_research_state_backup_authority_finalized',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchStateBackupAuthorityFinalizeRequest', request),
        reservationId: reservation.reservationId,
        inventoryHash: reservation.inventoryHash,
        databaseScopeHash: reservation.databaseScopeHash,
        snapshotContentHash: request.snapshotContentHash,
        headSequence: reservation.headSequence,
        headHash: reservation.headHash,
        finalizedAt: clock.now().toISOString(),
        allRegisteredMutationsFencedThroughFinalize: true,
      });
    },
    observeCurrentHead(request) {
      return sign({
        version: 1,
        kind: 'AutonomousResearchStateBackupAuthorityCurrentHead',
        status: 'autonomous_research_state_backup_authority_head_observed',
        authorityId: trust.authorityId,
        keyId: trust.keyId,
        requestHash: hashRecord('AutonomousResearchStateBackupAuthorityCurrentHeadRequest', request),
        reservationId: request.reservationId,
        databaseScopeHash: request.databaseScopeHash,
        headSequence,
        headHash,
        observedAt: clock.now().toISOString(),
        expiresAt: new Date(clock.now().getTime() + 60000).toISOString(),
        mutationFenceProtocol: 'external-linearizable-restore-validation-v1',
        allRegisteredMutationsFenced: true,
      });
    },
  });
  return Object.freeze({
    trust,
    client,
    advanceHead() {
      headSequence += 1;
      headHash = hashRecord('TestAuthorityHead', { headSequence });
    },
  });
}

function fixedClock() {
  let current = new Date('2026-07-18T06:00:00.000Z');
  return Object.freeze({
    now: () => new Date(current),
    advance: (milliseconds) => { current = new Date(current.getTime() + milliseconds); },
  });
}

test('state manifest cannot omit the per-database online authority schema', () => {
  assert.doesNotThrow(() => (
    assertAutonomousResearchStateDatabaseManifest(stateDatabaseManifest)
  ));
  assert.equal(
    autonomousResearchStateDatabaseManifestHash(stateDatabaseManifest),
    'sha256:bab1b625bfba87ac4cc375406b6be3cb335fbacb56fe1ec0deef749cca5871e6',
  );
  const weakened = structuredClone(stateDatabaseManifest);
  weakened.databases[0].requiredSchemaObjects = weakened.databases[0]
    .requiredSchemaObjects.filter((entry) => (
      entry !== 'table:autonomous_research_online_mutation_authority_marker'
    ));
  assert.throws(
    () => assertAutonomousResearchStateDatabaseManifest(weakened),
    /autonomous_research_state_database_online_authority_schema_required/,
  );
});

async function successfulBackup(t) {
  const setup = fixture(t);
  const clock = fixedClock();
  const authority = createAuthority(clock);
  const backupRoot = path.join(setup.runtimeRoot, 'backups', 'autonomous-research-state');
  const receipt = await createAutonomousResearchStateBackup({
    runtimeRoot: setup.runtimeRoot,
    backupRoot,
    stateDatabaseManifest,
    authorityClient: authority.client,
    authorityTrust: authority.trust,
    clock,
  });
  assert.equal(receipt.status, 'autonomous_research_state_backup_recorded');
  return { ...setup, clock, authority, backupRoot, receipt };
}

test('backup repository validates injected clocks and derives safe default bundle paths', async (t) => {
  const setup = fixture(t);
  const authorityClock = fixedClock();
  const authority = createAuthority(authorityClock);
  const invalidClock = await createAutonomousResearchStateBackup({
    runtimeRoot: setup.runtimeRoot,
    stateDatabaseManifest,
    authorityClient: authority.client,
    authorityTrust: authority.trust,
    clock: { now: () => 'not-a-date' },
  });
  assert.equal(invalidClock.status, 'autonomous_research_state_backup_blocked');
  assert.ok(invalidClock.blockers.includes(
    'autonomous_research_state_backup_clock_invalid',
  ));

  const outsideRoot = path.join(setup.parent, 'outside-backup-root');
  const escapedBundle = path.join(outsideRoot, 'bundle');
  fs.mkdirSync(escapedBundle, { recursive: true });
  const escapedParent = path.join(setup.runtimeRoot, 'escaped-parent');
  fs.symlinkSync(outsideRoot, escapedParent, 'dir');
  const escapedRestore = await drillAutonomousResearchStateRestore({
    bundlePath: path.join(escapedParent, 'bundle'),
    backupRoot: setup.runtimeRoot,
    stateDatabaseManifest,
    authorityClient: authority.client,
    authorityTrust: authority.trust,
    clock: authorityClock,
  });
  assert.equal(escapedRestore.status, 'autonomous_research_state_restore_drill_blocked');
  assert.ok(escapedRestore.blockers.includes(
    'autonomous_research_state_backup_bundle_path_unsafe',
  ));

  const validClock = fixedClock();
  const validAuthority = createAuthority(validClock);
  const backup = await createAutonomousResearchStateBackup({
    runtimeRoot: setup.runtimeRoot,
    stateDatabaseManifest,
    authorityClient: validAuthority.client,
    authorityTrust: validAuthority.trust,
    clock: validClock,
  });
  assert.equal(backup.status, 'autonomous_research_state_backup_recorded');
  assert.equal(
    path.dirname(backup.bundlePath),
    path.join(setup.runtimeRoot, 'backups', 'autonomous-research-state'),
  );

  const restore = await drillAutonomousResearchStateRestore({
    bundlePath: backup.bundlePath,
    stateDatabaseManifest,
    authorityClient: validAuthority.client,
    authorityTrust: validAuthority.trust,
    clock: validClock,
  });
  assert.equal(restore.status, 'autonomous_research_state_restore_drill_passed');
});

test('backup composition exposes every service boundary and fails closed without external authorities', async (t) => {
  const setup = fixture(t);
  const service = composeAutonomousResearchStateBackupService({
    workspaceRoot: repositoryRoot,
    runtimeRoot: setup.runtimeRoot,
    clock: fixedClock(),
  });

  assert.equal(service.authorityConfigured, false);
  assert.equal(service.authorityConfigurationHash, null);
  assert.equal(service.onlineMutationAuthorityConfigured, false);
  assert.equal(service.onlineMutationAuthorityConfigurationHash, null);
  assert.equal(service.manifestPath, path.join(
    repositoryRoot,
    'paper-core',
    'config',
    'autonomous-research-state-databases.v1.json',
  ));
  assert.equal(service.backupRoot, path.join(
    setup.runtimeRoot,
    'backups',
    'autonomous-research-state',
  ));
  assert.equal(
    service.inventory().status,
    'autonomous_research_state_database_inventory_ready',
  );

  const backup = await service.backup();
  assert.equal(backup.status, 'autonomous_research_state_backup_blocked');
  assert.ok(backup.blockers.includes(
    'autonomous_research_state_backup_external_authority_required',
  ));

  const nonexistentBundle = path.join(service.backupRoot, 'nonexistent-bundle');
  const restore = await service.restoreDrill({ bundlePath: nonexistentBundle });
  assert.equal(restore.status, 'autonomous_research_state_restore_drill_blocked');
  assert.ok(restore.blockers.includes(
    'autonomous_research_state_restore_external_authority_required',
  ));

  const renewal = await service.renew();
  assert.equal(renewal.status, 'autonomous_research_state_backup_renewal_blocked');
  assert.ok(renewal.blockers.includes(
    'autonomous_research_state_backup_external_authority_required',
  ));

  const pending = await service.reconcilePending();
  assert.equal(
    pending.status,
    'autonomous_research_state_pending_reconciliation_blocked',
  );
  assert.ok(pending.blockers.includes(
    'autonomous_research_state_reconcile_and_renew_authority_scope_mismatch',
  ));

  const reconciled = await service.reconcileAndRenew();
  assert.equal(
    reconciled.status,
    'autonomous_research_state_reconcile_and_renew_blocked',
  );
  assert.ok(reconciled.blockers.includes(
    'autonomous_research_state_reconcile_and_renew_authority_scope_mismatch',
  ));

  const head = await service.observeBundleHead({ bundlePath: nonexistentBundle });
  assert.equal(head.status, 'autonomous_research_state_backup_current_head_blocked');
  assert.ok(head.blockers.includes(
    'autonomous_research_state_restore_external_authority_required',
  ));

  const sources = service.offhostSources();
  assert.equal(sources.status, 'autonomous_research_state_backup_sources_blocked');
  assert.ok(sources.blockers.includes(
    'autonomous_research_state_backup_source_authority_trust_required',
  ));
});

test('canonical inventory covers every autonomous trust database and blocks unknown SQLite state', (t) => {
  const setup = fixture(t);
  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  assert.equal(inventory.status, 'autonomous_research_state_database_inventory_ready');
  assert.equal(inventory.instances.length, 10);
  assert.deepEqual(inventory.instances.map((entry) => entry.role).sort(), [
    'external-qualification',
    'full-research-qualification-publication',
    'machine-intake',
    'native-store',
    'resident-instance',
    'runtime-reproducibility-publication',
    'runtime-reproducibility-refresh',
    'submission-handoff',
    'supervisor-state',
    'topic-producer',
  ]);
  assert.equal(inventory.instances.every((entry) => (
    entry.schemaContractId && entry.missingSchemaObjects.length === 0
  )), true);
  const externalQualification = inventory.instances.find((entry) => (
    entry.role === 'external-qualification'
  ));
  assert.equal(externalQualification.instanceId, 'external-qualification');
  assert.equal(externalQualification.paperId, null);
  assert.equal(
    externalQualification.sourceRelativePath,
    'autonomous-research/qualification/external-qualification-state.sqlite',
  );

  const residentPath = path.join(
    setup.runtimeRoot,
    'autonomous-research/supervisor/resident-instance.sqlite',
  );
  const residentDatabase = new DatabaseSync(residentPath);
  residentDatabase.exec('DROP TABLE autonomous_research_supervisor_instance;');
  residentDatabase.close();
  const schemaBlocked = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  assert.ok(schemaBlocked.blockers.some((entry) => entry.startsWith(
    'autonomous_research_state_database_schema_contract_mismatch:resident-instance:',
  )));
  const repairedResidentDatabase = new DatabaseSync(residentPath);
  repairedResidentDatabase.exec(
    'CREATE TABLE "autonomous_research_supervisor_instance"(id TEXT PRIMARY KEY);',
  );
  repairedResidentDatabase.close();

  createDatabase(path.join(setup.runtimeRoot, 'unregistered-root-state.sqlite'), 'unknown-root');
  const rootBlocked = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  assert.ok(rootBlocked.blockers.includes(
    'autonomous_research_state_database_unregistered:unregistered-root-state.sqlite',
  ));
  fs.rmSync(path.join(setup.runtimeRoot, 'unregistered-root-state.sqlite'));

  const legacyQualificationRelativePath =
    'autonomous-research/paper-alpha/system-state/external-qualification-state.sqlite';
  const legacyPerPaperQualification = path.join(
    setup.runtimeRoot,
    legacyQualificationRelativePath,
  );
  createDatabase(legacyPerPaperQualification, 'legacy-per-paper-qualification');
  const legacyScopeBlocked = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  assert.ok(legacyScopeBlocked.blockers.includes(
    `autonomous_research_state_database_unregistered:${legacyQualificationRelativePath}`,
  ));
  fs.rmSync(legacyPerPaperQualification);

  createDatabase(path.join(setup.runtimeRoot, 'paper-automation.sqlite'), 'no-longer-empty');
  const exclusionBlocked = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  assert.ok(exclusionBlocked.blockers.some((entry) => (
    entry.startsWith('autonomous_research_state_database_exclusion_invalid:paper-automation.sqlite:')
  )));
  fs.rmSync(path.join(setup.runtimeRoot, 'paper-automation.sqlite'));
  fs.writeFileSync(path.join(setup.runtimeRoot, 'paper-automation.sqlite'), '', { mode: 0o600 });

  const unregisteredPath = path.join(setup.runtimeRoot, 'autonomous-research', 'unregistered.sqlite');
  createDatabase(unregisteredPath, 'unknown');
  const blocked = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  assert.equal(blocked.status, 'autonomous_research_state_database_inventory_blocked');
  assert.ok(blocked.blockers.some((entry) => entry.includes('state_database_unregistered')));
  fs.rmSync(unregisteredPath);
  fs.writeFileSync(path.join(setup.runtimeRoot, 'paper-automation.sqlite'), 'not-retired-state');
  const nonEmptyExclusion = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: setup.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  assert.equal(nonEmptyExclusion.status, 'autonomous_research_state_database_inventory_blocked');
  assert.ok(nonEmptyExclusion.blockers.includes(
    'autonomous_research_state_database_exclusion_invalid:paper-automation.sqlite',
  ));
});

test('production CLI status is wired to the canonical closed database inventory', (t) => {
  const setup = fixture(t);
  const result = spawnSync(process.execPath, [
    path.join(repositoryRoot, 'paper-core', 'bin', 'autonomous-research-state-backup.mjs'),
    '--action', 'status', '--runtime-root', setup.runtimeRoot,
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'autonomous_research_state_database_inventory_ready');
  assert.equal(report.instances.length, 10);
});

test('production backup CLI fails closed for help, invalid actions, and incomplete drills', () => {
  const cli = path.join(
    repositoryRoot,
    'paper-core',
    'bin',
    'autonomous-research-state-backup.mjs',
  );
  const help = spawnSync(process.execPath, [cli, '--help'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout,
    /status\|backup\|restore-drill\|renew\|reconcile-and-renew/);
  assert.match(help.stdout, /signed linearizable authority-head protocol/);

  const invalid = spawnSync(process.execPath, [cli, '--action', 'publish'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /autonomous_research_state_backup_action_invalid:publish/);

  const missingBundle = spawnSync(process.execPath, [cli, '--action', 'restore-drill'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(missingBundle.status, 1);
  assert.match(missingBundle.stderr, /autonomous_research_state_backup_bundle_required/);

  const missingStartupAuthorities = spawnSync(process.execPath, [
    cli, '--action', 'reconcile-and-renew',
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(missingStartupAuthorities.status, 1);
  assert.match(missingStartupAuthorities.stderr,
    /autonomous_research_state_reconcile_and_renew_authority_configuration_required/);
});

test('production authority adapter accepts only a public-key-only identity document', (t) => {
  const setup = fixture(t);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPath = path.join(setup.parent, 'authority-public-key.json');
  const configurationPath = path.join(setup.parent, 'authority-process.json');
  const commandPath = process.execPath;
  const writePublicKey = (publicKeyPem) => fs.writeFileSync(publicKeyPath, `${JSON.stringify({
    version: 1,
    kind: 'AutonomousResearchStateBackupAuthorityPublicKey',
    authorityId: 'external-backup-authority',
    keyId: 'external-backup-key-1',
    algorithm: 'ed25519',
    publicKeyPem,
  })}\n`, { mode: 0o600 });
  writePublicKey(publicKey.export({ type: 'spki', format: 'pem' }));
  fs.writeFileSync(configurationPath, `${JSON.stringify({
    version: 1,
    kind: 'AutonomousResearchStateBackupAuthorityProcessConfiguration',
    authorityId: 'external-backup-authority',
    keyId: 'external-backup-key-1',
    commandPath,
    commandSha256: fileSha256HashSync(commandPath),
    publicKeyPath,
    publicKeySha256: fileSha256HashSync(publicKeyPath),
    fixedArguments: [],
    timeoutMs: 5000,
    maximumReservationLeaseMs: 60000,
    maximumHeadObservationAgeMs: 60000,
  })}\n`, { mode: 0o600 });
  const adapter = createAutonomousResearchStateBackupAuthorityProcessClient({ configurationPath });
  assert.equal(adapter.trust.publicKey.type, 'public');
  assert.equal(adapter.trust.publicKey.asymmetricKeyType, 'ed25519');

  writePublicKey(privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const privateConfiguration = JSON.parse(fs.readFileSync(configurationPath, 'utf8'));
  privateConfiguration.publicKeySha256 = fileSha256HashSync(publicKeyPath);
  fs.writeFileSync(configurationPath, `${JSON.stringify(privateConfiguration)}\n`, { mode: 0o600 });
  assert.throws(
    () => createAutonomousResearchStateBackupAuthorityProcessClient({ configurationPath }),
    /autonomous_research_state_backup_authority_public_key_invalid/,
  );
});

test('backup and restore drill close over all databases without mutating production state', async (t) => {
  const setup = fixture(t);
  const before = new Map(setup.databasePaths.map((candidate) => [candidate, fs.readFileSync(candidate)]));
  const clock = fixedClock();
  const authority = createAuthority(clock);
  const backupRoot = path.join(setup.runtimeRoot, 'backups', 'autonomous-research-state');
  const backup = await createAutonomousResearchStateBackup({
    runtimeRoot: setup.runtimeRoot,
    backupRoot,
    stateDatabaseManifest,
    authorityClient: authority.client,
    authorityTrust: authority.trust,
    clock,
  });
  assert.equal(backup.status, 'autonomous_research_state_backup_recorded');
  assert.equal(backup.databaseCount, 10);
  for (const [candidate, content] of before) assert.deepEqual(fs.readFileSync(candidate), content);
  const drill = await drillAutonomousResearchStateRestore({
    bundlePath: backup.bundlePath,
    backupRoot,
    stateDatabaseManifest,
    authorityClient: authority.client,
    authorityTrust: authority.trust,
    clock,
  });
  assert.equal(drill.status, 'autonomous_research_state_restore_drill_passed');
  assert.equal(drill.databaseCount, 10);
  assert.equal(drill.productionStateMutated, false);
  assert.equal(fs.existsSync(path.join(backup.bundlePath, 'RESTORE_DRILL_RECEIPT.json')), true);
  const offhostSources = resolveLatestAutonomousResearchStateBackupSources({
    runtimeRoot: setup.runtimeRoot,
    backupRoot,
    stateDatabaseManifest,
    authorityTrust: authority.trust,
  });
  assert.equal(offhostSources.status, 'autonomous_research_state_backup_sources_ready');
  assert.equal(offhostSources.sources.length, 12);
  assert.equal(offhostSources.sources.some((entry) => entry.role === 'autonomous_state_database:native-store'), true);
  assert.deepEqual(Object.keys(offhostSources).sort(), [
    'authorityId', 'blockers', 'bundleManifestHash', 'bundlePath',
    'databaseInstanceIds', 'databaseScopeHash', 'headHash', 'headSequence',
    'inventoryHash', 'keyId', 'kind', 'manifestHash', 'manifestId',
    'restoreDrillPerformedAt', 'restoreDrillReceiptHash', 'skippedCandidates',
    'snapshotContentHash', 'snapshotCreatedAt', 'sources', 'status', 'version',
  ]);
  const bundle = JSON.parse(fs.readFileSync(path.join(
    backup.bundlePath,
    'AUTONOMOUS_RESEARCH_STATE_BACKUP.json',
  ), 'utf8'));
  const restoreReceipt = JSON.parse(fs.readFileSync(path.join(
    backup.bundlePath,
    'RESTORE_DRILL_RECEIPT.json',
  ), 'utf8'));
  const handoffBackup = bundle.content.databases.find((entry) => (
    entry.role === 'submission-handoff'
  ));
  assert.ok(handoffBackup);
  assert.equal(handoffBackup.instanceId, 'submission-handoff');
  assert.equal(handoffBackup.sourceRelativePath,
    'autonomous-research/submission-handoff/submission-handoff.sqlite');
  assert.equal(fs.existsSync(path.join(
    backup.bundlePath,
    handoffBackup.backupRelativePath,
  )), true);
  assert.equal(restoreReceipt.databaseCount, 10);
  assert.equal(offhostSources.version, 1);
  assert.equal(offhostSources.kind, 'AutonomousResearchStateBackupSourcesInspection');
  assert.equal(offhostSources.manifestId, bundle.content.manifestId);
  assert.equal(offhostSources.manifestHash, bundle.content.manifestHash);
  assert.equal(offhostSources.inventoryHash, bundle.content.inventoryHash);
  assert.equal(offhostSources.databaseScopeHash, bundle.content.databaseScopeHash);
  assert.deepEqual(
    offhostSources.databaseInstanceIds,
    bundle.content.databases.map((entry) => entry.instanceId).sort(),
  );
  assert.equal(
    offhostSources.restoreDrillReceiptHash,
    restoreReceipt.restoreDrillReceiptHash,
  );
  assert.equal(offhostSources.restoreDrillPerformedAt, restoreReceipt.performedAt);
  assert.equal(offhostSources.authorityId, restoreReceipt.authorityCurrentHeadReceipt.authorityId);
  assert.equal(offhostSources.keyId, restoreReceipt.authorityCurrentHeadReceipt.keyId);
  assert.equal(offhostSources.headSequence, restoreReceipt.authorityCurrentHeadReceipt.headSequence);
  assert.equal(offhostSources.headHash, restoreReceipt.authorityCurrentHeadReceipt.headHash);
  assert.equal(Object.hasOwn(offhostSources, 'authorityConfigurationPath'), false);
  assert.doesNotMatch(JSON.stringify(offhostSources), /privateKey|signature/);
});

test('backup cannot be authorized by a local option or incomplete signed database scope', async (t) => {
  const setup = fixture(t);
  const missingAuthority = await createAutonomousResearchStateBackup({
    runtimeRoot: setup.runtimeRoot,
    stateDatabaseManifest,
  });
  assert.equal(missingAuthority.status, 'autonomous_research_state_backup_blocked');
  assert.ok(missingAuthority.blockers.includes('autonomous_research_state_backup_external_authority_required'));

  const clock = fixedClock();
  const authority = createAuthority(clock);
  const incompleteClient = Object.freeze({
    ...authority.client,
    reserveSnapshot(request) {
      return authority.client.reserveSnapshot({
        ...request,
        databaseInstanceIds: request.databaseInstanceIds.slice(1),
      });
    },
  });
  const incomplete = await createAutonomousResearchStateBackup({
    runtimeRoot: setup.runtimeRoot,
    stateDatabaseManifest,
    authorityClient: incompleteClient,
    authorityTrust: authority.trust,
    clock,
  });
  assert.equal(incomplete.status, 'autonomous_research_state_backup_blocked');
  assert.ok(incomplete.blockers.includes('autonomous_research_state_backup_authority_reservation_invalid'));
});

test('restore drill blocks tampered copies and never promotes a local hash-only result', async (t) => {
  const setup = await successfulBackup(t);
  const bundle = JSON.parse(fs.readFileSync(path.join(
    setup.receipt.bundlePath,
    'AUTONOMOUS_RESEARCH_STATE_BACKUP.json',
  ), 'utf8'));
  const target = path.join(setup.receipt.bundlePath, bundle.content.databases[0].backupRelativePath);
  fs.appendFileSync(target, Buffer.from('tamper'));
  const drill = await drillAutonomousResearchStateRestore({
    bundlePath: setup.receipt.bundlePath,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityClient: setup.authority.client,
    authorityTrust: setup.authority.trust,
    clock: setup.clock,
  });
  assert.equal(drill.status, 'autonomous_research_state_restore_drill_blocked');
  assert.ok(drill.blockers.some((entry) => entry.includes('database_hash_mismatch')));
});

test('restore drill reports every malformed trust binding in a rehashed bundle manifest', async (t) => {
  const setup = await successfulBackup(t);
  const bundlePath = path.join(
    setup.receipt.bundlePath,
    'AUTONOMOUS_RESEARCH_STATE_BACKUP.json',
  );
  const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  const invalidHash = `sha256:${'0'.repeat(64)}`;
  bundle.content.manifestHash = invalidHash;
  bundle.content.manifestId = 'wrong-manifest';
  bundle.content.inventoryHash = invalidHash;
  bundle.content.databaseScopeHash = invalidHash;
  bundle.content.authorityReservationHash = invalidHash;
  bundle.productionStateMutated = true;
  bundle.authorityFinalization.snapshotContentHash = invalidHash;
  bundle.authorityFinalization.headSequence += 1;
  bundle.content.databases[0].role = 'unregistered-role';
  bundle.content.databases[1].bytes = 0;
  bundle.content.databases.push(structuredClone(bundle.content.databases[2]));
  bundle.bundleManifestHash = autonomousResearchStateBackupBundleManifestHash(bundle);
  fs.writeFileSync(bundlePath, `${JSON.stringify(bundle)}\n`);

  const drill = await drillAutonomousResearchStateRestore({
    bundlePath: setup.receipt.bundlePath,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityClient: setup.authority.client,
    authorityTrust: setup.authority.trust,
    clock: setup.clock,
  });
  assert.equal(drill.status, 'autonomous_research_state_restore_drill_blocked');
  assert.deepEqual(new Set(drill.blockers), new Set([
    'autonomous_research_state_backup_authority_finalization_binding_invalid',
    'autonomous_research_state_backup_authority_reservation_hash_invalid',
    'autonomous_research_state_backup_authority_scope_binding_invalid',
    'autonomous_research_state_backup_content_hash_invalid',
    'autonomous_research_state_backup_database_identity_duplicate',
    'autonomous_research_state_backup_database_manifest_id_mismatch',
    'autonomous_research_state_backup_database_manifest_mismatch',
    'autonomous_research_state_backup_database_record_invalid',
    'autonomous_research_state_backup_production_mutation_claim_invalid',
    'autonomous_research_state_backup_role_cardinality_invalid:external-qualification',
    'autonomous_research_state_backup_role_cardinality_invalid:machine-intake',
    'autonomous_research_state_backup_role_missing:external-qualification',
    'autonomous_research_state_backup_scope_hash_invalid',
    'autonomous_research_state_backup_unregistered_role',
  ]));
});

test('restore drill rejects a valid old bundle after the external authority head advances', async (t) => {
  const setup = await successfulBackup(t);
  setup.authority.advanceHead();
  const drill = await drillAutonomousResearchStateRestore({
    bundlePath: setup.receipt.bundlePath,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityClient: setup.authority.client,
    authorityTrust: setup.authority.trust,
    clock: setup.clock,
  });
  assert.equal(drill.status, 'autonomous_research_state_restore_drill_blocked');
  assert.ok(drill.blockers.includes('autonomous_research_state_restore_snapshot_stale_against_authority_head'));
});

test('restore drill fails closed without a fresh signed current-head observation', async (t) => {
  const setup = await successfulBackup(t);
  const drill = await drillAutonomousResearchStateRestore({
    bundlePath: setup.receipt.bundlePath,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityClient: {},
    authorityTrust: setup.authority.trust,
    clock: setup.clock,
  });
  assert.equal(drill.status, 'autonomous_research_state_restore_drill_blocked');
  assert.ok(drill.blockers.includes('autonomous_research_state_restore_external_authority_required'));
});

test('restore drill persists complete signed current-head evidence for offline WORM verification', async (t) => {
  const setup = await successfulBackup(t);
  const drill = await drillAutonomousResearchStateRestore({
    bundlePath: setup.receipt.bundlePath,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityClient: setup.authority.client,
    authorityTrust: setup.authority.trust,
    clock: setup.clock,
  });
  assert.equal(drill.status, 'autonomous_research_state_restore_drill_passed');
  const receiptPath = path.join(setup.receipt.bundlePath, 'RESTORE_DRILL_RECEIPT.json');
  const stored = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.deepEqual(stored.authorityCurrentHeadRequest, drill.authorityCurrentHeadRequest);
  assert.deepEqual(stored.authorityCurrentHeadReceipt, drill.authorityCurrentHeadReceipt);
  assert.equal(
    stored.authorityCurrentHeadReceiptHash,
    autonomousResearchStateBackupAuthorityReceiptHash(stored.authorityCurrentHeadReceipt),
  );
  assert.equal(stored.authorityCurrentHeadRequest.snapshotContentHash, setup.receipt.snapshotContentHash);
  assert.equal(stored.authorityCurrentHeadReceipt.databaseScopeHash, drill.authorityCurrentHeadRequest.databaseScopeHash);
  assert.equal(crypto.verify(
    null,
    Buffer.from(autonomousResearchStateBackupAuthoritySignaturePayload(
      stored.authorityCurrentHeadReceipt,
    ), 'utf8'),
    setup.authority.trust.publicKey,
    Buffer.from(stored.authorityCurrentHeadReceipt.signature, 'base64'),
  ), true);

  stored.authorityCurrentHeadReceiptHash = `sha256:${'0'.repeat(64)}`;
  const { restoreDrillReceiptHash: ignored, ...payload } = stored;
  stored.restoreDrillReceiptHash = hashRecord('AutonomousResearchStateRestoreDrillReceipt', payload);
  fs.writeFileSync(receiptPath, `${JSON.stringify(stored)}\n`);
  const blocked = resolveLatestAutonomousResearchStateBackupSources({
    runtimeRoot: setup.runtimeRoot,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityTrust: setup.authority.trust,
  });
  assert.equal(blocked.status, 'autonomous_research_state_backup_sources_blocked');
  assert.equal(Object.hasOwn(blocked, 'restoreDrillReceiptHash'), false);
  assert.equal(Object.hasOwn(blocked, 'authorityId'), false);
  assert.ok(blocked.skippedCandidates[0].blockers.includes(
    'autonomous_research_state_backup_restore_authority_receipt_hash_invalid',
  ));
});

test('WORM resolver skips newer undrilled or invalid bundles and fails closed when none are valid', async (t) => {
  const setup = await successfulBackup(t);
  const drill = await drillAutonomousResearchStateRestore({
    bundlePath: setup.receipt.bundlePath,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityClient: setup.authority.client,
    authorityTrust: setup.authority.trust,
    clock: setup.clock,
  });
  assert.equal(drill.status, 'autonomous_research_state_restore_drill_passed');
  const undrilledPath = path.join(setup.backupRoot, 'secret-undrilled-candidate');
  fs.cpSync(setup.receipt.bundlePath, undrilledPath, { recursive: true });
  fs.rmSync(path.join(undrilledPath, 'RESTORE_DRILL_RECEIPT.json'));
  const invalidPath = path.join(setup.backupRoot, 'secret-invalid-candidate');
  fs.cpSync(setup.receipt.bundlePath, invalidPath, { recursive: true });
  const invalidReceiptPath = path.join(invalidPath, 'RESTORE_DRILL_RECEIPT.json');
  const invalidReceipt = JSON.parse(fs.readFileSync(invalidReceiptPath, 'utf8'));
  invalidReceipt.bundlePath = invalidPath;
  invalidReceipt.authorityCurrentHeadReceipt.databaseScopeHash = `sha256:${'0'.repeat(64)}`;
  invalidReceipt.authorityCurrentHeadReceiptHash = autonomousResearchStateBackupAuthorityReceiptHash(
    invalidReceipt.authorityCurrentHeadReceipt,
  );
  const { restoreDrillReceiptHash: ignored, ...invalidPayload } = invalidReceipt;
  invalidReceipt.restoreDrillReceiptHash = hashRecord(
    'AutonomousResearchStateRestoreDrillReceipt',
    invalidPayload,
  );
  fs.writeFileSync(invalidReceiptPath, `${JSON.stringify(invalidReceipt)}\n`);
  fs.utimesSync(setup.receipt.bundlePath, new Date('2026-01-01'), new Date('2026-01-01'));
  fs.utimesSync(undrilledPath, new Date('2026-01-02'), new Date('2026-01-02'));
  fs.utimesSync(invalidPath, new Date('2026-01-03'), new Date('2026-01-03'));

  const resolved = resolveLatestAutonomousResearchStateBackupSources({
    runtimeRoot: setup.runtimeRoot,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityTrust: setup.authority.trust,
  });
  assert.equal(resolved.status, 'autonomous_research_state_backup_sources_ready');
  assert.equal(resolved.bundlePath, setup.receipt.bundlePath);
  const selectedBundle = JSON.parse(fs.readFileSync(path.join(
    setup.receipt.bundlePath,
    'AUTONOMOUS_RESEARCH_STATE_BACKUP.json',
  ), 'utf8'));
  const selectedRestoreReceipt = JSON.parse(fs.readFileSync(path.join(
    setup.receipt.bundlePath,
    'RESTORE_DRILL_RECEIPT.json',
  ), 'utf8'));
  assert.equal(resolved.inventoryHash, selectedBundle.content.inventoryHash);
  assert.equal(resolved.databaseScopeHash, selectedBundle.content.databaseScopeHash);
  assert.equal(
    resolved.restoreDrillReceiptHash,
    selectedRestoreReceipt.restoreDrillReceiptHash,
  );
  assert.equal(resolved.headHash, selectedRestoreReceipt.authorityCurrentHeadReceipt.headHash);
  assert.equal(resolved.skippedCandidates.length, 2);
  assert.ok(resolved.skippedCandidates.some((entry) => entry.blockers.includes(
    'autonomous_research_state_backup_restore_authority_scope_binding_invalid',
  )));
  assert.doesNotMatch(JSON.stringify(resolved.skippedCandidates), /secret-(?:undrilled|invalid)-candidate/);

  fs.rmSync(path.join(setup.receipt.bundlePath, 'RESTORE_DRILL_RECEIPT.json'));
  const blocked = resolveLatestAutonomousResearchStateBackupSources({
    runtimeRoot: setup.runtimeRoot,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityTrust: setup.authority.trust,
  });
  assert.equal(blocked.status, 'autonomous_research_state_backup_sources_blocked');
  assert.equal(blocked.bundlePath, null);
  assert.equal(blocked.skippedCandidates.length, 3);
  assert.deepEqual(blocked.blockers, [
    'autonomous_research_state_backup_no_valid_restore_drill_bundle',
  ]);
  assert.doesNotMatch(JSON.stringify(blocked.skippedCandidates), /secret-(?:undrilled|invalid)-candidate/);
});

test('WORM resolver fails closed for missing trust, missing roots, and empty candidate sets', (t) => {
  const setup = fixture(t);
  const authority = createAuthority(fixedClock());
  const missingTrust = resolveLatestAutonomousResearchStateBackupSources({
    runtimeRoot: setup.runtimeRoot,
    stateDatabaseManifest,
  });
  assert.deepEqual(missingTrust.blockers, [
    'autonomous_research_state_backup_source_authority_trust_required',
  ]);
  const missingRoot = resolveLatestAutonomousResearchStateBackupSources({
    runtimeRoot: setup.runtimeRoot,
    backupRoot: path.join(setup.runtimeRoot, 'missing-backup-root'),
    stateDatabaseManifest,
    authorityTrust: authority.trust,
  });
  assert.deepEqual(missingRoot.blockers, [
    'autonomous_research_state_backup_bundle_missing',
  ]);
  const emptyRoot = path.join(setup.runtimeRoot, 'empty-backup-root');
  fs.mkdirSync(emptyRoot, { recursive: true });
  const empty = resolveLatestAutonomousResearchStateBackupSources({
    runtimeRoot: setup.runtimeRoot,
    backupRoot: emptyRoot,
    stateDatabaseManifest,
    authorityTrust: authority.trust,
  });
  assert.deepEqual(empty.blockers, [
    'autonomous_research_state_backup_bundle_missing',
  ]);
});

test('WORM resolver checks stored request, receipt, time, and pinned trust branches independently', async (t) => {
  const setup = await successfulBackup(t);
  const drill = await drillAutonomousResearchStateRestore({
    bundlePath: setup.receipt.bundlePath,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityClient: setup.authority.client,
    authorityTrust: setup.authority.trust,
    clock: setup.clock,
  });
  assert.equal(drill.status, 'autonomous_research_state_restore_drill_passed');
  const receiptPath = path.join(setup.receipt.bundlePath, 'RESTORE_DRILL_RECEIPT.json');
  const original = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const writeReceipt = (receipt, { rehashHead = false, rehashReceipt = true } = {}) => {
    if (rehashHead) {
      receipt.authorityCurrentHeadReceiptHash =
        autonomousResearchStateBackupAuthorityReceiptHash(
          receipt.authorityCurrentHeadReceipt,
        );
    }
    if (rehashReceipt) {
      const { restoreDrillReceiptHash: ignored, ...payload } = receipt;
      receipt.restoreDrillReceiptHash = hashRecord(
        'AutonomousResearchStateRestoreDrillReceipt',
        payload,
      );
    }
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  };
  const resolve = (authorityTrust = setup.authority.trust) => (
    resolveLatestAutonomousResearchStateBackupSources({
      runtimeRoot: setup.runtimeRoot,
      backupRoot: setup.backupRoot,
      stateDatabaseManifest,
      authorityTrust,
    })
  );

  const invalidHash = structuredClone(original);
  invalidHash.restoreDrillReceiptHash = `sha256:${'0'.repeat(64)}`;
  writeReceipt(invalidHash, { rehashReceipt: false });
  assert.ok(resolve().skippedCandidates[0].blockers.includes(
    'autonomous_research_state_backup_restore_drill_receipt_hash_invalid',
  ));

  const invalidRequest = structuredClone(original);
  invalidRequest.authorityCurrentHeadRequest.requestedAt = null;
  writeReceipt(invalidRequest);
  assert.ok(resolve().skippedCandidates[0].blockers.includes(
    'autonomous_research_state_backup_restore_authority_request_invalid',
  ));

  const invalidHead = structuredClone(original);
  invalidHead.authorityCurrentHeadReceipt.signature = '!';
  writeReceipt(invalidHead, { rehashHead: true });
  assert.ok(resolve().skippedCandidates[0].blockers.includes(
    'autonomous_research_state_backup_restore_authority_receipt_invalid',
  ));

  const invalidTime = structuredClone(original);
  invalidTime.authorityCurrentHeadReceipt.observedAt = new Date(
    Date.parse(original.performedAt) + 6000,
  ).toISOString();
  invalidTime.authorityCurrentHeadReceipt.expiresAt = new Date(
    Date.parse(original.performedAt) + 12000,
  ).toISOString();
  writeReceipt(invalidTime, { rehashHead: true });
  assert.ok(resolve().skippedCandidates[0].blockers.includes(
    'autonomous_research_state_backup_restore_authority_time_binding_invalid',
  ));

  writeReceipt(structuredClone(original));
  assert.ok(resolve(Object.freeze({})).skippedCandidates[0].blockers.includes(
    'autonomous_research_state_backup_restore_authority_trust_invalid',
  ));
});

test('WORM resolver rejects extra, missing, and content-drifted database copies', async (t) => {
  const setup = await successfulBackup(t);
  const drill = await drillAutonomousResearchStateRestore({
    bundlePath: setup.receipt.bundlePath,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityClient: setup.authority.client,
    authorityTrust: setup.authority.trust,
    clock: setup.clock,
  });
  assert.equal(drill.status, 'autonomous_research_state_restore_drill_passed');
  const databaseRoot = path.join(setup.receipt.bundlePath, 'databases');
  const firstDatabase = path.join(databaseRoot, fs.readdirSync(databaseRoot).sort()[0]);
  const resolve = () => resolveLatestAutonomousResearchStateBackupSources({
    runtimeRoot: setup.runtimeRoot,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityTrust: setup.authority.trust,
  });

  const extraDatabase = path.join(databaseRoot, 'extra.sqlite');
  fs.copyFileSync(firstDatabase, extraDatabase);
  assert.ok(resolve().skippedCandidates[0].blockers.includes(
    'autonomous_research_state_backup_source_database_set_invalid',
  ));
  fs.rmSync(extraDatabase);

  const original = fs.readFileSync(firstDatabase);
  fs.appendFileSync(firstDatabase, Buffer.from('content-drift'));
  assert.ok(resolve().skippedCandidates[0].blockers.includes(
    'autonomous_research_state_backup_source_database_invalid',
  ));
  fs.writeFileSync(firstDatabase, original);

  const hiddenDatabaseRoot = `${databaseRoot}.hidden`;
  fs.renameSync(databaseRoot, hiddenDatabaseRoot);
  const missing = resolve();
  assert.ok(missing.skippedCandidates[0].blockers.includes(
    'autonomous_research_state_backup_source_database_set_invalid',
  ));
  assert.ok(missing.skippedCandidates[0].blockers.includes(
    'autonomous_research_state_backup_source_database_invalid',
  ));
  fs.renameSync(hiddenDatabaseRoot, databaseRoot);
});

test('WORM resolver requires the pinned authority trust and rejects a different signing key', async (t) => {
  const setup = await successfulBackup(t);
  const drill = await drillAutonomousResearchStateRestore({
    bundlePath: setup.receipt.bundlePath,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityClient: setup.authority.client,
    authorityTrust: setup.authority.trust,
    clock: setup.clock,
  });
  assert.equal(drill.status, 'autonomous_research_state_restore_drill_passed');
  const missingTrust = resolveLatestAutonomousResearchStateBackupSources({
    runtimeRoot: setup.runtimeRoot,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
  });
  assert.deepEqual(missingTrust.blockers, [
    'autonomous_research_state_backup_source_authority_trust_required',
  ]);

  const { publicKey: wrongPublicKey } = crypto.generateKeyPairSync('ed25519');
  const wrongTrust = Object.freeze({ ...setup.authority.trust, publicKey: wrongPublicKey });
  const wrongSigner = resolveLatestAutonomousResearchStateBackupSources({
    runtimeRoot: setup.runtimeRoot,
    backupRoot: setup.backupRoot,
    stateDatabaseManifest,
    authorityTrust: wrongTrust,
  });
  assert.equal(wrongSigner.status, 'autonomous_research_state_backup_sources_blocked');
  assert.ok(wrongSigner.skippedCandidates[0].blockers.includes(
    'autonomous_research_state_backup_restore_authority_current_head_signature_invalid',
  ));
  assert.ok(wrongSigner.skippedCandidates[0].blockers.includes(
    'autonomous_research_state_backup_restore_authority_reservation_signature_invalid',
  ));
});
