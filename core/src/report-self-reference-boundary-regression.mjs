import { digest } from './hash-utils.mjs';
import {
  analyzeReportArtifactReproducibilityRecords,
} from './report-artifact-reproducibility.mjs';
import {
  REPORT_FRESHNESS_GATE_REPORT,
  REPORT_FRESHNESS_REQUIRED_REPORTS,
  buildReportFreshnessReport,
} from './report-freshness.mjs';
import {
  extractIntegrationGateStepSpecs,
} from './integration-gate-sequence-regression.mjs';

export const REPORT_SELF_REFERENCE_BOUNDARY_REGRESSION_VERSION = 1;

export const REPORT_SELF_REFERENCE_BOUNDARY_REGRESSION_REPORT_FILE_ID = 'report-self-reference-boundary-regression-latest.json';

export const REPORT_SELF_REFERENCE_BOUNDARY_REGRESSION_SCRIPT_ID = 'reports:self-reference-boundary-regression';

const ZERO_HASH = `sha256:${'0'.repeat(64)}`;

function blocker(code, notes, extra = {}) {
  return { code, notes, ...extra };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function syntheticHash(hashDigit) {
  return `sha256:${hashDigit.repeat(64)}`;
}

function syntheticReport({ fileId, hashDigit, kind } = {}) {
  const hash = syntheticHash(hashDigit);
  return {
    fileId,
    report: {
      version: 1,
      kind,
      status: `pass_${kind.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`).replace(/^_/, '')}`,
      ok: true,
      generatedAt: '2026-01-01T00:00:00.000Z',
      reportFiles: {
        json: `reports/${fileId}`,
        md: `reports/${fileId.replace(/\.json$/, '.md')}`,
      },
      summary: {
        blockerCount: 0,
      },
      blockers: [],
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
        fetchesChannelState: false,
        appliesLocalStateTransition: false,
        grantsExecutionPermission: false,
      },
      reportHash: hash,
      hash,
    },
  };
}

function syntheticArtifactInput() {
  const records = [
    syntheticReport({
      fileId: 'alpha-latest.json',
      hashDigit: '1',
      kind: 'SyntheticAlphaReport',
    }),
    syntheticReport({
      fileId: 'beta-latest.json',
      hashDigit: '2',
      kind: 'SyntheticBetaReport',
    }),
  ];
  return {
    expectedFileIds: records.map((record) => record.fileId),
    records,
    freshnessReports: [
      {
        key: 'alpha',
        fileId: 'alpha-latest.json',
        gateSummaryHashKey: 'alphaHash',
      },
      {
        key: 'beta',
        fileId: 'beta-latest.json',
        gateSummaryHashKey: 'betaHash',
      },
    ],
    gateSummaryHashes: {
      alphaHash: ZERO_HASH,
      betaHash: records[1].report.hash,
    },
    checkpointReports: {
      alpha: { hash: ZERO_HASH },
      beta: { hash: records[1].report.hash },
    },
  };
}

function compactArtifactAnalysis(analysis = {}) {
  return {
    status: analysis.status || null,
    ok: analysis.ok === true,
    expectedReportCount: analysis.expectedReportCount || 0,
    analyzedReportCount: analysis.analyzedReportCount || 0,
    gateComparableBindingCount: analysis.gateComparableBindingCount || 0,
    gateBindingMatchCount: analysis.gateBindingMatchCount || 0,
    checkpointComparableBindingCount: analysis.checkpointComparableBindingCount || 0,
    checkpointBindingMatchCount: analysis.checkpointBindingMatchCount || 0,
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
      fileId: item.fileId || null,
      key: item.key || null,
      gateSummaryHashKey: item.gateSummaryHashKey || null,
    })),
  };
}

function reportBindingFor(spec, index) {
  const hash = spec.key === 'packageSurface' ? syntheticHash('1') : syntheticHash(String((index % 8) + 2));
  return {
    exists: true,
    ok: true,
    status: `pass_${spec.key}`,
    hash,
    blockerCount: 0,
    generatedAt: '2026-01-01T00:00:00.000Z',
    file: `reports/${spec.fileId}`,
  };
}

function syntheticFreshnessInput() {
  const reportBindings = {};
  REPORT_FRESHNESS_REQUIRED_REPORTS.forEach((spec, index) => {
    reportBindings[spec.fileId] = reportBindingFor(spec, index);
  });
  const gateHash = syntheticHash('9');
  reportBindings[REPORT_FRESHNESS_GATE_REPORT.fileId] = {
    exists: true,
    ok: true,
    status: 'pass_integration_dependency_gate',
    hash: gateHash,
    blockerCount: 0,
    generatedAt: '2026-01-01T00:00:00.000Z',
    file: `reports/${REPORT_FRESHNESS_GATE_REPORT.fileId}`,
  };
  const gateReport = {
    kind: 'IntegrationDependencyGate',
    status: 'pass_integration_dependency_gate',
    ok: true,
    gateHash,
    hash: gateHash,
    summary: {},
    blockers: [],
  };
  for (const spec of REPORT_FRESHNESS_REQUIRED_REPORTS) {
    if (spec.gateSummaryHashKey) {
      gateReport.summary[spec.gateSummaryHashKey] = reportBindings[spec.fileId].hash;
    }
  }
  gateReport.summary.packageSurfaceHash = ZERO_HASH;
  return { reportBindings, gateReport };
}

function freshnessBlockerCodes(report = {}) {
  return [
    ...(report.blockers || []).map((item) => item.code),
    ...(report.reports || []).flatMap((record) => (record.blockers || []).map((item) => item.code)),
  ];
}

function compactFreshnessReport(report = {}) {
  return {
    status: report.status || null,
    ok: report.ok === true,
    includeGateReport: report.includeGateReport === true,
    reportCount: report.summary?.reportCount || 0,
    okReportCount: report.summary?.okReportCount || 0,
    comparableGateReportCount: report.summary?.comparableGateReportCount || 0,
    gateHashMatchCount: report.summary?.gateHashMatchCount || 0,
    gateHashMismatchCount: report.summary?.gateHashMismatchCount || 0,
    blockerCodes: freshnessBlockerCodes(report),
  };
}

function buildBoundaryInput({
  gateSourceText = '',
  artifactSourceText = '',
  artifactExporterSourceText = '',
} = {}) {
  const artifactInput = syntheticArtifactInput();
  const artifactActual = analyzeReportArtifactReproducibilityRecords(artifactInput);
  const artifactRequired = analyzeReportArtifactReproducibilityRecords({
    ...artifactInput,
    requireGateBindings: true,
    requireCheckpointBindings: true,
  });
  const freshnessInput = syntheticFreshnessInput();
  const freshnessFinal = buildReportFreshnessReport({
    ...freshnessInput,
    includeGateReport: true,
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  const freshnessSkipGate = buildReportFreshnessReport({
    ...freshnessInput,
    includeGateReport: false,
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  return {
    artifactActual: compactArtifactAnalysis(artifactActual),
    artifactRequired: compactArtifactAnalysis(artifactRequired),
    freshnessFinal: compactFreshnessReport(freshnessFinal),
    freshnessSkipGate: compactFreshnessReport(freshnessSkipGate),
    gateSteps: extractIntegrationGateStepSpecs(gateSourceText),
    artifactSourceText,
    artifactExporterSourceText,
  };
}

function stepIndexById(steps = []) {
  return Object.fromEntries(steps.map((step, index) => [step.stepId, index]));
}

function stepArgs(steps = [], stepId) {
  return steps.find((step) => step.stepId === stepId)?.args || [];
}

function artifactRequiredBlockerCodes(artifactRequired = {}) {
  return (artifactRequired.blockers || []).map((item) => item.code);
}

export function analyzeReportSelfReferenceBoundary(input = {}) {
  const indexById = stepIndexById(input.gateSteps || []);
  const preToolingFreshnessArgs = stepArgs(input.gateSteps, 'report_freshness_export_pre_tooling');
  const finalFreshnessArgs = stepArgs(input.gateSteps, 'report_freshness_export');
  const requiredBlockerCodes = artifactRequiredBlockerCodes(input.artifactRequired);
  const finalFreshnessBlockerCodes = input.freshnessFinal?.blockerCodes || [];
  const skipFreshnessBlockerCodes = input.freshnessSkipGate?.blockerCodes || [];
  const artifactSourceText = String(input.artifactSourceText || '');
  const artifactExporterSourceText = String(input.artifactExporterSourceText || '');
  const gateDriftFilterRequirementGated = artifactSourceText.includes(
    '.filter((binding) => requireGateBindings && binding.comparable && !binding.matches)',
  );
  const checkpointDriftFilterRequirementGated = artifactSourceText.includes(
    '.filter((binding) => requireCheckpointBindings && binding.comparable && !binding.matches)',
  );
  const exporterRequiresLiveGateBinding = /requireGateBindings\s*:/.test(artifactExporterSourceText)
    || /requireCheckpointBindings\s*:/.test(artifactExporterSourceText);
  const artifactBeforePreToolingFreshness = indexById.report_artifact_reproducibility_export != null
    && indexById.report_freshness_export_pre_tooling != null
    && indexById.report_artifact_reproducibility_export < indexById.report_freshness_export_pre_tooling;
  const selfReferenceBeforePreToolingFreshness = indexById.report_self_reference_boundary_regression_export != null
    && indexById.report_freshness_export_pre_tooling != null
    && indexById.report_self_reference_boundary_regression_export < indexById.report_freshness_export_pre_tooling;
  const blockers = [
    ...(input.artifactActual?.ok === true ? [] : [blocker(
      'report_self_reference_artifact_actual_blocks_stale_binding',
      'Artifact reproducibility actual report must observe stale gate/checkpoint bindings without failing inside the integration gate.',
    )]),
    ...(input.artifactActual?.gateComparableBindingCount > input.artifactActual?.gateBindingMatchCount ? [] : [blocker(
      'report_self_reference_artifact_actual_gate_drift_not_observed',
      'Artifact reproducibility actual report must record a stale gate binding comparison while staying passable.',
    )]),
    ...(input.artifactActual?.checkpointComparableBindingCount > input.artifactActual?.checkpointBindingMatchCount ? [] : [blocker(
      'report_self_reference_artifact_actual_checkpoint_drift_not_observed',
      'Artifact reproducibility actual report must record a stale checkpoint binding comparison while staying passable.',
    )]),
    ...(input.artifactRequired?.ok === false
      && requiredBlockerCodes.includes('report_artifact_reproducibility_gate_hash_binding_drift')
      ? [] : [blocker(
        'report_self_reference_required_gate_binding_drift_not_blocked',
        'Artifact reproducibility required-binding mode must fail closed on gate summary hash drift.',
      )]),
    ...(input.artifactRequired?.ok === false
      && requiredBlockerCodes.includes('report_artifact_reproducibility_checkpoint_hash_binding_drift')
      ? [] : [blocker(
        'report_self_reference_required_checkpoint_binding_drift_not_blocked',
        'Artifact reproducibility required-binding mode must fail closed on architecture checkpoint hash drift.',
      )]),
    ...(input.freshnessFinal?.ok === false
      && finalFreshnessBlockerCodes.includes('report_freshness_gate_hash_mismatch')
      ? [] : [blocker(
        'report_self_reference_final_freshness_drift_not_blocked',
        'Final report freshness must hard-block latest report hash drift against the integration gate summary.',
      )]),
    ...(input.freshnessSkipGate?.ok === true
      && !skipFreshnessBlockerCodes.includes('report_freshness_gate_hash_mismatch')
      ? [] : [blocker(
        'report_self_reference_skip_gate_blocks_stale_binding',
        'Skip-gate report freshness must avoid gate-summary comparisons while running inside the integration gate.',
      )]),
    ...(preToolingFreshnessArgs.includes('--skip-gate') ? [] : [blocker(
      'report_self_reference_pre_tooling_freshness_missing_skip_gate',
      'Pre-tooling child freshness export must include --skip-gate.',
    )]),
    ...(finalFreshnessArgs.includes('--skip-gate') ? [] : [blocker(
      'report_self_reference_final_freshness_missing_skip_gate',
      'Final child freshness export inside the integration gate must include --skip-gate; outside-gate freshness owns live gate comparison.',
    )]),
    ...(artifactBeforePreToolingFreshness ? [] : [blocker(
      'report_self_reference_artifact_after_pre_tooling_freshness',
      'Artifact reproducibility must run before pre-tooling child freshness so freshness reads the refreshed artifact report.',
    )]),
    ...(selfReferenceBeforePreToolingFreshness ? [] : [blocker(
      'report_self_reference_boundary_after_pre_tooling_freshness',
      'Self-reference boundary regression must run before pre-tooling child freshness so freshness reads the refreshed boundary report.',
    )]),
    ...(gateDriftFilterRequirementGated ? [] : [blocker(
      'report_self_reference_artifact_gate_drift_not_requirement_gated',
      'Artifact reproducibility gate drift blockers must remain gated by requireGateBindings.',
    )]),
    ...(checkpointDriftFilterRequirementGated ? [] : [blocker(
      'report_self_reference_artifact_checkpoint_drift_not_requirement_gated',
      'Artifact reproducibility checkpoint drift blockers must remain gated by requireCheckpointBindings.',
    )]),
    ...(!exporterRequiresLiveGateBinding ? [] : [blocker(
      'report_self_reference_artifact_exporter_requires_live_binding',
      'The artifact reproducibility latest exporter must not require live gate/checkpoint binding agreement inside the gate.',
    )]),
  ];
  return {
    status: blockers.length ? 'blocked_report_self_reference_boundary_analysis' : 'pass_report_self_reference_boundary_analysis',
    ok: blockers.length === 0,
    artifactActualOk: input.artifactActual?.ok === true,
    artifactActualGateDriftObserved: input.artifactActual?.gateComparableBindingCount > input.artifactActual?.gateBindingMatchCount,
    artifactActualCheckpointDriftObserved: input.artifactActual?.checkpointComparableBindingCount > input.artifactActual?.checkpointBindingMatchCount,
    artifactRequiredGateDriftBlocked: requiredBlockerCodes.includes('report_artifact_reproducibility_gate_hash_binding_drift'),
    artifactRequiredCheckpointDriftBlocked: requiredBlockerCodes.includes('report_artifact_reproducibility_checkpoint_hash_binding_drift'),
    finalFreshnessDriftBlocked: finalFreshnessBlockerCodes.includes('report_freshness_gate_hash_mismatch'),
    skipGateFreshnessOk: input.freshnessSkipGate?.ok === true,
    preToolingFreshnessSkipGate: preToolingFreshnessArgs.includes('--skip-gate'),
    finalFreshnessSkipGate: finalFreshnessArgs.includes('--skip-gate'),
    artifactBeforePreToolingFreshness,
    selfReferenceBeforePreToolingFreshness,
    gateDriftFilterRequirementGated,
    checkpointDriftFilterRequirementGated,
    exporterRequiresLiveGateBinding,
    gateStepCount: (input.gateSteps || []).length,
    blockers,
  };
}

function compactBoundaryAnalysis(analysis = {}) {
  return {
    status: analysis.status || null,
    ok: analysis.ok === true,
    artifactActualOk: analysis.artifactActualOk === true,
    artifactActualGateDriftObserved: analysis.artifactActualGateDriftObserved === true,
    artifactActualCheckpointDriftObserved: analysis.artifactActualCheckpointDriftObserved === true,
    artifactRequiredGateDriftBlocked: analysis.artifactRequiredGateDriftBlocked === true,
    artifactRequiredCheckpointDriftBlocked: analysis.artifactRequiredCheckpointDriftBlocked === true,
    finalFreshnessDriftBlocked: analysis.finalFreshnessDriftBlocked === true,
    skipGateFreshnessOk: analysis.skipGateFreshnessOk === true,
    preToolingFreshnessSkipGate: analysis.preToolingFreshnessSkipGate === true,
    finalFreshnessSkipGate: analysis.finalFreshnessSkipGate === true,
    artifactBeforePreToolingFreshness: analysis.artifactBeforePreToolingFreshness === true,
    selfReferenceBeforePreToolingFreshness: analysis.selfReferenceBeforePreToolingFreshness === true,
    gateDriftFilterRequirementGated: analysis.gateDriftFilterRequirementGated === true,
    checkpointDriftFilterRequirementGated: analysis.checkpointDriftFilterRequirementGated === true,
    exporterRequiresLiveGateBinding: analysis.exporterRequiresLiveGateBinding === true,
    gateStepCount: analysis.gateStepCount || 0,
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
    })),
  };
}

function moveAfter(steps, movingStepId, anchorStepId) {
  const moving = steps.find((step) => step.stepId === movingStepId);
  if (!moving) return steps;
  const withoutMoving = steps.filter((step) => step.stepId !== movingStepId);
  const anchorIndex = withoutMoving.findIndex((step) => step.stepId === anchorStepId);
  if (anchorIndex < 0) return withoutMoving;
  return [
    ...withoutMoving.slice(0, anchorIndex + 1),
    moving,
    ...withoutMoving.slice(anchorIndex + 1),
  ];
}

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'artifact_actual_blocks_stale_binding',
    label: 'Artifact actual mode starts failing on stale gate/checkpoint bindings',
    expectedBlockerCode: 'report_self_reference_artifact_actual_blocks_stale_binding',
    mutate(input) {
      input.artifactActual = clone(input.artifactRequired);
    },
  }),
  Object.freeze({
    scenarioId: 'required_gate_binding_drift_not_blocked',
    label: 'Required-binding mode stops failing on gate hash drift',
    expectedBlockerCode: 'report_self_reference_required_gate_binding_drift_not_blocked',
    mutate(input) {
      input.artifactRequired = clone(input.artifactActual);
    },
  }),
  Object.freeze({
    scenarioId: 'final_freshness_drift_not_blocked',
    label: 'Final freshness stops blocking gate summary hash drift',
    expectedBlockerCode: 'report_self_reference_final_freshness_drift_not_blocked',
    mutate(input) {
      input.freshnessFinal = clone(input.freshnessSkipGate);
    },
  }),
  Object.freeze({
    scenarioId: 'skip_gate_freshness_blocks_stale_binding',
    label: 'Skip-gate freshness starts blocking stale gate summary hashes',
    expectedBlockerCode: 'report_self_reference_skip_gate_blocks_stale_binding',
    mutate(input) {
      input.freshnessSkipGate = clone(input.freshnessFinal);
    },
  }),
  Object.freeze({
    scenarioId: 'pre_tooling_freshness_missing_skip_gate',
    label: 'Pre-tooling freshness loses the skip-gate flag',
    expectedBlockerCode: 'report_self_reference_pre_tooling_freshness_missing_skip_gate',
    mutate(input) {
      input.gateSteps = input.gateSteps.map((step) => (step.stepId === 'report_freshness_export_pre_tooling'
        ? { ...step, args: step.args.filter((arg) => arg !== '--skip-gate') }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'self_reference_boundary_after_freshness',
    label: 'Self-reference boundary regression moves after pre-tooling freshness',
    expectedBlockerCode: 'report_self_reference_boundary_after_pre_tooling_freshness',
    mutate(input) {
      input.gateSteps = moveAfter(
        input.gateSteps,
        'report_self_reference_boundary_regression_export',
        'report_freshness_export_pre_tooling',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'artifact_after_freshness',
    label: 'Artifact reproducibility moves after pre-tooling freshness',
    expectedBlockerCode: 'report_self_reference_artifact_after_pre_tooling_freshness',
    mutate(input) {
      input.gateSteps = moveAfter(
        input.gateSteps,
        'report_artifact_reproducibility_export',
        'report_freshness_export_pre_tooling',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'artifact_gate_drift_not_requirement_gated',
    label: 'Artifact gate drift blocker stops being gated by requireGateBindings',
    expectedBlockerCode: 'report_self_reference_artifact_gate_drift_not_requirement_gated',
    mutate(input) {
      input.artifactSourceText = input.artifactSourceText.replace(
        '.filter((binding) => requireGateBindings && binding.comparable && !binding.matches)',
        '.filter((binding) => binding.comparable && !binding.matches)',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'artifact_exporter_requires_live_binding',
    label: 'Artifact latest exporter starts requiring live gate binding agreement',
    expectedBlockerCode: 'report_self_reference_artifact_exporter_requires_live_binding',
    mutate(input) {
      input.artifactExporterSourceText = `${input.artifactExporterSourceText}\nrequireGateBindings: true\n`;
    },
  }),
]);

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeReportSelfReferenceBoundary(input);
  const observedBlockerCodes = analysis.blockers.map((item) => item.code);
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_self_reference_boundary_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail the self-reference boundary analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_self_reference_boundary_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_self_reference_boundary_scenario' : 'pass_report_self_reference_boundary_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactBoundaryAnalysis(analysis),
    blockers,
  };
}

export function buildReportSelfReferenceBoundaryRegressionReport({
  gateSourceText = '',
  artifactSourceText = '',
  artifactExporterSourceText = '',
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildBoundaryInput({
    gateSourceText,
    artifactSourceText,
    artifactExporterSourceText,
  });
  const actual = analyzeReportSelfReferenceBoundary(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_boundary',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_SELF_REFERENCE_BOUNDARY_REGRESSION_VERSION,
    kind: 'ReportSelfReferenceBoundaryRegression',
    status: blockers.length ? 'blocked_report_self_reference_boundary_regression' : 'pass_report_self_reference_boundary_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_SELF_REFERENCE_BOUNDARY_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_SELF_REFERENCE_BOUNDARY_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
    },
    actual: compactBoundaryAnalysis(actual),
    artifact: {
      actual: baseInput.artifactActual,
      required: baseInput.artifactRequired,
    },
    freshness: {
      final: baseInput.freshnessFinal,
      skipGate: baseInput.freshnessSkipGate,
    },
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      gateStepCount: actual.gateStepCount,
      artifactActualOk: actual.artifactActualOk,
      artifactActualGateDriftObserved: actual.artifactActualGateDriftObserved,
      artifactActualCheckpointDriftObserved: actual.artifactActualCheckpointDriftObserved,
      artifactRequiredGateDriftBlocked: actual.artifactRequiredGateDriftBlocked,
      artifactRequiredCheckpointDriftBlocked: actual.artifactRequiredCheckpointDriftBlocked,
      finalFreshnessDriftBlocked: actual.finalFreshnessDriftBlocked,
      skipGateFreshnessOk: actual.skipGateFreshnessOk,
      preToolingFreshnessSkipGate: actual.preToolingFreshnessSkipGate,
      finalFreshnessSkipGate: actual.finalFreshnessSkipGate,
      artifactBeforePreToolingFreshness: actual.artifactBeforePreToolingFreshness,
      selfReferenceBeforePreToolingFreshness: actual.selfReferenceBeforePreToolingFreshness,
      gateDriftFilterRequirementGated: actual.gateDriftFilterRequirementGated,
      checkpointDriftFilterRequirementGated: actual.checkpointDriftFilterRequirementGated,
      exporterRequiresLiveGateBinding: actual.exporterRequiresLiveGateBinding,
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioCount: scenarios.length,
      passedScenarioCount: scenarios.filter((scenario) => scenario.ok).length,
      failedScenarioCount: scenarios.filter((scenario) => !scenario.ok).length,
      observedExpectedBlockerCount: scenarios.filter((scenario) => (
        scenario.observedBlockerCodes.includes(scenario.expectedBlockerCode)
      )).length,
      blockerCount: blockers.length,
    },
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      syntheticFixtureOnly: true,
      sourceInspectionOnly: true,
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
  const selfReferenceBoundaryRegressionHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    reportFileId: report.reportFileId,
    scriptId: report.scriptId,
    fixture: report.fixture,
    actual: report.actual,
    artifact: report.artifact,
    freshness: report.freshness,
    scenarios: report.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      status: scenario.status,
      ok: scenario.ok,
      expectedBlockerCode: scenario.expectedBlockerCode,
      observedBlockerCodes: scenario.observedBlockerCodes,
      analysis: scenario.analysis,
      blockers: scenario.blockers,
    })),
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    selfReferenceBoundaryRegressionHash,
    hash: selfReferenceBoundaryRegressionHash,
  };
}

export function summarizeReportSelfReferenceBoundaryRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_self_reference_boundary_regression',
    ok: report?.ok === true,
    selfReferenceBoundaryRegressionHash: report?.selfReferenceBoundaryRegressionHash || null,
    actualOk: report?.summary?.actualOk === true,
    gateStepCount: report?.summary?.gateStepCount || 0,
    artifactActualOk: report?.summary?.artifactActualOk === true,
    artifactRequiredGateDriftBlocked: report?.summary?.artifactRequiredGateDriftBlocked === true,
    artifactRequiredCheckpointDriftBlocked: report?.summary?.artifactRequiredCheckpointDriftBlocked === true,
    finalFreshnessDriftBlocked: report?.summary?.finalFreshnessDriftBlocked === true,
    skipGateFreshnessOk: report?.summary?.skipGateFreshnessOk === true,
    passedScenarioCount: report?.summary?.passedScenarioCount || 0,
    scenarioCount: report?.summary?.scenarioCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: report?.safety?.localOnly === true,
      readOnly: report?.safety?.readOnly === true,
      syntheticFixtureOnly: report?.safety?.syntheticFixtureOnly === true,
      sourceInspectionOnly: report?.safety?.sourceInspectionOnly === true,
      mutatesReportFiles: report?.safety?.mutatesReportFiles === true,
      executesExternalAction: report?.safety?.executesExternalAction === true,
    },
  };
}
