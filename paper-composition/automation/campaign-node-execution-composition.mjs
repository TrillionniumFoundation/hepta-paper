import { createCampaignNodeExecutor as createApplicationCampaignNodeExecutor } from '../../paper-application/automation/campaign-node-executor.mjs';
import { createCampaignNodePrimitivesAdapter } from '../../paper-adapters/automation/campaign-node-primitives-adapter.mjs';
import { createCampaignWorkspaceAttemptAdapter } from '../../paper-adapters/automation/campaign-workspace-attempt-adapter.mjs';
import { createFormalProofSearchOperationsExecutor } from '../../paper-adapters/research-verify/formal-proof-search-operations-executor.mjs';
import { createFormalTheoremDependencyGraphOperationsExecutor } from '../../paper-adapters/research-verify/formal-theorem-dependency-graph-operations-executor.mjs';
import { configuredPinnedFormalSandboxRuntime } from '../../paper-adapters/research-verify/pinned-formal-sandbox-runtime-configuration.mjs';

export function createCampaignNodeExecutor(options = {}) {
  const reviewerPool = options.reviewerPrincipalExecutorPool || null;
  const configuredRuntime = options.trustedFormalSandboxRuntime
    || configuredPinnedFormalSandboxRuntime({
      environment: options.environment || process.env,
      allowSystemDefault: true,
    });
  const formalProofSearchOperationsExecutor = options.formalProofSearchOperationsExecutor
    || createFormalProofSearchOperationsExecutor({
      trustedSandboxRuntime: configuredRuntime,
      temporaryRoot: options.runtimeRoot,
      dynamicFormalExecutionAuthority: options.dynamicFormalExecutionAuthority,
      dynamicFormalExecutionEnvironment: options.environment || process.env,
      dynamicFormalExecutionSpawnSync: options.spawnSyncImpl,
    });
  const formalTheoremDependencyGraphOperationsExecutor =
    options.formalTheoremDependencyGraphOperationsExecutor
    || createFormalTheoremDependencyGraphOperationsExecutor({
      trustedSandboxRuntime: configuredRuntime,
      temporaryRoot: options.runtimeRoot,
      dynamicFormalExecutionAuthority: options.dynamicFormalExecutionAuthority,
      dynamicFormalExecutionEnvironment: options.environment || process.env,
      dynamicFormalExecutionSpawnSync: options.spawnSyncImpl,
    });
  return createApplicationCampaignNodeExecutor({
    nodePrimitives: createCampaignNodePrimitivesAdapter({
      ...options,
      formalProofSearchOperationsExecutor,
      formalTheoremDependencyGraphOperationsExecutor,
    }),
    workspaceAttempts: createCampaignWorkspaceAttemptAdapter({ runtimeRoot: options.runtimeRoot }),
    experimentRegistryAuthorityVerifier: options.experimentRegistryAuthorityVerifier || null,
    signedReviewerReceiptVerifier:
      reviewerPool?.verifySignedReviewerReceipt || null,
    sessionReviewerReceiptVerifier:
      reviewerPool?.verifySessionReviewerReceipt || null,
    reviewerEvidenceAuthority: reviewerPool ? Object.freeze({
      version: reviewerPool.version,
      kind: 'ReviewerReceiptVerificationAuthority',
      authorityMode: reviewerPool.authorityMode || null,
      sessionIsolationReady: reviewerPool.sessionIsolationReady === true,
      cryptographicAuthorityReady:
        reviewerPool.cryptographicAuthorityReady === true,
      identityIndependenceReady:
        reviewerPool.identityIndependenceReady === true,
      researchPrincipalPoolHash: reviewerPool.pool?.researchPrincipalPoolHash || null,
      reviewerTrustSetHash: reviewerPool.trustSetHash || null,
      reviewerSignatureVerificationPolicyHash:
        reviewerPool.signatureVerificationPolicyHash || null,
      verifySignedReviewerReceipt: reviewerPool.verifySignedReviewerReceipt,
      verifySessionReviewerReceipt: reviewerPool.verifySessionReviewerReceipt,
    }) : null,
    advancedNumericalExecution: options.advancedNumericalExecution || null,
    gpuScientificExecution: options.gpuScientificExecution || null,
  });
}
