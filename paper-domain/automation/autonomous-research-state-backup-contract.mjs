import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES = Object.freeze([
  'native-store',
  'submission-handoff',
  'machine-intake',
  'topic-producer',
  'supervisor-state',
  'resident-instance',
  'runtime-reproducibility-refresh',
  'runtime-reproducibility-publication',
  'external-qualification',
  'full-research-qualification-publication',
]);

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ROLE = /^[a-z][a-z0-9-]{1,63}$/;
const SAFE_SCHEMA_OBJECT = /^(?:table|index|trigger|view):[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export const AUTONOMOUS_RESEARCH_ONLINE_MUTATION_REQUIRED_SCHEMA_OBJECTS = Object.freeze([
  'index:idx_autonomous_research_online_mutation_marker_head',
  'table:autonomous_research_online_mutation_authority_marker',
  'table:autonomous_research_online_mutation_authority_metadata',
  'table:autonomous_research_online_mutation_finalization_receipt',
  'trigger:autonomous_research_online_mutation_finalization_marker_required',
  'trigger:autonomous_research_online_mutation_finalization_no_delete',
  'trigger:autonomous_research_online_mutation_finalization_no_update',
  'trigger:autonomous_research_online_mutation_marker_no_delete',
  'trigger:autonomous_research_online_mutation_marker_no_update',
  'trigger:autonomous_research_online_mutation_metadata_no_delete',
  'trigger:autonomous_research_online_mutation_metadata_no_update',
]);

export const AUTONOMOUS_RESEARCH_RESIDENT_AUTHORITY_JOURNAL_REQUIRED_SCHEMA_OBJECTS =
  Object.freeze([
    'index:idx_autonomous_research_online_authority_receipt_latest',
    'table:autonomous_research_online_authority_journal_metadata',
    'table:autonomous_research_online_authority_receipt_journal',
    'trigger:autonomous_research_online_authority_journal_no_delete',
    'trigger:autonomous_research_online_authority_journal_no_update',
  ]);

function safeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.replaceAll('\\', '/')
    && !value.startsWith('/')
    && !value.includes('//')
    && !value.split('/').includes('.')
    && !value.split('/').includes('..')
    && !value.endsWith('/');
}

export function assertAutonomousResearchStateDatabaseManifest(manifest) {
  if (!hasExactObjectKeys(manifest, [
    'version', 'kind', 'manifestId', 'unknownAutonomousResearchSqlitePolicy',
    'databases', 'excludedDatabases',
  ])
    || manifest.version !== 1
    || manifest.kind !== 'AutonomousResearchStateDatabaseManifest'
    || !SAFE_ROLE.test(String(manifest.manifestId || ''))
    || manifest.unknownAutonomousResearchSqlitePolicy !== 'block'
    || !Array.isArray(manifest.databases)
    || !Array.isArray(manifest.excludedDatabases)) {
    throw new Error('autonomous_research_state_database_manifest_invalid');
  }
  const roles = [];
  for (const entry of manifest.databases) {
    const perPaper = entry?.cardinality === 'per-paper';
    const keys = perPaper
      ? [
        'role', 'cardinality', 'relativePathPattern', 'minimumInstances',
        'schemaContractId', 'requiredSchemaObjects',
      ]
      : [
        'role', 'cardinality', 'relativePath', 'minimumInstances',
        'schemaContractId', 'requiredSchemaObjects',
      ];
    if (!hasExactObjectKeys(entry, keys)
      || !SAFE_ROLE.test(String(entry.role || ''))
      || !['singleton', 'per-paper'].includes(entry.cardinality)
      || !Number.isSafeInteger(entry.minimumInstances)
      || entry.minimumInstances < 1
      || !SAFE_ROLE.test(String(entry.schemaContractId || ''))
      || !Array.isArray(entry.requiredSchemaObjects)
      || entry.requiredSchemaObjects.length < 1
      || entry.requiredSchemaObjects.some((value) => !SAFE_SCHEMA_OBJECT.test(String(value || '')))
      || new Set(entry.requiredSchemaObjects).size !== entry.requiredSchemaObjects.length
      || [...entry.requiredSchemaObjects].sort().join('\0') !== entry.requiredSchemaObjects.join('\0')) {
      throw new Error('autonomous_research_state_database_manifest_entry_invalid');
    }
    if (perPaper) {
      if (!safeRelativePath(entry.relativePathPattern)
        || entry.relativePathPattern.split('{paperId}').length !== 2) {
        throw new Error('autonomous_research_state_database_manifest_pattern_invalid');
      }
    } else if (!safeRelativePath(entry.relativePath)) {
      throw new Error('autonomous_research_state_database_manifest_path_invalid');
    }
    const requiredObjects = new Set(entry.requiredSchemaObjects);
    if (AUTONOMOUS_RESEARCH_ONLINE_MUTATION_REQUIRED_SCHEMA_OBJECTS.some(
      (objectId) => !requiredObjects.has(objectId),
    ) || (entry.role === 'resident-instance'
      && AUTONOMOUS_RESEARCH_RESIDENT_AUTHORITY_JOURNAL_REQUIRED_SCHEMA_OBJECTS.some(
        (objectId) => !requiredObjects.has(objectId),
      ))) {
      throw new Error('autonomous_research_state_database_online_authority_schema_required');
    }
    roles.push(entry.role);
  }
  if (new Set(roles).size !== roles.length
    || roles.sort().join('\0') !== [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort().join('\0')) {
    throw new Error('autonomous_research_state_database_manifest_roles_invalid');
  }
  const exclusions = [];
  for (const entry of manifest.excludedDatabases) {
    if (!hasExactObjectKeys(entry, [
      'relativePath', 'status', 'presence', 'requiredBytes',
    ])
      || !safeRelativePath(entry.relativePath)
      || entry.relativePath.includes('/')
      || entry.status !== 'retired-empty-unreferenced-placeholder'
      || entry.presence !== 'optional'
      || entry.requiredBytes !== 0) {
      throw new Error('autonomous_research_state_database_manifest_exclusion_invalid');
    }
    exclusions.push(entry.relativePath);
  }
  if (new Set(exclusions).size !== exclusions.length) {
    throw new Error('autonomous_research_state_database_manifest_exclusion_duplicate');
  }
  return manifest;
}

export function autonomousResearchStateDatabaseManifestHash(manifest) {
  return hashRecord(
    'AutonomousResearchStateDatabaseManifest',
    assertAutonomousResearchStateDatabaseManifest(manifest),
  );
}

export function autonomousResearchStateDatabaseScopeHash(instances) {
  if (!Array.isArray(instances) || !instances.length) {
    throw new Error('autonomous_research_state_database_scope_empty');
  }
  const scope = instances.map((entry) => ({
    instanceId: entry.instanceId,
    role: entry.role,
    sourceRelativePath: entry.sourceRelativePath,
  })).sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  if (scope.some((entry) => !SAFE_ROLE.test(String(entry.role || ''))
    || typeof entry.instanceId !== 'string' || !entry.instanceId
    || !safeRelativePath(entry.sourceRelativePath))) {
    throw new Error('autonomous_research_state_database_scope_invalid');
  }
  return hashRecord('AutonomousResearchStateDatabaseScope', scope);
}

export function autonomousResearchStateDatabaseInventoryHash(inventory) {
  if (inventory?.kind !== 'AutonomousResearchStateDatabaseInventory'
    || inventory?.version !== 1
    || inventory?.status !== 'autonomous_research_state_database_inventory_ready'
    || !SHA256.test(String(inventory.manifestHash || ''))
    || !SHA256.test(String(inventory.databaseScopeHash || ''))
    || !Array.isArray(inventory.instances)
    || !inventory.instances.length) {
    throw new Error('autonomous_research_state_database_inventory_invalid');
  }
  return hashRecord('AutonomousResearchStateDatabaseInventory', {
    manifestId: inventory.manifestId,
    manifestHash: inventory.manifestHash,
    databaseScopeHash: inventory.databaseScopeHash,
    instances: inventory.instances,
  });
}

export function autonomousResearchStateBackupContentHash(content) {
  if (content?.version !== 1
    || content?.kind !== 'AutonomousResearchStateBackupContent'
    || !SHA256.test(String(content.inventoryHash || ''))
    || !SHA256.test(String(content.databaseScopeHash || ''))
    || !SHA256.test(String(content.authorityReservationHash || ''))
    || !Array.isArray(content.databases)
    || !content.databases.length) {
    throw new Error('autonomous_research_state_backup_content_invalid');
  }
  return hashRecord('AutonomousResearchStateBackupContent', content);
}

export function autonomousResearchStateBackupBundleManifestHash(manifest) {
  if (manifest?.version !== 1
    || manifest?.kind !== 'AutonomousResearchStateBackupBundleManifest'
    || manifest?.status !== 'autonomous_research_state_backup_recorded'
    || !SHA256.test(String(manifest.snapshotContentHash || ''))
    || !manifest.content
    || !manifest.authorityReservation
    || !manifest.authorityFinalization) {
    throw new Error('autonomous_research_state_backup_bundle_manifest_invalid');
  }
  const payload = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'bundleManifestHash'),
  );
  return hashRecord('AutonomousResearchStateBackupBundleManifest', payload);
}
