import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';

export const REPORT_CONTRACT_DOC_COVERAGE_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_COVERAGE_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-coverage-regression-latest.json';
export const REPORT_CONTRACT_DOC_COVERAGE_REGRESSION_SCRIPT_ID = 'reports:contract-doc-coverage-regression';
export const REPORT_CONTRACT_DOC_COVERAGE_REGRESSION_STEP_ID = 'report_contract_doc_coverage_regression_export';

export const REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES = Object.freeze({
  integration_gate_sequence_regression: 'docs/integration-gate-sequence-regression.md',
  report_freshness_regression: 'docs/report-freshness.md',
});

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_docs',
    label: 'A new manifest contract is added without docs coverage',
    expectedBlockerCode: 'report_contract_doc_coverage_doc_missing',
    mutate(input) {
      return {
        ...input,
        manifest: [
          ...input.manifest,
          {
            contractId: 'report_uncovered_future_guard',
            label: 'Report uncovered future guard',
            scriptId: 'reports:uncovered-future-guard',
            exporterPath: 'src/export-report-uncovered-future-guard.mjs',
            stepIds: ['report_uncovered_future_guard_export'],
            fileId: 'report-uncovered-future-guard-latest.json',
            stdoutHashField: 'uncoveredFutureGuardHash',
            gateSummaryHashKey: 'reportUncoveredFutureGuardHash',
          },
        ],
      };
    },
  }),
  Object.freeze({
    scenarioId: 'docs_file_missing',
    label: 'A covered contract docs file disappears',
    expectedBlockerCode: 'report_contract_doc_coverage_doc_missing',
    mutate(input) {
      return {
        ...input,
        docsFileIds: input.docsFileIds.filter((fileId) => fileId !== 'docs/report-contract-manifest.md'),
      };
    },
  }),
  Object.freeze({
    scenarioId: 'main_readme_script_missing',
    label: 'The main README stops listing a contract command',
    expectedBlockerCode: 'report_contract_doc_coverage_readme_script_missing',
    mutate(input) {
      return {
        ...input,
        readmeText: input.readmeText
          .split('npm run reports:contract-manifest')
          .join('npm run reports:missing-contract-manifest'),
      };
    },
  }),
  Object.freeze({
    scenarioId: 'main_readme_doc_link_missing',
    label: 'The main README stops linking a contract docs page',
    expectedBlockerCode: 'report_contract_doc_coverage_readme_doc_missing',
    mutate(input) {
      return {
        ...input,
        readmeText: input.readmeText
          .split('docs/report-contract-manifest.md')
          .join('docs/missing-report-contract-manifest.md'),
      };
    },
  }),
  Object.freeze({
    scenarioId: 'reports_readme_file_missing',
    label: 'The reports README stops listing a latest report file',
    expectedBlockerCode: 'report_contract_doc_coverage_reports_readme_file_missing',
    mutate(input) {
      return {
        ...input,
        reportsReadmeText: input.reportsReadmeText
          .split('report-contract-manifest-latest.json')
          .join('missing-contract-manifest-report.json'),
      };
    },
  }),
  Object.freeze({
    scenarioId: 'special_doc_mapping_missing',
    label: 'A special contract docs mapping is removed',
    expectedBlockerCode: 'report_contract_doc_coverage_doc_missing',
    mutate(input) {
      const docPathOverrides = { ...input.docPathOverrides };
      delete docPathOverrides.report_freshness_regression;
      return {
        ...input,
        docPathOverrides,
      };
    },
  }),
]);

function normalizeManifest(manifest = []) {
  return manifest.map((contract) => ({
    ...contract,
    stepIds: Array.isArray(contract.stepIds) ? [...contract.stepIds] : [],
  }));
}

function docsPathFor(contract, overrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES) {
  if (overrides?.[contract.contractId]) return overrides[contract.contractId];
  return `docs/${String(contract.fileId || '').replace(/-latest\.json$/, '.md')}`;
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort();
}

function blocker(code, notes, contractId) {
  return { code, notes, contractId };
}

function analyzeDocCoverage(input = {}) {
  const manifest = normalizeManifest(input.manifest);
  const docsFileIds = new Set(input.docsFileIds || []);
  const readmeText = String(input.readmeText || '');
  const reportsReadmeText = String(input.reportsReadmeText || '');
  const docPathOverrides = input.docPathOverrides || REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES;
  const contracts = manifest.map((contract) => {
    const docsPath = docsPathFor(contract, docPathOverrides);
    const docsExists = docsFileIds.has(docsPath);
    const readmeScriptMention = readmeText.includes(`npm run ${contract.scriptId}`);
    const readmeDocsMention = readmeText.includes(docsPath);
    const reportsReadmeFileListed = reportsReadmeText.includes(contract.fileId);
    const blockers = [
      ...(docsExists ? [] : [blocker(
        'report_contract_doc_coverage_doc_missing',
        `${contract.contractId} docs path is missing: ${docsPath}.`,
        contract.contractId,
      )]),
      ...(readmeScriptMention ? [] : [blocker(
        'report_contract_doc_coverage_readme_script_missing',
        `${contract.contractId} script is missing from README.md: npm run ${contract.scriptId}.`,
        contract.contractId,
      )]),
      ...(readmeDocsMention ? [] : [blocker(
        'report_contract_doc_coverage_readme_doc_missing',
        `${contract.contractId} docs link is missing from README.md: ${docsPath}.`,
        contract.contractId,
      )]),
      ...(reportsReadmeFileListed ? [] : [blocker(
        'report_contract_doc_coverage_reports_readme_file_missing',
        `${contract.contractId} latest report is missing from reports/README.md: ${contract.fileId}.`,
        contract.contractId,
      )]),
    ];
    return {
      contractId: contract.contractId,
      scriptId: contract.scriptId,
      fileId: contract.fileId,
      docsPath,
      docsExists,
      readmeScriptMention,
      readmeDocsMention,
      reportsReadmeFileListed,
      status: blockers.length ? 'blocked_report_contract_doc_coverage_contract' : 'pass_report_contract_doc_coverage_contract',
      ok: blockers.length === 0,
      blockerCodes: blockers.map((item) => item.code),
      blockers,
    };
  });
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    ok: blockers.length === 0,
    status: blockers.length ? 'blocked_report_contract_doc_coverage_analysis' : 'pass_report_contract_doc_coverage_analysis',
    contractCount: contracts.length,
    coveredContractCount: contracts.filter((contract) => contract.ok).length,
    docsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    readmeScriptCount: contracts.filter((contract) => contract.readmeScriptMention).length,
    readmeDocsCount: contracts.filter((contract) => contract.readmeDocsMention).length,
    reportsReadmeFileCount: contracts.filter((contract) => contract.reportsReadmeFileListed).length,
    missingDocsContractIds: contracts.filter((contract) => !contract.docsExists).map((contract) => contract.contractId),
    missingReadmeScriptContractIds: contracts.filter((contract) => !contract.readmeScriptMention).map((contract) => contract.contractId),
    missingReadmeDocsContractIds: contracts.filter((contract) => !contract.readmeDocsMention).map((contract) => contract.contractId),
    missingReportsReadmeFileContractIds: contracts.filter((contract) => !contract.reportsReadmeFileListed).map((contract) => contract.contractId),
    contracts,
    blockers,
  };
}

function compactAnalysis(analysis = {}) {
  return {
    ok: analysis.ok === true,
    status: analysis.status,
    contractCount: analysis.contractCount || 0,
    coveredContractCount: analysis.coveredContractCount || 0,
    docsPathCount: analysis.docsPathCount || 0,
    docsFileCount: analysis.docsFileCount || 0,
    readmeScriptCount: analysis.readmeScriptCount || 0,
    readmeDocsCount: analysis.readmeDocsCount || 0,
    reportsReadmeFileCount: analysis.reportsReadmeFileCount || 0,
    missingDocsContractIds: analysis.missingDocsContractIds || [],
    missingReadmeScriptContractIds: analysis.missingReadmeScriptContractIds || [],
    missingReadmeDocsContractIds: analysis.missingReadmeDocsContractIds || [],
    missingReportsReadmeFileContractIds: analysis.missingReportsReadmeFileContractIds || [],
  };
}

function runScenario(scenario, baseInput) {
  const mutatedInput = scenario.mutate(baseInput);
  const analysis = analyzeDocCoverage(mutatedInput);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok ? [blocker(
      'report_contract_doc_coverage_scenario_unexpectedly_passed',
      `${scenario.scenarioId} should have produced ${scenario.expectedBlockerCode}.`,
      scenario.scenarioId,
    )] : []),
    ...(observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [] : [blocker(
      'report_contract_doc_coverage_expected_blocker_missing',
      `${scenario.scenarioId} did not produce ${scenario.expectedBlockerCode}.`,
      scenario.scenarioId,
    )]),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_doc_coverage_scenario' : 'pass_report_contract_doc_coverage_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractDocCoverageRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsFileIds = [],
  readmeText = '',
  reportsReadmeText = '',
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = {
    manifest: normalizeManifest(manifest),
    docsFileIds: [...docsFileIds],
    readmeText: String(readmeText || ''),
    reportsReadmeText: String(reportsReadmeText || ''),
    docPathOverrides: { ...docPathOverrides },
  };
  const actual = analyzeDocCoverage(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({ ...item, source: 'actual_doc_coverage' })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_DOC_COVERAGE_REGRESSION_VERSION,
    kind: 'ReportContractDocCoverageRegression',
    status: blockers.length ? 'blocked_report_contract_doc_coverage_regression' : 'pass_report_contract_doc_coverage_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_DOC_COVERAGE_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_DOC_COVERAGE_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      docPathOverrides,
    },
    actual: {
      ...compactAnalysis(actual),
      contracts: actual.contracts.map((contract) => ({
        contractId: contract.contractId,
        scriptId: contract.scriptId,
        fileId: contract.fileId,
        docsPath: contract.docsPath,
        docsExists: contract.docsExists,
        readmeScriptMention: contract.readmeScriptMention,
        readmeDocsMention: contract.readmeDocsMention,
        reportsReadmeFileListed: contract.reportsReadmeFileListed,
        status: contract.status,
        ok: contract.ok,
        blockerCodes: contract.blockerCodes,
      })),
    },
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      contractCount: actual.contractCount,
      coveredContractCount: actual.coveredContractCount,
      docsPathCount: actual.docsPathCount,
      docsFileCount: actual.docsFileCount,
      readmeScriptCount: actual.readmeScriptCount,
      readmeDocsCount: actual.readmeDocsCount,
      reportsReadmeFileCount: actual.reportsReadmeFileCount,
      missingDocsCount: actual.missingDocsContractIds.length,
      missingReadmeScriptCount: actual.missingReadmeScriptContractIds.length,
      missingReadmeDocsCount: actual.missingReadmeDocsContractIds.length,
      missingReportsReadmeFileCount: actual.missingReportsReadmeFileContractIds.length,
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
  const contractDocCoverageRegressionHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    reportFileId: report.reportFileId,
    scriptId: report.scriptId,
    fixture: report.fixture,
    actual: report.actual,
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
    contractDocCoverageRegressionHash,
    hash: contractDocCoverageRegressionHash,
  };
}

export function summarizeReportContractDocCoverageRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_contract_doc_coverage_regression',
    ok: report?.ok === true,
    contractDocCoverageRegressionHash: report?.contractDocCoverageRegressionHash || null,
    actualOk: report?.summary?.actualOk === true,
    contractCount: report?.summary?.contractCount || 0,
    coveredContractCount: report?.summary?.coveredContractCount || 0,
    docsFileCount: report?.summary?.docsFileCount || 0,
    readmeScriptCount: report?.summary?.readmeScriptCount || 0,
    readmeDocsCount: report?.summary?.readmeDocsCount || 0,
    reportsReadmeFileCount: report?.summary?.reportsReadmeFileCount || 0,
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
