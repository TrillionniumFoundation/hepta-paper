import { spawnSync } from 'node:child_process';
import { preflightCodexResearchAuthor } from '../../paper-adapters/automation/codex-research-author-preflight.mjs';
import { preflightCodexFormalReviewer } from '../../paper-adapters/automation/codex-formal-reviewer-preflight.mjs';
import { probeCodexModelAvailability } from '../../paper-adapters/automation/codex-runtime-preflight.mjs';
import { AUTOMATION_RUNTIME_IMAGES } from '../../paper-adapters/automation/runtime-image-registry.mjs';
import {
  inspectDockerRuntimeImageManifest,
} from '../../paper-adapters/automation/docker-runtime-image-manifest-inspection.mjs';
import {
  inspectResearchExecutionReleaseAttestorConfiguration,
} from '../../paper-adapters/build-package/research-execution-release-attestor.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { HEPTA_WORKSPACE_ROOT } from '../../paper-adapters/runtime/workspace-layout.mjs';
import {
  requireAutonomousResearchProviderConfiguration,
} from './autonomous-research-provider-configuration.mjs';
import {
  composeRuntimeImageReproducibilityStatus,
} from './runtime-image-reproducibility-composition.mjs';

function observedPinnedImageDigest(profile, spawnSyncImpl) {
  const inspection = inspectDockerRuntimeImageManifest({
    image: profile.image,
    expectedManifestDigest: profile.imageDigest,
    spawnSyncImpl,
    timeoutMs: 15_000,
  });
  return inspection.ready ? inspection.observedManifestDigest : null;
}

function dateFromClock(clock) {
  const observed = typeof clock?.now === 'function' ? clock.now() : new Date();
  const value = observed instanceof Date ? observed : new Date(observed);
  if (!Number.isFinite(value.getTime())) {
    throw new Error('autonomous_research_qualification_context_clock_invalid');
  }
  return value;
}

function reportSynchronousProgress(callback, stage) {
  if (callback === null || callback === undefined) return;
  if (typeof callback !== 'function') {
    throw new Error('autonomous_research_qualification_context_progress_callback_invalid');
  }
  let result;
  try { result = callback(Object.freeze({ stage })); }
  catch (error) {
    if (error?.message === 'autonomous_research_qualification_attempt_lease_lost') {
      throw error;
    }
    throw new Error('autonomous_research_qualification_progress_fence_lost', {
      cause: error,
    });
  }
  if (result && typeof result.then === 'function') {
    throw new Error(
      'autonomous_research_qualification_context_synchronous_progress_callback_required',
    );
  }
}

async function reportProgress(callback, stage) {
  if (callback === null || callback === undefined) return;
  if (typeof callback !== 'function') {
    throw new Error('autonomous_research_qualification_context_progress_callback_invalid');
  }
  try { await callback(Object.freeze({ stage })); }
  catch (error) {
    throw new Error('autonomous_research_qualification_progress_fence_lost', {
      cause: error,
    });
  }
}

export function createAutonomousResearchQualificationContextProvider({
  schemaVersionReceipt,
  providerConfiguration,
  expectedProviderConfigurationHash = null,
  environment = {},
  runtimeRoot = null,
  repositoryRoot = HEPTA_WORKSPACE_ROOT,
  spawnSyncImpl = spawnSync,
  codeProvenanceProvider = currentCodeProvenance,
  preflightAuthor = preflightCodexResearchAuthor,
  preflightReviewer = preflightCodexFormalReviewer,
  probeModelAvailability = probeCodexModelAvailability,
  clock = null,
  onProgress = null,
  onSynchronousProgress = null,
  runtimeImageStatusComposer = composeRuntimeImageReproducibilityStatus,
  releaseAttestorInspector = inspectResearchExecutionReleaseAttestorConfiguration,
  pinnedImageDigestInspector = observedPinnedImageDigest,
} = {}) {
  const configuration = requireAutonomousResearchProviderConfiguration(
    providerConfiguration,
    { expectedHash: expectedProviderConfigurationHash },
  );
  return async function provideAutonomousResearchQualificationContext({
    preparation,
    onSynchronousProgress: invocationSynchronousProgress = null,
  } = {}) {
    const progress = async (stage) => {
      await reportProgress(onProgress, stage);
      reportSynchronousProgress(invocationSynchronousProgress, stage);
    };
    const synchronousProgress = ({ stage }) => {
      reportSynchronousProgress(onSynchronousProgress, stage);
      reportSynchronousProgress(invocationSynchronousProgress, stage);
    };
    if (!preparation?.autonomousResearchProviderConfigurationHash
      || preparation.autonomousResearchProviderConfigurationHash
        !== configuration.autonomousResearchProviderConfigurationHash) {
      throw new Error('autonomous_research_provider_configuration_hash_mismatch');
    }
    await progress('qualification_context_before_code_provenance');
    const codeProvenance = codeProvenanceProvider();
    await progress('qualification_context_after_code_provenance');
    const authorConfiguration = configuration.researchAuthor;
    const reviewerConfiguration = configuration.formalReviewer;
    await progress('qualification_context_before_author_preflight');
    const author = preflightAuthor({
      ...authorConfiguration, environment, spawnSyncImpl,
    });
    await progress('qualification_context_after_author_preflight');
    await progress('qualification_context_before_reviewer_preflight');
    const reviewer = preflightReviewer({
      ...reviewerConfiguration,
      authorProvider: authorConfiguration.provider,
      authorCodexHome: author.codexHome,
      environment,
      spawnSyncImpl,
    });
    await progress('qualification_context_after_reviewer_preflight');
    await progress('qualification_context_before_author_provider_canary');
    const authorCanary = probeModelAvailability({
      ...authorConfiguration,
      errorPrefix: 'autonomous_research_author_qualification',
      environment,
      spawnSyncImpl,
      clock,
    });
    await progress('qualification_context_after_author_provider_canary');
    await progress('qualification_context_before_reviewer_provider_canary');
    const reviewerCanary = probeModelAvailability({
      ...reviewerConfiguration,
      errorPrefix: 'autonomous_research_reviewer_qualification',
      environment,
      spawnSyncImpl,
      clock,
    });
    await progress('qualification_context_after_reviewer_provider_canary');
    await progress('qualification_context_before_runtime_image_reproducibility');
    const runtimeImageReproducibilityReport = runtimeImageStatusComposer({
      runtimeRoot,
      repositoryRoot,
      configPath: environment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG || null,
      receiptPath: environment.HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT || null,
      environment,
      now: dateFromClock(clock),
      codeProvenance,
    });
    await progress('qualification_context_after_runtime_image_reproducibility');
    const runtimeImageReproducibilityInspection =
      runtimeImageReproducibilityReport.inspection || Object.freeze({
        version: 1,
        kind: 'RuntimeImageReproducibilityReceiptInspection',
        status: 'runtime_image_reproducibility_blocked',
        ready: false,
        receiptAccepted: false,
        receiptHash: null,
        requiredProfiles: Object.freeze([]),
        definitionManifestHashes: null,
        blockers: runtimeImageReproducibilityReport.blockers,
      });
    await progress('qualification_context_before_release_attestor_inspection');
    const releaseAttestorInspection = releaseAttestorInspector({
      runtimeRoot,
      configPath: environment.HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG || null,
      environment,
      now: dateFromClock(clock),
      spawnSyncImpl,
      onSynchronousProgress: synchronousProgress,
    });
    await progress('qualification_context_after_release_attestor_inspection');
    await progress('qualification_context_before_python_image_manifest_inspection');
    const pythonImageDigest = pinnedImageDigestInspector(
      AUTOMATION_RUNTIME_IMAGES.python,
      spawnSyncImpl,
    );
    await progress('qualification_context_after_python_image_manifest_inspection');
    await progress('qualification_context_before_r_image_manifest_inspection');
    const rImageDigest = pinnedImageDigestInspector(
      AUTOMATION_RUNTIME_IMAGES.r,
      spawnSyncImpl,
    );
    await progress('qualification_context_after_r_image_manifest_inspection');
    return Object.freeze({
      codeProvenance,
      autonomousResearchProviderConfigurationHash:
        configuration.autonomousResearchProviderConfigurationHash,
      researchAuthorCapabilityReceipt: author.capabilityReceipt,
      formalReviewerCapabilityReceipt: reviewer.capabilityReceipt,
      campaignStoreSchemaReceipt: schemaVersionReceipt,
      runtimeImageDigests: Object.freeze({
        python: pythonImageDigest,
        r: rImageDigest,
      }),
      runtimeImageReproducibilityInspection,
      releaseAttestorInspection,
      researchAuthorProviderCanaryReceipt: authorCanary,
      formalReviewerProviderCanaryReceipt: reviewerCanary,
    });
  };
}
