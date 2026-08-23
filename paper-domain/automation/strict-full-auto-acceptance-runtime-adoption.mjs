import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from './autonomous-research-state-backup-contract.mjs';
import {
  exactKeys,
  strictFullAutoAcceptanceHash,
} from './strict-full-auto-acceptance-primitives.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_INSPECTION_LIFETIME_MS = 5 * 60 * 1000;
const POLICY_KEYS = Object.freeze([
  'version', 'kind', 'mode', 'expectedRuntimeRootIdentityHash',
  'expectedPristineRuntimeStateHash', 'adoptionMutationPerformed',
  'preResidentSchemaRebindRequired',
]);
const INSPECTION_KEYS = Object.freeze([
  'version', 'kind', 'status', 'inspectedAt', 'runtimeRootIdentityHash',
  'stateDatabaseManifestHash', 'databaseScopeHash', 'writerManifestHash',
  'inventoryHash', 'pristineRuntimeStateHash', 'authority', 'instances',
  'businessRowCount',
  'adoptionMutationPerformed', 'preResidentSchemaRebindVerified',
  'evidenceFreshThrough', 'receiptHash',
]);
const AUTHORITY_KEYS = Object.freeze([
  'authorityId', 'keyId', 'scopeId', 'configurationHash', 'writerManifestHash',
  'observationReceiptHash', 'schemaTransitionState',
  'schemaRebindFinalizationReceiptHash', 'schemaRebindTargetConfigurationHash',
  'globalSequence', 'globalHash', 'databaseHeads',
  'writerQuiescenceStatus', 'writerQuiescenceReceiptHash',
  'writerQuiescenceScopeHash', 'writerQuiescenceFreshThrough',
  'unfinishedSchemaTransitionCount', 'unfinishedSchemaRebindCount',
  'unfinishedMutationCount', 'unfinishedBackupCount',
]);
const AUTHORITY_HEAD_KEYS = Object.freeze([
  'databaseInstanceId', 'schemaHash', 'sequence', 'hash', 'stateHash',
]);
const INSTANCE_KEYS = Object.freeze([
  'databaseRole', 'databaseInstanceId', 'sourceRelativePath', 'fileIdentityHash',
  'sha256', 'schemaContractId', 'schemaHash', 'stateHeadSequence',
  'stateHeadHash', 'stateHeadStateHash', 'markerCount', 'finalizationCount',
  'businessRowCount',
]);
const ADOPTION_KEYS = Object.freeze([
  'version', 'kind', 'status', 'planHash', 'configurationHash', 'runtimeRoot',
  'runtimeRootIdentityHash', 'pristineRuntimeStateHash', 'inspectionReceiptHash',
  'inventoryHash', 'databaseScopeHash', 'authorityConfigurationHash',
  'authorityId', 'authorityKeyId', 'authorityScopeId',
  'authorityObservationReceiptHash', 'authorityGlobalSequence', 'authorityGlobalHash',
  'schemaRebindFinalizationReceiptHash', 'leaseGeneration', 'fenceToken',
  'writerQuiescenceReceiptHash', 'adoptedAt', 'inspectionEvidenceFreshThrough',
  'adoptionReceiptHash',
]);

function canonicalTimestamp(value) {
  const parsed = Date.parse(value);
  return typeof value === 'string'
    && Number.isFinite(parsed)
    && new Date(parsed).toISOString() === value;
}

function safeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.replaceAll('\\', '/')
    && !value.startsWith('/')
    && !value.includes('//')
    && !value.split('/').some((segment) => ['.', '..'].includes(segment));
}

function inspectionBody(receipt) {
  const { receiptHash: _discarded, ...body } = receipt;
  return body;
}

function stableInspectionBody(receipt) {
  const {
    inspectedAt: _inspectedAt,
    evidenceFreshThrough: _evidenceFreshThrough,
    receiptHash: _receiptHash,
    ...body
  } = receipt;
  return body;
}

export function assertStrictFullAutoAcceptanceRuntimeRootAdoptionPolicy(value) {
  const adoption = value?.mode === 'verified-pristine-existing-runtime';
  if (!exactKeys(value, POLICY_KEYS)
    || value.version !== 1
    || value.kind !== 'StrictFullAutoAcceptanceRuntimeRootAdoptionPolicy'
    || !['fresh-runtime-only', 'verified-pristine-existing-runtime'].includes(value.mode)
    || value.adoptionMutationPerformed !== false
    || value.preResidentSchemaRebindRequired !== adoption
    || (adoption && (!SHA256.test(String(value.expectedRuntimeRootIdentityHash || ''))
      || !SHA256.test(String(value.expectedPristineRuntimeStateHash || ''))))
    || (!adoption && (value.expectedRuntimeRootIdentityHash !== null
      || value.expectedPristineRuntimeStateHash !== null))) {
    throw new Error('strict_full_auto_acceptance_runtime_root_adoption_policy_invalid');
  }
  return Object.freeze({ ...value });
}

export function autonomousResearchPristineRuntimeInspectionReceiptHash(receipt) {
  return strictFullAutoAcceptanceHash(inspectionBody(receipt));
}

export function autonomousResearchPristineRuntimeInspectionStateHash(receipt) {
  return strictFullAutoAcceptanceHash(stableInspectionBody(receipt));
}

export function assertAutonomousResearchPristineRuntimeInspectionReceipt(
  receipt,
  { now } = {},
) {
  const observedNow = new Date(now);
  const authority = receipt?.authority;
  if (!Number.isFinite(observedNow.getTime())
    || !exactKeys(receipt, INSPECTION_KEYS)
    || receipt.version !== 1
    || receipt.kind !== 'AutonomousResearchPristineRuntimeInspectionReceipt'
    || receipt.status !== 'autonomous_research_pristine_runtime_inspection_ready'
    || !canonicalTimestamp(receipt.inspectedAt)
    || !canonicalTimestamp(receipt.evidenceFreshThrough)
    || Date.parse(receipt.inspectedAt) > observedNow.getTime()
    || Date.parse(receipt.evidenceFreshThrough) <= observedNow.getTime()
    || Date.parse(receipt.evidenceFreshThrough) <= Date.parse(receipt.inspectedAt)
    || Date.parse(receipt.evidenceFreshThrough) - Date.parse(receipt.inspectedAt)
      > MAXIMUM_INSPECTION_LIFETIME_MS
    || ![
      receipt.runtimeRootIdentityHash,
      receipt.stateDatabaseManifestHash,
      receipt.databaseScopeHash,
      receipt.writerManifestHash,
      receipt.inventoryHash,
      receipt.pristineRuntimeStateHash,
    ].every((value) => SHA256.test(String(value || '')))
    || receipt.businessRowCount !== 0
    || receipt.adoptionMutationPerformed !== false
    || receipt.preResidentSchemaRebindVerified !== true
    || !exactKeys(authority, AUTHORITY_KEYS)
    || ![
      authority.configurationHash,
      authority.writerManifestHash,
      authority.observationReceiptHash,
      authority.schemaRebindFinalizationReceiptHash,
      authority.schemaRebindTargetConfigurationHash,
      authority.globalHash,
      authority.writerQuiescenceReceiptHash,
      authority.writerQuiescenceScopeHash,
    ].every((value) => SHA256.test(String(value || '')))
    || authority.writerManifestHash !== receipt.writerManifestHash
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/.test(String(authority.authorityId || ''))
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/.test(String(authority.keyId || ''))
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/.test(String(authority.scopeId || ''))
    || authority.schemaTransitionState !== 'finalized'
    || authority.schemaRebindTargetConfigurationHash !== authority.configurationHash
    || authority.globalSequence !== 0
    || authority.writerQuiescenceStatus !== 'pre_resident_writer_quiescence_verified'
    || authority.writerQuiescenceScopeHash !== receipt.databaseScopeHash
    || !canonicalTimestamp(authority.writerQuiescenceFreshThrough)
    || Date.parse(authority.writerQuiescenceFreshThrough) < Date.parse(receipt.evidenceFreshThrough)
    || [
      authority.unfinishedSchemaTransitionCount,
      authority.unfinishedSchemaRebindCount,
      authority.unfinishedMutationCount,
      authority.unfinishedBackupCount,
    ].some((value) => value !== 0)
    || !Array.isArray(receipt.instances)
    || receipt.instances.length !== AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.length
    || !Array.isArray(authority.databaseHeads)
    || authority.databaseHeads.length !== receipt.instances.length
    || receipt.receiptHash
      !== autonomousResearchPristineRuntimeInspectionReceiptHash(receipt)) {
    throw new Error('strict_full_auto_acceptance_pristine_runtime_inspection_invalid');
  }
  const instanceIds = [];
  const roles = [];
  const instanceById = new Map();
  for (const instance of receipt.instances) {
    if (!exactKeys(instance, INSTANCE_KEYS)
      || !AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.includes(instance.databaseRole)
      || typeof instance.databaseInstanceId !== 'string'
      || instance.databaseInstanceId.length < 2
      || !safeRelativePath(instance.sourceRelativePath)
      || ![
        instance.fileIdentityHash,
        instance.sha256,
        instance.schemaHash,
        instance.stateHeadHash,
        instance.stateHeadStateHash,
      ].every((value) => SHA256.test(String(value || '')))
      || typeof instance.schemaContractId !== 'string'
      || instance.schemaContractId.length < 2
      || instance.stateHeadSequence !== 0
      || instance.markerCount !== 0
      || instance.finalizationCount !== 0
      || instance.businessRowCount !== 0) {
      throw new Error('strict_full_auto_acceptance_pristine_runtime_inspection_invalid');
    }
    instanceIds.push(instance.databaseInstanceId);
    roles.push(instance.databaseRole);
    instanceById.set(instance.databaseInstanceId, instance);
  }
  if (new Set(instanceIds).size !== instanceIds.length
    || instanceIds.join('\0') !== [...instanceIds].sort().join('\0')
    || [...new Set(roles)].sort().join('\0')
      !== [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort().join('\0')) {
    throw new Error('strict_full_auto_acceptance_pristine_runtime_inspection_invalid');
  }
  const headIds = [];
  for (const head of authority.databaseHeads) {
    const instance = instanceById.get(head?.databaseInstanceId);
    if (!exactKeys(head, AUTHORITY_HEAD_KEYS)
      || !instance
      || head.sequence !== 0
      || head.sequence !== instance.stateHeadSequence
      || head.schemaHash !== instance.schemaHash
      || head.hash !== instance.stateHeadHash
      || head.stateHash !== instance.stateHeadStateHash) {
      throw new Error('strict_full_auto_acceptance_pristine_runtime_inspection_invalid');
    }
    headIds.push(head.databaseInstanceId);
  }
  if (headIds.join('\0') !== [...instanceIds].sort().join('\0')) {
    throw new Error('strict_full_auto_acceptance_pristine_runtime_inspection_invalid');
  }
  return Object.freeze({
    ...receipt,
    authority: Object.freeze({
      ...authority,
      databaseHeads: Object.freeze(authority.databaseHeads.map((head) => Object.freeze({
        ...head,
      }))),
    }),
    instances: Object.freeze(receipt.instances.map((instance) => Object.freeze({ ...instance }))),
  });
}

export function buildStrictFullAutoAcceptancePristineRuntimeAdoptionReceipt({
  plan,
  lease,
  inspectionReceipt,
  adoptedAt,
} = {}) {
  const policy = assertStrictFullAutoAcceptanceRuntimeRootAdoptionPolicy(
    plan?.runtimeRootAdoption,
  );
  const inspection = assertAutonomousResearchPristineRuntimeInspectionReceipt(
    inspectionReceipt,
    { now: new Date(adoptedAt) },
  );
  const pristineRuntimeStateHash = inspection.pristineRuntimeStateHash;
  if (policy.mode !== 'verified-pristine-existing-runtime'
    || inspection.runtimeRootIdentityHash !== policy.expectedRuntimeRootIdentityHash
    || pristineRuntimeStateHash !== policy.expectedPristineRuntimeStateHash
    || !SHA256.test(String(plan?.planHash || ''))
    || !SHA256.test(String(plan?.configurationHash || ''))
    || typeof plan.runtimeRoot !== 'string'
    || !plan.runtimeRoot.startsWith('/')
    || !Number.isSafeInteger(lease?.generation)
    || lease.generation < 1
    || !SHA256.test(String(lease?.fenceToken || ''))
    || !canonicalTimestamp(adoptedAt)) {
    throw new Error('strict_full_auto_acceptance_pristine_runtime_adoption_invalid');
  }
  const body = Object.freeze({
    version: 1,
    kind: 'StrictFullAutoAcceptancePristineRuntimeAdoption',
    status: 'strict_full_auto_acceptance_pristine_runtime_adopted',
    planHash: plan.planHash,
    configurationHash: plan.configurationHash,
    runtimeRoot: plan.runtimeRoot,
    runtimeRootIdentityHash: inspection.runtimeRootIdentityHash,
    pristineRuntimeStateHash,
    inspectionReceiptHash: inspection.receiptHash,
    inventoryHash: inspection.inventoryHash,
    databaseScopeHash: inspection.databaseScopeHash,
    authorityConfigurationHash: inspection.authority.configurationHash,
    authorityId: inspection.authority.authorityId,
    authorityKeyId: inspection.authority.keyId,
    authorityScopeId: inspection.authority.scopeId,
    authorityObservationReceiptHash: inspection.authority.observationReceiptHash,
    authorityGlobalSequence: inspection.authority.globalSequence,
    authorityGlobalHash: inspection.authority.globalHash,
    schemaRebindFinalizationReceiptHash:
      inspection.authority.schemaRebindFinalizationReceiptHash,
    writerQuiescenceReceiptHash: inspection.authority.writerQuiescenceReceiptHash,
    leaseGeneration: lease.generation,
    fenceToken: lease.fenceToken,
    adoptedAt,
    inspectionEvidenceFreshThrough: inspection.evidenceFreshThrough,
  });
  return Object.freeze({
    ...body,
    adoptionReceiptHash: strictFullAutoAcceptanceHash(body),
  });
}

export function verifyStrictFullAutoAcceptancePristineRuntimeAdoptionReceipt({
  plan,
  receipt,
} = {}) {
  const policy = assertStrictFullAutoAcceptanceRuntimeRootAdoptionPolicy(
    plan?.runtimeRootAdoption,
  );
  const { adoptionReceiptHash, ...body } = receipt || {};
  if (policy.mode !== 'verified-pristine-existing-runtime'
    || !exactKeys(receipt, ADOPTION_KEYS)
    || receipt.version !== 1
    || receipt.kind !== 'StrictFullAutoAcceptancePristineRuntimeAdoption'
    || receipt.status !== 'strict_full_auto_acceptance_pristine_runtime_adopted'
    || receipt.planHash !== plan.planHash
    || receipt.configurationHash !== plan.configurationHash
    || receipt.runtimeRoot !== plan.runtimeRoot
    || receipt.runtimeRootIdentityHash !== policy.expectedRuntimeRootIdentityHash
    || receipt.pristineRuntimeStateHash !== policy.expectedPristineRuntimeStateHash
    || ![
      receipt.inspectionReceiptHash,
      receipt.inventoryHash,
      receipt.databaseScopeHash,
      receipt.authorityConfigurationHash,
      receipt.authorityObservationReceiptHash,
      receipt.authorityGlobalHash,
      receipt.schemaRebindFinalizationReceiptHash,
      receipt.writerQuiescenceReceiptHash,
      adoptionReceiptHash,
    ].every((value) => SHA256.test(String(value || '')))
    || receipt.authorityGlobalSequence !== 0
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/.test(String(receipt.authorityId || ''))
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/.test(String(receipt.authorityKeyId || ''))
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,159}$/.test(String(receipt.authorityScopeId || ''))
    || !Number.isSafeInteger(receipt.leaseGeneration)
    || receipt.leaseGeneration < 1
    || !SHA256.test(String(receipt.fenceToken || ''))
    || !canonicalTimestamp(receipt.adoptedAt)
    || !canonicalTimestamp(receipt.inspectionEvidenceFreshThrough)
    || Date.parse(receipt.inspectionEvidenceFreshThrough) <= Date.parse(receipt.adoptedAt)
    || adoptionReceiptHash !== strictFullAutoAcceptanceHash(body)) {
    throw new Error('strict_full_auto_acceptance_pristine_runtime_adoption_invalid');
  }
  return Object.freeze({ ...receipt });
}
