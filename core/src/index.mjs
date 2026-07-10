export const CORE_PUBLIC_API_VERSION = 2;

export const CORE_PUBLIC_MODULES = Object.freeze([
  'contracts',
  'contract-schema',
  'compatibility-export-policy',
  'integration-gate-tooling',
  'channel-import-allowlist',
  'package-root-resolver',
  'package-root-import-migration',
  'hash-utils',
  'adapters',
  'channel-adapter-interface',
  'product-router',
  'workflow-registry',
  'workflow-production-contracts',
  'human-feedback-contracts',
  'human-feedback-loop-contracts',
  'human-feedback-evidence-contracts',
  'opportunity-lifecycle-contracts',
  'business-priority-contracts',
  'case-ledger-contracts',
  'semantic-intake-contracts',
  'industry-taxonomy-contracts',
  'production-planner-gate-contracts',
  'production-execution-invariant-contracts',
  'pre-generation-readiness-contracts',
  'package-quality-lifecycle-contracts',
  'structured-qa-blocker-contracts',
  'semantic-reviewer-calibration-contracts',
  'generation-repair-route-contracts',
  'submit-ready-lifecycle-contracts',
  'submit-ready-cleanup-contracts',
  'feedback-ingest-contracts',
  'feedback-learning-bridge-contracts',
  'submit-ready-action-projection-contracts',
  'today-operational-projection-contracts',
  'provider-experiment-contracts',
  'spend-guard-contracts',
  'acceptance-followup-projection-contracts',
  'structure-modeling-contracts',
  'semantic-visual-referee-contracts',
  'design-reference-contracts',
  'refpack-selection-contracts',
  'refpack-outcome-scoring',
  'prompt-artifact-compiler',
  'prompt-readiness-gate',
  'prompt-production-contracts',
  'production-plan-consistency-contracts',
  'generation-contracts',
  'submission-description-contracts',
  'live-submit-rules-contracts',
  'live-submit-result-contracts',
  'acceptance-lifecycle-contracts',
  'route-contracts',
  'semantic-visual-model-policy',
  'next-action-advisor',
  'design-reference-adapter',
  'llm-design-reference-resolver',
  'buyer-asset-package',
  'provider-quality-ledger-contracts',
  'plan-only',
  'migration-shims',
  'policy-profiles',
  'execution-gates',
  'approval-packets',
  'state-machine',
  'action-manifest',
  'external-action-lifecycle',
  'external-action-lifecycle-schema',
  'read-only-report-chain',
  'report-freshness',
  'adapter-runner-sdk',
  'adapter-receipt',
  'channel-state-proof',
  'external-action-ledger',
]);

export const CORE_COMPATIBILITY_MODULES = Object.freeze([]);

export const CORE_EXPORTED_MODULES = Object.freeze([
  ...CORE_PUBLIC_MODULES,
  ...CORE_COMPATIBILITY_MODULES,
]);

export function publicApiSummary() {
  return {
    version: CORE_PUBLIC_API_VERSION,
    modules: [...CORE_PUBLIC_MODULES],
    moduleCount: CORE_PUBLIC_MODULES.length,
    compatibilityModules: [...CORE_COMPATIBILITY_MODULES],
    compatibilityModuleCount: CORE_COMPATIBILITY_MODULES.length,
    exportedModules: [...CORE_EXPORTED_MODULES],
    exportedModuleCount: CORE_EXPORTED_MODULES.length,
    stability: {
      stableModules: [...CORE_PUBLIC_MODULES],
      compatibilityModules: [...CORE_COMPATIBILITY_MODULES],
      compatibilityExportsAreLegacy: true,
      compatibilityExportsRetired: CORE_COMPATIBILITY_MODULES.length === 0,
      zeroCompatibilityInvariant: CORE_COMPATIBILITY_MODULES.length === 0,
      recommendedImportSurface: 'CORE_PUBLIC_MODULES',
    },
    safety: {
      publicApiOnly: true,
      executesExternalAction: false,
      uploads: false,
      submits: false,
      sendsMessages: false,
      acceptsDelivery: false,
      pays: false,
      deploys: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
    },
  };
}

export * from './contracts.mjs';
export * from './contract-schema.mjs';
export * from './compatibility-export-policy.mjs';
export * from './integration-gate-tooling.mjs';
export * from './channel-import-allowlist.mjs';
export * from './package-root-resolver.mjs';
export * from './package-root-import-migration.mjs';
export * from './hash-utils.mjs';
export * from './adapters/index.mjs';
export * from './channel-adapter-interface.mjs';
export * from './product-router.mjs';
export * from './workflow-registry.mjs';
export * from './workflow-production-contracts.mjs';
export * from './human-feedback-contracts.mjs';
export * from './human-feedback-loop-contracts.mjs';
export * from './human-feedback-evidence-contracts.mjs';
export * from './opportunity-lifecycle-contracts.mjs';
export * from './business-priority-contracts.mjs';
export * from './case-ledger-contracts.mjs';
export * from './semantic-intake-contracts.mjs';
export * from './industry-taxonomy-contracts.mjs';
export * from './production-planner-gate-contracts.mjs';
export * from './production-execution-invariant-contracts.mjs';
export * from './pre-generation-readiness-contracts.mjs';
export * from './package-quality-lifecycle-contracts.mjs';
export * from './structured-qa-blocker-contracts.mjs';
export * from './semantic-reviewer-calibration-contracts.mjs';
export * from './generation-repair-route-contracts.mjs';
export * from './submit-ready-lifecycle-contracts.mjs';
export * from './submit-ready-cleanup-contracts.mjs';
export * from './feedback-ingest-contracts.mjs';
export * from './feedback-learning-bridge-contracts.mjs';
export * from './submit-ready-action-projection-contracts.mjs';
export * from './today-operational-projection-contracts.mjs';
export * from './provider-experiment-contracts.mjs';
export * from './spend-guard-contracts.mjs';
export * from './acceptance-followup-projection-contracts.mjs';
export * from './structure-modeling-contracts.mjs';
export * from './semantic-visual-referee-contracts.mjs';
export * from './design-reference-contracts.mjs';
export * from './refpack-selection-contracts.mjs';
export * from './refpack-outcome-scoring.mjs';
export * from './prompt-artifact-compiler.mjs';
export * from './prompt-readiness-gate.mjs';
export * from './prompt-production-contracts.mjs';
export * from './production-plan-consistency-contracts.mjs';
export * from './generation-contracts.mjs';
export * from './submission-description-contracts.mjs';
export * from './live-submit-rules-contracts.mjs';
export * from './live-submit-result-contracts.mjs';
export * from './acceptance-lifecycle-contracts.mjs';
export * from './route-contracts.mjs';
export * from './semantic-visual-model-policy.mjs';
export * from './next-action-advisor.mjs';
export * from './design-reference-adapter.mjs';
export * from './llm-design-reference-resolver.mjs';
export * from './buyer-asset-package.mjs';
export * from './provider-quality-ledger-contracts.mjs';
export * from './plan-only.mjs';
export * from './migration-shims.mjs';
export * from './policy-profiles.mjs';
export * from './execution-gates.mjs';
export * from './approval-packets.mjs';
export * from './state-machine.mjs';
export * from './action-manifest.mjs';
export * from './external-action-lifecycle.mjs';
export * from './external-action-lifecycle-schema.mjs';
export * from './read-only-report-chain.mjs';
export * from './report-freshness.mjs';
export * from './adapter-runner-sdk.mjs';
export * from './adapter-receipt.mjs';
export * from './channel-state-proof.mjs';
export * from './external-action-ledger.mjs';
