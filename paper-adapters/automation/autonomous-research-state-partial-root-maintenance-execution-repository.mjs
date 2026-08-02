import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  validateAutonomousResearchOnlineSchemaTransitionInventory,
  schemaTransitionTargetSchema,
} from './autonomous-research-online-schema-transition-schema.mjs';
import {
  inspectSqliteDatabase,
  resolveAutonomousResearchStateDatabaseInventory,
} from './autonomous-research-state-database-inventory.mjs';
import {
  installAutonomousResearchSupervisorExternalActionJournalCoreSchema,
} from './autonomous-research-supervisor-external-action-journal-storage.mjs';
import {
  assertPartialRootNoSqliteSidecars,
  buildAutonomousResearchStatePartialRootMaintenancePlan,
  partialRootBusinessState,
  partialRootBusinessStateFromDatabase,
  PARTIAL_ROOT_MISSING_ROLES,
} from './autonomous-research-state-partial-root-maintenance-inspection.mjs';
import { fileSha256HashSync } from '../runtime/pinned-file-reader.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { pathWithin } from '../../workflow-kernel/runtime/file-utils.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function syncFile(candidate) {
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function syncDirectory(candidate) {
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function fileIdentity(candidate) {
  const stat = fs.lstatSync(candidate, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('autonomous_research_state_partial_root_database_unsafe');
  }
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    links: String(stat.nlink),
    bytes: String(stat.size),
    modifiedNs: String(stat.mtimeNs),
    changedNs: String(stat.ctimeNs),
  });
}

function sameIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function instancePath(runtimeRoot, instance) {
  const candidate = path.resolve(runtimeRoot, instance.sourceRelativePath);
  if (!pathWithin(runtimeRoot, candidate)) {
    throw new Error('autonomous_research_state_partial_root_path_outside_runtime');
  }
  return candidate;
}

function acquireExclusiveLocks(plan) {
  const locks = new Map();
  try {
    for (const instance of plan.instances) {
      const candidate = instancePath(plan.runtimeRoot, instance);
      assertPartialRootNoSqliteSidecars(candidate);
      if (fileSha256HashSync(candidate) !== instance.sourceSha256
        || !sameIdentity(fileIdentity(candidate), instance.sourceFileIdentity)) {
        throw new Error('autonomous_research_state_partial_root_database_identity_changed');
      }
      const database = new DatabaseSync(candidate);
      try {
        database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
        assertPartialRootNoSqliteSidecars(candidate);
        if (fileSha256HashSync(candidate) !== instance.sourceSha256
          || !sameIdentity(fileIdentity(candidate), instance.sourceFileIdentity)) {
          throw new Error('autonomous_research_state_partial_root_database_identity_changed');
        }
      } catch (error) {
        database.close();
        throw error;
      }
      locks.set(instance.instanceId, database);
    }
    return locks;
  } catch (error) {
    closeLocks(locks, false);
    throw new Error(
      `autonomous_research_state_partial_root_writer_quiescence_failed:${error.message}`,
    );
  }
}

function closeLocks(locks, commitSupervisor) {
  let failure = null;
  for (const [instanceId, database] of [...locks].reverse()) {
    try {
      if (database.isTransaction) {
        database.exec(commitSupervisor && instanceId === 'supervisor-state'
          ? 'COMMIT;' : 'ROLLBACK;');
      }
    } catch (error) { failure ||= error; }
    try { database.close(); } catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
}

function rescueEntry({ plan, instance, stagingRoot }) {
  const source = instancePath(plan.runtimeRoot, instance);
  const backup = path.join(stagingRoot, instance.sourceRelativePath);
  fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, 0o600);
  syncFile(backup);
  const backupSha256 = fileSha256HashSync(backup);
  const inspection = inspectSqliteDatabase(backup);
  if (backupSha256 !== instance.sourceSha256 || inspection.quickCheck !== 'ok'
    || inspection.foreignKeyViolationCount !== 0) {
    throw new Error('autonomous_research_state_partial_root_rescue_copy_invalid');
  }
  const restore = `${backup}.restore-drill`;
  try {
    fs.copyFileSync(backup, restore, fs.constants.COPYFILE_EXCL);
    const restoredInspection = inspectSqliteDatabase(restore);
    if (fileSha256HashSync(restore) !== backupSha256
      || restoredInspection.quickCheck !== 'ok'
      || restoredInspection.foreignKeyViolationCount !== 0) {
      throw new Error('autonomous_research_state_partial_root_rescue_restore_invalid');
    }
  } finally {
    if (fs.existsSync(restore)) fs.unlinkSync(restore);
  }
  return Object.freeze({
    instanceId: instance.instanceId,
    role: instance.role,
    sourceRelativePath: instance.sourceRelativePath,
    sourceSha256: instance.sourceSha256,
    backupSha256,
    bytes: Number(fs.statSync(backup).size),
    copyRestoreVerified: true,
  });
}

function createRescueBundle(plan) {
  const bundleName = `partial-root-rescue-${plan.maintenancePlanId.slice('sha256:'.length)}`;
  const bundlePath = path.join(plan.rescueRoot, bundleName);
  if (fs.existsSync(bundlePath)) {
    throw new Error('autonomous_research_state_partial_root_rescue_bundle_exists');
  }
  const stagingRoot = fs.mkdtempSync(path.join(plan.rescueRoot, '.partial-root-rescue-'));
  fs.chmodSync(stagingRoot, 0o700);
  let committed = false;
  try {
    const databases = Object.freeze(plan.instances.map((instance) => (
      rescueEntry({ plan, instance, stagingRoot })
    )));
    const payload = Object.freeze({
      version: 1,
      kind: 'AutonomousResearchStatePartialRootRescueBundleManifest',
      status: 'autonomous_research_state_partial_root_rescue_bundle_verified',
      maintenancePlanId: plan.maintenancePlanId,
      stateDatabaseManifestHash: plan.stateDatabaseManifestHash,
      databaseScopeHash: plan.databaseScopeHash,
      databases,
      copyRestoreVerified: true,
    });
    const manifest = Object.freeze({
      ...payload,
      rescueManifestHash: hashRecord(
        'AutonomousResearchStatePartialRootRescueBundleManifest', payload,
      ),
    });
    const manifestPath = path.join(stagingRoot, 'RESCUE_MANIFEST.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    syncFile(manifestPath);
    syncDirectory(stagingRoot);
    fs.renameSync(stagingRoot, bundlePath);
    committed = true;
    syncDirectory(plan.rescueRoot);
    return Object.freeze({ bundlePath, manifest });
  } finally {
    if (!committed) fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function stagedDatabaseProjection({ stagingRoot, definition }) {
  const candidate = path.resolve(stagingRoot, definition.relativePath);
  if (!pathWithin(stagingRoot, candidate) || !fs.existsSync(candidate)) {
    throw new Error(`autonomous_research_state_partial_root_staged_database_missing:${definition.role}`);
  }
  assertPartialRootNoSqliteSidecars(candidate);
  const inspection = inspectSqliteDatabase(candidate);
  const targetNames = new Set(schemaTransitionTargetSchema({ role: definition.role }).objects.keys());
  const requiredBusiness = definition.requiredSchemaObjects.filter((entry) => (
    !targetNames.has(entry.slice(entry.indexOf(':') + 1))
  ));
  if (inspection.quickCheck !== 'ok' || inspection.foreignKeyViolationCount !== 0
    || requiredBusiness.some((entry) => !inspection.schemaObjects.includes(entry))
    || inspection.schemaObjects.some((entry) => targetNames.has(
      entry.slice(entry.indexOf(':') + 1),
    ))) {
    throw new Error(`autonomous_research_state_partial_root_staged_schema_invalid:${definition.role}`);
  }
  syncFile(candidate);
  return Object.freeze({
    role: definition.role,
    sourceRelativePath: definition.relativePath,
    sourcePath: candidate,
    sourceSha256: fileSha256HashSync(candidate),
    schemaHash: inspection.schemaHash,
  });
}

function stageMissingDatabases({ plan, stateDatabaseManifest, provisionMissingBusinessSchemas }) {
  const parent = path.dirname(plan.runtimeRoot);
  const stagingRoot = fs.mkdtempSync(path.join(parent, '.partial-root-business-staging-'));
  fs.chmodSync(stagingRoot, 0o700);
  try {
    provisionMissingBusinessSchemas({ runtimeRoot: stagingRoot });
    const definitions = stateDatabaseManifest.databases.filter((entry) => (
      PARTIAL_ROOT_MISSING_ROLES.includes(entry.role)
    ));
    const projection = Object.freeze(definitions.map((definition) => (
      stagedDatabaseProjection({ stagingRoot, definition })
    )).sort((left, right) => left.role.localeCompare(right.role)));
    const expectedPaths = new Set(projection.map((entry) => entry.sourcePath));
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error('autonomous_research_state_partial_root_staging_symlink_forbidden');
        }
        if (entry.isDirectory()) visit(candidate);
        else if (entry.name.endsWith('.sqlite') && !expectedPaths.has(candidate)) {
          throw new Error('autonomous_research_state_partial_root_staging_scope_invalid');
        }
      }
    };
    visit(stagingRoot);
    return Object.freeze({ stagingRoot, projection });
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function publishNoClobber({ plan, staged }) {
  const installed = [];
  try {
    for (const entry of staged.projection) {
      const target = path.resolve(plan.runtimeRoot, entry.sourceRelativePath);
      if (!pathWithin(plan.runtimeRoot, target)) {
        throw new Error('autonomous_research_state_partial_root_target_outside_runtime');
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      if (fs.existsSync(target)) {
        throw new Error(`autonomous_research_state_partial_root_target_appeared:${entry.role}`);
      }
      fs.linkSync(entry.sourcePath, target);
      fs.unlinkSync(entry.sourcePath);
      syncFile(target);
      syncDirectory(path.dirname(target));
      installed.push(Object.freeze({ ...entry, target }));
    }
    syncDirectory(plan.runtimeRoot);
    return installed;
  } catch (error) {
    for (const entry of installed.reverse()) {
      if (fs.existsSync(entry.target)) fs.unlinkSync(entry.target);
      syncDirectory(path.dirname(entry.target));
    }
    throw error;
  }
}

function verifyBusinessStatePreserved(plan) {
  const post = plan.instances.map((instance) => {
    const candidate = instancePath(plan.runtimeRoot, instance);
    const observed = partialRootBusinessState(candidate);
    const postSourceSha256 = fileSha256HashSync(candidate);
    if (observed.businessStateHash !== instance.businessState.businessStateHash) {
      throw new Error(
        `autonomous_research_state_partial_root_business_state_changed:${instance.role}`,
      );
    }
    if (instance.role !== 'supervisor-state'
      && postSourceSha256 !== instance.sourceSha256) {
      throw new Error(
        `autonomous_research_state_partial_root_unscoped_database_changed:${instance.role}`,
      );
    }
    return Object.freeze({
      instanceId: instance.instanceId,
      preBusinessStateHash: instance.businessState.businessStateHash,
      postBusinessStateHash: observed.businessStateHash,
      preSourceSha256: instance.sourceSha256,
      postSourceSha256,
      sourceBytesPreserved: instance.role === 'supervisor-state'
        ? null : postSourceSha256 === instance.sourceSha256,
      rowCount: observed.tables.reduce((sum, table) => sum + table.rowCount, 0),
    });
  });
  return Object.freeze(post);
}

export function executeAutonomousResearchStatePartialRootMaintenance({
  runtimeRoot,
  rescueRoot,
  stateDatabaseManifest,
  maintenanceIdentity,
  writerQuiescenceReceipt,
  expectedMaintenancePlanId,
  provisionMissingBusinessSchemas,
  clock = { now: () => new Date() },
} = {}) {
  if (!SHA256.test(String(expectedMaintenancePlanId || ''))
    || typeof provisionMissingBusinessSchemas !== 'function') {
    throw new Error('autonomous_research_state_partial_root_execution_invalid');
  }
  const plan = buildAutonomousResearchStatePartialRootMaintenancePlan({
    runtimeRoot,
    rescueRoot,
    stateDatabaseManifest,
    maintenanceIdentity,
    writerQuiescenceReceipt,
    clock,
  });
  if (plan.maintenancePlanId !== expectedMaintenancePlanId) {
    throw new Error('autonomous_research_state_partial_root_plan_mismatch');
  }
  const locks = acquireExclusiveLocks(plan);
  let staged = null;
  let installed = [];
  let supervisorCommitted = false;
  let rescue = null;
  try {
    rescue = createRescueBundle(plan);
    staged = stageMissingDatabases({
      plan, stateDatabaseManifest, provisionMissingBusinessSchemas,
    });
    const supervisor = locks.get('supervisor-state');
    installAutonomousResearchSupervisorExternalActionJournalCoreSchema(supervisor);
    const supervisorInstance = plan.instances.find((entry) => entry.role === 'supervisor-state');
    const supervisorState = partialRootBusinessStateFromDatabase(supervisor);
    if (supervisorState.businessStateHash
      !== supervisorInstance.businessState.businessStateHash) {
      throw new Error('autonomous_research_state_partial_root_supervisor_state_changed');
    }
    installed = publishNoClobber({ plan, staged });
    closeLocks(locks, true);
    supervisorCommitted = true;
  } catch (error) {
    if (!supervisorCommitted) {
      for (const entry of installed.reverse()) {
        if (fs.existsSync(entry.target)) fs.unlinkSync(entry.target);
      }
      try { closeLocks(locks, false); } catch { /* preserve primary failure */ }
    }
    throw error;
  } finally {
    if (staged) fs.rmSync(staged.stagingRoot, { recursive: true, force: true });
  }
  const postInventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot: plan.runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  validateAutonomousResearchOnlineSchemaTransitionInventory({
    runtimeRoot: plan.runtimeRoot,
    inventory: postInventory,
    stateDatabaseManifest,
  });
  const businessState = verifyBusinessStatePreserved(plan);
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStatePartialRootMaintenanceReceipt',
    status: 'autonomous_research_state_partial_root_business_repair_complete',
    ready: true,
    maintenancePlanId: plan.maintenancePlanId,
    stateDatabaseManifestHash: plan.stateDatabaseManifestHash,
    preRepairDatabaseScopeHash: plan.databaseScopeHash,
    postRepairDatabaseScopeHash: postInventory.databaseScopeHash,
    repairedSupervisorBusinessObjects: Object.freeze([
      'index:idx_autonomous_research_supervisor_external_action_history',
      'index:idx_autonomous_research_supervisor_external_action_one_active',
      'table:autonomous_research_supervisor_external_action_journal',
    ]),
    installedRoles: Object.freeze(installed.map((entry) => entry.role).sort()),
    businessState,
    businessStateAndRowsPreserved: true,
    unscopedExistingDatabaseBytesPreserved: true,
    rescueBundlePath: rescue.bundlePath,
    rescueManifestHash: rescue.manifest.rescueManifestHash,
    rescueCopyRestoreVerified: true,
    onlineSchemaTransitionRequired: true,
    externalAuthorityInvoked: false,
  });
  return Object.freeze({
    ...payload,
    maintenanceReceiptHash: hashRecord(
      'AutonomousResearchStatePartialRootMaintenanceReceipt', payload,
    ),
  });
}
