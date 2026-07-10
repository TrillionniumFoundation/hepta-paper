import { digest } from './hash-utils.mjs';

export const REPORT_FRESHNESS_VERSION = 1;

export const REPORT_FRESHNESS_STABLE_MODULE_ID = 'report-freshness';

export const REPORT_FRESHNESS_REQUIRED_REPORTS = Object.freeze([
  Object.freeze({
    key: 'contractSchemas',
    fileId: 'contract-schemas-latest.json',
  }),
  Object.freeze({
    key: 'compatibilityPolicy',
    fileId: 'compatibility-export-policy-latest.json',
    gateSummaryHashKey: 'compatibilityPolicyHash',
  }),
  Object.freeze({
    key: 'readOnlyReportChain',
    fileId: 'read-only-report-chain-latest.json',
    gateSummaryHashKey: 'readOnlyReportChainHash',
  }),
  Object.freeze({
    key: 'packageSurface',
    fileId: 'package-surface-latest.json',
    gateSummaryHashKey: 'packageSurfaceHash',
  }),
  Object.freeze({
    key: 'channelImportAllowlist',
    fileId: 'channel-import-allowlist-latest.json',
    gateSummaryHashKey: 'channelImportAllowlistHash',
  }),
  Object.freeze({
    key: 'packageRootResolver',
    fileId: 'package-root-resolver-latest.json',
    gateSummaryHashKey: 'packageRootResolverHash',
  }),
  Object.freeze({
    key: 'packageRootImportMigration',
    fileId: 'package-root-import-migration-latest.json',
    gateSummaryHashKey: 'packageRootImportMigrationHash',
  }),
  Object.freeze({
    key: 'packageRootImportRegression',
    fileId: 'package-root-import-regression-latest.json',
    gateSummaryHashKey: 'packageRootImportRegressionHash',
  }),
  Object.freeze({
    key: 'packageRootSymbolManifest',
    fileId: 'package-root-symbol-manifest-latest.json',
    gateSummaryHashKey: 'packageRootSymbolManifestHash',
  }),
  Object.freeze({
    key: 'packageRootSymbolRegression',
    fileId: 'package-root-symbol-regression-latest.json',
    gateSummaryHashKey: 'packageRootSymbolRegressionHash',
  }),
  Object.freeze({
    key: 'packageRootSymbolMinimization',
    fileId: 'package-root-symbol-minimization-latest.json',
    gateSummaryHashKey: 'packageRootSymbolMinimizationHash',
  }),
  Object.freeze({
    key: 'integrationGateTooling',
    fileId: 'integration-gate-tooling-latest.json',
    gateSummaryHashKey: 'integrationGateToolingHash',
  }),
  Object.freeze({
    key: 'selftestLanes',
    fileId: 'selftest-lanes-latest.json',
    gateSummaryHashKey: 'selftestLanesHash',
  }),
  Object.freeze({
    key: 'integrationAudit',
    fileId: 'integration-dependency-audit-latest.json',
    gateSummaryHashKey: 'integrationAuditHash',
  }),
  Object.freeze({
    key: 'reportFreshnessRegression',
    fileId: 'report-freshness-regression-latest.json',
    gateSummaryHashKey: 'reportFreshnessRegressionHash',
  }),
  Object.freeze({
    key: 'integrationGateSequenceRegression',
    fileId: 'integration-gate-sequence-regression-latest.json',
    gateSummaryHashKey: 'integrationGateSequenceRegressionHash',
  }),
  Object.freeze({
    key: 'reportInventoryConsistency',
    fileId: 'report-inventory-consistency-latest.json',
    gateSummaryHashKey: 'reportInventoryConsistencyHash',
  }),
  Object.freeze({
    key: 'reportSchemaContract',
    fileId: 'report-schema-contract-latest.json',
    gateSummaryHashKey: 'reportSchemaContractHash',
  }),
  Object.freeze({
    key: 'reportLineageTopology',
    fileId: 'report-lineage-topology-latest.json',
    gateSummaryHashKey: 'reportLineageTopologyHash',
  }),
  Object.freeze({
    key: 'reportHashStabilityRegression',
    fileId: 'report-hash-stability-regression-latest.json',
    gateSummaryHashKey: 'reportHashStabilityRegressionHash',
  }),
  Object.freeze({
    key: 'reportOutputPairing',
    fileId: 'report-output-pairing-latest.json',
    gateSummaryHashKey: 'reportOutputPairingHash',
  }),
  Object.freeze({
    key: 'reportArtifactReproducibility',
    fileId: 'report-artifact-reproducibility-latest.json',
    gateSummaryHashKey: 'reportArtifactReproducibilityHash',
  }),
  Object.freeze({
    key: 'reportSelfReferenceBoundaryRegression',
    fileId: 'report-self-reference-boundary-regression-latest.json',
    gateSummaryHashKey: 'reportSelfReferenceBoundaryRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractManifest',
    fileId: 'report-contract-manifest-latest.json',
    gateSummaryHashKey: 'reportContractManifestHash',
  }),
  Object.freeze({
    key: 'reportContractRequiredCoverageRegression',
    fileId: 'report-contract-required-coverage-regression-latest.json',
    gateSummaryHashKey: 'reportContractRequiredCoverageRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocCoverageRegression',
    fileId: 'report-contract-doc-coverage-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocCoverageRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractSyntaxCoverageRegression',
    fileId: 'report-contract-syntax-coverage-regression-latest.json',
    gateSummaryHashKey: 'reportContractSyntaxCoverageRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractSourceDerivationRegression',
    fileId: 'report-contract-source-derivation-regression-latest.json',
    gateSummaryHashKey: 'reportContractSourceDerivationRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractSummaryKeyRegression',
    fileId: 'report-contract-summary-key-regression-latest.json',
    gateSummaryHashKey: 'reportContractSummaryKeyRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractAuditForwardingRegression',
    fileId: 'report-contract-audit-forwarding-regression-latest.json',
    gateSummaryHashKey: 'reportContractAuditForwardingRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractCheckpointBindingShapeRegression',
    fileId: 'report-contract-checkpoint-binding-shape-regression-latest.json',
    gateSummaryHashKey: 'reportContractCheckpointBindingShapeRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractGateSummaryShapeRegression',
    fileId: 'report-contract-gate-summary-shape-regression-latest.json',
    gateSummaryHashKey: 'reportContractGateSummaryShapeRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractExporterStdoutShapeRegression',
    fileId: 'report-contract-exporter-stdout-shape-regression-latest.json',
    gateSummaryHashKey: 'reportContractExporterStdoutShapeRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractSafetyFlagRegression',
    fileId: 'report-contract-safety-flag-regression-latest.json',
    gateSummaryHashKey: 'reportContractSafetyFlagRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractArtifactBindingRegression',
    fileId: 'report-contract-artifact-binding-regression-latest.json',
    gateSummaryHashKey: 'reportContractArtifactBindingRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocIndexAnchorRegression',
    fileId: 'report-contract-doc-index-anchor-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocIndexAnchorRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageLatestDetailRegression',
    fileId: 'report-contract-doc-page-latest-detail-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageLatestDetailRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageCommandSectionRegression',
    fileId: 'report-contract-doc-page-command-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageCommandSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageSafetySectionDetailRegression',
    fileId: 'report-contract-doc-page-safety-section-detail-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageSafetySectionDetailRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageStrictGateSectionRegression',
    fileId: 'report-contract-doc-page-strict-gate-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageStrictGateSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageOutputSectionRegression',
    fileId: 'report-contract-doc-page-output-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageOutputSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageCrossReportSectionRegression',
    fileId: 'report-contract-doc-page-cross-report-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageCrossReportSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageCloseoutSectionRegression',
    fileId: 'report-contract-doc-page-closeout-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageCloseoutSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPagePostGateWriterSectionRegression',
    fileId: 'report-contract-doc-page-post-gate-writer-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPagePostGateWriterSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageRetentionSectionRegression',
    fileId: 'report-contract-doc-page-retention-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageRetentionSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageFreshnessHashSectionRegression',
    fileId: 'report-contract-doc-page-freshness-hash-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageFreshnessHashSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageCheckpointHashSectionRegression',
    fileId: 'report-contract-doc-page-checkpoint-hash-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageCheckpointHashSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageBootstrapSeedSectionRegression',
    fileId: 'report-contract-doc-page-bootstrap-seed-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageBootstrapSeedSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageCleanRerunSectionRegression',
    fileId: 'report-contract-doc-page-clean-rerun-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageCleanRerunSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageFinalSettlementSectionRegression',
    fileId: 'report-contract-doc-page-final-settlement-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageFinalSettlementSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageCloseoutIndexSectionRegression',
    fileId: 'report-contract-doc-page-closeout-index-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageCloseoutIndexSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageCloseoutEvidenceSectionRegression',
    fileId: 'report-contract-doc-page-closeout-evidence-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageCloseoutEvidenceSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageCloseoutLedgerSectionRegression',
    fileId: 'report-contract-doc-page-closeout-ledger-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageCloseoutLedgerSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageCloseoutRetentionProofSectionRegression',
    fileId: 'report-contract-doc-page-closeout-retention-proof-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageCloseoutRetentionProofSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageCloseoutProbeBundleSectionRegression',
    fileId: 'report-contract-doc-page-closeout-probe-bundle-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageCloseoutProbeBundleSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageCloseoutSignoffSectionRegression',
    fileId: 'report-contract-doc-page-closeout-signoff-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageCloseoutSignoffSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageCloseoutReleaseManifestSectionRegression',
    fileId: 'report-contract-doc-page-closeout-release-manifest-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageCloseoutReleaseManifestSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseArchiveIndexSectionRegression',
    fileId: 'report-contract-doc-page-release-archive-index-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseArchiveIndexSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseHandoffLedgerSectionRegression',
    fileId: 'report-contract-doc-page-release-handoff-ledger-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseHandoffLedgerSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseDeliveryReadinessSectionRegression',
    fileId: 'report-contract-doc-page-release-delivery-readiness-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseDeliveryReadinessSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseExecutionDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-execution-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseExecutionDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseOperatorApprovalSectionRegression',
    fileId: 'report-contract-doc-page-release-operator-approval-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseOperatorApprovalSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseApprovalLedgerSectionRegression',
    fileId: 'report-contract-doc-page-release-approval-ledger-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseApprovalLedgerSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseActionQueueSectionRegression',
    fileId: 'report-contract-doc-page-release-action-queue-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseActionQueueSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseRunnerDispatchDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-runner-dispatch-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseLiveActionPreflightSectionRegression',
    fileId: 'report-contract-doc-page-release-live-action-preflight-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseLiveActionPreflightSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseExecutionIntentCaptureSectionRegression',
    fileId: 'report-contract-doc-page-release-execution-intent-capture-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseExecutionApprovalBoundarySectionRegression',
    fileId: 'report-contract-doc-page-release-execution-approval-boundary-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseRunnerExecutionGateSectionRegression',
    fileId: 'report-contract-doc-page-release-runner-execution-gate-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseRunnerExecutionGateSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseDispatchImplementationDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-dispatch-implementation-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-platform-state-snapshot-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseDryRunReplayDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-dry-run-replay-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseDryRunReplayDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseProofBundleDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-proof-bundle-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseProofBundleDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseLedgerDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-ledger-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseLedgerDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseAuditEvidenceDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-audit-evidence-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleaseReceiptEvidenceDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-receipt-evidence-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleasePostActionReceiptDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-post-action-receipt-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleasePostActionReceiptDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleasePostActionAuditDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-post-action-audit-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleasePostActionAuditDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleasePostActionReconciliationDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-post-action-reconciliation-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleasePostActionSettlementDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-post-action-settlement-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleasePostActionSettlementDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleasePostActionAcceptanceDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-post-action-acceptance-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleasePostActionPaymentDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-post-action-payment-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleasePostActionPaymentDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleasePostActionDeploymentDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-post-action-deployment-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleasePostActionProviderSpendDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-post-action-provider-spend-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleasePostActionStateTransitionDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-post-action-state-transition-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-post-action-background-runner-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegression',
    fileId: 'report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression-latest.json',
    gateSummaryHashKey: 'reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionHash',
  }),
  Object.freeze({
    key: 'reportManifestDriftRegression',
    fileId: 'report-manifest-drift-regression-latest.json',
    gateSummaryHashKey: 'reportManifestDriftRegressionHash',
  }),
  Object.freeze({
    key: 'reportLatestRecoveryRegression',
    fileId: 'report-latest-recovery-regression-latest.json',
    gateSummaryHashKey: 'reportLatestRecoveryRegressionHash',
  }),
  Object.freeze({
    key: 'reportBootstrapSeedRegression',
    fileId: 'report-bootstrap-seed-regression-latest.json',
    gateSummaryHashKey: 'reportBootstrapSeedRegressionHash',
  }),
  Object.freeze({
    key: 'reportGateCleanRerunRegression',
    fileId: 'report-gate-clean-rerun-regression-latest.json',
    gateSummaryHashKey: 'reportGateCleanRerunRegressionHash',
  }),
  Object.freeze({
    key: 'reportCleanGateIdempotenceRegression',
    fileId: 'report-clean-gate-idempotence-regression-latest.json',
    gateSummaryHashKey: 'reportCleanGateIdempotenceRegressionHash',
  }),
  Object.freeze({
    key: 'reportFinalSettlementRegression',
    fileId: 'report-final-settlement-regression-latest.json',
    gateSummaryHashKey: 'reportFinalSettlementRegressionHash',
  }),
  Object.freeze({
    key: 'reportPostFinalDriftRegression',
    fileId: 'report-post-final-drift-regression-latest.json',
    gateSummaryHashKey: 'reportPostFinalDriftRegressionHash',
  }),
  Object.freeze({
    key: 'reportCloseoutDriftClassificationRegression',
    fileId: 'report-closeout-drift-classification-regression-latest.json',
    gateSummaryHashKey: 'reportCloseoutDriftClassificationRegressionHash',
  }),
  Object.freeze({
    key: 'reportCloseoutCommandInventoryRegression',
    fileId: 'report-closeout-command-inventory-regression-latest.json',
    gateSummaryHashKey: 'reportCloseoutCommandInventoryRegressionHash',
  }),
  Object.freeze({
    key: 'reportRunnerContractRegression',
    fileId: 'report-runner-contract-regression-latest.json',
    gateSummaryHashKey: 'reportRunnerContractRegressionHash',
  }),
  Object.freeze({
    key: 'runtimeDryRunHarness',
    fileId: 'runtime-dry-run-harness-latest.json',
    gateSummaryHashKey: 'runtimeDryRunHarnessHash',
  }),
  Object.freeze({
    key: 'channelRunnerCoverageMatrix',
    fileId: 'channel-runner-coverage-matrix-latest.json',
    gateSummaryHashKey: 'channelRunnerCoverageMatrixHash',
  }),
  Object.freeze({
    key: 'postActionEvidenceMatrix',
    fileId: 'post-action-evidence-matrix-latest.json',
    gateSummaryHashKey: 'postActionEvidenceMatrixHash',
  }),
  Object.freeze({
    key: 'postActionAuditBundleMatrix',
    fileId: 'post-action-audit-bundle-matrix-latest.json',
    gateSummaryHashKey: 'postActionAuditBundleMatrixHash',
  }),
  Object.freeze({
    key: 'postActionAuditArchiveMatrix',
    fileId: 'post-action-audit-archive-matrix-latest.json',
    gateSummaryHashKey: 'postActionAuditArchiveMatrixHash',
  }),
  Object.freeze({
    key: 'postActionReplayGuardMatrix',
    fileId: 'post-action-replay-guard-matrix-latest.json',
    gateSummaryHashKey: 'postActionReplayGuardMatrixHash',
  }),
  Object.freeze({
    key: 'postActionDispatchEnvelopeMatrix',
    fileId: 'post-action-dispatch-envelope-matrix-latest.json',
    gateSummaryHashKey: 'postActionDispatchEnvelopeMatrixHash',
  }),
  Object.freeze({
    key: 'postActionDispatchCompletionMatrix',
    fileId: 'post-action-dispatch-completion-matrix-latest.json',
    gateSummaryHashKey: 'postActionDispatchCompletionMatrixHash',
  }),
  Object.freeze({
    key: 'postActionReconciliationMatrix',
    fileId: 'post-action-reconciliation-matrix-latest.json',
    gateSummaryHashKey: 'postActionReconciliationMatrixHash',
  }),
  Object.freeze({
    key: 'postActionRuntimeStatus',
    fileId: 'post-action-runtime-status-latest.json',
    gateSummaryHashKey: 'postActionRuntimeStatusHash',
  }),
  Object.freeze({
    key: 'reportRetentionRegression',
    fileId: 'report-retention-regression-latest.json',
    gateSummaryHashKey: 'reportRetentionRegressionHash',
  }),
  Object.freeze({
    key: 'reportRetention',
    fileId: 'report-retention-latest.json',
  }),
]);

export const REPORT_FRESHNESS_GATE_REPORT = Object.freeze({
  key: 'integrationGate',
  fileId: 'integration-dependency-gate-latest.json',
});

function compactBinding(fileId, binding = {}) {
  return {
    fileId,
    exists: binding.exists === true,
    ok: binding.ok === true,
    status: binding.status || null,
    hash: binding.hash || null,
    blockerCount: Number(binding.blockerCount || 0),
    generatedAt: binding.generatedAt || null,
    file: binding.file || null,
  };
}

function gateSummaryHash(gateReport = {}, hashKey) {
  if (!hashKey) return null;
  return gateReport?.summary?.[hashKey] || null;
}

function gateReportHashAliases(gateReport = null) {
  return {
    gateHash: gateReport?.gateHash || null,
    genericHash: gateReport?.hash || null,
  };
}

function reportRecord(spec, binding, gateReport) {
  const report = compactBinding(spec.fileId, binding);
  const expectedGateHash = gateSummaryHash(gateReport, spec.gateSummaryHashKey);
  const gateHashMatches = !expectedGateHash || report.hash === expectedGateHash;
  const blockers = [
    ...(!report.exists ? [{
      code: 'report_freshness_required_report_missing',
      fileId: spec.fileId,
      notes: `${spec.fileId} is missing.`,
    }] : []),
    ...(report.exists && !report.ok ? [{
      code: 'report_freshness_required_report_not_ok',
      fileId: spec.fileId,
      notes: `${spec.fileId} is not ok: ${report.status || 'unknown'}.`,
    }] : []),
    ...(report.exists && !report.hash ? [{
      code: 'report_freshness_required_report_hash_missing',
      fileId: spec.fileId,
      notes: `${spec.fileId} does not expose a stable report hash.`,
    }] : []),
    ...(expectedGateHash && report.hash && !gateHashMatches ? [{
      code: 'report_freshness_gate_hash_mismatch',
      fileId: spec.fileId,
      notes: `${spec.fileId} hash ${report.hash} does not match integration gate summary ${spec.gateSummaryHashKey}=${expectedGateHash}.`,
    }] : []),
  ];
  return {
    key: spec.key,
    fileId: spec.fileId,
    status: blockers.length ? 'blocked_report_freshness_report' : 'pass_report_freshness_report',
    ok: blockers.length === 0,
    hash: report.hash,
    expectedGateHash,
    gateSummaryHashKey: spec.gateSummaryHashKey || null,
    gateHashMatches,
    generatedAt: report.generatedAt,
    blockerCount: blockers.length,
    blockers,
  };
}

export function buildReportFreshnessReport({
  reportBindings = {},
  gateReport = null,
  includeGateReport = true,
  generatedAt = new Date().toISOString(),
} = {}) {
  const gateBinding = compactBinding(
    REPORT_FRESHNESS_GATE_REPORT.fileId,
    reportBindings[REPORT_FRESHNESS_GATE_REPORT.fileId],
  );
  const gateHashAliases = gateReportHashAliases(gateReport);
  const gateReportAvailable = gateBinding.exists && gateBinding.ok && Boolean(gateReport);
  const gateReportHashMatchesFile = !includeGateReport
    || (gateBinding.hash && gateHashAliases.gateHash && gateBinding.hash === gateHashAliases.gateHash);
  const reportRecords = REPORT_FRESHNESS_REQUIRED_REPORTS.map((spec) => reportRecord(
    spec,
    reportBindings[spec.fileId],
    includeGateReport && gateReportAvailable ? gateReport : null,
  ));
  const gateBlockers = includeGateReport ? [
    ...(!gateBinding.exists ? [{
      code: 'report_freshness_integration_gate_missing',
      fileId: REPORT_FRESHNESS_GATE_REPORT.fileId,
      notes: 'integration-dependency-gate-latest.json must exist for final report freshness verification.',
    }] : []),
    ...(gateBinding.exists && !gateBinding.ok ? [{
      code: 'report_freshness_integration_gate_not_ok',
      fileId: REPORT_FRESHNESS_GATE_REPORT.fileId,
      notes: `integration-dependency-gate-latest.json is not ok: ${gateBinding.status || 'unknown'}.`,
    }] : []),
    ...(gateBinding.exists && !gateBinding.hash ? [{
      code: 'report_freshness_integration_gate_hash_missing',
      fileId: REPORT_FRESHNESS_GATE_REPORT.fileId,
      notes: 'integration-dependency-gate-latest.json does not expose a stable gate hash.',
    }] : []),
    ...(gateBinding.exists && gateReport && !gateHashAliases.gateHash ? [{
      code: 'report_freshness_integration_gate_hash_alias_missing',
      fileId: REPORT_FRESHNESS_GATE_REPORT.fileId,
      notes: 'integration-dependency-gate-latest.json must preserve gateHash.',
    }] : []),
    ...(gateBinding.exists && gateReport && !gateHashAliases.genericHash ? [{
      code: 'report_freshness_integration_gate_generic_hash_missing',
      fileId: REPORT_FRESHNESS_GATE_REPORT.fileId,
      notes: 'integration-dependency-gate-latest.json must preserve generic hash.',
    }] : []),
    ...(gateBinding.exists && gateReport && gateHashAliases.gateHash && gateHashAliases.genericHash && gateHashAliases.gateHash !== gateHashAliases.genericHash ? [{
      code: 'report_freshness_integration_gate_hash_alias_mismatch',
      fileId: REPORT_FRESHNESS_GATE_REPORT.fileId,
      notes: `integration gate gateHash ${gateHashAliases.gateHash} does not match generic hash ${gateHashAliases.genericHash}.`,
    }] : []),
    ...(gateBinding.exists && gateReport && !gateReportHashMatchesFile ? [{
      code: 'report_freshness_integration_gate_file_hash_mismatch',
      fileId: REPORT_FRESHNESS_GATE_REPORT.fileId,
      notes: `integration gate binding hash ${gateBinding.hash} does not match report gateHash ${gateHashAliases.gateHash || 'null'}.`,
    }] : []),
  ] : [];
  const blockers = [
    ...gateBlockers,
    ...reportRecords.flatMap((record) => record.blockers),
  ];
  const gateComparableReports = reportRecords.filter((record) => record.expectedGateHash);
  const report = {
    version: REPORT_FRESHNESS_VERSION,
    kind: 'ReportFreshness',
    status: blockers.length ? 'blocked_report_freshness' : 'pass_report_freshness',
    ok: blockers.length === 0,
    generatedAt,
    includeGateReport,
    gate: {
      fileId: REPORT_FRESHNESS_GATE_REPORT.fileId,
      exists: gateBinding.exists,
      ok: gateBinding.ok,
      status: gateBinding.status,
      hash: gateBinding.hash,
      gateHash: gateHashAliases.gateHash,
      genericHash: gateHashAliases.genericHash,
      generatedAt: gateBinding.generatedAt,
      hashMatchesFile: gateReportHashMatchesFile,
    },
    reports: reportRecords,
    summary: {
      reportCount: reportRecords.length,
      okReportCount: reportRecords.filter((record) => record.ok).length,
      comparableGateReportCount: gateComparableReports.length,
      gateHashMatchCount: gateComparableReports.filter((record) => record.gateHashMatches).length,
      gateHashMismatchCount: gateComparableReports.filter((record) => !record.gateHashMatches).length,
      missingReportCount: reportRecords.filter((record) => record.blockers.some((item) => item.code === 'report_freshness_required_report_missing')).length,
      notOkReportCount: reportRecords.filter((record) => record.blockers.some((item) => item.code === 'report_freshness_required_report_not_ok')).length,
      missingHashCount: reportRecords.filter((record) => record.blockers.some((item) => item.code === 'report_freshness_required_report_hash_missing')).length,
      includeGateReport,
      gateReportOk: gateBinding.ok,
      gateReportHashMatchesFile,
      blockerCount: blockers.length,
    },
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      mutatesReportFiles: false,
      executesExternalAction: false,
      providerSpend: false,
      browserAutomation: false,
      upload: false,
      submit: false,
      messaging: false,
      payment: false,
      acceptance: false,
      deployment: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
    },
  };
  const freshnessHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    includeGateReport: report.includeGateReport,
    gate: report.gate,
    reports: report.reports.map((record) => ({
      key: record.key,
      fileId: record.fileId,
      status: record.status,
      ok: record.ok,
      hash: record.hash,
      expectedGateHash: record.expectedGateHash,
      gateSummaryHashKey: record.gateSummaryHashKey,
      gateHashMatches: record.gateHashMatches,
      blockers: record.blockers,
    })),
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    freshnessHash,
    hash: freshnessHash,
  };
}

export function summarizeReportFreshness(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_freshness',
    ok: report?.ok === true,
    freshnessHash: report?.freshnessHash || null,
    reportCount: report?.summary?.reportCount || 0,
    okReportCount: report?.summary?.okReportCount || 0,
    gateHashMismatchCount: report?.summary?.gateHashMismatchCount || 0,
    includeGateReport: report?.summary?.includeGateReport === true,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: true,
      readOnly: true,
      executesExternalAction: false,
    },
  };
}
