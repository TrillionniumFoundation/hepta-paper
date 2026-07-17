// Operator automation infrastructure is exposed through a bounded composition
// surface so executable entrypoints do not acquire unrelated persistence,
// archive, or governance adapters.
export { createOpenClawAgentExecutor } from '../../paper-adapters/automation/openclaw-agent-executor.mjs';
export { createOllamaStructuredAgentExecutor } from '../../paper-adapters/automation/ollama-structured-agent-executor.mjs';
export { createAgentBackendRouter } from '../../paper-adapters/automation/agent-backend-router.mjs';
export { createIsolatedAgentExecutor } from '../../paper-adapters/automation/isolated-agent-executor.mjs';
export { createMultiLanguageEmpiricalExecutor } from '../../paper-adapters/automation/multi-language-empirical-executor.mjs';
export { createFilesystemEmpiricalCacheRepository } from '../../paper-adapters/automation/empirical-cache-repository.mjs';
export { AUTOMATION_RUNTIME_IMAGES, RUNTIME_IMAGE_BUILD_REPRODUCIBILITY, runtimeCapabilityForCampaign, runtimeImagesForCampaign } from '../../paper-adapters/automation/runtime-image-registry.mjs';
export { planAutomationRuntimeReconciliation, executeAutomationRuntimeReconciliation } from '../../paper-adapters/automation/automation-runtime-reconciler.mjs';
export { buildWorkspaceLineageBackfillPlan, executeWorkspaceLineageBackfill } from '../../paper-adapters/automation/workspace-lineage-backfill.mjs';
export { createWorkspaceRegistry } from '../../paper-adapters/automation/workspace-registry.mjs';
export { preflightCodexResearchAuthor } from '../../paper-adapters/automation/codex-research-author-preflight.mjs';
export { preflightCodexFormalReviewer } from '../../paper-adapters/automation/codex-formal-reviewer-preflight.mjs';
export { probeCodexModelAvailability } from '../../paper-adapters/automation/codex-runtime-preflight.mjs';
export {
  createResearchExecutionReleaseAttestor,
  inspectResearchExecutionReleaseAttestorConfiguration,
} from '../../paper-adapters/build-package/research-execution-release-attestor.mjs';
