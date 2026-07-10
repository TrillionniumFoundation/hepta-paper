#!/usr/bin/env node
import { isCliEntrypoint } from './cli-entrypoint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { digest } from './hash-utils.mjs';
import { relativeToWorkspace, writeLatestReportPair } from './report-output-writer.mjs';

export const SELFTEST_LANES_VERSION = 1;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LANE_DEFINITIONS = Object.freeze([
  Object.freeze({
    laneId: 'public_api_and_contracts',
    label: 'Public API and contract schemas',
    keys: Object.freeze([
      'publicApiModules',
      'compatibilityExportPolicyEntries',
      'compatibilityExportPolicyHash',
      'integrationGateToolingReports',
      'integrationGateToolingHash',
      'channelImportAllowlistImports',
      'channelImportAllowlistStableRelativeImports',
      'channelImportAllowlistHash',
      'packageRootResolverReadyChannels',
      'packageRootResolverHash',
      'packageRootImportMigrationImports',
      'packageRootImportMigrationHash',
      'packageRootImportRegressionBadImports',
      'packageRootImportRegressionAllowlistBlockers',
      'packageRootImportRegressionHash',
      'packageRootSymbolManifestImportedSymbols',
      'packageRootSymbolManifestUnallowedSymbols',
      'packageRootSymbolManifestHash',
      'packageRootSymbolRegressionManifestBlockers',
      'packageRootSymbolRegressionBlockers',
      'packageRootSymbolRegressionHash',
      'packageRootSymbolMinimizationUnusedSymbols',
      'packageRootSymbolMinimizationExactCurrentSymbols',
      'packageRootSymbolMinimizationBlockers',
      'packageRootSymbolMinimizationHash',
      'reportFreshnessHash',
      'reportFreshnessRegressionScenarios',
      'reportFreshnessRegressionHash',
      'integrationGateSequenceRegressionScenarios',
      'integrationGateSequenceRegressionHash',
      'reportInventoryConsistencyScenarios',
      'reportInventoryConsistencyHash',
      'reportSchemaContractScenarios',
      'reportSchemaContractHash',
      'reportLineageTopologyScenarios',
      'reportLineageTopologyHash',
      'reportHashStabilityRegressionScenarios',
      'reportHashStabilityRegressionHash',
      'reportOutputPairingScenarios',
      'reportOutputPairingHash',
      'reportArtifactReproducibilityScenarios',
      'reportArtifactReproducibilityHash',
      'reportSelfReferenceBoundaryRegressionScenarios',
      'reportSelfReferenceBoundaryRegressionHash',
      'reportContractManifestScenarios',
      'reportContractManifestHash',
      'reportContractRequiredCoverageRegressionScenarios',
      'reportContractRequiredCoverageRegressionHash',
      'reportContractDocCoverageRegressionScenarios',
      'reportContractDocCoverageRegressionHash',
      'reportContractSyntaxCoverageRegressionScenarios',
      'reportContractSyntaxCoverageRegressionHash',
      'reportContractSourceDerivationRegressionScenarios',
      'reportContractSourceDerivationRegressionHash',
      'reportContractSummaryKeyRegressionScenarios',
      'reportContractSummaryKeyRegressionHash',
      'reportContractAuditForwardingRegressionScenarios',
      'reportContractAuditForwardingRegressionHash',
      'reportContractCheckpointBindingShapeRegressionScenarios',
      'reportContractCheckpointBindingShapeRegressionHash',
      'reportContractGateSummaryShapeRegressionScenarios',
      'reportContractGateSummaryShapeRegressionHash',
      'reportContractExporterStdoutShapeRegressionScenarios',
      'reportContractExporterStdoutShapeRegressionHash',
      'reportContractSafetyFlagRegressionScenarios',
      'reportContractSafetyFlagRegressionHash',
      'reportContractArtifactBindingRegressionScenarios',
      'reportContractArtifactBindingRegressionHash',
      'reportContractDocIndexAnchorRegressionScenarios',
      'reportContractDocIndexAnchorRegressionHash',
      'reportContractDocPageLatestDetailRegressionScenarios',
      'reportContractDocPageLatestDetailRegressionHash',
      'reportContractDocPageCommandSectionRegressionScenarios',
      'reportContractDocPageCommandSectionRegressionHash',
      'reportContractDocPageSafetySectionDetailRegressionScenarios',
      'reportContractDocPageSafetySectionDetailRegressionHash',
      'reportContractDocPageStrictGateSectionRegressionScenarios',
      'reportContractDocPageStrictGateSectionRegressionHash',
      'reportContractDocPageOutputSectionRegressionScenarios',
      'reportContractDocPageOutputSectionRegressionHash',
      'reportContractDocPageCrossReportSectionRegressionScenarios',
      'reportContractDocPageCrossReportSectionRegressionHash',
      'reportContractDocPageCloseoutSectionRegressionScenarios',
      'reportContractDocPageCloseoutSectionRegressionHash',
      'reportContractDocPagePostGateWriterSectionRegressionScenarios',
      'reportContractDocPagePostGateWriterSectionRegressionHash',
      'reportContractDocPageRetentionSectionRegressionScenarios',
      'reportContractDocPageRetentionSectionRegressionHash',
      'reportContractDocPageFreshnessHashSectionRegressionScenarios',
      'reportContractDocPageFreshnessHashSectionRegressionHash',
      'reportContractDocPageCheckpointHashSectionRegressionScenarios',
      'reportContractDocPageCheckpointHashSectionRegressionHash',
      'reportContractDocPageBootstrapSeedSectionRegressionScenarios',
      'reportContractDocPageBootstrapSeedSectionRegressionHash',
      'reportContractDocPageCleanRerunSectionRegressionScenarios',
      'reportContractDocPageCleanRerunSectionRegressionHash',
      'reportContractDocPageFinalSettlementSectionRegressionScenarios',
      'reportContractDocPageFinalSettlementSectionRegressionHash',
      'reportContractDocPageCloseoutIndexSectionRegressionScenarios',
      'reportContractDocPageCloseoutIndexSectionRegressionHash',
      'reportContractDocPageCloseoutEvidenceSectionRegressionScenarios',
      'reportContractDocPageCloseoutEvidenceSectionRegressionHash',
      'reportContractDocPageCloseoutLedgerSectionRegressionScenarios',
      'reportContractDocPageCloseoutLedgerSectionRegressionHash',
      'reportContractDocPageCloseoutRetentionProofSectionRegressionScenarios',
      'reportContractDocPageCloseoutRetentionProofSectionRegressionHash',
      'reportContractDocPageCloseoutProbeBundleSectionRegressionScenarios',
      'reportContractDocPageCloseoutProbeBundleSectionRegressionHash',
      'reportContractDocPageCloseoutSignoffSectionRegressionScenarios',
      'reportContractDocPageCloseoutSignoffSectionRegressionHash',
      'reportContractDocPageCloseoutReleaseManifestSectionRegressionScenarios',
      'reportContractDocPageCloseoutReleaseManifestSectionRegressionHash',
      'reportContractDocPageReleaseArchiveIndexSectionRegressionScenarios',
      'reportContractDocPageReleaseArchiveIndexSectionRegressionHash',
      'reportContractDocPageReleaseHandoffLedgerSectionRegressionScenarios',
      'reportContractDocPageReleaseHandoffLedgerSectionRegressionHash',
      'reportContractDocPageReleaseDeliveryReadinessSectionRegressionScenarios',
      'reportContractDocPageReleaseDeliveryReadinessSectionRegressionHash',
      'reportContractDocPageReleaseExecutionDenialSectionRegressionScenarios',
      'reportContractDocPageReleaseExecutionDenialSectionRegressionHash',
      'reportContractDocPageReleaseOperatorApprovalSectionRegressionScenarios',
      'reportContractDocPageReleaseOperatorApprovalSectionRegressionHash',
      'reportContractDocPageReleaseApprovalLedgerSectionRegressionScenarios',
      'reportContractDocPageReleaseApprovalLedgerSectionRegressionHash',
      'reportContractDocPageReleaseActionQueueSectionRegressionScenarios',
      'reportContractDocPageReleaseActionQueueSectionRegressionHash',
      'reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionScenarios',
      'reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionHash',
      'reportContractDocPageReleaseLiveActionPreflightSectionRegressionScenarios',
      'reportContractDocPageReleaseLiveActionPreflightSectionRegressionHash',
      'reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionScenarios',
      'reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionHash',
      'reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionScenarios',
      'reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionHash',
      'reportContractDocPageReleaseRunnerExecutionGateSectionRegressionScenarios',
      'reportContractDocPageReleaseRunnerExecutionGateSectionRegressionHash',
      'reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionScenarios',
      'reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionScenarios',
      'reportContractDocPageReleaseDryRunReplayDenialSectionRegressionScenarios',
      'reportContractDocPageReleaseProofBundleDenialSectionRegressionScenarios',
      'reportContractDocPageReleaseLedgerDenialSectionRegressionScenarios',
      'reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionScenarios',
      'reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionScenarios',
      'reportContractDocPageReleasePostActionReceiptDenialSectionRegressionScenarios',
      'reportContractDocPageReleasePostActionAuditDenialSectionRegressionScenarios',
      'reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionScenarios',
      'reportContractDocPageReleasePostActionSettlementDenialSectionRegressionScenarios',
      'reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionScenarios',
      'reportContractDocPageReleasePostActionPaymentDenialSectionRegressionScenarios',
      'reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionScenarios',
      'reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionScenarios',
      'reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionScenarios',
      'reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionScenarios',
      'reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionScenarios',
      'reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionScenarios',
      'reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionHash',
      'reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionHash',
      'reportContractDocPageReleaseDryRunReplayDenialSectionRegressionHash',
      'reportContractDocPageReleaseProofBundleDenialSectionRegressionHash',
      'reportContractDocPageReleaseLedgerDenialSectionRegressionHash',
      'reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionHash',
      'reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionHash',
      'reportContractDocPageReleasePostActionReceiptDenialSectionRegressionHash',
      'reportContractDocPageReleasePostActionAuditDenialSectionRegressionHash',
      'reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionHash',
      'reportContractDocPageReleasePostActionSettlementDenialSectionRegressionHash',
      'reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionHash',
      'reportContractDocPageReleasePostActionPaymentDenialSectionRegressionHash',
      'reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionHash',
      'reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionHash',
      'reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionHash',
      'reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionHash',
      'reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionHash',
      'reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionHash',
      'reportManifestDriftRegressionScenarios',
      'reportManifestDriftRegressionHash',
      'reportLatestRecoveryRegressionScenarios',
      'reportLatestRecoveryRegressionHash',
      'reportBootstrapSeedRegressionScenarios',
      'reportBootstrapSeedRegressionHash',
      'reportGateCleanRerunRegressionScenarios',
      'reportGateCleanRerunRegressionHash',
      'reportCleanGateIdempotenceRegressionScenarios',
      'reportCleanGateIdempotenceRegressionHash',
      'reportFinalSettlementRegressionScenarios',
      'reportFinalSettlementRegressionHash',
      'reportPostFinalDriftRegressionScenarios',
      'reportPostFinalDriftRegressionHash',
      'reportCloseoutDriftClassificationRegressionScenarios',
      'reportCloseoutDriftClassificationRegressionHash',
      'reportCloseoutCommandInventoryRegressionScenarios',
      'reportCloseoutCommandInventoryRegressionHash',
      'reportRunnerContractRegressionScenarios',
      'reportRunnerContractRegressionHash',
      'reportRetentionRegressionScenarios',
      'reportRetentionRegressionHash',
      'contractJsonSchemaCount',
      'contractJsonSchemaHash',
      'workflowProfiles',
      'externalApprovalGate',
    ]),
  }),
  Object.freeze({
    laneId: 'planning_reference_assets',
    label: 'Planning, reference, and buyer assets',
    keys: Object.freeze([
      'designReferenceSpecs',
      'legacyDesignReferenceConversions',
      'llmDesignReferenceResolutions',
      'designReferenceTaxonomySyncGate',
      'designReferenceTaxonomySyncCoreIndustries',
      'designReferenceTaxonomySyncZbjIndustries',
      'designReferenceTaxonomySyncRefpacks',
      'designReferenceTaxonomySyncGateHash',
      'buyerAssetPackages',
      'planOnlyFixtures',
      'migrationShimFixtures',
      'channelProductionPipelineStatus',
    ]),
  }),
  Object.freeze({
    laneId: 'execution_gate_manifest',
    label: 'Execution gates, approvals, state, and manifest',
    keys: Object.freeze([
      'executionGateFixtures',
      'approvalPacketFixtures',
      'stateMachineFixtures',
      'actionManifestFixtures',
    ]),
  }),
  Object.freeze({
    laneId: 'external_action_lifecycle',
    label: 'External action lifecycle, receipt, proof, ledger, and audit',
    keys: Object.freeze([
      'externalActionLifecycleSchemaNodes',
      'externalActionLifecycleSchemaProfiles',
      'externalActionLifecycleSchemaFixtures',
      'adapterRunnerFixtures',
      'adapterReceiptFixtures',
      'channelStateProofFixtures',
      'externalActionLedgerFixtures',
      'adapterReceiptInboxFixtures',
      'channelStateProofInboxFixtures',
      'receiptStateTransitionInboxFixtures',
      'externalActionAuditBundleFixtures',
      'externalActionAuditArchiveFixtures',
      'externalActionReplayGuardFixtures',
    ]),
  }),
  Object.freeze({
    laneId: 'dispatch_runner_handoff',
    label: 'Dispatch runner handoff and replay guard',
    keys: Object.freeze([
      'adapterRunnerCapabilityFixtures',
      'adapterRunnerRegistryFixtures',
      'adapterRunnerSelectionFixtures',
      'adapterDispatchEnvelopeFixtures',
      'adapterDispatchAssignmentFixtures',
      'dispatchReadinessOperatorHints',
      'adapterDispatchReadinessReportFixtures',
      'adapterRunnerSdkFixtures',
      'adapterDispatchReceiptInboxFixtures',
      'adapterDispatchChannelStateProofInboxFixtures',
      'adapterDispatchReceiptStateTransitionInboxFixtures',
      'externalActionLedgerDispatchInboxFixtures',
      'externalActionAuditBundleDispatchFixtures',
      'externalActionAuditArchiveDispatchFixtures',
      'externalActionReplayGuardDispatchFixtures',
      'dispatchReplayCycleInvariantFixtures',
    ]),
  }),
  Object.freeze({
    laneId: 'read_only_release_chain',
    label: 'Read-only dashboard, closeout, release, and archive chain',
    keys: Object.freeze([
      'readOnlyDashboardSnapshotStatus',
      'readOnlyReportChainStages',
      'readOnlyReportChainModules',
      'readOnlyReportChainHash',
      'readOnlySampleExportStatus',
      'readOnlySampleExportValidationStatus',
      'readOnlyCoreGateValidationStatus',
      'readOnlyCloseoutSummaryStatus',
      'readOnlyCloseoutValidationStatus',
      'readOnlyReleaseHealthStatus',
      'readOnlyReleaseHealthValidationStatus',
      'readOnlyReleaseVerificationStatus',
      'readOnlyReleaseVerificationValidationStatus',
      'readOnlyReleaseArchiveStatus',
      'readOnlyReleaseArchiveValidationStatus',
      'readOnlyReleaseArchiveCloseoutStatus',
    ]),
  }),
]);

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function looksPassing(key, value) {
  if (key === 'compatibilityExportPolicyEntries') return value === 0;
  if (key === 'channelImportAllowlistStableRelativeImports') return value === 0;
  if (key === 'packageRootImportMigrationImports') return value === 0;
  if (key === 'packageRootSymbolManifestUnallowedSymbols') return value === 0;
  if (key === 'packageRootSymbolRegressionBlockers') return value === 0;
  if (key === 'packageRootSymbolMinimizationBlockers') return value === 0;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value === 'boolean') return value === true;
  if (typeof value === 'string') {
    return /^(pass|ready|sha256:)/.test(value) || value === 'externalApprovalGate' || value === 'pass';
  }
  return Boolean(value);
}

function runSelftest() {
  const result = spawnSync(process.execPath, ['src/selftest.mjs'], {
    cwd: packageRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const outputJson = parseJson(result.stdout);
  return {
    ok: result.status === 0 && outputJson?.ok === true,
    exitCode: result.status,
    signal: result.signal || null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    outputJson,
    blockers: [
      ...(result.error ? [{ code: 'selftest_spawn_failed', notes: result.error.message }] : []),
      ...(result.status === 0 ? [] : [{ code: 'selftest_exit_nonzero', notes: `selftest exited with ${result.status}` }]),
      ...(outputJson ? [] : [{ code: 'selftest_json_invalid', notes: 'selftest stdout was not parseable JSON' }]),
      ...(outputJson && outputJson.ok !== true ? [{ code: 'selftest_reported_not_ok', notes: 'selftest reported ok=false' }] : []),
    ],
  };
}

function laneFromDefinition(definition, selftestJson = {}) {
  const metrics = Object.fromEntries(definition.keys.map((key) => [key, selftestJson[key]]));
  const missing = definition.keys.filter((key) => selftestJson[key] == null);
  const failed = definition.keys.filter((key) => selftestJson[key] != null && !looksPassing(key, selftestJson[key]));
  const blockers = [
    ...missing.map((key) => ({
      code: 'lane_metric_missing',
      key,
      notes: `${definition.laneId} is missing ${key}`,
    })),
    ...failed.map((key) => ({
      code: 'lane_metric_not_passing',
      key,
      notes: `${definition.laneId} metric ${key} is not passing`,
    })),
  ];
  return {
    laneId: definition.laneId,
    label: definition.label,
    status: blockers.length ? 'blocked_selftest_lane' : 'pass_selftest_lane',
    ok: blockers.length === 0,
    metricCount: definition.keys.length,
    metrics,
    blockers,
  };
}

export function buildSelftestLaneReport({ generatedAt = new Date().toISOString() } = {}) {
  const selftest = runSelftest();
  const lanes = LANE_DEFINITIONS.map((definition) => laneFromDefinition(definition, selftest.outputJson || {}));
  const blockers = [
    ...selftest.blockers,
    ...lanes.flatMap((lane) => lane.blockers.map((blocker) => ({
      code: `${lane.laneId}_${blocker.code}`,
      notes: blocker.notes,
    }))),
  ];
  const report = {
    version: SELFTEST_LANES_VERSION,
    kind: 'DesignProductionCoreSelftestLaneReport',
    status: blockers.length ? 'blocked_selftest_lanes' : 'pass_selftest_lanes',
    ok: blockers.length === 0,
    generatedAt,
    packageRoot: relativeToWorkspace(packageRoot),
    selftest: {
      ok: selftest.ok,
      exitCode: selftest.exitCode,
      signal: selftest.signal,
      outputHash: digest(selftest.outputJson || {}),
      stderr: selftest.stderr,
    },
    lanes,
    summary: {
      laneCount: lanes.length,
      passedLanes: lanes.filter((lane) => lane.ok).length,
      blockedLanes: lanes.filter((lane) => !lane.ok).length,
      publicApiModules: selftest.outputJson?.publicApiModules || null,
      contractJsonSchemaHash: selftest.outputJson?.contractJsonSchemaHash || null,
      lifecycleSchemaProfiles: selftest.outputJson?.externalActionLifecycleSchemaProfiles || null,
    },
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      executesExternalAction: false,
      providerSpend: false,
      browserAutomation: false,
      upload: false,
      submit: false,
      messaging: false,
      payment: false,
      acceptance: false,
      deployment: false,
    },
  };
  const reportHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    packageRoot: report.packageRoot,
    selftest: report.selftest,
    lanes: report.lanes,
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    reportHash,
    hash: reportHash,
  };
}

function markdownFor(report) {
  const lines = [
    '# Selftest Lanes',
    '',
    `Status: ${report.status}`,
    `Hash: ${report.reportHash}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- Lanes: ${report.summary.passedLanes}/${report.summary.laneCount} passed`,
    `- Public modules: ${report.summary.publicApiModules}`,
    `- Contract schema hash: ${report.summary.contractJsonSchemaHash}`,
    `- Lifecycle profiles: ${report.summary.lifecycleSchemaProfiles}`,
    '',
    '## Lanes',
    '',
    '| Lane | Status | Metrics |',
    '| --- | --- | ---: |',
    ...report.lanes.map((lane) => `| ${lane.laneId} | ${lane.status} | ${lane.metricCount} |`),
    '',
    '## Blockers',
    '',
    ...(report.blockers.length
      ? report.blockers.map((item) => `- ${item.code}: ${item.notes}`)
      : ['- none']),
    '',
    '## Safety',
    '',
    '- Local selftest reporting only.',
    '- No provider/model calls.',
    '- No browser automation, upload, submit, message, payment, acceptance, deployment, or platform state mutation.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function writeReports(report) {
  return writeLatestReportPair({
    report,
    fileId: 'selftest-lanes-latest.json',
    markdown: markdownFor(report),
  });
}

function main() {
  const strict = process.argv.includes('--strict');
  const report = buildSelftestLaneReport();
  const reportFiles = writeReports(report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    status: report.status,
    reportHash: report.reportHash,
    laneCount: report.summary.laneCount,
    passedLanes: report.summary.passedLanes,
    blockers: report.blockers.map((item) => item.code),
    reportFiles: {
      json: relativeToWorkspace(reportFiles.latestJson),
      md: relativeToWorkspace(reportFiles.latestMd),
    },
  }, null, 2)}\n`);
  if (strict && !report.ok) process.exitCode = 1;
}

if (isCliEntrypoint(import.meta.url)) main();
