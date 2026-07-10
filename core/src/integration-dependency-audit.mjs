import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './hash-utils.mjs';
import { writeLatestReportPair } from './report-output-writer.mjs';
import {
  EXTERNAL_ACTION_LIFECYCLE_PHASES,
  buildExternalActionLifecycleSchema,
  validateExternalActionLifecycleChain,
} from './external-action-lifecycle-schema.mjs';
import {
  INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS,
  INTEGRATION_GATE_TOOLING_PACKAGE_EXPORTS,
  summarizePackageExportSurface,
} from './integration-gate-tooling.mjs';
import {
  CHANNEL_IMPORT_ALLOWLIST_STABLE_MODULE_ID,
  buildChannelImportAllowlist,
} from './channel-import-allowlist.mjs';
import {
  PACKAGE_ROOT_RESOLVER_STABLE_MODULE_ID,
  buildPackageRootResolverReport,
} from './package-root-resolver.mjs';
import {
  REPORT_FRESHNESS_GATE_REPORT,
  REPORT_FRESHNESS_REQUIRED_REPORTS,
  REPORT_FRESHNESS_STABLE_MODULE_ID,
  buildReportFreshnessReport,
} from './report-freshness.mjs';
import { reportHashForFileId } from './export-report-freshness.mjs';
import {
  buildReportFreshnessRegressionReport,
} from './report-freshness-regression.mjs';
import {
  buildIntegrationGateSequenceRegressionReport,
} from './integration-gate-sequence-regression.mjs';
import {
  buildReportInventoryConsistencyReport,
} from './report-inventory-consistency.mjs';
import {
  buildReportSchemaContractReport,
  expectedReportSchemaContractFileIds,
} from './report-schema-contract.mjs';
import {
  buildReportLineageTopologyReport,
} from './report-lineage-topology.mjs';
import {
  REPORT_HASH_STABILITY_REGRESSION_REPORT_FILE_ID,
  buildReportHashStabilityRegressionReport,
} from './report-hash-stability-regression.mjs';
import {
  REPORT_OUTPUT_PAIRING_REPORT_FILE_ID,
  buildReportOutputPairingReport,
} from './report-output-pairing.mjs';
import {
  REPORT_ARTIFACT_REPRODUCIBILITY_REPORT_FILE_ID,
  buildReportArtifactReproducibilityReport,
} from './report-artifact-reproducibility.mjs';
import {
  buildReportSelfReferenceBoundaryRegressionReport,
} from './report-self-reference-boundary-regression.mjs';
import {
  buildReportContractManifestReport,
} from './report-contract-manifest.mjs';
import {
  buildReportContractRequiredCoverageRegressionReport,
} from './report-contract-required-coverage-regression.mjs';
import {
  buildReportContractDocCoverageRegressionReport,
} from './report-contract-doc-coverage-regression.mjs';
import {
  buildReportContractSyntaxCoverageRegressionReport,
} from './report-contract-syntax-coverage-regression.mjs';
import {
  buildReportContractSourceDerivationRegressionReport,
} from './report-contract-source-derivation-regression.mjs';
import {
  buildReportContractSummaryKeyRegressionReport,
} from './report-contract-summary-key-regression.mjs';
import {
  buildReportContractAuditForwardingRegressionReport,
} from './report-contract-audit-forwarding-regression.mjs';
import {
  buildReportContractCheckpointBindingShapeRegressionReport,
} from './report-contract-checkpoint-binding-shape-regression.mjs';
import {
  buildReportContractGateSummaryShapeRegressionReport,
} from './report-contract-gate-summary-shape-regression.mjs';
import {
  buildReportContractExporterStdoutShapeRegressionReport,
} from './report-contract-exporter-stdout-shape-regression.mjs';
import {
  buildReportContractSafetyFlagRegressionReport,
} from './report-contract-safety-flag-regression.mjs';
import {
  buildReportContractArtifactBindingRegressionReport,
} from './report-contract-artifact-binding-regression.mjs';
import {
  buildReportContractDocIndexAnchorRegressionReport,
} from './report-contract-doc-index-anchor-regression.mjs';
import {
  buildReportContractDocPageLatestDetailRegressionReport,
} from './report-contract-doc-page-latest-detail-regression.mjs';
import {
  buildReportContractDocPageCommandSectionRegressionReport,
} from './report-contract-doc-page-command-section-regression.mjs';
import {
  buildReportContractDocPageSafetySectionDetailRegressionReport,
} from './report-contract-doc-page-safety-section-detail-regression.mjs';
import {
  buildReportContractDocPageStrictGateSectionRegressionReport,
} from './report-contract-doc-page-strict-gate-section-regression.mjs';
import {
  buildReportContractDocPageOutputSectionRegressionReport,
} from './report-contract-doc-page-output-section-regression.mjs';
import {
  buildReportContractDocPageCrossReportSectionRegressionReport,
} from './report-contract-doc-page-cross-report-section-regression.mjs';
import {
  buildReportContractDocPageCloseoutSectionRegressionReport,
} from './report-contract-doc-page-closeout-section-regression.mjs';
import {
  buildReportContractDocPagePostGateWriterSectionRegressionReport,
} from './report-contract-doc-page-post-gate-writer-section-regression.mjs';
import {
  buildReportContractDocPageRetentionSectionRegressionReport,
} from './report-contract-doc-page-retention-section-regression.mjs';
import {
  buildReportContractDocPageFreshnessHashSectionRegressionReport,
} from './report-contract-doc-page-freshness-hash-section-regression.mjs';
import {
  buildReportContractDocPageCheckpointHashSectionRegressionReport,
} from './report-contract-doc-page-checkpoint-hash-section-regression.mjs';
import {
  buildReportContractDocPageBootstrapSeedSectionRegressionReport,
} from './report-contract-doc-page-bootstrap-seed-section-regression.mjs';
import {
  buildReportContractDocPageCleanRerunSectionRegressionReport,
} from './report-contract-doc-page-clean-rerun-section-regression.mjs';
import {
  buildReportContractDocPageFinalSettlementSectionRegressionReport,
} from './report-contract-doc-page-final-settlement-section-regression.mjs';
import {
  buildReportContractDocPageCloseoutIndexSectionRegressionReport,
} from './report-contract-doc-page-closeout-index-section-regression.mjs';
import {
  buildReportContractDocPageCloseoutEvidenceSectionRegressionReport,
} from './report-contract-doc-page-closeout-evidence-section-regression.mjs';
import {
  buildReportContractDocPageCloseoutLedgerSectionRegressionReport,
} from './report-contract-doc-page-closeout-ledger-section-regression.mjs';
import {
  buildReportContractDocPageCloseoutRetentionProofSectionRegressionReport,
} from './report-contract-doc-page-closeout-retention-proof-section-regression.mjs';
import {
  buildReportContractDocPageCloseoutProbeBundleSectionRegressionReport,
} from './report-contract-doc-page-closeout-probe-bundle-section-regression.mjs';
import {
  buildReportContractDocPageCloseoutSignoffSectionRegressionReport,
} from './report-contract-doc-page-closeout-signoff-section-regression.mjs';
import {
  buildReportContractDocPageCloseoutReleaseManifestSectionRegressionReport,
} from './report-contract-doc-page-closeout-release-manifest-section-regression.mjs';
import {
  buildReportContractDocPageReleaseArchiveIndexSectionRegressionReport,
} from './report-contract-doc-page-release-archive-index-section-regression.mjs';
import {
  buildReportContractDocPageReleaseHandoffLedgerSectionRegressionReport,
} from './report-contract-doc-page-release-handoff-ledger-section-regression.mjs';
import {
  buildReportContractDocPageReleaseDeliveryReadinessSectionRegressionReport,
} from './report-contract-doc-page-release-delivery-readiness-section-regression.mjs';
import {
  buildReportContractDocPageReleaseExecutionDenialSectionRegressionReport,
} from './report-contract-doc-page-release-execution-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleaseOperatorApprovalSectionRegressionReport,
} from './report-contract-doc-page-release-operator-approval-section-regression.mjs';
import {
  buildReportContractDocPageReleaseApprovalLedgerSectionRegressionReport,
} from './report-contract-doc-page-release-approval-ledger-section-regression.mjs';
import {
  buildReportContractDocPageReleaseActionQueueSectionRegressionReport,
} from './report-contract-doc-page-release-action-queue-section-regression.mjs';
import {
  buildReportContractDocPageReleaseRunnerDispatchDenialSectionRegressionReport,
} from './report-contract-doc-page-release-runner-dispatch-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleaseLiveActionPreflightSectionRegressionReport,
} from './report-contract-doc-page-release-live-action-preflight-section-regression.mjs';
import {
  buildReportContractDocPageReleaseExecutionIntentCaptureSectionRegressionReport,
} from './report-contract-doc-page-release-execution-intent-capture-section-regression.mjs';
import {
  buildReportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionReport,
} from './report-contract-doc-page-release-execution-approval-boundary-section-regression.mjs';
import {
  buildReportContractDocPageReleaseRunnerExecutionGateSectionRegressionReport,
} from './report-contract-doc-page-release-runner-execution-gate-section-regression.mjs';
import {
  buildReportContractDocPageReleaseDispatchImplementationDenialSectionRegressionReport,
} from './report-contract-doc-page-release-dispatch-implementation-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionReport,
} from './report-contract-doc-page-release-platform-state-snapshot-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleaseDryRunReplayDenialSectionRegressionReport,
} from './report-contract-doc-page-release-dry-run-replay-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleaseProofBundleDenialSectionRegressionReport,
} from './report-contract-doc-page-release-proof-bundle-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleaseLedgerDenialSectionRegressionReport,
} from './report-contract-doc-page-release-ledger-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleaseAuditEvidenceDenialSectionRegressionReport,
} from './report-contract-doc-page-release-audit-evidence-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionReport,
} from './report-contract-doc-page-release-receipt-evidence-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleasePostActionReceiptDenialSectionRegressionReport,
} from './report-contract-doc-page-release-post-action-receipt-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleasePostActionAuditDenialSectionRegressionReport,
} from './report-contract-doc-page-release-post-action-audit-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleasePostActionReconciliationDenialSectionRegressionReport,
} from './report-contract-doc-page-release-post-action-reconciliation-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleasePostActionSettlementDenialSectionRegressionReport,
} from './report-contract-doc-page-release-post-action-settlement-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionReport,
} from './report-contract-doc-page-release-post-action-acceptance-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleasePostActionPaymentDenialSectionRegressionReport,
} from './report-contract-doc-page-release-post-action-payment-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleasePostActionDeploymentDenialSectionRegressionReport,
} from './report-contract-doc-page-release-post-action-deployment-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionReport,
} from './report-contract-doc-page-release-post-action-provider-spend-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionReport,
} from './report-contract-doc-page-release-post-action-state-transition-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionReport,
} from './report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionReport,
} from './report-contract-doc-page-release-post-action-background-runner-denial-section-regression.mjs';
import {
  buildReportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionReport,
} from './report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression.mjs';
import {
  buildReportManifestDriftRegressionReport,
} from './report-manifest-drift-regression.mjs';
import {
  buildReportLatestRecoveryRegressionReport,
} from './report-latest-recovery-regression.mjs';
import {
  buildReportBootstrapSeedRegressionReport,
} from './report-bootstrap-seed-regression.mjs';
import {
  buildReportGateCleanRerunRegressionReport,
} from './report-gate-clean-rerun-regression.mjs';
import {
  buildReportCleanGateIdempotenceRegressionReport,
} from './report-clean-gate-idempotence-regression.mjs';
import {
  buildReportFinalSettlementRegressionReport,
} from './report-final-settlement-regression.mjs';
import {
  buildReportPostFinalDriftRegressionReport,
} from './report-post-final-drift-regression.mjs';
import {
  buildReportCloseoutDriftClassificationRegressionReport,
} from './report-closeout-drift-classification-regression.mjs';
import {
  buildReportCloseoutCommandInventoryRegressionReport,
} from './report-closeout-command-inventory-regression.mjs';
import {
  REPORT_RUNNER_CONTRACTS,
  buildReportRunnerContractRegressionReport,
} from './report-runner-contract-regression.mjs';
import {
  buildReportRetentionRegressionReport,
} from './report-retention-regression.mjs';
import {
  PACKAGE_ROOT_IMPORT_MIGRATION_STABLE_MODULE_ID,
  buildPackageRootImportMigrationPlan,
} from './package-root-import-migration.mjs';
import {
  buildPackageRootImportRegressionReport,
} from './package-root-import-regression.mjs';
import {
  buildPackageRootSymbolManifestReport,
} from './package-root-symbol-manifest.mjs';
import {
  buildPackageRootSymbolRegressionReport,
} from './package-root-symbol-regression.mjs';
import {
  buildPackageRootSymbolMinimizationReport,
} from './package-root-symbol-minimization.mjs';

export const INTEGRATION_DEPENDENCY_AUDIT_VERSION = 46;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = path.resolve(packageRoot, '..');
const reportsDir = path.join(packageRoot, 'reports');

const CHANNELS = Object.freeze([
  {
    channelId: 'zbj',
    label: 'ZBJ',
    roots: ['zbj-auto-intake'],
    runtimeRoots: ['src', 'scripts', 'package.json'],
    expectedSurfaces: [
      'channel_normalization',
      'plan_only_product_routing',
      'design_reference_runtime',
      'artifact_review_contract',
      'external_action_control',
      'runner_handoff_receipt_proof',
    ],
  },
  {
    channelId: 'epwk',
    label: 'EPWK',
    roots: ['epwk-auto-intake'],
    runtimeRoots: ['src', 'scripts', 'package.json'],
    expectedSurfaces: [
      'channel_normalization',
      'plan_only_product_routing',
      'design_reference_runtime',
      'buyer_asset_package',
      'artifact_review_contract',
      'external_action_control',
      'runner_handoff_receipt_proof',
    ],
  },
  {
    channelId: 'hepta',
    label: 'Hepta',
    roots: ['skills/hepta_design', 'work/hepta-brand-kit', '.cache/hepta_design', 'tmp-hepta-review'],
    runtimeRoots: ['src', 'scripts', 'package.json', 'SKILL.md'],
    expectedSurfaces: [
      'channel_normalization',
      'plan_only_product_routing',
      'design_reference_runtime',
      'buyer_asset_package',
      'artifact_review_contract',
      'delivery_deployment_control',
    ],
  },
]);

const SURFACE_RULES = Object.freeze({
  channel_normalization: ['contracts.mjs', 'adapters/', 'channel-adapter-interface.mjs', 'migration-shims.mjs'],
  plan_only_product_routing: ['plan-only.mjs', 'product-router.mjs', 'workflow-registry.mjs', 'workflow-production-contracts.mjs', 'migration-shims.mjs', 'route-contracts.mjs', 'production-plan-consistency-contracts.mjs'],
  design_reference_runtime: ['llm-design-reference-resolver', 'design-reference', 'reference-package', 'refpack', 'designReferenceSpec'],
  buyer_asset_package: ['buyer-asset', 'source-asset', 'attachment-package'],
  artifact_review_contract: ['contracts.mjs', 'workflow-registry.mjs'],
  external_action_control: ['policy-profiles.mjs', 'semantic-visual-model-policy.mjs', 'execution-gates.mjs', 'approval-packets.mjs', 'state-machine.mjs', 'action-manifest.mjs'],
  runner_handoff_receipt_proof: [
    'external-action-lifecycle.mjs',
    'adapter-runner-sdk.mjs',
    'adapter-receipt.mjs',
    'channel-state-proof.mjs',
    'external-action-ledger.mjs',
    'adapter-handoff-outbox.mjs',
    'adapter-dispatch',
  ],
  delivery_deployment_control: ['external-action-lifecycle.mjs', 'adapter-runner-sdk.mjs', 'channel-state-proof.mjs', 'external-action-ledger.mjs'],
});

const PACKAGE_ROOT_SYMBOL_MODULE_HINTS = Object.freeze({
  ADAPTER_RESULT_STATUS: 'external-action-lifecycle.mjs',
  ACCEPTANCE_LIFECYCLE_BUCKETS: 'acceptance-lifecycle-contracts.mjs',
  ACCEPTANCE_LIFECYCLE_CONTRACT_VERSION: 'acceptance-lifecycle-contracts.mjs',
  ACCEPTANCE_LIFECYCLE_STATUS: 'acceptance-lifecycle-contracts.mjs',
  BUSINESS_PRIORITY_SCORE_VERSION: 'business-priority-contracts.mjs',
  BUYER_ASSET_ROLES: 'buyer-asset-package.mjs',
  CASE_LEDGER_VERSION: 'case-ledger-contracts.mjs',
  CHANNEL_IDS: 'contracts.mjs',
  CORE_MODEL_INDUSTRY_IDS: 'llm-design-reference-resolver.mjs',
  CORE_STAGES: 'contracts.mjs',
  HUMAN_FEEDBACK_EVIDENCE_CONTRACT_VERSION: 'human-feedback-evidence-contracts.mjs',
  HUMAN_FEEDBACK_EVIDENCE_SOURCE_TYPES: 'human-feedback-evidence-contracts.mjs',
  HUMAN_FEEDBACK_EVIDENCE_STATUS: 'human-feedback-evidence-contracts.mjs',
  HUMAN_FEEDBACK_LOOP_SAFETY: 'human-feedback-loop-contracts.mjs',
  HUMAN_FEEDBACK_LOOP_STATES: 'human-feedback-loop-contracts.mjs',
  HUMAN_FEEDBACK_LOOP_VERSION: 'human-feedback-loop-contracts.mjs',
  HUMAN_FEEDBACK_ROUNDS_DIR: 'human-feedback-loop-contracts.mjs',
  HUMAN_FEEDBACK_SATISFACTION_STATES: 'human-feedback-loop-contracts.mjs',
  HUMAN_FEEDBACK_SESSION_ARCHIVE_DIR: 'human-feedback-loop-contracts.mjs',
  HUMAN_FEEDBACK_SESSION_FILENAME: 'human-feedback-loop-contracts.mjs',
  DEFAULT_REFPACK_OUTCOME_WORKFLOWS: 'refpack-outcome-scoring.mjs',
  EXECUTION_GATE_DECISIONS: 'execution-gates.mjs',
  EXECUTION_POLICIES: 'execution-gates.mjs',
  EXTERNAL_ACTIONS: 'contracts.mjs',
  GENERATION_CONTRACT_VERSION: 'generation-contracts.mjs',
  GENERATION_STATUS: 'generation-contracts.mjs',
  LIVE_SUBMIT_BLOCKER_TYPES: 'live-submit-result-contracts.mjs',
  LIVE_SUBMIT_RULES_CONTRACT_VERSION: 'live-submit-rules-contracts.mjs',
  LIVE_SUBMIT_RULES_SAFETY: 'live-submit-rules-contracts.mjs',
  LIVE_SUBMIT_RESULT_CONTRACT_VERSION: 'live-submit-result-contracts.mjs',
  LIVE_SUBMIT_RESULT_STATUS: 'live-submit-result-contracts.mjs',
  PACKAGE_QUALITY_LIFECYCLE_SAFETY: 'package-quality-lifecycle-contracts.mjs',
  PACKAGE_QUALITY_LIFECYCLE_VERSION: 'package-quality-lifecycle-contracts.mjs',
  OPPORTUNITY_LIFECYCLE_BUCKETS: 'opportunity-lifecycle-contracts.mjs',
  OPPORTUNITY_LIFECYCLE_CONTRACT_VERSION: 'opportunity-lifecycle-contracts.mjs',
  OPPORTUNITY_LIFECYCLE_STATUS: 'opportunity-lifecycle-contracts.mjs',
  NEXT_ACTION_ADVISOR_PROVIDER_LOCAL: 'next-action-advisor.mjs',
  NEXT_ACTION_ADVISOR_VERSION: 'next-action-advisor.mjs',
  OUTPUT_MODES: 'contracts.mjs',
  POLICY_PROFILE_VERSION: 'policy-profiles.mjs',
  POLICY_PROFILES: 'policy-profiles.mjs',
  PRE_GENERATION_BLOCKERS: 'pre-generation-readiness-contracts.mjs',
  PRE_GENERATION_READINESS_SAFETY: 'pre-generation-readiness-contracts.mjs',
  PRE_GENERATION_READINESS_VERSION: 'pre-generation-readiness-contracts.mjs',
  PROVIDER_QUALITY_VERSION: 'provider-quality-ledger-contracts.mjs',
  FEEDBACK_INGEST_CONTRACT_VERSION: 'feedback-ingest-contracts.mjs',
  FEEDBACK_INGEST_LEDGER_OUTCOMES: 'feedback-ingest-contracts.mjs',
  FEEDBACK_INGEST_SAFETY: 'feedback-ingest-contracts.mjs',
  PRODUCTION_PLAN_CONSISTENCY_CONTRACT_VERSION: 'production-plan-consistency-contracts.mjs',
  PRODUCTION_PLAN_CONSISTENCY_STATUS: 'production-plan-consistency-contracts.mjs',
  PRODUCT_LINE_IDS: 'contracts.mjs',
  QUALITY_REVIEW_DECISIONS: 'package-quality-lifecycle-contracts.mjs',
  QA_DECISION: 'generation-contracts.mjs',
  QA_BLOCKER_SCHEMA_VERSION: 'structured-qa-blocker-contracts.mjs',
  REFPACK_OUTCOME_SCORE_VERSION: 'refpack-outcome-scoring.mjs',
  REFPACK_SELECTION_CONTRACT_VERSION: 'refpack-selection-contracts.mjs',
  REFPACK_SELECTION_SAFETY: 'refpack-selection-contracts.mjs',
  ROUTE_CONTRACT_SAFETY: 'route-contracts.mjs',
  ROUTE_CONTRACT_VERSION: 'route-contracts.mjs',
  SEMANTIC_REVIEWER_CALIBRATION_SAFETY: 'semantic-reviewer-calibration-contracts.mjs',
  SEMANTIC_REVIEWER_CALIBRATION_VERSION: 'semantic-reviewer-calibration-contracts.mjs',
  DEFAULT_SEMANTIC_VISUAL_MODEL_MINIMUM: 'semantic-visual-model-policy.mjs',
  DISALLOWED_SEMANTIC_VISUAL_MODEL_RE: 'semantic-visual-model-policy.mjs',
  DISALLOWED_SEMANTIC_VISUAL_MODEL_TIER_RE: 'semantic-visual-model-policy.mjs',
  SEMANTIC_VISUAL_MODEL_POLICY_SAFETY: 'semantic-visual-model-policy.mjs',
  SEMANTIC_VISUAL_MODEL_POLICY_VERSION: 'semantic-visual-model-policy.mjs',
  STANDARD_SUBMISSION_NOTE: 'submission-description-contracts.mjs',
  STANDARD_SUBMISSION_NOTE_MAX_CHARS: 'submission-description-contracts.mjs',
  SUBMISSION_DESCRIPTION_CONTRACT_VERSION: 'submission-description-contracts.mjs',
  SUBMISSION_DESCRIPTION_FIELD_KINDS: 'submission-description-contracts.mjs',
  SUBMIT_READY_CLEANUP_ARTIFACT_EXTS: 'submit-ready-cleanup-contracts.mjs',
  SUBMIT_READY_CLEANUP_CONTRACT_VERSION: 'submit-ready-cleanup-contracts.mjs',
  SUBMIT_READY_CLEANUP_SAFETY: 'submit-ready-cleanup-contracts.mjs',
  SUBMIT_READY_LIFECYCLE_SAFETY: 'submit-ready-lifecycle-contracts.mjs',
  SUBMIT_READY_LIFECYCLE_VERSION: 'submit-ready-lifecycle-contracts.mjs',
  STRUCTURED_QA_BLOCKER_SAFETY: 'structured-qa-blocker-contracts.mjs',
  WORKFLOW_PRODUCTION_CONTRACT_VERSION: 'workflow-production-contracts.mjs',
  acceptanceLifecycleRecommendation: 'acceptance-lifecycle-contracts.mjs',
  adaptBuyerAssetAttachmentSpecForGeneration: 'buyer-asset-package.mjs',
  alreadySubmittedSignals: 'submit-ready-lifecycle-contracts.mjs',
  applyCaseLedgerEntryToLedger: 'case-ledger-contracts.mjs',
  applyPreGenerationReadiness: 'pre-generation-readiness-contracts.mjs',
  applyProviderQualityEventToLedger: 'provider-quality-ledger-contracts.mjs',
  appendRoundToSession: 'human-feedback-loop-contracts.mjs',
  applyLiveSubmitRulesToPlan: 'live-submit-rules-contracts.mjs',
  applyPromptReadinessGateToPlan: 'prompt-readiness-gate.mjs',
  applyRouteContractToPlan: 'route-contracts.mjs',
  approvalPacketBodyHash: 'approval-packets.mjs',
  approvalPolicyActionMatchesApprovalPacket: 'approval-packets.mjs',
  approvalPolicyActionMatchesEvidenceStage: 'approval-packets.mjs',
  approvalPolicyApprovedCommandIntegrityIssues: 'approval-packets.mjs',
  approvalPolicyCustomerMessageApprovalIssues: 'approval-packets.mjs',
  approvalPolicyCustomerMessageEvidenceIssues: 'approval-packets.mjs',
  approvalPolicyExpectedApprovedCommand: 'approval-packets.mjs',
  approvalPolicyMaterializeApprovedCommand: 'approval-packets.mjs',
  approvalPolicyNormalizeAction: 'approval-packets.mjs',
  approvalPolicyNormalizeEvidenceStage: 'approval-packets.mjs',
  approvalPolicyState: 'approval-packets.mjs',
  buildFreshEvidenceHandshakeCommands: 'approval-packets.mjs',
  buildFreshEvidenceHandshakePlan: 'approval-packets.mjs',
  buildFreshEvidenceHandshakeResult: 'approval-packets.mjs',
  buildApprovalPacket: 'approval-packets.mjs',
  FRESH_EVIDENCE_HANDSHAKE_SAFETY: 'approval-packets.mjs',
  FRESH_EVIDENCE_HANDSHAKE_VERSION: 'approval-packets.mjs',
  freshEvidenceHandshakeRequested: 'approval-packets.mjs',
  freshEvidenceHandshakeSelftest: 'approval-packets.mjs',
  assertPolicyAllowed: 'policy-profiles.mjs',
  assertStandardSubmissionNote: 'submission-description-contracts.mjs',
  buildBuyerAssetPackage: 'buyer-asset-package.mjs',
  buildChannelActionManifest: 'action-manifest.mjs',
  buildDesignReferenceSpec: 'design-reference-contracts.mjs',
  buildFeedbackLedgerCandidate: 'feedback-ingest-contracts.mjs',
  buildGenerationRevisionPrompt: 'generation-repair-route-contracts.mjs',
  humanFeedbackEvidenceRecommendation: 'human-feedback-evidence-contracts.mjs',
  humanFeedbackLoopSelftest: 'human-feedback-loop-contracts.mjs',
  buildEpwkPlanOnlyMigration: 'migration-shims.mjs',
  buildExecutionGateRequest: 'execution-gates.mjs',
  buildHeptaPlanOnlyMigration: 'migration-shims.mjs',
  buildDisabledDesignReferenceRetrieval: 'llm-design-reference-resolver.mjs',
  buildPromptCompilerReport: 'prompt-artifact-compiler.mjs',
  buildModelLockedDesignReferenceRetrieval: 'llm-design-reference-resolver.mjs',
  buildPromptProductionContract: 'prompt-production-contracts.mjs',
  buildPromptProductionContractFixture: 'prompt-production-contracts.mjs',
  buildPromptReadinessReport: 'prompt-readiness-gate.mjs',
  buildStructuredQaBlockers: 'structured-qa-blocker-contracts.mjs',
  buildRefpackRetrievalContract: 'refpack-selection-contracts.mjs',
  buildRefpackOutcomeScoreReport: 'refpack-outcome-scoring.mjs',
  buildRouteContract: 'route-contracts.mjs',
  buildSubmitReadyLedgerEntry: 'submit-ready-lifecycle-contracts.mjs',
  buildLocalNextActionAdvice: 'next-action-advisor.mjs',
  buildNextActionAdvisorContext: 'next-action-advisor.mjs',
  buildNextActionAdvisorPrompt: 'next-action-advisor.mjs',
  buildNextActionCommandBank: 'next-action-advisor.mjs',
  buildZbjPlanOnlyMigration: 'migration-shims.mjs',
  businessPriorityScoreSelftest: 'business-priority-contracts.mjs',
  caseLedgerGuidanceFor: 'case-ledger-contracts.mjs',
  classifyGenerationPackageFailureRoute: 'generation-repair-route-contracts.mjs',
  classifyOpportunityProductLine: 'opportunity-lifecycle-contracts.mjs',
  classifySatisfactionSignal: 'human-feedback-loop-contracts.mjs',
  classifySubmitReadyCleanupPath: 'submit-ready-cleanup-contracts.mjs',
  compactGenerationRepairText: 'generation-repair-route-contracts.mjs',
  canonicalProductLineId: 'contracts.mjs',
  compilePromptArtifact: 'prompt-artifact-compiler.mjs',
  computeAdapterRunReceiptHash: 'adapter-receipt.mjs',
  computeChannelStateProofHash: 'channel-state-proof.mjs',
  convertLegacyDesignReferenceSpecToCore: 'design-reference-adapter.mjs',
  createArtifactRequest: 'generation-contracts.mjs',
  createPreGenerationReadiness: 'pre-generation-readiness-contracts.mjs',
  createImageGenerationProviderPolicy: 'generation-contracts.mjs',
  createArtifactPackage: 'contracts.mjs',
  createChannelTask: 'contracts.mjs',
  createCreativeBrief: 'contracts.mjs',
  createHumanFeedbackLegacyStageRevisionContract: 'human-feedback-contracts.mjs',
  createHumanFeedbackRound: 'human-feedback-loop-contracts.mjs',
  createHumanFeedbackSession: 'human-feedback-loop-contracts.mjs',
  createGenerationJob: 'generation-contracts.mjs',
  createSatisfactionSignal: 'human-feedback-loop-contracts.mjs',
  createWorkflowArtifactPolicy: 'workflow-production-contracts.mjs',
  createWorkflowDefaultDriftGuards: 'workflow-production-contracts.mjs',
  createWorkflowDeliverableSpec: 'workflow-production-contracts.mjs',
  createWorkflowDriftGuard: 'workflow-production-contracts.mjs',
  createWorkflowQaContract: 'workflow-production-contracts.mjs',
  createWorkflowQualityGate: 'workflow-production-contracts.mjs',
  createSubmissionDescriptionContract: 'submission-description-contracts.mjs',
  createProductionPlanEnvelope: 'contracts.mjs',
  createPromptReadinessGate: 'prompt-readiness-gate.mjs',
  createPromptSetStrategyGate: 'prompt-readiness-gate.mjs',
  createQaRecord: 'generation-contracts.mjs',
  createReviewReport: 'contracts.mjs',
  currentSubmitReadyItems: 'submit-ready-lifecycle-contracts.mjs',
  currentSubmitReadyNames: 'submit-ready-lifecycle-contracts.mjs',
  currentSubmitReadyPaths: 'submit-ready-lifecycle-contracts.mjs',
  decisionFromSemanticReviewerReport: 'semantic-reviewer-calibration-contracts.mjs',
  defaultSemanticReviewerCalibrationSet: 'semantic-reviewer-calibration-contracts.mjs',
  deadlineHoursFromJob: 'business-priority-contracts.mjs',
  deriveLiveSubmitRules: 'live-submit-rules-contracts.mjs',
  decisionFromQualityChecks: 'package-quality-lifecycle-contracts.mjs',
  digest: 'hash-utils.mjs',
  emptyCaseLedger: 'case-ledger-contracts.mjs',
  emptyProviderQualityLedger: 'provider-quality-ledger-contracts.mjs',
  evidenceBundleBodyHash: 'approval-packets.mjs',
  evaluateExecutionGate: 'execution-gates.mjs',
  evaluateTenImageRepairStopPolicy: 'package-quality-lifecycle-contracts.mjs',
  extractFeedbackPatterns: 'feedback-ingest-contracts.mjs',
  feedbackIngestContractsSelftest: 'feedback-ingest-contracts.mjs',
  feedbackIngestReportHash: 'feedback-ingest-contracts.mjs',
  feedbackIngestScanMarkdown: 'feedback-ingest-contracts.mjs',
  feedbackSourceReliability: 'feedback-ingest-contracts.mjs',
  feedbackSourceWeight: 'feedback-ingest-contracts.mjs',
  finalReviewAuditFiles: 'submit-ready-lifecycle-contracts.mjs',
  finalReviewCurrentSync: 'submit-ready-lifecycle-contracts.mjs',
  finalReviewNames: 'submit-ready-lifecycle-contracts.mjs',
  finalReviewPaths: 'submit-ready-lifecycle-contracts.mjs',
  flowJobForTask: 'submit-ready-lifecycle-contracts.mjs',
  gateSemanticReviewerCalibrationReports: 'semantic-reviewer-calibration-contracts.mjs',
  generationFeedbackLinesFromResponse: 'generation-repair-route-contracts.mjs',
  generationFinalReviewFeedbackLines: 'generation-repair-route-contracts.mjs',
  generationPackageFeedbackLines: 'generation-repair-route-contracts.mjs',
  generationRevisionFilename: 'generation-repair-route-contracts.mjs',
  attachPromptCompilerToArtifacts: 'prompt-artifact-compiler.mjs',
  generationContractsSelftest: 'generation-contracts.mjs',
  generationJobId: 'generation-contracts.mjs',
  IMAGE_GENERATION_EXECUTION_MODES: 'generation-contracts.mjs',
  IMAGE_GENERATION_PROVIDER_IDS: 'generation-contracts.mjs',
  IMAGE_GENERATION_PROVIDER_POLICY_VERSION: 'generation-contracts.mjs',
  hashHumanFeedbackRevisionContract: 'human-feedback-contracts.mjs',
  hashHumanFeedbackLoop: 'human-feedback-loop-contracts.mjs',
  hashPromptCompiler: 'prompt-artifact-compiler.mjs',
  hashRouteContract: 'route-contracts.mjs',
  industryIdsForSemanticPrompt: 'llm-design-reference-resolver.mjs',
  inferFeedbackOutcome: 'feedback-ingest-contracts.mjs',
  inferProductLineFromWorkflow: 'contracts.mjs',
  isBookCoverPackageText: 'live-submit-rules-contracts.mjs',
  isBookCoverRouteText: 'route-contracts.mjs',
  isStandardSubmissionNote: 'submission-description-contracts.mjs',
  isUnpassedGenerationRepairCheck: 'generation-repair-route-contracts.mjs',
  isUnpassedQualityCheck: 'package-quality-lifecycle-contracts.mjs',
  nextActionAdvisorSelftest: 'next-action-advisor.mjs',
  nextGenerationRevisionNumber: 'generation-repair-route-contracts.mjs',
  liveSubmitRulesContractsSelftest: 'live-submit-rules-contracts.mjs',
  mergeFinalReviewBridgeManifest: 'package-quality-lifecycle-contracts.mjs',
  normalizeAcceptanceLifecycle: 'acceptance-lifecycle-contracts.mjs',
  normalizeCaseLedgerEntry: 'case-ledger-contracts.mjs',
  normalizeHumanFeedbackEvidenceContract: 'human-feedback-evidence-contracts.mjs',
  normalizeLoopState: 'human-feedback-loop-contracts.mjs',
  normalizeLiveRuleText: 'live-submit-rules-contracts.mjs',
  normalizeLiveSubmitRules: 'live-submit-rules-contracts.mjs',
  normalizeLiveSubmitResult: 'live-submit-result-contracts.mjs',
  normalizeOpportunityLifecycle: 'opportunity-lifecycle-contracts.mjs',
  normalizeHumanFeedbackStage: 'human-feedback-contracts.mjs',
  normalizeSatisfactionState: 'human-feedback-loop-contracts.mjs',
  normalizeNextActionProvider: 'next-action-advisor.mjs',
  normalizeNextActionText: 'next-action-advisor.mjs',
  normalizeGenerationRepairDecision: 'generation-repair-route-contracts.mjs',
  normalizeProductionPlanConsistency: 'production-plan-consistency-contracts.mjs',
  normalizeProviderQualityEvent: 'provider-quality-ledger-contracts.mjs',
  normalizedNames: 'submit-ready-lifecycle-contracts.mjs',
  normalizedSubmitReadyNames: 'submit-ready-lifecycle-contracts.mjs',
  normalizeQualityDecision: 'package-quality-lifecycle-contracts.mjs',
  normalizeSemanticReviewerDecision: 'semantic-reviewer-calibration-contracts.mjs',
  normalizeStructuredQaBlocker: 'structured-qa-blocker-contracts.mjs',
  parseNextActionJsonObject: 'next-action-advisor.mjs',
  parseNextActionModelRun: 'next-action-advisor.mjs',
  normalizeRouteContract: 'route-contracts.mjs',
  normalizeSubmissionNoteForCompare: 'submission-description-contracts.mjs',
  parseMoneyAmount: 'business-priority-contracts.mjs',
  opportunityLifecycleRecommendation: 'opportunity-lifecycle-contracts.mjs',
  packageCapacityGap: 'live-submit-rules-contracts.mjs',
  onlySemanticGatePlaceholderBlockers: 'package-quality-lifecycle-contracts.mjs',
  parseAllowedExtensionsFromText: 'live-submit-rules-contracts.mjs',
  parseMaxFileSizeMbFromText: 'live-submit-rules-contracts.mjs',
  parseMaxFilesFromText: 'live-submit-rules-contracts.mjs',
  parseMaxNamingItemsFromText: 'live-submit-rules-contracts.mjs',
  parseMaxSubmissionNoteCharsFromText: 'live-submit-rules-contracts.mjs',
  policyProfile: 'policy-profiles.mjs',
  policyProfilesSelftest: 'policy-profiles.mjs',
  policyViolations: 'policy-profiles.mjs',
  preGenerationReadinessContractsSelftest: 'pre-generation-readiness-contracts.mjs',
  providerQualityScore: 'provider-quality-ledger-contracts.mjs',
  providerOutcomeForFeedbackOutcome: 'feedback-ingest-contracts.mjs',
  productionExecutionInvariantContractsSelftest: 'production-execution-invariant-contracts.mjs',
  promptCompilerReportMarkdown: 'prompt-artifact-compiler.mjs',
  promptReadinessReportMarkdown: 'prompt-readiness-gate.mjs',
  decideRefpackStaticSelection: 'refpack-selection-contracts.mjs',
  normalizeRefpackQuery: 'refpack-selection-contracts.mjs',
  rankRefpackCandidates: 'refpack-selection-contracts.mjs',
  refpackQueryTokenInfo: 'refpack-selection-contracts.mjs',
  refpackOutcomeScoreMarkdown: 'refpack-outcome-scoring.mjs',
  refpackSelectionContractsSelftest: 'refpack-selection-contracts.mjs',
  summarizeRefpackRetrievalResult: 'refpack-selection-contracts.mjs',
  refreshPromptCompilerForPlan: 'prompt-artifact-compiler.mjs',
  routeContractPackageChecks: 'route-contracts.mjs',
  routeContractRoute: 'route-contracts.mjs',
  routeContractSelftest: 'route-contracts.mjs',
  recommendSubmitRoute: 'live-submit-rules-contracts.mjs',
  tokenMatchesRefpackPattern: 'refpack-selection-contracts.mjs',
  resolveSubmitReadyKeepFiles: 'submit-ready-cleanup-contracts.mjs',
  resolveSemanticVisualModel: 'semantic-visual-model-policy.mjs',
  resolveLlmDesignReferenceSpec: 'llm-design-reference-resolver.mjs',
  scoreBusinessPriority: 'business-priority-contracts.mjs',
  scoreSemanticReviewerReport: 'semantic-reviewer-calibration-contracts.mjs',
  scoreOpportunityPriority: 'opportunity-lifecycle-contracts.mjs',
  scoreRefpackOutcome: 'refpack-outcome-scoring.mjs',
  semanticVisualModelBlockerCheck: 'semantic-visual-model-policy.mjs',
  semanticVisualModelPolicySelftest: 'semantic-visual-model-policy.mjs',
  semanticReviewerCalibrationContractsSelftest: 'semantic-reviewer-calibration-contracts.mjs',
  semanticReviewerCalibrationHash: 'semantic-reviewer-calibration-contracts.mjs',
  sameNames: 'submit-ready-lifecycle-contracts.mjs',
  sameSubmitReadySet: 'submit-ready-lifecycle-contracts.mjs',
  slashPath: 'submit-ready-cleanup-contracts.mjs',
  standardSubmissionDescription: 'submission-description-contracts.mjs',
  standardSubmissionNote: 'submission-description-contracts.mjs',
  structuredQaBlockerContractsSelftest: 'structured-qa-blocker-contracts.mjs',
  submissionNoteCompliance: 'submission-description-contracts.mjs',
  summarizeHumanFeedbackLoop: 'human-feedback-loop-contracts.mjs',
  summarizeSemanticReviewerCalibration: 'semantic-reviewer-calibration-contracts.mjs',
  summarizeStructuredQaBlockers: 'structured-qa-blocker-contracts.mjs',
  submitReadyCleanupCandidateRecord: 'submit-ready-cleanup-contracts.mjs',
  submitReadyCleanupCheck: 'submit-ready-cleanup-contracts.mjs',
  submitReadyCleanupContractHash: 'submit-ready-cleanup-contracts.mjs',
  submitReadyCleanupContractsSelftest: 'submit-ready-cleanup-contracts.mjs',
  submitReadyLifecycleContractsSelftest: 'submit-ready-lifecycle-contracts.mjs',
  summarizeSubmitReadyLedger: 'submit-ready-lifecycle-contracts.mjs',
  taskIdFromSemanticReviewerReport: 'semantic-reviewer-calibration-contracts.mjs',
  stripPromptCompilerGuidance: 'prompt-artifact-compiler.mjs',
  summarizeGenerationAttachmentSpec: 'generation-contracts.mjs',
  applyStateTransition: 'state-machine.mjs',
  validateGenerationJob: 'generation-contracts.mjs',
  validateGenerationPlanSync: 'generation-contracts.mjs',
  validateHumanFeedbackRevisionContractForStage: 'human-feedback-contracts.mjs',
  validateAcceptanceLifecycleContract: 'acceptance-lifecycle-contracts.mjs',
  validateHumanFeedbackEvidenceContract: 'human-feedback-evidence-contracts.mjs',
  validateHumanFeedbackLoopSession: 'human-feedback-loop-contracts.mjs',
  validateLiveSubmitResultProof: 'live-submit-result-contracts.mjs',
  validateOpportunityLifecycleContract: 'opportunity-lifecycle-contracts.mjs',
  validateNextActionModelAdvice: 'next-action-advisor.mjs',
  validateProductionPlanConsistencyContract: 'production-plan-consistency-contracts.mjs',
  validatePromptProductionContract: 'prompt-production-contracts.mjs',
  validateRouteContractAgainstLiveRules: 'route-contracts.mjs',
  validateTenImageDirectPassPolicy: 'package-quality-lifecycle-contracts.mjs',
  validateSubmissionDescriptionContract: 'submission-description-contracts.mjs',
  validateWorkflowChain: 'contracts.mjs',
  updateCurrentRound: 'human-feedback-loop-contracts.mjs',
  updateSubmitReadyCaseIndex: 'submit-ready-cleanup-contracts.mjs',
  updateSubmitReadyCaseManifest: 'submit-ready-cleanup-contracts.mjs',
});

const CORE_RUNTIME_BOUNDARIES = Object.freeze({
  executesExternalAction: false,
  providerCalls: false,
  browserAutomation: false,
  upload: false,
  submit: false,
  messaging: false,
  payment: false,
  acceptance: false,
  deployment: false,
});

const LIFECYCLE_SCHEMA = buildExternalActionLifecycleSchema({ createdAt: '1970-01-01T00:00:00.000Z' });

const LIVE_ENTRYPOINT_LIFECYCLE_PROFILE_ID = 'live_entrypoint_enforced';

const LIFECYCLE_PHASE_TO_AUDIT_PHASE = Object.freeze({
  [EXTERNAL_ACTION_LIFECYCLE_PHASES.PLAN_REFERENCE_BINDING]: 'plan_reference_binding',
  [EXTERNAL_ACTION_LIFECYCLE_PHASES.APPROVAL_EVIDENCE_GATE]: 'approval_evidence_gate',
  [EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_ACTION_MANIFEST]: 'action_manifest_or_dispatch',
  [EXTERNAL_ACTION_LIFECYCLE_PHASES.ADAPTER_RUN_RECEIPT]: 'runner_receipt',
  [EXTERNAL_ACTION_LIFECYCLE_PHASES.CHANNEL_STATE_PROOF]: 'independent_channel_proof',
  [EXTERNAL_ACTION_LIFECYCLE_PHASES.EXTERNAL_ACTION_LEDGER]: 'external_action_ledger',
});

const AUDIT_PHASE_TO_LIFECYCLE_PHASE = Object.freeze(Object.fromEntries(
  Object.entries(LIFECYCLE_PHASE_TO_AUDIT_PHASE).map(([lifecyclePhase, auditPhase]) => [auditPhase, lifecyclePhase]),
));

function liveEntrypointRequiredPhases() {
  const profile = LIFECYCLE_SCHEMA.profiles.find((item) => item.profileId === LIVE_ENTRYPOINT_LIFECYCLE_PROFILE_ID);
  return (profile?.requiredPhaseIds || [])
    .map((phaseId) => LIFECYCLE_PHASE_TO_AUDIT_PHASE[phaseId])
    .filter(Boolean);
}

const LIVE_ENTRYPOINT_REQUIRED_PHASES = Object.freeze(liveEntrypointRequiredPhases());

const LIVE_ENTRYPOINT_OPTIONAL_PHASES = Object.freeze([
  'replay_guard',
]);

const LIVE_ENTRYPOINT_PHASE_RULES = Object.freeze({
  plan_reference_binding: Object.freeze({
    label: 'core plan/reference binding',
    patterns: [
      /\bbuildPlanOnlyDraft\b/,
      /\brouteProductLine\b/,
      /\bbuild(?:Zbj|Epwk|Hepta)PlanOnlyMigration\b/,
      /\bbuildDesignReferenceSpec\b/,
      /\bresolveLlmDesignReferenceSpec\b/,
      /\bbuildBuyerAssetPackage\b/,
      /design-reference/i,
      /buyer-asset/i,
      /plan-only/i,
    ],
  }),
  approval_evidence_gate: Object.freeze({
    label: 'approval/evidence gate',
    patterns: [
      /\bevaluate(?:Core)?ExecutionGate\b/,
      /\benforceExecutionPolicy\b/,
      /\bconsumeApprovalPacket\b/,
      /\bapprovalHash\b/,
      /\bevidenceHash\b/,
      /\bfreshEvidence/i,
    ],
  }),
  action_manifest_or_dispatch: Object.freeze({
    label: 'action manifest/dispatch',
    patterns: [
      /\bbuildChannelActionManifest\b/,
      /\bChannelActionManifest\b/,
      /\bbuildAdapterRunPreview\b/,
      /\bbuildAdapterHandoffOutboxItem\b/,
      /\bbuildAdapterDispatchEnvelope\b/,
      /\bbuildAdapterDispatchAssignment\b/,
      /\bmanifestHash\b/,
      /\bdispatchEnvelopeHash\b/,
      /\bcoreHandoffArtifacts\b/,
    ],
  }),
  runner_receipt: Object.freeze({
    label: 'runner receipt',
    patterns: [
      /\bbuildAdapterRunReceipt\b/,
      /\bAdapterRunReceipt\b/,
      /\bbuildAndWriteEpwkRunnerReceiptChain\b/,
      /\brunnerReceipt\b/,
      /receipt-finalizer/i,
      /\breceiptHash\b/,
    ],
  }),
  independent_channel_proof: Object.freeze({
    label: 'independent channel proof',
    patterns: [
      /\bbuildChannelStateProof\b/,
      /\bChannelStateProof\b/,
      /\binspectEpwkWorkDetailProof\b/,
      /\bruntimeProof\b/,
      /\bindependentChannel/i,
      /\bchannelStateProofHash\b/,
    ],
  }),
  external_action_ledger: Object.freeze({
    label: 'external action ledger',
    patterns: [
      /\bbuildExternalActionLedgerEntry\b/,
      /\bExternalActionLedger\b/,
      /external-action-ledger/i,
      /\bledgerHash\b/,
    ],
  }),
  replay_guard: Object.freeze({
    label: 'replay guard',
    patterns: [
      /\bbuildExternalActionReplayGuardDecision\b/,
      /\bReplayGuard\b/,
      /\breplayGuard\b/,
      /\breplay_guard/i,
    ],
  }),
});

export const LIVE_ENTRYPOINTS = Object.freeze({
  zbj: Object.freeze([
    Object.freeze({
      actionId: 'zbj.pitchSubmitLive',
      label: 'ZBJ pitch live submit',
      packageJson: 'zbj-auto-intake/package.json',
      scriptName: 'pitch:submit-live',
      entryFiles: ['zbj-auto-intake/src/pitch-submit-live.mjs'],
      coreBridgeFiles: [
        'zbj-auto-intake/src/core/zbj-core-workflow-bridge.mjs',
        'zbj-auto-intake/src/core/zbj-runner-bridge.mjs',
        'zbj-auto-intake/src/zbj-runner-bridge.mjs',
      ],
      lifecycleSchemaValidationProfileIds: ['dispatch_inbox_verified'],
    }),
    Object.freeze({
      actionId: 'zbj.acceptanceApplyLive',
      label: 'ZBJ acceptance apply live',
      packageJson: 'zbj-auto-intake/package.json',
      scriptName: 'acceptance:apply-live',
      entryFiles: ['zbj-auto-intake/src/acceptance-apply-live.mjs'],
      coreBridgeFiles: [
        'zbj-auto-intake/src/core/zbj-core-workflow-bridge.mjs',
        'zbj-auto-intake/src/core/zbj-runner-bridge.mjs',
        'zbj-auto-intake/src/zbj-runner-bridge.mjs',
      ],
      lifecycleSchemaValidationProfileIds: ['dispatch_inbox_verified'],
    }),
  ]),
  epwk: Object.freeze([
    Object.freeze({
      actionId: 'epwk.submitLive',
      label: 'EPWK manuscript live submit',
      packageJson: 'epwk-auto-intake/package.json',
      scriptName: 'submit:live',
      entryFiles: ['epwk-auto-intake/src/epwk-submit-live.mjs'],
      coreBridgeFiles: [
        'epwk-auto-intake/src/epwk-core-bridge.mjs',
        'epwk-auto-intake/src/epwk-lifecycle-adapters.mjs',
        'epwk-auto-intake/src/epwk-runner-receipt.mjs',
      ],
      lifecycleSchemaValidationProfileIds: ['standard_inbox_verified'],
    }),
    Object.freeze({
      actionId: 'epwk.workModifyLive',
      label: 'EPWK work modify live',
      packageJson: 'epwk-auto-intake/package.json',
      scriptName: 'work:modify-live',
      entryFiles: ['epwk-auto-intake/src/epwk-modify-work-live.mjs'],
      coreBridgeFiles: [
        'epwk-auto-intake/src/epwk-core-bridge.mjs',
        'epwk-auto-intake/src/epwk-lifecycle-adapters.mjs',
        'epwk-auto-intake/src/epwk-runner-receipt.mjs',
      ],
      lifecycleSchemaValidationProfileIds: ['standard_inbox_verified'],
    }),
    Object.freeze({
      actionId: 'epwk.bidSubmitLive',
      label: 'EPWK bid live submit',
      packageJson: 'epwk-auto-intake/package.json',
      scriptName: 'bid:submit-live',
      entryFiles: ['epwk-auto-intake/src/epwk-bid-submit-live.mjs'],
      coreBridgeFiles: [
        'epwk-auto-intake/src/epwk-core-bridge.mjs',
        'epwk-auto-intake/src/epwk-lifecycle-adapters.mjs',
        'epwk-auto-intake/src/epwk-runner-receipt.mjs',
      ],
      lifecycleSchemaValidationProfileIds: ['standard_inbox_verified'],
    }),
    Object.freeze({
      actionId: 'epwk.customerMessageLive',
      label: 'EPWK customer message live',
      packageJson: 'epwk-auto-intake/package.json',
      scriptName: 'im:send-live',
      entryFiles: ['epwk-auto-intake/src/epwk-customer-message-live.mjs'],
      coreBridgeFiles: [
        'epwk-auto-intake/src/epwk-core-bridge.mjs',
        'epwk-auto-intake/src/epwk-lifecycle-adapters.mjs',
        'epwk-auto-intake/src/epwk-runner-receipt.mjs',
      ],
      lifecycleSchemaValidationProfileIds: ['standard_inbox_verified'],
    }),
    Object.freeze({
      actionId: 'epwk.acceptanceApplyLive',
      label: 'EPWK acceptance apply live',
      packageJson: 'epwk-auto-intake/package.json',
      scriptName: 'acceptance:apply-live',
      entryFiles: ['epwk-auto-intake/src/epwk-acceptance-apply-live.mjs'],
      coreBridgeFiles: [
        'epwk-auto-intake/src/epwk-core-bridge.mjs',
        'epwk-auto-intake/src/epwk-lifecycle-adapters.mjs',
        'epwk-auto-intake/src/epwk-runner-receipt.mjs',
      ],
      lifecycleSchemaValidationProfileIds: ['standard_inbox_verified'],
    }),
  ]),
  hepta: Object.freeze([
    Object.freeze({
      actionId: 'hepta.deliveryDeploy',
      label: 'Hepta delivery deploy',
      entryFiles: ['skills/hepta_design/scripts/hepta-core-bridge.mjs'],
      coreBridgeFiles: [],
      lifecycleSchemaValidationProfileIds: ['live_entrypoint_enforced'],
    }),
  ]),
});

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function reportOk(report = {}) {
  return report?.ok === true
    || report?.validationOk === true
    || /^pass_|^ready_/.test(String(report?.status || ''));
}

function readReportBindings() {
  const bindings = {};
  for (const spec of [
    ...REPORT_FRESHNESS_REQUIRED_REPORTS,
    REPORT_FRESHNESS_GATE_REPORT,
  ]) {
    const filePath = path.join(reportsDir, spec.fileId);
    const report = readJson(filePath);
    bindings[spec.fileId] = {
      exists: Boolean(report),
      ok: reportOk(report),
      status: report?.status || null,
      hash: reportHashForFileId(report || {}, spec.fileId),
      blockerCount: Array.isArray(report?.blockers) ? report.blockers.length : 0,
      generatedAt: report?.generatedAt || null,
      file: relative(filePath),
      report,
    };
  }
  return bindings;
}

function readReportSchemaContractRecords() {
  return expectedReportSchemaContractFileIds(undefined, { includeGateReport: false }).flatMap((fileId) => {
    const report = readJson(path.join(reportsDir, fileId));
    return report ? [{ fileId, report }] : [];
  });
}

function markdownFileIdFor(fileId) {
  return String(fileId || '').replace(/\.json$/, '.md');
}

function latestReportFileIds() {
  return fs.readdirSync(reportsDir)
    .filter((fileId) => fileId.endsWith('-latest.json'))
    .filter((fileId) => fileId !== REPORT_OUTPUT_PAIRING_REPORT_FILE_ID)
    .sort((left, right) => left.localeCompare(right));
}

function readReportOutputPairingRecords(fileIds) {
  return fileIds.map((fileId) => {
    const jsonPath = path.join(reportsDir, fileId);
    const mdPath = path.join(reportsDir, markdownFileIdFor(fileId));
    return {
      fileId,
      jsonExists: fs.existsSync(jsonPath),
      mdExists: fs.existsSync(mdPath),
      report: readJson(jsonPath),
    };
  });
}

function relative(filePath) {
  return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
}

function exists(relPath) {
  return fs.existsSync(path.join(workspaceRoot, relPath));
}

function absolute(relPath) {
  return path.join(workspaceRoot, relPath);
}

function uniqueStrings(values = []) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function codeToken(value) {
  return String(value || 'unknown')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'unknown';
}

function shouldSkipDir(name) {
  return ['node_modules', '.git', 'tmp', '.next', 'dist', 'reports'].includes(name);
}

function walkFiles(rootPath, limit = 20000) {
  const out = [];
  function walk(current) {
    if (out.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) break;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) walk(fullPath);
        continue;
      }
      if (entry.isFile()) out.push(fullPath);
    }
  }
  if (fs.existsSync(rootPath)) {
    const stat = fs.statSync(rootPath);
    if (stat.isFile()) return [rootPath];
    walk(rootPath);
  }
  return out;
}

function scanFilesForTarget(target) {
  const files = [];
  for (const root of target.roots) {
    const absoluteRoot = path.join(workspaceRoot, root);
    if (!fs.existsSync(absoluteRoot)) continue;
    for (const runtimeRoot of target.runtimeRoots) {
      const full = path.join(absoluteRoot, runtimeRoot);
      files.push(...walkFiles(full));
    }
    const docs = path.join(absoluteRoot, 'docs');
    files.push(...walkFiles(docs));
  }
  return [...new Set(files)]
    .filter((filePath) => /\.(mjs|js|ts|tsx|jsx|json|md)$/.test(filePath))
    .sort((left, right) => left.localeCompare(right));
}

function packageRootModuleForImportedName(importedName) {
  const name = String(importedName || '').trim();
  if (PACKAGE_ROOT_SYMBOL_MODULE_HINTS[name]) return PACKAGE_ROOT_SYMBOL_MODULE_HINTS[name];
  if (/^(build|summarize|select|resolve)?Adapter/.test(name)) return 'external-action-lifecycle.mjs';
  if (/^(build|summarize|validate)?ExternalAction/.test(name)) return 'external-action-lifecycle.mjs';
  if (/^(build|summarize)?ChannelStateProof/.test(name)) return 'external-action-lifecycle.mjs';
  if (/^(build|summarize)?ReceiptStateTransition/.test(name)) return 'external-action-lifecycle.mjs';
  if (/^buildDispatch/.test(name)) return 'external-action-lifecycle.mjs';
  return null;
}

function importedNamesFromPackageRootClause(clause) {
  return String(clause || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+as\s+/i)[0].trim())
    .filter(Boolean);
}

function extractCoreReferences(filePath) {
  const text = readText(filePath);
  if (!text.includes('design-production-core')) return [];
  const refs = [];
  const packageRootImportRegex = /\b(?:import|export)\s*\{([\s\S]*?)\}\s*from\s*['"]design-production-core['"]/g;
  let packageRootMatch = packageRootImportRegex.exec(text);
  while (packageRootMatch) {
    const importedNames = importedNamesFromPackageRootClause(packageRootMatch[1]);
    const moduleHints = uniqueStrings(importedNames.map(packageRootModuleForImportedName).filter(Boolean));
    if (!moduleHints.length) {
      refs.push({
        kind: 'runtime_import',
        importPath: 'design-production-core',
        module: 'index.mjs',
        packageRoot: true,
        importedNames,
        file: relative(filePath),
      });
    }
    for (const module of moduleHints) {
      refs.push({
        kind: 'runtime_import',
        importPath: 'design-production-core',
        module,
        packageRoot: true,
        importedNames: importedNames.filter((name) => packageRootModuleForImportedName(name) === module),
        file: relative(filePath),
      });
    }
    packageRootMatch = packageRootImportRegex.exec(text);
  }
  const importRegex = /(?:from\s+|import\s*\()\s*['"]([^'"]*design-production-core\/src\/([^'"]+))['"]/g;
  let match = importRegex.exec(text);
  while (match) {
    refs.push({
      kind: 'runtime_import',
      importPath: match[1],
      module: match[2],
      file: relative(filePath),
    });
    match = importRegex.exec(text);
  }
  if (!refs.length) {
    refs.push({
      kind: 'text_reference',
      importPath: null,
      module: null,
      file: relative(filePath),
    });
  }
  return refs;
}

function modulesFromIndexExport(exportName) {
  const indexText = readText(path.join(packageRoot, 'src', 'index.mjs'));
  const match = indexText.match(new RegExp(`${exportName}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\);`));
  if (!match) return [];
  const modules = [];
  const itemRegex = /'([^']+)'/g;
  let item = itemRegex.exec(match[1]);
  while (item) {
    modules.push(item[1]);
    item = itemRegex.exec(match[1]);
  }
  return modules;
}

function publicModulesFromIndex() {
  return modulesFromIndexExport('CORE_PUBLIC_MODULES');
}

function compatibilityModulesFromIndex() {
  return modulesFromIndexExport('CORE_COMPATIBILITY_MODULES');
}

function runtimeOnly(refs) {
  return refs.filter((ref) => ref.kind === 'runtime_import' && !ref.file.includes('/docs/'));
}

function normalizeCoreModuleName(moduleName) {
  return String(moduleName || '')
    .replace(/\\/g, '/')
    .replace(/\.mjs$/, '')
    .replace(/\/index$/, '');
}

function publicApiUsage(refs) {
  const publicModules = new Set(publicModulesFromIndex());
  const compatibilityModules = new Set(compatibilityModulesFromIndex());
  const usage = {
    stable: new Map(),
    compatibility: new Map(),
    internal: new Map(),
  };
  for (const ref of runtimeOnly(refs)) {
    const normalized = normalizeCoreModuleName(ref.module);
    const bucket = publicModules.has(normalized)
      ? 'stable'
      : compatibilityModules.has(normalized)
        ? 'compatibility'
        : 'internal';
    const current = usage[bucket].get(normalized) || {
      module: normalized,
      importCount: 0,
      files: new Set(),
    };
    current.importCount += 1;
    current.files.add(ref.file);
    usage[bucket].set(normalized, current);
  }
  function rows(bucket) {
    return [...usage[bucket].values()]
      .map((item) => ({
        module: item.module,
        importCount: item.importCount,
        files: [...item.files].sort(),
      }))
      .sort((left, right) => left.module.localeCompare(right.module));
  }
  const stableModules = rows('stable');
  const compatibilityModulesUsed = rows('compatibility');
  const internalModules = rows('internal');
  return {
    stableImportCount: stableModules.reduce((sum, item) => sum + item.importCount, 0),
    compatibilityImportCount: compatibilityModulesUsed.reduce((sum, item) => sum + item.importCount, 0),
    internalImportCount: internalModules.reduce((sum, item) => sum + item.importCount, 0),
    stableModules,
    compatibilityModules: compatibilityModulesUsed,
    internalModules,
    recommendedAction: internalModules.length
      ? 'replace_internal_imports_with_public_or_channel_owned_adapters'
      : compatibilityModulesUsed.length
        ? 'migrate_compatibility_imports_to_stable_public_surface'
        : 'already_on_stable_public_surface',
  };
}

function forbiddenChannelImports(files, target) {
  const rules = [
    {
      code: 'channel_imports_zbj_industry_taxonomy_runtime',
      pattern: /zbj-auto-intake\/src\/core\/industry-taxonomy\.mjs|\.\.\/\.\.\/zbj-auto-intake\/src\/core\/industry-taxonomy\.mjs/,
      notes: 'Production channels must not call the ZBJ regex industry taxonomy directly; model industry selection must enter through design-production-core.',
    },
    {
      code: 'channel_imports_zbj_refpack_index_runtime',
      pattern: /zbj-auto-intake\/src\/core\/refpack-index\.mjs|\.\.\/\.\.\/zbj-auto-intake\/src\/core\/refpack-index\.mjs/,
      notes: 'Production channels must not call the ZBJ refpack index resolver directly; refpack selection must be model-locked in design-production-core.',
    },
  ];
  return files.flatMap((filePath) => {
    const text = readText(filePath);
    return rules
      .filter((rule) => rule.pattern.test(text))
      .map((rule) => ({
        code: `${target.channelId}_${rule.code}`,
        file: relative(filePath),
        notes: rule.notes,
      }));
  });
}

function moduleMatchesSurface(moduleName, surfaceId) {
  const rules = SURFACE_RULES[surfaceId] || [];
  return rules.some((rule) => moduleName.includes(rule));
}

function surfaceCoverage(refs, expectedSurfaces) {
  const imports = runtimeOnly(refs);
  const importedModules = imports.map((ref) => ref.module || '');
  return Object.fromEntries(expectedSurfaces.map((surfaceId) => {
    const matched = importedModules.filter((moduleName) => moduleMatchesSurface(moduleName, surfaceId));
    return [surfaceId, {
      present: matched.length > 0,
      modules: [...new Set(matched)].sort(),
    }];
  }));
}

function channelStatus({ target, refs, coverage }) {
  const runtimeImports = runtimeOnly(refs);
  const present = Object.values(coverage).filter((item) => item.present).length;
  const expected = target.expectedSurfaces.length;
  if (!runtimeImports.length) return 'not_wired_to_core_runtime';
  if (present < expected) return 'partially_wired_to_core';
  return 'wired_to_core_surfaces';
}

function packageScriptAudit(spec) {
  if (!spec.packageJson || !spec.scriptName) {
    return {
      required: false,
      packageJson: spec.packageJson || null,
      scriptName: spec.scriptName || null,
      exists: true,
      command: null,
      blockers: [],
    };
  }
  const packageJson = readJson(absolute(spec.packageJson), {});
  const command = packageJson?.scripts?.[spec.scriptName] || null;
  const entryFiles = spec.entryFiles || [];
  const referencesEntry = command
    ? entryFiles.some((file) => command.includes(path.basename(file)) || command.includes(file.replace(/^[^/]+\//, '')))
    : false;
  const blockers = [];
  if (!command) {
    blockers.push({
      code: 'package_script_missing',
      notes: `${spec.packageJson} is missing script ${spec.scriptName}.`,
    });
  } else if (!referencesEntry) {
    blockers.push({
      code: 'package_script_entrypoint_mismatch',
      notes: `${spec.scriptName} does not reference the expected live entry file.`,
    });
  }
  return {
    required: true,
    packageJson: spec.packageJson,
    scriptName: spec.scriptName,
    exists: Boolean(command),
    command,
    referencesEntry,
    blockers,
  };
}

function phaseCoverageForText(text, phaseIds) {
  return Object.fromEntries(phaseIds.map((phaseId) => {
    const rule = LIVE_ENTRYPOINT_PHASE_RULES[phaseId];
    const matchedPatterns = (rule?.patterns || [])
      .filter((pattern) => pattern.test(text))
      .map((pattern) => String(pattern));
    return [phaseId, {
      label: rule?.label || phaseId,
      present: matchedPatterns.length > 0,
      matchedPatterns,
    }];
  }));
}

function lifecycleSchemaUsageForText(text, spec) {
  const expectedProfileIds = uniqueStrings(spec.lifecycleSchemaValidationProfileIds || [
    spec.lifecycleProfileId || LIVE_ENTRYPOINT_LIFECYCLE_PROFILE_ID,
  ]);
  const matchedProfileIds = uniqueStrings(
    (text.match(/profileId:\s*['"]([^'"]+)['"]/g) || [])
      .map((item) => item.match(/profileId:\s*['"]([^'"]+)['"]/)?.[1])
      .filter(Boolean),
  );
  const usesSchemaBuilder = /\bbuildExternalActionLifecycleSchema\b/.test(text);
  const usesChainValidator = /\bvalidateExternalActionLifecycleChain\b/.test(text);
  const missingProfileIds = expectedProfileIds.filter((profileId) => !matchedProfileIds.includes(profileId));
  const blockers = [];
  if (!usesSchemaBuilder || !usesChainValidator) {
    blockers.push({
      code: 'lifecycle_schema_validation_missing',
      notes: `${spec.actionId} entry/bridge files do not explicitly build and validate the external action lifecycle schema.`,
    });
  }
  for (const profileId of missingProfileIds) {
    blockers.push({
      code: 'lifecycle_schema_validation_profile_missing',
      notes: `${spec.actionId} entry/bridge files do not validate the expected lifecycle schema profile ${profileId}.`,
    });
  }
  return {
    present: usesSchemaBuilder && usesChainValidator && missingProfileIds.length === 0,
    usesSchemaBuilder,
    usesChainValidator,
    expectedProfileIds,
    matchedProfileIds,
    missingProfileIds,
    blockers,
  };
}

function auditLiveEntrypoint(spec) {
  const entryFiles = spec.entryFiles || [];
  const coreBridgeFiles = spec.coreBridgeFiles || [];
  const allFiles = uniqueStrings([...entryFiles, ...coreBridgeFiles]);
  const fileRecords = allFiles.map((file) => {
    const abs = absolute(file);
    const present = fs.existsSync(abs);
    return {
      path: file,
      role: entryFiles.includes(file) ? 'live_entrypoint' : 'core_bridge',
      exists: present,
      bytes: present ? Buffer.byteLength(readText(abs), 'utf8') : 0,
    };
  });
  const text = fileRecords
    .filter((record) => record.exists)
    .map((record) => readText(absolute(record.path)))
    .join('\n\n');
  const requiredPhases = spec.requiredPhases || LIVE_ENTRYPOINT_REQUIRED_PHASES;
  const optionalPhases = spec.optionalPhases || LIVE_ENTRYPOINT_OPTIONAL_PHASES;
  const phaseCoverage = phaseCoverageForText(text, [...requiredPhases, ...optionalPhases]);
  const missingRequiredPhases = requiredPhases.filter((phaseId) => !phaseCoverage[phaseId]?.present);
  const lifecyclePhaseIds = requiredPhases
    .filter((phaseId) => phaseCoverage[phaseId]?.present)
    .map((phaseId) => AUDIT_PHASE_TO_LIFECYCLE_PHASE[phaseId])
    .filter(Boolean);
  const lifecycleValidation = validateExternalActionLifecycleChain({
    schema: LIFECYCLE_SCHEMA,
    profileId: spec.lifecycleProfileId || LIVE_ENTRYPOINT_LIFECYCLE_PROFILE_ID,
    phases: lifecyclePhaseIds,
    strictUnknown: false,
  });
  const lifecycleSchemaUsage = lifecycleSchemaUsageForText(text, spec);
  const packageScript = packageScriptAudit(spec);
  const missingEntryFiles = fileRecords
    .filter((record) => record.role === 'live_entrypoint' && !record.exists)
    .map((record) => record.path);
  const missingBridgeFiles = fileRecords
    .filter((record) => record.role === 'core_bridge' && !record.exists)
    .map((record) => record.path);
  const blockers = [
    ...packageScript.blockers,
    ...missingEntryFiles.map((file) => ({
      code: 'live_entrypoint_file_missing',
      notes: `Expected live entrypoint file is missing: ${file}.`,
    })),
    ...missingRequiredPhases.map((phaseId) => ({
      code: `live_entrypoint_phase_missing_${phaseId}`,
      notes: `${spec.actionId} does not show required ${LIVE_ENTRYPOINT_PHASE_RULES[phaseId]?.label || phaseId} coverage across its entrypoint and core bridge files.`,
    })),
    ...lifecycleValidation.blockers.map((item) => ({
      code: `live_entrypoint_lifecycle_schema_${item.code}`,
      notes: `${spec.actionId} failed ${lifecycleValidation.profileId} validation: ${item.notes || item.code}.`,
    })),
    ...lifecycleSchemaUsage.blockers,
  ];
  return {
    actionId: spec.actionId,
    label: spec.label,
    status: blockers.length ? 'blocked_live_entrypoint_core_lifecycle' : 'core_lifecycle_enforced',
    ok: blockers.length === 0,
    packageScript,
    files: fileRecords,
    missingEntryFiles,
    missingBridgeFiles,
    requiredPhases,
    optionalPhases,
    phaseCoverage,
    lifecycleProfileId: lifecycleValidation.profileId,
    lifecycleValidationStatus: lifecycleValidation.status,
    lifecycleSchemaUsage,
    lifecyclePhaseIds,
    lifecycleMissingRequiredPhaseIds: lifecycleValidation.missingRequiredPhaseIds,
    missingRequiredPhases,
    blockers,
  };
}

function auditLiveEntrypoints(target) {
  return (LIVE_ENTRYPOINTS[target.channelId] || []).map(auditLiveEntrypoint);
}

export function auditLiveEntrypointsForChannel(channelId) {
  return (LIVE_ENTRYPOINTS[channelId] || []).map(auditLiveEntrypoint);
}

function auditChannel(target) {
  const files = scanFilesForTarget(target);
  const refs = files.flatMap(extractCoreReferences);
  const coverage = surfaceCoverage(refs, target.expectedSurfaces);
  const missingSurfaces = Object.entries(coverage)
    .filter(([, item]) => !item.present)
    .map(([surfaceId]) => surfaceId);
  const runtimeImports = runtimeOnly(refs);
  const forbiddenImports = forbiddenChannelImports(files, target);
  const liveEntrypoints = auditLiveEntrypoints(target);
  const apiUsage = publicApiUsage(refs);
  return {
    channelId: target.channelId,
    label: target.label,
    roots: target.roots.map((root) => ({
      path: root,
      exists: exists(root),
    })),
    status: channelStatus({ target, refs, coverage }),
    scannedFileCount: files.length,
    runtimeCoreImportCount: runtimeImports.length,
    textReferenceCount: refs.filter((ref) => ref.kind === 'text_reference').length,
    runtimeImportFiles: [...new Set(runtimeImports.map((ref) => ref.file))].sort(),
    importedCoreModules: [...new Set(runtimeImports.map((ref) => ref.module))].sort(),
    publicApiUsage: apiUsage,
    expectedSurfaces: target.expectedSurfaces,
    surfaceCoverage: coverage,
    missingSurfaces,
    liveEntrypoints,
    forbiddenImports,
    references: refs.sort((left, right) => `${left.file}:${left.module || ''}`.localeCompare(`${right.file}:${right.module || ''}`)),
  };
}

function coreShape() {
  const packageJson = readJson(path.join(packageRoot, 'package.json'), {});
  const packageExportSurface = summarizePackageExportSurface(packageJson.exports || {});
  const indexText = readText(path.join(packageRoot, 'src', 'index.mjs'));
  const srcFiles = walkFiles(path.join(packageRoot, 'src')).filter((filePath) => filePath.endsWith('.mjs'));
  const srcText = srcFiles.map(readText).join('\n');
  const adapterRunnerText = readText(path.join(packageRoot, 'src', 'adapter-runner.mjs'));
  const lifecycleSurfacePath = path.join(packageRoot, 'src', 'external-action-lifecycle.mjs');
  const lifecycleSurfaceText = readText(lifecycleSurfacePath);
  const lifecycleSchemaPath = path.join(packageRoot, 'src', 'external-action-lifecycle-schema.mjs');
  const lifecycleSchemaText = readText(lifecycleSchemaPath);
  const contractSchemaPath = path.join(packageRoot, 'src', 'contract-schema.mjs');
  const contractSchemaText = readText(contractSchemaPath);
  const compatibilityPolicyPath = path.join(packageRoot, 'src', 'compatibility-export-policy.mjs');
  const compatibilityPolicyText = readText(compatibilityPolicyPath);
  const readOnlyReportChainPath = path.join(packageRoot, 'src', 'read-only-report-chain.mjs');
  const readOnlyReportChainText = readText(readOnlyReportChainPath);
  const reportFreshnessPath = path.join(packageRoot, 'src', 'report-freshness.mjs');
  const reportFreshnessText = readText(reportFreshnessPath);
  const reportFreshnessRegressionPath = path.join(packageRoot, 'src', 'report-freshness-regression.mjs');
  const reportFreshnessRegressionText = readText(reportFreshnessRegressionPath);
  const integrationGateSequenceRegressionPath = path.join(packageRoot, 'src', 'integration-gate-sequence-regression.mjs');
  const integrationGateSequenceRegressionText = readText(integrationGateSequenceRegressionPath);
  const reportInventoryConsistencyPath = path.join(packageRoot, 'src', 'report-inventory-consistency.mjs');
  const reportInventoryConsistencyText = readText(reportInventoryConsistencyPath);
  const reportSchemaContractPath = path.join(packageRoot, 'src', 'report-schema-contract.mjs');
  const reportSchemaContractText = readText(reportSchemaContractPath);
  const reportLineageTopologyPath = path.join(packageRoot, 'src', 'report-lineage-topology.mjs');
  const reportLineageTopologyText = readText(reportLineageTopologyPath);
  const reportHashStabilityRegressionPath = path.join(packageRoot, 'src', 'report-hash-stability-regression.mjs');
  const reportHashStabilityRegressionText = readText(reportHashStabilityRegressionPath);
  const reportOutputPairingPath = path.join(packageRoot, 'src', 'report-output-pairing.mjs');
  const reportOutputPairingText = readText(reportOutputPairingPath);
  const reportArtifactReproducibilityPath = path.join(packageRoot, 'src', 'report-artifact-reproducibility.mjs');
  const reportArtifactReproducibilityText = readText(reportArtifactReproducibilityPath);
  const reportSelfReferenceBoundaryRegressionPath = path.join(packageRoot, 'src', 'report-self-reference-boundary-regression.mjs');
  const reportSelfReferenceBoundaryRegressionText = readText(reportSelfReferenceBoundaryRegressionPath);
  const reportContractManifestPath = path.join(packageRoot, 'src', 'report-contract-manifest.mjs');
  const reportContractManifestText = readText(reportContractManifestPath);
  const reportContractRequiredCoverageRegressionPath = path.join(packageRoot, 'src', 'report-contract-required-coverage-regression.mjs');
  const reportContractRequiredCoverageRegressionText = readText(reportContractRequiredCoverageRegressionPath);
  const reportContractDocCoverageRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-coverage-regression.mjs');
  const reportContractDocCoverageRegressionText = readText(reportContractDocCoverageRegressionPath);
  const reportContractSyntaxCoverageRegressionPath = path.join(packageRoot, 'src', 'report-contract-syntax-coverage-regression.mjs');
  const reportContractSyntaxCoverageRegressionText = readText(reportContractSyntaxCoverageRegressionPath);
  const reportContractSourceDerivationRegressionPath = path.join(packageRoot, 'src', 'report-contract-source-derivation-regression.mjs');
  const reportContractSourceDerivationRegressionText = readText(reportContractSourceDerivationRegressionPath);
  const reportContractSummaryKeyRegressionPath = path.join(packageRoot, 'src', 'report-contract-summary-key-regression.mjs');
  const reportContractSummaryKeyRegressionText = readText(reportContractSummaryKeyRegressionPath);
  const reportContractAuditForwardingRegressionPath = path.join(packageRoot, 'src', 'report-contract-audit-forwarding-regression.mjs');
  const reportContractAuditForwardingRegressionText = readText(reportContractAuditForwardingRegressionPath);
  const reportContractCheckpointBindingShapeRegressionPath = path.join(packageRoot, 'src', 'report-contract-checkpoint-binding-shape-regression.mjs');
  const reportContractCheckpointBindingShapeRegressionText = readText(reportContractCheckpointBindingShapeRegressionPath);
  const reportContractGateSummaryShapeRegressionPath = path.join(packageRoot, 'src', 'report-contract-gate-summary-shape-regression.mjs');
  const reportContractGateSummaryShapeRegressionText = readText(reportContractGateSummaryShapeRegressionPath);
  const reportContractExporterStdoutShapeRegressionPath = path.join(packageRoot, 'src', 'report-contract-exporter-stdout-shape-regression.mjs');
  const reportContractExporterStdoutShapeRegressionText = readText(reportContractExporterStdoutShapeRegressionPath);
  const reportContractSafetyFlagRegressionPath = path.join(packageRoot, 'src', 'report-contract-safety-flag-regression.mjs');
  const reportContractSafetyFlagRegressionText = readText(reportContractSafetyFlagRegressionPath);
  const reportContractArtifactBindingRegressionPath = path.join(packageRoot, 'src', 'report-contract-artifact-binding-regression.mjs');
  const reportContractArtifactBindingRegressionText = readText(reportContractArtifactBindingRegressionPath);
  const reportContractDocIndexAnchorRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-index-anchor-regression.mjs');
  const reportContractDocIndexAnchorRegressionText = readText(reportContractDocIndexAnchorRegressionPath);
  const reportContractDocPageLatestDetailRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-latest-detail-regression.mjs');
  const reportContractDocPageLatestDetailRegressionText = readText(reportContractDocPageLatestDetailRegressionPath);
  const reportContractDocPageCommandSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-command-section-regression.mjs');
  const reportContractDocPageCommandSectionRegressionText = readText(reportContractDocPageCommandSectionRegressionPath);
  const reportContractDocPageSafetySectionDetailRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-safety-section-detail-regression.mjs');
  const reportContractDocPageSafetySectionDetailRegressionText = readText(reportContractDocPageSafetySectionDetailRegressionPath);
  const reportContractDocPageStrictGateSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-strict-gate-section-regression.mjs');
  const reportContractDocPageStrictGateSectionRegressionText = readText(reportContractDocPageStrictGateSectionRegressionPath);
  const reportContractDocPageOutputSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-output-section-regression.mjs');
  const reportContractDocPageOutputSectionRegressionText = readText(reportContractDocPageOutputSectionRegressionPath);
  const reportContractDocPageCrossReportSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-cross-report-section-regression.mjs');
  const reportContractDocPageCrossReportSectionRegressionText = readText(reportContractDocPageCrossReportSectionRegressionPath);
  const reportContractDocPageCloseoutSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-closeout-section-regression.mjs');
  const reportContractDocPageCloseoutSectionRegressionText = readText(reportContractDocPageCloseoutSectionRegressionPath);
  const reportContractDocPagePostGateWriterSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-post-gate-writer-section-regression.mjs');
  const reportContractDocPagePostGateWriterSectionRegressionText = readText(reportContractDocPagePostGateWriterSectionRegressionPath);
  const reportContractDocPageRetentionSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-retention-section-regression.mjs');
  const reportContractDocPageRetentionSectionRegressionText = readText(reportContractDocPageRetentionSectionRegressionPath);
  const reportContractDocPageFreshnessHashSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-freshness-hash-section-regression.mjs');
  const reportContractDocPageFreshnessHashSectionRegressionText = readText(reportContractDocPageFreshnessHashSectionRegressionPath);
  const reportContractDocPageCheckpointHashSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-checkpoint-hash-section-regression.mjs');
  const reportContractDocPageCheckpointHashSectionRegressionText = readText(reportContractDocPageCheckpointHashSectionRegressionPath);
  const reportContractDocPageBootstrapSeedSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-bootstrap-seed-section-regression.mjs');
  const reportContractDocPageBootstrapSeedSectionRegressionText = readText(reportContractDocPageBootstrapSeedSectionRegressionPath);
  const reportContractDocPageCleanRerunSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-clean-rerun-section-regression.mjs');
  const reportContractDocPageCleanRerunSectionRegressionText = readText(reportContractDocPageCleanRerunSectionRegressionPath);
  const reportContractDocPageFinalSettlementSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-final-settlement-section-regression.mjs');
  const reportContractDocPageFinalSettlementSectionRegressionText = readText(reportContractDocPageFinalSettlementSectionRegressionPath);
  const reportContractDocPageCloseoutIndexSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-closeout-index-section-regression.mjs');
  const reportContractDocPageCloseoutIndexSectionRegressionText = readText(reportContractDocPageCloseoutIndexSectionRegressionPath);
  const reportContractDocPageCloseoutEvidenceSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-closeout-evidence-section-regression.mjs');
  const reportContractDocPageCloseoutEvidenceSectionRegressionText = readText(reportContractDocPageCloseoutEvidenceSectionRegressionPath);
  const reportContractDocPageCloseoutLedgerSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-closeout-ledger-section-regression.mjs');
  const reportContractDocPageCloseoutLedgerSectionRegressionText = readText(reportContractDocPageCloseoutLedgerSectionRegressionPath);
  const reportContractDocPageCloseoutRetentionProofSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-closeout-retention-proof-section-regression.mjs');
  const reportContractDocPageCloseoutRetentionProofSectionRegressionText = readText(reportContractDocPageCloseoutRetentionProofSectionRegressionPath);
  const reportContractDocPageCloseoutProbeBundleSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-closeout-probe-bundle-section-regression.mjs');
  const reportContractDocPageCloseoutProbeBundleSectionRegressionText = readText(reportContractDocPageCloseoutProbeBundleSectionRegressionPath);
  const reportContractDocPageCloseoutSignoffSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-closeout-signoff-section-regression.mjs');
  const reportContractDocPageCloseoutSignoffSectionRegressionText = readText(reportContractDocPageCloseoutSignoffSectionRegressionPath);
  const reportContractDocPageCloseoutReleaseManifestSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-closeout-release-manifest-section-regression.mjs');
  const reportContractDocPageCloseoutReleaseManifestSectionRegressionText = readText(reportContractDocPageCloseoutReleaseManifestSectionRegressionPath);
  const reportContractDocPageReleaseArchiveIndexSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-archive-index-section-regression.mjs');
  const reportContractDocPageReleaseArchiveIndexSectionRegressionText = readText(reportContractDocPageReleaseArchiveIndexSectionRegressionPath);
  const reportContractDocPageReleaseHandoffLedgerSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-handoff-ledger-section-regression.mjs');
  const reportContractDocPageReleaseHandoffLedgerSectionRegressionText = readText(reportContractDocPageReleaseHandoffLedgerSectionRegressionPath);
  const reportContractDocPageReleaseDeliveryReadinessSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-delivery-readiness-section-regression.mjs');
  const reportContractDocPageReleaseDeliveryReadinessSectionRegressionText = readText(reportContractDocPageReleaseDeliveryReadinessSectionRegressionPath);
  const reportContractDocPageReleaseExecutionDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-execution-denial-section-regression.mjs');
  const reportContractDocPageReleaseExecutionDenialSectionRegressionText = readText(reportContractDocPageReleaseExecutionDenialSectionRegressionPath);
  const reportContractDocPageReleaseOperatorApprovalSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-operator-approval-section-regression.mjs');
  const reportContractDocPageReleaseOperatorApprovalSectionRegressionText = readText(reportContractDocPageReleaseOperatorApprovalSectionRegressionPath);
  const reportContractDocPageReleaseApprovalLedgerSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-approval-ledger-section-regression.mjs');
  const reportContractDocPageReleaseApprovalLedgerSectionRegressionText = readText(reportContractDocPageReleaseApprovalLedgerSectionRegressionPath);
  const reportContractDocPageReleaseActionQueueSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-action-queue-section-regression.mjs');
  const reportContractDocPageReleaseActionQueueSectionRegressionText = readText(reportContractDocPageReleaseActionQueueSectionRegressionPath);
  const reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-runner-dispatch-denial-section-regression.mjs');
  const reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionText = readText(reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionPath);
  const reportContractDocPageReleaseLiveActionPreflightSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-live-action-preflight-section-regression.mjs');
  const reportContractDocPageReleaseLiveActionPreflightSectionRegressionText = readText(reportContractDocPageReleaseLiveActionPreflightSectionRegressionPath);
  const reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-execution-intent-capture-section-regression.mjs');
  const reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionText = readText(reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionPath);
  const reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-execution-approval-boundary-section-regression.mjs');
  const reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionText = readText(reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionPath);
  const reportContractDocPageReleaseRunnerExecutionGateSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-runner-execution-gate-section-regression.mjs');
  const reportContractDocPageReleaseRunnerExecutionGateSectionRegressionText = readText(reportContractDocPageReleaseRunnerExecutionGateSectionRegressionPath);
  const reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-dispatch-implementation-denial-section-regression.mjs');
  const reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionText = readText(reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionPath);
  const reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-platform-state-snapshot-denial-section-regression.mjs');
  const reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionText = readText(reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionPath);
  const reportContractDocPageReleaseDryRunReplayDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-dry-run-replay-denial-section-regression.mjs');
  const reportContractDocPageReleaseDryRunReplayDenialSectionRegressionText = readText(reportContractDocPageReleaseDryRunReplayDenialSectionRegressionPath);
  const reportContractDocPageReleaseProofBundleDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-proof-bundle-denial-section-regression.mjs');
  const reportContractDocPageReleaseProofBundleDenialSectionRegressionText = readText(reportContractDocPageReleaseProofBundleDenialSectionRegressionPath);
  const reportContractDocPageReleaseLedgerDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-ledger-denial-section-regression.mjs');
  const reportContractDocPageReleaseLedgerDenialSectionRegressionText = readText(reportContractDocPageReleaseLedgerDenialSectionRegressionPath);
  const reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-audit-evidence-denial-section-regression.mjs');
  const reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionText = readText(reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionPath);
  const reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-receipt-evidence-denial-section-regression.mjs');
  const reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionText = readText(reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionPath);
  const reportContractDocPageReleasePostActionReceiptDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-post-action-receipt-denial-section-regression.mjs');
  const reportContractDocPageReleasePostActionReceiptDenialSectionRegressionText = readText(reportContractDocPageReleasePostActionReceiptDenialSectionRegressionPath);
  const reportContractDocPageReleasePostActionAuditDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-post-action-audit-denial-section-regression.mjs');
  const reportContractDocPageReleasePostActionAuditDenialSectionRegressionText = readText(reportContractDocPageReleasePostActionAuditDenialSectionRegressionPath);
  const reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-post-action-reconciliation-denial-section-regression.mjs');
  const reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionText = readText(reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionPath);
  const reportContractDocPageReleasePostActionSettlementDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-post-action-settlement-denial-section-regression.mjs');
  const reportContractDocPageReleasePostActionSettlementDenialSectionRegressionText = readText(reportContractDocPageReleasePostActionSettlementDenialSectionRegressionPath);
  const reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-post-action-acceptance-denial-section-regression.mjs');
  const reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionText = readText(reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionPath);
  const reportContractDocPageReleasePostActionPaymentDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-post-action-payment-denial-section-regression.mjs');
  const reportContractDocPageReleasePostActionPaymentDenialSectionRegressionText = readText(reportContractDocPageReleasePostActionPaymentDenialSectionRegressionPath);
  const reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-post-action-deployment-denial-section-regression.mjs');
  const reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionText = readText(reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionPath);
  const reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-post-action-provider-spend-denial-section-regression.mjs');
  const reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionText = readText(reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionPath);
  const reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-post-action-state-transition-denial-section-regression.mjs');
  const reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionText = readText(reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionPath);
  const reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression.mjs');
  const reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionText = readText(reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionPath);
  const reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-post-action-background-runner-denial-section-regression.mjs');
  const reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionText = readText(reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionPath);
  const reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionPath = path.join(packageRoot, 'src', 'report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression.mjs');
  const reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionText = readText(reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionPath);
  const reportManifestDriftRegressionPath = path.join(packageRoot, 'src', 'report-manifest-drift-regression.mjs');
  const reportManifestDriftRegressionText = readText(reportManifestDriftRegressionPath);
  const reportLatestRecoveryRegressionPath = path.join(packageRoot, 'src', 'report-latest-recovery-regression.mjs');
  const reportLatestRecoveryRegressionText = readText(reportLatestRecoveryRegressionPath);
  const reportBootstrapSeedRegressionPath = path.join(packageRoot, 'src', 'report-bootstrap-seed-regression.mjs');
  const reportBootstrapSeedRegressionText = readText(reportBootstrapSeedRegressionPath);
  const reportGateCleanRerunRegressionPath = path.join(packageRoot, 'src', 'report-gate-clean-rerun-regression.mjs');
  const reportGateCleanRerunRegressionText = readText(reportGateCleanRerunRegressionPath);
  const reportCleanGateIdempotenceRegressionPath = path.join(packageRoot, 'src', 'report-clean-gate-idempotence-regression.mjs');
  const reportCleanGateIdempotenceRegressionText = readText(reportCleanGateIdempotenceRegressionPath);
  const reportFinalSettlementRegressionPath = path.join(packageRoot, 'src', 'report-final-settlement-regression.mjs');
  const reportFinalSettlementRegressionText = readText(reportFinalSettlementRegressionPath);
  const reportPostFinalDriftRegressionPath = path.join(packageRoot, 'src', 'report-post-final-drift-regression.mjs');
  const reportPostFinalDriftRegressionText = readText(reportPostFinalDriftRegressionPath);
  const reportCloseoutDriftClassificationRegressionPath = path.join(packageRoot, 'src', 'report-closeout-drift-classification-regression.mjs');
  const reportCloseoutDriftClassificationRegressionText = readText(reportCloseoutDriftClassificationRegressionPath);
  const reportCloseoutCommandInventoryRegressionPath = path.join(packageRoot, 'src', 'report-closeout-command-inventory-regression.mjs');
  const reportCloseoutCommandInventoryRegressionText = readText(reportCloseoutCommandInventoryRegressionPath);
  const reportRunnerContractRegressionPath = path.join(packageRoot, 'src', 'report-runner-contract-regression.mjs');
  const reportRunnerContractRegressionText = readText(reportRunnerContractRegressionPath);
  const reportRetentionPath = path.join(packageRoot, 'src', 'prune-reports.mjs');
  const reportRetentionText = readText(reportRetentionPath);
  const reportRetentionRegressionPath = path.join(packageRoot, 'src', 'report-retention-regression.mjs');
  const reportRetentionRegressionText = readText(reportRetentionRegressionPath);
  const integrationGateToolingPath = path.join(packageRoot, 'src', 'integration-gate-tooling.mjs');
  const integrationGateToolingText = readText(integrationGateToolingPath);
  const channelImportAllowlistPath = path.join(packageRoot, 'src', 'channel-import-allowlist.mjs');
  const channelImportAllowlistText = readText(channelImportAllowlistPath);
  const packageRootResolverPath = path.join(packageRoot, 'src', 'package-root-resolver.mjs');
  const packageRootResolverText = readText(packageRootResolverPath);
  const packageRootImportMigrationPath = path.join(packageRoot, 'src', 'package-root-import-migration.mjs');
  const packageRootImportMigrationText = readText(packageRootImportMigrationPath);
  const packageRootImportRegressionPath = path.join(packageRoot, 'src', 'package-root-import-regression.mjs');
  const packageRootImportRegressionText = readText(packageRootImportRegressionPath);
  const packageRootSymbolManifestPath = path.join(packageRoot, 'src', 'package-root-symbol-manifest.mjs');
  const packageRootSymbolManifestText = readText(packageRootSymbolManifestPath);
  const packageRootSymbolRegressionPath = path.join(packageRoot, 'src', 'package-root-symbol-regression.mjs');
  const packageRootSymbolRegressionText = readText(packageRootSymbolRegressionPath);
  const packageRootSymbolMinimizationPath = path.join(packageRoot, 'src', 'package-root-symbol-minimization.mjs');
  const packageRootSymbolMinimizationText = readText(packageRootSymbolMinimizationPath);
  const publicModules = publicModulesFromIndex();
  const compatibilityModules = compatibilityModulesFromIndex();
  return {
    packageName: packageJson.name || null,
    privatePackage: packageJson.private === true,
    packageExportSurface,
    packageExportsRootPublic: packageExportSurface.rootExportTarget === INTEGRATION_GATE_TOOLING_PACKAGE_EXPORTS['.'],
    packageExportsPackageJson: packageExportSurface.packageJsonExportPresent,
    packageExportsDeepSrcCount: packageExportSurface.packageDeepSrcExportCount,
    packageExportsExtraCount: packageExportSurface.packageExtraExportCount,
    packageExportsStableOnly: packageExportSurface.packageStableOnly,
    srcFileCount: srcFiles.length,
    publicModuleCount: publicModules.length,
    publicModules,
    compatibilityModuleCount: compatibilityModules.length,
    compatibilityModules,
    exportedModuleCount: publicModules.length + compatibilityModules.length,
    boundaries: CORE_RUNTIME_BOUNDARIES,
    designReferenceSpecDescriptorPresent: srcText.includes('designReferenceSpec'),
    designReferenceRuntimeModulePresent: /design-reference|reference-package|refpack/i.test(srcFiles.map(relative).join('\n')),
    llmDesignReferenceResolverPresent: publicModules.includes('llm-design-reference-resolver')
      && fs.existsSync(path.join(packageRoot, 'src', 'llm-design-reference-resolver.mjs'))
      && srcText.includes('resolveLlmDesignReferenceSpec'),
    buyerAssetPackageModulePresent: /buyer-asset|source-asset|asset-package/i.test(srcFiles.map(relative).join('\n')),
    workflowRegistryPresent: publicModules.includes('workflow-registry'),
    runnerSdkPresent: publicModules.includes('adapter-runner-sdk'),
    lifecycleSurfaceModulePresent: fs.existsSync(lifecycleSurfacePath),
    lifecycleSurfacePublic: publicModules.includes('external-action-lifecycle'),
    lifecycleSurfaceVersioned: lifecycleSurfaceText.includes('EXTERNAL_ACTION_LIFECYCLE_SURFACE_VERSION')
      && lifecycleSurfaceText.includes('summarizeExternalActionLifecycleSurface')
      && lifecycleSurfaceText.includes('external-action-lifecycle-schema.mjs'),
    lifecycleSchemaModulePresent: fs.existsSync(lifecycleSchemaPath),
    lifecycleSchemaPublic: publicModules.includes('external-action-lifecycle-schema'),
    lifecycleSchemaVersioned: lifecycleSchemaText.includes('EXTERNAL_ACTION_LIFECYCLE_SCHEMA_VERSION')
      && lifecycleSchemaText.includes('buildExternalActionLifecycleSchema')
      && lifecycleSchemaText.includes('validateExternalActionLifecycleChain'),
    lifecycleSchemaProfileCount: (lifecycleSchemaText.match(/profileId:\s*'/g) || []).length,
    contractSchemaModulePresent: fs.existsSync(contractSchemaPath),
    contractSchemaPublic: publicModules.includes('contract-schema'),
    contractSchemaVersioned: contractSchemaText.includes('CONTRACT_JSON_SCHEMA_VERSION')
      && contractSchemaText.includes('buildContractJsonSchema')
      && contractSchemaText.includes('validateContractJsonSchemaSnapshot'),
    contractSchemaExportScriptPresent: packageJson.scripts?.['schema:contracts'] === 'node src/export-contract-schemas.mjs',
    compatibilityPolicyModulePresent: fs.existsSync(compatibilityPolicyPath),
    compatibilityPolicyPublic: publicModules.includes('compatibility-export-policy'),
    compatibilityPolicyVersioned: compatibilityPolicyText.includes('COMPATIBILITY_EXPORT_POLICY_VERSION')
      && compatibilityPolicyText.includes('summarizeCompatibilityExportPolicy')
      && compatibilityPolicyText.includes('validateCompatibilityExportPolicy'),
    compatibilityPolicyScriptPresent: packageJson.scripts?.['compatibility:policy'] === 'node src/export-compatibility-policy.mjs --strict',
    readOnlyReportChainModulePresent: fs.existsSync(readOnlyReportChainPath),
    readOnlyReportChainPublic: publicModules.includes('read-only-report-chain'),
    readOnlyReportChainVersioned: readOnlyReportChainText.includes('READ_ONLY_REPORT_CHAIN_VERSION')
      && readOnlyReportChainText.includes('buildReadOnlyReportChain')
      && readOnlyReportChainText.includes('summarizeReadOnlyReportChain'),
    readOnlyReportChainScriptPresent: packageJson.scripts?.['readonly:report-chain'] === 'node src/export-readonly-report-chain.mjs --strict',
    reportFreshnessModulePresent: fs.existsSync(reportFreshnessPath),
    reportFreshnessPublic: publicModules.includes(REPORT_FRESHNESS_STABLE_MODULE_ID),
    reportFreshnessVersioned: reportFreshnessText.includes('REPORT_FRESHNESS_VERSION')
      && reportFreshnessText.includes('buildReportFreshnessReport')
      && reportFreshnessText.includes('summarizeReportFreshness'),
    reportFreshnessScriptPresent: packageJson.scripts?.['reports:freshness'] === 'node src/export-report-freshness.mjs --strict',
    reportFreshnessRegressionModulePresent: fs.existsSync(reportFreshnessRegressionPath),
    reportFreshnessRegressionVersioned: reportFreshnessRegressionText.includes('REPORT_FRESHNESS_REGRESSION_VERSION')
      && reportFreshnessRegressionText.includes('buildReportFreshnessRegressionReport')
      && reportFreshnessRegressionText.includes('summarizeReportFreshnessRegressionReport'),
    reportFreshnessRegressionScriptPresent: packageJson.scripts?.['reports:freshness-regression'] === 'node src/export-report-freshness-regression.mjs --strict',
    integrationGateSequenceRegressionModulePresent: fs.existsSync(integrationGateSequenceRegressionPath),
    integrationGateSequenceRegressionVersioned: integrationGateSequenceRegressionText.includes('INTEGRATION_GATE_SEQUENCE_REGRESSION_VERSION')
      && integrationGateSequenceRegressionText.includes('buildIntegrationGateSequenceRegressionReport')
      && integrationGateSequenceRegressionText.includes('summarizeIntegrationGateSequenceRegressionReport'),
    integrationGateSequenceRegressionScriptPresent: packageJson.scripts?.['reports:gate-sequence-regression'] === 'node src/export-integration-gate-sequence-regression.mjs --strict',
    reportInventoryConsistencyModulePresent: fs.existsSync(reportInventoryConsistencyPath),
    reportInventoryConsistencyVersioned: reportInventoryConsistencyText.includes('REPORT_INVENTORY_CONSISTENCY_VERSION')
      && reportInventoryConsistencyText.includes('buildReportInventoryConsistencyReport')
      && reportInventoryConsistencyText.includes('summarizeReportInventoryConsistencyReport'),
    reportInventoryConsistencyScriptPresent: packageJson.scripts?.['reports:inventory-consistency'] === 'node src/export-report-inventory-consistency.mjs --strict',
    reportSchemaContractModulePresent: fs.existsSync(reportSchemaContractPath),
    reportSchemaContractVersioned: reportSchemaContractText.includes('REPORT_SCHEMA_CONTRACT_VERSION')
      && reportSchemaContractText.includes('buildReportSchemaContractReport')
      && reportSchemaContractText.includes('summarizeReportSchemaContractReport'),
    reportSchemaContractScriptPresent: packageJson.scripts?.['reports:schema-contract'] === 'node src/export-report-schema-contract.mjs --strict',
    reportLineageTopologyModulePresent: fs.existsSync(reportLineageTopologyPath),
    reportLineageTopologyVersioned: reportLineageTopologyText.includes('REPORT_LINEAGE_TOPOLOGY_VERSION')
      && reportLineageTopologyText.includes('buildReportLineageTopologyReport')
      && reportLineageTopologyText.includes('summarizeReportLineageTopologyReport'),
    reportLineageTopologyScriptPresent: packageJson.scripts?.['reports:lineage-topology'] === 'node src/export-report-lineage-topology.mjs --strict',
    reportHashStabilityRegressionModulePresent: fs.existsSync(reportHashStabilityRegressionPath),
    reportHashStabilityRegressionVersioned: reportHashStabilityRegressionText.includes('REPORT_HASH_STABILITY_REGRESSION_VERSION')
      && reportHashStabilityRegressionText.includes('buildReportHashStabilityRegressionReport')
      && reportHashStabilityRegressionText.includes('summarizeReportHashStabilityRegressionReport'),
    reportHashStabilityRegressionScriptPresent: packageJson.scripts?.['reports:hash-stability-regression'] === 'node src/export-report-hash-stability-regression.mjs --strict',
    reportOutputPairingModulePresent: fs.existsSync(reportOutputPairingPath),
    reportOutputPairingVersioned: reportOutputPairingText.includes('REPORT_OUTPUT_PAIRING_VERSION')
      && reportOutputPairingText.includes('buildReportOutputPairingReport')
      && reportOutputPairingText.includes('summarizeReportOutputPairingReport'),
    reportOutputPairingScriptPresent: packageJson.scripts?.['reports:output-pairing'] === 'node src/export-report-output-pairing.mjs --strict',
    reportArtifactReproducibilityModulePresent: fs.existsSync(reportArtifactReproducibilityPath),
    reportArtifactReproducibilityVersioned: reportArtifactReproducibilityText.includes('REPORT_ARTIFACT_REPRODUCIBILITY_VERSION')
      && reportArtifactReproducibilityText.includes('buildReportArtifactReproducibilityReport')
      && reportArtifactReproducibilityText.includes('summarizeReportArtifactReproducibilityReport'),
    reportArtifactReproducibilityScriptPresent: packageJson.scripts?.['reports:artifact-reproducibility'] === 'node src/export-report-artifact-reproducibility.mjs --strict',
    reportSelfReferenceBoundaryRegressionModulePresent: fs.existsSync(reportSelfReferenceBoundaryRegressionPath),
    reportSelfReferenceBoundaryRegressionVersioned: reportSelfReferenceBoundaryRegressionText.includes('REPORT_SELF_REFERENCE_BOUNDARY_REGRESSION_VERSION')
      && reportSelfReferenceBoundaryRegressionText.includes('buildReportSelfReferenceBoundaryRegressionReport')
      && reportSelfReferenceBoundaryRegressionText.includes('summarizeReportSelfReferenceBoundaryRegressionReport'),
    reportSelfReferenceBoundaryRegressionScriptPresent: packageJson.scripts?.['reports:self-reference-boundary-regression'] === 'node src/export-report-self-reference-boundary-regression.mjs --strict',
    reportContractManifestModulePresent: fs.existsSync(reportContractManifestPath),
    reportContractManifestVersioned: reportContractManifestText.includes('REPORT_CONTRACT_MANIFEST_VERSION')
      && reportContractManifestText.includes('REPORT_CONTRACT_MANIFEST')
      && reportContractManifestText.includes('buildReportContractManifestReport')
      && reportContractManifestText.includes('summarizeReportContractManifestReport'),
    reportContractManifestScriptPresent: packageJson.scripts?.['reports:contract-manifest'] === 'node src/export-report-contract-manifest.mjs --strict',
    reportContractRequiredCoverageRegressionModulePresent: fs.existsSync(reportContractRequiredCoverageRegressionPath),
    reportContractRequiredCoverageRegressionVersioned: reportContractRequiredCoverageRegressionText.includes('REPORT_CONTRACT_REQUIRED_COVERAGE_REGRESSION_VERSION')
      && reportContractRequiredCoverageRegressionText.includes('buildReportContractRequiredCoverageRegressionReport')
      && reportContractRequiredCoverageRegressionText.includes('summarizeReportContractRequiredCoverageRegressionReport'),
    reportContractRequiredCoverageRegressionScriptPresent: packageJson.scripts?.['reports:contract-required-coverage-regression'] === 'node src/export-report-contract-required-coverage-regression.mjs --strict',
    reportContractDocCoverageRegressionModulePresent: fs.existsSync(reportContractDocCoverageRegressionPath),
    reportContractDocCoverageRegressionVersioned: reportContractDocCoverageRegressionText.includes('REPORT_CONTRACT_DOC_COVERAGE_REGRESSION_VERSION')
      && reportContractDocCoverageRegressionText.includes('buildReportContractDocCoverageRegressionReport')
      && reportContractDocCoverageRegressionText.includes('summarizeReportContractDocCoverageRegressionReport'),
    reportContractDocCoverageRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-coverage-regression'] === 'node src/export-report-contract-doc-coverage-regression.mjs --strict',
    reportContractSyntaxCoverageRegressionModulePresent: fs.existsSync(reportContractSyntaxCoverageRegressionPath),
    reportContractSyntaxCoverageRegressionVersioned: reportContractSyntaxCoverageRegressionText.includes('REPORT_CONTRACT_SYNTAX_COVERAGE_REGRESSION_VERSION')
      && reportContractSyntaxCoverageRegressionText.includes('buildReportContractSyntaxCoverageRegressionReport')
      && reportContractSyntaxCoverageRegressionText.includes('summarizeReportContractSyntaxCoverageRegressionReport'),
    reportContractSyntaxCoverageRegressionScriptPresent: packageJson.scripts?.['reports:contract-syntax-coverage-regression'] === 'node src/export-report-contract-syntax-coverage-regression.mjs --strict',
    reportContractSourceDerivationRegressionModulePresent: fs.existsSync(reportContractSourceDerivationRegressionPath),
    reportContractSourceDerivationRegressionVersioned: reportContractSourceDerivationRegressionText.includes('REPORT_CONTRACT_SOURCE_DERIVATION_REGRESSION_VERSION')
      && reportContractSourceDerivationRegressionText.includes('buildReportContractSourceDerivationRegressionReport')
      && reportContractSourceDerivationRegressionText.includes('summarizeReportContractSourceDerivationRegressionReport'),
    reportContractSourceDerivationRegressionScriptPresent: packageJson.scripts?.['reports:contract-source-derivation-regression'] === 'node src/export-report-contract-source-derivation-regression.mjs --strict',
    reportContractSummaryKeyRegressionModulePresent: fs.existsSync(reportContractSummaryKeyRegressionPath),
    reportContractSummaryKeyRegressionVersioned: reportContractSummaryKeyRegressionText.includes('REPORT_CONTRACT_SUMMARY_KEY_REGRESSION_VERSION')
      && reportContractSummaryKeyRegressionText.includes('buildReportContractSummaryKeyRegressionReport')
      && reportContractSummaryKeyRegressionText.includes('summarizeReportContractSummaryKeyRegressionReport'),
    reportContractSummaryKeyRegressionScriptPresent: packageJson.scripts?.['reports:contract-summary-key-regression'] === 'node src/export-report-contract-summary-key-regression.mjs --strict',
    reportContractAuditForwardingRegressionModulePresent: fs.existsSync(reportContractAuditForwardingRegressionPath),
    reportContractAuditForwardingRegressionVersioned: reportContractAuditForwardingRegressionText.includes('REPORT_CONTRACT_AUDIT_FORWARDING_REGRESSION_VERSION')
      && reportContractAuditForwardingRegressionText.includes('buildReportContractAuditForwardingRegressionReport')
      && reportContractAuditForwardingRegressionText.includes('summarizeReportContractAuditForwardingRegressionReport'),
    reportContractAuditForwardingRegressionScriptPresent: packageJson.scripts?.['reports:contract-audit-forwarding-regression'] === 'node src/export-report-contract-audit-forwarding-regression.mjs --strict',
    reportContractCheckpointBindingShapeRegressionModulePresent: fs.existsSync(reportContractCheckpointBindingShapeRegressionPath),
    reportContractCheckpointBindingShapeRegressionVersioned: reportContractCheckpointBindingShapeRegressionText.includes('REPORT_CONTRACT_CHECKPOINT_BINDING_SHAPE_REGRESSION_VERSION')
      && reportContractCheckpointBindingShapeRegressionText.includes('buildReportContractCheckpointBindingShapeRegressionReport')
      && reportContractCheckpointBindingShapeRegressionText.includes('summarizeReportContractCheckpointBindingShapeRegressionReport'),
    reportContractCheckpointBindingShapeRegressionScriptPresent: packageJson.scripts?.['reports:contract-checkpoint-binding-shape-regression'] === 'node src/export-report-contract-checkpoint-binding-shape-regression.mjs --strict',
    reportContractGateSummaryShapeRegressionModulePresent: fs.existsSync(reportContractGateSummaryShapeRegressionPath),
    reportContractGateSummaryShapeRegressionVersioned: reportContractGateSummaryShapeRegressionText.includes('REPORT_CONTRACT_GATE_SUMMARY_SHAPE_REGRESSION_VERSION')
      && reportContractGateSummaryShapeRegressionText.includes('buildReportContractGateSummaryShapeRegressionReport')
      && reportContractGateSummaryShapeRegressionText.includes('summarizeReportContractGateSummaryShapeRegressionReport'),
    reportContractGateSummaryShapeRegressionScriptPresent: packageJson.scripts?.['reports:contract-gate-summary-shape-regression'] === 'node src/export-report-contract-gate-summary-shape-regression.mjs --strict',
    reportContractExporterStdoutShapeRegressionModulePresent: fs.existsSync(reportContractExporterStdoutShapeRegressionPath),
    reportContractExporterStdoutShapeRegressionVersioned: reportContractExporterStdoutShapeRegressionText.includes('REPORT_CONTRACT_EXPORTER_STDOUT_SHAPE_REGRESSION_VERSION')
      && reportContractExporterStdoutShapeRegressionText.includes('buildReportContractExporterStdoutShapeRegressionReport')
      && reportContractExporterStdoutShapeRegressionText.includes('summarizeReportContractExporterStdoutShapeRegressionReport'),
    reportContractExporterStdoutShapeRegressionScriptPresent: packageJson.scripts?.['reports:contract-exporter-stdout-shape-regression'] === 'node src/export-report-contract-exporter-stdout-shape-regression.mjs --strict',
    reportContractSafetyFlagRegressionModulePresent: fs.existsSync(reportContractSafetyFlagRegressionPath),
    reportContractSafetyFlagRegressionVersioned: reportContractSafetyFlagRegressionText.includes('REPORT_CONTRACT_SAFETY_FLAG_REGRESSION_VERSION')
      && reportContractSafetyFlagRegressionText.includes('buildReportContractSafetyFlagRegressionReport')
      && reportContractSafetyFlagRegressionText.includes('summarizeReportContractSafetyFlagRegressionReport'),
    reportContractSafetyFlagRegressionScriptPresent: packageJson.scripts?.['reports:contract-safety-flag-regression'] === 'node src/export-report-contract-safety-flag-regression.mjs --strict',
    reportContractArtifactBindingRegressionModulePresent: fs.existsSync(reportContractArtifactBindingRegressionPath),
    reportContractArtifactBindingRegressionVersioned: reportContractArtifactBindingRegressionText.includes('REPORT_CONTRACT_ARTIFACT_BINDING_REGRESSION_VERSION')
      && reportContractArtifactBindingRegressionText.includes('buildReportContractArtifactBindingRegressionReport')
      && reportContractArtifactBindingRegressionText.includes('summarizeReportContractArtifactBindingRegressionReport'),
    reportContractArtifactBindingRegressionScriptPresent: packageJson.scripts?.['reports:contract-artifact-binding-regression'] === 'node src/export-report-contract-artifact-binding-regression.mjs --strict',
    reportContractDocIndexAnchorRegressionModulePresent: fs.existsSync(reportContractDocIndexAnchorRegressionPath),
    reportContractDocIndexAnchorRegressionVersioned: reportContractDocIndexAnchorRegressionText.includes('REPORT_CONTRACT_DOC_INDEX_ANCHOR_REGRESSION_VERSION')
      && reportContractDocIndexAnchorRegressionText.includes('buildReportContractDocIndexAnchorRegressionReport')
      && reportContractDocIndexAnchorRegressionText.includes('summarizeReportContractDocIndexAnchorRegressionReport'),
    reportContractDocIndexAnchorRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-index-anchor-regression'] === 'node src/export-report-contract-doc-index-anchor-regression.mjs --strict',
    reportContractDocPageLatestDetailRegressionModulePresent: fs.existsSync(reportContractDocPageLatestDetailRegressionPath),
    reportContractDocPageLatestDetailRegressionVersioned: reportContractDocPageLatestDetailRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_LATEST_DETAIL_REGRESSION_VERSION')
      && reportContractDocPageLatestDetailRegressionText.includes('buildReportContractDocPageLatestDetailRegressionReport')
      && reportContractDocPageLatestDetailRegressionText.includes('summarizeReportContractDocPageLatestDetailRegressionReport'),
    reportContractDocPageLatestDetailRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-latest-detail-regression'] === 'node src/export-report-contract-doc-page-latest-detail-regression.mjs --strict',
    reportContractDocPageCommandSectionRegressionModulePresent: fs.existsSync(reportContractDocPageCommandSectionRegressionPath),
    reportContractDocPageCommandSectionRegressionVersioned: reportContractDocPageCommandSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_REGRESSION_VERSION')
      && reportContractDocPageCommandSectionRegressionText.includes('buildReportContractDocPageCommandSectionRegressionReport')
      && reportContractDocPageCommandSectionRegressionText.includes('summarizeReportContractDocPageCommandSectionRegressionReport'),
    reportContractDocPageCommandSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-command-section-regression'] === 'node src/export-report-contract-doc-page-command-section-regression.mjs --strict',
    reportContractDocPageSafetySectionDetailRegressionModulePresent: fs.existsSync(reportContractDocPageSafetySectionDetailRegressionPath),
    reportContractDocPageSafetySectionDetailRegressionVersioned: reportContractDocPageSafetySectionDetailRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_DETAIL_REGRESSION_VERSION')
      && reportContractDocPageSafetySectionDetailRegressionText.includes('buildReportContractDocPageSafetySectionDetailRegressionReport')
      && reportContractDocPageSafetySectionDetailRegressionText.includes('summarizeReportContractDocPageSafetySectionDetailRegressionReport'),
    reportContractDocPageSafetySectionDetailRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-safety-section-detail-regression'] === 'node src/export-report-contract-doc-page-safety-section-detail-regression.mjs --strict',
    reportContractDocPageStrictGateSectionRegressionModulePresent: fs.existsSync(reportContractDocPageStrictGateSectionRegressionPath),
    reportContractDocPageStrictGateSectionRegressionVersioned: reportContractDocPageStrictGateSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_REGRESSION_VERSION')
      && reportContractDocPageStrictGateSectionRegressionText.includes('buildReportContractDocPageStrictGateSectionRegressionReport')
      && reportContractDocPageStrictGateSectionRegressionText.includes('summarizeReportContractDocPageStrictGateSectionRegressionReport'),
    reportContractDocPageStrictGateSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-strict-gate-section-regression'] === 'node src/export-report-contract-doc-page-strict-gate-section-regression.mjs --strict',
    reportContractDocPageOutputSectionRegressionModulePresent: fs.existsSync(reportContractDocPageOutputSectionRegressionPath),
    reportContractDocPageOutputSectionRegressionVersioned: reportContractDocPageOutputSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_REGRESSION_VERSION')
      && reportContractDocPageOutputSectionRegressionText.includes('buildReportContractDocPageOutputSectionRegressionReport')
      && reportContractDocPageOutputSectionRegressionText.includes('summarizeReportContractDocPageOutputSectionRegressionReport'),
    reportContractDocPageOutputSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-output-section-regression'] === 'node src/export-report-contract-doc-page-output-section-regression.mjs --strict',
    reportContractDocPageCrossReportSectionRegressionModulePresent: fs.existsSync(reportContractDocPageCrossReportSectionRegressionPath),
    reportContractDocPageCrossReportSectionRegressionVersioned: reportContractDocPageCrossReportSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_CROSS_REPORT_SECTION_REGRESSION_VERSION')
      && reportContractDocPageCrossReportSectionRegressionText.includes('buildReportContractDocPageCrossReportSectionRegressionReport')
      && reportContractDocPageCrossReportSectionRegressionText.includes('summarizeReportContractDocPageCrossReportSectionRegressionReport'),
    reportContractDocPageCrossReportSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-cross-report-section-regression'] === 'node src/export-report-contract-doc-page-cross-report-section-regression.mjs --strict',
    reportContractDocPageCloseoutSectionRegressionModulePresent: fs.existsSync(reportContractDocPageCloseoutSectionRegressionPath),
    reportContractDocPageCloseoutSectionRegressionVersioned: reportContractDocPageCloseoutSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_REGRESSION_VERSION')
      && reportContractDocPageCloseoutSectionRegressionText.includes('buildReportContractDocPageCloseoutSectionRegressionReport')
      && reportContractDocPageCloseoutSectionRegressionText.includes('summarizeReportContractDocPageCloseoutSectionRegressionReport'),
    reportContractDocPageCloseoutSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-closeout-section-regression'] === 'node src/export-report-contract-doc-page-closeout-section-regression.mjs --strict',
    reportContractDocPagePostGateWriterSectionRegressionModulePresent: fs.existsSync(reportContractDocPagePostGateWriterSectionRegressionPath),
    reportContractDocPagePostGateWriterSectionRegressionVersioned: reportContractDocPagePostGateWriterSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_POST_GATE_WRITER_SECTION_REGRESSION_VERSION')
      && reportContractDocPagePostGateWriterSectionRegressionText.includes('buildReportContractDocPagePostGateWriterSectionRegressionReport')
      && reportContractDocPagePostGateWriterSectionRegressionText.includes('summarizeReportContractDocPagePostGateWriterSectionRegressionReport'),
    reportContractDocPagePostGateWriterSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-post-gate-writer-section-regression'] === 'node src/export-report-contract-doc-page-post-gate-writer-section-regression.mjs --strict',
    reportContractDocPageRetentionSectionRegressionModulePresent: fs.existsSync(reportContractDocPageRetentionSectionRegressionPath),
    reportContractDocPageRetentionSectionRegressionVersioned: reportContractDocPageRetentionSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RETENTION_SECTION_REGRESSION_VERSION')
      && reportContractDocPageRetentionSectionRegressionText.includes('buildReportContractDocPageRetentionSectionRegressionReport')
      && reportContractDocPageRetentionSectionRegressionText.includes('summarizeReportContractDocPageRetentionSectionRegressionReport'),
    reportContractDocPageRetentionSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-retention-section-regression'] === 'node src/export-report-contract-doc-page-retention-section-regression.mjs --strict',
    reportContractDocPageFreshnessHashSectionRegressionModulePresent: fs.existsSync(reportContractDocPageFreshnessHashSectionRegressionPath),
    reportContractDocPageFreshnessHashSectionRegressionVersioned: reportContractDocPageFreshnessHashSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_REGRESSION_VERSION')
      && reportContractDocPageFreshnessHashSectionRegressionText.includes('buildReportContractDocPageFreshnessHashSectionRegressionReport')
      && reportContractDocPageFreshnessHashSectionRegressionText.includes('summarizeReportContractDocPageFreshnessHashSectionRegressionReport'),
    reportContractDocPageFreshnessHashSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-freshness-hash-section-regression'] === 'node src/export-report-contract-doc-page-freshness-hash-section-regression.mjs --strict',
    reportContractDocPageCheckpointHashSectionRegressionModulePresent: fs.existsSync(reportContractDocPageCheckpointHashSectionRegressionPath),
    reportContractDocPageCheckpointHashSectionRegressionVersioned: reportContractDocPageCheckpointHashSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_CHECKPOINT_HASH_SECTION_REGRESSION_VERSION')
      && reportContractDocPageCheckpointHashSectionRegressionText.includes('buildReportContractDocPageCheckpointHashSectionRegressionReport')
      && reportContractDocPageCheckpointHashSectionRegressionText.includes('summarizeReportContractDocPageCheckpointHashSectionRegressionReport'),
    reportContractDocPageCheckpointHashSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-checkpoint-hash-section-regression'] === 'node src/export-report-contract-doc-page-checkpoint-hash-section-regression.mjs --strict',
    reportContractDocPageBootstrapSeedSectionRegressionModulePresent: fs.existsSync(reportContractDocPageBootstrapSeedSectionRegressionPath),
    reportContractDocPageBootstrapSeedSectionRegressionVersioned: reportContractDocPageBootstrapSeedSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_REGRESSION_VERSION')
      && reportContractDocPageBootstrapSeedSectionRegressionText.includes('buildReportContractDocPageBootstrapSeedSectionRegressionReport')
      && reportContractDocPageBootstrapSeedSectionRegressionText.includes('summarizeReportContractDocPageBootstrapSeedSectionRegressionReport'),
    reportContractDocPageBootstrapSeedSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-bootstrap-seed-section-regression'] === 'node src/export-report-contract-doc-page-bootstrap-seed-section-regression.mjs --strict',
    reportContractDocPageCleanRerunSectionRegressionModulePresent: fs.existsSync(reportContractDocPageCleanRerunSectionRegressionPath),
    reportContractDocPageCleanRerunSectionRegressionVersioned: reportContractDocPageCleanRerunSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_CLEAN_RERUN_SECTION_REGRESSION_VERSION')
      && reportContractDocPageCleanRerunSectionRegressionText.includes('buildReportContractDocPageCleanRerunSectionRegressionReport')
      && reportContractDocPageCleanRerunSectionRegressionText.includes('summarizeReportContractDocPageCleanRerunSectionRegressionReport'),
    reportContractDocPageCleanRerunSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-clean-rerun-section-regression'] === 'node src/export-report-contract-doc-page-clean-rerun-section-regression.mjs --strict',
    reportContractDocPageFinalSettlementSectionRegressionModulePresent: fs.existsSync(reportContractDocPageFinalSettlementSectionRegressionPath),
    reportContractDocPageFinalSettlementSectionRegressionVersioned: reportContractDocPageFinalSettlementSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_FINAL_SETTLEMENT_SECTION_REGRESSION_VERSION')
      && reportContractDocPageFinalSettlementSectionRegressionText.includes('buildReportContractDocPageFinalSettlementSectionRegressionReport')
      && reportContractDocPageFinalSettlementSectionRegressionText.includes('summarizeReportContractDocPageFinalSettlementSectionRegressionReport'),
    reportContractDocPageFinalSettlementSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-final-settlement-section-regression'] === 'node src/export-report-contract-doc-page-final-settlement-section-regression.mjs --strict',
    reportContractDocPageCloseoutIndexSectionRegressionModulePresent: fs.existsSync(reportContractDocPageCloseoutIndexSectionRegressionPath),
    reportContractDocPageCloseoutIndexSectionRegressionVersioned: reportContractDocPageCloseoutIndexSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_REGRESSION_VERSION')
      && reportContractDocPageCloseoutIndexSectionRegressionText.includes('buildReportContractDocPageCloseoutIndexSectionRegressionReport')
      && reportContractDocPageCloseoutIndexSectionRegressionText.includes('summarizeReportContractDocPageCloseoutIndexSectionRegressionReport'),
    reportContractDocPageCloseoutIndexSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-closeout-index-section-regression'] === 'node src/export-report-contract-doc-page-closeout-index-section-regression.mjs --strict',
    reportContractDocPageCloseoutEvidenceSectionRegressionModulePresent: fs.existsSync(reportContractDocPageCloseoutEvidenceSectionRegressionPath),
    reportContractDocPageCloseoutEvidenceSectionRegressionVersioned: reportContractDocPageCloseoutEvidenceSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_EVIDENCE_SECTION_REGRESSION_VERSION')
      && reportContractDocPageCloseoutEvidenceSectionRegressionText.includes('buildReportContractDocPageCloseoutEvidenceSectionRegressionReport')
      && reportContractDocPageCloseoutEvidenceSectionRegressionText.includes('summarizeReportContractDocPageCloseoutEvidenceSectionRegressionReport'),
    reportContractDocPageCloseoutEvidenceSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-closeout-evidence-section-regression'] === 'node src/export-report-contract-doc-page-closeout-evidence-section-regression.mjs --strict',
    reportContractDocPageCloseoutLedgerSectionRegressionModulePresent: fs.existsSync(reportContractDocPageCloseoutLedgerSectionRegressionPath),
    reportContractDocPageCloseoutLedgerSectionRegressionVersioned: reportContractDocPageCloseoutLedgerSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_REGRESSION_VERSION')
      && reportContractDocPageCloseoutLedgerSectionRegressionText.includes('buildReportContractDocPageCloseoutLedgerSectionRegressionReport')
      && reportContractDocPageCloseoutLedgerSectionRegressionText.includes('summarizeReportContractDocPageCloseoutLedgerSectionRegressionReport'),
    reportContractDocPageCloseoutLedgerSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-closeout-ledger-section-regression'] === 'node src/export-report-contract-doc-page-closeout-ledger-section-regression.mjs --strict',
    reportContractDocPageCloseoutRetentionProofSectionRegressionModulePresent: fs.existsSync(reportContractDocPageCloseoutRetentionProofSectionRegressionPath),
    reportContractDocPageCloseoutRetentionProofSectionRegressionVersioned: reportContractDocPageCloseoutRetentionProofSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_RETENTION_PROOF_SECTION_REGRESSION_VERSION')
      && reportContractDocPageCloseoutRetentionProofSectionRegressionText.includes('buildReportContractDocPageCloseoutRetentionProofSectionRegressionReport')
      && reportContractDocPageCloseoutRetentionProofSectionRegressionText.includes('summarizeReportContractDocPageCloseoutRetentionProofSectionRegressionReport'),
    reportContractDocPageCloseoutRetentionProofSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-closeout-retention-proof-section-regression'] === 'node src/export-report-contract-doc-page-closeout-retention-proof-section-regression.mjs --strict',
    reportContractDocPageCloseoutProbeBundleSectionRegressionModulePresent: fs.existsSync(reportContractDocPageCloseoutProbeBundleSectionRegressionPath),
    reportContractDocPageCloseoutProbeBundleSectionRegressionVersioned: reportContractDocPageCloseoutProbeBundleSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_PROBE_BUNDLE_SECTION_REGRESSION_VERSION')
      && reportContractDocPageCloseoutProbeBundleSectionRegressionText.includes('buildReportContractDocPageCloseoutProbeBundleSectionRegressionReport')
      && reportContractDocPageCloseoutProbeBundleSectionRegressionText.includes('summarizeReportContractDocPageCloseoutProbeBundleSectionRegressionReport'),
    reportContractDocPageCloseoutProbeBundleSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-closeout-probe-bundle-section-regression'] === 'node src/export-report-contract-doc-page-closeout-probe-bundle-section-regression.mjs --strict',
    reportContractDocPageCloseoutSignoffSectionRegressionModulePresent: fs.existsSync(reportContractDocPageCloseoutSignoffSectionRegressionPath),
    reportContractDocPageCloseoutSignoffSectionRegressionVersioned: reportContractDocPageCloseoutSignoffSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SIGNOFF_SECTION_REGRESSION_VERSION')
      && reportContractDocPageCloseoutSignoffSectionRegressionText.includes('buildReportContractDocPageCloseoutSignoffSectionRegressionReport')
      && reportContractDocPageCloseoutSignoffSectionRegressionText.includes('summarizeReportContractDocPageCloseoutSignoffSectionRegressionReport'),
    reportContractDocPageCloseoutSignoffSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-closeout-signoff-section-regression'] === 'node src/export-report-contract-doc-page-closeout-signoff-section-regression.mjs --strict',
    reportContractDocPageCloseoutReleaseManifestSectionRegressionModulePresent: fs.existsSync(reportContractDocPageCloseoutReleaseManifestSectionRegressionPath),
    reportContractDocPageCloseoutReleaseManifestSectionRegressionVersioned: reportContractDocPageCloseoutReleaseManifestSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_RELEASE_MANIFEST_SECTION_REGRESSION_VERSION')
      && reportContractDocPageCloseoutReleaseManifestSectionRegressionText.includes('buildReportContractDocPageCloseoutReleaseManifestSectionRegressionReport')
      && reportContractDocPageCloseoutReleaseManifestSectionRegressionText.includes('summarizeReportContractDocPageCloseoutReleaseManifestSectionRegressionReport'),
    reportContractDocPageCloseoutReleaseManifestSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-closeout-release-manifest-section-regression'] === 'node src/export-report-contract-doc-page-closeout-release-manifest-section-regression.mjs --strict',
    reportContractDocPageReleaseArchiveIndexSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseArchiveIndexSectionRegressionPath),
    reportContractDocPageReleaseArchiveIndexSectionRegressionVersioned: reportContractDocPageReleaseArchiveIndexSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_ARCHIVE_INDEX_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseArchiveIndexSectionRegressionText.includes('buildReportContractDocPageReleaseArchiveIndexSectionRegressionReport')
      && reportContractDocPageReleaseArchiveIndexSectionRegressionText.includes('summarizeReportContractDocPageReleaseArchiveIndexSectionRegressionReport'),
    reportContractDocPageReleaseArchiveIndexSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-archive-index-section-regression'] === 'node src/export-report-contract-doc-page-release-archive-index-section-regression.mjs --strict',
    reportContractDocPageReleaseHandoffLedgerSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseHandoffLedgerSectionRegressionPath),
    reportContractDocPageReleaseHandoffLedgerSectionRegressionVersioned: reportContractDocPageReleaseHandoffLedgerSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_HANDOFF_LEDGER_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseHandoffLedgerSectionRegressionText.includes('buildReportContractDocPageReleaseHandoffLedgerSectionRegressionReport')
      && reportContractDocPageReleaseHandoffLedgerSectionRegressionText.includes('summarizeReportContractDocPageReleaseHandoffLedgerSectionRegressionReport'),
    reportContractDocPageReleaseHandoffLedgerSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-handoff-ledger-section-regression'] === 'node src/export-report-contract-doc-page-release-handoff-ledger-section-regression.mjs --strict',
    reportContractDocPageReleaseDeliveryReadinessSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseDeliveryReadinessSectionRegressionPath),
    reportContractDocPageReleaseDeliveryReadinessSectionRegressionVersioned: reportContractDocPageReleaseDeliveryReadinessSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_DELIVERY_READINESS_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseDeliveryReadinessSectionRegressionText.includes('buildReportContractDocPageReleaseDeliveryReadinessSectionRegressionReport')
      && reportContractDocPageReleaseDeliveryReadinessSectionRegressionText.includes('summarizeReportContractDocPageReleaseDeliveryReadinessSectionRegressionReport'),
    reportContractDocPageReleaseDeliveryReadinessSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-delivery-readiness-section-regression'] === 'node src/export-report-contract-doc-page-release-delivery-readiness-section-regression.mjs --strict',
    reportContractDocPageReleaseExecutionDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseExecutionDenialSectionRegressionPath),
    reportContractDocPageReleaseExecutionDenialSectionRegressionVersioned: reportContractDocPageReleaseExecutionDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseExecutionDenialSectionRegressionText.includes('buildReportContractDocPageReleaseExecutionDenialSectionRegressionReport')
      && reportContractDocPageReleaseExecutionDenialSectionRegressionText.includes('summarizeReportContractDocPageReleaseExecutionDenialSectionRegressionReport'),
    reportContractDocPageReleaseExecutionDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-execution-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-execution-denial-section-regression.mjs --strict',
    reportContractDocPageReleaseOperatorApprovalSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseOperatorApprovalSectionRegressionPath),
    reportContractDocPageReleaseOperatorApprovalSectionRegressionVersioned: reportContractDocPageReleaseOperatorApprovalSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_OPERATOR_APPROVAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseOperatorApprovalSectionRegressionText.includes('buildReportContractDocPageReleaseOperatorApprovalSectionRegressionReport')
      && reportContractDocPageReleaseOperatorApprovalSectionRegressionText.includes('summarizeReportContractDocPageReleaseOperatorApprovalSectionRegressionReport'),
    reportContractDocPageReleaseOperatorApprovalSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-operator-approval-section-regression'] === 'node src/export-report-contract-doc-page-release-operator-approval-section-regression.mjs --strict',
    reportContractDocPageReleaseApprovalLedgerSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseApprovalLedgerSectionRegressionPath),
    reportContractDocPageReleaseApprovalLedgerSectionRegressionVersioned: reportContractDocPageReleaseApprovalLedgerSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_APPROVAL_LEDGER_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseApprovalLedgerSectionRegressionText.includes('buildReportContractDocPageReleaseApprovalLedgerSectionRegressionReport')
      && reportContractDocPageReleaseApprovalLedgerSectionRegressionText.includes('summarizeReportContractDocPageReleaseApprovalLedgerSectionRegressionReport'),
    reportContractDocPageReleaseApprovalLedgerSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-approval-ledger-section-regression'] === 'node src/export-report-contract-doc-page-release-approval-ledger-section-regression.mjs --strict',
    reportContractDocPageReleaseActionQueueSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseActionQueueSectionRegressionPath),
    reportContractDocPageReleaseActionQueueSectionRegressionVersioned: reportContractDocPageReleaseActionQueueSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_ACTION_QUEUE_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseActionQueueSectionRegressionText.includes('buildReportContractDocPageReleaseActionQueueSectionRegressionReport')
      && reportContractDocPageReleaseActionQueueSectionRegressionText.includes('summarizeReportContractDocPageReleaseActionQueueSectionRegressionReport'),
    reportContractDocPageReleaseActionQueueSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-action-queue-section-regression'] === 'node src/export-report-contract-doc-page-release-action-queue-section-regression.mjs --strict',
    reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionPath),
    reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionVersioned: reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_RUNNER_DISPATCH_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionText.includes('buildReportContractDocPageReleaseRunnerDispatchDenialSectionRegressionReport')
      && reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionText.includes('summarizeReportContractDocPageReleaseRunnerDispatchDenialSectionRegressionReport'),
    reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-runner-dispatch-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-runner-dispatch-denial-section-regression.mjs --strict',
    reportContractDocPageReleaseLiveActionPreflightSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseLiveActionPreflightSectionRegressionPath),
    reportContractDocPageReleaseLiveActionPreflightSectionRegressionVersioned: reportContractDocPageReleaseLiveActionPreflightSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_LIVE_ACTION_PREFLIGHT_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseLiveActionPreflightSectionRegressionText.includes('buildReportContractDocPageReleaseLiveActionPreflightSectionRegressionReport')
      && reportContractDocPageReleaseLiveActionPreflightSectionRegressionText.includes('summarizeReportContractDocPageReleaseLiveActionPreflightSectionRegressionReport'),
    reportContractDocPageReleaseLiveActionPreflightSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-live-action-preflight-section-regression'] === 'node src/export-report-contract-doc-page-release-live-action-preflight-section-regression.mjs --strict',
    reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionPath),
    reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionVersioned: reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_INTENT_CAPTURE_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionText.includes('buildReportContractDocPageReleaseExecutionIntentCaptureSectionRegressionReport')
      && reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionText.includes('summarizeReportContractDocPageReleaseExecutionIntentCaptureSectionRegressionReport'),
    reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-execution-intent-capture-section-regression'] === 'node src/export-report-contract-doc-page-release-execution-intent-capture-section-regression.mjs --strict',
    reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionPath),
    reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionVersioned: reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionText.includes('buildReportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionReport')
      && reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionText.includes('summarizeReportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionReport'),
    reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-execution-approval-boundary-section-regression'] === 'node src/export-report-contract-doc-page-release-execution-approval-boundary-section-regression.mjs --strict',
    reportContractDocPageReleaseRunnerExecutionGateSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseRunnerExecutionGateSectionRegressionPath),
    reportContractDocPageReleaseRunnerExecutionGateSectionRegressionVersioned: reportContractDocPageReleaseRunnerExecutionGateSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_RUNNER_EXECUTION_GATE_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseRunnerExecutionGateSectionRegressionText.includes('buildReportContractDocPageReleaseRunnerExecutionGateSectionRegressionReport')
      && reportContractDocPageReleaseRunnerExecutionGateSectionRegressionText.includes('summarizeReportContractDocPageReleaseRunnerExecutionGateSectionRegressionReport'),
    reportContractDocPageReleaseRunnerExecutionGateSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-runner-execution-gate-section-regression'] === 'node src/export-report-contract-doc-page-release-runner-execution-gate-section-regression.mjs --strict',
    reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionPath),
    reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionVersioned: reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionText.includes('buildReportContractDocPageReleaseDispatchImplementationDenialSectionRegressionReport')
      && reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionText.includes('summarizeReportContractDocPageReleaseDispatchImplementationDenialSectionRegressionReport'),
    reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-dispatch-implementation-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-dispatch-implementation-denial-section-regression.mjs --strict',
    reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionPath),
    reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionVersioned: reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_PLATFORM_STATE_SNAPSHOT_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionText.includes('buildReportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionReport')
      && reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionText.includes('summarizeReportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionReport'),
    reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-platform-state-snapshot-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-platform-state-snapshot-denial-section-regression.mjs --strict',
    reportContractDocPageReleaseDryRunReplayDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseDryRunReplayDenialSectionRegressionPath),
    reportContractDocPageReleaseDryRunReplayDenialSectionRegressionVersioned: reportContractDocPageReleaseDryRunReplayDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_DRY_RUN_REPLAY_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseDryRunReplayDenialSectionRegressionText.includes('buildReportContractDocPageReleaseDryRunReplayDenialSectionRegressionReport')
      && reportContractDocPageReleaseDryRunReplayDenialSectionRegressionText.includes('summarizeReportContractDocPageReleaseDryRunReplayDenialSectionRegressionReport'),
    reportContractDocPageReleaseDryRunReplayDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-dry-run-replay-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-dry-run-replay-denial-section-regression.mjs --strict',
    reportContractDocPageReleaseProofBundleDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseProofBundleDenialSectionRegressionPath),
    reportContractDocPageReleaseProofBundleDenialSectionRegressionVersioned: reportContractDocPageReleaseProofBundleDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_PROOF_BUNDLE_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseProofBundleDenialSectionRegressionText.includes('buildReportContractDocPageReleaseProofBundleDenialSectionRegressionReport')
      && reportContractDocPageReleaseProofBundleDenialSectionRegressionText.includes('summarizeReportContractDocPageReleaseProofBundleDenialSectionRegressionReport'),
    reportContractDocPageReleaseProofBundleDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-proof-bundle-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-proof-bundle-denial-section-regression.mjs --strict',
    reportContractDocPageReleaseLedgerDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseLedgerDenialSectionRegressionPath),
    reportContractDocPageReleaseLedgerDenialSectionRegressionVersioned: reportContractDocPageReleaseLedgerDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_LEDGER_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseLedgerDenialSectionRegressionText.includes('buildReportContractDocPageReleaseLedgerDenialSectionRegressionReport')
      && reportContractDocPageReleaseLedgerDenialSectionRegressionText.includes('summarizeReportContractDocPageReleaseLedgerDenialSectionRegressionReport'),
    reportContractDocPageReleaseLedgerDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-ledger-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-ledger-denial-section-regression.mjs --strict',
    reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionPath),
    reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionVersioned: reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionText.includes('buildReportContractDocPageReleaseAuditEvidenceDenialSectionRegressionReport')
      && reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionText.includes('summarizeReportContractDocPageReleaseAuditEvidenceDenialSectionRegressionReport'),
    reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-audit-evidence-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-audit-evidence-denial-section-regression.mjs --strict',
    reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionPath),
    reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionVersioned: reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_RECEIPT_EVIDENCE_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionText.includes('buildReportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionReport')
      && reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionText.includes('summarizeReportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionReport'),
    reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-receipt-evidence-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-receipt-evidence-denial-section-regression.mjs --strict',
    reportContractDocPageReleasePostActionReceiptDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleasePostActionReceiptDenialSectionRegressionPath),
    reportContractDocPageReleasePostActionReceiptDenialSectionRegressionVersioned: reportContractDocPageReleasePostActionReceiptDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleasePostActionReceiptDenialSectionRegressionText.includes('buildReportContractDocPageReleasePostActionReceiptDenialSectionRegressionReport')
      && reportContractDocPageReleasePostActionReceiptDenialSectionRegressionText.includes('summarizeReportContractDocPageReleasePostActionReceiptDenialSectionRegressionReport'),
    reportContractDocPageReleasePostActionReceiptDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-post-action-receipt-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-post-action-receipt-denial-section-regression.mjs --strict',
    reportContractDocPageReleasePostActionAuditDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleasePostActionAuditDenialSectionRegressionPath),
    reportContractDocPageReleasePostActionAuditDenialSectionRegressionVersioned: reportContractDocPageReleasePostActionAuditDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_AUDIT_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleasePostActionAuditDenialSectionRegressionText.includes('buildReportContractDocPageReleasePostActionAuditDenialSectionRegressionReport')
      && reportContractDocPageReleasePostActionAuditDenialSectionRegressionText.includes('summarizeReportContractDocPageReleasePostActionAuditDenialSectionRegressionReport'),
    reportContractDocPageReleasePostActionAuditDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-post-action-audit-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-post-action-audit-denial-section-regression.mjs --strict',
    reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionPath),
    reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionVersioned: reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECONCILIATION_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionText.includes('buildReportContractDocPageReleasePostActionReconciliationDenialSectionRegressionReport')
      && reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionText.includes('summarizeReportContractDocPageReleasePostActionReconciliationDenialSectionRegressionReport'),
    reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-post-action-reconciliation-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-post-action-reconciliation-denial-section-regression.mjs --strict',
    reportContractDocPageReleasePostActionSettlementDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleasePostActionSettlementDenialSectionRegressionPath),
    reportContractDocPageReleasePostActionSettlementDenialSectionRegressionVersioned: reportContractDocPageReleasePostActionSettlementDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_SETTLEMENT_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleasePostActionSettlementDenialSectionRegressionText.includes('buildReportContractDocPageReleasePostActionSettlementDenialSectionRegressionReport')
      && reportContractDocPageReleasePostActionSettlementDenialSectionRegressionText.includes('summarizeReportContractDocPageReleasePostActionSettlementDenialSectionRegressionReport'),
    reportContractDocPageReleasePostActionSettlementDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-post-action-settlement-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-post-action-settlement-denial-section-regression.mjs --strict',
    reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionPath),
    reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionVersioned: reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionText.includes('buildReportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionReport')
      && reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionText.includes('summarizeReportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionReport'),
    reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-post-action-acceptance-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-post-action-acceptance-denial-section-regression.mjs --strict',
    reportContractDocPageReleasePostActionPaymentDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleasePostActionPaymentDenialSectionRegressionPath),
    reportContractDocPageReleasePostActionPaymentDenialSectionRegressionVersioned: reportContractDocPageReleasePostActionPaymentDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_PAYMENT_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleasePostActionPaymentDenialSectionRegressionText.includes('buildReportContractDocPageReleasePostActionPaymentDenialSectionRegressionReport')
      && reportContractDocPageReleasePostActionPaymentDenialSectionRegressionText.includes('summarizeReportContractDocPageReleasePostActionPaymentDenialSectionRegressionReport'),
    reportContractDocPageReleasePostActionPaymentDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-post-action-payment-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-post-action-payment-denial-section-regression.mjs --strict',
    reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionPath),
    reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionVersioned: reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_DEPLOYMENT_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionText.includes('buildReportContractDocPageReleasePostActionDeploymentDenialSectionRegressionReport')
      && reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionText.includes('summarizeReportContractDocPageReleasePostActionDeploymentDenialSectionRegressionReport'),
    reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-post-action-deployment-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-post-action-deployment-denial-section-regression.mjs --strict',
    reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionPath),
    reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionVersioned: reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_PROVIDER_SPEND_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionText.includes('buildReportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionReport')
      && reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionText.includes('summarizeReportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionReport'),
    reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-post-action-provider-spend-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-post-action-provider-spend-denial-section-regression.mjs --strict',
    reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionPath),
    reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionVersioned: reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_STATE_TRANSITION_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionText.includes('buildReportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionReport')
      && reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionText.includes('summarizeReportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionReport'),
    reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-post-action-state-transition-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-post-action-state-transition-denial-section-regression.mjs --strict',
    reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionPath),
    reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionVersioned: reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionText.includes('buildReportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionReport')
      && reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionText.includes('summarizeReportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionReport'),
    reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-post-action-queue-consumption-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression.mjs --strict',
    reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionPath),
    reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionVersioned: reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_BACKGROUND_RUNNER_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionText.includes('buildReportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionReport')
      && reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionText.includes('summarizeReportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionReport'),
    reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-post-action-background-runner-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-post-action-background-runner-denial-section-regression.mjs --strict',
    reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionModulePresent: fs.existsSync(reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionPath),
    reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionVersioned: reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionText.includes('REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_DISPATCH_COMPLETION_DENIAL_SECTION_REGRESSION_VERSION')
      && reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionText.includes('buildReportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionReport')
      && reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionText.includes('summarizeReportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionReport'),
    reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionScriptPresent: packageJson.scripts?.['reports:contract-doc-page-release-post-action-dispatch-completion-denial-section-regression'] === 'node src/export-report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression.mjs --strict',
    reportManifestDriftRegressionModulePresent: fs.existsSync(reportManifestDriftRegressionPath),
    reportManifestDriftRegressionVersioned: reportManifestDriftRegressionText.includes('REPORT_MANIFEST_DRIFT_REGRESSION_VERSION')
      && reportManifestDriftRegressionText.includes('buildReportManifestDriftRegressionReport')
      && reportManifestDriftRegressionText.includes('summarizeReportManifestDriftRegressionReport'),
    reportManifestDriftRegressionScriptPresent: packageJson.scripts?.['reports:manifest-drift-regression'] === 'node src/export-report-manifest-drift-regression.mjs --strict',
    reportLatestRecoveryRegressionModulePresent: fs.existsSync(reportLatestRecoveryRegressionPath),
    reportLatestRecoveryRegressionVersioned: reportLatestRecoveryRegressionText.includes('REPORT_LATEST_RECOVERY_REGRESSION_VERSION')
      && reportLatestRecoveryRegressionText.includes('buildReportLatestRecoveryRegressionReport')
      && reportLatestRecoveryRegressionText.includes('summarizeReportLatestRecoveryRegressionReport'),
    reportLatestRecoveryRegressionScriptPresent: packageJson.scripts?.['reports:latest-recovery-regression'] === 'node src/export-report-latest-recovery-regression.mjs --strict',
    reportBootstrapSeedRegressionModulePresent: fs.existsSync(reportBootstrapSeedRegressionPath),
    reportBootstrapSeedRegressionVersioned: reportBootstrapSeedRegressionText.includes('REPORT_BOOTSTRAP_SEED_REGRESSION_VERSION')
      && reportBootstrapSeedRegressionText.includes('buildReportBootstrapSeedRegressionReport')
      && reportBootstrapSeedRegressionText.includes('summarizeReportBootstrapSeedRegressionReport'),
    reportBootstrapSeedRegressionScriptPresent: packageJson.scripts?.['reports:bootstrap-seed-regression'] === 'node src/export-report-bootstrap-seed-regression.mjs --strict',
    reportGateCleanRerunRegressionModulePresent: fs.existsSync(reportGateCleanRerunRegressionPath),
    reportGateCleanRerunRegressionVersioned: reportGateCleanRerunRegressionText.includes('REPORT_GATE_CLEAN_RERUN_REGRESSION_VERSION')
      && reportGateCleanRerunRegressionText.includes('buildReportGateCleanRerunRegressionReport')
      && reportGateCleanRerunRegressionText.includes('summarizeReportGateCleanRerunRegressionReport'),
    reportGateCleanRerunRegressionScriptPresent: packageJson.scripts?.['reports:gate-clean-rerun-regression'] === 'node src/export-report-gate-clean-rerun-regression.mjs --strict',
    reportCleanGateIdempotenceRegressionModulePresent: fs.existsSync(reportCleanGateIdempotenceRegressionPath),
    reportCleanGateIdempotenceRegressionVersioned: reportCleanGateIdempotenceRegressionText.includes('REPORT_CLEAN_GATE_IDEMPOTENCE_REGRESSION_VERSION')
      && reportCleanGateIdempotenceRegressionText.includes('buildReportCleanGateIdempotenceRegressionReport')
      && reportCleanGateIdempotenceRegressionText.includes('summarizeReportCleanGateIdempotenceRegressionReport'),
    reportCleanGateIdempotenceRegressionScriptPresent: packageJson.scripts?.['reports:clean-gate-idempotence-regression'] === 'node src/export-report-clean-gate-idempotence-regression.mjs --strict',
    reportFinalSettlementRegressionModulePresent: fs.existsSync(reportFinalSettlementRegressionPath),
    reportFinalSettlementRegressionVersioned: reportFinalSettlementRegressionText.includes('REPORT_FINAL_SETTLEMENT_REGRESSION_VERSION')
      && reportFinalSettlementRegressionText.includes('buildReportFinalSettlementRegressionReport')
      && reportFinalSettlementRegressionText.includes('summarizeReportFinalSettlementRegressionReport'),
    reportFinalSettlementRegressionScriptPresent: packageJson.scripts?.['reports:final-settlement-regression'] === 'node src/export-report-final-settlement-regression.mjs --strict',
    reportPostFinalDriftRegressionModulePresent: fs.existsSync(reportPostFinalDriftRegressionPath),
    reportPostFinalDriftRegressionVersioned: reportPostFinalDriftRegressionText.includes('REPORT_POST_FINAL_DRIFT_REGRESSION_VERSION')
      && reportPostFinalDriftRegressionText.includes('buildReportPostFinalDriftRegressionReport')
      && reportPostFinalDriftRegressionText.includes('summarizeReportPostFinalDriftRegressionReport'),
    reportPostFinalDriftRegressionScriptPresent: packageJson.scripts?.['reports:post-final-drift-regression'] === 'node src/export-report-post-final-drift-regression.mjs --strict',
    reportCloseoutDriftClassificationRegressionModulePresent: fs.existsSync(reportCloseoutDriftClassificationRegressionPath),
    reportCloseoutDriftClassificationRegressionVersioned: reportCloseoutDriftClassificationRegressionText.includes('REPORT_CLOSEOUT_DRIFT_CLASSIFICATION_REGRESSION_VERSION')
      && reportCloseoutDriftClassificationRegressionText.includes('buildReportCloseoutDriftClassificationRegressionReport')
      && reportCloseoutDriftClassificationRegressionText.includes('summarizeReportCloseoutDriftClassificationRegressionReport'),
    reportCloseoutDriftClassificationRegressionScriptPresent: packageJson.scripts?.['reports:closeout-drift-classification-regression'] === 'node src/export-report-closeout-drift-classification-regression.mjs --strict',
    reportCloseoutCommandInventoryRegressionModulePresent: fs.existsSync(reportCloseoutCommandInventoryRegressionPath),
    reportCloseoutCommandInventoryRegressionVersioned: reportCloseoutCommandInventoryRegressionText.includes('REPORT_CLOSEOUT_COMMAND_INVENTORY_REGRESSION_VERSION')
      && reportCloseoutCommandInventoryRegressionText.includes('buildReportCloseoutCommandInventoryRegressionReport')
      && reportCloseoutCommandInventoryRegressionText.includes('summarizeReportCloseoutCommandInventoryRegressionReport'),
    reportCloseoutCommandInventoryRegressionScriptPresent: packageJson.scripts?.['reports:closeout-command-inventory-regression'] === 'node src/export-report-closeout-command-inventory-regression.mjs --strict',
    reportRunnerContractRegressionModulePresent: fs.existsSync(reportRunnerContractRegressionPath),
    reportRunnerContractRegressionVersioned: reportRunnerContractRegressionText.includes('REPORT_RUNNER_CONTRACT_REGRESSION_VERSION')
      && reportRunnerContractRegressionText.includes('buildReportRunnerContractRegressionReport')
      && reportRunnerContractRegressionText.includes('summarizeReportRunnerContractRegressionReport'),
    reportRunnerContractRegressionScriptPresent: packageJson.scripts?.['reports:runner-contract-regression'] === 'node src/export-report-runner-contract-regression.mjs --strict',
    reportRetentionModulePresent: fs.existsSync(reportRetentionPath),
    reportRetentionVersioned: reportRetentionText.includes('REPORT_RETENTION_VERSION')
      && reportRetentionText.includes('buildReportRetentionPlan')
      && reportRetentionText.includes('buildReportRetentionResult'),
    reportRetentionRegressionModulePresent: fs.existsSync(reportRetentionRegressionPath),
    reportRetentionRegressionVersioned: reportRetentionRegressionText.includes('REPORT_RETENTION_REGRESSION_VERSION')
      && reportRetentionRegressionText.includes('buildReportRetentionRegressionReport')
      && reportRetentionRegressionText.includes('summarizeReportRetentionRegressionReport'),
    reportRetentionRegressionScriptPresent: packageJson.scripts?.['reports:retention-regression'] === 'node src/export-report-retention-regression.mjs --strict',
    integrationGateToolingModulePresent: fs.existsSync(integrationGateToolingPath),
    integrationGateToolingPublic: publicModules.includes('integration-gate-tooling'),
    integrationGateToolingVersioned: integrationGateToolingText.includes('INTEGRATION_GATE_TOOLING_VERSION')
      && integrationGateToolingText.includes('buildIntegrationGateTooling')
      && integrationGateToolingText.includes('summarizeIntegrationGateTooling'),
    integrationGateToolingScriptPresent: packageJson.scripts?.['integration:tooling'] === 'node src/export-integration-gate-tooling.mjs --strict',
    channelImportAllowlistModulePresent: fs.existsSync(channelImportAllowlistPath),
    channelImportAllowlistPublic: publicModules.includes(CHANNEL_IMPORT_ALLOWLIST_STABLE_MODULE_ID),
    channelImportAllowlistVersioned: channelImportAllowlistText.includes('CHANNEL_IMPORT_ALLOWLIST_VERSION')
      && channelImportAllowlistText.includes('buildChannelImportAllowlist')
      && channelImportAllowlistText.includes('summarizeChannelImportAllowlist'),
    channelImportAllowlistScriptPresent: packageJson.scripts?.['channel:imports'] === 'node src/export-channel-import-allowlist.mjs --strict',
    packageRootResolverModulePresent: fs.existsSync(packageRootResolverPath),
    packageRootResolverPublic: publicModules.includes(PACKAGE_ROOT_RESOLVER_STABLE_MODULE_ID),
    packageRootResolverVersioned: packageRootResolverText.includes('PACKAGE_ROOT_RESOLVER_VERSION')
      && packageRootResolverText.includes('buildPackageRootResolverReport')
      && packageRootResolverText.includes('summarizePackageRootResolverReport'),
    packageRootResolverScriptPresent: packageJson.scripts?.['package-root:resolver'] === 'node src/export-package-root-resolver.mjs --strict',
    packageRootImportMigrationModulePresent: fs.existsSync(packageRootImportMigrationPath),
    packageRootImportMigrationPublic: publicModules.includes(PACKAGE_ROOT_IMPORT_MIGRATION_STABLE_MODULE_ID),
    packageRootImportMigrationVersioned: packageRootImportMigrationText.includes('PACKAGE_ROOT_IMPORT_MIGRATION_VERSION')
      && packageRootImportMigrationText.includes('buildPackageRootImportMigrationPlan')
      && packageRootImportMigrationText.includes('summarizePackageRootImportMigrationPlan'),
    packageRootImportMigrationScriptPresent: packageJson.scripts?.['package-root:migration'] === 'node src/export-package-root-import-migration.mjs --strict',
    packageRootImportRegressionModulePresent: fs.existsSync(packageRootImportRegressionPath),
    packageRootImportRegressionVersioned: packageRootImportRegressionText.includes('PACKAGE_ROOT_IMPORT_REGRESSION_VERSION')
      && packageRootImportRegressionText.includes('buildPackageRootImportRegressionReport')
      && packageRootImportRegressionText.includes('summarizePackageRootImportRegressionReport'),
    packageRootImportRegressionScriptPresent: packageJson.scripts?.['package-root:regression'] === 'node src/export-package-root-import-regression.mjs --strict',
    packageRootSymbolManifestModulePresent: fs.existsSync(packageRootSymbolManifestPath),
    packageRootSymbolManifestVersioned: packageRootSymbolManifestText.includes('PACKAGE_ROOT_SYMBOL_MANIFEST_VERSION')
      && packageRootSymbolManifestText.includes('buildPackageRootSymbolManifestReport')
      && packageRootSymbolManifestText.includes('summarizePackageRootSymbolManifestReport'),
    packageRootSymbolManifestScriptPresent: packageJson.scripts?.['package-root:symbols'] === 'node src/export-package-root-symbol-manifest.mjs --strict',
    packageRootSymbolRegressionModulePresent: fs.existsSync(packageRootSymbolRegressionPath),
    packageRootSymbolRegressionVersioned: packageRootSymbolRegressionText.includes('PACKAGE_ROOT_SYMBOL_REGRESSION_VERSION')
      && packageRootSymbolRegressionText.includes('buildPackageRootSymbolRegressionReport')
      && packageRootSymbolRegressionText.includes('summarizePackageRootSymbolRegressionReport'),
    packageRootSymbolRegressionScriptPresent: packageJson.scripts?.['package-root:symbol-regression'] === 'node src/export-package-root-symbol-regression.mjs --strict',
    packageRootSymbolMinimizationModulePresent: fs.existsSync(packageRootSymbolMinimizationPath),
    packageRootSymbolMinimizationVersioned: packageRootSymbolMinimizationText.includes('PACKAGE_ROOT_SYMBOL_MINIMIZATION_VERSION')
      && packageRootSymbolMinimizationText.includes('buildPackageRootSymbolMinimizationReport')
      && packageRootSymbolMinimizationText.includes('summarizePackageRootSymbolMinimizationReport'),
    packageRootSymbolMinimizationScriptPresent: packageJson.scripts?.['package-root:symbol-minimize'] === 'node src/export-package-root-symbol-minimization.mjs --strict',
    integrationDependencyAuditCompatibilityExportAbsent: !compatibilityModules.includes('integration-dependency-audit'),
    integrationDependencyAuditRootExportAbsent: !/export\s+\*\s+from\s+['"]\.\/integration-dependency-audit\.mjs['"]/.test(indexText),
    integrationGateScriptPresent: packageJson.scripts?.['gate:integration:strict'] === 'node src/integration-dependency-gate.mjs --strict',
    reportRetentionScriptPresent: packageJson.scripts?.['reports:prune'] === 'node src/prune-reports.mjs',
    channelCommandPreviewHardcoded: /npm['"],\s*['"]run|pitch:submit-live|submit:live|acceptance:apply-live|deploy:dry-run/.test(adapterRunnerText),
  };
}

function blocker(code, notes, owner = 'design-production-core') {
  return { code, notes, owner };
}

function buildBlockers({
  shape,
  channels,
  channelImportAllowlist,
  packageRootResolver,
  packageRootImportMigration,
  packageRootImportRegression,
  packageRootSymbolManifest,
  packageRootSymbolRegression,
  packageRootSymbolMinimization,
  reportFreshness,
  reportFreshnessRegression,
  integrationGateSequenceRegression,
  reportInventoryConsistency,
  reportSchemaContract,
  reportLineageTopology,
  reportHashStabilityRegression,
  reportOutputPairing,
  reportArtifactReproducibility,
  reportSelfReferenceBoundaryRegression,
  reportContractManifest,
  reportContractRequiredCoverageRegression,
  reportContractDocCoverageRegression,
  reportContractSyntaxCoverageRegression,
  reportContractSourceDerivationRegression,
  reportContractSummaryKeyRegression,
  reportContractAuditForwardingRegression,
  reportContractCheckpointBindingShapeRegression,
  reportContractGateSummaryShapeRegression,
  reportContractExporterStdoutShapeRegression,
  reportContractSafetyFlagRegression,
  reportContractArtifactBindingRegression,
  reportContractDocIndexAnchorRegression,
  reportContractDocPageLatestDetailRegression,
  reportContractDocPageCommandSectionRegression,
  reportContractDocPageSafetySectionDetailRegression,
  reportContractDocPageStrictGateSectionRegression,
  reportContractDocPageOutputSectionRegression,
  reportContractDocPageCrossReportSectionRegression,
  reportContractDocPageCloseoutSectionRegression,
  reportContractDocPagePostGateWriterSectionRegression,
  reportContractDocPageRetentionSectionRegression,
  reportContractDocPageFreshnessHashSectionRegression,
  reportContractDocPageCheckpointHashSectionRegression,
  reportContractDocPageBootstrapSeedSectionRegression,
  reportContractDocPageCleanRerunSectionRegression,
  reportContractDocPageFinalSettlementSectionRegression,
  reportContractDocPageCloseoutIndexSectionRegression,
  reportContractDocPageCloseoutEvidenceSectionRegression,
  reportContractDocPageCloseoutLedgerSectionRegression,
  reportContractDocPageCloseoutRetentionProofSectionRegression,
  reportContractDocPageCloseoutProbeBundleSectionRegression,
  reportContractDocPageCloseoutSignoffSectionRegression,
  reportContractDocPageCloseoutReleaseManifestSectionRegression,
  reportContractDocPageReleaseArchiveIndexSectionRegression,
  reportContractDocPageReleaseHandoffLedgerSectionRegression,
  reportContractDocPageReleaseDeliveryReadinessSectionRegression,
  reportContractDocPageReleaseExecutionDenialSectionRegression,
  reportContractDocPageReleaseOperatorApprovalSectionRegression,
  reportContractDocPageReleaseApprovalLedgerSectionRegression,
  reportContractDocPageReleaseActionQueueSectionRegression,
  reportContractDocPageReleaseRunnerDispatchDenialSectionRegression,
  reportContractDocPageReleaseLiveActionPreflightSectionRegression,
  reportContractDocPageReleaseExecutionIntentCaptureSectionRegression,
  reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression,
  reportContractDocPageReleaseRunnerExecutionGateSectionRegression,
  reportContractDocPageReleaseDispatchImplementationDenialSectionRegression,
  reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression,
  reportContractDocPageReleaseDryRunReplayDenialSectionRegression,
  reportContractDocPageReleaseProofBundleDenialSectionRegression,
  reportContractDocPageReleaseLedgerDenialSectionRegression,
  reportContractDocPageReleaseAuditEvidenceDenialSectionRegression,
  reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression,
  reportContractDocPageReleasePostActionReceiptDenialSectionRegression,
  reportContractDocPageReleasePostActionAuditDenialSectionRegression,
  reportContractDocPageReleasePostActionReconciliationDenialSectionRegression,
  reportContractDocPageReleasePostActionSettlementDenialSectionRegression,
  reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression,
  reportContractDocPageReleasePostActionPaymentDenialSectionRegression,
  reportContractDocPageReleasePostActionDeploymentDenialSectionRegression,
  reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression,
  reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression,
  reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression,
  reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression,
  reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression,
  reportManifestDriftRegression,
  reportLatestRecoveryRegression,
  reportBootstrapSeedRegression,
  reportGateCleanRerunRegression,
  reportCleanGateIdempotenceRegression,
  reportFinalSettlementRegression,
  reportPostFinalDriftRegression,
  reportCloseoutDriftClassificationRegression,
  reportCloseoutCommandInventoryRegression,
  reportRunnerContractRegression,
  reportRetentionRegression,
}) {
  const blockers = [];
  const byChannel = Object.fromEntries(channels.map((channel) => [channel.channelId, channel]));
  if (!shape.privatePackage) blockers.push(blocker('core_package_not_private', 'Core package should stay private until runtime boundaries are stable.'));
  if (!shape.packageExportsRootPublic) {
    blockers.push(blocker(
      'core_package_root_export_missing',
      `package.json exports["."] must point at ${INTEGRATION_GATE_TOOLING_PACKAGE_EXPORTS['.']} so package-name imports use the stable public surface.`,
    ));
  }
  if (!shape.packageExportsPackageJson) {
    blockers.push(blocker(
      'core_package_json_export_missing',
      'package.json exports must expose ./package.json for local tooling metadata reads.',
    ));
  }
  if (shape.packageExportsDeepSrcCount > 0) {
    blockers.push(blocker(
      'core_package_deep_src_exports_present',
      `package.json must not expose src implementation subpaths: ${shape.packageExportSurface.packageDeepSrcExportKeys.join(', ')}.`,
    ));
  }
  if (shape.packageExportsExtraCount > 0) {
    blockers.push(blocker(
      'core_package_extra_exports_present',
      `package.json must not expose extra public subpaths outside the stable root/package metadata surface: ${shape.packageExportSurface.packageExtraExportKeys.join(', ')}.`,
    ));
  }
  if (shape.channelCommandPreviewHardcoded) {
    blockers.push(blocker(
      'core_adapter_runner_hardcodes_channel_command',
      'Core adapter-runner must only emit generic action/hash handoff previews; channel packages own npm command mapping.',
    ));
  }
  if (!shape.designReferenceRuntimeModulePresent) {
    blockers.push(blocker(
      'core_design_reference_runtime_missing',
      'Core has designReferenceSpec as a descriptor, but no dedicated design-reference/refpack runtime contract module.',
    ));
  }
  if (!shape.llmDesignReferenceResolverPresent) {
    blockers.push(blocker(
      'core_llm_design_reference_resolver_missing',
      'Core must own the LLM-authoritative industry/refpack resolver; legacy channel regex/index routing is not sufficient.',
    ));
  }
  if (!shape.buyerAssetPackageModulePresent) {
    blockers.push(blocker(
      'core_buyer_asset_package_missing',
      'Core has attachmentRefs in CreativeBrief, but no separate buyer/source asset package contract.',
    ));
  }
  if (!shape.lifecycleSchemaModulePresent || !shape.lifecycleSchemaPublic || !shape.lifecycleSchemaVersioned) {
    blockers.push(blocker(
      'core_external_action_lifecycle_schema_missing',
      'Core must expose one versioned lifecycle schema so receipt/proof/inbox/dispatch/ledger modules do not drift.',
    ));
  }
  if (!shape.lifecycleSurfaceModulePresent || !shape.lifecycleSurfacePublic || !shape.lifecycleSurfaceVersioned) {
    blockers.push(blocker(
      'core_external_action_lifecycle_surface_missing',
      'Core must expose one stable lifecycle facade so channels do not import receipt/proof/inbox/dispatch modules directly.',
    ));
  }
  if (!shape.contractSchemaModulePresent || !shape.contractSchemaPublic || !shape.contractSchemaVersioned) {
    blockers.push(blocker(
      'core_contract_json_schema_missing',
      'Core must expose one versioned JSON Schema snapshot for public contracts so fixtures, docs, and runtime validators do not drift.',
    ));
  }
  if (!shape.contractSchemaExportScriptPresent) {
    blockers.push(blocker(
      'core_contract_schema_export_script_missing',
      'Core must expose schema:contracts so the current contract JSON Schema snapshot can be regenerated locally.',
    ));
  }
  if (!shape.compatibilityPolicyModulePresent || !shape.compatibilityPolicyPublic || !shape.compatibilityPolicyVersioned) {
    blockers.push(blocker(
      'core_compatibility_export_policy_missing',
      'Core must expose one versioned compatibility export policy so legacy root exports cannot grow without a deprecation/removal plan.',
    ));
  }
  if (!shape.compatibilityPolicyScriptPresent) {
    blockers.push(blocker(
      'core_compatibility_policy_script_missing',
      'Core must expose compatibility:policy so the legacy root export deprecation/removal plan can be regenerated locally.',
    ));
  }
  if (!shape.readOnlyReportChainModulePresent || !shape.readOnlyReportChainPublic || !shape.readOnlyReportChainVersioned) {
    blockers.push(blocker(
      'core_read_only_report_chain_missing',
      'Core must expose one versioned read-only report chain facade so dashboard/release/archive modules do not remain scattered root imports.',
    ));
  }
  if (!shape.readOnlyReportChainScriptPresent) {
    blockers.push(blocker(
      'core_read_only_report_chain_script_missing',
      'Core must expose readonly:report-chain so the read-only report chain can be regenerated locally.',
    ));
  }
  if (!shape.reportFreshnessModulePresent || !shape.reportFreshnessPublic || !shape.reportFreshnessVersioned) {
    blockers.push(blocker(
      'core_report_freshness_missing',
      'Core must expose one versioned report freshness facade so latest reports cannot drift from the current integration gate summary.',
    ));
  }
  if (!shape.reportFreshnessScriptPresent) {
    blockers.push(blocker(
      'core_report_freshness_script_missing',
      'Core must expose reports:freshness so latest report freshness can be regenerated locally.',
    ));
  }
  if (!shape.reportFreshnessRegressionModulePresent || !shape.reportFreshnessRegressionVersioned) {
    blockers.push(blocker(
      'core_report_freshness_regression_missing',
      'Core must expose one versioned report freshness regression fixture so missing/not-ok/hash-drift freshness blockers stay proven.',
    ));
  }
  if (!shape.reportFreshnessRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_freshness_regression_script_missing',
      'Core must expose reports:freshness-regression so the negative report freshness fixture can be regenerated locally.',
    ));
  }
  if (!shape.integrationGateSequenceRegressionModulePresent || !shape.integrationGateSequenceRegressionVersioned) {
    blockers.push(blocker(
      'core_integration_gate_sequence_regression_missing',
      'Core must expose one versioned integration gate sequence regression fixture so child freshness ordering stays proven.',
    ));
  }
  if (!shape.integrationGateSequenceRegressionScriptPresent) {
    blockers.push(blocker(
      'core_integration_gate_sequence_regression_script_missing',
      'Core must expose reports:gate-sequence-regression so the gate sequence fixture can be regenerated locally.',
    ));
  }
  if (!shape.reportInventoryConsistencyModulePresent || !shape.reportInventoryConsistencyVersioned) {
    blockers.push(blocker(
      'core_report_inventory_consistency_missing',
      'Core must expose one versioned report inventory consistency fixture so report freshness, tooling, gate summary, and checkpoint bindings cannot drift.',
    ));
  }
  if (!shape.reportInventoryConsistencyScriptPresent) {
    blockers.push(blocker(
      'core_report_inventory_consistency_script_missing',
      'Core must expose reports:inventory-consistency so the report inventory consistency fixture can be regenerated locally.',
    ));
  }
  if (!shape.reportSchemaContractModulePresent || !shape.reportSchemaContractVersioned) {
    blockers.push(blocker(
      'core_report_schema_contract_missing',
      'Core must expose one versioned report schema contract fixture so latest report JSON shape cannot drift silently.',
    ));
  }
  if (!shape.reportSchemaContractScriptPresent) {
    blockers.push(blocker(
      'core_report_schema_contract_script_missing',
      'Core must expose reports:schema-contract so latest report JSON shape can be regenerated and verified locally.',
    ));
  }
  if (!shape.reportLineageTopologyModulePresent || !shape.reportLineageTopologyVersioned) {
    blockers.push(blocker(
      'core_report_lineage_topology_missing',
      'Core must expose one versioned report lineage topology fixture so latest-report DAG dependencies cannot drift silently.',
    ));
  }
  if (!shape.reportLineageTopologyScriptPresent) {
    blockers.push(blocker(
      'core_report_lineage_topology_script_missing',
      'Core must expose reports:lineage-topology so the report DAG guard can be regenerated locally.',
    ));
  }
  if (!shape.reportHashStabilityRegressionModulePresent || !shape.reportHashStabilityRegressionVersioned) {
    blockers.push(blocker(
      'core_report_hash_stability_regression_missing',
      'Core must expose one versioned report hash stability regression fixture so latest report hashes cannot flap on generatedAt/output path/key-order noise.',
    ));
  }
  if (!shape.reportHashStabilityRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_hash_stability_regression_script_missing',
      'Core must expose reports:hash-stability-regression so latest report hash stability can be regenerated locally.',
    ));
  }
  if (!shape.reportOutputPairingModulePresent || !shape.reportOutputPairingVersioned) {
    blockers.push(blocker(
      'core_report_output_pairing_missing',
      'Core must expose one versioned report output pairing fixture so latest JSON/Markdown report files and README/script indexes cannot drift silently.',
    ));
  }
  if (!shape.reportOutputPairingScriptPresent) {
    blockers.push(blocker(
      'core_report_output_pairing_script_missing',
      'Core must expose reports:output-pairing so latest report output pairing can be regenerated locally.',
    ));
  }
  if (!shape.reportArtifactReproducibilityModulePresent || !shape.reportArtifactReproducibilityVersioned) {
    blockers.push(blocker(
      'core_report_artifact_reproducibility_missing',
      'Core must expose one versioned report artifact reproducibility fixture so repeated latest-report exports cannot drift silently.',
    ));
  }
  if (!shape.reportArtifactReproducibilityScriptPresent) {
    blockers.push(blocker(
      'core_report_artifact_reproducibility_script_missing',
      'Core must expose reports:artifact-reproducibility so latest report artifact reproducibility can be regenerated locally.',
    ));
  }
  if (!shape.reportSelfReferenceBoundaryRegressionModulePresent || !shape.reportSelfReferenceBoundaryRegressionVersioned) {
    blockers.push(blocker(
      'core_report_self_reference_boundary_regression_missing',
      'Core must expose one versioned report self-reference boundary regression fixture so mid-gate stale hash observation and final freshness blockers cannot drift.',
    ));
  }
  if (!shape.reportSelfReferenceBoundaryRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_self_reference_boundary_regression_script_missing',
      'Core must expose reports:self-reference-boundary-regression so gate/freshness self-reference boundaries can be regenerated locally.',
    ));
  }
  if (!shape.reportContractManifestModulePresent || !shape.reportContractManifestVersioned) {
    blockers.push(blocker(
      'core_report_contract_manifest_missing',
      'Core must expose one versioned report contract manifest so exporter contracts are maintained in one source of truth.',
    ));
  }
  if (!shape.reportContractManifestScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_manifest_script_missing',
      'Core must expose reports:contract-manifest so the report exporter contract manifest can be regenerated locally.',
    ));
  }
  if (!shape.reportContractRequiredCoverageRegressionModulePresent || !shape.reportContractRequiredCoverageRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_required_coverage_regression_missing',
      'Core must expose one versioned report contract required coverage regression fixture so manifest contracts stay required by default or explicitly optional.',
    ));
  }
  if (!shape.reportContractRequiredCoverageRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_required_coverage_regression_script_missing',
      'Core must expose reports:contract-required-coverage-regression so manifest required/optional coverage can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocCoverageRegressionModulePresent || !shape.reportContractDocCoverageRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_coverage_regression_missing',
      'Core must expose one versioned report contract doc coverage regression fixture so manifest contracts cannot land without docs and README coverage.',
    ));
  }
  if (!shape.reportContractDocCoverageRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_coverage_regression_script_missing',
      'Core must expose reports:contract-doc-coverage-regression so manifest docs coverage can be regenerated locally.',
    ));
  }
  if (!shape.reportContractSyntaxCoverageRegressionModulePresent || !shape.reportContractSyntaxCoverageRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_syntax_coverage_regression_missing',
      'Core must expose one versioned report contract syntax coverage regression fixture so manifest contracts cannot land without source/exporter syntax checks.',
    ));
  }
  if (!shape.reportContractSyntaxCoverageRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_syntax_coverage_regression_script_missing',
      'Core must expose reports:contract-syntax-coverage-regression so manifest syntax coverage can be regenerated locally.',
    ));
  }
  if (!shape.reportContractSourceDerivationRegressionModulePresent || !shape.reportContractSourceDerivationRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_source_derivation_regression_missing',
      'Core must expose one versioned report contract source derivation regression fixture so manifest ids cannot drift from source/exporter/docs/report/hash derivations.',
    ));
  }
  if (!shape.reportContractSourceDerivationRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_source_derivation_regression_script_missing',
      'Core must expose reports:contract-source-derivation-regression so manifest source derivation coverage can be regenerated locally.',
    ));
  }
  if (!shape.reportContractSummaryKeyRegressionModulePresent || !shape.reportContractSummaryKeyRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_summary_key_regression_missing',
      'Core must expose one versioned report contract summary key regression fixture so manifest contracts reach gate/checkpoint/audit/selftest observation keys.',
    ));
  }
  if (!shape.reportContractSummaryKeyRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_summary_key_regression_script_missing',
      'Core must expose reports:contract-summary-key-regression so manifest contract summary key coverage can be regenerated locally.',
    ));
  }
  if (!shape.reportContractAuditForwardingRegressionModulePresent || !shape.reportContractAuditForwardingRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_audit_forwarding_regression_missing',
      'Core must expose one versioned report contract audit forwarding regression fixture so manifest contract blockers always reach integration audit.',
    ));
  }
  if (!shape.reportContractAuditForwardingRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_audit_forwarding_regression_script_missing',
      'Core must expose reports:contract-audit-forwarding-regression so manifest contract audit forwarding coverage can be regenerated locally.',
    ));
  }
  if (!shape.reportContractCheckpointBindingShapeRegressionModulePresent || !shape.reportContractCheckpointBindingShapeRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_checkpoint_binding_shape_regression_missing',
      'Core must expose one versioned report contract checkpoint binding shape regression fixture so manifest contracts keep canonical checkpoint bindings.',
    ));
  }
  if (!shape.reportContractCheckpointBindingShapeRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_checkpoint_binding_shape_regression_script_missing',
      'Core must expose reports:contract-checkpoint-binding-shape-regression so manifest contract checkpoint binding shape coverage can be regenerated locally.',
    ));
  }
  if (!shape.reportContractGateSummaryShapeRegressionModulePresent || !shape.reportContractGateSummaryShapeRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_gate_summary_shape_regression_missing',
      'Core must expose one versioned report contract gate summary shape regression fixture so manifest contracts keep canonical gate summary keys.',
    ));
  }
  if (!shape.reportContractGateSummaryShapeRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_gate_summary_shape_regression_script_missing',
      'Core must expose reports:contract-gate-summary-shape-regression so manifest contract gate summary shape coverage can be regenerated locally.',
    ));
  }
  if (!shape.reportContractExporterStdoutShapeRegressionModulePresent || !shape.reportContractExporterStdoutShapeRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_exporter_stdout_shape_regression_missing',
      'Core must expose one versioned report contract exporter stdout shape regression fixture so manifest contract exporters keep canonical stdout summaries.',
    ));
  }
  if (!shape.reportContractExporterStdoutShapeRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_exporter_stdout_shape_regression_script_missing',
      'Core must expose reports:contract-exporter-stdout-shape-regression so manifest contract exporter stdout shape coverage can be regenerated locally.',
    ));
  }
  if (!shape.reportContractSafetyFlagRegressionModulePresent || !shape.reportContractSafetyFlagRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_safety_flag_regression_missing',
      'Core must expose one versioned report contract safety flag regression fixture so manifest contract reports keep canonical local-only safety flags.',
    ));
  }
  if (!shape.reportContractSafetyFlagRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_safety_flag_regression_script_missing',
      'Core must expose reports:contract-safety-flag-regression so manifest contract safety flag coverage can be regenerated locally.',
    ));
  }
  if (!shape.reportContractArtifactBindingRegressionModulePresent || !shape.reportContractArtifactBindingRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_artifact_binding_regression_missing',
      'Core must expose one versioned report contract artifact binding regression fixture so manifest contract latest artifacts stay cross-report bound.',
    ));
  }
  if (!shape.reportContractArtifactBindingRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_artifact_binding_regression_script_missing',
      'Core must expose reports:contract-artifact-binding-regression so manifest contract artifact binding coverage can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocIndexAnchorRegressionModulePresent || !shape.reportContractDocIndexAnchorRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_index_anchor_regression_missing',
      'Core must expose one versioned report contract doc index anchor regression fixture so manifest contract docs and indexes stay navigable.',
    ));
  }
  if (!shape.reportContractDocIndexAnchorRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_index_anchor_regression_script_missing',
      'Core must expose reports:contract-doc-index-anchor-regression so manifest contract doc index anchors can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageLatestDetailRegressionModulePresent || !shape.reportContractDocPageLatestDetailRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_latest_detail_regression_missing',
      'Core must expose one versioned report contract doc page latest detail regression fixture so manifest contract docs pages name exact latest artifacts.',
    ));
  }
  if (!shape.reportContractDocPageLatestDetailRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_latest_detail_regression_script_missing',
      'Core must expose reports:contract-doc-page-latest-detail-regression so manifest contract docs page latest artifact detail can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageCommandSectionRegressionModulePresent || !shape.reportContractDocPageCommandSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_command_section_regression_missing',
      'Core must expose one versioned report contract doc page command section regression fixture so manifest contract docs pages keep executable command sections.',
    ));
  }
  if (!shape.reportContractDocPageCommandSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_command_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-command-section-regression so manifest contract docs page command sections can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageSafetySectionDetailRegressionModulePresent || !shape.reportContractDocPageSafetySectionDetailRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_safety_section_detail_regression_missing',
      'Core must expose one versioned report contract doc page safety section detail regression fixture so manifest contract docs pages keep native safety sections.',
    ));
  }
  if (!shape.reportContractDocPageSafetySectionDetailRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_safety_section_detail_regression_script_missing',
      'Core must expose reports:contract-doc-page-safety-section-detail-regression so manifest contract docs page safety section details can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageStrictGateSectionRegressionModulePresent || !shape.reportContractDocPageStrictGateSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_strict_gate_section_regression_missing',
      'Core must expose one versioned report contract doc page strict gate section regression fixture so manifest contract docs pages keep native strict gate sections.',
    ));
  }
  if (!shape.reportContractDocPageStrictGateSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_strict_gate_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-strict-gate-section-regression so manifest contract docs page strict gate sections can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageOutputSectionRegressionModulePresent || !shape.reportContractDocPageOutputSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_output_section_regression_missing',
      'Core must expose one versioned report contract doc page output section regression fixture so manifest contract docs pages keep explicit output artifact bindings.',
    ));
  }
  if (!shape.reportContractDocPageOutputSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_output_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-output-section-regression so manifest contract docs page output artifact bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageCrossReportSectionRegressionModulePresent || !shape.reportContractDocPageCrossReportSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_cross_report_section_regression_missing',
      'Core must expose one versioned report contract doc page cross-report section regression fixture so manifest contract docs pages keep explicit cross-report visibility bindings.',
    ));
  }
  if (!shape.reportContractDocPageCrossReportSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_cross_report_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-cross-report-section-regression so manifest contract docs page cross-report visibility bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutSectionRegressionModulePresent || !shape.reportContractDocPageCloseoutSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_section_regression_missing',
      'Core must expose one versioned report contract doc page closeout section regression fixture so manifest contract docs pages keep explicit final closeout probe bindings.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-closeout-section-regression so manifest contract docs page closeout probe bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPagePostGateWriterSectionRegressionModulePresent || !shape.reportContractDocPagePostGateWriterSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_post_gate_writer_section_regression_missing',
      'Core must expose one versioned report contract doc page post-gate writer section regression fixture so manifest contract docs pages keep explicit recovery boundaries for blocked post-gate latest writers.',
    ));
  }
  if (!shape.reportContractDocPagePostGateWriterSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_post_gate_writer_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-post-gate-writer-section-regression so manifest contract docs page post-gate writer recovery bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageRetentionSectionRegressionModulePresent || !shape.reportContractDocPageRetentionSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_retention_section_regression_missing',
      'Core must expose one versioned report contract doc page retention section regression fixture so manifest contract docs pages keep explicit local retention/prune dry-run boundaries.',
    ));
  }
  if (!shape.reportContractDocPageRetentionSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_retention_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-retention-section-regression so manifest contract docs page retention/prune bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageFreshnessHashSectionRegressionModulePresent || !shape.reportContractDocPageFreshnessHashSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_freshness_hash_section_regression_missing',
      'Core must expose one versioned report contract doc page freshness hash section regression fixture so manifest contract docs pages keep explicit freshness/hash parity boundaries.',
    ));
  }
  if (!shape.reportContractDocPageFreshnessHashSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_freshness_hash_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-freshness-hash-section-regression so manifest contract docs page freshness/hash bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageCheckpointHashSectionRegressionModulePresent || !shape.reportContractDocPageCheckpointHashSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_checkpoint_hash_section_regression_missing',
      'Core must expose one versioned report contract doc page checkpoint hash section regression fixture so manifest contract docs pages keep explicit checkpoint/hash visibility boundaries.',
    ));
  }
  if (!shape.reportContractDocPageCheckpointHashSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_checkpoint_hash_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-checkpoint-hash-section-regression so manifest contract docs page checkpoint/hash bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageBootstrapSeedSectionRegressionModulePresent || !shape.reportContractDocPageBootstrapSeedSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_bootstrap_seed_section_regression_missing',
      'Core must expose one versioned report contract doc page bootstrap seed section regression fixture so manifest contract docs pages keep explicit bootstrap seed recovery boundaries.',
    ));
  }
  if (!shape.reportContractDocPageBootstrapSeedSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_bootstrap_seed_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-bootstrap-seed-section-regression so manifest contract docs page bootstrap seed bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageCleanRerunSectionRegressionModulePresent || !shape.reportContractDocPageCleanRerunSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_clean_rerun_section_regression_missing',
      'Core must expose one versioned report contract doc page clean rerun section regression fixture so manifest contract docs pages keep explicit clean strict gate idempotence boundaries.',
    ));
  }
  if (!shape.reportContractDocPageCleanRerunSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_clean_rerun_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-clean-rerun-section-regression so manifest contract docs page clean rerun bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageFinalSettlementSectionRegressionModulePresent || !shape.reportContractDocPageFinalSettlementSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_final_settlement_section_regression_missing',
      'Core must expose one versioned report contract doc page final settlement section regression fixture so manifest contract docs pages keep explicit final closeout settlement order boundaries.',
    ));
  }
  if (!shape.reportContractDocPageFinalSettlementSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_final_settlement_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-final-settlement-section-regression so manifest contract docs page final settlement bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutIndexSectionRegressionModulePresent || !shape.reportContractDocPageCloseoutIndexSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_index_section_regression_missing',
      'Core must expose one versioned report contract doc page closeout index section regression fixture so manifest contract docs pages keep explicit final closeout index boundaries.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutIndexSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_index_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-closeout-index-section-regression so manifest contract docs page closeout index bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutEvidenceSectionRegressionModulePresent || !shape.reportContractDocPageCloseoutEvidenceSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_evidence_section_regression_missing',
      'Core must expose one versioned report contract doc page closeout evidence section regression fixture so manifest contract docs pages keep explicit final closeout evidence boundaries.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutEvidenceSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_evidence_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-closeout-evidence-section-regression so manifest contract docs page closeout evidence bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutLedgerSectionRegressionModulePresent || !shape.reportContractDocPageCloseoutLedgerSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_ledger_section_regression_missing',
      'Core must expose one versioned report contract doc page closeout ledger section regression fixture so manifest contract docs pages keep explicit final closeout ledger boundaries.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutLedgerSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_ledger_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-closeout-ledger-section-regression so manifest contract docs page closeout ledger bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutRetentionProofSectionRegressionModulePresent || !shape.reportContractDocPageCloseoutRetentionProofSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_retention_proof_section_regression_missing',
      'Core must expose one versioned report contract doc page closeout retention proof section regression fixture so manifest contract docs pages keep explicit no-archive/no-delete retention proof boundaries.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutRetentionProofSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_retention_proof_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-closeout-retention-proof-section-regression so manifest contract docs page closeout retention proof bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutProbeBundleSectionRegressionModulePresent || !shape.reportContractDocPageCloseoutProbeBundleSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_probe_bundle_section_regression_missing',
      'Core must expose one versioned report contract doc page closeout probe bundle section regression fixture so manifest contract docs pages keep final closeout probe bundle fields explicit.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutProbeBundleSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_probe_bundle_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-closeout-probe-bundle-section-regression so manifest contract docs page closeout probe bundle bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutSignoffSectionRegressionModulePresent || !shape.reportContractDocPageCloseoutSignoffSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_signoff_section_regression_missing',
      'Core must expose one versioned report contract doc page closeout signoff section regression fixture so manifest contract docs pages keep final local-only closeout signoff boundaries explicit.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutSignoffSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_signoff_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-closeout-signoff-section-regression so manifest contract docs page final closeout signoff bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutReleaseManifestSectionRegressionModulePresent || !shape.reportContractDocPageCloseoutReleaseManifestSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_release_manifest_section_regression_missing',
      'Core must expose one versioned report contract doc page closeout release manifest section regression fixture so manifest contract docs pages keep final release readiness boundaries explicit.',
    ));
  }
  if (!shape.reportContractDocPageCloseoutReleaseManifestSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_closeout_release_manifest_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-closeout-release-manifest-section-regression so manifest contract docs page final release manifest bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseArchiveIndexSectionRegressionModulePresent || !shape.reportContractDocPageReleaseArchiveIndexSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_archive_index_section_regression_missing',
      'Core must expose one versioned report contract doc page release archive index section regression fixture so manifest contract docs pages keep final release archive index boundaries explicit.',
    ));
  }
  if (!shape.reportContractDocPageReleaseArchiveIndexSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_archive_index_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-archive-index-section-regression so manifest contract docs page final release archive index bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseHandoffLedgerSectionRegressionModulePresent || !shape.reportContractDocPageReleaseHandoffLedgerSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_handoff_ledger_section_regression_missing',
      'Core must expose one versioned report contract doc page release handoff ledger section regression fixture so manifest contract docs pages keep final release handoff ledger boundaries explicit.',
    ));
  }
  if (!shape.reportContractDocPageReleaseHandoffLedgerSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_handoff_ledger_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-handoff-ledger-section-regression so manifest contract docs page final release handoff ledger bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseDeliveryReadinessSectionRegressionModulePresent || !shape.reportContractDocPageReleaseDeliveryReadinessSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_delivery_readiness_section_regression_missing',
      'Core must expose one versioned report contract doc page release delivery readiness section regression fixture so manifest contract docs pages keep final release delivery readiness boundaries explicit.',
    ));
  }
  if (!shape.reportContractDocPageReleaseDeliveryReadinessSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_delivery_readiness_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-delivery-readiness-section-regression so manifest contract docs page final release delivery readiness bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseExecutionDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleaseExecutionDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_execution_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release execution denial section regression fixture so manifest contract docs pages separate release delivery readiness from live execution permission.',
    ));
  }
  if (!shape.reportContractDocPageReleaseExecutionDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_execution_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-execution-denial-section-regression so manifest contract docs page final release execution denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseOperatorApprovalSectionRegressionModulePresent || !shape.reportContractDocPageReleaseOperatorApprovalSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_operator_approval_section_regression_missing',
      'Core must expose one versioned report contract doc page release operator approval section regression fixture so manifest contract docs pages require current-chat operator approval before external action.',
    ));
  }
  if (!shape.reportContractDocPageReleaseOperatorApprovalSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_operator_approval_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-operator-approval-section-regression so manifest contract docs page release operator approval bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseApprovalLedgerSectionRegressionModulePresent || !shape.reportContractDocPageReleaseApprovalLedgerSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_approval_ledger_section_regression_missing',
      'Core must expose one versioned report contract doc page release approval ledger section regression fixture so manifest contract docs pages record approval evidence as append-only ledger entries, not execution permission.',
    ));
  }
  if (!shape.reportContractDocPageReleaseApprovalLedgerSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_approval_ledger_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-approval-ledger-section-regression so manifest contract docs page release approval ledger bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseActionQueueSectionRegressionModulePresent || !shape.reportContractDocPageReleaseActionQueueSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_action_queue_section_regression_missing',
      'Core must expose one versioned report contract doc page release action queue section regression fixture so manifest contract docs pages keep queued action review local-only and non-executing.',
    ));
  }
  if (!shape.reportContractDocPageReleaseActionQueueSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_action_queue_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-action-queue-section-regression so manifest contract docs page release action queue bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_runner_dispatch_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release runner dispatch denial section regression fixture so manifest contract docs pages keep queued actions non-dispatchable and non-executing.',
    ));
  }
  if (!shape.reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_runner_dispatch_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-runner-dispatch-denial-section-regression so manifest contract docs page release runner dispatch denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseLiveActionPreflightSectionRegressionModulePresent || !shape.reportContractDocPageReleaseLiveActionPreflightSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_live_action_preflight_section_regression_missing',
      'Core must expose one versioned report contract doc page release live action preflight section regression fixture so manifest contract docs pages keep read-only preflight evidence separated from dispatch and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleaseLiveActionPreflightSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_live_action_preflight_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-live-action-preflight-section-regression so manifest contract docs page release live action preflight bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionModulePresent || !shape.reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_execution_intent_capture_section_regression_missing',
      'Core must expose one versioned report contract doc page release execution intent capture section regression fixture so manifest contract docs pages keep current-chat execution intent separated from preflight, approval, dispatch, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_execution_intent_capture_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-execution-intent-capture-section-regression so manifest contract docs page release execution intent capture bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionModulePresent || !shape.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_execution_approval_boundary_section_regression_missing',
      'Core must expose one versioned report contract doc page release execution approval boundary section regression fixture so manifest contract docs pages keep explicit approvals separated from standing authorization, dispatch, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_execution_approval_boundary_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-execution-approval-boundary-section-regression so manifest contract docs page release execution approval boundary bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseRunnerExecutionGateSectionRegressionModulePresent || !shape.reportContractDocPageReleaseRunnerExecutionGateSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_runner_execution_gate_section_regression_missing',
      'Core must expose one versioned report contract doc page release runner execution gate section regression fixture so manifest contract docs pages keep explicit approvals separated from standing authorization, dispatch, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleaseRunnerExecutionGateSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_runner_execution_gate_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-runner-execution-gate-section-regression so manifest contract docs page release runner execution gate bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_dispatch_implementation_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release dispatch implementation denial section regression fixture so manifest contract docs pages keep runner execution gate evidence separated from dispatch implementation, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_dispatch_implementation_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-dispatch-implementation-denial-section-regression so manifest contract docs page release dispatch implementation denial bindings can be regenerated locally.',
    ));
  }

  if (!shape.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_platform_state_snapshot_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release platform-state snapshot denial section regression fixture so manifest contract docs pages keep runner execution gate evidence separated from dispatch implementation, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_platform_state_snapshot_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-platform-state-snapshot-denial-section-regression so manifest contract docs page release platform-state snapshot denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseDryRunReplayDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleaseDryRunReplayDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_dry_run_replay_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release dry-run replay denial section regression fixture so manifest contract docs pages keep platform-state snapshot evidence separated from dry-run replay, live replay, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleaseDryRunReplayDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_dry_run_replay_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-dry-run-replay-denial-section-regression so manifest contract docs page release dry-run replay denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseProofBundleDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleaseProofBundleDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_proof_bundle_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release proof-bundle denial section regression fixture so manifest contract docs pages keep dry-run replay evidence separated from proof bundles, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleaseProofBundleDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_proof_bundle_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-proof-bundle-denial-section-regression so manifest contract docs page release proof-bundle denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseLedgerDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleaseLedgerDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_ledger_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release ledger denial section regression fixture so manifest contract docs pages keep proof-bundle evidence separated from ledger mutation, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleaseLedgerDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_ledger_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-ledger-denial-section-regression so manifest contract docs page release ledger denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_audit_evidence_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release audit-evidence denial section regression fixture so manifest contract docs pages keep ledger evidence separated from audit writes, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_audit_evidence_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-audit-evidence-denial-section-regression so manifest contract docs page release audit-evidence denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_receipt_evidence_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release receipt-evidence denial section regression fixture so manifest contract docs pages keep audit-evidence proof separated from receipt writes, audit writes, ledger mutation, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_receipt_evidence_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-receipt-evidence-denial-section-regression so manifest contract docs page release receipt-evidence denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionReceiptDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleasePostActionReceiptDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_receipt_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release post-action receipt denial section regression fixture so manifest contract docs pages keep receipt evidence separated from post-action receipt writes, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionReceiptDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_receipt_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-post-action-receipt-denial-section-regression so manifest contract docs page release post-action receipt denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionAuditDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleasePostActionAuditDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_audit_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release post-action audit denial section regression fixture so manifest contract docs pages keep post-action receipt evidence separated from post-action audit writes, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionAuditDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_audit_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-post-action-audit-denial-section-regression so manifest contract docs page release post-action audit denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_reconciliation_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release post-action reconciliation denial section regression fixture so manifest contract docs pages keep post-action audit evidence separated from post-action reconciliation writes, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_reconciliation_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-post-action-reconciliation-denial-section-regression so manifest contract docs page release post-action reconciliation denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionSettlementDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleasePostActionSettlementDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_settlement_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release post-action settlement denial section regression fixture so manifest contract docs pages keep post-action reconciliation evidence separated from post-action settlement writes, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionSettlementDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_settlement_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-post-action-settlement-denial-section-regression so manifest contract docs page release post-action settlement denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_acceptance_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release post-action acceptance denial section regression fixture so manifest contract docs pages keep post-action settlement evidence separated from post-action acceptance writes, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_acceptance_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-post-action-acceptance-denial-section-regression so manifest contract docs page release post-action acceptance denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionPaymentDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleasePostActionPaymentDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_payment_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release post-action payment denial section regression fixture so manifest contract docs pages keep post-action acceptance evidence separated from post-action payment writes, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionPaymentDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_payment_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-post-action-payment-denial-section-regression so manifest contract docs page release post-action payment denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_deployment_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release post-action deployment denial section regression fixture so manifest contract docs pages keep post-action payment evidence separated from post-action deployment writes, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_deployment_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-post-action-deployment-denial-section-regression so manifest contract docs page release post-action deployment denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_provider_spend_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release post-action provider spend denial section regression fixture so manifest contract docs pages keep post-action deployment evidence separated from post-action provider/model spend writes, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_provider_spend_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-post-action-provider-spend-denial-section-regression so manifest contract docs page release post-action provider spend denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_state_transition_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release post-action state transition denial section regression fixture so manifest contract docs pages keep post-action provider spend evidence separated from local state transitions, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_state_transition_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-post-action-state-transition-denial-section-regression so manifest contract docs page release post-action state transition denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release post-action queue consumption denial section regression fixture so manifest contract docs pages keep post-action state transition evidence separated from queue consumption, background runners, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-post-action-queue-consumption-denial-section-regression so manifest contract docs page release post-action queue consumption denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_background_runner_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release post-action background runner denial section regression fixture so manifest contract docs pages keep post-action queue consumption evidence separated from background runners, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_background_runner_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-post-action-background-runner-denial-section-regression so manifest contract docs page release post-action background runner denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionModulePresent || !shape.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression_missing',
      'Core must expose one versioned report contract doc page release post-action dispatch completion denial section regression fixture so manifest contract docs pages keep post-action background runner evidence separated from dispatch completions, live writes, write adapters, and execution.',
    ));
  }
  if (!shape.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression_script_missing',
      'Core must expose reports:contract-doc-page-release-post-action-dispatch-completion-denial-section-regression so manifest contract docs page release post-action dispatch completion denial bindings can be regenerated locally.',
    ));
  }
  if (!shape.reportManifestDriftRegressionModulePresent || !shape.reportManifestDriftRegressionVersioned) {
    blockers.push(blocker(
      'core_report_manifest_drift_regression_missing',
      'Core must expose one versioned report manifest drift regression fixture so manifest changes cannot drift away from package/gate/freshness/tooling/checkpoint wiring.',
    ));
  }
  if (!shape.reportManifestDriftRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_manifest_drift_regression_script_missing',
      'Core must expose reports:manifest-drift-regression so manifest drift regressions can be regenerated locally.',
    ));
  }
  if (!shape.reportLatestRecoveryRegressionModulePresent || !shape.reportLatestRecoveryRegressionVersioned) {
    blockers.push(blocker(
      'core_report_latest_recovery_regression_missing',
      'Core must expose one versioned report latest recovery regression fixture so latest-report contamination and bootstrap recovery stay proven.',
    ));
  }
  if (!shape.reportLatestRecoveryRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_latest_recovery_regression_script_missing',
      'Core must expose reports:latest-recovery-regression so latest-report recovery regressions can be regenerated locally.',
    ));
  }
  if (!shape.reportBootstrapSeedRegressionModulePresent || !shape.reportBootstrapSeedRegressionVersioned) {
    blockers.push(blocker(
      'core_report_bootstrap_seed_regression_missing',
      'Core must expose one versioned report bootstrap seed regression fixture so temporary latest-report recovery seeds stay allowlisted, synthetic, and replaced by final gate output.',
    ));
  }
  if (!shape.reportBootstrapSeedRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_bootstrap_seed_regression_script_missing',
      'Core must expose reports:bootstrap-seed-regression so bootstrap seed boundaries can be regenerated locally.',
    ));
  }
  if (!shape.reportGateCleanRerunRegressionModulePresent || !shape.reportGateCleanRerunRegressionVersioned) {
    blockers.push(blocker(
      'core_report_gate_clean_rerun_regression_missing',
      'Core must expose one versioned report gate clean rerun regression fixture so conditional bootstrap seeds stay skipped on clean reruns.',
    ));
  }
  if (!shape.reportGateCleanRerunRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_gate_clean_rerun_regression_script_missing',
      'Core must expose reports:gate-clean-rerun-regression so clean rerun seed-skip regressions can be regenerated locally.',
    ));
  }
  if (!shape.reportCleanGateIdempotenceRegressionModulePresent || !shape.reportCleanGateIdempotenceRegressionVersioned) {
    blockers.push(blocker(
      'core_report_clean_gate_idempotence_regression_missing',
      'Core must expose one versioned report clean gate idempotence regression fixture so repeated clean gate runs keep stable hashes and seed skips.',
    ));
  }
  if (!shape.reportCleanGateIdempotenceRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_clean_gate_idempotence_regression_script_missing',
      'Core must expose reports:clean-gate-idempotence-regression so clean gate idempotence can be regenerated locally.',
    ));
  }
  if (!shape.reportFinalSettlementRegressionModulePresent || !shape.reportFinalSettlementRegressionVersioned) {
    blockers.push(blocker(
      'core_report_final_settlement_regression_missing',
      'Core must expose one versioned report final settlement regression fixture so final gate/freshness/checkpoint/seed closeout order stays proven.',
    ));
  }
  if (!shape.reportFinalSettlementRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_final_settlement_regression_script_missing',
      'Core must expose reports:final-settlement-regression so final closeout regressions can be regenerated locally.',
    ));
  }
  if (!shape.reportPostFinalDriftRegressionModulePresent || !shape.reportPostFinalDriftRegressionVersioned) {
    blockers.push(blocker(
      'core_report_post_final_drift_regression_missing',
      'Core must expose one versioned report post-final drift regression fixture so latest writes after final closeout are blocked until clean closeout reruns.',
    ));
  }
  if (!shape.reportPostFinalDriftRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_post_final_drift_regression_script_missing',
      'Core must expose reports:post-final-drift-regression so post-final drift regressions can be regenerated locally.',
    ));
  }
  if (!shape.reportCloseoutDriftClassificationRegressionModulePresent || !shape.reportCloseoutDriftClassificationRegressionVersioned) {
    blockers.push(blocker(
      'core_report_closeout_drift_classification_regression_missing',
      'Core must expose one versioned report closeout drift classification regression fixture so post-final commands stay risk-classified.',
    ));
  }
  if (!shape.reportCloseoutDriftClassificationRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_closeout_drift_classification_regression_script_missing',
      'Core must expose reports:closeout-drift-classification-regression so closeout drift command classifications can be regenerated locally.',
    ));
  }
  if (!shape.reportCloseoutCommandInventoryRegressionModulePresent || !shape.reportCloseoutCommandInventoryRegressionVersioned) {
    blockers.push(blocker(
      'core_report_closeout_command_inventory_regression_missing',
      'Core must expose one versioned report closeout command inventory regression fixture so package scripts, docs, and gate steps cannot add closeout commands outside the classification inventory.',
    ));
  }
  if (!shape.reportCloseoutCommandInventoryRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_closeout_command_inventory_regression_script_missing',
      'Core must expose reports:closeout-command-inventory-regression so closeout command inventory drift can be regenerated locally.',
    ));
  }
  if (!shape.reportRunnerContractRegressionModulePresent || !shape.reportRunnerContractRegressionVersioned) {
    blockers.push(blocker(
      'core_report_runner_contract_regression_missing',
      'Core must expose one versioned report runner contract regression fixture so report exporters cannot pass without strict stdout/hash/reportFiles contracts.',
    ));
  }
  if (!shape.reportRunnerContractRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_runner_contract_regression_script_missing',
      'Core must expose reports:runner-contract-regression so report exporter runner contracts can be regenerated locally.',
    ));
  }
  if (!shape.reportRetentionModulePresent || !shape.reportRetentionVersioned) {
    blockers.push(blocker(
      'core_report_retention_guard_missing',
      'Core must expose one versioned report retention guard so timestamped reports can be classified without deleting files.',
    ));
  }
  if (!shape.reportRetentionRegressionModulePresent || !shape.reportRetentionRegressionVersioned) {
    blockers.push(blocker(
      'core_report_retention_regression_missing',
      'Core must expose one versioned report retention regression fixture so latest/README protection and archive-candidate classification stay proven.',
    ));
  }
  if (!shape.reportRetentionRegressionScriptPresent) {
    blockers.push(blocker(
      'core_report_retention_regression_script_missing',
      'Core must expose reports:retention-regression so the negative report retention fixture can be regenerated locally.',
    ));
  }
  if (!shape.integrationGateToolingModulePresent || !shape.integrationGateToolingPublic || !shape.integrationGateToolingVersioned) {
    blockers.push(blocker(
      'core_integration_gate_tooling_missing',
      'Core must expose one stable integration gate tooling facade while keeping the audit implementation CLI-only.',
    ));
  }
  if (!shape.integrationGateToolingScriptPresent) {
    blockers.push(blocker(
      'core_integration_gate_tooling_script_missing',
      'Core must expose integration:tooling so local architecture gate tooling metadata can be regenerated.',
    ));
  }
  if (!shape.channelImportAllowlistModulePresent || !shape.channelImportAllowlistPublic || !shape.channelImportAllowlistVersioned) {
    blockers.push(blocker(
      'core_channel_import_allowlist_missing',
      'Core must expose one versioned channel import allowlist so channel relative core imports cannot bypass the stable package surface.',
    ));
  }
  if (!shape.channelImportAllowlistScriptPresent) {
    blockers.push(blocker(
      'core_channel_import_allowlist_script_missing',
      'Core must expose channel:imports so channel import allowlist reports can be regenerated locally.',
    ));
  }
  if (!shape.packageRootResolverModulePresent || !shape.packageRootResolverPublic || !shape.packageRootResolverVersioned) {
    blockers.push(blocker(
      'core_package_root_resolver_missing',
      'Core must expose one versioned package-root resolver smoke gate so channel package-name imports cannot be rewritten before Node can resolve them.',
    ));
  }
  if (!shape.packageRootResolverScriptPresent) {
    blockers.push(blocker(
      'core_package_root_resolver_script_missing',
      'Core must expose package-root:resolver so channel package-name resolver probes can be regenerated locally.',
    ));
  }
  if (!shape.packageRootImportMigrationModulePresent || !shape.packageRootImportMigrationPublic || !shape.packageRootImportMigrationVersioned) {
    blockers.push(blocker(
      'core_package_root_import_migration_missing',
      'Core must expose one versioned package-root import migration plan so channel relative imports can be retired deliberately.',
    ));
  }
  if (!shape.packageRootImportMigrationScriptPresent) {
    blockers.push(blocker(
      'core_package_root_import_migration_script_missing',
      'Core must expose package-root:migration so the channel package-root import migration plan can be regenerated locally.',
    ));
  }
  if (!shape.packageRootImportRegressionModulePresent || !shape.packageRootImportRegressionVersioned) {
    blockers.push(blocker(
      'core_package_root_import_regression_missing',
      'Core must expose one versioned package-root import regression fixture so sibling relative core-src imports stay blocked after migration.',
    ));
  }
  if (!shape.packageRootImportRegressionScriptPresent) {
    blockers.push(blocker(
      'core_package_root_import_regression_script_missing',
      'Core must expose package-root:regression so the negative package-root import fixture can be regenerated locally.',
    ));
  }
  if (!shape.packageRootSymbolManifestModulePresent || !shape.packageRootSymbolManifestVersioned) {
    blockers.push(blocker(
      'core_package_root_symbol_manifest_missing',
      'Core must expose one versioned package-root symbol manifest so channel package-root named imports cannot drift silently.',
    ));
  }
  if (!shape.packageRootSymbolManifestScriptPresent) {
    blockers.push(blocker(
      'core_package_root_symbol_manifest_script_missing',
      'Core must expose package-root:symbols so channel package-root named import manifests can be regenerated locally.',
    ));
  }
  if (!shape.packageRootSymbolRegressionModulePresent || !shape.packageRootSymbolRegressionVersioned) {
    blockers.push(blocker(
      'core_package_root_symbol_regression_missing',
      'Core must expose one versioned package-root symbol regression fixture so namespace/default/unlisted package-root imports stay blocked.',
    ));
  }
  if (!shape.packageRootSymbolRegressionScriptPresent) {
    blockers.push(blocker(
      'core_package_root_symbol_regression_script_missing',
      'Core must expose package-root:symbol-regression so the negative package-root symbol fixture can be regenerated locally.',
    ));
  }
  if (!shape.packageRootSymbolMinimizationModulePresent || !shape.packageRootSymbolMinimizationVersioned) {
    blockers.push(blocker(
      'core_package_root_symbol_minimization_missing',
      'Core must expose one versioned package-root symbol minimization report so unused per-channel symbol allowances can be reviewed before shrinking.',
    ));
  }
  if (!shape.packageRootSymbolMinimizationScriptPresent) {
    blockers.push(blocker(
      'core_package_root_symbol_minimization_script_missing',
      'Core must expose package-root:symbol-minimize so the report-only exact-current symbol manifest plan can be regenerated locally.',
    ));
  }
  for (const allowlistBlocker of channelImportAllowlist?.blockers || []) {
    blockers.push(blocker(
      `channel_import_allowlist_${allowlistBlocker.code}`,
      `${allowlistBlocker.notes}${allowlistBlocker.file ? ` (${allowlistBlocker.file}:${allowlistBlocker.line})` : ''}`,
      allowlistBlocker.file?.split('/')[0] || 'design-production-core',
    ));
  }
  for (const resolverBlocker of packageRootResolver?.blockers || []) {
    blockers.push(blocker(
      `package_root_resolver_${resolverBlocker.code}`,
      `${resolverBlocker.notes}${resolverBlocker.cwd ? ` (${resolverBlocker.cwd})` : ''}`,
      resolverBlocker.cwd?.split('/')[0] || 'design-production-core',
    ));
  }
  for (const migrationBlocker of packageRootImportMigration?.blockers || []) {
    blockers.push(blocker(
      `package_root_import_migration_${migrationBlocker.code}`,
      `${migrationBlocker.notes}${migrationBlocker.file ? ` (${migrationBlocker.file}:${migrationBlocker.line})` : ''}`,
      migrationBlocker.file?.split('/')[0] || 'design-production-core',
    ));
  }
  for (const regressionBlocker of packageRootImportRegression?.blockers || []) {
    blockers.push(blocker(
      `package_root_import_regression_${regressionBlocker.code}`,
      regressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const symbolBlocker of packageRootSymbolManifest?.blockers || []) {
    blockers.push(blocker(
      `package_root_symbol_manifest_${symbolBlocker.code}`,
      `${symbolBlocker.notes}${symbolBlocker.file ? ` (${symbolBlocker.file}:${symbolBlocker.line})` : ''}`,
      symbolBlocker.file?.split('/')[0] || 'design-production-core',
    ));
  }
  for (const symbolRegressionBlocker of packageRootSymbolRegression?.blockers || []) {
    blockers.push(blocker(
      `package_root_symbol_regression_${symbolRegressionBlocker.code}`,
      symbolRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const symbolMinimizationBlocker of packageRootSymbolMinimization?.blockers || []) {
    blockers.push(blocker(
      `package_root_symbol_minimization_${symbolMinimizationBlocker.code}`,
      `${symbolMinimizationBlocker.notes}${symbolMinimizationBlocker.file ? ` (${symbolMinimizationBlocker.file}:${symbolMinimizationBlocker.line})` : ''}`,
      symbolMinimizationBlocker.file?.split('/')[0] || 'design-production-core',
    ));
  }
  for (const freshnessBlocker of reportFreshness?.blockers || []) {
    blockers.push(blocker(
      `report_freshness_${freshnessBlocker.code}`,
      freshnessBlocker.notes,
      'design-production-core',
    ));
  }
  for (const freshnessRegressionBlocker of reportFreshnessRegression?.blockers || []) {
    blockers.push(blocker(
      `report_freshness_regression_${freshnessRegressionBlocker.code}`,
      freshnessRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const sequenceRegressionBlocker of integrationGateSequenceRegression?.blockers || []) {
    blockers.push(blocker(
      `integration_gate_sequence_regression_${sequenceRegressionBlocker.code}`,
      sequenceRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const inventoryConsistencyBlocker of reportInventoryConsistency?.blockers || []) {
    blockers.push(blocker(
      `report_inventory_consistency_${inventoryConsistencyBlocker.code}`,
      inventoryConsistencyBlocker.notes,
      'design-production-core',
    ));
  }
  for (const schemaContractBlocker of reportSchemaContract?.blockers || []) {
    blockers.push(blocker(
      `report_schema_contract_${schemaContractBlocker.code}`,
      schemaContractBlocker.notes,
      'design-production-core',
    ));
  }
  for (const lineageTopologyBlocker of reportLineageTopology?.blockers || []) {
    blockers.push(blocker(
      `report_lineage_topology_${lineageTopologyBlocker.code}`,
      lineageTopologyBlocker.notes,
      'design-production-core',
    ));
  }
  for (const hashStabilityRegressionBlocker of reportHashStabilityRegression?.blockers || []) {
    blockers.push(blocker(
      `report_hash_stability_regression_${hashStabilityRegressionBlocker.code}`,
      hashStabilityRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const outputPairingBlocker of reportOutputPairing?.blockers || []) {
    blockers.push(blocker(
      `report_output_pairing_${outputPairingBlocker.code}`,
      outputPairingBlocker.notes,
      'design-production-core',
    ));
  }
  for (const artifactReproducibilityBlocker of reportArtifactReproducibility?.blockers || []) {
    blockers.push(blocker(
      `report_artifact_reproducibility_${artifactReproducibilityBlocker.code}`,
      artifactReproducibilityBlocker.notes,
      'design-production-core',
    ));
  }
  for (const selfReferenceBoundaryRegressionBlocker of reportSelfReferenceBoundaryRegression?.blockers || []) {
    blockers.push(blocker(
      `report_self_reference_boundary_regression_${selfReferenceBoundaryRegressionBlocker.code}`,
      selfReferenceBoundaryRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractManifestBlocker of reportContractManifest?.blockers || []) {
    blockers.push(blocker(
      `report_contract_manifest_${contractManifestBlocker.code}`,
      contractManifestBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractRequiredCoverageRegressionBlocker of reportContractRequiredCoverageRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_required_coverage_regression_${contractRequiredCoverageRegressionBlocker.code}`,
      contractRequiredCoverageRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocCoverageRegressionBlocker of reportContractDocCoverageRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_coverage_regression_${contractDocCoverageRegressionBlocker.code}`,
      contractDocCoverageRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractSyntaxCoverageRegressionBlocker of reportContractSyntaxCoverageRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_syntax_coverage_regression_${contractSyntaxCoverageRegressionBlocker.code}`,
      contractSyntaxCoverageRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractSourceDerivationRegressionBlocker of reportContractSourceDerivationRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_source_derivation_regression_${contractSourceDerivationRegressionBlocker.code}`,
      contractSourceDerivationRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractSummaryKeyRegressionBlocker of reportContractSummaryKeyRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_summary_key_regression_${contractSummaryKeyRegressionBlocker.code}`,
      contractSummaryKeyRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractAuditForwardingRegressionBlocker of reportContractAuditForwardingRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_audit_forwarding_regression_${contractAuditForwardingRegressionBlocker.code}`,
      contractAuditForwardingRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractCheckpointBindingShapeRegressionBlocker of reportContractCheckpointBindingShapeRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_checkpoint_binding_shape_regression_${contractCheckpointBindingShapeRegressionBlocker.code}`,
      contractCheckpointBindingShapeRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractGateSummaryShapeRegressionBlocker of reportContractGateSummaryShapeRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_gate_summary_shape_regression_${contractGateSummaryShapeRegressionBlocker.code}`,
      contractGateSummaryShapeRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractExporterStdoutShapeRegressionBlocker of reportContractExporterStdoutShapeRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_exporter_stdout_shape_regression_${contractExporterStdoutShapeRegressionBlocker.code}`,
      contractExporterStdoutShapeRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractSafetyFlagRegressionBlocker of reportContractSafetyFlagRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_safety_flag_regression_${contractSafetyFlagRegressionBlocker.code}`,
      contractSafetyFlagRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractArtifactBindingRegressionBlocker of reportContractArtifactBindingRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_artifact_binding_regression_${contractArtifactBindingRegressionBlocker.code}`,
      contractArtifactBindingRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocIndexAnchorRegressionBlocker of reportContractDocIndexAnchorRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_index_anchor_regression_${contractDocIndexAnchorRegressionBlocker.code}`,
      contractDocIndexAnchorRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageLatestDetailRegressionBlocker of reportContractDocPageLatestDetailRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_latest_detail_regression_${contractDocPageLatestDetailRegressionBlocker.code}`,
      contractDocPageLatestDetailRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageCommandSectionRegressionBlocker of reportContractDocPageCommandSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_command_section_regression_${contractDocPageCommandSectionRegressionBlocker.code}`,
      contractDocPageCommandSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageSafetySectionDetailRegressionBlocker of reportContractDocPageSafetySectionDetailRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_safety_section_detail_regression_${contractDocPageSafetySectionDetailRegressionBlocker.code}`,
      contractDocPageSafetySectionDetailRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageStrictGateSectionRegressionBlocker of reportContractDocPageStrictGateSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_strict_gate_section_regression_${contractDocPageStrictGateSectionRegressionBlocker.code}`,
      contractDocPageStrictGateSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageOutputSectionRegressionBlocker of reportContractDocPageOutputSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_output_section_regression_${contractDocPageOutputSectionRegressionBlocker.code}`,
      contractDocPageOutputSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageCrossReportSectionRegressionBlocker of reportContractDocPageCrossReportSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_cross_report_section_regression_${contractDocPageCrossReportSectionRegressionBlocker.code}`,
      contractDocPageCrossReportSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageCloseoutSectionRegressionBlocker of reportContractDocPageCloseoutSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_closeout_section_regression_${contractDocPageCloseoutSectionRegressionBlocker.code}`,
      contractDocPageCloseoutSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPagePostGateWriterSectionRegressionBlocker of reportContractDocPagePostGateWriterSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_post_gate_writer_section_regression_${contractDocPagePostGateWriterSectionRegressionBlocker.code}`,
      contractDocPagePostGateWriterSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageRetentionSectionRegressionBlocker of reportContractDocPageRetentionSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_retention_section_regression_${contractDocPageRetentionSectionRegressionBlocker.code}`,
      contractDocPageRetentionSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageFreshnessHashSectionRegressionBlocker of reportContractDocPageFreshnessHashSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_freshness_hash_section_regression_${contractDocPageFreshnessHashSectionRegressionBlocker.code}`,
      contractDocPageFreshnessHashSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageCheckpointHashSectionRegressionBlocker of reportContractDocPageCheckpointHashSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_checkpoint_hash_section_regression_${contractDocPageCheckpointHashSectionRegressionBlocker.code}`,
      contractDocPageCheckpointHashSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageBootstrapSeedSectionRegressionBlocker of reportContractDocPageBootstrapSeedSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_bootstrap_seed_section_regression_${contractDocPageBootstrapSeedSectionRegressionBlocker.code}`,
      contractDocPageBootstrapSeedSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageCleanRerunSectionRegressionBlocker of reportContractDocPageCleanRerunSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_clean_rerun_section_regression_${contractDocPageCleanRerunSectionRegressionBlocker.code}`,
      contractDocPageCleanRerunSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageFinalSettlementSectionRegressionBlocker of reportContractDocPageFinalSettlementSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_final_settlement_section_regression_${contractDocPageFinalSettlementSectionRegressionBlocker.code}`,
      contractDocPageFinalSettlementSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageCloseoutIndexSectionRegressionBlocker of reportContractDocPageCloseoutIndexSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_closeout_index_section_regression_${contractDocPageCloseoutIndexSectionRegressionBlocker.code}`,
      contractDocPageCloseoutIndexSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageCloseoutEvidenceSectionRegressionBlocker of reportContractDocPageCloseoutEvidenceSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_closeout_evidence_section_regression_${contractDocPageCloseoutEvidenceSectionRegressionBlocker.code}`,
      contractDocPageCloseoutEvidenceSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageCloseoutLedgerSectionRegressionBlocker of reportContractDocPageCloseoutLedgerSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_closeout_ledger_section_regression_${contractDocPageCloseoutLedgerSectionRegressionBlocker.code}`,
      contractDocPageCloseoutLedgerSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageCloseoutRetentionProofSectionRegressionBlocker of reportContractDocPageCloseoutRetentionProofSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_closeout_retention_proof_section_regression_${contractDocPageCloseoutRetentionProofSectionRegressionBlocker.code}`,
      contractDocPageCloseoutRetentionProofSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageCloseoutProbeBundleSectionRegressionBlocker of reportContractDocPageCloseoutProbeBundleSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_closeout_probe_bundle_section_regression_${contractDocPageCloseoutProbeBundleSectionRegressionBlocker.code}`,
      contractDocPageCloseoutProbeBundleSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageCloseoutSignoffSectionRegressionBlocker of reportContractDocPageCloseoutSignoffSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_closeout_signoff_section_regression_${contractDocPageCloseoutSignoffSectionRegressionBlocker.code}`,
      contractDocPageCloseoutSignoffSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageCloseoutReleaseManifestSectionRegressionBlocker of reportContractDocPageCloseoutReleaseManifestSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_closeout_release_manifest_section_regression_${contractDocPageCloseoutReleaseManifestSectionRegressionBlocker.code}`,
      contractDocPageCloseoutReleaseManifestSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseArchiveIndexSectionRegressionBlocker of reportContractDocPageReleaseArchiveIndexSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_archive_index_section_regression_${contractDocPageReleaseArchiveIndexSectionRegressionBlocker.code}`,
      contractDocPageReleaseArchiveIndexSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseHandoffLedgerSectionRegressionBlocker of reportContractDocPageReleaseHandoffLedgerSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_handoff_ledger_section_regression_${contractDocPageReleaseHandoffLedgerSectionRegressionBlocker.code}`,
      contractDocPageReleaseHandoffLedgerSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseDeliveryReadinessSectionRegressionBlocker of reportContractDocPageReleaseDeliveryReadinessSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_delivery_readiness_section_regression_${contractDocPageReleaseDeliveryReadinessSectionRegressionBlocker.code}`,
      contractDocPageReleaseDeliveryReadinessSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseExecutionDenialSectionRegressionBlocker of reportContractDocPageReleaseExecutionDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_execution_denial_section_regression_${contractDocPageReleaseExecutionDenialSectionRegressionBlocker.code}`,
      contractDocPageReleaseExecutionDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseOperatorApprovalSectionRegressionBlocker of reportContractDocPageReleaseOperatorApprovalSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_operator_approval_section_regression_${contractDocPageReleaseOperatorApprovalSectionRegressionBlocker.code}`,
      contractDocPageReleaseOperatorApprovalSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseApprovalLedgerSectionRegressionBlocker of reportContractDocPageReleaseApprovalLedgerSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_approval_ledger_section_regression_${contractDocPageReleaseApprovalLedgerSectionRegressionBlocker.code}`,
      contractDocPageReleaseApprovalLedgerSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseActionQueueSectionRegressionBlocker of reportContractDocPageReleaseActionQueueSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_action_queue_section_regression_${contractDocPageReleaseActionQueueSectionRegressionBlocker.code}`,
      contractDocPageReleaseActionQueueSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseRunnerDispatchDenialSectionRegressionBlocker of reportContractDocPageReleaseRunnerDispatchDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_runner_dispatch_denial_section_regression_${contractDocPageReleaseRunnerDispatchDenialSectionRegressionBlocker.code}`,
      contractDocPageReleaseRunnerDispatchDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseLiveActionPreflightSectionRegressionBlocker of reportContractDocPageReleaseLiveActionPreflightSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_live_action_preflight_section_regression_${contractDocPageReleaseLiveActionPreflightSectionRegressionBlocker.code}`,
      contractDocPageReleaseLiveActionPreflightSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseExecutionIntentCaptureSectionRegressionBlocker of reportContractDocPageReleaseExecutionIntentCaptureSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_execution_intent_capture_section_regression_${contractDocPageReleaseExecutionIntentCaptureSectionRegressionBlocker.code}`,
      contractDocPageReleaseExecutionIntentCaptureSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseExecutionApprovalBoundarySectionRegressionBlocker of reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_execution_approval_boundary_section_regression_${contractDocPageReleaseExecutionApprovalBoundarySectionRegressionBlocker.code}`,
      contractDocPageReleaseExecutionApprovalBoundarySectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseRunnerExecutionGateSectionRegressionBlocker of reportContractDocPageReleaseRunnerExecutionGateSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_runner_execution_gate_section_regression_${contractDocPageReleaseRunnerExecutionGateSectionRegressionBlocker.code}`,
      contractDocPageReleaseRunnerExecutionGateSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseDispatchImplementationDenialSectionRegressionBlocker of reportContractDocPageReleaseDispatchImplementationDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_dispatch_implementation_denial_section_regression_${contractDocPageReleaseDispatchImplementationDenialSectionRegressionBlocker.code}`,
      contractDocPageReleaseDispatchImplementationDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleasePlatformStateSnapshotDenialSectionRegressionBlocker of reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_platform_state_snapshot_denial_section_regression_${contractDocPageReleasePlatformStateSnapshotDenialSectionRegressionBlocker.code}`,
      contractDocPageReleasePlatformStateSnapshotDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseDryRunReplayDenialSectionRegressionBlocker of reportContractDocPageReleaseDryRunReplayDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_dry_run_replay_denial_section_regression_${contractDocPageReleaseDryRunReplayDenialSectionRegressionBlocker.code}`,
      contractDocPageReleaseDryRunReplayDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseProofBundleDenialSectionRegressionBlocker of reportContractDocPageReleaseProofBundleDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_proof_bundle_denial_section_regression_${contractDocPageReleaseProofBundleDenialSectionRegressionBlocker.code}`,
      contractDocPageReleaseProofBundleDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseLedgerDenialSectionRegressionBlocker of reportContractDocPageReleaseLedgerDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_ledger_denial_section_regression_${contractDocPageReleaseLedgerDenialSectionRegressionBlocker.code}`,
      contractDocPageReleaseLedgerDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseAuditEvidenceDenialSectionRegressionBlocker of reportContractDocPageReleaseAuditEvidenceDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_audit_evidence_denial_section_regression_${contractDocPageReleaseAuditEvidenceDenialSectionRegressionBlocker.code}`,
      contractDocPageReleaseAuditEvidenceDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleaseReceiptEvidenceDenialSectionRegressionBlocker of reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_receipt_evidence_denial_section_regression_${contractDocPageReleaseReceiptEvidenceDenialSectionRegressionBlocker.code}`,
      contractDocPageReleaseReceiptEvidenceDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleasePostActionReceiptDenialSectionRegressionBlocker of reportContractDocPageReleasePostActionReceiptDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_post_action_receipt_denial_section_regression_${contractDocPageReleasePostActionReceiptDenialSectionRegressionBlocker.code}`,
      contractDocPageReleasePostActionReceiptDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleasePostActionAuditDenialSectionRegressionBlocker of reportContractDocPageReleasePostActionAuditDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_post_action_audit_denial_section_regression_${contractDocPageReleasePostActionAuditDenialSectionRegressionBlocker.code}`,
      contractDocPageReleasePostActionAuditDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleasePostActionReconciliationDenialSectionRegressionBlocker of reportContractDocPageReleasePostActionReconciliationDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_post_action_reconciliation_denial_section_regression_${contractDocPageReleasePostActionReconciliationDenialSectionRegressionBlocker.code}`,
      contractDocPageReleasePostActionReconciliationDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleasePostActionSettlementDenialSectionRegressionBlocker of reportContractDocPageReleasePostActionSettlementDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_post_action_settlement_denial_section_regression_${contractDocPageReleasePostActionSettlementDenialSectionRegressionBlocker.code}`,
      contractDocPageReleasePostActionSettlementDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleasePostActionAcceptanceDenialSectionRegressionBlocker of reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_post_action_acceptance_denial_section_regression_${contractDocPageReleasePostActionAcceptanceDenialSectionRegressionBlocker.code}`,
      contractDocPageReleasePostActionAcceptanceDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleasePostActionPaymentDenialSectionRegressionBlocker of reportContractDocPageReleasePostActionPaymentDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_post_action_payment_denial_section_regression_${contractDocPageReleasePostActionPaymentDenialSectionRegressionBlocker.code}`,
      contractDocPageReleasePostActionPaymentDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleasePostActionDeploymentDenialSectionRegressionBlocker of reportContractDocPageReleasePostActionDeploymentDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_post_action_deployment_denial_section_regression_${contractDocPageReleasePostActionDeploymentDenialSectionRegressionBlocker.code}`,
      contractDocPageReleasePostActionDeploymentDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleasePostActionProviderSpendDenialSectionRegressionBlocker of reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_post_action_provider_spend_denial_section_regression_${contractDocPageReleasePostActionProviderSpendDenialSectionRegressionBlocker.code}`,
      contractDocPageReleasePostActionProviderSpendDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleasePostActionStateTransitionDenialSectionRegressionBlocker of reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_post_action_state_transition_denial_section_regression_${contractDocPageReleasePostActionStateTransitionDenialSectionRegressionBlocker.code}`,
      contractDocPageReleasePostActionStateTransitionDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionBlocker of reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression_${contractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionBlocker.code}`,
      contractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionBlocker of reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_post_action_background_runner_denial_section_regression_${contractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionBlocker.code}`,
      contractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const contractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionBlocker of reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression_${contractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionBlocker.code}`,
      contractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const manifestDriftRegressionBlocker of reportManifestDriftRegression?.blockers || []) {
    blockers.push(blocker(
      `report_manifest_drift_regression_${manifestDriftRegressionBlocker.code}`,
      manifestDriftRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const latestRecoveryRegressionBlocker of reportLatestRecoveryRegression?.blockers || []) {
    blockers.push(blocker(
      `report_latest_recovery_regression_${latestRecoveryRegressionBlocker.code}`,
      latestRecoveryRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const bootstrapSeedRegressionBlocker of reportBootstrapSeedRegression?.blockers || []) {
    blockers.push(blocker(
      `report_bootstrap_seed_regression_${bootstrapSeedRegressionBlocker.code}`,
      bootstrapSeedRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const gateCleanRerunRegressionBlocker of reportGateCleanRerunRegression?.blockers || []) {
    blockers.push(blocker(
      `report_gate_clean_rerun_regression_${gateCleanRerunRegressionBlocker.code}`,
      gateCleanRerunRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const cleanGateIdempotenceRegressionBlocker of reportCleanGateIdempotenceRegression?.blockers || []) {
    blockers.push(blocker(
      `report_clean_gate_idempotence_regression_${cleanGateIdempotenceRegressionBlocker.code}`,
      cleanGateIdempotenceRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const finalSettlementRegressionBlocker of reportFinalSettlementRegression?.blockers || []) {
    blockers.push(blocker(
      `report_final_settlement_regression_${finalSettlementRegressionBlocker.code}`,
      finalSettlementRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const postFinalDriftRegressionBlocker of reportPostFinalDriftRegression?.blockers || []) {
    blockers.push(blocker(
      `report_post_final_drift_regression_${postFinalDriftRegressionBlocker.code}`,
      postFinalDriftRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const closeoutDriftClassificationRegressionBlocker of reportCloseoutDriftClassificationRegression?.blockers || []) {
    blockers.push(blocker(
      `report_closeout_drift_classification_regression_${closeoutDriftClassificationRegressionBlocker.code}`,
      closeoutDriftClassificationRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const closeoutCommandInventoryRegressionBlocker of reportCloseoutCommandInventoryRegression?.blockers || []) {
    blockers.push(blocker(
      `report_closeout_command_inventory_regression_${closeoutCommandInventoryRegressionBlocker.code}`,
      closeoutCommandInventoryRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const runnerContractRegressionBlocker of reportRunnerContractRegression?.blockers || []) {
    blockers.push(blocker(
      `report_runner_contract_regression_${runnerContractRegressionBlocker.code}`,
      runnerContractRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  for (const retentionRegressionBlocker of reportRetentionRegression?.blockers || []) {
    blockers.push(blocker(
      `report_retention_regression_${retentionRegressionBlocker.code}`,
      retentionRegressionBlocker.notes,
      'design-production-core',
    ));
  }
  if (!shape.integrationDependencyAuditCompatibilityExportAbsent || !shape.integrationDependencyAuditRootExportAbsent) {
    blockers.push(blocker(
      'core_integration_dependency_audit_still_root_exported',
      'integration-dependency-audit must be CLI-only/internal gate tooling, not a root public or compatibility export.',
    ));
  }
  if (!shape.integrationGateScriptPresent) {
    blockers.push(blocker(
      'core_integration_gate_script_missing',
      'Core must expose gate:integration:strict as a local hard gate for syntax, selftest, and strict integration audit.',
    ));
  }
  if (!shape.reportRetentionScriptPresent) {
    blockers.push(blocker(
      'core_report_retention_script_missing',
      'Core must expose reports:prune so timestamped reports move to local archive instead of accumulating in reports/.',
    ));
  }
  if (byChannel.zbj?.missingSurfaces?.includes('plan_only_product_routing')) {
    blockers.push(blocker(
      'zbj_plan_runtime_still_channel_owned',
      'ZBJ runner bridge imports core handoff/receipt modules, but product planning/runtime is not forced through core.',
      'zbj-auto-intake',
    ));
  }
  if (byChannel.zbj?.missingSurfaces?.includes('design_reference_runtime')) {
    blockers.push(blocker(
      'zbj_refpack_runtime_still_channel_owned',
      'ZBJ designReferenceSpec/refpack logic remains in zbj-auto-intake/hepta-design code instead of a core-enforced product workflow contract.',
      'zbj-auto-intake',
    ));
  }
  if (!byChannel.epwk?.runtimeCoreImportCount) {
    blockers.push(blocker(
      'epwk_core_runtime_dependency_absent',
      'EPWK has no runtime import from design-production-core; current EPWK flow is a local copy rather than a hard dependency.',
      'epwk-auto-intake',
    ));
  }
  for (const channel of channels) {
    for (const forbiddenImport of channel.forbiddenImports || []) {
      blockers.push(blocker(
        forbiddenImport.code,
        `${channel.label} bypasses core model-locked reference routing in ${forbiddenImport.file}. ${forbiddenImport.notes}`,
        channel.roots.find((root) => root.exists)?.path || channel.channelId,
      ));
    }
    for (const entrypoint of channel.liveEntrypoints || []) {
      for (const entrypointBlocker of entrypoint.blockers || []) {
        blockers.push(blocker(
          `${channel.channelId}_live_${codeToken(entrypoint.actionId)}_${entrypointBlocker.code}`,
          `${channel.label} live action ${entrypoint.actionId} is not fully forced through core lifecycle: ${entrypointBlocker.notes}`,
          channel.roots.find((root) => root.exists)?.path || channel.channelId,
        ));
      }
    }
    if (!channel.runtimeCoreImportCount || !channel.missingSurfaces?.length) continue;
    for (const surfaceId of channel.missingSurfaces) {
      const code = `${channel.channelId}_core_surface_missing_${surfaceId}`;
      if (blockers.some((item) => item.code === code)) continue;
      blockers.push(blocker(
        code,
        `${channel.label} has runtime core imports, but the ${surfaceId} surface is not wired to design-production-core.`,
        channel.roots.find((root) => root.exists)?.path || channel.channelId,
      ));
    }
  }
  if (!byChannel.hepta?.runtimeCoreImportCount) {
    blockers.push(blocker(
      'hepta_core_runtime_dependency_unverified',
      'No Hepta runtime dependency on design-production-core was found in the local Hepta skill/work dirs.',
      'hepta',
    ));
  }
  return blockers;
}

function buildRemediation({ shape, channels }) {
  const byChannel = Object.fromEntries(channels.map((channel) => [channel.channelId, channel]));
  const livePlanBindingMissing = channels.some((channel) => (
    channel.liveEntrypoints || []
  ).some((entrypoint) => entrypoint.missingRequiredPhases?.includes('plan_reference_binding')));
  const allLiveEntrypointsValidateLifecycleSchema = channels.every((channel) => (
    channel.liveEntrypoints || []
  ).every((entrypoint) => (
    entrypoint.lifecycleValidationStatus === 'pass_external_action_lifecycle_chain'
      && entrypoint.lifecycleSchemaUsage?.usesSchemaBuilder
      && entrypoint.lifecycleSchemaUsage?.usesChainValidator
  )));
  const hasInternalCoreImports = channels.some((channel) => channel.publicApiUsage?.internalImportCount > 0);
  const hasCompatibilityCoreImports = channels.some((channel) => channel.publicApiUsage?.compatibilityImportCount > 0);
  return [
    (!shape.designReferenceRuntimeModulePresent || !shape.buyerAssetPackageModulePresent) ? {
      priority: 'P0',
      action: 'Define core DesignReferenceSpec/referencePackage and BuyerAssetPackage as separate public contracts.',
      reason: 'ZBJ refpack and buyer attachments are distinct; EPWK must not model buyer attachments as refpack.',
    } : null,
    livePlanBindingMissing ? {
      priority: 'P0',
      action: 'Move or wrap product planning entrypoints so ZBJ and EPWK call core plan/product/reference contracts before production.',
      reason: 'A channel-local RouteContract or production plan can bypass shared workflow policy.',
    } : null,
    byChannel.epwk?.runtimeCoreImportCount && !byChannel.epwk?.missingSurfaces?.length ? null : {
      priority: 'P0',
      action: 'Make EPWK fail if semantic intake, production plan, produce, package review, final review, or submit gates do not bind to all required core surfaces.',
      reason: 'A single bridge import is not enough; EPWK must cover planning, reference, buyer assets, artifact review, action control, and runner proof surfaces.',
    },
    allLiveEntrypointsValidateLifecycleSchema ? null : {
      priority: 'P1',
      action: 'Replace channel duplicate gates with core lifecycle schema validation plus channel-specific evidence collectors.',
      reason: 'Channels should collect platform evidence and prove they satisfy the shared lifecycle, not reimplement the common state machine.',
    },
    hasInternalCoreImports ? {
      priority: 'P1',
      action: 'Move direct channel imports of core internal modules behind stable public API exports or channel-owned adapter registries.',
      reason: 'Internal imports such as hash/report helpers make compatibility boundaries hard to enforce.',
    } : null,
    !hasInternalCoreImports && hasCompatibilityCoreImports ? {
      priority: 'P2',
      action: 'Gradually migrate compatibility imports to stable public modules before removing legacy exports.',
      reason: 'Compatibility exports should remain a bridge for old scripts, not the default for new channel code.',
    } : null,
    shape.integrationGateScriptPresent ? null : {
      priority: 'P1',
      action: 'Add a strict CI/local gate around this audit once the intentional blockers are cleared.',
      reason: 'The audit must become a failing guard, not a report-only checklist.',
    },
  ].filter(Boolean);
}

export function buildIntegrationDependencyAudit({ generatedAt = new Date().toISOString() } = {}) {
  const shape = coreShape();
  const packageJson = readJson(path.join(packageRoot, 'package.json'), {});
  const channels = CHANNELS.map(auditChannel);
  const channelImportAllowlist = buildChannelImportAllowlist({ generatedAt });
  const packageRootResolver = buildPackageRootResolverReport({ generatedAt });
  const packageRootImportMigration = buildPackageRootImportMigrationPlan({
    channelImportAllowlist,
    packageRootResolverReport: packageRootResolver,
    packageSurfaceReport: readJson(path.join(reportsDir, 'package-surface-latest.json')),
    generatedAt,
  });
  const packageRootImportRegression = buildPackageRootImportRegressionReport({ generatedAt });
  const packageRootSymbolManifest = buildPackageRootSymbolManifestReport({ generatedAt });
  const packageRootSymbolRegression = buildPackageRootSymbolRegressionReport({ generatedAt });
  const packageRootSymbolMinimization = buildPackageRootSymbolMinimizationReport({
    symbolManifestReport: packageRootSymbolManifest,
    generatedAt,
  });
  const reportBindings = readReportBindings();
  const reportFreshness = buildReportFreshnessReport({
    reportBindings,
    gateReport: reportBindings[REPORT_FRESHNESS_GATE_REPORT.fileId]?.report || null,
    includeGateReport: false,
    generatedAt,
  });
  const reportFreshnessRegression = buildReportFreshnessRegressionReport({ generatedAt });
  const gateSourceText = readText(path.join(packageRoot, 'src', 'integration-dependency-gate.mjs'));
  const releaseFinalSettlementSourceText = readText(path.join(packageRoot, 'src', 'release-final-settlement.mjs'));
  const artifactSourceText = readText(path.join(packageRoot, 'src', 'report-artifact-reproducibility.mjs'));
  const artifactExporterSourceText = readText(path.join(packageRoot, 'src', 'export-report-artifact-reproducibility.mjs'));
  const checkpointSourceText = readText(path.join(packageRoot, 'src', 'export-architecture-checkpoint.mjs'));
  const auditSourceText = readText(path.join(packageRoot, 'src', 'integration-dependency-audit.mjs'));
  const selftestSourceText = readText(path.join(packageRoot, 'src', 'selftest.mjs'));
  const selftestLanesSourceText = readText(path.join(packageRoot, 'src', 'selftest-lanes.mjs'));
  const reportContractManifestText = readText(path.join(packageRoot, 'src', 'report-contract-manifest.mjs'));
  const reportRunnerContractRegressionText = readText(path.join(packageRoot, 'src', 'report-runner-contract-regression.mjs'));
  const packageScriptIds = Object.keys(readJson(path.join(packageRoot, 'package.json'), {}).scripts || {});
  const integrationGateSequenceRegression = buildIntegrationGateSequenceRegressionReport({
    sourceText: gateSourceText,
    generatedAt,
  });
  const reportInventoryConsistency = buildReportInventoryConsistencyReport({
    checkpointSourceText,
    gateSourceText,
    packageScriptIds,
    generatedAt,
  });
  const schemaContractExpectedFileIds = expectedReportSchemaContractFileIds(undefined, { includeGateReport: false });
  const reportSchemaContract = buildReportSchemaContractReport({
    expectedFileIds: schemaContractExpectedFileIds,
    records: readReportSchemaContractRecords(),
    generatedAt,
  });
  const reportLineageTopology = buildReportLineageTopologyReport({
    checkpointSourceText,
    gateSourceText,
    packageScriptIds,
    generatedAt,
  });
  const hashStabilityExpectedFileIds = expectedReportSchemaContractFileIds(undefined, { includeGateReport: false })
    .filter((fileId) => fileId !== REPORT_HASH_STABILITY_REGRESSION_REPORT_FILE_ID);
  const reportHashStabilityRegression = buildReportHashStabilityRegressionReport({
    expectedFileIds: hashStabilityExpectedFileIds,
    records: readReportSchemaContractRecords()
      .filter((record) => hashStabilityExpectedFileIds.includes(record.fileId)),
    generatedAt,
  });
  const outputPairingExpectedFileIds = latestReportFileIds();
  const reportOutputPairing = buildReportOutputPairingReport({
    expectedFileIds: outputPairingExpectedFileIds,
    records: readReportOutputPairingRecords(outputPairingExpectedFileIds),
    readmeText: readText(path.join(reportsDir, 'README.md')),
    packageScriptIds,
    freshnessRequiredFileIds: REPORT_FRESHNESS_REQUIRED_REPORTS.map((spec) => spec.fileId),
    generatedAt,
  });
  const artifactReproducibilityExpectedFileIds = expectedReportSchemaContractFileIds(undefined, { includeGateReport: false })
    .filter((fileId) => fileId !== REPORT_ARTIFACT_REPRODUCIBILITY_REPORT_FILE_ID);
  const reportArtifactReproducibility = buildReportArtifactReproducibilityReport({
    expectedFileIds: artifactReproducibilityExpectedFileIds,
    records: readReportSchemaContractRecords()
      .filter((record) => artifactReproducibilityExpectedFileIds.includes(record.fileId)),
    freshnessReports: REPORT_FRESHNESS_REQUIRED_REPORTS,
    gateSummaryHashes: readJson(path.join(reportsDir, 'integration-dependency-gate-latest.json'), {})?.summary || {},
    checkpointReports: readJson(path.join(reportsDir, 'architecture-checkpoint-latest.json'), {})?.reports || {},
    generatedAt,
  });
  const reportSelfReferenceBoundaryRegression = buildReportSelfReferenceBoundaryRegressionReport({
    gateSourceText,
    artifactSourceText,
    artifactExporterSourceText,
    generatedAt,
  });
  const reportContractManifest = buildReportContractManifestReport({
    runnerSourceText: reportRunnerContractRegressionText,
    generatedAt,
  });
  const reportContractRequiredCoverageRegression = buildReportContractRequiredCoverageRegressionReport({
    manifestSourceText: reportContractManifestText,
    generatedAt,
  });
  const docsFileIds = walkFiles(path.join(packageRoot, 'docs'))
    .filter((filePath) => filePath.endsWith('.md'))
    .map((filePath) => path.relative(packageRoot, filePath).replace(/\\/g, '/'));
  const docsByPath = Object.fromEntries(docsFileIds.map((fileId) => [
    fileId,
    readText(path.join(packageRoot, fileId)),
  ]));
  const reportContractDocCoverageRegression = buildReportContractDocCoverageRegressionReport({
    docsFileIds,
    readmeText: readText(path.join(packageRoot, 'README.md')),
    reportsReadmeText: readText(path.join(reportsDir, 'README.md')),
    generatedAt,
  });
  const sourceFileIds = walkFiles(path.join(packageRoot, 'src'))
    .filter((filePath) => filePath.endsWith('.mjs'))
    .map((filePath) => path.relative(packageRoot, filePath).replace(/\\/g, '/'));
  const sourceTextsByFileId = Object.fromEntries(sourceFileIds.map((fileId) => [
    fileId,
    readText(path.join(packageRoot, fileId)),
  ]));
  const reportContractSyntaxCoverageRegression = buildReportContractSyntaxCoverageRegressionReport({
    gateSourceText,
    sourceFileIds,
    sourceTextsByFileId,
    generatedAt,
  });
  const reportContractSourceDerivationRegression = buildReportContractSourceDerivationRegressionReport({
    sourceFileIds,
    docsFileIds,
    sourceTextsByFileId,
    generatedAt,
  });
  const reportContractSummaryKeyRegression = buildReportContractSummaryKeyRegressionReport({
    gateSourceText,
    checkpointSourceText,
    auditSourceText,
    selftestSourceText,
    selftestLanesSourceText,
    generatedAt,
  });
  const reportContractAuditForwardingRegression = buildReportContractAuditForwardingRegressionReport({
    auditSourceText,
    generatedAt,
  });
  const reportContractCheckpointBindingShapeRegression = buildReportContractCheckpointBindingShapeRegressionReport({
    checkpointSourceText,
    generatedAt,
  });
  const reportContractGateSummaryShapeRegression = buildReportContractGateSummaryShapeRegressionReport({
    gateSourceText,
    generatedAt,
  });
  const reportExporterSources = Object.fromEntries(REPORT_RUNNER_CONTRACTS.map((contract) => [
    contract.exporterPath,
    readText(path.join(packageRoot, contract.exporterPath)),
  ]));
  const reportContractExporterStdoutShapeRegression = buildReportContractExporterStdoutShapeRegressionReport({
    exporterSources: reportExporterSources,
    generatedAt,
  });
  const reportContractSafetyReportsByFileId = Object.fromEntries(REPORT_RUNNER_CONTRACTS.map((contract) => [
    contract.fileId,
    readJson(path.join(packageRoot, 'reports', contract.fileId)),
  ]));
  const reportContractSafetyFlagRegression = buildReportContractSafetyFlagRegressionReport({
    reportsByFileId: reportContractSafetyReportsByFileId,
    generatedAt,
  });
  const reportContractArtifactBindingsByFileId = Object.fromEntries(
    readReportOutputPairingRecords(REPORT_RUNNER_CONTRACTS.map((contract) => contract.fileId))
      .map((record) => [
        record.fileId,
        {
          jsonExists: record.jsonExists,
          mdExists: record.mdExists,
        },
      ]),
  );
  const reportContractArtifactBindingRegression = buildReportContractArtifactBindingRegressionReport({
    reportArtifactsByFileId: reportContractArtifactBindingsByFileId,
    reportsReadmeText: readText(path.join(reportsDir, 'README.md')),
    freshnessRequiredFileIds: REPORT_FRESHNESS_REQUIRED_REPORTS.map((spec) => spec.fileId),
    toolingReportFileIds: INTEGRATION_GATE_TOOLING_REPORT_FILE_IDS,
    schemaExpectedFileIds: expectedReportSchemaContractFileIds(undefined, { includeGateReport: false }),
    outputPairingExpectedFileIds,
    artifactReproducibilityExpectedFileIds,
    generatedAt,
  });
  const reportContractDocIndexAnchorRegression = buildReportContractDocIndexAnchorRegressionReport({
    docsByPath,
    readmeText: readText(path.join(packageRoot, 'README.md')),
    reportsReadmeText: readText(path.join(reportsDir, 'README.md')),
    generatedAt,
  });
  const reportContractDocPageLatestDetailRegression = buildReportContractDocPageLatestDetailRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageCommandSectionRegression = buildReportContractDocPageCommandSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageSafetySectionDetailRegression = buildReportContractDocPageSafetySectionDetailRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageStrictGateSectionRegression = buildReportContractDocPageStrictGateSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageOutputSectionRegression = buildReportContractDocPageOutputSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageCrossReportSectionRegression = buildReportContractDocPageCrossReportSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageCloseoutSectionRegression = buildReportContractDocPageCloseoutSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPagePostGateWriterSectionRegression = buildReportContractDocPagePostGateWriterSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageRetentionSectionRegression = buildReportContractDocPageRetentionSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageFreshnessHashSectionRegression = buildReportContractDocPageFreshnessHashSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageCheckpointHashSectionRegression = buildReportContractDocPageCheckpointHashSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageBootstrapSeedSectionRegression = buildReportContractDocPageBootstrapSeedSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageCleanRerunSectionRegression = buildReportContractDocPageCleanRerunSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageFinalSettlementSectionRegression = buildReportContractDocPageFinalSettlementSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageCloseoutIndexSectionRegression = buildReportContractDocPageCloseoutIndexSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageCloseoutEvidenceSectionRegression = buildReportContractDocPageCloseoutEvidenceSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageCloseoutLedgerSectionRegression = buildReportContractDocPageCloseoutLedgerSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageCloseoutRetentionProofSectionRegression = buildReportContractDocPageCloseoutRetentionProofSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageCloseoutProbeBundleSectionRegression = buildReportContractDocPageCloseoutProbeBundleSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageCloseoutSignoffSectionRegression = buildReportContractDocPageCloseoutSignoffSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageCloseoutReleaseManifestSectionRegression = buildReportContractDocPageCloseoutReleaseManifestSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseArchiveIndexSectionRegression = buildReportContractDocPageReleaseArchiveIndexSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseHandoffLedgerSectionRegression = buildReportContractDocPageReleaseHandoffLedgerSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseDeliveryReadinessSectionRegression = buildReportContractDocPageReleaseDeliveryReadinessSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseExecutionDenialSectionRegression = buildReportContractDocPageReleaseExecutionDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseOperatorApprovalSectionRegression = buildReportContractDocPageReleaseOperatorApprovalSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseApprovalLedgerSectionRegression = buildReportContractDocPageReleaseApprovalLedgerSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseActionQueueSectionRegression = buildReportContractDocPageReleaseActionQueueSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseRunnerDispatchDenialSectionRegression = buildReportContractDocPageReleaseRunnerDispatchDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseLiveActionPreflightSectionRegression = buildReportContractDocPageReleaseLiveActionPreflightSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseExecutionIntentCaptureSectionRegression = buildReportContractDocPageReleaseExecutionIntentCaptureSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression = buildReportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseRunnerExecutionGateSectionRegression = buildReportContractDocPageReleaseRunnerExecutionGateSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseDispatchImplementationDenialSectionRegression = buildReportContractDocPageReleaseDispatchImplementationDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression = buildReportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseDryRunReplayDenialSectionRegression = buildReportContractDocPageReleaseDryRunReplayDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseProofBundleDenialSectionRegression = buildReportContractDocPageReleaseProofBundleDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseLedgerDenialSectionRegression = buildReportContractDocPageReleaseLedgerDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseAuditEvidenceDenialSectionRegression = buildReportContractDocPageReleaseAuditEvidenceDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression = buildReportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleasePostActionReceiptDenialSectionRegression = buildReportContractDocPageReleasePostActionReceiptDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleasePostActionAuditDenialSectionRegression = buildReportContractDocPageReleasePostActionAuditDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleasePostActionReconciliationDenialSectionRegression = buildReportContractDocPageReleasePostActionReconciliationDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleasePostActionSettlementDenialSectionRegression = buildReportContractDocPageReleasePostActionSettlementDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression = buildReportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleasePostActionPaymentDenialSectionRegression = buildReportContractDocPageReleasePostActionPaymentDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleasePostActionDeploymentDenialSectionRegression = buildReportContractDocPageReleasePostActionDeploymentDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression = buildReportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression = buildReportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression = buildReportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression = buildReportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression = buildReportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionReport({
    docsByPath,
    generatedAt,
  });
  const reportManifestDriftRegression = buildReportManifestDriftRegressionReport({
    gateSourceText,
    checkpointSourceText,
    packageScripts: packageJson.scripts || {},
    exporterSources: reportExporterSources,
    generatedAt,
  });
  const reportLatestRecoveryRegression = buildReportLatestRecoveryRegressionReport({ generatedAt });
  const reportBootstrapSeedRegression = buildReportBootstrapSeedRegressionReport({ generatedAt });
  const reportGateCleanRerunRegression = buildReportGateCleanRerunRegressionReport({
    gateSourceText,
    generatedAt,
  });
  const reportCleanGateIdempotenceRegression = buildReportCleanGateIdempotenceRegressionReport({
    gateSourceText,
    generatedAt,
  });
  const reportFinalSettlementRegression = buildReportFinalSettlementRegressionReport({
    gateSourceText,
    releaseSourceText: releaseFinalSettlementSourceText,
    packageScripts: packageJson.scripts || {},
    generatedAt,
  });
  const reportPostFinalDriftRegression = buildReportPostFinalDriftRegressionReport({
    gateSourceText,
    packageScripts: packageJson.scripts || {},
    generatedAt,
  });
  const closeoutDriftDocsText = [
    'README.md',
    'reports/README.md',
    'docs/integration-dependency-gate.md',
    'docs/report-final-settlement-regression.md',
    'docs/report-post-final-drift-regression.md',
    'docs/report-closeout-drift-classification-regression.md',
    'docs/report-closeout-command-inventory-regression.md',
  ].map((filePath) => readText(path.join(packageRoot, filePath))).join('\n');
  const reportCloseoutDriftClassificationRegression = buildReportCloseoutDriftClassificationRegressionReport({
    gateSourceText,
    packageScripts: packageJson.scripts || {},
    docsText: closeoutDriftDocsText,
    generatedAt,
  });
  const reportCloseoutCommandInventoryRegression = buildReportCloseoutCommandInventoryRegressionReport({
    gateSourceText,
    packageScripts: packageJson.scripts || {},
    docsText: closeoutDriftDocsText,
    classificationSourceText: readText(path.join(packageRoot, 'src', 'report-closeout-drift-classification-regression.mjs')),
    generatedAt,
  });
  const reportRunnerContractRegression = buildReportRunnerContractRegressionReport({
    gateSourceText,
    packageScripts: packageJson.scripts || {},
    exporterSources: reportExporterSources,
    generatedAt,
  });
  const reportRetentionRegression = buildReportRetentionRegressionReport({ generatedAt });
  const blockers = buildBlockers({
    shape,
    channels,
    channelImportAllowlist,
    packageRootResolver,
    packageRootImportMigration,
    packageRootImportRegression,
    packageRootSymbolManifest,
    packageRootSymbolRegression,
    packageRootSymbolMinimization,
    reportFreshness,
    reportFreshnessRegression,
    integrationGateSequenceRegression,
    reportInventoryConsistency,
    reportSchemaContract,
    reportLineageTopology,
    reportHashStabilityRegression,
    reportOutputPairing,
    reportArtifactReproducibility,
    reportSelfReferenceBoundaryRegression,
    reportContractManifest,
    reportContractRequiredCoverageRegression,
    reportContractDocCoverageRegression,
    reportContractSyntaxCoverageRegression,
    reportContractSourceDerivationRegression,
    reportContractSummaryKeyRegression,
    reportContractAuditForwardingRegression,
    reportContractCheckpointBindingShapeRegression,
    reportContractGateSummaryShapeRegression,
    reportContractExporterStdoutShapeRegression,
    reportContractSafetyFlagRegression,
    reportContractArtifactBindingRegression,
    reportContractDocIndexAnchorRegression,
    reportContractDocPageLatestDetailRegression,
    reportContractDocPageCommandSectionRegression,
    reportContractDocPageSafetySectionDetailRegression,
    reportContractDocPageStrictGateSectionRegression,
    reportContractDocPageOutputSectionRegression,
    reportContractDocPageCrossReportSectionRegression,
    reportContractDocPageCloseoutSectionRegression,
    reportContractDocPagePostGateWriterSectionRegression,
    reportContractDocPageRetentionSectionRegression,
    reportContractDocPageFreshnessHashSectionRegression,
    reportContractDocPageCheckpointHashSectionRegression,
    reportContractDocPageBootstrapSeedSectionRegression,
    reportContractDocPageCleanRerunSectionRegression,
    reportContractDocPageFinalSettlementSectionRegression,
    reportContractDocPageCloseoutIndexSectionRegression,
    reportContractDocPageCloseoutEvidenceSectionRegression,
    reportContractDocPageCloseoutLedgerSectionRegression,
    reportContractDocPageCloseoutRetentionProofSectionRegression,
    reportContractDocPageCloseoutProbeBundleSectionRegression,
    reportContractDocPageCloseoutSignoffSectionRegression,
    reportContractDocPageCloseoutReleaseManifestSectionRegression,
    reportContractDocPageReleaseArchiveIndexSectionRegression,
    reportContractDocPageReleaseHandoffLedgerSectionRegression,
    reportContractDocPageReleaseDeliveryReadinessSectionRegression,
    reportContractDocPageReleaseExecutionDenialSectionRegression,
    reportContractDocPageReleaseOperatorApprovalSectionRegression,
    reportContractDocPageReleaseApprovalLedgerSectionRegression,
    reportContractDocPageReleaseActionQueueSectionRegression,
    reportContractDocPageReleaseRunnerDispatchDenialSectionRegression,
    reportContractDocPageReleaseLiveActionPreflightSectionRegression,
    reportContractDocPageReleaseExecutionIntentCaptureSectionRegression,
    reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression,
    reportContractDocPageReleaseRunnerExecutionGateSectionRegression,
    reportContractDocPageReleaseDispatchImplementationDenialSectionRegression,
    reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression,
    reportContractDocPageReleaseDryRunReplayDenialSectionRegression,
    reportContractDocPageReleaseProofBundleDenialSectionRegression,
    reportContractDocPageReleaseLedgerDenialSectionRegression,
    reportContractDocPageReleaseAuditEvidenceDenialSectionRegression,
    reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression,
    reportContractDocPageReleasePostActionReceiptDenialSectionRegression,
    reportContractDocPageReleasePostActionAuditDenialSectionRegression,
    reportContractDocPageReleasePostActionReconciliationDenialSectionRegression,
    reportContractDocPageReleasePostActionSettlementDenialSectionRegression,
    reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression,
    reportContractDocPageReleasePostActionPaymentDenialSectionRegression,
    reportContractDocPageReleasePostActionDeploymentDenialSectionRegression,
    reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression,
    reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression,
    reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression,
    reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression,
    reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression,
    reportManifestDriftRegression,
    reportLatestRecoveryRegression,
    reportBootstrapSeedRegression,
    reportGateCleanRerunRegression,
    reportCleanGateIdempotenceRegression,
    reportFinalSettlementRegression,
    reportPostFinalDriftRegression,
    reportCloseoutDriftClassificationRegression,
    reportCloseoutCommandInventoryRegression,
    reportRunnerContractRegression,
    reportRetentionRegression,
  });
  const audit = {
    version: INTEGRATION_DEPENDENCY_AUDIT_VERSION,
    kind: 'IntegrationDependencyAudit',
    status: blockers.length ? 'blocked_integration_dependency_audit' : 'pass_integration_dependency_audit',
    ok: blockers.length === 0,
    generatedAt,
    packageRoot: relative(packageRoot),
    workspaceRoot: relative(workspaceRoot) || '.',
    core: shape,
    channels,
    channelImportAllowlist: {
      status: channelImportAllowlist.status,
      ok: channelImportAllowlist.ok,
      allowlistHash: channelImportAllowlist.allowlistHash,
      summary: channelImportAllowlist.summary,
      blockers: channelImportAllowlist.blockers,
    },
    packageRootResolver: {
      status: packageRootResolver.status,
      ok: packageRootResolver.ok,
      resolverHash: packageRootResolver.resolverHash,
      summary: packageRootResolver.summary,
      blockers: packageRootResolver.blockers,
    },
    packageRootImportMigration: {
      status: packageRootImportMigration.status,
      ok: packageRootImportMigration.ok,
      migrationHash: packageRootImportMigration.migrationHash,
      summary: packageRootImportMigration.summary,
      blockers: packageRootImportMigration.blockers,
    },
    packageRootImportRegression: {
      status: packageRootImportRegression.status,
      ok: packageRootImportRegression.ok,
      regressionHash: packageRootImportRegression.regressionHash,
      summary: packageRootImportRegression.summary,
      blockers: packageRootImportRegression.blockers,
    },
    packageRootSymbolManifest: {
      status: packageRootSymbolManifest.status,
      ok: packageRootSymbolManifest.ok,
      symbolManifestHash: packageRootSymbolManifest.symbolManifestHash,
      summary: packageRootSymbolManifest.summary,
      blockers: packageRootSymbolManifest.blockers,
    },
    packageRootSymbolRegression: {
      status: packageRootSymbolRegression.status,
      ok: packageRootSymbolRegression.ok,
      symbolRegressionHash: packageRootSymbolRegression.symbolRegressionHash,
      summary: packageRootSymbolRegression.summary,
      blockers: packageRootSymbolRegression.blockers,
    },
    packageRootSymbolMinimization: {
      status: packageRootSymbolMinimization.status,
      ok: packageRootSymbolMinimization.ok,
      symbolMinimizationHash: packageRootSymbolMinimization.symbolMinimizationHash,
      summary: packageRootSymbolMinimization.summary,
      blockers: packageRootSymbolMinimization.blockers,
    },
    reportFreshness: {
      status: reportFreshness.status,
      ok: reportFreshness.ok,
      freshnessHash: reportFreshness.freshnessHash,
      summary: reportFreshness.summary,
      blockers: reportFreshness.blockers,
    },
    reportFreshnessRegression: {
      status: reportFreshnessRegression.status,
      ok: reportFreshnessRegression.ok,
      freshnessRegressionHash: reportFreshnessRegression.freshnessRegressionHash,
      summary: reportFreshnessRegression.summary,
      blockers: reportFreshnessRegression.blockers,
    },
    integrationGateSequenceRegression: {
      status: integrationGateSequenceRegression.status,
      ok: integrationGateSequenceRegression.ok,
      sequenceRegressionHash: integrationGateSequenceRegression.sequenceRegressionHash,
      summary: integrationGateSequenceRegression.summary,
      blockers: integrationGateSequenceRegression.blockers,
    },
    reportInventoryConsistency: {
      status: reportInventoryConsistency.status,
      ok: reportInventoryConsistency.ok,
      inventoryConsistencyHash: reportInventoryConsistency.inventoryConsistencyHash,
      summary: reportInventoryConsistency.summary,
      blockers: reportInventoryConsistency.blockers,
    },
    reportSchemaContract: {
      status: reportSchemaContract.status,
      ok: reportSchemaContract.ok,
      schemaContractHash: reportSchemaContract.schemaContractHash,
      summary: reportSchemaContract.summary,
      blockers: reportSchemaContract.blockers,
    },
    reportLineageTopology: {
      status: reportLineageTopology.status,
      ok: reportLineageTopology.ok,
      lineageTopologyHash: reportLineageTopology.lineageTopologyHash,
      summary: reportLineageTopology.summary,
      blockers: reportLineageTopology.blockers,
    },
    reportHashStabilityRegression: {
      status: reportHashStabilityRegression.status,
      ok: reportHashStabilityRegression.ok,
      hashStabilityRegressionHash: reportHashStabilityRegression.hashStabilityRegressionHash,
      summary: reportHashStabilityRegression.summary,
      blockers: reportHashStabilityRegression.blockers,
    },
    reportOutputPairing: {
      status: reportOutputPairing.status,
      ok: reportOutputPairing.ok,
      outputPairingHash: reportOutputPairing.outputPairingHash,
      summary: reportOutputPairing.summary,
      blockers: reportOutputPairing.blockers,
    },
    reportArtifactReproducibility: {
      status: reportArtifactReproducibility.status,
      ok: reportArtifactReproducibility.ok,
      artifactReproducibilityHash: reportArtifactReproducibility.artifactReproducibilityHash,
      summary: reportArtifactReproducibility.summary,
      blockers: reportArtifactReproducibility.blockers,
    },
    reportSelfReferenceBoundaryRegression: {
      status: reportSelfReferenceBoundaryRegression.status,
      ok: reportSelfReferenceBoundaryRegression.ok,
      selfReferenceBoundaryRegressionHash: reportSelfReferenceBoundaryRegression.selfReferenceBoundaryRegressionHash,
      summary: reportSelfReferenceBoundaryRegression.summary,
      blockers: reportSelfReferenceBoundaryRegression.blockers,
    },
    reportContractManifest: {
      status: reportContractManifest.status,
      ok: reportContractManifest.ok,
      contractManifestHash: reportContractManifest.contractManifestHash,
      summary: reportContractManifest.summary,
      blockers: reportContractManifest.blockers,
    },
    reportContractRequiredCoverageRegression: {
      status: reportContractRequiredCoverageRegression.status,
      ok: reportContractRequiredCoverageRegression.ok,
      contractRequiredCoverageRegressionHash: reportContractRequiredCoverageRegression.contractRequiredCoverageRegressionHash,
      summary: reportContractRequiredCoverageRegression.summary,
      blockers: reportContractRequiredCoverageRegression.blockers,
    },
    reportContractDocCoverageRegression: {
      status: reportContractDocCoverageRegression.status,
      ok: reportContractDocCoverageRegression.ok,
      contractDocCoverageRegressionHash: reportContractDocCoverageRegression.contractDocCoverageRegressionHash,
      summary: reportContractDocCoverageRegression.summary,
      blockers: reportContractDocCoverageRegression.blockers,
    },
    reportContractSyntaxCoverageRegression: {
      status: reportContractSyntaxCoverageRegression.status,
      ok: reportContractSyntaxCoverageRegression.ok,
      contractSyntaxCoverageRegressionHash: reportContractSyntaxCoverageRegression.contractSyntaxCoverageRegressionHash,
      summary: reportContractSyntaxCoverageRegression.summary,
      blockers: reportContractSyntaxCoverageRegression.blockers,
    },
    reportContractSourceDerivationRegression: {
      status: reportContractSourceDerivationRegression.status,
      ok: reportContractSourceDerivationRegression.ok,
      contractSourceDerivationRegressionHash: reportContractSourceDerivationRegression.contractSourceDerivationRegressionHash,
      summary: reportContractSourceDerivationRegression.summary,
      blockers: reportContractSourceDerivationRegression.blockers,
    },
    reportContractSummaryKeyRegression: {
      status: reportContractSummaryKeyRegression.status,
      ok: reportContractSummaryKeyRegression.ok,
      contractSummaryKeyRegressionHash: reportContractSummaryKeyRegression.contractSummaryKeyRegressionHash,
      summary: reportContractSummaryKeyRegression.summary,
      blockers: reportContractSummaryKeyRegression.blockers,
    },
    reportContractAuditForwardingRegression: {
      status: reportContractAuditForwardingRegression.status,
      ok: reportContractAuditForwardingRegression.ok,
      contractAuditForwardingRegressionHash: reportContractAuditForwardingRegression.contractAuditForwardingRegressionHash,
      summary: reportContractAuditForwardingRegression.summary,
      blockers: reportContractAuditForwardingRegression.blockers,
    },
    reportContractCheckpointBindingShapeRegression: {
      status: reportContractCheckpointBindingShapeRegression.status,
      ok: reportContractCheckpointBindingShapeRegression.ok,
      contractCheckpointBindingShapeRegressionHash: reportContractCheckpointBindingShapeRegression.contractCheckpointBindingShapeRegressionHash,
      summary: reportContractCheckpointBindingShapeRegression.summary,
      blockers: reportContractCheckpointBindingShapeRegression.blockers,
    },
    reportContractGateSummaryShapeRegression: {
      status: reportContractGateSummaryShapeRegression.status,
      ok: reportContractGateSummaryShapeRegression.ok,
      contractGateSummaryShapeRegressionHash: reportContractGateSummaryShapeRegression.contractGateSummaryShapeRegressionHash,
      summary: reportContractGateSummaryShapeRegression.summary,
      blockers: reportContractGateSummaryShapeRegression.blockers,
    },
    reportContractExporterStdoutShapeRegression: {
      status: reportContractExporterStdoutShapeRegression.status,
      ok: reportContractExporterStdoutShapeRegression.ok,
      contractExporterStdoutShapeRegressionHash: reportContractExporterStdoutShapeRegression.contractExporterStdoutShapeRegressionHash,
      summary: reportContractExporterStdoutShapeRegression.summary,
      blockers: reportContractExporterStdoutShapeRegression.blockers,
    },
    reportContractSafetyFlagRegression: {
      status: reportContractSafetyFlagRegression.status,
      ok: reportContractSafetyFlagRegression.ok,
      contractSafetyFlagRegressionHash: reportContractSafetyFlagRegression.contractSafetyFlagRegressionHash,
      summary: reportContractSafetyFlagRegression.summary,
      blockers: reportContractSafetyFlagRegression.blockers,
    },
    reportContractArtifactBindingRegression: {
      status: reportContractArtifactBindingRegression.status,
      ok: reportContractArtifactBindingRegression.ok,
      contractArtifactBindingRegressionHash: reportContractArtifactBindingRegression.contractArtifactBindingRegressionHash,
      summary: reportContractArtifactBindingRegression.summary,
      blockers: reportContractArtifactBindingRegression.blockers,
    },
    reportContractDocIndexAnchorRegression: {
      status: reportContractDocIndexAnchorRegression.status,
      ok: reportContractDocIndexAnchorRegression.ok,
      contractDocIndexAnchorRegressionHash: reportContractDocIndexAnchorRegression.contractDocIndexAnchorRegressionHash,
      summary: reportContractDocIndexAnchorRegression.summary,
      blockers: reportContractDocIndexAnchorRegression.blockers,
    },
    reportContractDocPageLatestDetailRegression: {
      status: reportContractDocPageLatestDetailRegression.status,
      ok: reportContractDocPageLatestDetailRegression.ok,
      contractDocPageLatestDetailRegressionHash: reportContractDocPageLatestDetailRegression.contractDocPageLatestDetailRegressionHash,
      summary: reportContractDocPageLatestDetailRegression.summary,
      blockers: reportContractDocPageLatestDetailRegression.blockers,
    },
    reportContractDocPageCommandSectionRegression: {
      status: reportContractDocPageCommandSectionRegression.status,
      ok: reportContractDocPageCommandSectionRegression.ok,
      contractDocPageCommandSectionRegressionHash: reportContractDocPageCommandSectionRegression.contractDocPageCommandSectionRegressionHash,
      summary: reportContractDocPageCommandSectionRegression.summary,
      blockers: reportContractDocPageCommandSectionRegression.blockers,
    },
    reportContractDocPageSafetySectionDetailRegression: {
      status: reportContractDocPageSafetySectionDetailRegression.status,
      ok: reportContractDocPageSafetySectionDetailRegression.ok,
      contractDocPageSafetySectionDetailRegressionHash: reportContractDocPageSafetySectionDetailRegression.contractDocPageSafetySectionDetailRegressionHash,
      summary: reportContractDocPageSafetySectionDetailRegression.summary,
      blockers: reportContractDocPageSafetySectionDetailRegression.blockers,
    },
    reportContractDocPageStrictGateSectionRegression: {
      status: reportContractDocPageStrictGateSectionRegression.status,
      ok: reportContractDocPageStrictGateSectionRegression.ok,
      contractDocPageStrictGateSectionRegressionHash: reportContractDocPageStrictGateSectionRegression.contractDocPageStrictGateSectionRegressionHash,
      summary: reportContractDocPageStrictGateSectionRegression.summary,
      blockers: reportContractDocPageStrictGateSectionRegression.blockers,
    },
    reportContractDocPageOutputSectionRegression: {
      status: reportContractDocPageOutputSectionRegression.status,
      ok: reportContractDocPageOutputSectionRegression.ok,
      contractDocPageOutputSectionRegressionHash: reportContractDocPageOutputSectionRegression.contractDocPageOutputSectionRegressionHash,
      summary: reportContractDocPageOutputSectionRegression.summary,
      blockers: reportContractDocPageOutputSectionRegression.blockers,
    },
    reportContractDocPageCrossReportSectionRegression: {
      status: reportContractDocPageCrossReportSectionRegression.status,
      ok: reportContractDocPageCrossReportSectionRegression.ok,
      contractDocPageCrossReportSectionRegressionHash: reportContractDocPageCrossReportSectionRegression.contractDocPageCrossReportSectionRegressionHash,
      summary: reportContractDocPageCrossReportSectionRegression.summary,
      blockers: reportContractDocPageCrossReportSectionRegression.blockers,
    },
    reportContractDocPageCloseoutSectionRegression: {
      status: reportContractDocPageCloseoutSectionRegression.status,
      ok: reportContractDocPageCloseoutSectionRegression.ok,
      contractDocPageCloseoutSectionRegressionHash: reportContractDocPageCloseoutSectionRegression.contractDocPageCloseoutSectionRegressionHash,
      summary: reportContractDocPageCloseoutSectionRegression.summary,
      blockers: reportContractDocPageCloseoutSectionRegression.blockers,
    },
    reportContractDocPagePostGateWriterSectionRegression: {
      status: reportContractDocPagePostGateWriterSectionRegression.status,
      ok: reportContractDocPagePostGateWriterSectionRegression.ok,
      contractDocPagePostGateWriterSectionRegressionHash: reportContractDocPagePostGateWriterSectionRegression.contractDocPagePostGateWriterSectionRegressionHash,
      summary: reportContractDocPagePostGateWriterSectionRegression.summary,
      blockers: reportContractDocPagePostGateWriterSectionRegression.blockers,
    },
    reportContractDocPageRetentionSectionRegression: {
      status: reportContractDocPageRetentionSectionRegression.status,
      ok: reportContractDocPageRetentionSectionRegression.ok,
      contractDocPageRetentionSectionRegressionHash: reportContractDocPageRetentionSectionRegression.contractDocPageRetentionSectionRegressionHash,
      summary: reportContractDocPageRetentionSectionRegression.summary,
      blockers: reportContractDocPageRetentionSectionRegression.blockers,
    },
    reportContractDocPageFreshnessHashSectionRegression: {
      status: reportContractDocPageFreshnessHashSectionRegression.status,
      ok: reportContractDocPageFreshnessHashSectionRegression.ok,
      contractDocPageFreshnessHashSectionRegressionHash: reportContractDocPageFreshnessHashSectionRegression.contractDocPageFreshnessHashSectionRegressionHash,
      summary: reportContractDocPageFreshnessHashSectionRegression.summary,
      blockers: reportContractDocPageFreshnessHashSectionRegression.blockers,
    },
    reportContractDocPageCheckpointHashSectionRegression: {
      status: reportContractDocPageCheckpointHashSectionRegression.status,
      ok: reportContractDocPageCheckpointHashSectionRegression.ok,
      contractDocPageCheckpointHashSectionRegressionHash: reportContractDocPageCheckpointHashSectionRegression.contractDocPageCheckpointHashSectionRegressionHash,
      summary: reportContractDocPageCheckpointHashSectionRegression.summary,
      blockers: reportContractDocPageCheckpointHashSectionRegression.blockers,
    },
    reportContractDocPageBootstrapSeedSectionRegression: {
      status: reportContractDocPageBootstrapSeedSectionRegression.status,
      ok: reportContractDocPageBootstrapSeedSectionRegression.ok,
      contractDocPageBootstrapSeedSectionRegressionHash: reportContractDocPageBootstrapSeedSectionRegression.contractDocPageBootstrapSeedSectionRegressionHash,
      summary: reportContractDocPageBootstrapSeedSectionRegression.summary,
      blockers: reportContractDocPageBootstrapSeedSectionRegression.blockers,
    },
    reportContractDocPageCleanRerunSectionRegression: {
      status: reportContractDocPageCleanRerunSectionRegression.status,
      ok: reportContractDocPageCleanRerunSectionRegression.ok,
      contractDocPageCleanRerunSectionRegressionHash: reportContractDocPageCleanRerunSectionRegression.contractDocPageCleanRerunSectionRegressionHash,
      summary: reportContractDocPageCleanRerunSectionRegression.summary,
      blockers: reportContractDocPageCleanRerunSectionRegression.blockers,
    },
    reportContractDocPageFinalSettlementSectionRegression: {
      status: reportContractDocPageFinalSettlementSectionRegression.status,
      ok: reportContractDocPageFinalSettlementSectionRegression.ok,
      contractDocPageFinalSettlementSectionRegressionHash: reportContractDocPageFinalSettlementSectionRegression.contractDocPageFinalSettlementSectionRegressionHash,
      summary: reportContractDocPageFinalSettlementSectionRegression.summary,
      blockers: reportContractDocPageFinalSettlementSectionRegression.blockers,
    },
    reportContractDocPageCloseoutIndexSectionRegression: {
      status: reportContractDocPageCloseoutIndexSectionRegression.status,
      ok: reportContractDocPageCloseoutIndexSectionRegression.ok,
      contractDocPageCloseoutIndexSectionRegressionHash: reportContractDocPageCloseoutIndexSectionRegression.contractDocPageCloseoutIndexSectionRegressionHash,
      summary: reportContractDocPageCloseoutIndexSectionRegression.summary,
      blockers: reportContractDocPageCloseoutIndexSectionRegression.blockers,
    },
    reportContractDocPageCloseoutEvidenceSectionRegression: {
      status: reportContractDocPageCloseoutEvidenceSectionRegression.status,
      ok: reportContractDocPageCloseoutEvidenceSectionRegression.ok,
      contractDocPageCloseoutEvidenceSectionRegressionHash: reportContractDocPageCloseoutEvidenceSectionRegression.contractDocPageCloseoutEvidenceSectionRegressionHash,
      summary: reportContractDocPageCloseoutEvidenceSectionRegression.summary,
      blockers: reportContractDocPageCloseoutEvidenceSectionRegression.blockers,
    },
    reportContractDocPageCloseoutLedgerSectionRegression: {
      status: reportContractDocPageCloseoutLedgerSectionRegression.status,
      ok: reportContractDocPageCloseoutLedgerSectionRegression.ok,
      contractDocPageCloseoutLedgerSectionRegressionHash: reportContractDocPageCloseoutLedgerSectionRegression.contractDocPageCloseoutLedgerSectionRegressionHash,
      summary: reportContractDocPageCloseoutLedgerSectionRegression.summary,
      blockers: reportContractDocPageCloseoutLedgerSectionRegression.blockers,
    },
    reportContractDocPageCloseoutRetentionProofSectionRegression: {
      status: reportContractDocPageCloseoutRetentionProofSectionRegression.status,
      ok: reportContractDocPageCloseoutRetentionProofSectionRegression.ok,
      contractDocPageCloseoutRetentionProofSectionRegressionHash: reportContractDocPageCloseoutRetentionProofSectionRegression.contractDocPageCloseoutRetentionProofSectionRegressionHash,
      summary: reportContractDocPageCloseoutRetentionProofSectionRegression.summary,
      blockers: reportContractDocPageCloseoutRetentionProofSectionRegression.blockers,
    },
    reportContractDocPageCloseoutProbeBundleSectionRegression: {
      status: reportContractDocPageCloseoutProbeBundleSectionRegression.status,
      ok: reportContractDocPageCloseoutProbeBundleSectionRegression.ok,
      contractDocPageCloseoutProbeBundleSectionRegressionHash: reportContractDocPageCloseoutProbeBundleSectionRegression.contractDocPageCloseoutProbeBundleSectionRegressionHash,
      summary: reportContractDocPageCloseoutProbeBundleSectionRegression.summary,
      blockers: reportContractDocPageCloseoutProbeBundleSectionRegression.blockers,
    },
    reportContractDocPageCloseoutSignoffSectionRegression: {
      status: reportContractDocPageCloseoutSignoffSectionRegression.status,
      ok: reportContractDocPageCloseoutSignoffSectionRegression.ok,
      contractDocPageCloseoutSignoffSectionRegressionHash: reportContractDocPageCloseoutSignoffSectionRegression.contractDocPageCloseoutSignoffSectionRegressionHash,
      summary: reportContractDocPageCloseoutSignoffSectionRegression.summary,
      blockers: reportContractDocPageCloseoutSignoffSectionRegression.blockers,
    },
    reportContractDocPageCloseoutReleaseManifestSectionRegression: {
      status: reportContractDocPageCloseoutReleaseManifestSectionRegression.status,
      ok: reportContractDocPageCloseoutReleaseManifestSectionRegression.ok,
      contractDocPageCloseoutReleaseManifestSectionRegressionHash: reportContractDocPageCloseoutReleaseManifestSectionRegression.contractDocPageCloseoutReleaseManifestSectionRegressionHash,
      summary: reportContractDocPageCloseoutReleaseManifestSectionRegression.summary,
      blockers: reportContractDocPageCloseoutReleaseManifestSectionRegression.blockers,
    },
    reportContractDocPageReleaseArchiveIndexSectionRegression: {
      status: reportContractDocPageReleaseArchiveIndexSectionRegression.status,
      ok: reportContractDocPageReleaseArchiveIndexSectionRegression.ok,
      contractDocPageReleaseArchiveIndexSectionRegressionHash: reportContractDocPageReleaseArchiveIndexSectionRegression.contractDocPageReleaseArchiveIndexSectionRegressionHash,
      summary: reportContractDocPageReleaseArchiveIndexSectionRegression.summary,
      blockers: reportContractDocPageReleaseArchiveIndexSectionRegression.blockers,
    },
    reportContractDocPageReleaseHandoffLedgerSectionRegression: {
      status: reportContractDocPageReleaseHandoffLedgerSectionRegression.status,
      ok: reportContractDocPageReleaseHandoffLedgerSectionRegression.ok,
      contractDocPageReleaseHandoffLedgerSectionRegressionHash: reportContractDocPageReleaseHandoffLedgerSectionRegression.contractDocPageReleaseHandoffLedgerSectionRegressionHash,
      summary: reportContractDocPageReleaseHandoffLedgerSectionRegression.summary,
      blockers: reportContractDocPageReleaseHandoffLedgerSectionRegression.blockers,
    },
    reportContractDocPageReleaseDeliveryReadinessSectionRegression: {
      status: reportContractDocPageReleaseDeliveryReadinessSectionRegression.status,
      ok: reportContractDocPageReleaseDeliveryReadinessSectionRegression.ok,
      contractDocPageReleaseDeliveryReadinessSectionRegressionHash: reportContractDocPageReleaseDeliveryReadinessSectionRegression.contractDocPageReleaseDeliveryReadinessSectionRegressionHash,
      summary: reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary,
      blockers: reportContractDocPageReleaseDeliveryReadinessSectionRegression.blockers,
    },
    reportContractDocPageReleaseExecutionDenialSectionRegression: {
      status: reportContractDocPageReleaseExecutionDenialSectionRegression.status,
      ok: reportContractDocPageReleaseExecutionDenialSectionRegression.ok,
      contractDocPageReleaseExecutionDenialSectionRegressionHash: reportContractDocPageReleaseExecutionDenialSectionRegression.contractDocPageReleaseExecutionDenialSectionRegressionHash,
      summary: reportContractDocPageReleaseExecutionDenialSectionRegression.summary,
      blockers: reportContractDocPageReleaseExecutionDenialSectionRegression.blockers,
    },
    reportContractDocPageReleaseOperatorApprovalSectionRegression: {
      status: reportContractDocPageReleaseOperatorApprovalSectionRegression.status,
      ok: reportContractDocPageReleaseOperatorApprovalSectionRegression.ok,
      contractDocPageReleaseOperatorApprovalSectionRegressionHash: reportContractDocPageReleaseOperatorApprovalSectionRegression.contractDocPageReleaseOperatorApprovalSectionRegressionHash,
      summary: reportContractDocPageReleaseOperatorApprovalSectionRegression.summary,
      blockers: reportContractDocPageReleaseOperatorApprovalSectionRegression.blockers,
    },
    reportContractDocPageReleaseApprovalLedgerSectionRegression: {
      status: reportContractDocPageReleaseApprovalLedgerSectionRegression.status,
      ok: reportContractDocPageReleaseApprovalLedgerSectionRegression.ok,
      contractDocPageReleaseApprovalLedgerSectionRegressionHash: reportContractDocPageReleaseApprovalLedgerSectionRegression.contractDocPageReleaseApprovalLedgerSectionRegressionHash,
      summary: reportContractDocPageReleaseApprovalLedgerSectionRegression.summary,
      blockers: reportContractDocPageReleaseApprovalLedgerSectionRegression.blockers,
    },
    reportContractDocPageReleaseActionQueueSectionRegression: {
      status: reportContractDocPageReleaseActionQueueSectionRegression.status,
      ok: reportContractDocPageReleaseActionQueueSectionRegression.ok,
      contractDocPageReleaseActionQueueSectionRegressionHash: reportContractDocPageReleaseActionQueueSectionRegression.contractDocPageReleaseActionQueueSectionRegressionHash,
      summary: reportContractDocPageReleaseActionQueueSectionRegression.summary,
      blockers: reportContractDocPageReleaseActionQueueSectionRegression.blockers,
    },
    reportContractDocPageReleaseRunnerDispatchDenialSectionRegression: {
      status: reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.status,
      ok: reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.ok,
      contractDocPageReleaseRunnerDispatchDenialSectionRegressionHash: reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.contractDocPageReleaseRunnerDispatchDenialSectionRegressionHash,
      summary: reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary,
      blockers: reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.blockers,
    },
    reportContractDocPageReleaseLiveActionPreflightSectionRegression: {
      status: reportContractDocPageReleaseLiveActionPreflightSectionRegression.status,
      ok: reportContractDocPageReleaseLiveActionPreflightSectionRegression.ok,
      contractDocPageReleaseLiveActionPreflightSectionRegressionHash: reportContractDocPageReleaseLiveActionPreflightSectionRegression.contractDocPageReleaseLiveActionPreflightSectionRegressionHash,
      summary: reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary,
      blockers: reportContractDocPageReleaseLiveActionPreflightSectionRegression.blockers,
    },
    reportContractDocPageReleaseExecutionIntentCaptureSectionRegression: {
      status: reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.status,
      ok: reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.ok,
      contractDocPageReleaseExecutionIntentCaptureSectionRegressionHash: reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.contractDocPageReleaseExecutionIntentCaptureSectionRegressionHash,
      summary: reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary,
      blockers: reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.blockers,
    },
    reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression: {
      status: reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.status,
      ok: reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.ok,
      contractDocPageReleaseExecutionApprovalBoundarySectionRegressionHash: reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.contractDocPageReleaseExecutionApprovalBoundarySectionRegressionHash,
      summary: reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary,
      blockers: reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.blockers,
    },
    reportContractDocPageReleaseRunnerExecutionGateSectionRegression: {
      status: reportContractDocPageReleaseRunnerExecutionGateSectionRegression.status,
      ok: reportContractDocPageReleaseRunnerExecutionGateSectionRegression.ok,
      contractDocPageReleaseRunnerExecutionGateSectionRegressionHash: reportContractDocPageReleaseRunnerExecutionGateSectionRegression.contractDocPageReleaseRunnerExecutionGateSectionRegressionHash,
      summary: reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary,
      blockers: reportContractDocPageReleaseRunnerExecutionGateSectionRegression.blockers,
    },
    reportContractDocPageReleaseDispatchImplementationDenialSectionRegression: {
      status: reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.status,
      ok: reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.ok,
      contractDocPageReleaseDispatchImplementationDenialSectionRegressionHash: reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.contractDocPageReleaseDispatchImplementationDenialSectionRegressionHash,
      summary: reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary,
      blockers: reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.blockers,
    },
    reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression: {
      status: reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.status,
      ok: reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.ok,
      contractDocPageReleasePlatformStateSnapshotDenialSectionRegressionHash: reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.contractDocPageReleasePlatformStateSnapshotDenialSectionRegressionHash,
      summary: reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary,
      blockers: reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.blockers,
    },
    reportContractDocPageReleaseDryRunReplayDenialSectionRegression: {
      status: reportContractDocPageReleaseDryRunReplayDenialSectionRegression.status,
      ok: reportContractDocPageReleaseDryRunReplayDenialSectionRegression.ok,
      contractDocPageReleaseDryRunReplayDenialSectionRegressionHash: reportContractDocPageReleaseDryRunReplayDenialSectionRegression.contractDocPageReleaseDryRunReplayDenialSectionRegressionHash,
      summary: reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary,
      blockers: reportContractDocPageReleaseDryRunReplayDenialSectionRegression.blockers,
    },
    reportContractDocPageReleaseProofBundleDenialSectionRegression: {
      status: reportContractDocPageReleaseProofBundleDenialSectionRegression.status,
      ok: reportContractDocPageReleaseProofBundleDenialSectionRegression.ok,
      contractDocPageReleaseProofBundleDenialSectionRegressionHash: reportContractDocPageReleaseProofBundleDenialSectionRegression.contractDocPageReleaseProofBundleDenialSectionRegressionHash,
      summary: reportContractDocPageReleaseProofBundleDenialSectionRegression.summary,
      blockers: reportContractDocPageReleaseProofBundleDenialSectionRegression.blockers,
    },
    reportContractDocPageReleaseLedgerDenialSectionRegression: {
      status: reportContractDocPageReleaseLedgerDenialSectionRegression.status,
      ok: reportContractDocPageReleaseLedgerDenialSectionRegression.ok,
      contractDocPageReleaseLedgerDenialSectionRegressionHash: reportContractDocPageReleaseLedgerDenialSectionRegression.contractDocPageReleaseLedgerDenialSectionRegressionHash,
      summary: reportContractDocPageReleaseLedgerDenialSectionRegression.summary,
      blockers: reportContractDocPageReleaseLedgerDenialSectionRegression.blockers,
    },
    reportContractDocPageReleaseAuditEvidenceDenialSectionRegression: {
      status: reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.status,
      ok: reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.ok,
      contractDocPageReleaseAuditEvidenceDenialSectionRegressionHash: reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.contractDocPageReleaseAuditEvidenceDenialSectionRegressionHash,
      summary: reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary,
      blockers: reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.blockers,
    },
    reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression: {
      status: reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.status,
      ok: reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.ok,
      contractDocPageReleaseReceiptEvidenceDenialSectionRegressionHash: reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.contractDocPageReleaseReceiptEvidenceDenialSectionRegressionHash,
      summary: reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary,
      blockers: reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.blockers,
    },
    reportContractDocPageReleasePostActionReceiptDenialSectionRegression: {
      status: reportContractDocPageReleasePostActionReceiptDenialSectionRegression.status,
      ok: reportContractDocPageReleasePostActionReceiptDenialSectionRegression.ok,
      contractDocPageReleasePostActionReceiptDenialSectionRegressionHash: reportContractDocPageReleasePostActionReceiptDenialSectionRegression.contractDocPageReleasePostActionReceiptDenialSectionRegressionHash,
      summary: reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary,
      blockers: reportContractDocPageReleasePostActionReceiptDenialSectionRegression.blockers,
    },
    reportContractDocPageReleasePostActionAuditDenialSectionRegression: {
      status: reportContractDocPageReleasePostActionAuditDenialSectionRegression.status,
      ok: reportContractDocPageReleasePostActionAuditDenialSectionRegression.ok,
      contractDocPageReleasePostActionAuditDenialSectionRegressionHash: reportContractDocPageReleasePostActionAuditDenialSectionRegression.contractDocPageReleasePostActionAuditDenialSectionRegressionHash,
      summary: reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary,
      blockers: reportContractDocPageReleasePostActionAuditDenialSectionRegression.blockers,
    },
    reportContractDocPageReleasePostActionReconciliationDenialSectionRegression: {
      status: reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.status,
      ok: reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.ok,
      contractDocPageReleasePostActionReconciliationDenialSectionRegressionHash: reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.contractDocPageReleasePostActionReconciliationDenialSectionRegressionHash,
      summary: reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary,
      blockers: reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.blockers,
    },
    reportContractDocPageReleasePostActionSettlementDenialSectionRegression: {
      status: reportContractDocPageReleasePostActionSettlementDenialSectionRegression.status,
      ok: reportContractDocPageReleasePostActionSettlementDenialSectionRegression.ok,
      contractDocPageReleasePostActionSettlementDenialSectionRegressionHash: reportContractDocPageReleasePostActionSettlementDenialSectionRegression.contractDocPageReleasePostActionSettlementDenialSectionRegressionHash,
      summary: reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary,
      blockers: reportContractDocPageReleasePostActionSettlementDenialSectionRegression.blockers,
    },
    reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression: {
      status: reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.status,
      ok: reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.ok,
      contractDocPageReleasePostActionAcceptanceDenialSectionRegressionHash: reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.contractDocPageReleasePostActionAcceptanceDenialSectionRegressionHash,
      summary: reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary,
      blockers: reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.blockers,
    },
    reportContractDocPageReleasePostActionPaymentDenialSectionRegression: {
      status: reportContractDocPageReleasePostActionPaymentDenialSectionRegression.status,
      ok: reportContractDocPageReleasePostActionPaymentDenialSectionRegression.ok,
      contractDocPageReleasePostActionPaymentDenialSectionRegressionHash: reportContractDocPageReleasePostActionPaymentDenialSectionRegression.contractDocPageReleasePostActionPaymentDenialSectionRegressionHash,
      summary: reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary,
      blockers: reportContractDocPageReleasePostActionPaymentDenialSectionRegression.blockers,
    },
    reportContractDocPageReleasePostActionDeploymentDenialSectionRegression: {
      status: reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.status,
      ok: reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.ok,
      contractDocPageReleasePostActionDeploymentDenialSectionRegressionHash: reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.contractDocPageReleasePostActionDeploymentDenialSectionRegressionHash,
      summary: reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary,
      blockers: reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.blockers,
    },
    reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression: {
      status: reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.status,
      ok: reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.ok,
      contractDocPageReleasePostActionProviderSpendDenialSectionRegressionHash: reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.contractDocPageReleasePostActionProviderSpendDenialSectionRegressionHash,
      summary: reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary,
      blockers: reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.blockers,
    },
    reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression: {
      status: reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.status,
      ok: reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.ok,
      contractDocPageReleasePostActionStateTransitionDenialSectionRegressionHash: reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.contractDocPageReleasePostActionStateTransitionDenialSectionRegressionHash,
      summary: reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary,
      blockers: reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.blockers,
    },
    reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression: {
      status: reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.status,
      ok: reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.ok,
      contractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionHash: reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.contractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionHash,
      summary: reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary,
      blockers: reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.blockers,
    },
    reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression: {
      status: reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.status,
      ok: reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.ok,
      contractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionHash: reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.contractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionHash,
      summary: reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary,
      blockers: reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.blockers,
    },
    reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression: {
      status: reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.status,
      ok: reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.ok,
      contractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionHash: reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.contractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionHash,
      summary: reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary,
      blockers: reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.blockers,
    },
    reportManifestDriftRegression: {
      status: reportManifestDriftRegression.status,
      ok: reportManifestDriftRegression.ok,
      manifestDriftRegressionHash: reportManifestDriftRegression.manifestDriftRegressionHash,
      summary: reportManifestDriftRegression.summary,
      blockers: reportManifestDriftRegression.blockers,
    },
    reportLatestRecoveryRegression: {
      status: reportLatestRecoveryRegression.status,
      ok: reportLatestRecoveryRegression.ok,
      latestRecoveryRegressionHash: reportLatestRecoveryRegression.latestRecoveryRegressionHash,
      summary: reportLatestRecoveryRegression.summary,
      blockers: reportLatestRecoveryRegression.blockers,
    },
    reportBootstrapSeedRegression: {
      status: reportBootstrapSeedRegression.status,
      ok: reportBootstrapSeedRegression.ok,
      bootstrapSeedRegressionHash: reportBootstrapSeedRegression.bootstrapSeedRegressionHash,
      summary: reportBootstrapSeedRegression.summary,
      blockers: reportBootstrapSeedRegression.blockers,
    },
    reportGateCleanRerunRegression: {
      status: reportGateCleanRerunRegression.status,
      ok: reportGateCleanRerunRegression.ok,
      gateCleanRerunRegressionHash: reportGateCleanRerunRegression.gateCleanRerunRegressionHash,
      summary: reportGateCleanRerunRegression.summary,
      blockers: reportGateCleanRerunRegression.blockers,
    },
    reportCleanGateIdempotenceRegression: {
      status: reportCleanGateIdempotenceRegression.status,
      ok: reportCleanGateIdempotenceRegression.ok,
      cleanGateIdempotenceRegressionHash: reportCleanGateIdempotenceRegression.cleanGateIdempotenceRegressionHash,
      summary: reportCleanGateIdempotenceRegression.summary,
      blockers: reportCleanGateIdempotenceRegression.blockers,
    },
    reportFinalSettlementRegression: {
      status: reportFinalSettlementRegression.status,
      ok: reportFinalSettlementRegression.ok,
      finalSettlementRegressionHash: reportFinalSettlementRegression.finalSettlementRegressionHash,
      summary: reportFinalSettlementRegression.summary,
      blockers: reportFinalSettlementRegression.blockers,
    },
    reportPostFinalDriftRegression: {
      status: reportPostFinalDriftRegression.status,
      ok: reportPostFinalDriftRegression.ok,
      postFinalDriftRegressionHash: reportPostFinalDriftRegression.postFinalDriftRegressionHash,
      summary: reportPostFinalDriftRegression.summary,
      blockers: reportPostFinalDriftRegression.blockers,
    },
    reportCloseoutDriftClassificationRegression: {
      status: reportCloseoutDriftClassificationRegression.status,
      ok: reportCloseoutDriftClassificationRegression.ok,
      closeoutDriftClassificationRegressionHash: reportCloseoutDriftClassificationRegression.closeoutDriftClassificationRegressionHash,
      summary: reportCloseoutDriftClassificationRegression.summary,
      blockers: reportCloseoutDriftClassificationRegression.blockers,
    },
    reportCloseoutCommandInventoryRegression: {
      status: reportCloseoutCommandInventoryRegression.status,
      ok: reportCloseoutCommandInventoryRegression.ok,
      closeoutCommandInventoryRegressionHash: reportCloseoutCommandInventoryRegression.closeoutCommandInventoryRegressionHash,
      summary: reportCloseoutCommandInventoryRegression.summary,
      blockers: reportCloseoutCommandInventoryRegression.blockers,
    },
    reportRunnerContractRegression: {
      status: reportRunnerContractRegression.status,
      ok: reportRunnerContractRegression.ok,
      runnerContractRegressionHash: reportRunnerContractRegression.runnerContractRegressionHash,
      summary: reportRunnerContractRegression.summary,
      blockers: reportRunnerContractRegression.blockers,
    },
    reportRetentionRegression: {
      status: reportRetentionRegression.status,
      ok: reportRetentionRegression.ok,
      retentionRegressionHash: reportRetentionRegression.retentionRegressionHash,
      summary: reportRetentionRegression.summary,
      blockers: reportRetentionRegression.blockers,
    },
    blockers,
    remediation: buildRemediation({ shape, channels }),
    safety: {
      readOnly: true,
      executesExternalAction: false,
      touchesPlatforms: false,
      providerSpend: false,
    },
  };
  const auditHash = digest({
    version: audit.version,
    kind: audit.kind,
    status: audit.status,
    core: audit.core,
    channels: audit.channels.map((channel) => ({
      channelId: channel.channelId,
      status: channel.status,
      runtimeCoreImportCount: channel.runtimeCoreImportCount,
      importedCoreModules: channel.importedCoreModules,
      publicApiUsage: channel.publicApiUsage,
      expectedSurfaces: channel.expectedSurfaces,
      missingSurfaces: channel.missingSurfaces,
      forbiddenImports: channel.forbiddenImports,
      liveEntrypoints: (channel.liveEntrypoints || []).map((entrypoint) => ({
        actionId: entrypoint.actionId,
        status: entrypoint.status,
        lifecycleProfileId: entrypoint.lifecycleProfileId,
        lifecycleValidationStatus: entrypoint.lifecycleValidationStatus,
        lifecycleSchemaUsage: entrypoint.lifecycleSchemaUsage,
        lifecycleMissingRequiredPhaseIds: entrypoint.lifecycleMissingRequiredPhaseIds,
        missingRequiredPhases: entrypoint.missingRequiredPhases,
        blockers: entrypoint.blockers,
      })),
    })),
    channelImportAllowlist: audit.channelImportAllowlist,
    packageRootResolver: audit.packageRootResolver,
    packageRootImportMigration: audit.packageRootImportMigration,
    packageRootImportRegression: audit.packageRootImportRegression,
    packageRootSymbolManifest: audit.packageRootSymbolManifest,
    packageRootSymbolRegression: audit.packageRootSymbolRegression,
    packageRootSymbolMinimization: audit.packageRootSymbolMinimization,
    reportFreshness: audit.reportFreshness,
    reportFreshnessRegression: audit.reportFreshnessRegression,
    integrationGateSequenceRegression: audit.integrationGateSequenceRegression,
    reportInventoryConsistency: audit.reportInventoryConsistency,
    reportSchemaContract: audit.reportSchemaContract,
    reportLineageTopology: audit.reportLineageTopology,
    reportHashStabilityRegression: audit.reportHashStabilityRegression,
    reportOutputPairing: audit.reportOutputPairing,
    reportArtifactReproducibility: audit.reportArtifactReproducibility,
    reportSelfReferenceBoundaryRegression: audit.reportSelfReferenceBoundaryRegression,
    reportContractManifest: audit.reportContractManifest,
    reportContractRequiredCoverageRegression: audit.reportContractRequiredCoverageRegression,
    reportContractDocCoverageRegression: audit.reportContractDocCoverageRegression,
    reportContractSyntaxCoverageRegression: audit.reportContractSyntaxCoverageRegression,
    reportContractSourceDerivationRegression: audit.reportContractSourceDerivationRegression,
    reportContractSummaryKeyRegression: audit.reportContractSummaryKeyRegression,
    reportContractAuditForwardingRegression: audit.reportContractAuditForwardingRegression,
    reportContractCheckpointBindingShapeRegression: audit.reportContractCheckpointBindingShapeRegression,
    reportContractGateSummaryShapeRegression: audit.reportContractGateSummaryShapeRegression,
    reportContractExporterStdoutShapeRegression: audit.reportContractExporterStdoutShapeRegression,
    reportContractSafetyFlagRegression: audit.reportContractSafetyFlagRegression,
    reportContractArtifactBindingRegression: audit.reportContractArtifactBindingRegression,
    reportContractDocIndexAnchorRegression: audit.reportContractDocIndexAnchorRegression,
    reportContractDocPageLatestDetailRegression: audit.reportContractDocPageLatestDetailRegression,
    reportContractDocPageCommandSectionRegression: audit.reportContractDocPageCommandSectionRegression,
    reportContractDocPageSafetySectionDetailRegression: audit.reportContractDocPageSafetySectionDetailRegression,
    reportContractDocPageStrictGateSectionRegression: audit.reportContractDocPageStrictGateSectionRegression,
    reportContractDocPageOutputSectionRegression: audit.reportContractDocPageOutputSectionRegression,
    reportContractDocPageCrossReportSectionRegression: audit.reportContractDocPageCrossReportSectionRegression,
    reportContractDocPageCloseoutSectionRegression: audit.reportContractDocPageCloseoutSectionRegression,
    reportContractDocPagePostGateWriterSectionRegression: audit.reportContractDocPagePostGateWriterSectionRegression,
    reportContractDocPageRetentionSectionRegression: audit.reportContractDocPageRetentionSectionRegression,
    reportContractDocPageFreshnessHashSectionRegression: audit.reportContractDocPageFreshnessHashSectionRegression,
    reportContractDocPageCheckpointHashSectionRegression: audit.reportContractDocPageCheckpointHashSectionRegression,
    reportContractDocPageBootstrapSeedSectionRegression: audit.reportContractDocPageBootstrapSeedSectionRegression,
    reportContractDocPageCleanRerunSectionRegression: audit.reportContractDocPageCleanRerunSectionRegression,
    reportContractDocPageFinalSettlementSectionRegression: audit.reportContractDocPageFinalSettlementSectionRegression,
    reportContractDocPageCloseoutIndexSectionRegression: audit.reportContractDocPageCloseoutIndexSectionRegression,
    reportContractDocPageCloseoutEvidenceSectionRegression: audit.reportContractDocPageCloseoutEvidenceSectionRegression,
    reportContractDocPageCloseoutLedgerSectionRegression: audit.reportContractDocPageCloseoutLedgerSectionRegression,
    reportContractDocPageCloseoutRetentionProofSectionRegression: audit.reportContractDocPageCloseoutRetentionProofSectionRegression,
    reportContractDocPageCloseoutProbeBundleSectionRegression: audit.reportContractDocPageCloseoutProbeBundleSectionRegression,
    reportContractDocPageCloseoutSignoffSectionRegression: audit.reportContractDocPageCloseoutSignoffSectionRegression,
    reportContractDocPageCloseoutReleaseManifestSectionRegression: audit.reportContractDocPageCloseoutReleaseManifestSectionRegression,
    reportContractDocPageReleaseArchiveIndexSectionRegression: audit.reportContractDocPageReleaseArchiveIndexSectionRegression,
    reportContractDocPageReleaseHandoffLedgerSectionRegression: audit.reportContractDocPageReleaseHandoffLedgerSectionRegression,
    reportContractDocPageReleaseDeliveryReadinessSectionRegression: audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression,
    reportContractDocPageReleaseExecutionDenialSectionRegression: audit.reportContractDocPageReleaseExecutionDenialSectionRegression,
    reportContractDocPageReleaseOperatorApprovalSectionRegression: audit.reportContractDocPageReleaseOperatorApprovalSectionRegression,
    reportContractDocPageReleaseApprovalLedgerSectionRegression: audit.reportContractDocPageReleaseApprovalLedgerSectionRegression,
    reportContractDocPageReleaseActionQueueSectionRegression: audit.reportContractDocPageReleaseActionQueueSectionRegression,
    reportContractDocPageReleaseRunnerDispatchDenialSectionRegression: audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression,
    reportContractDocPageReleaseLiveActionPreflightSectionRegression: audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression,
    reportContractDocPageReleaseExecutionIntentCaptureSectionRegression: audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression,
    reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression: audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression,
    reportContractDocPageReleaseRunnerExecutionGateSectionRegression: audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression,
    reportContractDocPageReleaseDispatchImplementationDenialSectionRegression: audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression,
    reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression: audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression,
    reportContractDocPageReleaseDryRunReplayDenialSectionRegression: audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression,
    reportContractDocPageReleaseProofBundleDenialSectionRegression: audit.reportContractDocPageReleaseProofBundleDenialSectionRegression,
    reportContractDocPageReleaseLedgerDenialSectionRegression: audit.reportContractDocPageReleaseLedgerDenialSectionRegression,
    reportContractDocPageReleaseAuditEvidenceDenialSectionRegression: audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression,
    reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression: audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression,
    reportContractDocPageReleasePostActionReceiptDenialSectionRegression: audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression,
    reportContractDocPageReleasePostActionAuditDenialSectionRegression: audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression,
    reportContractDocPageReleasePostActionReconciliationDenialSectionRegression: audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression,
    reportContractDocPageReleasePostActionSettlementDenialSectionRegression: audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression,
    reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression: audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression,
    reportContractDocPageReleasePostActionPaymentDenialSectionRegression: audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression,
    reportContractDocPageReleasePostActionDeploymentDenialSectionRegression: audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression,
    reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression: audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression,
    reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression: audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression,
    reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression: audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression,
    reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression: audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression,
    reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression: audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression,
    reportManifestDriftRegression: audit.reportManifestDriftRegression,
    reportLatestRecoveryRegression: audit.reportLatestRecoveryRegression,
    reportBootstrapSeedRegression: audit.reportBootstrapSeedRegression,
    reportGateCleanRerunRegression: audit.reportGateCleanRerunRegression,
    reportCleanGateIdempotenceRegression: audit.reportCleanGateIdempotenceRegression,
    reportFinalSettlementRegression: audit.reportFinalSettlementRegression,
    reportPostFinalDriftRegression: audit.reportPostFinalDriftRegression,
    reportCloseoutDriftClassificationRegression: audit.reportCloseoutDriftClassificationRegression,
    reportCloseoutCommandInventoryRegression: audit.reportCloseoutCommandInventoryRegression,
    reportRunnerContractRegression: audit.reportRunnerContractRegression,
    reportRetentionRegression: audit.reportRetentionRegression,
    blockers: audit.blockers,
    remediation: audit.remediation,
    safety: audit.safety,
  });
  return {
    ...audit,
    auditHash,
    hash: auditHash,
  };
}

function markdownFor(audit) {
  const lines = [
    '# Integration Dependency Audit',
    '',
    `Status: ${audit.status}`,
    `Hash: ${audit.auditHash}`,
    `Generated: ${audit.generatedAt}`,
    '',
    '## Core Shape',
    '',
    `- Package: ${audit.core.packageName}`,
    `- Private: ${audit.core.privatePackage}`,
    `- Package root export: ${audit.core.packageExportSurface.rootExportTarget || 'null'}`,
    `- Package JSON export present: ${audit.core.packageExportsPackageJson}`,
    `- Package deep src exports: ${audit.core.packageExportsDeepSrcCount}`,
    `- Package extra exports: ${audit.core.packageExportsExtraCount}`,
    `- Package stable only: ${audit.core.packageExportsStableOnly}`,
    `- Source files: ${audit.core.srcFileCount}`,
    `- Stable public modules: ${audit.core.publicModuleCount}`,
    `- Compatibility exports: ${audit.core.compatibilityModuleCount}`,
    `- Total exported modules: ${audit.core.exportedModuleCount}`,
    `- Executes external action: ${audit.core.boundaries.executesExternalAction}`,
    `- Channel command preview hardcoded in core: ${audit.core.channelCommandPreviewHardcoded}`,
    `- Design reference runtime module present: ${audit.core.designReferenceRuntimeModulePresent}`,
    `- LLM design reference resolver present: ${audit.core.llmDesignReferenceResolverPresent}`,
    `- Buyer/source asset package module present: ${audit.core.buyerAssetPackageModulePresent}`,
    `- External action lifecycle schema present: ${audit.core.lifecycleSchemaModulePresent}`,
    `- External action lifecycle schema public: ${audit.core.lifecycleSchemaPublic}`,
    `- External action lifecycle schema versioned: ${audit.core.lifecycleSchemaVersioned}`,
    `- External action lifecycle schema profiles: ${audit.core.lifecycleSchemaProfileCount}`,
    `- Contract JSON schema present: ${audit.core.contractSchemaModulePresent}`,
    `- Contract JSON schema public: ${audit.core.contractSchemaPublic}`,
    `- Contract JSON schema versioned: ${audit.core.contractSchemaVersioned}`,
    `- Contract JSON schema export script present: ${audit.core.contractSchemaExportScriptPresent}`,
    `- Integration gate tooling present: ${audit.core.integrationGateToolingModulePresent}`,
    `- Integration gate tooling public: ${audit.core.integrationGateToolingPublic}`,
    `- Integration gate tooling versioned: ${audit.core.integrationGateToolingVersioned}`,
    `- Channel import allowlist present: ${audit.core.channelImportAllowlistModulePresent}`,
    `- Channel import allowlist public: ${audit.core.channelImportAllowlistPublic}`,
    `- Channel import allowlist versioned: ${audit.core.channelImportAllowlistVersioned}`,
    `- Package-root resolver present: ${audit.core.packageRootResolverModulePresent}`,
    `- Package-root resolver public: ${audit.core.packageRootResolverPublic}`,
    `- Package-root resolver versioned: ${audit.core.packageRootResolverVersioned}`,
    `- Package-root import migration present: ${audit.core.packageRootImportMigrationModulePresent}`,
    `- Package-root import migration public: ${audit.core.packageRootImportMigrationPublic}`,
    `- Package-root import migration versioned: ${audit.core.packageRootImportMigrationVersioned}`,
    `- Package-root import regression fixture present: ${audit.core.packageRootImportRegressionModulePresent}`,
    `- Package-root import regression fixture versioned: ${audit.core.packageRootImportRegressionVersioned}`,
    `- Package-root symbol manifest present: ${audit.core.packageRootSymbolManifestModulePresent}`,
    `- Package-root symbol manifest versioned: ${audit.core.packageRootSymbolManifestVersioned}`,
    `- Package-root symbol regression fixture present: ${audit.core.packageRootSymbolRegressionModulePresent}`,
    `- Package-root symbol regression fixture versioned: ${audit.core.packageRootSymbolRegressionVersioned}`,
    `- Package-root symbol minimization report present: ${audit.core.packageRootSymbolMinimizationModulePresent}`,
    `- Package-root symbol minimization report versioned: ${audit.core.packageRootSymbolMinimizationVersioned}`,
    `- Report freshness present: ${audit.core.reportFreshnessModulePresent}`,
    `- Report freshness public: ${audit.core.reportFreshnessPublic}`,
    `- Report freshness versioned: ${audit.core.reportFreshnessVersioned}`,
    `- Report freshness script present: ${audit.core.reportFreshnessScriptPresent}`,
    `- Report freshness regression fixture present: ${audit.core.reportFreshnessRegressionModulePresent}`,
    `- Report freshness regression fixture versioned: ${audit.core.reportFreshnessRegressionVersioned}`,
    `- Report freshness regression script present: ${audit.core.reportFreshnessRegressionScriptPresent}`,
    `- Integration gate sequence regression fixture present: ${audit.core.integrationGateSequenceRegressionModulePresent}`,
    `- Integration gate sequence regression fixture versioned: ${audit.core.integrationGateSequenceRegressionVersioned}`,
    `- Integration gate sequence regression script present: ${audit.core.integrationGateSequenceRegressionScriptPresent}`,
    `- Report inventory consistency fixture present: ${audit.core.reportInventoryConsistencyModulePresent}`,
    `- Report inventory consistency fixture versioned: ${audit.core.reportInventoryConsistencyVersioned}`,
    `- Report inventory consistency script present: ${audit.core.reportInventoryConsistencyScriptPresent}`,
    `- Report schema contract fixture present: ${audit.core.reportSchemaContractModulePresent}`,
    `- Report schema contract fixture versioned: ${audit.core.reportSchemaContractVersioned}`,
    `- Report schema contract script present: ${audit.core.reportSchemaContractScriptPresent}`,
    `- Report lineage topology fixture present: ${audit.core.reportLineageTopologyModulePresent}`,
    `- Report lineage topology fixture versioned: ${audit.core.reportLineageTopologyVersioned}`,
    `- Report lineage topology script present: ${audit.core.reportLineageTopologyScriptPresent}`,
    `- Report hash stability regression fixture present: ${audit.core.reportHashStabilityRegressionModulePresent}`,
    `- Report hash stability regression fixture versioned: ${audit.core.reportHashStabilityRegressionVersioned}`,
    `- Report hash stability regression script present: ${audit.core.reportHashStabilityRegressionScriptPresent}`,
    `- Report output pairing fixture present: ${audit.core.reportOutputPairingModulePresent}`,
    `- Report output pairing fixture versioned: ${audit.core.reportOutputPairingVersioned}`,
    `- Report output pairing script present: ${audit.core.reportOutputPairingScriptPresent}`,
    `- Report artifact reproducibility fixture present: ${audit.core.reportArtifactReproducibilityModulePresent}`,
    `- Report artifact reproducibility fixture versioned: ${audit.core.reportArtifactReproducibilityVersioned}`,
    `- Report artifact reproducibility script present: ${audit.core.reportArtifactReproducibilityScriptPresent}`,
    `- Report self-reference boundary regression fixture present: ${audit.core.reportSelfReferenceBoundaryRegressionModulePresent}`,
    `- Report self-reference boundary regression fixture versioned: ${audit.core.reportSelfReferenceBoundaryRegressionVersioned}`,
    `- Report self-reference boundary regression script present: ${audit.core.reportSelfReferenceBoundaryRegressionScriptPresent}`,
    `- Report contract manifest fixture present: ${audit.core.reportContractManifestModulePresent}`,
    `- Report contract manifest fixture versioned: ${audit.core.reportContractManifestVersioned}`,
    `- Report contract manifest script present: ${audit.core.reportContractManifestScriptPresent}`,
    `- Report contract required coverage regression fixture present: ${audit.core.reportContractRequiredCoverageRegressionModulePresent}`,
    `- Report contract required coverage regression fixture versioned: ${audit.core.reportContractRequiredCoverageRegressionVersioned}`,
    `- Report contract required coverage regression script present: ${audit.core.reportContractRequiredCoverageRegressionScriptPresent}`,
    `- Report contract doc coverage regression fixture present: ${audit.core.reportContractDocCoverageRegressionModulePresent}`,
    `- Report contract doc coverage regression fixture versioned: ${audit.core.reportContractDocCoverageRegressionVersioned}`,
    `- Report contract doc coverage regression script present: ${audit.core.reportContractDocCoverageRegressionScriptPresent}`,
    `- Report contract syntax coverage regression fixture present: ${audit.core.reportContractSyntaxCoverageRegressionModulePresent}`,
    `- Report contract syntax coverage regression fixture versioned: ${audit.core.reportContractSyntaxCoverageRegressionVersioned}`,
    `- Report contract syntax coverage regression script present: ${audit.core.reportContractSyntaxCoverageRegressionScriptPresent}`,
    `- Report contract source derivation regression fixture present: ${audit.core.reportContractSourceDerivationRegressionModulePresent}`,
    `- Report contract source derivation regression fixture versioned: ${audit.core.reportContractSourceDerivationRegressionVersioned}`,
    `- Report contract source derivation regression script present: ${audit.core.reportContractSourceDerivationRegressionScriptPresent}`,
    `- Report contract summary key regression fixture present: ${audit.core.reportContractSummaryKeyRegressionModulePresent}`,
    `- Report contract summary key regression fixture versioned: ${audit.core.reportContractSummaryKeyRegressionVersioned}`,
    `- Report contract summary key regression script present: ${audit.core.reportContractSummaryKeyRegressionScriptPresent}`,
    `- Report contract audit forwarding regression fixture present: ${audit.core.reportContractAuditForwardingRegressionModulePresent}`,
    `- Report contract audit forwarding regression fixture versioned: ${audit.core.reportContractAuditForwardingRegressionVersioned}`,
    `- Report contract audit forwarding regression script present: ${audit.core.reportContractAuditForwardingRegressionScriptPresent}`,
    `- Report contract checkpoint binding shape regression fixture present: ${audit.core.reportContractCheckpointBindingShapeRegressionModulePresent}`,
    `- Report contract checkpoint binding shape regression fixture versioned: ${audit.core.reportContractCheckpointBindingShapeRegressionVersioned}`,
    `- Report contract checkpoint binding shape regression script present: ${audit.core.reportContractCheckpointBindingShapeRegressionScriptPresent}`,
    `- Report contract gate summary shape regression fixture present: ${audit.core.reportContractGateSummaryShapeRegressionModulePresent}`,
    `- Report contract gate summary shape regression fixture versioned: ${audit.core.reportContractGateSummaryShapeRegressionVersioned}`,
    `- Report contract gate summary shape regression script present: ${audit.core.reportContractGateSummaryShapeRegressionScriptPresent}`,
    `- Report contract exporter stdout shape regression fixture present: ${audit.core.reportContractExporterStdoutShapeRegressionModulePresent}`,
    `- Report contract exporter stdout shape regression fixture versioned: ${audit.core.reportContractExporterStdoutShapeRegressionVersioned}`,
    `- Report contract exporter stdout shape regression script present: ${audit.core.reportContractExporterStdoutShapeRegressionScriptPresent}`,
    `- Report contract safety flag regression fixture present: ${audit.core.reportContractSafetyFlagRegressionModulePresent}`,
    `- Report contract safety flag regression fixture versioned: ${audit.core.reportContractSafetyFlagRegressionVersioned}`,
    `- Report contract safety flag regression script present: ${audit.core.reportContractSafetyFlagRegressionScriptPresent}`,
    `- Report contract artifact binding regression fixture present: ${audit.core.reportContractArtifactBindingRegressionModulePresent}`,
    `- Report contract artifact binding regression fixture versioned: ${audit.core.reportContractArtifactBindingRegressionVersioned}`,
    `- Report contract artifact binding regression script present: ${audit.core.reportContractArtifactBindingRegressionScriptPresent}`,
    `- Report contract doc index anchor regression fixture present: ${audit.core.reportContractDocIndexAnchorRegressionModulePresent}`,
    `- Report contract doc index anchor regression fixture versioned: ${audit.core.reportContractDocIndexAnchorRegressionVersioned}`,
    `- Report contract doc index anchor regression script present: ${audit.core.reportContractDocIndexAnchorRegressionScriptPresent}`,
    `- Report contract doc page latest detail regression fixture present: ${audit.core.reportContractDocPageLatestDetailRegressionModulePresent}`,
    `- Report contract doc page latest detail regression fixture versioned: ${audit.core.reportContractDocPageLatestDetailRegressionVersioned}`,
    `- Report contract doc page latest detail regression script present: ${audit.core.reportContractDocPageLatestDetailRegressionScriptPresent}`,
    `- Report contract doc page command section regression fixture present: ${audit.core.reportContractDocPageCommandSectionRegressionModulePresent}`,
    `- Report contract doc page command section regression fixture versioned: ${audit.core.reportContractDocPageCommandSectionRegressionVersioned}`,
    `- Report contract doc page command section regression script present: ${audit.core.reportContractDocPageCommandSectionRegressionScriptPresent}`,
    `- Report contract doc page safety section detail regression fixture present: ${audit.core.reportContractDocPageSafetySectionDetailRegressionModulePresent}`,
    `- Report contract doc page safety section detail regression fixture versioned: ${audit.core.reportContractDocPageSafetySectionDetailRegressionVersioned}`,
    `- Report contract doc page safety section detail regression script present: ${audit.core.reportContractDocPageSafetySectionDetailRegressionScriptPresent}`,
    `- Report contract doc page strict gate section regression fixture present: ${audit.core.reportContractDocPageStrictGateSectionRegressionModulePresent}`,
    `- Report contract doc page strict gate section regression fixture versioned: ${audit.core.reportContractDocPageStrictGateSectionRegressionVersioned}`,
    `- Report contract doc page strict gate section regression script present: ${audit.core.reportContractDocPageStrictGateSectionRegressionScriptPresent}`,
    `- Report contract doc page output section regression fixture present: ${audit.core.reportContractDocPageOutputSectionRegressionModulePresent}`,
    `- Report contract doc page output section regression fixture versioned: ${audit.core.reportContractDocPageOutputSectionRegressionVersioned}`,
    `- Report contract doc page output section regression script present: ${audit.core.reportContractDocPageOutputSectionRegressionScriptPresent}`,
    `- Report contract doc page cross-report section regression fixture present: ${audit.core.reportContractDocPageCrossReportSectionRegressionModulePresent}`,
    `- Report contract doc page cross-report section regression fixture versioned: ${audit.core.reportContractDocPageCrossReportSectionRegressionVersioned}`,
    `- Report contract doc page cross-report section regression script present: ${audit.core.reportContractDocPageCrossReportSectionRegressionScriptPresent}`,
    `- Report contract doc page closeout section regression fixture present: ${audit.core.reportContractDocPageCloseoutSectionRegressionModulePresent}`,
    `- Report contract doc page closeout section regression fixture versioned: ${audit.core.reportContractDocPageCloseoutSectionRegressionVersioned}`,
    `- Report contract doc page closeout section regression script present: ${audit.core.reportContractDocPageCloseoutSectionRegressionScriptPresent}`,
    `- Report contract doc page post-gate writer section regression fixture present: ${audit.core.reportContractDocPagePostGateWriterSectionRegressionModulePresent}`,
    `- Report contract doc page post-gate writer section regression fixture versioned: ${audit.core.reportContractDocPagePostGateWriterSectionRegressionVersioned}`,
    `- Report contract doc page post-gate writer section regression script present: ${audit.core.reportContractDocPagePostGateWriterSectionRegressionScriptPresent}`,
    `- Report contract doc page retention section regression fixture present: ${audit.core.reportContractDocPageRetentionSectionRegressionModulePresent}`,
    `- Report contract doc page retention section regression fixture versioned: ${audit.core.reportContractDocPageRetentionSectionRegressionVersioned}`,
    `- Report contract doc page retention section regression script present: ${audit.core.reportContractDocPageRetentionSectionRegressionScriptPresent}`,
    `- Report contract doc page freshness hash section regression fixture present: ${audit.core.reportContractDocPageFreshnessHashSectionRegressionModulePresent}`,
    `- Report contract doc page freshness hash section regression fixture versioned: ${audit.core.reportContractDocPageFreshnessHashSectionRegressionVersioned}`,
    `- Report contract doc page freshness hash section regression script present: ${audit.core.reportContractDocPageFreshnessHashSectionRegressionScriptPresent}`,
    `- Report contract doc page checkpoint hash section regression fixture present: ${audit.core.reportContractDocPageCheckpointHashSectionRegressionModulePresent}`,
    `- Report contract doc page checkpoint hash section regression fixture versioned: ${audit.core.reportContractDocPageCheckpointHashSectionRegressionVersioned}`,
    `- Report contract doc page checkpoint hash section regression script present: ${audit.core.reportContractDocPageCheckpointHashSectionRegressionScriptPresent}`,
    `- Report contract doc page bootstrap seed section regression fixture present: ${audit.core.reportContractDocPageBootstrapSeedSectionRegressionModulePresent}`,
    `- Report contract doc page bootstrap seed section regression fixture versioned: ${audit.core.reportContractDocPageBootstrapSeedSectionRegressionVersioned}`,
    `- Report contract doc page bootstrap seed section regression script present: ${audit.core.reportContractDocPageBootstrapSeedSectionRegressionScriptPresent}`,
    `- Report contract doc page clean rerun section regression fixture present: ${audit.core.reportContractDocPageCleanRerunSectionRegressionModulePresent}`,
    `- Report contract doc page clean rerun section regression fixture versioned: ${audit.core.reportContractDocPageCleanRerunSectionRegressionVersioned}`,
    `- Report contract doc page clean rerun section regression script present: ${audit.core.reportContractDocPageCleanRerunSectionRegressionScriptPresent}`,
    `- Report contract doc page final settlement section regression fixture present: ${audit.core.reportContractDocPageFinalSettlementSectionRegressionModulePresent}`,
    `- Report contract doc page final settlement section regression fixture versioned: ${audit.core.reportContractDocPageFinalSettlementSectionRegressionVersioned}`,
    `- Report contract doc page final settlement section regression script present: ${audit.core.reportContractDocPageFinalSettlementSectionRegressionScriptPresent}`,
    `- Report contract doc page closeout index section regression fixture present: ${audit.core.reportContractDocPageCloseoutIndexSectionRegressionModulePresent}`,
    `- Report contract doc page closeout index section regression fixture versioned: ${audit.core.reportContractDocPageCloseoutIndexSectionRegressionVersioned}`,
    `- Report contract doc page closeout index section regression script present: ${audit.core.reportContractDocPageCloseoutIndexSectionRegressionScriptPresent}`,
    `- Report contract doc page closeout evidence section regression fixture present: ${audit.core.reportContractDocPageCloseoutEvidenceSectionRegressionModulePresent}`,
    `- Report contract doc page closeout evidence section regression fixture versioned: ${audit.core.reportContractDocPageCloseoutEvidenceSectionRegressionVersioned}`,
    `- Report contract doc page closeout evidence section regression script present: ${audit.core.reportContractDocPageCloseoutEvidenceSectionRegressionScriptPresent}`,
    `- Report contract doc page closeout ledger section regression fixture present: ${audit.core.reportContractDocPageCloseoutLedgerSectionRegressionModulePresent}`,
    `- Report contract doc page closeout ledger section regression fixture versioned: ${audit.core.reportContractDocPageCloseoutLedgerSectionRegressionVersioned}`,
    `- Report contract doc page closeout ledger section regression script present: ${audit.core.reportContractDocPageCloseoutLedgerSectionRegressionScriptPresent}`,
    `- Report contract doc page closeout retention proof section regression fixture present: ${audit.core.reportContractDocPageCloseoutRetentionProofSectionRegressionModulePresent}`,
    `- Report contract doc page closeout retention proof section regression fixture versioned: ${audit.core.reportContractDocPageCloseoutRetentionProofSectionRegressionVersioned}`,
    `- Report contract doc page closeout retention proof section regression script present: ${audit.core.reportContractDocPageCloseoutRetentionProofSectionRegressionScriptPresent}`,
    `- Report contract doc page closeout probe bundle section regression fixture present: ${audit.core.reportContractDocPageCloseoutProbeBundleSectionRegressionModulePresent}`,
    `- Report contract doc page closeout probe bundle section regression fixture versioned: ${audit.core.reportContractDocPageCloseoutProbeBundleSectionRegressionVersioned}`,
    `- Report contract doc page closeout probe bundle section regression script present: ${audit.core.reportContractDocPageCloseoutProbeBundleSectionRegressionScriptPresent}`,
    `- Report contract doc page closeout signoff section regression fixture present: ${audit.core.reportContractDocPageCloseoutSignoffSectionRegressionModulePresent}`,
    `- Report contract doc page closeout signoff section regression fixture versioned: ${audit.core.reportContractDocPageCloseoutSignoffSectionRegressionVersioned}`,
    `- Report contract doc page closeout signoff section regression script present: ${audit.core.reportContractDocPageCloseoutSignoffSectionRegressionScriptPresent}`,
    `- Report contract doc page closeout release manifest section regression fixture present: ${audit.core.reportContractDocPageCloseoutReleaseManifestSectionRegressionModulePresent}`,
    `- Report contract doc page closeout release manifest section regression fixture versioned: ${audit.core.reportContractDocPageCloseoutReleaseManifestSectionRegressionVersioned}`,
    `- Report contract doc page closeout release manifest section regression script present: ${audit.core.reportContractDocPageCloseoutReleaseManifestSectionRegressionScriptPresent}`,
    `- Report contract doc page release archive index section regression fixture present: ${audit.core.reportContractDocPageReleaseArchiveIndexSectionRegressionModulePresent}`,
    `- Report contract doc page release archive index section regression fixture versioned: ${audit.core.reportContractDocPageReleaseArchiveIndexSectionRegressionVersioned}`,
    `- Report contract doc page release archive index section regression script present: ${audit.core.reportContractDocPageReleaseArchiveIndexSectionRegressionScriptPresent}`,
    `- Report contract doc page release handoff ledger section regression fixture present: ${audit.core.reportContractDocPageReleaseHandoffLedgerSectionRegressionModulePresent}`,
    `- Report contract doc page release handoff ledger section regression fixture versioned: ${audit.core.reportContractDocPageReleaseHandoffLedgerSectionRegressionVersioned}`,
    `- Report contract doc page release handoff ledger section regression script present: ${audit.core.reportContractDocPageReleaseHandoffLedgerSectionRegressionScriptPresent}`,
    `- Report contract doc page release delivery readiness section regression fixture present: ${audit.core.reportContractDocPageReleaseDeliveryReadinessSectionRegressionModulePresent}`,
    `- Report contract doc page release delivery readiness section regression fixture versioned: ${audit.core.reportContractDocPageReleaseDeliveryReadinessSectionRegressionVersioned}`,
    `- Report contract doc page release delivery readiness section regression script present: ${audit.core.reportContractDocPageReleaseDeliveryReadinessSectionRegressionScriptPresent}`,
    `- Report contract doc page release execution denial section regression fixture present: ${audit.core.reportContractDocPageReleaseExecutionDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release execution denial section regression fixture versioned: ${audit.core.reportContractDocPageReleaseExecutionDenialSectionRegressionVersioned}`,
    `- Report contract doc page release execution denial section regression script present: ${audit.core.reportContractDocPageReleaseExecutionDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release operator approval section regression fixture present: ${audit.core.reportContractDocPageReleaseOperatorApprovalSectionRegressionModulePresent}`,
    `- Report contract doc page release operator approval section regression fixture versioned: ${audit.core.reportContractDocPageReleaseOperatorApprovalSectionRegressionVersioned}`,
    `- Report contract doc page release operator approval section regression script present: ${audit.core.reportContractDocPageReleaseOperatorApprovalSectionRegressionScriptPresent}`,
    `- Report contract doc page release approval ledger section regression fixture present: ${audit.core.reportContractDocPageReleaseApprovalLedgerSectionRegressionModulePresent}`,
    `- Report contract doc page release approval ledger section regression fixture versioned: ${audit.core.reportContractDocPageReleaseApprovalLedgerSectionRegressionVersioned}`,
    `- Report contract doc page release approval ledger section regression script present: ${audit.core.reportContractDocPageReleaseApprovalLedgerSectionRegressionScriptPresent}`,
    `- Report contract doc page release action queue section regression fixture present: ${audit.core.reportContractDocPageReleaseActionQueueSectionRegressionModulePresent}`,
    `- Report contract doc page release action queue section regression fixture versioned: ${audit.core.reportContractDocPageReleaseActionQueueSectionRegressionVersioned}`,
    `- Report contract doc page release action queue section regression script present: ${audit.core.reportContractDocPageReleaseActionQueueSectionRegressionScriptPresent}`,
    `- Report contract doc page release runner dispatch denial section regression fixture present: ${audit.core.reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release runner dispatch denial section regression fixture versioned: ${audit.core.reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionVersioned}`,
    `- Report contract doc page release runner dispatch denial section regression script present: ${audit.core.reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release live action preflight section regression fixture present: ${audit.core.reportContractDocPageReleaseLiveActionPreflightSectionRegressionModulePresent}`,
    `- Report contract doc page release live action preflight section regression fixture versioned: ${audit.core.reportContractDocPageReleaseLiveActionPreflightSectionRegressionVersioned}`,
    `- Report contract doc page release live action preflight section regression script present: ${audit.core.reportContractDocPageReleaseLiveActionPreflightSectionRegressionScriptPresent}`,
    `- Report contract doc page release execution intent capture section regression fixture present: ${audit.core.reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionModulePresent}`,
    `- Report contract doc page release execution intent capture section regression fixture versioned: ${audit.core.reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionVersioned}`,
    `- Report contract doc page release execution intent capture section regression script present: ${audit.core.reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionScriptPresent}`,
    `- Report contract doc page release execution approval boundary section regression fixture present: ${audit.core.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionModulePresent}`,
    `- Report contract doc page release execution approval boundary section regression fixture versioned: ${audit.core.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionVersioned}`,
    `- Report contract doc page release execution approval boundary section regression script present: ${audit.core.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionScriptPresent}`,
    `- Report contract doc page release runner execution gate section regression fixture present: ${audit.core.reportContractDocPageReleaseRunnerExecutionGateSectionRegressionModulePresent}`,
    `- Report contract doc page release runner execution gate section regression fixture versioned: ${audit.core.reportContractDocPageReleaseRunnerExecutionGateSectionRegressionVersioned}`,
    `- Report contract doc page release runner execution gate section regression script present: ${audit.core.reportContractDocPageReleaseRunnerExecutionGateSectionRegressionScriptPresent}`,
    `- Report contract doc page release dispatch implementation denial section regression fixture present: ${audit.core.reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release dispatch implementation denial section regression fixture versioned: ${audit.core.reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionVersioned}`,
    `- Report contract doc page release dispatch implementation denial section regression script present: ${audit.core.reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release platform-state snapshot denial section regression fixture present: ${audit.core.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release platform-state snapshot denial section regression fixture versioned: ${audit.core.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionVersioned}`,
    `- Report contract doc page release platform-state snapshot denial section regression script present: ${audit.core.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release dry-run replay denial section regression fixture present: ${audit.core.reportContractDocPageReleaseDryRunReplayDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release dry-run replay denial section regression fixture versioned: ${audit.core.reportContractDocPageReleaseDryRunReplayDenialSectionRegressionVersioned}`,
    `- Report contract doc page release dry-run replay denial section regression script present: ${audit.core.reportContractDocPageReleaseDryRunReplayDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release proof-bundle denial section regression fixture present: ${audit.core.reportContractDocPageReleaseProofBundleDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release proof-bundle denial section regression fixture versioned: ${audit.core.reportContractDocPageReleaseProofBundleDenialSectionRegressionVersioned}`,
    `- Report contract doc page release proof-bundle denial section regression script present: ${audit.core.reportContractDocPageReleaseProofBundleDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release ledger denial section regression fixture present: ${audit.core.reportContractDocPageReleaseLedgerDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release ledger denial section regression fixture versioned: ${audit.core.reportContractDocPageReleaseLedgerDenialSectionRegressionVersioned}`,
    `- Report contract doc page release ledger denial section regression script present: ${audit.core.reportContractDocPageReleaseLedgerDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release audit-evidence denial section regression fixture present: ${audit.core.reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release audit-evidence denial section regression fixture versioned: ${audit.core.reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionVersioned}`,
    `- Report contract doc page release audit-evidence denial section regression script present: ${audit.core.reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release receipt-evidence denial section regression fixture present: ${audit.core.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release receipt-evidence denial section regression fixture versioned: ${audit.core.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionVersioned}`,
    `- Report contract doc page release receipt-evidence denial section regression script present: ${audit.core.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release post-action receipt denial section regression fixture present: ${audit.core.reportContractDocPageReleasePostActionReceiptDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release post-action receipt denial section regression fixture versioned: ${audit.core.reportContractDocPageReleasePostActionReceiptDenialSectionRegressionVersioned}`,
    `- Report contract doc page release post-action receipt denial section regression script present: ${audit.core.reportContractDocPageReleasePostActionReceiptDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release post-action audit denial section regression fixture present: ${audit.core.reportContractDocPageReleasePostActionAuditDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release post-action audit denial section regression fixture versioned: ${audit.core.reportContractDocPageReleasePostActionAuditDenialSectionRegressionVersioned}`,
    `- Report contract doc page release post-action audit denial section regression script present: ${audit.core.reportContractDocPageReleasePostActionAuditDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release post-action reconciliation denial section regression fixture present: ${audit.core.reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release post-action reconciliation denial section regression fixture versioned: ${audit.core.reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionVersioned}`,
    `- Report contract doc page release post-action reconciliation denial section regression script present: ${audit.core.reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release post-action settlement denial section regression fixture present: ${audit.core.reportContractDocPageReleasePostActionSettlementDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release post-action settlement denial section regression fixture versioned: ${audit.core.reportContractDocPageReleasePostActionSettlementDenialSectionRegressionVersioned}`,
    `- Report contract doc page release post-action settlement denial section regression script present: ${audit.core.reportContractDocPageReleasePostActionSettlementDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release post-action acceptance denial section regression fixture present: ${audit.core.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release post-action acceptance denial section regression fixture versioned: ${audit.core.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionVersioned}`,
    `- Report contract doc page release post-action acceptance denial section regression script present: ${audit.core.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release post-action payment denial section regression fixture present: ${audit.core.reportContractDocPageReleasePostActionPaymentDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release post-action payment denial section regression fixture versioned: ${audit.core.reportContractDocPageReleasePostActionPaymentDenialSectionRegressionVersioned}`,
    `- Report contract doc page release post-action payment denial section regression script present: ${audit.core.reportContractDocPageReleasePostActionPaymentDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release post-action deployment denial section regression fixture present: ${audit.core.reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release post-action deployment denial section regression fixture versioned: ${audit.core.reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionVersioned}`,
    `- Report contract doc page release post-action deployment denial section regression script present: ${audit.core.reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release post-action provider spend denial section regression fixture present: ${audit.core.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release post-action provider spend denial section regression fixture versioned: ${audit.core.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionVersioned}`,
    `- Report contract doc page release post-action provider spend denial section regression script present: ${audit.core.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release post-action state transition denial section regression fixture present: ${audit.core.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release post-action state transition denial section regression fixture versioned: ${audit.core.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionVersioned}`,
    `- Report contract doc page release post-action state transition denial section regression script present: ${audit.core.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release post-action queue consumption denial section regression fixture present: ${audit.core.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release post-action queue consumption denial section regression fixture versioned: ${audit.core.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionVersioned}`,
    `- Report contract doc page release post-action queue consumption denial section regression script present: ${audit.core.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release post-action background runner denial section regression fixture present: ${audit.core.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release post-action background runner denial section regression fixture versioned: ${audit.core.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionVersioned}`,
    `- Report contract doc page release post-action background runner denial section regression script present: ${audit.core.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionScriptPresent}`,
    `- Report contract doc page release post-action dispatch completion denial section regression fixture present: ${audit.core.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionModulePresent}`,
    `- Report contract doc page release post-action dispatch completion denial section regression fixture versioned: ${audit.core.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionVersioned}`,
    `- Report contract doc page release post-action dispatch completion denial section regression script present: ${audit.core.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionScriptPresent}`,
    `- Report manifest drift regression fixture present: ${audit.core.reportManifestDriftRegressionModulePresent}`,
    `- Report manifest drift regression fixture versioned: ${audit.core.reportManifestDriftRegressionVersioned}`,
    `- Report manifest drift regression script present: ${audit.core.reportManifestDriftRegressionScriptPresent}`,
    `- Report latest recovery regression fixture present: ${audit.core.reportLatestRecoveryRegressionModulePresent}`,
    `- Report latest recovery regression fixture versioned: ${audit.core.reportLatestRecoveryRegressionVersioned}`,
    `- Report latest recovery regression script present: ${audit.core.reportLatestRecoveryRegressionScriptPresent}`,
    `- Report bootstrap seed regression fixture present: ${audit.core.reportBootstrapSeedRegressionModulePresent}`,
    `- Report bootstrap seed regression fixture versioned: ${audit.core.reportBootstrapSeedRegressionVersioned}`,
    `- Report bootstrap seed regression script present: ${audit.core.reportBootstrapSeedRegressionScriptPresent}`,
    `- Report gate clean rerun regression fixture present: ${audit.core.reportGateCleanRerunRegressionModulePresent}`,
    `- Report gate clean rerun regression fixture versioned: ${audit.core.reportGateCleanRerunRegressionVersioned}`,
    `- Report gate clean rerun regression script present: ${audit.core.reportGateCleanRerunRegressionScriptPresent}`,
    `- Report clean gate idempotence regression fixture present: ${audit.core.reportCleanGateIdempotenceRegressionModulePresent}`,
    `- Report clean gate idempotence regression fixture versioned: ${audit.core.reportCleanGateIdempotenceRegressionVersioned}`,
    `- Report clean gate idempotence regression script present: ${audit.core.reportCleanGateIdempotenceRegressionScriptPresent}`,
    `- Report final settlement regression fixture present: ${audit.core.reportFinalSettlementRegressionModulePresent}`,
    `- Report final settlement regression fixture versioned: ${audit.core.reportFinalSettlementRegressionVersioned}`,
    `- Report final settlement regression script present: ${audit.core.reportFinalSettlementRegressionScriptPresent}`,
    `- Report post-final drift regression fixture present: ${audit.core.reportPostFinalDriftRegressionModulePresent}`,
    `- Report post-final drift regression fixture versioned: ${audit.core.reportPostFinalDriftRegressionVersioned}`,
    `- Report post-final drift regression script present: ${audit.core.reportPostFinalDriftRegressionScriptPresent}`,
    `- Report closeout drift classification regression fixture present: ${audit.core.reportCloseoutDriftClassificationRegressionModulePresent}`,
    `- Report closeout drift classification regression fixture versioned: ${audit.core.reportCloseoutDriftClassificationRegressionVersioned}`,
    `- Report closeout drift classification regression script present: ${audit.core.reportCloseoutDriftClassificationRegressionScriptPresent}`,
    `- Report closeout command inventory regression fixture present: ${audit.core.reportCloseoutCommandInventoryRegressionModulePresent}`,
    `- Report closeout command inventory regression fixture versioned: ${audit.core.reportCloseoutCommandInventoryRegressionVersioned}`,
    `- Report closeout command inventory regression script present: ${audit.core.reportCloseoutCommandInventoryRegressionScriptPresent}`,
    `- Report runner contract regression fixture present: ${audit.core.reportRunnerContractRegressionModulePresent}`,
    `- Report runner contract regression fixture versioned: ${audit.core.reportRunnerContractRegressionVersioned}`,
    `- Report runner contract regression script present: ${audit.core.reportRunnerContractRegressionScriptPresent}`,
    `- Report retention guard present: ${audit.core.reportRetentionModulePresent}`,
    `- Report retention guard versioned: ${audit.core.reportRetentionVersioned}`,
    `- Report retention regression fixture present: ${audit.core.reportRetentionRegressionModulePresent}`,
    `- Report retention regression fixture versioned: ${audit.core.reportRetentionRegressionVersioned}`,
    `- Report retention regression script present: ${audit.core.reportRetentionRegressionScriptPresent}`,
    `- Integration dependency audit compatibility export absent: ${audit.core.integrationDependencyAuditCompatibilityExportAbsent}`,
    `- Integration dependency audit root export absent: ${audit.core.integrationDependencyAuditRootExportAbsent}`,
    `- Integration gate script present: ${audit.core.integrationGateScriptPresent}`,
    `- Report retention script present: ${audit.core.reportRetentionScriptPresent}`,
    '',
    '## Channel Wiring',
    '',
    '| Channel | Status | Runtime core imports | Runtime files | Missing surfaces |',
    '| --- | --- | ---: | ---: | --- |',
    ...audit.channels.map((channel) => (
      `| ${channel.label} | ${channel.status} | ${channel.runtimeCoreImportCount} | ${channel.runtimeImportFiles.length} | ${[
        ...channel.missingSurfaces,
        ...(channel.forbiddenImports || []).map((item) => item.code),
      ].join(', ') || 'none'} |`
    )),
    '',
    '## Public API Migration',
    '',
    '| Channel | Stable imports | Compatibility imports | Internal imports | Recommended action |',
    '| --- | ---: | ---: | ---: | --- |',
    ...audit.channels.map((channel) => (
      `| ${channel.label} | ${channel.publicApiUsage.stableImportCount} | ${channel.publicApiUsage.compatibilityImportCount} | ${channel.publicApiUsage.internalImportCount} | ${channel.publicApiUsage.recommendedAction} |`
    )),
    '',
    '## Channel Import Allowlist',
    '',
    `- Status: ${audit.channelImportAllowlist.status}`,
    `- Hash: ${audit.channelImportAllowlist.allowlistHash}`,
    `- Channels: ${audit.channelImportAllowlist.summary.passingChannels}/${audit.channelImportAllowlist.summary.channelCount}`,
    `- Imports: ${audit.channelImportAllowlist.summary.importCount}`,
    `- Package deep src imports: ${audit.channelImportAllowlist.summary.packageDeepSrcImportCount}`,
    `- Compatibility imports: ${audit.channelImportAllowlist.summary.compatibilityImportCount}`,
    `- Internal imports: ${audit.channelImportAllowlist.summary.internalImportCount}`,
    `- Unallowed stable imports: ${audit.channelImportAllowlist.summary.unallowedStableImportCount}`,
    `- Blockers: ${audit.channelImportAllowlist.summary.blockerCount}`,
    `- Stable relative imports: ${audit.channelImportAllowlist.summary.stableRelativeImportCount}`,
    '',
    '## Package Root Resolver',
    '',
    `- Status: ${audit.packageRootResolver.status}`,
    `- Hash: ${audit.packageRootResolver.resolverHash}`,
    `- Link ready: ${audit.packageRootResolver.summary.packageLinkReady}`,
    `- Resolver-ready channels: ${audit.packageRootResolver.summary.resolverReadyChannels}/${audit.packageRootResolver.summary.channelCount}`,
    `- Root import-ready channels: ${audit.packageRootResolver.summary.rootImportReadyChannels}/${audit.packageRootResolver.summary.channelCount}`,
    `- Deep import-blocked channels: ${audit.packageRootResolver.summary.deepImportBlockedChannels}/${audit.packageRootResolver.summary.channelCount}`,
    `- Blockers: ${audit.packageRootResolver.summary.blockerCount}`,
    '',
    '## Package Root Import Migration Plan',
    '',
    `- Status: ${audit.packageRootImportMigration.status}`,
    `- Hash: ${audit.packageRootImportMigration.migrationHash}`,
    `- Current core imports: ${audit.packageRootImportMigration.summary.currentCoreImportCount}`,
    `- Package root imports: ${audit.packageRootImportMigration.summary.packageRootImportCount}`,
    `- Migratable relative imports: ${audit.packageRootImportMigration.summary.migratableRelativeImportCount}`,
    `- Non-migratable imports: ${audit.packageRootImportMigration.summary.nonMigratableImportCount}`,
    `- File plans: ${audit.packageRootImportMigration.summary.filePlanCount}`,
    `- Blockers: ${audit.packageRootImportMigration.summary.blockerCount}`,
    '',
    '## Package Root Import Regression Fixture',
    '',
    `- Status: ${audit.packageRootImportRegression.status}`,
    `- Hash: ${audit.packageRootImportRegression.regressionHash}`,
    `- Expected bad imports: ${audit.packageRootImportRegression.summary.expectedBadImportCount}`,
    `- Allowlist relative blockers: ${audit.packageRootImportRegression.summary.allowlistRelativeBlockerCount}`,
    `- Migration non-migratable blockers: ${audit.packageRootImportRegression.summary.migrationNonMigratableBlockerCount}`,
    `- Docs files scanned: ${audit.packageRootImportRegression.summary.docsScannedFileCount}`,
    `- Docs forbidden import examples: ${audit.packageRootImportRegression.summary.docsForbiddenImportExampleCount}`,
    `- Blockers: ${audit.packageRootImportRegression.summary.blockerCount}`,
    '',
    '## Package Root Symbol Manifest',
    '',
    `- Status: ${audit.packageRootSymbolManifest.status}`,
    `- Hash: ${audit.packageRootSymbolManifest.symbolManifestHash}`,
    `- Imported symbols: ${audit.packageRootSymbolManifest.summary.importedSymbolCount}`,
    `- Unique imported symbols: ${audit.packageRootSymbolManifest.summary.uniqueImportedSymbolCount}`,
    `- Unallowed symbols: ${audit.packageRootSymbolManifest.summary.unallowedSymbolCount}`,
    `- Missing package exports: ${audit.packageRootSymbolManifest.summary.missingPackageExportCount}`,
    `- Namespace imports: ${audit.packageRootSymbolManifest.summary.namespaceImportCount}`,
    `- Default imports: ${audit.packageRootSymbolManifest.summary.defaultImportCount}`,
    `- Blockers: ${audit.packageRootSymbolManifest.summary.blockerCount}`,
    '',
    '## Package Root Symbol Regression Fixture',
    '',
    `- Status: ${audit.packageRootSymbolRegression.status}`,
    `- Hash: ${audit.packageRootSymbolRegression.symbolRegressionHash}`,
    `- Symbol manifest ok: ${audit.packageRootSymbolRegression.summary.symbolManifestOk}`,
    `- Namespace imports: ${audit.packageRootSymbolRegression.summary.namespaceImportCount}`,
    `- Default imports: ${audit.packageRootSymbolRegression.summary.defaultImportCount}`,
    `- Unallowed symbols: ${audit.packageRootSymbolRegression.summary.unallowedSymbolCount}`,
    `- Missing package exports: ${audit.packageRootSymbolRegression.summary.missingPackageExportCount}`,
    `- Symbol manifest blockers: ${audit.packageRootSymbolRegression.summary.symbolManifestBlockerCount}`,
    `- Regression blockers: ${audit.packageRootSymbolRegression.summary.blockerCount}`,
    '',
    '## Package Root Symbol Minimization',
    '',
    `- Status: ${audit.packageRootSymbolMinimization.status}`,
    `- Hash: ${audit.packageRootSymbolMinimization.symbolMinimizationHash}`,
    `- Manifest symbols: ${audit.packageRootSymbolMinimization.summary.manifestSymbolCount}`,
    `- Exact-current manifest symbols: ${audit.packageRootSymbolMinimization.summary.exactCurrentManifestSymbolCount}`,
    `- Unused allowed symbols: ${audit.packageRootSymbolMinimization.summary.unusedAllowedSymbolCount}`,
    `- Shrinkable symbols: ${audit.packageRootSymbolMinimization.summary.shrinkableSymbolCount}`,
    `- Minimization ready: ${audit.packageRootSymbolMinimization.summary.minimizationReady}`,
    `- Blockers: ${audit.packageRootSymbolMinimization.summary.blockerCount}`,
    '',
    '## Report Freshness',
    '',
    `- Status: ${audit.reportFreshness.status}`,
    `- Hash: ${audit.reportFreshness.freshnessHash}`,
    `- Reports ok: ${audit.reportFreshness.summary.okReportCount}/${audit.reportFreshness.summary.reportCount}`,
    `- Include gate report: ${audit.reportFreshness.summary.includeGateReport}`,
    `- Gate hash mismatches: ${audit.reportFreshness.summary.gateHashMismatchCount}`,
    `- Blockers: ${audit.reportFreshness.summary.blockerCount}`,
    '',
    '## Report Freshness Regression Fixture',
    '',
    `- Status: ${audit.reportFreshnessRegression.status}`,
    `- Hash: ${audit.reportFreshnessRegression.freshnessRegressionHash}`,
    `- Scenarios: ${audit.reportFreshnessRegression.summary.passedScenarioCount}/${audit.reportFreshnessRegression.summary.scenarioCount}`,
    `- Expected blockers observed: ${audit.reportFreshnessRegression.summary.observedExpectedBlockerCount}/${audit.reportFreshnessRegression.summary.expectedBlockerCount}`,
    `- Blockers: ${audit.reportFreshnessRegression.summary.blockerCount}`,
    '',
    '## Integration Gate Sequence Regression Fixture',
    '',
    `- Status: ${audit.integrationGateSequenceRegression.status}`,
    `- Hash: ${audit.integrationGateSequenceRegression.sequenceRegressionHash}`,
    `- Actual sequence ok: ${audit.integrationGateSequenceRegression.summary.actualOk}`,
    `- Actual steps: ${audit.integrationGateSequenceRegression.summary.actualStepCount}`,
    `- Scenarios: ${audit.integrationGateSequenceRegression.summary.passedScenarioCount}/${audit.integrationGateSequenceRegression.summary.scenarioCount}`,
    `- Expected blockers observed: ${audit.integrationGateSequenceRegression.summary.observedExpectedBlockerCount}/${audit.integrationGateSequenceRegression.summary.expectedScenarioCount}`,
    `- Blockers: ${audit.integrationGateSequenceRegression.summary.blockerCount}`,
    '',
    '## Report Inventory Consistency Fixture',
    '',
    `- Status: ${audit.reportInventoryConsistency.status}`,
    `- Hash: ${audit.reportInventoryConsistency.inventoryConsistencyHash}`,
    `- Actual inventory ok: ${audit.reportInventoryConsistency.summary.actualOk}`,
    `- Freshness reports: ${audit.reportInventoryConsistency.summary.freshnessRequiredReportCount}`,
    `- Tooling reports: ${audit.reportInventoryConsistency.summary.toolingReportCount}/${audit.reportInventoryConsistency.summary.expectedToolingReportCount}`,
    `- Checkpoint bindings: ${audit.reportInventoryConsistency.summary.checkpointBindingCount}/${audit.reportInventoryConsistency.summary.expectedCheckpointBindingCount}`,
    `- Gate hash keys: ${audit.reportInventoryConsistency.summary.gateSummaryHashKeyCount}/${audit.reportInventoryConsistency.summary.requiredGateSummaryHashKeyCount}`,
    `- Scenarios: ${audit.reportInventoryConsistency.summary.passedScenarioCount}/${audit.reportInventoryConsistency.summary.scenarioCount}`,
    `- Expected blockers observed: ${audit.reportInventoryConsistency.summary.observedExpectedBlockerCount}/${audit.reportInventoryConsistency.summary.expectedScenarioCount}`,
    `- Blockers: ${audit.reportInventoryConsistency.summary.blockerCount}`,
    '',
    '## Report Schema Contract Fixture',
    '',
    `- Status: ${audit.reportSchemaContract.status}`,
    `- Hash: ${audit.reportSchemaContract.schemaContractHash}`,
    `- Actual schema ok: ${audit.reportSchemaContract.summary.actualOk}`,
    `- Reports: ${audit.reportSchemaContract.summary.passedReportCount}/${audit.reportSchemaContract.summary.expectedReportCount}`,
    `- Hashable reports: ${audit.reportSchemaContract.summary.hashableReportCount}`,
    `- Scenarios: ${audit.reportSchemaContract.summary.passedScenarioCount}/${audit.reportSchemaContract.summary.scenarioCount}`,
    `- Expected blockers observed: ${audit.reportSchemaContract.summary.observedExpectedBlockerCount}/${audit.reportSchemaContract.summary.expectedScenarioCount}`,
    `- Blockers: ${audit.reportSchemaContract.summary.blockerCount}`,
    '',
    '## Report Lineage Topology Fixture',
    '',
    `- Status: ${audit.reportLineageTopology.status}`,
    `- Hash: ${audit.reportLineageTopology.lineageTopologyHash}`,
    `- Actual topology ok: ${audit.reportLineageTopology.summary.actualOk}`,
    `- Graph: nodes=${audit.reportLineageTopology.summary.nodeCount}, edges=${audit.reportLineageTopology.summary.edgeCount}`,
    `- Required nodes: ${audit.reportLineageTopology.summary.nodeCount - audit.reportLineageTopology.summary.missingRequiredNodeCount}/${audit.reportLineageTopology.summary.requiredNodeCount}`,
    `- Scenarios: ${audit.reportLineageTopology.summary.passedScenarioCount}/${audit.reportLineageTopology.summary.scenarioCount}`,
    `- Expected blockers observed: ${audit.reportLineageTopology.summary.observedExpectedBlockerCount}/${audit.reportLineageTopology.summary.expectedScenarioCount}`,
    `- Blockers: ${audit.reportLineageTopology.summary.blockerCount}`,
    '',
    '## Report Hash Stability Regression Fixture',
    '',
    `- Status: ${audit.reportHashStabilityRegression.status}`,
    `- Hash: ${audit.reportHashStabilityRegression.hashStabilityRegressionHash}`,
    `- Actual report inventory ok: ${audit.reportHashStabilityRegression.summary.actualOk}`,
    `- Hashable reports: ${audit.reportHashStabilityRegression.summary.hashableReportCount}/${audit.reportHashStabilityRegression.summary.expectedReportCount}`,
    `- Scenarios: ${audit.reportHashStabilityRegression.summary.passedScenarioCount}/${audit.reportHashStabilityRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportHashStabilityRegression.summary.blockerCount}`,
    '',
    '## Report Output Pairing Fixture',
    '',
    `- Status: ${audit.reportOutputPairing.status}`,
    `- Hash: ${audit.reportOutputPairing.outputPairingHash}`,
    `- Actual pairing ok: ${audit.reportOutputPairing.summary.actualOk}`,
    `- JSON reports: ${audit.reportOutputPairing.summary.jsonReportCount}/${audit.reportOutputPairing.summary.expectedJsonReportCount}`,
    `- Markdown reports: ${audit.reportOutputPairing.summary.markdownReportCount}/${audit.reportOutputPairing.summary.expectedJsonReportCount}`,
    `- README listed reports: ${audit.reportOutputPairing.summary.readmeListedReportCount}/${audit.reportOutputPairing.summary.expectedJsonReportCount}`,
    `- Scenarios: ${audit.reportOutputPairing.summary.passedScenarioCount}/${audit.reportOutputPairing.summary.scenarioCount}`,
    `- Blockers: ${audit.reportOutputPairing.summary.blockerCount}`,
    '',
    '## Report Artifact Reproducibility Fixture',
    '',
    `- Status: ${audit.reportArtifactReproducibility.status}`,
    `- Hash: ${audit.reportArtifactReproducibility.artifactReproducibilityHash}`,
    `- Actual reproducibility ok: ${audit.reportArtifactReproducibility.summary.actualOk}`,
    `- Artifact digests: ${audit.reportArtifactReproducibility.summary.artifactDigestCount}/${audit.reportArtifactReproducibility.summary.expectedReportCount}`,
    `- Gate bindings: ${audit.reportArtifactReproducibility.summary.gateBindingMatchCount}/${audit.reportArtifactReproducibility.summary.gateComparableBindingCount}`,
    `- Checkpoint bindings: ${audit.reportArtifactReproducibility.summary.checkpointBindingMatchCount}/${audit.reportArtifactReproducibility.summary.checkpointComparableBindingCount}`,
    `- Scenarios: ${audit.reportArtifactReproducibility.summary.passedScenarioCount}/${audit.reportArtifactReproducibility.summary.scenarioCount}`,
    `- Blockers: ${audit.reportArtifactReproducibility.summary.blockerCount}`,
    '',
    '## Report Self-Reference Boundary Regression Fixture',
    '',
    `- Status: ${audit.reportSelfReferenceBoundaryRegression.status}`,
    `- Hash: ${audit.reportSelfReferenceBoundaryRegression.selfReferenceBoundaryRegressionHash}`,
    `- Actual boundary ok: ${audit.reportSelfReferenceBoundaryRegression.summary.actualOk}`,
    `- Gate steps: ${audit.reportSelfReferenceBoundaryRegression.summary.gateStepCount}`,
    `- Artifact actual ok: ${audit.reportSelfReferenceBoundaryRegression.summary.artifactActualOk}`,
    `- Required gate drift blocked: ${audit.reportSelfReferenceBoundaryRegression.summary.artifactRequiredGateDriftBlocked}`,
    `- Required checkpoint drift blocked: ${audit.reportSelfReferenceBoundaryRegression.summary.artifactRequiredCheckpointDriftBlocked}`,
    `- Final freshness drift blocked: ${audit.reportSelfReferenceBoundaryRegression.summary.finalFreshnessDriftBlocked}`,
    `- Skip-gate freshness ok: ${audit.reportSelfReferenceBoundaryRegression.summary.skipGateFreshnessOk}`,
    `- Scenarios: ${audit.reportSelfReferenceBoundaryRegression.summary.passedScenarioCount}/${audit.reportSelfReferenceBoundaryRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportSelfReferenceBoundaryRegression.summary.blockerCount}`,
    '',
    '## Report Contract Manifest Fixture',
    '',
    `- Status: ${audit.reportContractManifest.status}`,
    `- Hash: ${audit.reportContractManifest.contractManifestHash}`,
    `- Actual manifest ok: ${audit.reportContractManifest.summary.actualOk}`,
    `- Contracts: ${audit.reportContractManifest.summary.okContractCount}/${audit.reportContractManifest.summary.contractCount}`,
    `- Required contracts: ${audit.reportContractManifest.summary.requiredContractCount}`,
    `- Step bindings: ${audit.reportContractManifest.summary.stepBindingCount}`,
    `- Runner imports manifest: ${audit.reportContractManifest.summary.runnerImportsManifest}`,
    `- Runner aliases manifest: ${audit.reportContractManifest.summary.runnerAliasesManifest}`,
    `- Runner local list present: ${audit.reportContractManifest.summary.runnerLocalListPresent}`,
    `- Scenarios: ${audit.reportContractManifest.summary.passedScenarioCount}/${audit.reportContractManifest.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractManifest.summary.blockerCount}`,
    '',
    '## Report Contract Required Coverage Regression Fixture',
    '',
    `- Status: ${audit.reportContractRequiredCoverageRegression.status}`,
    `- Hash: ${audit.reportContractRequiredCoverageRegression.contractRequiredCoverageRegressionHash}`,
    `- Actual coverage ok: ${audit.reportContractRequiredCoverageRegression.summary.actualOk}`,
    `- Contracts: manifest=${audit.reportContractRequiredCoverageRegression.summary.manifestContractCount}, required=${audit.reportContractRequiredCoverageRegression.summary.requiredContractCount}, optional=${audit.reportContractRequiredCoverageRegression.summary.optionalContractCount}`,
    `- Drift: unclassified=${audit.reportContractRequiredCoverageRegression.summary.unclassifiedContractCount}, missingRequired=${audit.reportContractRequiredCoverageRegression.summary.missingRequiredContractCount}`,
    `- Exports: required=${audit.reportContractRequiredCoverageRegression.summary.requiredExportPresent}, optional=${audit.reportContractRequiredCoverageRegression.summary.optionalExportPresent}`,
    `- Scenarios: ${audit.reportContractRequiredCoverageRegression.summary.passedScenarioCount}/${audit.reportContractRequiredCoverageRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractRequiredCoverageRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Coverage Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocCoverageRegression.status}`,
    `- Hash: ${audit.reportContractDocCoverageRegression.contractDocCoverageRegressionHash}`,
    `- Actual coverage ok: ${audit.reportContractDocCoverageRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocCoverageRegression.summary.coveredContractCount}/${audit.reportContractDocCoverageRegression.summary.contractCount}`,
    `- Docs files: ${audit.reportContractDocCoverageRegression.summary.docsFileCount}/${audit.reportContractDocCoverageRegression.summary.contractCount}`,
    `- README scripts: ${audit.reportContractDocCoverageRegression.summary.readmeScriptCount}/${audit.reportContractDocCoverageRegression.summary.contractCount}`,
    `- README docs links: ${audit.reportContractDocCoverageRegression.summary.readmeDocsCount}/${audit.reportContractDocCoverageRegression.summary.contractCount}`,
    `- Reports README files: ${audit.reportContractDocCoverageRegression.summary.reportsReadmeFileCount}/${audit.reportContractDocCoverageRegression.summary.contractCount}`,
    `- Scenarios: ${audit.reportContractDocCoverageRegression.summary.passedScenarioCount}/${audit.reportContractDocCoverageRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocCoverageRegression.summary.blockerCount}`,
    '',
    '## Report Contract Syntax Coverage Regression Fixture',
    '',
    `- Status: ${audit.reportContractSyntaxCoverageRegression.status}`,
    `- Hash: ${audit.reportContractSyntaxCoverageRegression.contractSyntaxCoverageRegressionHash}`,
    `- Actual coverage ok: ${audit.reportContractSyntaxCoverageRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractSyntaxCoverageRegression.summary.okContractCount}/${audit.reportContractSyntaxCoverageRegression.summary.contractCount}`,
    `- Source files: ${audit.reportContractSyntaxCoverageRegression.summary.sourceFileCount}/${audit.reportContractSyntaxCoverageRegression.summary.contractCount}`,
    `- Exporter files: ${audit.reportContractSyntaxCoverageRegression.summary.exporterFileCount}/${audit.reportContractSyntaxCoverageRegression.summary.contractCount}`,
    `- Source syntax steps: ${audit.reportContractSyntaxCoverageRegression.summary.sourceSyntaxStepCount}/${audit.reportContractSyntaxCoverageRegression.summary.contractCount}`,
    `- Exporter syntax steps: ${audit.reportContractSyntaxCoverageRegression.summary.exporterSyntaxStepCount}/${audit.reportContractSyntaxCoverageRegression.summary.contractCount}`,
    `- Source syntax args: ${audit.reportContractSyntaxCoverageRegression.summary.sourceSyntaxArgCount}/${audit.reportContractSyntaxCoverageRegression.summary.contractCount}`,
    `- Exporter syntax args: ${audit.reportContractSyntaxCoverageRegression.summary.exporterSyntaxArgCount}/${audit.reportContractSyntaxCoverageRegression.summary.contractCount}`,
    `- Export order: ${audit.reportContractSyntaxCoverageRegression.summary.exporterBeforeExportCount}/${audit.reportContractSyntaxCoverageRegression.summary.exportStepCount}`,
    `- CLI entrypoint helper sources: ${audit.reportContractSyntaxCoverageRegression.summary.cliEntrypointHelperCount}/${audit.reportContractSyntaxCoverageRegression.summary.cliEntrypointSourceCount}`,
    `- Raw CLI entrypoint sources: ${audit.reportContractSyntaxCoverageRegression.summary.rawCliEntrypointCount}`,
    `- URL pathname package-root sources: ${audit.reportContractSyntaxCoverageRegression.summary.urlPathnameSourceCount}`,
    `- Direct write sources: ${audit.reportContractSyntaxCoverageRegression.summary.allowedDirectWriteSourceCount}/${audit.reportContractSyntaxCoverageRegression.summary.directWriteSourceCount} allowed; disallowed ${audit.reportContractSyntaxCoverageRegression.summary.disallowedDirectWriteSourceCount}`,
    `- Filesystem mutation sources: ${audit.reportContractSyntaxCoverageRegression.summary.allowedFilesystemMutationSourceCount}/${audit.reportContractSyntaxCoverageRegression.summary.filesystemMutationSourceCount} allowed; disallowed ${audit.reportContractSyntaxCoverageRegression.summary.disallowedFilesystemMutationSourceCount}`,
    `- Child process sources: ${audit.reportContractSyntaxCoverageRegression.summary.allowedChildProcessSourceCount}/${audit.reportContractSyntaxCoverageRegression.summary.childProcessSourceCount} allowed; disallowed ${audit.reportContractSyntaxCoverageRegression.summary.disallowedChildProcessSourceCount}; approved commands ${audit.reportContractSyntaxCoverageRegression.summary.approvedChildProcessCommandCount}/${audit.reportContractSyntaxCoverageRegression.summary.childProcessCommandCount}; approved argv ${audit.reportContractSyntaxCoverageRegression.summary.approvedChildProcessArgvCount}/${audit.reportContractSyntaxCoverageRegression.summary.childProcessCommandCount}; approved options ${audit.reportContractSyntaxCoverageRegression.summary.approvedChildProcessOptionsCount}/${audit.reportContractSyntaxCoverageRegression.summary.childProcessCommandCount}; disallowed options ${audit.reportContractSyntaxCoverageRegression.summary.disallowedChildProcessOptionsCount}; result handling ${audit.reportContractSyntaxCoverageRegression.summary.approvedChildProcessResultCount}/${audit.reportContractSyntaxCoverageRegression.summary.childProcessSpawnCount}; disallowed results ${audit.reportContractSyntaxCoverageRegression.summary.disallowedChildProcessResultCount}`,
    `- External boundary sources: ${audit.reportContractSyntaxCoverageRegression.summary.externalBoundarySourceCount}; network ${audit.reportContractSyntaxCoverageRegression.summary.networkApiSourceCount}; browser automation ${audit.reportContractSyntaxCoverageRegression.summary.browserAutomationSourceCount}; process env ${audit.reportContractSyntaxCoverageRegression.summary.allowedProcessEnvSourceCount}/${audit.reportContractSyntaxCoverageRegression.summary.processEnvSourceCount} allowed; disallowed ${audit.reportContractSyntaxCoverageRegression.summary.disallowedProcessEnvSourceCount}`,
    `- Dynamic code sources: ${audit.reportContractSyntaxCoverageRegression.summary.dynamicCodeSourceCount}; dynamic import ${audit.reportContractSyntaxCoverageRegression.summary.allowedDynamicImportSourceCount}/${audit.reportContractSyntaxCoverageRegression.summary.dynamicImportSourceCount} allowed; disallowed ${audit.reportContractSyntaxCoverageRegression.summary.disallowedDynamicImportSourceCount}; unsafe dynamic code ${audit.reportContractSyntaxCoverageRegression.summary.unsafeDynamicCodeSourceCount}`,
    `- Randomness/crypto sources: ${audit.reportContractSyntaxCoverageRegression.summary.randomnessCryptoSourceCount}; crypto ${audit.reportContractSyntaxCoverageRegression.summary.allowedCryptoSourceCount}/${audit.reportContractSyntaxCoverageRegression.summary.cryptoSourceCount} allowed; disallowed ${audit.reportContractSyntaxCoverageRegression.summary.disallowedCryptoSourceCount}; randomness ${audit.reportContractSyntaxCoverageRegression.summary.randomnessSourceCount}`,
    `- Runtime side-effect sources: ${audit.reportContractSyntaxCoverageRegression.summary.runtimeSideEffectSourceCount}; direct process exit ${audit.reportContractSyntaxCoverageRegression.summary.allowedDirectProcessExitSourceCount}/${audit.reportContractSyntaxCoverageRegression.summary.directProcessExitSourceCount} allowed; disallowed ${audit.reportContractSyntaxCoverageRegression.summary.disallowedDirectProcessExitSourceCount}; env mutations ${audit.reportContractSyntaxCoverageRegression.summary.processEnvMutationSourceCount}; async timers ${audit.reportContractSyntaxCoverageRegression.summary.asyncTimerSourceCount}`,
    `- Command string sources: ${audit.reportContractSyntaxCoverageRegression.summary.commandStringSourceCount}; destructive ${audit.reportContractSyntaxCoverageRegression.summary.destructiveCommandStringSourceCount}; external ${audit.reportContractSyntaxCoverageRegression.summary.externalCommandStringSourceCount}`,
    `- Scenarios: ${audit.reportContractSyntaxCoverageRegression.summary.passedScenarioCount}/${audit.reportContractSyntaxCoverageRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractSyntaxCoverageRegression.summary.blockerCount}`,
    '',
    '## Report Contract Source Derivation Regression Fixture',
    '',
    `- Status: ${audit.reportContractSourceDerivationRegression.status}`,
    `- Hash: ${audit.reportContractSourceDerivationRegression.contractSourceDerivationRegressionHash}`,
    `- Actual derivation ok: ${audit.reportContractSourceDerivationRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractSourceDerivationRegression.summary.okContractCount}/${audit.reportContractSourceDerivationRegression.summary.contractCount}`,
    `- File ids: ${audit.reportContractSourceDerivationRegression.summary.fileIdMatchCount}/${audit.reportContractSourceDerivationRegression.summary.contractCount}`,
    `- Markdown ids: ${audit.reportContractSourceDerivationRegression.summary.markdownFileIdMatchCount}/${audit.reportContractSourceDerivationRegression.summary.contractCount}`,
    `- Source/exporter/docs paths: ${audit.reportContractSourceDerivationRegression.summary.sourcePathMatchCount}/${audit.reportContractSourceDerivationRegression.summary.exporterPathMatchCount}/${audit.reportContractSourceDerivationRegression.summary.docsPathMatchCount}`,
    `- Script/hash keys: scripts=${audit.reportContractSourceDerivationRegression.summary.scriptIdMatchCount}, stdout=${audit.reportContractSourceDerivationRegression.summary.stdoutHashFieldMatchCount}, gate=${audit.reportContractSourceDerivationRegression.summary.gateSummaryHashKeyMatchCount}`,
    `- Primary steps: ${audit.reportContractSourceDerivationRegression.summary.primaryStepCount}/${audit.reportContractSourceDerivationRegression.summary.contractCount}`,
    `- Special docs overrides: ${audit.reportContractSourceDerivationRegression.summary.specialDocOverridePresentCount}/${audit.reportContractSourceDerivationRegression.summary.specialDocOverrideCount}`,
    `- Scenarios: ${audit.reportContractSourceDerivationRegression.summary.passedScenarioCount}/${audit.reportContractSourceDerivationRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractSourceDerivationRegression.summary.blockerCount}`,
    '',
    '## Report Contract Summary Key Regression Fixture',
    '',
    `- Status: ${audit.reportContractSummaryKeyRegression.status}`,
    `- Hash: ${audit.reportContractSummaryKeyRegression.contractSummaryKeyRegressionHash}`,
    `- Actual coverage ok: ${audit.reportContractSummaryKeyRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractSummaryKeyRegression.summary.okContractCount}/${audit.reportContractSummaryKeyRegression.summary.contractCount}`,
    `- Scenario contracts: ${audit.reportContractSummaryKeyRegression.summary.scenarioContractCount}`,
    `- Gate hash keys: ${audit.reportContractSummaryKeyRegression.summary.gateHashKeyCount}/${audit.reportContractSummaryKeyRegression.summary.contractCount}`,
    `- Gate ok keys: ${audit.reportContractSummaryKeyRegression.summary.gateOkKeyCount}/${audit.reportContractSummaryKeyRegression.summary.contractCount}`,
    `- Checkpoint hash keys: ${audit.reportContractSummaryKeyRegression.summary.checkpointHashKeyCount}/${audit.reportContractSummaryKeyRegression.summary.contractCount}`,
    `- Audit objects: ${audit.reportContractSummaryKeyRegression.summary.auditObjectKeyCount}/${audit.reportContractSummaryKeyRegression.summary.contractCount}`,
    `- Selftest hash keys: ${audit.reportContractSummaryKeyRegression.summary.selftestHashKeyCount}/${audit.reportContractSummaryKeyRegression.summary.contractCount}`,
    `- Selftest lane hash keys: ${audit.reportContractSummaryKeyRegression.summary.selftestLaneHashKeyCount}/${audit.reportContractSummaryKeyRegression.summary.contractCount}`,
    `- Scenarios: ${audit.reportContractSummaryKeyRegression.summary.passedScenarioCount}/${audit.reportContractSummaryKeyRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractSummaryKeyRegression.summary.blockerCount}`,
    '',
    '## Report Contract Audit Forwarding Regression Fixture',
    '',
    `- Status: ${audit.reportContractAuditForwardingRegression.status}`,
    `- Hash: ${audit.reportContractAuditForwardingRegression.contractAuditForwardingRegressionHash}`,
    `- Actual forwarding ok: ${audit.reportContractAuditForwardingRegression.summary.actualOk}`,
    `- Contracts forwarded: ${audit.reportContractAuditForwardingRegression.summary.okContractCount}/${audit.reportContractAuditForwardingRegression.summary.contractCount}`,
    `- Parameters/call bindings: ${audit.reportContractAuditForwardingRegression.summary.parameterCount}/${audit.reportContractAuditForwardingRegression.summary.callBindingCount}`,
    `- Loops/pushes: ${audit.reportContractAuditForwardingRegression.summary.forwardingLoopCount}/${audit.reportContractAuditForwardingRegression.summary.blockerPushCount}`,
    `- Prefix/code/notes/owner: ${audit.reportContractAuditForwardingRegression.summary.prefixCount}/${audit.reportContractAuditForwardingRegression.summary.childCodeCount}/${audit.reportContractAuditForwardingRegression.summary.notesCount}/${audit.reportContractAuditForwardingRegression.summary.ownerCount}`,
    `- Scenarios: ${audit.reportContractAuditForwardingRegression.summary.passedScenarioCount}/${audit.reportContractAuditForwardingRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractAuditForwardingRegression.summary.blockerCount}`,
    '',
    '## Report Contract Checkpoint Binding Shape Regression Fixture',
    '',
    `- Status: ${audit.reportContractCheckpointBindingShapeRegression.status}`,
    `- Hash: ${audit.reportContractCheckpointBindingShapeRegression.contractCheckpointBindingShapeRegressionHash}`,
    `- Actual binding shape ok: ${audit.reportContractCheckpointBindingShapeRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractCheckpointBindingShapeRegression.summary.okContractCount}/${audit.reportContractCheckpointBindingShapeRegression.summary.contractCount}`,
    `- Scenario contracts: ${audit.reportContractCheckpointBindingShapeRegression.summary.scenarioContractCount}`,
    `- Bindings/files/required: ${audit.reportContractCheckpointBindingShapeRegression.summary.bindingCount}/${audit.reportContractCheckpointBindingShapeRegression.summary.bindingFilenameCount}/${audit.reportContractCheckpointBindingShapeRegression.summary.bindingRequiredCount}`,
    `- Hash extractors/summary hashes/markdown hashes: ${audit.reportContractCheckpointBindingShapeRegression.summary.hashExtractorCount}/${audit.reportContractCheckpointBindingShapeRegression.summary.summaryHashCount}/${audit.reportContractCheckpointBindingShapeRegression.summary.markdownHashCount}`,
    `- Scenario summary keys: ${audit.reportContractCheckpointBindingShapeRegression.summary.summaryScenarioCount}/${audit.reportContractCheckpointBindingShapeRegression.summary.summaryPassedScenarioCount}/${audit.reportContractCheckpointBindingShapeRegression.summary.summaryBlockerCount}`,
    `- Scenarios: ${audit.reportContractCheckpointBindingShapeRegression.summary.passedScenarioCount}/${audit.reportContractCheckpointBindingShapeRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractCheckpointBindingShapeRegression.summary.blockerCount}`,
    '',
    '## Report Contract Gate Summary Shape Regression Fixture',
    '',
    `- Status: ${audit.reportContractGateSummaryShapeRegression.status}`,
    `- Hash: ${audit.reportContractGateSummaryShapeRegression.contractGateSummaryShapeRegressionHash}`,
    `- Actual gate summary shape ok: ${audit.reportContractGateSummaryShapeRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractGateSummaryShapeRegression.summary.okContractCount}/${audit.reportContractGateSummaryShapeRegression.summary.contractCount}`,
    `- Gate ok/hash shapes: ${audit.reportContractGateSummaryShapeRegression.summary.okShapeCount}/${audit.reportContractGateSummaryShapeRegression.summary.hashShapeCount}`,
    `- Markdown ok/hash lines: ${audit.reportContractGateSummaryShapeRegression.summary.markdownOkCount}/${audit.reportContractGateSummaryShapeRegression.summary.markdownHashCount}`,
    `- Scenarios: ${audit.reportContractGateSummaryShapeRegression.summary.passedScenarioCount}/${audit.reportContractGateSummaryShapeRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractGateSummaryShapeRegression.summary.blockerCount}`,
    '',
    '## Report Contract Exporter Stdout Shape Regression Fixture',
    '',
    `- Status: ${audit.reportContractExporterStdoutShapeRegression.status}`,
    `- Hash: ${audit.reportContractExporterStdoutShapeRegression.contractExporterStdoutShapeRegressionHash}`,
    `- Actual exporter stdout shape ok: ${audit.reportContractExporterStdoutShapeRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractExporterStdoutShapeRegression.summary.okContractCount}/${audit.reportContractExporterStdoutShapeRegression.summary.contractCount}`,
    `- Stdout ok/status/hash fields: ${audit.reportContractExporterStdoutShapeRegression.summary.stdoutOkCount}/${audit.reportContractExporterStdoutShapeRegression.summary.stdoutStatusCount}/${audit.reportContractExporterStdoutShapeRegression.summary.stdoutHashCount}`,
    `- Stdout summary/blockers/reportFiles fields: ${audit.reportContractExporterStdoutShapeRegression.summary.stdoutSummaryCount}/${audit.reportContractExporterStdoutShapeRegression.summary.stdoutBlockersCount}/${audit.reportContractExporterStdoutShapeRegression.summary.stdoutReportFilesCount}`,
    `- Strict exits: ${audit.reportContractExporterStdoutShapeRegression.summary.strictExitCount}/${audit.reportContractExporterStdoutShapeRegression.summary.contractCount}`,
    `- Scenarios: ${audit.reportContractExporterStdoutShapeRegression.summary.passedScenarioCount}/${audit.reportContractExporterStdoutShapeRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractExporterStdoutShapeRegression.summary.blockerCount}`,
    '',
    '## Report Contract Safety Flag Regression Fixture',
    '',
    `- Status: ${audit.reportContractSafetyFlagRegression.status}`,
    `- Hash: ${audit.reportContractSafetyFlagRegression.contractSafetyFlagRegressionHash}`,
    `- Actual safety flags ok: ${audit.reportContractSafetyFlagRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractSafetyFlagRegression.summary.okContractCount}/${audit.reportContractSafetyFlagRegression.summary.contractCount}`,
    `- Safety blocks: ${audit.reportContractSafetyFlagRegression.summary.safetyCount}/${audit.reportContractSafetyFlagRegression.summary.contractCount}`,
    `- Required true flags: ${audit.reportContractSafetyFlagRegression.summary.trueFlagCount}/${audit.reportContractSafetyFlagRegression.summary.requiredTrueFlagCount}`,
    `- Required false flags: ${audit.reportContractSafetyFlagRegression.summary.falseFlagCount}/${audit.reportContractSafetyFlagRegression.summary.requiredFalseFlagCount}`,
    `- Scenarios: ${audit.reportContractSafetyFlagRegression.summary.passedScenarioCount}/${audit.reportContractSafetyFlagRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractSafetyFlagRegression.summary.blockerCount}`,
    '',
    '## Report Contract Artifact Binding Regression Fixture',
    '',
    `- Status: ${audit.reportContractArtifactBindingRegression.status}`,
    `- Hash: ${audit.reportContractArtifactBindingRegression.contractArtifactBindingRegressionHash}`,
    `- Actual artifact bindings ok: ${audit.reportContractArtifactBindingRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractArtifactBindingRegression.summary.okContractCount}/${audit.reportContractArtifactBindingRegression.summary.contractCount}`,
    `- Latest outputs: json=${audit.reportContractArtifactBindingRegression.summary.jsonReportCount}, md=${audit.reportContractArtifactBindingRegression.summary.markdownReportCount}, readme=${audit.reportContractArtifactBindingRegression.summary.readmeBindingCount}`,
    `- Freshness/tooling/schema: ${audit.reportContractArtifactBindingRegression.summary.freshnessBindingCount}/${audit.reportContractArtifactBindingRegression.summary.freshnessExpectedCount}, ${audit.reportContractArtifactBindingRegression.summary.toolingBindingCount}/${audit.reportContractArtifactBindingRegression.summary.toolingExpectedCount}, ${audit.reportContractArtifactBindingRegression.summary.schemaBindingCount}/${audit.reportContractArtifactBindingRegression.summary.schemaExpectedCount}`,
    `- Output/artifact bindings: ${audit.reportContractArtifactBindingRegression.summary.outputPairingBindingCount}/${audit.reportContractArtifactBindingRegression.summary.outputPairingExpectedCount}, ${audit.reportContractArtifactBindingRegression.summary.artifactReproducibilityBindingCount}/${audit.reportContractArtifactBindingRegression.summary.artifactReproducibilityExpectedCount}`,
    `- Explicit self-cycle skips: ${audit.reportContractArtifactBindingRegression.summary.skippedBindingCount}`,
    `- Scenarios: ${audit.reportContractArtifactBindingRegression.summary.passedScenarioCount}/${audit.reportContractArtifactBindingRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractArtifactBindingRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Index Anchor Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocIndexAnchorRegression.status}`,
    `- Hash: ${audit.reportContractDocIndexAnchorRegression.contractDocIndexAnchorRegressionHash}`,
    `- Actual doc index anchors ok: ${audit.reportContractDocIndexAnchorRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocIndexAnchorRegression.summary.okContractCount}/${audit.reportContractDocIndexAnchorRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocIndexAnchorRegression.summary.uniqueDocsPathCount}`,
    `- Docs files/headings/commands: ${audit.reportContractDocIndexAnchorRegression.summary.docsFileCount}/${audit.reportContractDocIndexAnchorRegression.summary.docsHeadingCount}/${audit.reportContractDocIndexAnchorRegression.summary.docsCommandCount}`,
    `- README docs/commands/latest: ${audit.reportContractDocIndexAnchorRegression.summary.readmeDocsCount}/${audit.reportContractDocIndexAnchorRegression.summary.readmeCommandCount}/${audit.reportContractDocIndexAnchorRegression.summary.readmeLatestCount}`,
    `- Reports README commands/latest: ${audit.reportContractDocIndexAnchorRegression.summary.reportsReadmeCommandCount}/${audit.reportContractDocIndexAnchorRegression.summary.reportsReadmeLatestCount}`,
    `- Scenarios: ${audit.reportContractDocIndexAnchorRegression.summary.passedScenarioCount}/${audit.reportContractDocIndexAnchorRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocIndexAnchorRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Latest Detail Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageLatestDetailRegression.status}`,
    `- Hash: ${audit.reportContractDocPageLatestDetailRegression.contractDocPageLatestDetailRegressionHash}`,
    `- Actual doc page latest details ok: ${audit.reportContractDocPageLatestDetailRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageLatestDetailRegression.summary.okContractCount}/${audit.reportContractDocPageLatestDetailRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageLatestDetailRegression.summary.uniqueDocsPathCount}`,
    `- Docs/latest JSON/latest Markdown: ${audit.reportContractDocPageLatestDetailRegression.summary.docsFileCount}/${audit.reportContractDocPageLatestDetailRegression.summary.latestJsonCount}/${audit.reportContractDocPageLatestDetailRegression.summary.latestMarkdownCount}`,
    `- Scenarios: ${audit.reportContractDocPageLatestDetailRegression.summary.passedScenarioCount}/${audit.reportContractDocPageLatestDetailRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageLatestDetailRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Command Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageCommandSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageCommandSectionRegression.contractDocPageCommandSectionRegressionHash}`,
    `- Actual doc page command sections ok: ${audit.reportContractDocPageCommandSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageCommandSectionRegression.summary.okContractCount}/${audit.reportContractDocPageCommandSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageCommandSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections/commands: ${audit.reportContractDocPageCommandSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageCommandSectionRegression.summary.sectionCount}/${audit.reportContractDocPageCommandSectionRegression.summary.commandCount}`,
    `- Latest/strict/safety/order: ${audit.reportContractDocPageCommandSectionRegression.summary.latestJsonCount}/${audit.reportContractDocPageCommandSectionRegression.summary.latestMarkdownCount}/${audit.reportContractDocPageCommandSectionRegression.summary.strictGateCount}/${audit.reportContractDocPageCommandSectionRegression.summary.safetyCount}/${audit.reportContractDocPageCommandSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageCommandSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageCommandSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageCommandSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Safety Section Detail Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageSafetySectionDetailRegression.status}`,
    `- Hash: ${audit.reportContractDocPageSafetySectionDetailRegression.contractDocPageSafetySectionDetailRegressionHash}`,
    `- Actual doc page safety sections ok: ${audit.reportContractDocPageSafetySectionDetailRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageSafetySectionDetailRegression.summary.okContractCount}/${audit.reportContractDocPageSafetySectionDetailRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageSafetySectionDetailRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageSafetySectionDetailRegression.summary.docsFileCount}/${audit.reportContractDocPageSafetySectionDetailRegression.summary.sectionCount}`,
    `- Boundaries/order: ${audit.reportContractDocPageSafetySectionDetailRegression.summary.localBoundaryCount}/${audit.reportContractDocPageSafetySectionDetailRegression.summary.reportFileBoundaryCount}/${audit.reportContractDocPageSafetySectionDetailRegression.summary.externalActionBoundaryCount}/${audit.reportContractDocPageSafetySectionDetailRegression.summary.executionBoundaryCount}/${audit.reportContractDocPageSafetySectionDetailRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageSafetySectionDetailRegression.summary.passedScenarioCount}/${audit.reportContractDocPageSafetySectionDetailRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageSafetySectionDetailRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Strict Gate Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageStrictGateSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageStrictGateSectionRegression.contractDocPageStrictGateSectionRegressionHash}`,
    `- Actual doc page strict gate sections ok: ${audit.reportContractDocPageStrictGateSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageStrictGateSectionRegression.summary.okContractCount}/${audit.reportContractDocPageStrictGateSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageStrictGateSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageStrictGateSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageStrictGateSectionRegression.summary.sectionCount}`,
    `- Command/participation/closeout/recovery/order: ${audit.reportContractDocPageStrictGateSectionRegression.summary.commandCount}/${audit.reportContractDocPageStrictGateSectionRegression.summary.participationCount}/${audit.reportContractDocPageStrictGateSectionRegression.summary.closeoutCount}/${audit.reportContractDocPageStrictGateSectionRegression.summary.recoveryCount}/${audit.reportContractDocPageStrictGateSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageStrictGateSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageStrictGateSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageStrictGateSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Output Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageOutputSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageOutputSectionRegression.contractDocPageOutputSectionRegressionHash}`,
    `- Actual doc page output sections ok: ${audit.reportContractDocPageOutputSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageOutputSectionRegression.summary.okContractCount}/${audit.reportContractDocPageOutputSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageOutputSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageOutputSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageOutputSectionRegression.summary.sectionCount}`,
    `- JSON/Markdown/Index/Cross-report/order: ${audit.reportContractDocPageOutputSectionRegression.summary.jsonOutputCount}/${audit.reportContractDocPageOutputSectionRegression.summary.markdownOutputCount}/${audit.reportContractDocPageOutputSectionRegression.summary.indexBindingCount}/${audit.reportContractDocPageOutputSectionRegression.summary.crossReportBindingCount}/${audit.reportContractDocPageOutputSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageOutputSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageOutputSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageOutputSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Cross-report Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageCrossReportSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageCrossReportSectionRegression.contractDocPageCrossReportSectionRegressionHash}`,
    `- Actual doc page cross-report sections ok: ${audit.reportContractDocPageCrossReportSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageCrossReportSectionRegression.summary.okContractCount}/${audit.reportContractDocPageCrossReportSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageCrossReportSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageCrossReportSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageCrossReportSectionRegression.summary.sectionCount}`,
    `- Freshness/tooling/schema/output/artifact/audit/selftest/selftest-lanes/checkpoint/order: ${audit.reportContractDocPageCrossReportSectionRegression.summary.freshnessBindingCount}/${audit.reportContractDocPageCrossReportSectionRegression.summary.toolingBindingCount}/${audit.reportContractDocPageCrossReportSectionRegression.summary.schemaBindingCount}/${audit.reportContractDocPageCrossReportSectionRegression.summary.outputPairingBindingCount}/${audit.reportContractDocPageCrossReportSectionRegression.summary.artifactReproducibilityBindingCount}/${audit.reportContractDocPageCrossReportSectionRegression.summary.auditBindingCount}/${audit.reportContractDocPageCrossReportSectionRegression.summary.selftestBindingCount}/${audit.reportContractDocPageCrossReportSectionRegression.summary.selftestLanesBindingCount}/${audit.reportContractDocPageCrossReportSectionRegression.summary.checkpointBindingCount}/${audit.reportContractDocPageCrossReportSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageCrossReportSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageCrossReportSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageCrossReportSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Closeout Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageCloseoutSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageCloseoutSectionRegression.contractDocPageCloseoutSectionRegressionHash}`,
    `- Actual doc page closeout sections ok: ${audit.reportContractDocPageCloseoutSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageCloseoutSectionRegression.summary.okContractCount}/${audit.reportContractDocPageCloseoutSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageCloseoutSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageCloseoutSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageCloseoutSectionRegression.summary.sectionCount}`,
    `- Final freshness/checkpoint/bootstrap seed/active seed/docs placeholder/diff-check/order: ${audit.reportContractDocPageCloseoutSectionRegression.summary.finalFreshnessProbeCount}/${audit.reportContractDocPageCloseoutSectionRegression.summary.checkpointProbeCount}/${audit.reportContractDocPageCloseoutSectionRegression.summary.bootstrapSeedCleanProbeCount}/${audit.reportContractDocPageCloseoutSectionRegression.summary.activeSeedProbeCount}/${audit.reportContractDocPageCloseoutSectionRegression.summary.docsPlaceholderProbeCount}/${audit.reportContractDocPageCloseoutSectionRegression.summary.diffCheckProbeCount}/${audit.reportContractDocPageCloseoutSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageCloseoutSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageCloseoutSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageCloseoutSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Post-Gate Writer Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPagePostGateWriterSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPagePostGateWriterSectionRegression.contractDocPagePostGateWriterSectionRegressionHash}`,
    `- Actual doc page post-gate writer sections ok: ${audit.reportContractDocPagePostGateWriterSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPagePostGateWriterSectionRegression.summary.okContractCount}/${audit.reportContractDocPagePostGateWriterSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPagePostGateWriterSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPagePostGateWriterSectionRegression.summary.docsFileCount}/${audit.reportContractDocPagePostGateWriterSectionRegression.summary.sectionCount}`,
    `- Blocked writer/drift proof/classification/inventory/recovery/zero-seed/order: ${audit.reportContractDocPagePostGateWriterSectionRegression.summary.blockedWriterBoundaryCount}/${audit.reportContractDocPagePostGateWriterSectionRegression.summary.driftProofBindingCount}/${audit.reportContractDocPagePostGateWriterSectionRegression.summary.classificationBindingCount}/${audit.reportContractDocPagePostGateWriterSectionRegression.summary.inventoryBindingCount}/${audit.reportContractDocPagePostGateWriterSectionRegression.summary.recoveryCommandBoundaryCount}/${audit.reportContractDocPagePostGateWriterSectionRegression.summary.zeroSeedRecoveryBoundaryCount}/${audit.reportContractDocPagePostGateWriterSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPagePostGateWriterSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPagePostGateWriterSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPagePostGateWriterSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Retention Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageRetentionSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageRetentionSectionRegression.contractDocPageRetentionSectionRegressionHash}`,
    `- Actual doc page retention sections ok: ${audit.reportContractDocPageRetentionSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageRetentionSectionRegression.summary.okContractCount}/${audit.reportContractDocPageRetentionSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageRetentionSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageRetentionSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageRetentionSectionRegression.summary.sectionCount}`,
    `- Retention dry-run/latest artifact/archive-zero/report-retention/retention-regression/safety/order: ${audit.reportContractDocPageRetentionSectionRegression.summary.retentionDryRunBoundaryCount}/${audit.reportContractDocPageRetentionSectionRegression.summary.latestArtifactRetentionBindingCount}/${audit.reportContractDocPageRetentionSectionRegression.summary.archivedZeroExpectationCount}/${audit.reportContractDocPageRetentionSectionRegression.summary.reportRetentionLatestBindingCount}/${audit.reportContractDocPageRetentionSectionRegression.summary.retentionRegressionBindingCount}/${audit.reportContractDocPageRetentionSectionRegression.summary.retentionSafetyBoundaryCount}/${audit.reportContractDocPageRetentionSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageRetentionSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageRetentionSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageRetentionSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Freshness Hash Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageFreshnessHashSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageFreshnessHashSectionRegression.contractDocPageFreshnessHashSectionRegressionHash}`,
    `- Actual doc page freshness hash sections ok: ${audit.reportContractDocPageFreshnessHashSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageFreshnessHashSectionRegression.summary.okContractCount}/${audit.reportContractDocPageFreshnessHashSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageFreshnessHashSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageFreshnessHashSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageFreshnessHashSectionRegression.summary.sectionCount}`,
    `- Gate parity/comparable/missing-hash/gate-report/recovery/safety/order: ${audit.reportContractDocPageFreshnessHashSectionRegression.summary.gateHashParityBindingCount}/${audit.reportContractDocPageFreshnessHashSectionRegression.summary.comparableGateCountBindingCount}/${audit.reportContractDocPageFreshnessHashSectionRegression.summary.missingHashBlockerBindingCount}/${audit.reportContractDocPageFreshnessHashSectionRegression.summary.gateReportInclusionBindingCount}/${audit.reportContractDocPageFreshnessHashSectionRegression.summary.recoveryOrderingBindingCount}/${audit.reportContractDocPageFreshnessHashSectionRegression.summary.freshnessHashSafetyBoundaryCount}/${audit.reportContractDocPageFreshnessHashSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageFreshnessHashSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageFreshnessHashSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageFreshnessHashSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Checkpoint Hash Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageCheckpointHashSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageCheckpointHashSectionRegression.contractDocPageCheckpointHashSectionRegressionHash}`,
    `- Actual doc page checkpoint hash sections ok: ${audit.reportContractDocPageCheckpointHashSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageCheckpointHashSectionRegression.summary.okContractCount}/${audit.reportContractDocPageCheckpointHashSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageCheckpointHashSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageCheckpointHashSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageCheckpointHashSectionRegression.summary.sectionCount}`,
    `- Hash/scenario/blocker/extractor/markdown/safety/order: ${audit.reportContractDocPageCheckpointHashSectionRegression.summary.checkpointHashBindingCount}/${audit.reportContractDocPageCheckpointHashSectionRegression.summary.checkpointScenarioBindingCount}/${audit.reportContractDocPageCheckpointHashSectionRegression.summary.checkpointBlockerBindingCount}/${audit.reportContractDocPageCheckpointHashSectionRegression.summary.checkpointExtractorBindingCount}/${audit.reportContractDocPageCheckpointHashSectionRegression.summary.checkpointMarkdownBindingCount}/${audit.reportContractDocPageCheckpointHashSectionRegression.summary.checkpointHashSafetyBoundaryCount}/${audit.reportContractDocPageCheckpointHashSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageCheckpointHashSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageCheckpointHashSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageCheckpointHashSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Execution Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.contractDocPageReleaseExecutionDenialSectionRegressionHash}`,
    `- Actual doc page release execution denial sections ok: ${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.sectionCount}`,
    `- Delivery/gate/freshness/checkpoint/retention/seedProbe/external/runtime/order: ${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.releaseDeliveryReadinessArtifactDenialEntryCount}/${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.strictGateExecutionDenialEntryCount}/${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.freshnessExecutionDenialEntryCount}/${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.checkpointExecutionDenialEntryCount}/${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.retentionDryRunExecutionDenialEntryCount}/${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.seedCleanProbeExecutionDenialEntryCount}/${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.externalActionHardDenialEntryCount}/${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.runtimeProviderBrowserDenialEntryCount}/${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseExecutionDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Operator Approval Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.contractDocPageReleaseOperatorApprovalSectionRegressionHash}`,
    `- Actual doc page release operator approval sections ok: ${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.sectionCount}`,
    `- ExecutionDenial/gate/freshness/checkpoint/retention/seedProbe/currentChat/scopeExpiry/order: ${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.releaseExecutionDenialArtifactApprovalEntryCount}/${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.strictGateOperatorApprovalEntryCount}/${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.freshnessOperatorApprovalEntryCount}/${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.checkpointOperatorApprovalEntryCount}/${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.retentionDryRunOperatorApprovalEntryCount}/${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.seedCleanProbeOperatorApprovalEntryCount}/${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.currentChatOperatorApprovalEntryCount}/${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.approvalScopeExpiryEntryCount}/${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseOperatorApprovalSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Approval Ledger Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.contractDocPageReleaseApprovalLedgerSectionRegressionHash}`,
    `- Actual doc page release approval ledger sections ok: ${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.sectionCount}`,
    `- OperatorApproval/gate/freshness/checkpoint/retention/seedProbe/identity/immutability/order: ${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.releaseOperatorApprovalArtifactLedgerEntryCount}/${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.strictGateApprovalLedgerEntryCount}/${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.freshnessApprovalLedgerEntryCount}/${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.checkpointApprovalLedgerEntryCount}/${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.retentionDryRunApprovalLedgerEntryCount}/${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.seedCleanProbeApprovalLedgerEntryCount}/${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.approvalRecordIdentityEntryCount}/${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.ledgerImmutabilityRevocationEntryCount}/${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseApprovalLedgerSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Action Queue Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseActionQueueSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseActionQueueSectionRegression.contractDocPageReleaseActionQueueSectionRegressionHash}`,
    `- Actual doc page release action queue sections ok: ${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.sectionCount}`,
    `- ApprovalLedger/gate/freshness/checkpoint/retention/seedProbe/queueIdentity/replayDenial/order: ${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.releaseApprovalLedgerArtifactQueueEntryCount}/${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.strictGateActionQueueEntryCount}/${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.freshnessActionQueueEntryCount}/${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.checkpointActionQueueEntryCount}/${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.retentionDryRunActionQueueEntryCount}/${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.seedCleanProbeActionQueueEntryCount}/${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.queueRecordIdentityScopeEntryCount}/${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.queueImmutabilityReplayDenialEntryCount}/${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseActionQueueSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Runner Dispatch Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.contractDocPageReleaseRunnerDispatchDenialSectionRegressionHash}`,
    `- Actual doc page release runner dispatch denial sections ok: ${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.sectionCount}`,
    `- ActionQueue/gate/freshness/checkpoint/retention/seedProbe/preflight/replayState/order: ${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.releaseActionQueueArtifactDispatchDenialEntryCount}/${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.strictGateRunnerDispatchDenialEntryCount}/${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.freshnessRunnerDispatchDenialEntryCount}/${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.checkpointRunnerDispatchDenialEntryCount}/${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.retentionDryRunRunnerDispatchDenialEntryCount}/${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.seedCleanProbeRunnerDispatchDenialEntryCount}/${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.runnerDispatchPreflightDenialEntryCount}/${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.liveActionReplayStateDenialEntryCount}/${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseRunnerDispatchDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Live Action Preflight Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.contractDocPageReleaseLiveActionPreflightSectionRegressionHash}`,
    `- Actual doc page release live action preflight sections ok: ${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.sectionCount}`,
    `- RunnerDispatch/gate/freshness/checkpoint/retention/seedProbe/channelState/approvalSeparation/order: ${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.releaseRunnerDispatchDenialArtifactPreflightEntryCount}/${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.strictGateLiveActionPreflightEntryCount}/${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.freshnessLiveActionPreflightEntryCount}/${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.checkpointLiveActionPreflightEntryCount}/${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.retentionDryRunLiveActionPreflightEntryCount}/${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.seedCleanProbeLiveActionPreflightEntryCount}/${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.readOnlyChannelStateEvidenceEntryCount}/${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.preflightApprovalSeparationWriteDenialEntryCount}/${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseLiveActionPreflightSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Execution Intent Capture Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.contractDocPageReleaseExecutionIntentCaptureSectionRegressionHash}`,
    `- Actual doc page release execution intent capture sections ok: ${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.sectionCount}`,
    `- LivePreflight/gate/freshness/checkpoint/retention/seedProbe/intentIdentity/approvalSeparation/order: ${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.releaseLiveActionPreflightArtifactIntentEntryCount}/${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.strictGateExecutionIntentCaptureEntryCount}/${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.freshnessExecutionIntentCaptureEntryCount}/${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.checkpointExecutionIntentCaptureEntryCount}/${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.retentionDryRunExecutionIntentCaptureEntryCount}/${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.seedCleanProbeExecutionIntentCaptureEntryCount}/${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.currentChatIntentIdentityScopeEntryCount}/${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.intentApprovalSeparationWriteDenialEntryCount}/${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseExecutionIntentCaptureSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Execution Approval Boundary Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.contractDocPageReleaseExecutionApprovalBoundarySectionRegressionHash}`,
    `- Actual doc page release execution approval boundary sections ok: ${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.sectionCount}`,
    `- ApprovalBoundary/gate/freshness/checkpoint/retention/seedProbe/lifecycleGate/receiptWriteDenial/order: ${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.releaseExecutionIntentCaptureArtifactApprovalEntryCount}/${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.strictGateExecutionApprovalBoundaryEntryCount}/${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.freshnessExecutionApprovalBoundaryEntryCount}/${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.checkpointExecutionApprovalBoundaryEntryCount}/${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.retentionDryRunExecutionApprovalBoundaryEntryCount}/${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.seedCleanProbeExecutionApprovalBoundaryEntryCount}/${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.currentChatExplicitExecutionApprovalEntryCount}/${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.approvalPrerequisiteWriteDenialEntryCount}/${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Runner Execution Gate Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.contractDocPageReleaseRunnerExecutionGateSectionRegressionHash}`,
    `- Actual doc page release runner execution gate sections ok: ${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.sectionCount}`,
    `- ApprovalBoundary/gate/freshness/checkpoint/retention/seedProbe/lifecycleGate/receiptWriteDenial/order: ${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.releaseExecutionApprovalBoundaryArtifactGateEntryCount}/${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.strictGateRunnerExecutionGateEntryCount}/${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.freshnessRunnerExecutionGateEntryCount}/${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.checkpointRunnerExecutionGateEntryCount}/${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.retentionDryRunRunnerExecutionGateEntryCount}/${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.seedCleanProbeRunnerExecutionGateEntryCount}/${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.runnerLifecyclePreDispatchGateEntryCount}/${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.externalActionReceiptWriteDenialEntryCount}/${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseRunnerExecutionGateSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Dispatch Implementation Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.contractDocPageReleaseDispatchImplementationDenialSectionRegressionHash}`,
    `- Actual doc page release dispatch implementation denial sections ok: ${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.sectionCount}`,
    `- RunnerGate/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/writeAdapterDenial/order: ${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.releaseRunnerExecutionGateArtifactImplementationDenialEntryCount}/${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.strictGateDispatchImplementationDenialEntryCount}/${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.freshnessDispatchImplementationDenialEntryCount}/${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.checkpointDispatchImplementationDenialEntryCount}/${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.retentionDryRunDispatchImplementationDenialEntryCount}/${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.seedCleanProbeDispatchImplementationDenialEntryCount}/${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.dispatchImplementationPreconditionDenialEntryCount}/${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.writeAdapterExecutionDenialEntryCount}/${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseDispatchImplementationDenialSectionRegression.summary.blockerCount}`,
    '## Report Contract Doc Page Release Platform State Snapshot Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.contractDocPageReleasePlatformStateSnapshotDenialSectionRegressionHash}`,
    `- Actual doc page release platform-state snapshot denial sections ok: ${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.sectionCount}`,
    `- RunnerGate/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/writeAdapterDenial/order: ${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.releaseDispatchImplementationDenialArtifactSnapshotEntryCount}/${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.strictGatePlatformStateSnapshotDenialEntryCount}/${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.freshnessPlatformStateSnapshotDenialEntryCount}/${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.checkpointPlatformStateSnapshotDenialEntryCount}/${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.retentionDryRunPlatformStateSnapshotDenialEntryCount}/${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.seedCleanProbePlatformStateSnapshotDenialEntryCount}/${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.readOnlyPlatformStateSnapshotPreconditionDenialEntryCount}/${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.platformStateWriteReplayDenialEntryCount}/${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression.summary.blockerCount}`,
    '## Report Contract Doc Page Release Dry-Run Replay Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.contractDocPageReleaseDryRunReplayDenialSectionRegressionHash}`,
    `- Actual doc page release dry-run replay denial sections ok: ${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.sectionCount}`,
    `- PlatformState/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveReplayDenial/order: ${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.releasePlatformStateSnapshotDenialArtifactReplayEntryCount}/${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.strictGateDryRunReplayDenialEntryCount}/${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.freshnessDryRunReplayDenialEntryCount}/${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.checkpointDryRunReplayDenialEntryCount}/${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.retentionDryRunReplayDenialEntryCount}/${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.seedCleanProbeDryRunReplayDenialEntryCount}/${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.readOnlyDryRunReplayPreconditionDenialEntryCount}/${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.dryRunReplayLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseDryRunReplayDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Proof-Bundle Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.contractDocPageReleaseProofBundleDenialSectionRegressionHash}`,
    `- Actual doc page release proof-bundle denial sections ok: ${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.sectionCount}`,
    `- DryRunReplay/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.releaseDryRunReplayDenialArtifactProofBundleEntryCount}/${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.strictGateProofBundleDenialEntryCount}/${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.freshnessProofBundleDenialEntryCount}/${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.checkpointProofBundleDenialEntryCount}/${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.retentionProofBundleDenialEntryCount}/${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.seedCleanProbeProofBundleDenialEntryCount}/${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.readOnlyProofBundlePreconditionDenialEntryCount}/${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.proofBundleLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseProofBundleDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Ledger Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.contractDocPageReleaseLedgerDenialSectionRegressionHash}`,
    `- Actual doc page release ledger denial sections ok: ${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.sectionCount}`,
    `- ProofBundle/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.releaseProofBundleDenialArtifactLedgerEntryCount}/${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.strictGateLedgerDenialEntryCount}/${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.freshnessLedgerDenialEntryCount}/${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.checkpointLedgerDenialEntryCount}/${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.retentionLedgerDenialEntryCount}/${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.seedCleanProbeLedgerDenialEntryCount}/${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.readOnlyLedgerPreconditionDenialEntryCount}/${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.ledgerLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseLedgerDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Audit-Evidence Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.contractDocPageReleaseAuditEvidenceDenialSectionRegressionHash}`,
    `- Actual doc page release audit-evidence denial sections ok: ${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.sectionCount}`,
    `- Ledger/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.releaseLedgerDenialArtifactAuditEvidenceEntryCount}/${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.strictGateAuditEvidenceDenialEntryCount}/${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.freshnessAuditEvidenceDenialEntryCount}/${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.checkpointAuditEvidenceDenialEntryCount}/${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.retentionAuditEvidenceDenialEntryCount}/${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.seedCleanProbeAuditEvidenceDenialEntryCount}/${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.readOnlyAuditEvidencePreconditionDenialEntryCount}/${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.auditEvidenceLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseAuditEvidenceDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Receipt-Evidence Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.contractDocPageReleaseReceiptEvidenceDenialSectionRegressionHash}`,
    `- Actual doc page release receipt-evidence denial sections ok: ${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.sectionCount}`,
    `- AuditEvidence/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.releaseAuditEvidenceDenialArtifactReceiptEvidenceEntryCount}/${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.strictGateReceiptEvidenceDenialEntryCount}/${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.freshnessReceiptEvidenceDenialEntryCount}/${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.checkpointReceiptEvidenceDenialEntryCount}/${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.retentionReceiptEvidenceDenialEntryCount}/${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.seedCleanProbeReceiptEvidenceDenialEntryCount}/${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.readOnlyReceiptEvidencePreconditionDenialEntryCount}/${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.receiptEvidenceLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Post-Action Receipt Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.contractDocPageReleasePostActionReceiptDenialSectionRegressionHash}`,
    `- Actual doc page release post-action receipt denial sections ok: ${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.sectionCount}`,
    `- ReceiptEvidence/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.releaseReceiptEvidenceDenialArtifactPostActionReceiptEntryCount}/${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.strictGatePostActionReceiptDenialEntryCount}/${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.freshnessPostActionReceiptDenialEntryCount}/${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.checkpointPostActionReceiptDenialEntryCount}/${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.retentionPostActionReceiptDenialEntryCount}/${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.seedCleanProbePostActionReceiptDenialEntryCount}/${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.readOnlyPostActionReceiptPreconditionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.postActionReceiptLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleasePostActionReceiptDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Post-Action Audit Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.contractDocPageReleasePostActionAuditDenialSectionRegressionHash}`,
    `- Actual doc page release post-action audit denial sections ok: ${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.sectionCount}`,
    `- PostActionReceipt/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.releasePostActionReceiptDenialArtifactPostActionAuditEntryCount}/${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.strictGatePostActionAuditDenialEntryCount}/${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.freshnessPostActionAuditDenialEntryCount}/${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.checkpointPostActionAuditDenialEntryCount}/${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.retentionPostActionAuditDenialEntryCount}/${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.seedCleanProbePostActionAuditDenialEntryCount}/${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.readOnlyPostActionAuditPreconditionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.postActionAuditLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleasePostActionAuditDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Post-Action Reconciliation Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.contractDocPageReleasePostActionReconciliationDenialSectionRegressionHash}`,
    `- Actual doc page release post-action reconciliation denial sections ok: ${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.sectionCount}`,
    `- PostActionAudit/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.releasePostActionAuditDenialArtifactPostActionReconciliationEntryCount}/${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.strictGatePostActionReconciliationDenialEntryCount}/${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.freshnessPostActionReconciliationDenialEntryCount}/${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.checkpointPostActionReconciliationDenialEntryCount}/${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.retentionPostActionReconciliationDenialEntryCount}/${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.seedCleanProbePostActionReconciliationDenialEntryCount}/${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.readOnlyPostActionReconciliationPreconditionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.postActionReconciliationLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleasePostActionReconciliationDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Post-Action Settlement Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.contractDocPageReleasePostActionSettlementDenialSectionRegressionHash}`,
    `- Actual doc page release post-action settlement denial sections ok: ${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.sectionCount}`,
    `- PostActionReconciliation/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.releasePostActionReconciliationDenialArtifactPostActionSettlementEntryCount}/${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.strictGatePostActionSettlementDenialEntryCount}/${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.freshnessPostActionSettlementDenialEntryCount}/${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.checkpointPostActionSettlementDenialEntryCount}/${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.retentionPostActionSettlementDenialEntryCount}/${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.seedCleanProbePostActionSettlementDenialEntryCount}/${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.readOnlyPostActionSettlementPreconditionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.postActionSettlementLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleasePostActionSettlementDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Post-Action Acceptance Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.contractDocPageReleasePostActionAcceptanceDenialSectionRegressionHash}`,
    `- Actual doc page release post-action acceptance denial sections ok: ${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.sectionCount}`,
    `- PostActionSettlement/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.releasePostActionSettlementDenialArtifactPostActionAcceptanceEntryCount}/${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.strictGatePostActionAcceptanceDenialEntryCount}/${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.freshnessPostActionAcceptanceDenialEntryCount}/${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.checkpointPostActionAcceptanceDenialEntryCount}/${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.retentionPostActionAcceptanceDenialEntryCount}/${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.seedCleanProbePostActionAcceptanceDenialEntryCount}/${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.readOnlyPostActionAcceptancePreconditionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.postActionAcceptanceLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Post-Action Payment Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.contractDocPageReleasePostActionPaymentDenialSectionRegressionHash}`,
    `- Actual doc page release post-action payment denial sections ok: ${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.sectionCount}`,
    `- PostActionAcceptance/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.releasePostActionAcceptanceDenialArtifactPostActionPaymentEntryCount}/${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.strictGatePostActionPaymentDenialEntryCount}/${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.freshnessPostActionPaymentDenialEntryCount}/${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.checkpointPostActionPaymentDenialEntryCount}/${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.retentionPostActionPaymentDenialEntryCount}/${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.seedCleanProbePostActionPaymentDenialEntryCount}/${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.readOnlyPostActionPaymentPreconditionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.postActionPaymentLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleasePostActionPaymentDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Post-Action Deployment Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.contractDocPageReleasePostActionDeploymentDenialSectionRegressionHash}`,
    `- Actual doc page release post-action deployment denial sections ok: ${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.sectionCount}`,
    `- PostActionPayment/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.releasePostActionPaymentDenialArtifactPostActionDeploymentEntryCount}/${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.strictGatePostActionDeploymentDenialEntryCount}/${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.freshnessPostActionDeploymentDenialEntryCount}/${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.checkpointPostActionDeploymentDenialEntryCount}/${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.retentionPostActionDeploymentDenialEntryCount}/${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.seedCleanProbePostActionDeploymentDenialEntryCount}/${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.readOnlyPostActionDeploymentPreconditionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.postActionDeploymentLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleasePostActionDeploymentDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Post-Action Provider Spend Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.contractDocPageReleasePostActionProviderSpendDenialSectionRegressionHash}`,
    `- Actual doc page release post-action provider spend denial sections ok: ${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.sectionCount}`,
    `- PostActionDeployment/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.releasePostActionDeploymentDenialArtifactPostActionProviderSpendEntryCount}/${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.strictGatePostActionProviderSpendDenialEntryCount}/${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.freshnessPostActionProviderSpendDenialEntryCount}/${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.checkpointPostActionProviderSpendDenialEntryCount}/${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.retentionPostActionProviderSpendDenialEntryCount}/${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.seedCleanProbePostActionProviderSpendDenialEntryCount}/${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.readOnlyPostActionProviderSpendPreconditionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.postActionProviderSpendLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Post-Action State Transition Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.contractDocPageReleasePostActionStateTransitionDenialSectionRegressionHash}`,
    `- Actual doc page release post-action state transition denial sections ok: ${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.sectionCount}`,
    `- PostActionProviderSpend/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.releasePostActionProviderSpendDenialArtifactPostActionStateTransitionEntryCount}/${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.strictGatePostActionStateTransitionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.freshnessPostActionStateTransitionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.checkpointPostActionStateTransitionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.retentionPostActionStateTransitionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.seedCleanProbePostActionStateTransitionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.readOnlyPostActionStateTransitionPreconditionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.postActionStateTransitionLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Post-Action Queue Consumption Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.contractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionHash}`,
    `- Actual doc page release post-action queue consumption denial sections ok: ${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.sectionCount}`,
    `- PostActionStateTransition/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.releasePostActionStateTransitionDenialArtifactPostActionQueueConsumptionEntryCount}/${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.strictGatePostActionQueueConsumptionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.freshnessPostActionQueueConsumptionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.checkpointPostActionQueueConsumptionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.retentionPostActionQueueConsumptionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.seedCleanProbePostActionQueueConsumptionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.readOnlyPostActionQueueConsumptionPreconditionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.postActionQueueConsumptionLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Post-Action Background Runner Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.contractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionHash}`,
    `- Actual doc page release post-action background runner denial sections ok: ${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.sectionCount}`,
    `- PostActionQueueConsumption/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.releasePostActionQueueConsumptionDenialArtifactPostActionBackgroundRunnerEntryCount}/${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.strictGatePostActionBackgroundRunnerDenialEntryCount}/${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.freshnessPostActionBackgroundRunnerDenialEntryCount}/${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.checkpointPostActionBackgroundRunnerDenialEntryCount}/${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.retentionPostActionBackgroundRunnerDenialEntryCount}/${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.seedCleanProbePostActionBackgroundRunnerDenialEntryCount}/${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.readOnlyPostActionBackgroundRunnerPreconditionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.postActionBackgroundRunnerLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Post-Action Dispatch Completion Denial Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.contractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionHash}`,
    `- Actual doc page release post-action dispatch completion denial sections ok: ${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.sectionCount}`,
    `- PostActionBackgroundRunner/gate/freshness/checkpoint/retention/seedProbe/preconditionDenial/liveWriteDenial/order: ${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.releasePostActionBackgroundRunnerDenialArtifactPostActionDispatchCompletionEntryCount}/${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.strictGatePostActionDispatchCompletionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.freshnessPostActionDispatchCompletionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.checkpointPostActionDispatchCompletionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.retentionPostActionDispatchCompletionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.seedCleanProbePostActionDispatchCompletionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.readOnlyPostActionDispatchCompletionPreconditionDenialEntryCount}/${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.postActionDispatchCompletionLiveWriteDenialEntryCount}/${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression.summary.blockerCount}`,
    '',
    '## Report Manifest Drift Regression Fixture',
    `- Blockers: ${audit.reportContractDocPageCheckpointHashSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Bootstrap Seed Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageBootstrapSeedSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageBootstrapSeedSectionRegression.contractDocPageBootstrapSeedSectionRegressionHash}`,
    `- Actual doc page bootstrap seed sections ok: ${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.okContractCount}/${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.sectionCount}`,
    `- Allowed/break/clean/active/report/safety/order: ${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.allowedSeedFilesBindingCount}/${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.selfReferenceBreakBindingCount}/${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.finalCleanSeedBindingCount}/${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.activeSeedMarkerBindingCount}/${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.seedReportBindingCount}/${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.bootstrapSeedSafetyBoundaryCount}/${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageBootstrapSeedSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Clean Rerun Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageCleanRerunSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageCleanRerunSectionRegression.contractDocPageCleanRerunSectionRegressionHash}`,
    `- Actual doc page clean rerun sections ok: ${audit.reportContractDocPageCleanRerunSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageCleanRerunSectionRegression.summary.okContractCount}/${audit.reportContractDocPageCleanRerunSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageCleanRerunSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageCleanRerunSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageCleanRerunSectionRegression.summary.sectionCount}`,
    `- Strict/zero-seed/hash/tracked/closeout/safety/order: ${audit.reportContractDocPageCleanRerunSectionRegression.summary.cleanStrictGateRerunBindingCount}/${audit.reportContractDocPageCleanRerunSectionRegression.summary.zeroSeedWritesBindingCount}/${audit.reportContractDocPageCleanRerunSectionRegression.summary.stableGateHashBindingCount}/${audit.reportContractDocPageCleanRerunSectionRegression.summary.trackedReportIdempotenceBindingCount}/${audit.reportContractDocPageCleanRerunSectionRegression.summary.postRecoveryCloseoutOrderBindingCount}/${audit.reportContractDocPageCleanRerunSectionRegression.summary.cleanRerunSafetyBoundaryCount}/${audit.reportContractDocPageCleanRerunSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageCleanRerunSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageCleanRerunSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageCleanRerunSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Final Settlement Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageFinalSettlementSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageFinalSettlementSectionRegression.contractDocPageFinalSettlementSectionRegressionHash}`,
    `- Actual doc page final settlement sections ok: ${audit.reportContractDocPageFinalSettlementSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageFinalSettlementSectionRegression.summary.okContractCount}/${audit.reportContractDocPageFinalSettlementSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageFinalSettlementSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageFinalSettlementSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageFinalSettlementSectionRegression.summary.sectionCount}`,
    `- Gate/retention/freshness/checkpoint/seed/safety/order: ${audit.reportContractDocPageFinalSettlementSectionRegression.summary.finalStrictGateBindingCount}/${audit.reportContractDocPageFinalSettlementSectionRegression.summary.retentionDryRunBindingCount}/${audit.reportContractDocPageFinalSettlementSectionRegression.summary.freshnessGateHashBindingCount}/${audit.reportContractDocPageFinalSettlementSectionRegression.summary.checkpointFreshnessBindingCount}/${audit.reportContractDocPageFinalSettlementSectionRegression.summary.seedCleanSettlementBindingCount}/${audit.reportContractDocPageFinalSettlementSectionRegression.summary.finalSettlementSafetyBoundaryCount}/${audit.reportContractDocPageFinalSettlementSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageFinalSettlementSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageFinalSettlementSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageFinalSettlementSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Closeout Index Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageCloseoutIndexSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageCloseoutIndexSectionRegression.contractDocPageCloseoutIndexSectionRegressionHash}`,
    `- Actual doc page closeout index sections ok: ${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.okContractCount}/${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.sectionCount}`,
    `- Gate/retention/freshness-checkpoint/seed/scans/diff/order: ${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.strictGateIndexBindingCount}/${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.retentionDryRunIndexBindingCount}/${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.freshnessCheckpointIndexBindingCount}/${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.seedCleanIndexBindingCount}/${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.finalScansIndexBindingCount}/${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.diffCheckSafetyBindingCount}/${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageCloseoutIndexSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Closeout Evidence Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageCloseoutEvidenceSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageCloseoutEvidenceSectionRegression.contractDocPageCloseoutEvidenceSectionRegressionHash}`,
    `- Actual doc page closeout evidence sections ok: ${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.okContractCount}/${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.sectionCount}`,
    `- Index/gate/freshness/checkpoint/retentionSeed/diff/order: ${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.closeoutIndexArtifactEvidenceBindingCount}/${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.strictGateHashEvidenceBindingCount}/${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.freshnessHashEvidenceBindingCount}/${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.checkpointHashEvidenceBindingCount}/${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.retentionSeedEvidenceBindingCount}/${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.diffCheckNoGrantEvidenceBindingCount}/${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageCloseoutEvidenceSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Closeout Ledger Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageCloseoutLedgerSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageCloseoutLedgerSectionRegression.contractDocPageCloseoutLedgerSectionRegressionHash}`,
    `- Actual doc page closeout ledger sections ok: ${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.okContractCount}/${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.sectionCount}`,
    `- Command/evidenceHash/owner/recovery/noGrant/retention/order: ${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.commandLedgerBindingCount}/${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.evidenceHashLedgerBindingCount}/${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.ownerLedgerBindingCount}/${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.recoveryLedgerBindingCount}/${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.noGrantLedgerBindingCount}/${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.retentionLedgerBindingCount}/${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageCloseoutLedgerSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Closeout Retention Proof Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.contractDocPageCloseoutRetentionProofSectionRegressionHash}`,
    `- Actual doc page closeout retention proof sections ok: ${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.okContractCount}/${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.sectionCount}`,
    `- Retention/latest/seed/active/placeholderDiff/noGrant/order: ${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.retentionDryRunProofBindingCount}/${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.latestArtifactProtectionProofBindingCount}/${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.seedCleanProofBindingCount}/${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.activeSeedScanProofBindingCount}/${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.placeholderDiffProofBindingCount}/${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.noArchiveDeleteWriteGrantProofBindingCount}/${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageCloseoutRetentionProofSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Closeout Probe Bundle Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.contractDocPageCloseoutProbeBundleSectionRegressionHash}`,
    `- Actual doc page closeout probe bundle sections ok: ${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.okContractCount}/${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.sectionCount}`,
    `- Retention/freshness/checkpoint/seed/active/placeholder/diffNoGrant/order: ${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.retentionFieldBindingCount}/${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.freshnessFieldBindingCount}/${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.checkpointFieldBindingCount}/${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.seedCleanFieldBindingCount}/${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.activeSeedFieldBindingCount}/${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.placeholderFieldBindingCount}/${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.diffCheckNoGrantFieldBindingCount}/${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageCloseoutProbeBundleSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Closeout Signoff Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageCloseoutSignoffSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageCloseoutSignoffSectionRegression.contractDocPageCloseoutSignoffSectionRegressionHash}`,
    `- Actual doc page closeout signoff sections ok: ${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.okContractCount}/${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.sectionCount}`,
    `- ProbeBundle/gate/freshness/checkpoint/seed/scans/noGrant/order: ${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.probeBundleArtifactSignoffCount}/${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.strictGateHashSignoffCount}/${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.freshnessHashSignoffCount}/${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.checkpointHashSignoffCount}/${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.seedCleanDecisionSignoffCount}/${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.finalScansDiffSignoffCount}/${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.localOnlyNoGrantSignoffCount}/${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageCloseoutSignoffSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Closeout Release Manifest Section Regression Fixture',
    '',
    `- Status: ${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.contractDocPageCloseoutReleaseManifestSectionRegressionHash}`,
    `- Actual doc page closeout release manifest sections ok: ${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.okContractCount}/${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.sectionCount}`,
    `- Signoff/gate/freshness/checkpoint/seed/finalProbes/noGrant/order: ${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.signoffArtifactReleaseEntryCount}/${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.strictGateReleaseReadinessEntryCount}/${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.freshnessReleaseReadinessEntryCount}/${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.checkpointReleaseReadinessEntryCount}/${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.seedCleanReleaseReadinessEntryCount}/${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.finalProbesReleaseReadinessEntryCount}/${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.localOnlyNoGrantReleaseBoundaryEntryCount}/${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageCloseoutReleaseManifestSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Archive Index Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.contractDocPageReleaseArchiveIndexSectionRegressionHash}`,
    `- Actual doc page release archive index sections ok: ${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.sectionCount}`,
    `- ReleaseManifest/gate/freshness/checkpoint/retention/seedProbe/noGrant/order: ${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.releaseManifestArtifactArchiveEntryCount}/${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.strictGateArchiveEntryCount}/${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.freshnessArchiveEntryCount}/${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.checkpointArchiveEntryCount}/${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.retentionArchiveEntryCount}/${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.seedCleanProbeArchiveEntryCount}/${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.localOnlyNoGrantArchiveBoundaryEntryCount}/${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseArchiveIndexSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Handoff Ledger Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.contractDocPageReleaseHandoffLedgerSectionRegressionHash}`,
    `- Actual doc page release handoff ledger sections ok: ${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.sectionCount}`,
    `- ArchiveIndex/gate/freshness/checkpoint/retention/seedProbe/noGrant/order: ${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.releaseArchiveIndexArtifactHandoffEntryCount}/${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.strictGateHandoffEntryCount}/${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.freshnessHandoffEntryCount}/${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.checkpointHandoffEntryCount}/${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.retentionHandoffEntryCount}/${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.seedCleanProbeHandoffEntryCount}/${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.localOnlyNoGrantHandoffBoundaryEntryCount}/${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseHandoffLedgerSectionRegression.summary.blockerCount}`,
    '',
    '## Report Contract Doc Page Release Delivery Readiness Section Regression',
    '',
    `- Status: ${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.status}`,
    `- Hash: ${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.contractDocPageReleaseDeliveryReadinessSectionRegressionHash}`,
    `- Actual doc page release delivery readiness sections ok: ${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.actualOk}`,
    `- Contracts covered: ${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.okContractCount}/${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.contractCount}`,
    `- Unique docs paths: ${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.uniqueDocsPathCount}`,
    `- Docs/sections: ${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.docsFileCount}/${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.sectionCount}`,
    `- HandoffLedger/gate/freshness/checkpoint/retention/seedProbe/noGrant/order: ${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.releaseHandoffLedgerArtifactReadinessEntryCount}/${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.strictGateDeliveryReadinessEntryCount}/${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.freshnessDeliveryReadinessEntryCount}/${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.checkpointDeliveryReadinessEntryCount}/${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.retentionDeliveryReadinessEntryCount}/${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.seedCleanProbeDeliveryReadinessEntryCount}/${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.localOnlyNoGrantDeliveryBoundaryEntryCount}/${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.orderCount}`,
    `- Scenarios: ${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.passedScenarioCount}/${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportContractDocPageReleaseDeliveryReadinessSectionRegression.summary.blockerCount}`,
    '',
    '## Report Manifest Drift Regression Fixture',
    '',
    `- Status: ${audit.reportManifestDriftRegression.status}`,
    `- Hash: ${audit.reportManifestDriftRegression.manifestDriftRegressionHash}`,
    `- Actual drift ok: ${audit.reportManifestDriftRegression.summary.actualOk}`,
    `- Contracts: ${audit.reportManifestDriftRegression.summary.okContractCount}/${audit.reportManifestDriftRegression.summary.contractCount}`,
    `- Package scripts: ${audit.reportManifestDriftRegression.summary.packageScriptCount}/${audit.reportManifestDriftRegression.summary.contractCount}`,
    `- Freshness inventory: ${audit.reportManifestDriftRegression.summary.freshnessInventoryCount}/${audit.reportManifestDriftRegression.summary.contractCount}`,
    `- Tooling reports: ${audit.reportManifestDriftRegression.summary.toolingReportCount}/${audit.reportManifestDriftRegression.summary.contractCount}`,
    `- Checkpoint bindings: ${audit.reportManifestDriftRegression.summary.checkpointBindingCount}/${audit.reportManifestDriftRegression.summary.contractCount}`,
    `- Gate steps: ${audit.reportManifestDriftRegression.summary.gateStepBindingCount}/${audit.reportManifestDriftRegression.summary.expectedGateStepBindingCount}`,
    `- Stdout hash fields: ${audit.reportManifestDriftRegression.summary.stdoutHashFieldCount}/${audit.reportManifestDriftRegression.summary.contractCount}`,
    `- Stdout reportFiles: ${audit.reportManifestDriftRegression.summary.stdoutReportFilesCount}/${audit.reportManifestDriftRegression.summary.contractCount}`,
    `- Scenarios: ${audit.reportManifestDriftRegression.summary.passedScenarioCount}/${audit.reportManifestDriftRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportManifestDriftRegression.summary.blockerCount}`,
    '',
    '## Report Latest Recovery Regression Fixture',
    '',
    `- Status: ${audit.reportLatestRecoveryRegression.status}`,
    `- Hash: ${audit.reportLatestRecoveryRegression.latestRecoveryRegressionHash}`,
    `- Actual recovery ok: ${audit.reportLatestRecoveryRegression.summary.actualOk}`,
    `- Contaminated files: ${audit.reportLatestRecoveryRegression.summary.contaminatedFileCount}`,
    `- Contaminated schema blocked: ${audit.reportLatestRecoveryRegression.summary.contaminatedSchemaBlocked}`,
    `- Contaminated freshness blocked: ${audit.reportLatestRecoveryRegression.summary.contaminatedFreshnessBlocked}`,
    `- Contaminated tooling blocked: ${audit.reportLatestRecoveryRegression.summary.contaminatedToolingBlocked}`,
    `- Bootstrap schema ok: ${audit.reportLatestRecoveryRegression.summary.bootstrapSchemaOk}`,
    `- Bootstrap freshness ok: ${audit.reportLatestRecoveryRegression.summary.bootstrapFreshnessOk}`,
    `- Bootstrap tooling ok: ${audit.reportLatestRecoveryRegression.summary.bootstrapToolingOk}`,
    `- Final freshness ok: ${audit.reportLatestRecoveryRegression.summary.finalFreshnessOk}`,
    `- Scenarios: ${audit.reportLatestRecoveryRegression.summary.passedScenarioCount}/${audit.reportLatestRecoveryRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportLatestRecoveryRegression.summary.blockerCount}`,
    '',
    '## Report Bootstrap Seed Regression Fixture',
    '',
    `- Status: ${audit.reportBootstrapSeedRegression.status}`,
    `- Hash: ${audit.reportBootstrapSeedRegression.bootstrapSeedRegressionHash}`,
    `- Actual policy ok: ${audit.reportBootstrapSeedRegression.summary.actualOk}`,
    `- Allowed seeds: ${audit.reportBootstrapSeedRegression.summary.allowedSeedFileCount}`,
    `- Seed reports: ${audit.reportBootstrapSeedRegression.summary.seedReportCount}`,
    `- Final reports: ${audit.reportBootstrapSeedRegression.summary.finalReportCount}`,
    `- Final overwrites: ${audit.reportBootstrapSeedRegression.summary.finalReportOverwriteCount}`,
    `- Gate seed leaks: ${audit.reportBootstrapSeedRegression.summary.gateSummarySeedLeakCount}`,
    `- Final marker leaks: ${audit.reportBootstrapSeedRegression.summary.finalBootstrapMarkerLeakCount}`,
    `- Scenarios: ${audit.reportBootstrapSeedRegression.summary.passedScenarioCount}/${audit.reportBootstrapSeedRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportBootstrapSeedRegression.summary.blockerCount}`,
    '',
    '## Report Gate Clean Rerun Regression Fixture',
    '',
    `- Status: ${audit.reportGateCleanRerunRegression.status}`,
    `- Hash: ${audit.reportGateCleanRerunRegression.gateCleanRerunRegressionHash}`,
    `- Actual policy ok: ${audit.reportGateCleanRerunRegression.summary.actualOk}`,
    `- Dirty seed writes: ${audit.reportGateCleanRerunRegression.summary.dirtySeedWriteCount}`,
    `- Clean seed writes: ${audit.reportGateCleanRerunRegression.summary.cleanSeedWriteCount}`,
    `- Clean seed skips: ${audit.reportGateCleanRerunRegression.summary.cleanSeedSkipCount}`,
    `- Seed hash reuses: ${audit.reportGateCleanRerunRegression.summary.seedHashReuseCount}`,
    `- Gate seed leaks: ${audit.reportGateCleanRerunRegression.summary.gateSummarySeedLeakCount}`,
    `- Final marker leaks: ${audit.reportGateCleanRerunRegression.summary.finalBootstrapMarkerLeakCount}`,
    `- Scenarios: ${audit.reportGateCleanRerunRegression.summary.passedScenarioCount}/${audit.reportGateCleanRerunRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportGateCleanRerunRegression.summary.blockerCount}`,
    '',
    '## Report Clean Gate Idempotence Regression Fixture',
    '',
    `- Status: ${audit.reportCleanGateIdempotenceRegression.status}`,
    `- Hash: ${audit.reportCleanGateIdempotenceRegression.cleanGateIdempotenceRegressionHash}`,
    `- Actual policy ok: ${audit.reportCleanGateIdempotenceRegression.summary.actualOk}`,
    `- Tracked reports: ${audit.reportCleanGateIdempotenceRegression.summary.trackedReportCount}`,
    `- Seed writes: ${audit.reportCleanGateIdempotenceRegression.summary.seedWriteCount}`,
    `- Seed skips: ${audit.reportCleanGateIdempotenceRegression.summary.seedSkipCount}`,
    `- Gate summary hashes: ${audit.reportCleanGateIdempotenceRegression.summary.gateSummaryHashCount}`,
    `- Scenarios: ${audit.reportCleanGateIdempotenceRegression.summary.passedScenarioCount}/${audit.reportCleanGateIdempotenceRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportCleanGateIdempotenceRegression.summary.blockerCount}`,
    '',
    '## Report Final Settlement Regression Fixture',
    '',
    `- Status: ${audit.reportFinalSettlementRegression.status}`,
    `- Hash: ${audit.reportFinalSettlementRegression.finalSettlementRegressionHash}`,
    `- Actual policy ok: ${audit.reportFinalSettlementRegression.summary.actualOk}`,
    `- Settlement stages: ${audit.reportFinalSettlementRegression.summary.settlementStageCount}/${audit.reportFinalSettlementRegression.summary.expectedSettlementStageCount}`,
    `- Mapped writes after final gate: ${audit.reportFinalSettlementRegression.summary.mappedReportWriteAfterFinalGateCount}`,
    `- Final gate hash present: ${audit.reportFinalSettlementRegression.summary.finalGateHashPresent}`,
    `- Freshness gate hash matches: ${audit.reportFinalSettlementRegression.summary.finalFreshnessGateHashMatches}`,
    `- Checkpoint freshness hash matches: ${audit.reportFinalSettlementRegression.summary.checkpointFreshnessHashMatches}`,
    `- Seed writes: ${audit.reportFinalSettlementRegression.summary.seedWriteCount}`,
    `- Seed skips: ${audit.reportFinalSettlementRegression.summary.seedSkipCount}`,
    `- Latest report write integrity: ${audit.reportFinalSettlementRegression.summary.latestReportWriteIntegrityOk}`,
    `- Latest report hash/markdown binding: hash=${audit.reportFinalSettlementRegression.summary.latestReportHashMatches}, markdown=${audit.reportFinalSettlementRegression.summary.latestReportMarkdownBindingPresent}`,
    `- Scenarios: ${audit.reportFinalSettlementRegression.summary.passedScenarioCount}/${audit.reportFinalSettlementRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportFinalSettlementRegression.summary.blockerCount}`,
    '',
    '## Report Post-Final Drift Regression Fixture',
    '',
    `- Status: ${audit.reportPostFinalDriftRegression.status}`,
    `- Hash: ${audit.reportPostFinalDriftRegression.postFinalDriftRegressionHash}`,
    `- Actual policy ok: ${audit.reportPostFinalDriftRegression.summary.actualOk}`,
    `- Drift events: ${audit.reportPostFinalDriftRegression.summary.driftEventCount}`,
    `- Post-drift freshness blocked: ${audit.reportPostFinalDriftRegression.summary.postDriftFreshnessBlocked}`,
    `- Post-drift freshness mismatches: ${audit.reportPostFinalDriftRegression.summary.postDriftFreshnessGateHashMismatchCount}`,
    `- Post-drift checkpoint blocked: ${audit.reportPostFinalDriftRegression.summary.postDriftCheckpointBlocked}`,
    `- Recovery clean gate ok: ${audit.reportPostFinalDriftRegression.summary.recoveryCleanGateOk}`,
    `- Recovery freshness gate hash matches: ${audit.reportPostFinalDriftRegression.summary.recoveryFreshnessGateHashMatches}`,
    `- Recovery checkpoint freshness matches: ${audit.reportPostFinalDriftRegression.summary.recoveryCheckpointFreshnessMatches}`,
    `- Recovery seed writes: ${audit.reportPostFinalDriftRegression.summary.recoverySeedWriteCount}`,
    `- Recovery seed skips: ${audit.reportPostFinalDriftRegression.summary.recoverySeedSkipCount}`,
    `- Scenarios: ${audit.reportPostFinalDriftRegression.summary.passedScenarioCount}/${audit.reportPostFinalDriftRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportPostFinalDriftRegression.summary.blockerCount}`,
    '',
    '## Report Closeout Drift Classification Regression Fixture',
    '',
    `- Status: ${audit.reportCloseoutDriftClassificationRegression.status}`,
    `- Hash: ${audit.reportCloseoutDriftClassificationRegression.closeoutDriftClassificationRegressionHash}`,
    `- Actual policy ok: ${audit.reportCloseoutDriftClassificationRegression.summary.actualOk}`,
    `- Commands: ${audit.reportCloseoutDriftClassificationRegression.summary.commandCount}`,
    `- Clean closeout commands: ${audit.reportCloseoutDriftClassificationRegression.summary.cleanCloseoutCommandCount}`,
    `- Blocked gate-bound writers: ${audit.reportCloseoutDriftClassificationRegression.summary.blockedGateBoundWriterCount}`,
    `- Documented blocked writers: ${audit.reportCloseoutDriftClassificationRegression.summary.documentedBlockedWriterCount}`,
    `- Recovery-required blocked writers: ${audit.reportCloseoutDriftClassificationRegression.summary.recoveryRequiredBlockedWriterCount}`,
    `- Allowed read-only probes: ${audit.reportCloseoutDriftClassificationRegression.summary.allowedReadOnlyProbeCount}`,
    `- Allowed non-gate-bound writers: ${audit.reportCloseoutDriftClassificationRegression.summary.allowedNonGateBoundWriterCount}`,
    `- Clean seed writes allowed: ${audit.reportCloseoutDriftClassificationRegression.summary.cleanSeedWritesAllowed}`,
    `- Scenarios: ${audit.reportCloseoutDriftClassificationRegression.summary.passedScenarioCount}/${audit.reportCloseoutDriftClassificationRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportCloseoutDriftClassificationRegression.summary.blockerCount}`,
    '',
    '## Report Closeout Command Inventory Regression Fixture',
    '',
    `- Status: ${audit.reportCloseoutCommandInventoryRegression.status}`,
    `- Hash: ${audit.reportCloseoutCommandInventoryRegression.closeoutCommandInventoryRegressionHash}`,
    `- Actual inventory ok: ${audit.reportCloseoutCommandInventoryRegression.summary.actualOk}`,
    `- Classified commands: ${audit.reportCloseoutCommandInventoryRegression.summary.classifiedCommandCount}`,
    `- Classified scripts: ${audit.reportCloseoutCommandInventoryRegression.summary.classifiedScriptCount}`,
    `- Package closeout scripts: ${audit.reportCloseoutCommandInventoryRegression.summary.packageCloseoutScriptCount}`,
    `- Docs closeout scripts: ${audit.reportCloseoutCommandInventoryRegression.summary.docsCloseoutScriptCount}`,
    `- Guard scripts: ${audit.reportCloseoutCommandInventoryRegression.summary.guardScriptCount}`,
    `- Documented scripts: ${audit.reportCloseoutCommandInventoryRegression.summary.documentedClassifiedScriptCount}/${audit.reportCloseoutCommandInventoryRegression.summary.requiredDocumentedScriptCount}`,
    `- Unclassified closeout scripts: package=${audit.reportCloseoutCommandInventoryRegression.summary.unclassifiedPackageCloseoutScriptCount}, docs=${audit.reportCloseoutCommandInventoryRegression.summary.unclassifiedDocCloseoutScriptCount}`,
    `- Classification constants exported: ${audit.reportCloseoutCommandInventoryRegression.summary.classificationExportsPresent}`,
    `- Scenarios: ${audit.reportCloseoutCommandInventoryRegression.summary.passedScenarioCount}/${audit.reportCloseoutCommandInventoryRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportCloseoutCommandInventoryRegression.summary.blockerCount}`,
    '',
    '## Report Runner Contract Regression Fixture',
    '',
    `- Status: ${audit.reportRunnerContractRegression.status}`,
    `- Hash: ${audit.reportRunnerContractRegression.runnerContractRegressionHash}`,
    `- Actual contracts ok: ${audit.reportRunnerContractRegression.summary.actualOk}`,
    `- Contracts: ${audit.reportRunnerContractRegression.summary.okContractCount}/${audit.reportRunnerContractRegression.summary.contractCount}`,
    `- Gate steps: ${audit.reportRunnerContractRegression.summary.gateStepBindingCount}/${audit.reportRunnerContractRegression.summary.expectedGateStepBindingCount}`,
    `- Parse JSON gate steps: ${audit.reportRunnerContractRegression.summary.parseJsonGateStepCount}/${audit.reportRunnerContractRegression.summary.expectedGateStepBindingCount}`,
    `- Stdout hash fields: ${audit.reportRunnerContractRegression.summary.stdoutHashFieldCount}/${audit.reportRunnerContractRegression.summary.contractCount}`,
    `- Stdout reportFiles: ${audit.reportRunnerContractRegression.summary.stdoutReportFilesCount}/${audit.reportRunnerContractRegression.summary.contractCount}`,
    `- Scenarios: ${audit.reportRunnerContractRegression.summary.passedScenarioCount}/${audit.reportRunnerContractRegression.summary.scenarioCount}`,
    `- Blockers: ${audit.reportRunnerContractRegression.summary.blockerCount}`,
    '',
    '## Report Retention Regression Fixture',
    '',
    `- Status: ${audit.reportRetentionRegression.status}`,
    `- Hash: ${audit.reportRetentionRegression.retentionRegressionHash}`,
    `- Scenarios: ${audit.reportRetentionRegression.summary.passedScenarioCount}/${audit.reportRetentionRegression.summary.scenarioCount}`,
    `- Archive candidates observed: ${audit.reportRetentionRegression.summary.archiveCandidateCount}`,
    `- Protected keeps expected: ${audit.reportRetentionRegression.summary.protectedKeepCount}`,
    `- Blockers: ${audit.reportRetentionRegression.summary.blockerCount}`,
    '',
    '## Live Entrypoint Coverage',
    '',
    '| Channel | Action | Status | Lifecycle profile | Lifecycle status | Schema validation | Required phases missing | Entrypoint files | Bridge files |',
    '| --- | --- | --- | --- | --- | --- | --- | ---: | ---: |',
    ...audit.channels.flatMap((channel) => (channel.liveEntrypoints || []).map((entrypoint) => {
      const entryFileCount = entrypoint.files.filter((file) => file.role === 'live_entrypoint' && file.exists).length;
      const bridgeFileCount = entrypoint.files.filter((file) => file.role === 'core_bridge' && file.exists).length;
      return `| ${channel.label} | ${entrypoint.actionId} | ${entrypoint.status} | ${entrypoint.lifecycleProfileId} | ${entrypoint.lifecycleValidationStatus} | ${entrypoint.lifecycleSchemaUsage?.present === true} | ${entrypoint.missingRequiredPhases.join(', ') || 'none'} | ${entryFileCount} | ${bridgeFileCount} |`;
    })),
    '',
    '## Blockers',
    '',
    ...(audit.blockers.length
      ? audit.blockers.map((item) => `- ${item.code} (${item.owner}): ${item.notes}`)
      : ['- none']),
    '',
    '## Remediation',
    '',
    ...audit.remediation.map((item) => `- ${item.priority}: ${item.action} Reason: ${item.reason}`),
    '',
    '## Safety',
    '',
    '- Read-only audit only.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, or platform state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(audit) {
  return writeLatestReportPair({
    report: audit,
    fileId: 'integration-dependency-audit-latest.json',
    markdown: markdownFor(audit),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const audit = buildIntegrationDependencyAudit();
  const reportFiles = writeReports(audit);
  const summary = {
    ok: audit.ok,
    status: audit.status,
    auditHash: audit.auditHash,
    blockers: audit.blockers.map((item) => item.code),
    reportFiles: {
      json: relative(reportFiles.latestJson),
      md: relative(reportFiles.latestMd),
    },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (strict && !audit.ok) process.exitCode = 1;
}

if (isCliEntrypoint(import.meta.url)) main();
