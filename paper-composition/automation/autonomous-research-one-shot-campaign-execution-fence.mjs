import { preflightCodexResearchAuthor } from '../../paper-adapters/automation/codex-research-author-preflight.mjs';
import { preflightCodexFormalReviewer } from '../../paper-adapters/automation/codex-formal-reviewer-preflight.mjs';
import {
  canonicalAutonomousResearchOneShotSnapshot,
} from '../../paper-domain/automation/autonomous-research-one-shot-canonical-json.mjs';
import {
  verifyAutonomousResearchProviderCanaryPairReceipt,
} from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';
import { stableStringify } from '../../workflow-kernel/record-hash.mjs';

const MAXIMUM_EXECUTION_BINDING_BYTES = 64 * 1024;
const MAXIMUM_DATASET_MOUNTS_BYTES = 64 * 1024;
const EXECUTION_FENCE_PHASES = new Set([
  'launch_started', 'post_provider_canary', 'pre_launch', 'pre_provider',
  'provider_started',
]);

function canonicalExecutionBinding(value) {
  return canonicalAutonomousResearchOneShotSnapshot(value, {
    code: 'autonomous_research_one_shot_execution_binding_reinspection_invalid',
    maximumBytes: MAXIMUM_EXECUTION_BINDING_BYTES,
  });
}

export function canonicalAutonomousResearchOneShotDatasetMounts(datasetMounts) {
  if (!Array.isArray(datasetMounts)) {
    throw new Error('autonomous_research_one_shot_dataset_mounts_invalid');
  }
  return canonicalAutonomousResearchOneShotSnapshot(datasetMounts, {
    code: 'autonomous_research_one_shot_dataset_mounts_invalid',
    maximumBytes: MAXIMUM_DATASET_MOUNTS_BYTES,
  });
}

export function createAutonomousResearchOneShotCampaignExecutionBindingFence({
  expectedExecutionBinding,
  inspectCurrentExecutionBinding,
} = {}) {
  if (typeof inspectCurrentExecutionBinding !== 'function') {
    throw new Error('autonomous_research_one_shot_execution_binding_fence_invalid');
  }
  const expected = stableStringify(canonicalExecutionBinding(expectedExecutionBinding));
  return Object.freeze({
    assertCurrent({ phase } = {}) {
      if (!EXECUTION_FENCE_PHASES.has(phase)) {
        throw new Error('autonomous_research_one_shot_execution_binding_fence_phase_invalid');
      }
      const current = canonicalExecutionBinding(inspectCurrentExecutionBinding());
      if (stableStringify(current) !== expected) {
        throw new Error(`autonomous_research_one_shot_execution_binding_changed:${phase}`);
      }
      return current;
    },
  });
}

export function createAutonomousResearchOneShotExternalActionGate({
  repository,
  transition,
  executionBindingFence,
  phase,
} = {}) {
  if (typeof repository?.assertExternalActionMarkerCurrent !== 'function'
    || typeof executionBindingFence?.assertCurrent !== 'function'
    || !['provider_started', 'launch_started'].includes(phase)) {
    throw new Error('autonomous_research_one_shot_external_action_gate_invalid');
  }
  const assertCurrent = () => {
    if (repository.assertExternalActionMarkerCurrent({ transition }) !== true) {
      throw new Error('autonomous_research_one_shot_external_action_marker_invalid');
    }
    return executionBindingFence.assertCurrent({ phase });
  };
  const gate = async () => assertCurrent();
  gate.assertCurrent = assertCurrent;
  return Object.freeze(gate);
}

export function assertAutonomousResearchOneShotProviderCanaryReceiptBound({
  receipt,
  expectedProviderConfigurationHash,
  expectedProviderRuntimeBinding,
  now,
} = {}) {
  if (!verifyAutonomousResearchProviderCanaryPairReceipt(receipt, {
    expectedProviderConfigurationHash,
    now,
  })) {
    throw new Error('autonomous_research_one_shot_provider_canary_receipt_invalid');
  }
  if (receipt.researchAuthorCapabilityReceiptHash
      !== expectedProviderRuntimeBinding?.researchAuthorCapabilityReceiptHash
    || receipt.formalReviewerCapabilityReceiptHash
      !== expectedProviderRuntimeBinding?.formalReviewerCapabilityReceiptHash
    || receipt.researchAuthorProviderCanaryReceipt?.credentialConfigIdentityHash
      !== expectedProviderRuntimeBinding?.researchAuthorCredentialConfigIdentityHash
    || receipt.formalReviewerProviderCanaryReceipt?.credentialConfigIdentityHash
      !== expectedProviderRuntimeBinding?.formalReviewerCredentialConfigIdentityHash
    || receipt.researchAuthorProviderCanaryReceipt?.openClawManagedAuthProfileIdentityHash
      !== expectedProviderRuntimeBinding?.researchAuthorOpenClawManagedAuthProfileIdentityHash
    || receipt.formalReviewerProviderCanaryReceipt?.openClawManagedAuthProfileIdentityHash
      !== expectedProviderRuntimeBinding?.formalReviewerOpenClawManagedAuthProfileIdentityHash
    || receipt.researchAuthorProviderCanaryReceipt?.openClawManagedRuntimeProvenanceHash
      !== expectedProviderRuntimeBinding?.openClawManagedRuntimeProvenanceHash
    || receipt.formalReviewerProviderCanaryReceipt?.openClawManagedRuntimeProvenanceHash
      !== expectedProviderRuntimeBinding?.openClawManagedRuntimeProvenanceHash
    || receipt.researchAuthorProviderCanaryReceipt?.openClawManagedAuthSourceIdentityHash
      !== expectedProviderRuntimeBinding?.openClawManagedAuthSourceIdentityHash
    || receipt.formalReviewerProviderCanaryReceipt?.openClawManagedAuthSourceIdentityHash
      !== expectedProviderRuntimeBinding?.openClawManagedAuthSourceIdentityHash) {
    throw new Error('autonomous_research_one_shot_provider_canary_capability_mismatch');
  }
  return receipt;
}

export function inspectAutonomousResearchOneShotProviderRuntimeBinding({
  providerConfiguration,
  environment,
  preflightAuthor = preflightCodexResearchAuthor,
  preflightReviewer = preflightCodexFormalReviewer,
} = {}) {
  const author = preflightAuthor({
    ...providerConfiguration.researchAuthor,
    environment,
  });
  const reviewer = preflightReviewer({
    ...providerConfiguration.formalReviewer,
    authorProvider: providerConfiguration.researchAuthor.provider,
    authorCodexHome: author.codexHome,
    environment,
  });
  const authorReceipt = author.capabilityReceipt;
  const reviewerReceipt = reviewer.capabilityReceipt;
  if (!authorReceipt || !reviewerReceipt
    || authorReceipt.openClawManagedRuntimeProvenanceHash
      !== reviewerReceipt.openClawManagedRuntimeProvenanceHash
    || authorReceipt.openClawManagedAuthSourceIdentityHash
      !== reviewerReceipt.openClawManagedAuthSourceIdentityHash) {
    throw new Error('autonomous_research_one_shot_provider_runtime_binding_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotProviderRuntimeBinding',
    providerConfigurationHash:
      providerConfiguration.autonomousResearchProviderConfigurationHash,
    researchAuthorCapabilityReceiptHash:
      authorReceipt.codexResearchAuthorCapabilityReceiptHash,
    formalReviewerCapabilityReceiptHash:
      reviewerReceipt.codexFormalReviewerCapabilityReceiptHash,
    researchAuthorCredentialConfigIdentityHash:
      authorReceipt.credentialConfigIdentityHash,
    formalReviewerCredentialConfigIdentityHash:
      reviewerReceipt.credentialConfigIdentityHash,
    researchAuthorOpenClawManagedAuthProfileIdentityHash:
      authorReceipt.openClawManagedAuthProfileIdentityHash,
    formalReviewerOpenClawManagedAuthProfileIdentityHash:
      reviewerReceipt.openClawManagedAuthProfileIdentityHash,
    openClawManagedRuntimeProvenanceHash:
      authorReceipt.openClawManagedRuntimeProvenanceHash,
    openClawManagedAuthSourceIdentityHash:
      authorReceipt.openClawManagedAuthSourceIdentityHash,
  });
}
