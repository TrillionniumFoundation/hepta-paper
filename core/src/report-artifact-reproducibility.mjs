import { digest } from './hash-utils.mjs';
import { stableReportDigest } from './report-hash-stability-regression.mjs';
import { reportStableHash } from './report-schema-contract.mjs';

export const REPORT_ARTIFACT_REPRODUCIBILITY_VERSION = 1;

export const REPORT_ARTIFACT_REPRODUCIBILITY_REPORT_FILE_ID = 'report-artifact-reproducibility-latest.json';

export const REPORT_ARTIFACT_REPRODUCIBILITY_SCRIPT_ID = 'reports:artifact-reproducibility';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function isSha256(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value || ''));
}

function blocker(code, fileId, notes, extra = {}) {
  return { code, fileId, notes, ...extra };
}

function artifactProjection(fileId, report = {}) {
  const stableHash = reportStableHash(report);
  return {
    fileId,
    kind: report.kind || null,
    status: report.status || null,
    ok: report.ok === true,
    stableHash,
    canonicalReportDigest: stableReportDigest(report || {}),
  };
}

function artifactDigestFor(fileId, report = {}) {
  return digest(artifactProjection(fileId, report));
}

function compactRecord(record = {}) {
  const projection = artifactProjection(record.fileId, record.report || {});
  return {
    ...projection,
    stableHashValid: isSha256(projection.stableHash),
    artifactDigest: artifactDigestFor(record.fileId, record.report || {}),
  };
}

function aggregateArtifactDigest(records = []) {
  return digest(records.map((record) => ({
    fileId: record.fileId,
    artifactDigest: record.artifactDigest,
    stableHash: record.stableHash,
  })));
}

function checkpointHashFor(checkpointReports = {}, spec = {}) {
  const byKey = checkpointReports[spec.key];
  const byFileId = checkpointReports[spec.fileId];
  const row = byKey || byFileId;
  if (typeof row === 'string') return row;
  return row?.hash || null;
}

function comparableFreshnessSpecs(freshnessReports = [], expectedFileIds = []) {
  const expectedSet = new Set(expectedFileIds);
  return freshnessReports.filter((spec) => expectedSet.has(spec.fileId));
}

export function analyzeReportArtifactReproducibilityRecords({
  expectedFileIds = [],
  records = [],
  freshnessReports = [],
  gateSummaryHashes = {},
  checkpointReports = {},
  requireGateBindings = false,
  requireCheckpointBindings = false,
} = {}) {
  const expectedIds = uniqueSorted(expectedFileIds);
  const byFileId = Object.fromEntries(records.map((record) => [record.fileId, record]));
  const missingFileIds = expectedIds.filter((fileId) => !byFileId[fileId]);
  const actualRecords = expectedIds
    .filter((fileId) => byFileId[fileId])
    .map((fileId) => compactRecord(byFileId[fileId]));
  const actualHashByFileId = Object.fromEntries(actualRecords.map((record) => [record.fileId, record.stableHash]));
  const specs = comparableFreshnessSpecs(freshnessReports, expectedIds);
  const gateBindings = specs
    .filter((spec) => spec.gateSummaryHashKey)
    .map((spec) => {
      const actualHash = actualHashByFileId[spec.fileId] || null;
      const expectedGateHash = gateSummaryHashes[spec.gateSummaryHashKey] || null;
      return {
        key: spec.key,
        fileId: spec.fileId,
        gateSummaryHashKey: spec.gateSummaryHashKey,
        actualHash,
        expectedGateHash,
        comparable: Boolean(actualHash && expectedGateHash),
        matches: Boolean(actualHash && expectedGateHash && actualHash === expectedGateHash),
      };
    });
  const checkpointBindings = specs.map((spec) => {
    const actualHash = actualHashByFileId[spec.fileId] || null;
    const checkpointHash = checkpointHashFor(checkpointReports, spec);
    return {
      key: spec.key,
      fileId: spec.fileId,
      actualHash,
      checkpointHash,
      comparable: Boolean(actualHash && checkpointHash),
      matches: Boolean(actualHash && checkpointHash && actualHash === checkpointHash),
    };
  });
  const blockers = [
    ...missingFileIds.map((fileId) => blocker(
      'report_artifact_reproducibility_required_report_missing',
      fileId,
      `${fileId} is required for report artifact reproducibility but was not provided.`,
    )),
    ...actualRecords
      .filter((record) => !record.stableHash)
      .map((record) => blocker(
        'report_artifact_reproducibility_stable_hash_missing',
        record.fileId,
        `${record.fileId} must expose a stable hash before artifact reproducibility can compare outputs.`,
      )),
    ...actualRecords
      .filter((record) => record.stableHash && !record.stableHashValid)
      .map((record) => blocker(
        'report_artifact_reproducibility_stable_hash_invalid',
        record.fileId,
        `${record.fileId} stable hash is not a sha256 digest.`,
        { stableHash: record.stableHash },
      )),
    ...gateBindings
      .filter((binding) => requireGateBindings && !binding.expectedGateHash)
      .map((binding) => blocker(
        'report_artifact_reproducibility_gate_hash_binding_missing',
        binding.fileId,
        `${binding.gateSummaryHashKey} must exist in the integration gate summary when gate bindings are required.`,
        { gateSummaryHashKey: binding.gateSummaryHashKey },
      )),
    ...gateBindings
      .filter((binding) => requireGateBindings && binding.comparable && !binding.matches)
      .map((binding) => blocker(
        'report_artifact_reproducibility_gate_hash_binding_drift',
        binding.fileId,
        `${binding.fileId} stable hash does not match integration gate summary ${binding.gateSummaryHashKey}.`,
        { actualHash: binding.actualHash, expectedGateHash: binding.expectedGateHash },
      )),
    ...checkpointBindings
      .filter((binding) => requireCheckpointBindings && !binding.checkpointHash)
      .map((binding) => blocker(
        'report_artifact_reproducibility_checkpoint_hash_binding_missing',
        binding.fileId,
        `${binding.fileId} must have a checkpoint report hash binding when checkpoint bindings are required.`,
        { key: binding.key },
      )),
    ...checkpointBindings
      .filter((binding) => requireCheckpointBindings && binding.comparable && !binding.matches)
      .map((binding) => blocker(
        'report_artifact_reproducibility_checkpoint_hash_binding_drift',
        binding.fileId,
        `${binding.fileId} stable hash does not match the architecture checkpoint report binding.`,
        { actualHash: binding.actualHash, checkpointHash: binding.checkpointHash, key: binding.key },
      )),
  ];
  return {
    status: blockers.length ? 'blocked_report_artifact_reproducibility_analysis' : 'pass_report_artifact_reproducibility_analysis',
    ok: blockers.length === 0,
    expectedReportCount: expectedIds.length,
    analyzedReportCount: actualRecords.length,
    missingReportCount: missingFileIds.length,
    stableHashCount: actualRecords.filter((record) => record.stableHashValid).length,
    artifactDigestCount: actualRecords.filter((record) => isSha256(record.artifactDigest)).length,
    gateComparableBindingCount: gateBindings.filter((binding) => binding.comparable).length,
    gateBindingMatchCount: gateBindings.filter((binding) => binding.comparable && binding.matches).length,
    checkpointComparableBindingCount: checkpointBindings.filter((binding) => binding.comparable).length,
    checkpointBindingMatchCount: checkpointBindings.filter((binding) => binding.comparable && binding.matches).length,
    expectedFileIds: expectedIds,
    records: actualRecords,
    artifactInventoryHash: aggregateArtifactDigest(actualRecords),
    gateBindings,
    checkpointBindings,
    blockers,
  };
}

function syntheticReport({
  fileId,
  hashDigit,
  kind,
} = {}) {
  const hash = `sha256:${hashDigit.repeat(64)}`;
  return {
    fileId,
    report: {
      version: 1,
      kind,
      status: 'pass_synthetic_report_artifact',
      ok: true,
      generatedAt: '2026-01-01T00:00:00.000Z',
      reportFiles: {
        json: `reports/${fileId}`,
        md: `reports/${fileId.replace(/\.json$/, '.md')}`,
      },
      summary: {
        recordCount: 2,
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

function syntheticAnalysisInput() {
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
  const freshnessReports = [
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
  ];
  return {
    expectedFileIds: records.map((record) => record.fileId),
    records,
    freshnessReports,
    gateSummaryHashes: {
      alphaHash: records[0].report.hash,
      betaHash: records[1].report.hash,
    },
    checkpointReports: {
      alpha: { hash: records[0].report.hash },
      beta: { hash: records[1].report.hash },
    },
    requireGateBindings: true,
    requireCheckpointBindings: true,
  };
}

function reorderObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reorderObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([key, item]) => [key, reorderObjectKeys(item)]),
  );
}

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'generated_at_noise_same_artifact',
    label: 'Changing generatedAt must not change the report artifact digest',
    mode: 'digest',
    expectedSameDigest: true,
    expectedBlockerCode: 'report_artifact_reproducibility_generated_at_affects_digest',
    mutate(input) {
      input.records[0].report.generatedAt = '2026-12-31T23:59:59.999Z';
    },
  }),
  Object.freeze({
    scenarioId: 'output_path_noise_same_artifact',
    label: 'Changing report output paths must not change the report artifact digest',
    mode: 'digest',
    expectedSameDigest: true,
    expectedBlockerCode: 'report_artifact_reproducibility_output_path_affects_digest',
    mutate(input) {
      input.records[0].report.reportFiles = {
        json: 'reports/archive/alpha-latest.json',
        md: 'reports/archive/alpha-latest.md',
      };
      input.records[0].report.outputFiles = ['reports/archive/alpha-latest.json'];
    },
  }),
  Object.freeze({
    scenarioId: 'key_order_noise_same_artifact',
    label: 'Changing object key order must not change the report artifact digest',
    mode: 'digest',
    expectedSameDigest: true,
    expectedBlockerCode: 'report_artifact_reproducibility_key_order_affects_digest',
    mutate(input) {
      input.records = input.records.map((record) => ({
        ...record,
        report: reorderObjectKeys(record.report),
      }));
    },
  }),
  Object.freeze({
    scenarioId: 'summary_semantic_change_changes_artifact',
    label: 'Changing report summary semantics must change the artifact digest',
    mode: 'digest',
    expectedSameDigest: false,
    expectedBlockerCode: 'report_artifact_reproducibility_summary_change_not_hashed',
    mutate(input) {
      input.records[0].report.summary.recordCount += 1;
    },
  }),
  Object.freeze({
    scenarioId: 'gate_hash_binding_drift',
    label: 'Gate summary hash drift must be detected',
    mode: 'analysis',
    expectedBlockerCode: 'report_artifact_reproducibility_gate_hash_binding_drift',
    mutate(input) {
      input.gateSummaryHashes.alphaHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    },
  }),
  Object.freeze({
    scenarioId: 'checkpoint_hash_binding_drift',
    label: 'Architecture checkpoint report hash drift must be detected',
    mode: 'analysis',
    expectedBlockerCode: 'report_artifact_reproducibility_checkpoint_hash_binding_drift',
    mutate(input) {
      input.checkpointReports.alpha.hash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    },
  }),
]);

function compactAnalysis(analysis) {
  return {
    status: analysis.status,
    ok: analysis.ok === true,
    expectedReportCount: analysis.expectedReportCount,
    analyzedReportCount: analysis.analyzedReportCount,
    missingReportCount: analysis.missingReportCount,
    stableHashCount: analysis.stableHashCount,
    artifactDigestCount: analysis.artifactDigestCount,
    gateComparableBindingCount: analysis.gateComparableBindingCount,
    gateBindingMatchCount: analysis.gateBindingMatchCount,
    checkpointComparableBindingCount: analysis.checkpointComparableBindingCount,
    checkpointBindingMatchCount: analysis.checkpointBindingMatchCount,
    artifactInventoryHash: analysis.artifactInventoryHash,
    blockers: analysis.blockers.map((item) => ({
      code: item.code,
      fileId: item.fileId || null,
      key: item.key || null,
      gateSummaryHashKey: item.gateSummaryHashKey || null,
    })),
  };
}

function runScenario(scenario) {
  const input = syntheticAnalysisInput();
  const baseline = analyzeReportArtifactReproducibilityRecords(input);
  const mutatedInput = clone(input);
  scenario.mutate(mutatedInput);
  const mutated = analyzeReportArtifactReproducibilityRecords(mutatedInput);
  if (scenario.mode === 'digest') {
    const sameDigest = baseline.artifactInventoryHash === mutated.artifactInventoryHash;
    const ok = scenario.expectedSameDigest ? sameDigest : !sameDigest;
    return {
      scenarioId: scenario.scenarioId,
      label: scenario.label,
      status: ok ? 'pass_report_artifact_reproducibility_scenario' : 'blocked_report_artifact_reproducibility_scenario',
      ok,
      expectedBlockerCode: scenario.expectedBlockerCode,
      expectedSameDigest: scenario.expectedSameDigest,
      observed: {
        baselineDigest: baseline.artifactInventoryHash,
        mutatedDigest: mutated.artifactInventoryHash,
        sameDigest,
      },
      observedBlockerCodes: mutated.blockers.map((item) => item.code),
      blockers: ok ? [] : [blocker(
        scenario.expectedBlockerCode,
        null,
        `${scenario.scenarioId} expected sameDigest=${scenario.expectedSameDigest}, observed sameDigest=${sameDigest}.`,
      )],
    };
  }
  const observedBlockerCodes = mutated.blockers.map((item) => item.code);
  const ok = observedBlockerCodes.includes(scenario.expectedBlockerCode);
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: ok ? 'pass_report_artifact_reproducibility_scenario' : 'blocked_report_artifact_reproducibility_scenario',
    ok,
    expectedBlockerCode: scenario.expectedBlockerCode,
    expectedSameDigest: null,
    observed: {
      baselineDigest: baseline.artifactInventoryHash,
      mutatedDigest: mutated.artifactInventoryHash,
      sameDigest: baseline.artifactInventoryHash === mutated.artifactInventoryHash,
    },
    observedBlockerCodes,
    blockers: ok ? [] : [blocker(
      'report_artifact_reproducibility_expected_blocker_not_observed',
      null,
      `${scenario.scenarioId} did not observe ${scenario.expectedBlockerCode}.`,
      { scenarioId: scenario.scenarioId, observedBlockerCodes },
    )],
  };
}

export function buildReportArtifactReproducibilityReport({
  expectedFileIds = [],
  records = [],
  freshnessReports = [],
  gateSummaryHashes = {},
  checkpointReports = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const actual = analyzeReportArtifactReproducibilityRecords({
    expectedFileIds,
    records,
    freshnessReports,
    gateSummaryHashes,
    checkpointReports,
  });
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_reports',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_ARTIFACT_REPRODUCIBILITY_VERSION,
    kind: 'ReportArtifactReproducibility',
    status: blockers.length ? 'blocked_report_artifact_reproducibility' : 'pass_report_artifact_reproducibility',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_ARTIFACT_REPRODUCIBILITY_REPORT_FILE_ID,
    scriptId: REPORT_ARTIFACT_REPRODUCIBILITY_SCRIPT_ID,
    expectedFileIds: uniqueSorted(expectedFileIds),
    actual: compactAnalysis(actual),
    records: actual.records,
    gateBindings: actual.gateBindings,
    checkpointBindings: actual.checkpointBindings,
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      expectedReportCount: actual.expectedReportCount,
      analyzedReportCount: actual.analyzedReportCount,
      missingReportCount: actual.missingReportCount,
      stableHashCount: actual.stableHashCount,
      artifactDigestCount: actual.artifactDigestCount,
      artifactInventoryHash: actual.artifactInventoryHash,
      gateComparableBindingCount: actual.gateComparableBindingCount,
      gateBindingMatchCount: actual.gateBindingMatchCount,
      checkpointComparableBindingCount: actual.checkpointComparableBindingCount,
      checkpointBindingMatchCount: actual.checkpointBindingMatchCount,
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioCount: scenarios.length,
      passedScenarioCount: scenarios.filter((scenario) => scenario.ok).length,
      failedScenarioCount: scenarios.filter((scenario) => !scenario.ok).length,
      noiseScenarioCount: scenarios.filter((scenario) => scenario.expectedSameDigest === true).length,
      semanticScenarioCount: scenarios.filter((scenario) => scenario.expectedSameDigest === false).length,
      bindingScenarioCount: scenarios.filter((scenario) => scenario.expectedSameDigest == null).length,
      observedExpectedBlockerCount: scenarios.filter((scenario) => scenario.ok).length,
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
  const artifactReproducibilityHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    reportFileId: report.reportFileId,
    scriptId: report.scriptId,
    expectedFileIds: report.expectedFileIds,
    actual: report.actual,
    records: report.records,
    gateBindings: report.gateBindings,
    checkpointBindings: report.checkpointBindings,
    scenarios: report.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      status: scenario.status,
      ok: scenario.ok,
      expectedBlockerCode: scenario.expectedBlockerCode,
      expectedSameDigest: scenario.expectedSameDigest,
      observed: scenario.observed,
      observedBlockerCodes: scenario.observedBlockerCodes,
      blockers: scenario.blockers,
    })),
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    artifactReproducibilityHash,
    hash: artifactReproducibilityHash,
  };
}

export function summarizeReportArtifactReproducibilityReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_artifact_reproducibility',
    ok: report?.ok === true,
    artifactReproducibilityHash: report?.artifactReproducibilityHash || null,
    actualOk: report?.summary?.actualOk === true,
    expectedReportCount: report?.summary?.expectedReportCount || 0,
    artifactDigestCount: report?.summary?.artifactDigestCount || 0,
    gateBindingMatchCount: report?.summary?.gateBindingMatchCount || 0,
    checkpointBindingMatchCount: report?.summary?.checkpointBindingMatchCount || 0,
    passedScenarioCount: report?.summary?.passedScenarioCount || 0,
    scenarioCount: report?.summary?.scenarioCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: true,
      readOnly: true,
      syntheticFixtureOnly: true,
      sourceInspectionOnly: true,
      executesExternalAction: false,
    },
  };
}
