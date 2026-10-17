import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES, autonomousResearchStateDatabaseInventoryHash, autonomousResearchStateDatabaseScopeHash } from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { assertAutonomousResearchOnlineRuntimeActivationReceipt, autonomousResearchOnlineRuntimeActivationReceiptHash } from '../../paper-domain/automation/autonomous-research-online-runtime-activation-contract.mjs';
import { activateAutonomousResearchOnlineMutationRuntime, openAutonomousResearchOnlineRuntimeActivationDatabase } from '../../paper-adapters/automation/autonomous-research-online-runtime-activation.mjs';
import { autonomousResearchOnlineWriterOperationManifestHash } from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { autonomousResearchOnlineSchemaTransitionReadyReceiptHash, AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL } from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
const PROTOCOL = 'external-linearizable-reserve-apply-finalize-v1';
const NOW = '2026-07-18T09:00:00.000Z';
const H = (label) => hashRecord('NativeRuntimeActivationFixture', { label });
function fixture() {
  const roles = [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort();
  const manifest = { version: 1, kind: 'AutonomousResearchOnlineWriterCoverageManifest', manifestId: 'native-runtime-activation-test-v1', protocol: PROTOCOL, requiredDatabaseRoles: roles,
    writers: roles.map((role) => ({ writerId: `writer:${role}:test:v1`, databaseRoles: [role], operationIds: [`${role}.testWriter.mutate.v1`], implementationHash: H(role), protocol: PROTOCOL })),
    operations: roles.map((role, index) => ({ operationId: `${role}.testWriter.mutate.v1`, databaseRole: role, sourceFile: `paper-adapters/automation/runtime-activation-test-${index}.mjs`, entrypoint: `mutateRole${index}`, mutationClass: 'business-dml', protocolStatus: 'coordinator-integrated-reserve-apply-finalize-v1', coordinatorIntegrated: true })),
    coverage: { requiredRoleCount: roles.length, coveredRoleCount: roles.length, coveredDatabaseRoles: roles, percent: 100 } };
  const instances = roles.map((role) => ({ instanceId: role, role, paperId: null, sourceRelativePath: `autonomous-research/${role}.sqlite`, schemaContractId: `${role}-schema-v1`, missingSchemaObjects: [], sourceFileIdentity: { marker: role }, sourceSha256: H(`source:${role}`), walFileIdentity: null, walSha256: null, quickCheck: 'ok', foreignKeyViolationCount: 0, schemaHash: H(`schema:${role}`), schemaObjects: [], userVersion: 1, applicationId: 0 }));
  const inventory = { version: 1, kind: 'AutonomousResearchStateDatabaseInventory', status: 'autonomous_research_state_database_inventory_ready', manifestId: 'hepta-paper-autonomous-research-state-databases-v1', manifestHash: H('manifest'), databaseScopeHash: autonomousResearchStateDatabaseScopeHash(instances), instances, blockers: [] };
  inventory.inventoryHash = autonomousResearchStateDatabaseInventoryHash(inventory);
  const receipt = { version: 1, kind: 'AutonomousResearchOnlineRuntimeActivationReceipt', status: 'autonomous_research_online_mutation_runtime_activated', protocol: PROTOCOL, inventoryHash: inventory.inventoryHash, databaseScopeHash: inventory.databaseScopeHash, writerManifestHash: autonomousResearchOnlineWriterOperationManifestHash(manifest), authorityId: 'authority:test', keyId: 'key:test', authorityGlobalSequence: 17, authorityGlobalHash: H('global'), databaseActivations: instances.map((entry) => ({ databaseRole: entry.role, databaseInstanceId: entry.instanceId, schemaContractId: entry.schemaContractId, schemaHash: entry.schemaHash, startupReconciliationReceiptHash: H(`startup:${entry.instanceId}`), finalizedHeadInspectionReceiptHash: H(`finalized:${entry.instanceId}`), databaseSequence: 0, databaseHash: H(`db:${entry.instanceId}`), stateHash: H(`state:${entry.instanceId}`) })), activeRefreshReceiptHash: H('refresh'), authorityEvidenceCacheReceiptHash: H('cache'), restoreDrillReceiptHash: H('restore'), schemaTransitionReceiptHash: H('transition'), activatedAt: NOW, coordinatorRuntimeReady: true, remainingBlockers: [] };
  receipt.activationReceiptHash = autonomousResearchOnlineRuntimeActivationReceiptHash(receipt);
  const readiness = { version: 1, kind: 'AutonomousResearchOnlineSchemaTransitionReadyReceipt', status: 'autonomous_research_online_schema_transition_ready', protocol: AUTONOMOUS_RESEARCH_ONLINE_SCHEMA_TRANSITION_PROTOCOL, transitionId: H('transition-id'), databaseScopeHash: inventory.databaseScopeHash, writerManifestHash: receipt.writerManifestHash, inventoryHash: inventory.inventoryHash, schemaTransitionReceiptHash: H('transition'), liveObservationReceiptHash: H('observation'), observedAt: NOW, expiresAt: '2026-07-18T09:05:00.000Z', externalAuthorityVerified: true, blockers: [] };
  readiness.readinessReceiptHash = autonomousResearchOnlineSchemaTransitionReadyReceiptHash(readiness);
  return { manifest, inventory, receipt, readiness, now: NOW };
}
function fileIdentity(file) {
  const s = fs.lstatSync(file, { bigint: true });
  return { device: String(s.dev), inode: String(s.ino), mode: String(s.mode), links: String(s.nlink), bytes: String(s.size), modifiedNs: String(s.mtimeNs), changedNs: String(s.ctimeNs) };
}
function main(input) {
  if (input.mode === 'fixture') return fixture();
  if (input.mode === 'receipt') {
    assertAutonomousResearchOnlineRuntimeActivationReceipt(input.value);
    return { accepted: true, hash: autonomousResearchOnlineRuntimeActivationReceiptHash(input.value) };
  }
  if (input.mode === 'scope') return { hash: autonomousResearchStateDatabaseScopeHash(input.value) };
  if (input.mode === 'inventoryHash') return { hash: autonomousResearchStateDatabaseInventoryHash(input.value) };
  if (input.mode === 'readinessHash') return { hash: autonomousResearchOnlineSchemaTransitionReadyReceiptHash(input.value) };
  if (input.mode === 'preflight') {
    try { activateAutonomousResearchOnlineMutationRuntime({ inventory: input.inventory, writerManifest: input.manifest, schemaTransitionReadiness: input.readiness, configuredCoordinator: {}, clock: { now: () => new Date(input.now) } }); }
    catch (error) { return { error: error.message }; }
    throw new Error('unexpected_activation');
  }
  if (input.mode === 'stable') {
    const source = fs.readFileSync(new URL('../../paper-adapters/automation/autonomous-research-online-runtime-activation.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('function stableInventoryScope(');
    const end = source.indexOf('\nfunction configuredCoordinatorStatus(', start);
    if (start < 0 || end < 0) throw new Error('source_function_missing');
    const original = new vm.Script(`(${source.slice(start, end)})`).runInNewContext();
    return { stable: original(JSON.parse(input.left), JSON.parse(input.right)) };
  }
  if (input.mode === 'identity') return fileIdentity(input.path);
  if (input.mode === 'open') {
    // The native API receives typed serde_json values, so this oracle restores
    // the source inventory builder's documented identity member order. Raw
    // member order is tested separately by the stable-inventory operation.
    const identity = input.instance?.sourceFileIdentity;
    if (identity && typeof identity === 'object' && !Array.isArray(identity)) {
      const ordered = {};
      for (const key of ['device', 'inode', 'mode', 'links', 'bytes', 'modifiedNs', 'changedNs']) {
        if (Object.hasOwn(identity, key)) ordered[key] = identity[key];
      }
      for (const key of Object.keys(identity)) if (!Object.hasOwn(ordered, key)) ordered[key] = identity[key];
      input.instance.sourceFileIdentity = ordered;
    }
    const database = openAutonomousResearchOnlineRuntimeActivationDatabase(input);
    try {
      const schema = database.prepare("SELECT type,name,tbl_name,coalesce(sql,'') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name,sql;").all();
      return { opened: true, inspection: { quickCheck: database.prepare('PRAGMA quick_check;').get().quick_check, foreignKeyViolationCount: database.prepare('PRAGMA foreign_key_check;').all().length, schemaHash: hashRecord('AutonomousResearchStateDatabaseSchema', schema), userVersion: database.prepare('PRAGMA user_version;').get().user_version, applicationId: database.prepare('PRAGMA application_id;').get().application_id } };
    }
    finally { database.close(); }
  }
  if (input.mode === 'createDatabase') {
    if (!input.path.startsWith('/tmp/hepta-native-activation-')) throw new Error('test_directory_required');
    const database = new DatabaseSync(input.path);
    try { database.exec('CREATE TABLE state(value TEXT NOT NULL); INSERT INTO state VALUES(\'test\');'); }
    finally { database.close(); }
    return fileIdentity(input.path);
  }
  throw new Error('unknown_mode');
}
let result;
try { result = main(JSON.parse(fs.readFileSync(0, 'utf8'))); }
catch (error) { result = { error: error.message }; }
process.stdout.write(`${JSON.stringify(result)}\n`);
