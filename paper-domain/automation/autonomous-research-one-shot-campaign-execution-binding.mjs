import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';
import {
  canonicalAutonomousResearchOneShotSnapshot,
} from './autonomous-research-one-shot-canonical-json.mjs';
import {
  autonomousResearchOneShotProviderRuntimeBindingHash,
  verifyAutonomousResearchOneShotProviderRuntimeBinding,
} from './autonomous-research-one-shot-provider-runtime-binding.mjs';
import {
  historicalAutonomousResearchOneShotCampaignOrdinal,
  verifyAutonomousResearchOneShotHistoricalTargetCampaignDefinition,
  verifyAutonomousResearchOneShotTargetCampaignDefinition,
} from './autonomous-research-one-shot-target-campaign.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_BINDING_BYTES = 64 * 1024;
const SAFE_ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
const SENSITIVE_ENVIRONMENT_KEY =
  /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|API_KEY|AUTHORIZATION)/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CODE_PROVENANCE_KEYS = Object.freeze([
  'commit', 'commitTree', 'evidenceClass', 'evidenceEnvironment',
  'indexStateHash', 'kind', 'packageVersion', 'repositoryContentHash',
  'repositoryEntryCount', 'tags', 'treeDirty', 'version', 'worktreeStateHash',
].sort());
const SOURCE_EXECUTION_SNAPSHOT_KEYS = Object.freeze([
  'manifestHash', 'merkleHash', 'version',
]);
const LAST_PROVIDER_BINDING_FREE_CAMPAIGN_ORDINAL = '52';
const LEGACY_EXECUTION_BINDING_KEYS = Object.freeze([
  'autonomousResearchProviderConfigurationHash', 'campaignLaunchPolicy',
  'codeProvenance', 'codeProvenanceHash', 'environmentProjection',
  'preparationPolicy', 'protectedCampaignDefinition',
  'protectedCampaignFingerprintHash', 'sourceExecutionSnapshot',
  'sourceExecutionSnapshotHash', 'targetCampaignDefinition',
  'targetCampaignDefinitionHash', 'version',
].sort());
const EXECUTION_BINDING_KEYS = Object.freeze([
  ...LEGACY_EXECUTION_BINDING_KEYS,
  'providerRuntimeBinding',
  'providerRuntimeBindingHash',
].sort());

export const AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID =
  'autonomous-research:local-auto-20260730-51';
export const AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH =
  'sha256:7fe1d221302fb8e5b1c1c7ccb33ea341311d00a994ff9b3f6dd433af82964792';
export const AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS =
  Object.freeze([
    'HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG', 'HEPTA_EXTERNAL_REPLAY_CONFIG',
    'HEPTA_EXTERNAL_REPLAY_CONFIG_HASH', 'HEPTA_EXTERNAL_REPLAY_SERVICE_TOKEN_FILE',
    'HEPTA_PRIOR_ART_SERVICE_CONFIG', 'HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH',
    'HEPTA_PRIOR_ART_SERVICE_TOKEN_FILE',
  ].sort());

export function autonomousResearchOneShotCampaignEnvironmentProjectionHash(projection) {
  const canonicalProjection = canonicalAutonomousResearchOneShotSnapshot(projection, {
    code: 'autonomous_research_one_shot_campaign_environment_projection_invalid',
    maximumBytes: 32 * 1024,
  });
  return hashRecord(
    'AutonomousResearchOneShotCampaignEnvironmentProjection',
    canonicalProjection,
  );
}

function executionBindingRecordHash(kind, value) {
  const canonicalValue = canonicalAutonomousResearchOneShotSnapshot(value, {
    code: 'autonomous_research_one_shot_campaign_execution_binding_record_invalid',
    maximumBytes: MAXIMUM_BINDING_BYTES,
  });
  return hashRecord(kind, canonicalValue);
}

export function autonomousResearchOneShotCampaignCodeProvenanceHash(value) {
  return executionBindingRecordHash(
    'AutonomousResearchOneShotCampaignCodeProvenance',
    value,
  );
}

export function autonomousResearchOneShotCampaignSourceExecutionSnapshotHash(value) {
  return executionBindingRecordHash(
    'AutonomousResearchOneShotCampaignSourceExecutionSnapshot',
    value,
  );
}

export function autonomousResearchOneShotProtectedCampaignFingerprintHash(value) {
  return executionBindingRecordHash(
    'AutonomousResearchOneShotProtectedCampaignFingerprint',
    value,
  );
}

export function autonomousResearchOneShotTargetCampaignDefinitionHash(value) {
  return executionBindingRecordHash(
    'AutonomousResearchOneShotTargetCampaignDefinition',
    value,
  );
}

export function verifyAutonomousResearchOneShotProtectedCampaignDefinition(value) {
  return exactKeys(value, [
    'activeNodeCount', 'campaignId', 'failedTerminalNodeCount', 'failureClass',
    'ledgerCount', 'logicalStateHash', 'nodeLeaseCount', 'outboxCount',
    'resourceLeaseCount', 'skippedNodeCount', 'status', 'submissionCount',
    'version', 'waiterCount',
  ].sort())
    && value.version === 1
    && value.campaignId === AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID
    && value.status === 'failed'
    && value.failedTerminalNodeCount === 1 && value.skippedNodeCount === 65
    && value.activeNodeCount === 0 && value.nodeLeaseCount === 0
    && value.resourceLeaseCount === 0 && value.waiterCount === 0
    && value.failureClass === 'agent_usage_unknown_terminal'
    && value.submissionCount === 0 && value.outboxCount === 0
    && value.ledgerCount === 0 && SHA256.test(String(value.logicalStateHash || ''));
}

function providerRuntimePolicyValid(binding, targetCampaignDefinition) {
  const historicalOrdinal = historicalAutonomousResearchOneShotCampaignOrdinal(
    targetCampaignDefinition,
  );
  if (historicalOrdinal === LAST_PROVIDER_BINDING_FREE_CAMPAIGN_ORDINAL) {
    return exactKeys(binding, LEGACY_EXECUTION_BINDING_KEYS);
  }
  return exactKeys(binding, EXECUTION_BINDING_KEYS)
    && SHA256.test(String(binding?.providerRuntimeBindingHash || ''))
    && verifyAutonomousResearchOneShotProviderRuntimeBinding(
      binding?.providerRuntimeBinding,
    )
    && binding.providerRuntimeBinding.providerConfigurationHash
      === AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH
    && binding.providerRuntimeBindingHash
      === autonomousResearchOneShotProviderRuntimeBindingHash(
        binding.providerRuntimeBinding,
      );
}

export function verifyAutonomousResearchOneShotCodeProvenance(value) {
  return exactKeys(value, CODE_PROVENANCE_KEYS)
    && value.version === 2 && value.kind === 'CodeProvenance'
    && typeof value.packageVersion === 'string' && value.packageVersion.length > 0
    && GIT_OBJECT_ID.test(String(value.commit || ''))
    && GIT_OBJECT_ID.test(String(value.commitTree || ''))
    && Array.isArray(value.tags)
    && value.tags.every((tag) => typeof tag === 'string')
    && new Set(value.tags).size === value.tags.length
    && value.treeDirty === false
    && SHA256.test(String(value.indexStateHash || ''))
    && Number.isSafeInteger(value.repositoryEntryCount)
    && value.repositoryEntryCount > 0
    && SHA256.test(String(value.repositoryContentHash || ''))
    && SHA256.test(String(value.worktreeStateHash || ''))
    && typeof value.evidenceEnvironment === 'string'
    && value.evidenceEnvironment.length > 0
    && typeof value.evidenceClass === 'string'
    && value.evidenceClass.length > 0;
}

export function verifyAutonomousResearchOneShotSourceExecutionSnapshot(value) {
  return exactKeys(value, SOURCE_EXECUTION_SNAPSHOT_KEYS)
    && value.version === 1
    && SHA256.test(String(value.merkleHash || ''))
    && SHA256.test(String(value.manifestHash || ''));
}

function preparationPolicyValid(binding, verifyTargetCampaignDefinition) {
  const policy = binding?.preparationPolicy;
  const projection = binding?.environmentProjection;
  const launchPolicy = binding?.campaignLaunchPolicy;
  const codeProvenance = binding?.codeProvenance;
  const sourceExecutionSnapshot = binding?.sourceExecutionSnapshot;
  const protectedCampaignDefinition = binding?.protectedCampaignDefinition;
  const targetCampaignDefinition = binding?.targetCampaignDefinition;
  if (!SHA256.test(String(binding?.codeProvenanceHash || ''))
    || !SHA256.test(String(binding?.sourceExecutionSnapshotHash || ''))
    || !SHA256.test(String(
      binding?.autonomousResearchProviderConfigurationHash || '',
    ))
    || binding.autonomousResearchProviderConfigurationHash
      !== AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH
    || !SHA256.test(String(binding?.protectedCampaignFingerprintHash || ''))
    || !SHA256.test(String(binding?.targetCampaignDefinitionHash || ''))
    || !verifyAutonomousResearchOneShotCodeProvenance(codeProvenance)
    || binding.codeProvenanceHash
      !== autonomousResearchOneShotCampaignCodeProvenanceHash(codeProvenance)
    || !verifyAutonomousResearchOneShotSourceExecutionSnapshot(
      sourceExecutionSnapshot,
    )
    || binding.sourceExecutionSnapshotHash
      !== autonomousResearchOneShotCampaignSourceExecutionSnapshotHash(
        sourceExecutionSnapshot,
      )
    || !verifyAutonomousResearchOneShotProtectedCampaignDefinition(
      protectedCampaignDefinition,
    )
    || binding.protectedCampaignFingerprintHash
      !== autonomousResearchOneShotProtectedCampaignFingerprintHash(
        protectedCampaignDefinition,
      )
    || !verifyTargetCampaignDefinition(targetCampaignDefinition)
    || binding.targetCampaignDefinitionHash
      !== autonomousResearchOneShotTargetCampaignDefinitionHash(targetCampaignDefinition)
    || !providerRuntimePolicyValid(binding, targetCampaignDefinition)
    || !exactKeys(policy, [
      'allowedExternalActionKinds',
      'contentMode',
      'environmentProjectionHash',
      'forbiddenEnvironmentKeys',
      'mode',
      'providerFreeRequired',
      'version',
    ].sort())
    || policy.version !== 1
    || policy.mode !== 'deterministic-bounded-offline-v1'
    || policy.contentMode !== 'deterministic-bounded'
    || policy.providerFreeRequired !== true
    || !Array.isArray(policy.allowedExternalActionKinds)
    || policy.allowedExternalActionKinds.length !== 0
    || !Array.isArray(policy.forbiddenEnvironmentKeys)
    || stableStringify(policy.forbiddenEnvironmentKeys)
      !== stableStringify(AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS)
    || !SHA256.test(String(policy.environmentProjectionHash || ''))
    || !projection || typeof projection !== 'object' || Array.isArray(projection)
    || Object.getPrototypeOf(projection) !== Object.prototype
    || Object.entries(projection).some(([key, value]) => (
      !SAFE_ENVIRONMENT_KEY.test(key)
      || SENSITIVE_ENVIRONMENT_KEY.test(key)
      || typeof value !== 'string'
      || Buffer.byteLength(value) > 4096
      || AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS.includes(key)
    ))
    || projection.HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE !== policy.contentMode
    || policy.environmentProjectionHash
      !== autonomousResearchOneShotCampaignEnvironmentProjectionHash(projection)
    || !exactKeys(launchPolicy, [
      'allowedRecoveryActions',
      'createOnly',
      'forbiddenActions',
      'version',
    ].sort())
    || launchPolicy.version !== 1
    || launchPolicy.createOnly !== true
    || stableStringify(launchPolicy.allowedRecoveryActions) !== stableStringify(['status'])
    || stableStringify(launchPolicy.forbiddenActions)
      !== stableStringify(['converge', 'resume'])) return false;
  return true;
}

function verifyExecutionBindingWithTargetPolicy(value, verifyTargetCampaignDefinition) {
  try {
    const binding = canonicalAutonomousResearchOneShotSnapshot(value, {
      code: 'autonomous_research_one_shot_campaign_attempt_binding_invalid',
      maximumBytes: MAXIMUM_BINDING_BYTES,
    });
    return stableStringify(binding) === stableStringify(value)
      && preparationPolicyValid(binding, verifyTargetCampaignDefinition);
  } catch { return false; }
}

export function verifyAutonomousResearchOneShotCampaignExecutionBinding(value) {
  return verifyExecutionBindingWithTargetPolicy(
    value,
    verifyAutonomousResearchOneShotTargetCampaignDefinition,
  );
}

export function verifyAutonomousResearchOneShotCampaignExecutionBindingForHistoricalAudit(
  value,
) {
  return verifyExecutionBindingWithTargetPolicy(
    value,
    verifyAutonomousResearchOneShotHistoricalTargetCampaignDefinition,
  );
}
