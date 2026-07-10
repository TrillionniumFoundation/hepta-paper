import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_DOC_INDEX_ANCHOR_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_INDEX_ANCHOR_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-index-anchor-regression-latest.json';
export const REPORT_CONTRACT_DOC_INDEX_ANCHOR_REGRESSION_SCRIPT_ID = 'reports:contract-doc-index-anchor-regression';
export const REPORT_CONTRACT_DOC_INDEX_ANCHOR_REGRESSION_STEP_ID = 'report_contract_doc_index_anchor_regression_export';

const TARGET_CONTRACT_ID = 'report_contract_manifest';

export const REPORT_CONTRACT_DOC_INDEX_HEADING_OVERRIDES = Object.freeze({
  report_freshness_regression: Object.freeze(['Report Freshness']),
});

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_doc_index_anchor',
    label: 'A new manifest contract is added without docs or index anchors',
    expectedBlockerCode: 'report_contract_doc_index_anchor_docs_missing',
    mutate(input) {
      input.manifest.push({
        contractId: 'report_future_doc_index_anchor',
        label: 'Report future doc index anchor',
        scriptId: 'reports:future-doc-index-anchor',
        fileId: 'report-future-doc-index-anchor-latest.json',
      });
    },
  }),
  Object.freeze({
    scenarioId: 'docs_heading_missing',
    label: 'A contract docs page loses its canonical H1 anchor',
    expectedBlockerCode: 'report_contract_doc_index_anchor_docs_heading_missing',
    mutate(input) {
      const contract = targetContract(input);
      const docsPath = docsPathFor(contract, input.docPathOverrides);
      input.docsByPath[docsPath] = String(input.docsByPath[docsPath] || '')
        .replace('# Report Contract Manifest', '# Report Contract Manifest Drifted');
    },
  }),
  Object.freeze({
    scenarioId: 'docs_command_missing',
    label: 'A contract docs page stops showing its executable npm command',
    expectedBlockerCode: 'report_contract_doc_index_anchor_docs_command_missing',
    mutate(input) {
      const contract = targetContract(input);
      const docsPath = docsPathFor(contract, input.docPathOverrides);
      input.docsByPath[docsPath] = String(input.docsByPath[docsPath] || '')
        .replaceAll(`npm run ${contract.scriptId}`, `npm run missing-${contract.scriptId}`);
    },
  }),
  Object.freeze({
    scenarioId: 'readme_docs_anchor_missing',
    label: 'README.md stops linking the contract docs page',
    expectedBlockerCode: 'report_contract_doc_index_anchor_readme_docs_missing',
    mutate(input) {
      const contract = targetContract(input);
      const docsPath = docsPathFor(contract, input.docPathOverrides);
      input.readmeText = input.readmeText.replaceAll(docsPath, 'docs/missing-report-contract-manifest.md');
    },
  }),
  Object.freeze({
    scenarioId: 'readme_command_missing',
    label: 'README.md stops showing the contract npm command',
    expectedBlockerCode: 'report_contract_doc_index_anchor_readme_command_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.readmeText = input.readmeText.replaceAll(`npm run ${contract.scriptId}`, `npm run missing-${contract.scriptId}`);
    },
  }),
  Object.freeze({
    scenarioId: 'readme_latest_missing',
    label: 'README.md stops naming the contract latest artifacts',
    expectedBlockerCode: 'report_contract_doc_index_anchor_readme_latest_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.readmeText = removeLatestMentions(input.readmeText, contract.fileId);
    },
  }),
  Object.freeze({
    scenarioId: 'reports_readme_command_missing',
    label: 'reports/README.md stops showing the contract npm command',
    expectedBlockerCode: 'report_contract_doc_index_anchor_reports_readme_command_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.reportsReadmeText = input.reportsReadmeText.replaceAll(`npm run ${contract.scriptId}`, `npm run missing-${contract.scriptId}`);
    },
  }),
  Object.freeze({
    scenarioId: 'reports_readme_latest_missing',
    label: 'reports/README.md stops naming the contract latest JSON output',
    expectedBlockerCode: 'report_contract_doc_index_anchor_reports_readme_latest_missing',
    mutate(input) {
      const contract = targetContract(input);
      input.reportsReadmeText = removeLatestMentions(input.reportsReadmeText, contract.fileId);
    },
  }),
  Object.freeze({
    scenarioId: 'shared_docs_heading_override_missing',
    label: 'A shared docs page loses its explicit heading override',
    expectedBlockerCode: 'report_contract_doc_index_anchor_docs_heading_missing',
    mutate(input) {
      const headingOverrides = { ...input.headingOverrides };
      delete headingOverrides.report_freshness_regression;
      input.headingOverrides = headingOverrides;
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

function removeLatestMentions(text = '', fileId = '') {
  return String(text || '')
    .replaceAll(`reports/${latestPairIdFor(fileId)}`, 'reports/omitted-doc-index-anchor-latest.{json,md}')
    .replaceAll(latestPairIdFor(fileId), 'omitted-doc-index-anchor-latest.{json,md}')
    .replaceAll(`reports/${fileId}`, 'reports/omitted-doc-index-anchor-latest.json')
    .replaceAll(fileId, 'omitted-doc-index-anchor-latest.json')
    .replaceAll(`reports/${markdownFileIdFor(fileId)}`, 'reports/omitted-doc-index-anchor-latest.md')
    .replaceAll(markdownFileIdFor(fileId), 'omitted-doc-index-anchor-latest.md');
}

function titleCaseWord(word = '') {
  return String(word || '')
    .split('-')
    .map((segment) => segment ? `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}` : segment)
    .join('-');
}

function headingForLabel(label = '') {
  return String(label || '').split(/\s+/).filter(Boolean).map(titleCaseWord).join(' ');
}

function headingCandidatesFor(contract = {}, headingOverrides = REPORT_CONTRACT_DOC_INDEX_HEADING_OVERRIDES) {
  return uniqueSorted([
    headingForLabel(contract.label),
    ...(headingOverrides?.[contract.contractId] || []),
  ]);
}

function docsPathFor(contract = {}, overrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES) {
  if (overrides?.[contract.contractId]) return overrides[contract.contractId];
  return `docs/${String(contract.fileId || '').replace(/-latest\.json$/, '.md')}`;
}

function hasHeading(text = '', candidates = []) {
  return candidates.some((heading) => {
    const escapedHeading = String(heading || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^# ${escapedHeading}\\s*$`, 'm').test(String(text || ''));
  });
}

function hasCommand(text = '', scriptId = '') {
  return String(text || '').includes(`npm run ${scriptId}`);
}

function hasLatestMention(text = '', fileId = '') {
  const value = String(text || '');
  return [
    fileId,
    markdownFileIdFor(fileId),
    latestPairIdFor(fileId),
    `reports/${fileId}`,
    `reports/${markdownFileIdFor(fileId)}`,
    `reports/${latestPairIdFor(fileId)}`,
  ].some((candidate) => value.includes(candidate));
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

function analyzeContract(contract = {}, input = {}) {
  const docsPath = docsPathFor(contract, input.docPathOverrides);
  const docsText = input.docsByPath?.[docsPath] || '';
  const headingCandidates = headingCandidatesFor(contract, input.headingOverrides);
  const docsExists = Object.hasOwn(input.docsByPath || {}, docsPath);
  const docsHeadingPresent = docsExists && hasHeading(docsText, headingCandidates);
  const docsCommandPresent = docsExists && hasCommand(docsText, contract.scriptId);
  const readmeDocsPresent = String(input.readmeText || '').includes(docsPath);
  const readmeCommandPresent = hasCommand(input.readmeText, contract.scriptId);
  const readmeLatestPresent = hasLatestMention(input.readmeText, contract.fileId);
  const reportsReadmeCommandPresent = hasCommand(input.reportsReadmeText, contract.scriptId);
  const reportsReadmeLatestPresent = hasLatestMention(input.reportsReadmeText, contract.fileId);
  const blockers = [
    ...(docsExists ? [] : [blocker(
      'report_contract_doc_index_anchor_docs_missing',
      `${contract.contractId} docs file must exist at ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(docsHeadingPresent ? [] : [blocker(
      'report_contract_doc_index_anchor_docs_heading_missing',
      `${docsPath} must expose one canonical H1 anchor: ${headingCandidates.map((heading) => `# ${heading}`).join(' or ')}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(docsCommandPresent ? [] : [blocker(
      'report_contract_doc_index_anchor_docs_command_missing',
      `${docsPath} must show the executable command: npm run ${contract.scriptId}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(readmeDocsPresent ? [] : [blocker(
      'report_contract_doc_index_anchor_readme_docs_missing',
      `README.md must link ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(readmeCommandPresent ? [] : [blocker(
      'report_contract_doc_index_anchor_readme_command_missing',
      `README.md must show npm run ${contract.scriptId}.`,
      { contractId: contract.contractId, scriptId: contract.scriptId },
    )]),
    ...(readmeLatestPresent ? [] : [blocker(
      'report_contract_doc_index_anchor_readme_latest_missing',
      `README.md must name latest artifacts for ${contract.fileId}.`,
      { contractId: contract.contractId, fileId: contract.fileId },
    )]),
    ...(reportsReadmeCommandPresent ? [] : [blocker(
      'report_contract_doc_index_anchor_reports_readme_command_missing',
      `reports/README.md must show npm run ${contract.scriptId}.`,
      { contractId: contract.contractId, scriptId: contract.scriptId },
    )]),
    ...(reportsReadmeLatestPresent ? [] : [blocker(
      'report_contract_doc_index_anchor_reports_readme_latest_missing',
      `reports/README.md must name latest artifacts for ${contract.fileId}.`,
      { contractId: contract.contractId, fileId: contract.fileId },
    )]),
  ];
  return {
    contractId: contract.contractId,
    label: contract.label,
    scriptId: contract.scriptId,
    fileId: contract.fileId,
    docsPath,
    headingCandidates,
    status: blockers.length ? 'blocked_report_contract_doc_index_anchor_contract' : 'pass_report_contract_doc_index_anchor_contract',
    ok: blockers.length === 0,
    docsExists,
    docsHeadingPresent,
    docsCommandPresent,
    readmeDocsPresent,
    readmeCommandPresent,
    readmeLatestPresent,
    reportsReadmeCommandPresent,
    reportsReadmeLatestPresent,
    blockerCount: blockers.length,
    blockers,
  };
}

function compactContract(contract = {}) {
  return {
    contractId: contract.contractId,
    scriptId: contract.scriptId,
    fileId: contract.fileId,
    docsPath: contract.docsPath,
    headingCandidates: contract.headingCandidates || [],
    status: contract.status,
    ok: contract.ok === true,
    docsExists: contract.docsExists === true,
    docsHeadingPresent: contract.docsHeadingPresent === true,
    docsCommandPresent: contract.docsCommandPresent === true,
    readmeDocsPresent: contract.readmeDocsPresent === true,
    readmeCommandPresent: contract.readmeCommandPresent === true,
    readmeLatestPresent: contract.readmeLatestPresent === true,
    reportsReadmeCommandPresent: contract.reportsReadmeCommandPresent === true,
    reportsReadmeLatestPresent: contract.reportsReadmeLatestPresent === true,
    blockerCount: contract.blockerCount || 0,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      docsPath: item.docsPath || null,
      fileId: item.fileId || null,
      scriptId: item.scriptId || null,
    })),
  };
}

function analyzeDocIndexAnchors(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract).map((contract) => analyzeContract(contract, input));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_doc_index_anchor_analysis' : 'pass_report_contract_doc_index_anchor_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    uniqueDocsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    docsHeadingCount: contracts.filter((contract) => contract.docsHeadingPresent).length,
    docsCommandCount: contracts.filter((contract) => contract.docsCommandPresent).length,
    readmeDocsCount: contracts.filter((contract) => contract.readmeDocsPresent).length,
    readmeCommandCount: contracts.filter((contract) => contract.readmeCommandPresent).length,
    readmeLatestCount: contracts.filter((contract) => contract.readmeLatestPresent).length,
    reportsReadmeCommandCount: contracts.filter((contract) => contract.reportsReadmeCommandPresent).length,
    reportsReadmeLatestCount: contracts.filter((contract) => contract.reportsReadmeLatestPresent).length,
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
    docsHeadingCount: analysis.docsHeadingCount || 0,
    docsCommandCount: analysis.docsCommandCount || 0,
    readmeDocsCount: analysis.readmeDocsCount || 0,
    readmeCommandCount: analysis.readmeCommandCount || 0,
    readmeLatestCount: analysis.readmeLatestCount || 0,
    reportsReadmeCommandCount: analysis.reportsReadmeCommandCount || 0,
    reportsReadmeLatestCount: analysis.reportsReadmeLatestCount || 0,
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      docsPath: item.docsPath || null,
      fileId: item.fileId || null,
      scriptId: item.scriptId || null,
    })),
  };
}

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeDocIndexAnchors(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_doc_index_anchor_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract doc index anchor analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_doc_index_anchor_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_doc_index_anchor_scenario' : 'pass_report_contract_doc_index_anchor_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractDocIndexAnchorRegressionInput({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  readmeText = '',
  reportsReadmeText = '',
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  headingOverrides = REPORT_CONTRACT_DOC_INDEX_HEADING_OVERRIDES,
} = {}) {
  return {
    manifest: manifest.map(normalizeContract),
    docsByPath: { ...(docsByPath || {}) },
    readmeText: String(readmeText || ''),
    reportsReadmeText: String(reportsReadmeText || ''),
    docPathOverrides: { ...(docPathOverrides || {}) },
    headingOverrides: { ...(headingOverrides || {}) },
  };
}

export function buildReportContractDocIndexAnchorRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  readmeText = '',
  reportsReadmeText = '',
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  headingOverrides = REPORT_CONTRACT_DOC_INDEX_HEADING_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractDocIndexAnchorRegressionInput({
    manifest,
    docsByPath,
    readmeText,
    reportsReadmeText,
    docPathOverrides,
    headingOverrides,
  });
  const actual = analyzeDocIndexAnchors(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_doc_index_anchors',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_DOC_INDEX_ANCHOR_REGRESSION_VERSION,
    kind: 'ReportContractDocIndexAnchorRegression',
    status: blockers.length ? 'blocked_report_contract_doc_index_anchor_regression' : 'pass_report_contract_doc_index_anchor_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_DOC_INDEX_ANCHOR_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_DOC_INDEX_ANCHOR_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docsPaths: uniqueSorted(baseInput.manifest.map((contract) => docsPathFor(contract, baseInput.docPathOverrides))),
      docPathOverrides: baseInput.docPathOverrides,
      headingOverrides: baseInput.headingOverrides,
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
      docsHeadingCount: actual.docsHeadingCount,
      docsCommandCount: actual.docsCommandCount,
      readmeDocsCount: actual.readmeDocsCount,
      readmeCommandCount: actual.readmeCommandCount,
      readmeLatestCount: actual.readmeLatestCount,
      reportsReadmeCommandCount: actual.reportsReadmeCommandCount,
      reportsReadmeLatestCount: actual.reportsReadmeLatestCount,
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
  const contractDocIndexAnchorRegressionHash = digest({
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
      scriptId: item.scriptId || null,
      source: item.source || null,
    })),
    safety: report.safety,
  });
  return {
    ...report,
    contractDocIndexAnchorRegressionHash,
    hash: contractDocIndexAnchorRegressionHash,
  };
}

export function summarizeReportContractDocIndexAnchorRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractDocIndexAnchorRegressionHash: report.contractDocIndexAnchorRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    uniqueDocsPathCount: report.summary?.uniqueDocsPathCount ?? null,
    docsFileCount: report.summary?.docsFileCount ?? null,
    docsHeadingCount: report.summary?.docsHeadingCount ?? null,
    docsCommandCount: report.summary?.docsCommandCount ?? null,
    readmeDocsCount: report.summary?.readmeDocsCount ?? null,
    readmeCommandCount: report.summary?.readmeCommandCount ?? null,
    readmeLatestCount: report.summary?.readmeLatestCount ?? null,
    reportsReadmeCommandCount: report.summary?.reportsReadmeCommandCount ?? null,
    reportsReadmeLatestCount: report.summary?.reportsReadmeLatestCount ?? null,
    scenarioCount: report.summary?.scenarioCount ?? null,
    passedScenarioCount: report.summary?.passedScenarioCount ?? null,
    blockerCount: report.summary?.blockerCount ?? null,
    safety: report.safety || {},
  };
}
