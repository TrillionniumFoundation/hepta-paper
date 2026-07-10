import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_DOC_PAGE_LATEST_DETAIL_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_LATEST_DETAIL_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-latest-detail-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_LATEST_DETAIL_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-latest-detail-regression';
export const REPORT_CONTRACT_DOC_PAGE_LATEST_DETAIL_REGRESSION_STEP_ID = 'report_contract_doc_page_latest_detail_regression_export';

const TARGET_CONTRACT_ID = 'report_contract_manifest';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_doc_page_latest_detail',
    label: 'A new manifest contract is added without docs page latest artifact detail',
    expectedBlockerCode: 'report_contract_doc_page_latest_detail_docs_missing',
    mutate(input) {
      input.manifest.push({
        contractId: 'report_future_doc_page_latest_detail',
        label: 'Report future doc page latest detail',
        scriptId: 'reports:future-doc-page-latest-detail',
        fileId: 'report-future-doc-page-latest-detail-latest.json',
      });
    },
  }),
  Object.freeze({
    scenarioId: 'doc_page_latest_json_missing',
    label: 'A contract docs page stops naming its own latest JSON artifact',
    expectedBlockerCode: 'report_contract_doc_page_latest_detail_json_missing',
    mutate(input) {
      const contract = targetContract(input);
      const docsPath = docsPathFor(contract, input.docPathOverrides);
      input.docsByPath[docsPath] = String(input.docsByPath[docsPath] || '')
        .replaceAll(`reports/${contract.fileId}`, `reports/missing-${contract.fileId}`)
        .replaceAll(contract.fileId, `missing-${contract.fileId}`);
    },
  }),
  Object.freeze({
    scenarioId: 'doc_page_latest_markdown_missing',
    label: 'A contract docs page stops naming its own latest Markdown artifact',
    expectedBlockerCode: 'report_contract_doc_page_latest_detail_markdown_missing',
    mutate(input) {
      const contract = targetContract(input);
      const docsPath = docsPathFor(contract, input.docPathOverrides);
      const mdFileId = markdownFileIdFor(contract.fileId);
      input.docsByPath[docsPath] = String(input.docsByPath[docsPath] || '')
        .replaceAll(`reports/${mdFileId}`, `reports/missing-${mdFileId}`)
        .replaceAll(mdFileId, `missing-${mdFileId}`);
    },
  }),
  Object.freeze({
    scenarioId: 'doc_page_latest_json_unqualified',
    label: 'A contract docs page keeps the latest JSON basename but loses the reports path',
    expectedBlockerCode: 'report_contract_doc_page_latest_detail_json_missing',
    mutate(input) {
      const contract = targetContract(input);
      const docsPath = docsPathFor(contract, input.docPathOverrides);
      input.docsByPath[docsPath] = String(input.docsByPath[docsPath] || '')
        .replaceAll(`reports/${contract.fileId}`, contract.fileId);
    },
  }),
  Object.freeze({
    scenarioId: 'doc_page_latest_markdown_unqualified',
    label: 'A contract docs page keeps the latest Markdown basename but loses the reports path',
    expectedBlockerCode: 'report_contract_doc_page_latest_detail_markdown_missing',
    mutate(input) {
      const contract = targetContract(input);
      const docsPath = docsPathFor(contract, input.docPathOverrides);
      const mdFileId = markdownFileIdFor(contract.fileId);
      input.docsByPath[docsPath] = String(input.docsByPath[docsPath] || '')
        .replaceAll(`reports/${mdFileId}`, mdFileId);
    },
  }),
  Object.freeze({
    scenarioId: 'doc_page_latest_wildcard_pair_only',
    label: 'A contract docs page collapses explicit latest files into a wildcard pair',
    expectedBlockerCode: 'report_contract_doc_page_latest_detail_json_missing',
    mutate(input) {
      const contract = targetContract(input);
      const docsPath = docsPathFor(contract, input.docPathOverrides);
      const pair = `reports/${latestPairIdFor(contract.fileId)}`;
      input.docsByPath[docsPath] = String(input.docsByPath[docsPath] || '')
        .replaceAll(`reports/${contract.fileId}`, pair)
        .replaceAll(`reports/${markdownFileIdFor(contract.fileId)}`, pair);
    },
  }),
  Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: 'report_contract_doc_page_latest_detail_docs_missing',
    mutate(input) {
      const docPathOverrides = { ...input.docPathOverrides };
      delete docPathOverrides.report_freshness_regression;
      input.docPathOverrides = docPathOverrides;
    },
  }),
]);

function blocker(code, notes, extra = {}) {
  return { code, notes, ...extra };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function markdownFileIdFor(fileId = '') {
  return String(fileId || '').replace(/\.json$/, '.md');
}

function latestPairIdFor(fileId = '') {
  return String(fileId || '').replace(/-latest\.json$/, '-latest.{json,md}');
}

function docsPathFor(contract = {}, overrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES) {
  if (overrides?.[contract.contractId]) return overrides[contract.contractId];
  return `docs/${String(contract.fileId || '').replace(/-latest\.json$/, '.md')}`;
}

function normalizeContract(contract = {}) {
  return {
    contractId: contract.contractId || null,
    label: contract.label || null,
    scriptId: contract.scriptId || null,
    fileId: contract.fileId || null,
  };
}

function targetContract(input = {}) {
  return input.manifest.find((contract) => contract.contractId === TARGET_CONTRACT_ID)
    || input.manifest[0];
}

function hasQualifiedLatest(text = '', fileId = '') {
  return String(text || '').includes(`reports/${fileId}`);
}

function analyzeContract(contract = {}, input = {}) {
  const docsPath = docsPathFor(contract, input.docPathOverrides);
  const docsExists = Object.hasOwn(input.docsByPath || {}, docsPath);
  const docsText = docsExists ? String(input.docsByPath[docsPath] || '') : '';
  const mdFileId = markdownFileIdFor(contract.fileId);
  const latestJsonPresent = docsExists && hasQualifiedLatest(docsText, contract.fileId);
  const latestMarkdownPresent = docsExists && hasQualifiedLatest(docsText, mdFileId);
  const blockers = [
    ...(docsExists ? [] : [blocker(
      'report_contract_doc_page_latest_detail_docs_missing',
      `${contract.contractId} docs file must exist at ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(latestJsonPresent ? [] : [blocker(
      'report_contract_doc_page_latest_detail_json_missing',
      `${docsPath} must explicitly name reports/${contract.fileId}.`,
      { contractId: contract.contractId, docsPath, fileId: contract.fileId },
    )]),
    ...(latestMarkdownPresent ? [] : [blocker(
      'report_contract_doc_page_latest_detail_markdown_missing',
      `${docsPath} must explicitly name reports/${mdFileId}.`,
      { contractId: contract.contractId, docsPath, mdFileId },
    )]),
  ];
  return {
    contractId: contract.contractId,
    label: contract.label,
    scriptId: contract.scriptId,
    fileId: contract.fileId,
    mdFileId,
    docsPath,
    status: blockers.length ? 'blocked_report_contract_doc_page_latest_detail_contract' : 'pass_report_contract_doc_page_latest_detail_contract',
    ok: blockers.length === 0,
    docsExists,
    latestJsonPresent,
    latestMarkdownPresent,
    blockerCount: blockers.length,
    blockers,
  };
}

function compactContract(contract = {}) {
  return {
    contractId: contract.contractId,
    scriptId: contract.scriptId,
    fileId: contract.fileId,
    mdFileId: contract.mdFileId,
    docsPath: contract.docsPath,
    status: contract.status,
    ok: contract.ok === true,
    docsExists: contract.docsExists === true,
    latestJsonPresent: contract.latestJsonPresent === true,
    latestMarkdownPresent: contract.latestMarkdownPresent === true,
    blockerCount: contract.blockerCount || 0,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      docsPath: item.docsPath || null,
      fileId: item.fileId || null,
      mdFileId: item.mdFileId || null,
    })),
  };
}

function analyzeDocPageLatestDetails(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract).map((contract) => analyzeContract(contract, input));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_doc_page_latest_detail_analysis' : 'pass_report_contract_doc_page_latest_detail_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    uniqueDocsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    latestJsonCount: contracts.filter((contract) => contract.latestJsonPresent).length,
    latestMarkdownCount: contracts.filter((contract) => contract.latestMarkdownPresent).length,
    contracts,
    blockers,
  };
}

function compactAnalysis(analysis = {}) {
  return {
    status: analysis.status || null,
    ok: analysis.ok === true,
    contractCount: analysis.contractCount || 0,
    okContractCount: analysis.okContractCount || 0,
    uniqueDocsPathCount: analysis.uniqueDocsPathCount || 0,
    docsFileCount: analysis.docsFileCount || 0,
    latestJsonCount: analysis.latestJsonCount || 0,
    latestMarkdownCount: analysis.latestMarkdownCount || 0,
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      docsPath: item.docsPath || null,
      fileId: item.fileId || null,
      mdFileId: item.mdFileId || null,
    })),
  };
}

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeDocPageLatestDetails(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_doc_page_latest_detail_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract docs page latest detail analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_doc_page_latest_detail_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_doc_page_latest_detail_scenario' : 'pass_report_contract_doc_page_latest_detail_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractDocPageLatestDetailRegressionInput({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} = {}) {
  return {
    manifest: manifest.map(normalizeContract),
    docsByPath: { ...(docsByPath || {}) },
    docPathOverrides: { ...(docPathOverrides || {}) },
  };
}

export function buildReportContractDocPageLatestDetailRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractDocPageLatestDetailRegressionInput({
    manifest,
    docsByPath,
    docPathOverrides,
  });
  const actual = analyzeDocPageLatestDetails(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_doc_page_latest_details',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_DOC_PAGE_LATEST_DETAIL_REGRESSION_VERSION,
    kind: 'ReportContractDocPageLatestDetailRegression',
    status: blockers.length ? 'blocked_report_contract_doc_page_latest_detail_regression' : 'pass_report_contract_doc_page_latest_detail_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_DOC_PAGE_LATEST_DETAIL_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_DOC_PAGE_LATEST_DETAIL_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docsPaths: uniqueSorted(baseInput.manifest.map((contract) => docsPathFor(contract, baseInput.docPathOverrides))),
      docPathOverrides: baseInput.docPathOverrides,
    },
    actual: {
      ...compactAnalysis(actual),
      contracts: actual.contracts.map(compactContract),
    },
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      contractCount: actual.contractCount,
      okContractCount: actual.okContractCount,
      uniqueDocsPathCount: actual.uniqueDocsPathCount,
      docsFileCount: actual.docsFileCount,
      latestJsonCount: actual.latestJsonCount,
      latestMarkdownCount: actual.latestMarkdownCount,
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
  const contractDocPageLatestDetailRegressionHash = digest({
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
      blockerCodes: scenario.blockers.map((item) => item.code),
    })),
    summary: report.summary,
    blockers: report.blockers.map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      scenarioId: item.scenarioId || null,
      docsPath: item.docsPath || null,
      fileId: item.fileId || null,
      mdFileId: item.mdFileId || null,
      source: item.source || null,
    })),
    safety: report.safety,
  });
  return {
    ...report,
    contractDocPageLatestDetailRegressionHash,
    hash: contractDocPageLatestDetailRegressionHash,
  };
}

export function summarizeReportContractDocPageLatestDetailRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractDocPageLatestDetailRegressionHash: report.contractDocPageLatestDetailRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    uniqueDocsPathCount: report.summary?.uniqueDocsPathCount ?? null,
    docsFileCount: report.summary?.docsFileCount ?? null,
    latestJsonCount: report.summary?.latestJsonCount ?? null,
    latestMarkdownCount: report.summary?.latestMarkdownCount ?? null,
    scenarioCount: report.summary?.scenarioCount ?? null,
    passedScenarioCount: report.summary?.passedScenarioCount ?? null,
    blockerCount: report.summary?.blockerCount ?? null,
    safety: report.safety || {},
  };
}
