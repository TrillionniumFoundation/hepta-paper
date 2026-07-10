import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_DETAIL_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_DETAIL_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-safety-section-detail-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_DETAIL_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-safety-section-detail-regression';
export const REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_DETAIL_REGRESSION_STEP_ID = 'report_contract_doc_page_safety_section_detail_regression_export';

export const REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_LOCAL_BOUNDARY_SENTENCE = 'Local boundary: local-only/read-only report and docs inspection.';
export const REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_REPORT_FILE_BOUNDARY_SENTENCE = 'Report file boundary: exporter writes only its own latest JSON/Markdown report files.';
export const REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_EXTERNAL_ACTION_BOUNDARY_SENTENCE = 'External action boundary: no provider/model calls, browser automation, upload, submit, messaging, payment, acceptance, deployment, or channel-state fetch.';
export const REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_EXECUTION_BOUNDARY_SENTENCE = 'Execution boundary: no local state transition and no execution permission grant.';

const TARGET_CONTRACT_ID = 'report_contract_manifest';
const SECTION_HEADING_PREFIX = '## Contract Page Safety Section: ';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_safety_section',
    label: 'A new manifest contract is added with docs but without a safety section',
    expectedBlockerCode: 'report_contract_doc_page_safety_section_detail_missing',
    mutate(input) {
      const contract = {
        contractId: 'report_future_doc_page_safety_section_detail',
        label: 'Report future doc page safety section detail',
        scriptId: 'reports:future-doc-page-safety-section-detail',
        fileId: 'report-future-doc-page-safety-section-detail-latest.json',
      };
      input.manifest.push(contract);
      input.docsByPath[docsPathFor(contract, input.docPathOverrides)] = '# Report Future Doc Page Safety Section Detail\n';
    },
  }),
  Object.freeze({
    scenarioId: 'local_boundary_missing',
    label: 'A contract safety section loses the local-only/read-only boundary',
    expectedBlockerCode: 'report_contract_doc_page_safety_section_detail_local_boundary_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_LOCAL_BOUNDARY_SENTENCE, ''));
    },
  }),
  Object.freeze({
    scenarioId: 'local_only_wording_drift',
    label: 'A contract safety section keeps a local sentence but loses local-only/read-only wording',
    expectedBlockerCode: 'report_contract_doc_page_safety_section_detail_local_boundary_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace('local-only/read-only', 'local'));
    },
  }),
  Object.freeze({
    scenarioId: 'report_file_boundary_missing',
    label: 'A contract safety section loses its report-file mutation boundary',
    expectedBlockerCode: 'report_contract_doc_page_safety_section_detail_report_file_boundary_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_REPORT_FILE_BOUNDARY_SENTENCE, ''));
    },
  }),
  Object.freeze({
    scenarioId: 'external_action_boundary_missing',
    label: 'A contract safety section loses its no-external-action boundary',
    expectedBlockerCode: 'report_contract_doc_page_safety_section_detail_external_action_boundary_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_EXTERNAL_ACTION_BOUNDARY_SENTENCE, ''));
    },
  }),
  Object.freeze({
    scenarioId: 'provider_model_browser_terms_missing',
    label: 'A contract safety section loses provider/model or browser terms',
    expectedBlockerCode: 'report_contract_doc_page_safety_section_detail_external_action_boundary_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace('provider/model calls, browser automation, ', ''));
    },
  }),
  Object.freeze({
    scenarioId: 'upload_submit_messaging_terms_missing',
    label: 'A contract safety section loses upload/submit/messaging terms',
    expectedBlockerCode: 'report_contract_doc_page_safety_section_detail_external_action_boundary_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace('upload, submit, messaging, ', ''));
    },
  }),
  Object.freeze({
    scenarioId: 'execution_boundary_missing',
    label: 'A contract safety section loses state-transition and permission-grant wording',
    expectedBlockerCode: 'report_contract_doc_page_safety_section_detail_execution_boundary_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_EXECUTION_BOUNDARY_SENTENCE, ''));
    },
  }),
  Object.freeze({
    scenarioId: 'safety_section_order_drift',
    label: 'A contract safety section moves execution before external action boundary',
    expectedBlockerCode: 'report_contract_doc_page_safety_section_detail_order_invalid',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(
          `${REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_EXTERNAL_ACTION_BOUNDARY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_EXECUTION_BOUNDARY_SENTENCE}`,
          `${REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_EXECUTION_BOUNDARY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_EXTERNAL_ACTION_BOUNDARY_SENTENCE}`,
        ));
    },
  }),
  Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: 'report_contract_doc_page_safety_section_detail_docs_missing',
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

export function safetySectionHeadingFor(contractId = '') {
  return `${SECTION_HEADING_PREFIX}${contractId}`;
}

export function buildReportContractDocPageSafetySectionDetailMarkdownBlock(contract = {}) {
  return [
    safetySectionHeadingFor(contract.contractId),
    '',
    REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_LOCAL_BOUNDARY_SENTENCE,
    '',
    REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_REPORT_FILE_BOUNDARY_SENTENCE,
    '',
    REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_EXTERNAL_ACTION_BOUNDARY_SENTENCE,
    '',
    REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_EXECUTION_BOUNDARY_SENTENCE,
    '',
  ].join('\n');
}

function extractSafetySection(text = '', contractId = '') {
  const heading = safetySectionHeadingFor(contractId);
  const source = String(text || '');
  const lineStartNeedle = `\n${heading}\n`;
  const embeddedStart = source.indexOf(lineStartNeedle);
  const start = source.startsWith(`${heading}\n`)
    ? 0
    : (embeddedStart < 0 ? -1 : embeddedStart + 1);
  if (start < 0) return null;
  const nextHeading = source.indexOf('\n## ', start + heading.length);
  return source.slice(start, nextHeading < 0 ? undefined : nextHeading).trimEnd();
}

function replaceSafetySection(text = '', contractId = '', replacer = (section) => section) {
  const heading = safetySectionHeadingFor(contractId);
  const source = String(text || '');
  const lineStartNeedle = `\n${heading}\n`;
  const embeddedStart = source.indexOf(lineStartNeedle);
  const start = source.startsWith(`${heading}\n`)
    ? 0
    : (embeddedStart < 0 ? -1 : embeddedStart + 1);
  if (start < 0) return source;
  const nextHeading = source.indexOf('\n## ', start + heading.length);
  const end = nextHeading < 0 ? source.length : nextHeading;
  return `${source.slice(0, start)}${replacer(source.slice(start, end), contractId)}${source.slice(end)}`;
}

function mutateTargetDocsSection(input = {}, sectionMutator = (section) => section) {
  const contract = targetContract(input);
  const docsPath = docsPathFor(contract, input.docPathOverrides);
  input.docsByPath[docsPath] = replaceSafetySection(
    input.docsByPath[docsPath] || '',
    contract.contractId,
    (section) => sectionMutator(section, contract),
  );
}

function indexOfPart(sectionText = '', part = '') {
  return String(sectionText || '').indexOf(part);
}

function analyzeContract(contract = {}, input = {}) {
  const docsPath = docsPathFor(contract, input.docPathOverrides);
  const docsExists = Object.hasOwn(input.docsByPath || {}, docsPath);
  const docsText = docsExists ? String(input.docsByPath[docsPath] || '') : '';
  const sectionText = docsExists ? extractSafetySection(docsText, contract.contractId) : null;
  const mdFileId = markdownFileIdFor(contract.fileId);
  const expectedParts = [
    { key: 'sectionHeading', part: safetySectionHeadingFor(contract.contractId) },
    { key: 'localBoundary', part: REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_LOCAL_BOUNDARY_SENTENCE },
    { key: 'reportFileBoundary', part: REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_REPORT_FILE_BOUNDARY_SENTENCE },
    { key: 'externalActionBoundary', part: REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_EXTERNAL_ACTION_BOUNDARY_SENTENCE },
    { key: 'executionBoundary', part: REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_EXECUTION_BOUNDARY_SENTENCE },
  ];
  const positions = Object.fromEntries(expectedParts.map((entry) => [
    entry.key,
    sectionText == null ? -1 : indexOfPart(sectionText, entry.part),
  ]));
  const localBoundaryPresent = positions.localBoundary >= 0
    && /local-only\/read-only/.test(sectionText || '');
  const reportFileBoundaryPresent = positions.reportFileBoundary >= 0
    && /latest JSON\/Markdown report files/.test(sectionText || '');
  const externalActionBoundaryPresent = positions.externalActionBoundary >= 0
    && [
      'provider/model calls',
      'browser automation',
      'upload',
      'submit',
      'messaging',
      'payment',
      'acceptance',
      'deployment',
      'channel-state fetch',
    ].every((term) => String(sectionText || '').includes(term));
  const executionBoundaryPresent = positions.executionBoundary >= 0
    && ['local state transition', 'execution permission grant'].every((term) => String(sectionText || '').includes(term));
  const orderValues = expectedParts.map((entry) => positions[entry.key]);
  const orderValid = sectionText != null
    && orderValues.every((position) => position >= 0)
    && orderValues.every((position, index, values) => index === 0 || values[index - 1] < position);
  const blockers = [
    ...(docsExists ? [] : [blocker(
      'report_contract_doc_page_safety_section_detail_docs_missing',
      `${contract.contractId} docs file must exist at ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(sectionText != null ? [] : [blocker(
      'report_contract_doc_page_safety_section_detail_missing',
      `${docsPath} must include ${safetySectionHeadingFor(contract.contractId)}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(localBoundaryPresent ? [] : [blocker(
      'report_contract_doc_page_safety_section_detail_local_boundary_missing',
      `${docsPath} safety section must include the canonical local-only/read-only boundary.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(reportFileBoundaryPresent ? [] : [blocker(
      'report_contract_doc_page_safety_section_detail_report_file_boundary_missing',
      `${docsPath} safety section must include the canonical report-file write boundary.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(externalActionBoundaryPresent ? [] : [blocker(
      'report_contract_doc_page_safety_section_detail_external_action_boundary_missing',
      `${docsPath} safety section must include the canonical no-external-action boundary.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(executionBoundaryPresent ? [] : [blocker(
      'report_contract_doc_page_safety_section_detail_execution_boundary_missing',
      `${docsPath} safety section must include the canonical execution-permission boundary.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(orderValid ? [] : [blocker(
      'report_contract_doc_page_safety_section_detail_order_invalid',
      `${docsPath} safety section must order heading, local boundary, report-file boundary, external-action boundary, then execution boundary.`,
      { contractId: contract.contractId, docsPath, positions },
    )]),
  ];
  return {
    contractId: contract.contractId,
    label: contract.label,
    scriptId: contract.scriptId,
    fileId: contract.fileId,
    mdFileId,
    docsPath,
    status: blockers.length ? 'blocked_report_contract_doc_page_safety_section_detail_contract' : 'pass_report_contract_doc_page_safety_section_detail_contract',
    ok: blockers.length === 0,
    docsExists,
    sectionPresent: sectionText != null,
    localBoundaryPresent,
    reportFileBoundaryPresent,
    externalActionBoundaryPresent,
    executionBoundaryPresent,
    orderValid,
    positions,
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
    sectionPresent: contract.sectionPresent === true,
    localBoundaryPresent: contract.localBoundaryPresent === true,
    reportFileBoundaryPresent: contract.reportFileBoundaryPresent === true,
    externalActionBoundaryPresent: contract.externalActionBoundaryPresent === true,
    executionBoundaryPresent: contract.executionBoundaryPresent === true,
    orderValid: contract.orderValid === true,
    blockerCount: contract.blockerCount || 0,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      docsPath: item.docsPath || null,
    })),
  };
}

function analyzeDocPageSafetySectionDetails(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract).map((contract) => analyzeContract(contract, input));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_doc_page_safety_section_detail_analysis' : 'pass_report_contract_doc_page_safety_section_detail_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    uniqueDocsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    sectionCount: contracts.filter((contract) => contract.sectionPresent).length,
    localBoundaryCount: contracts.filter((contract) => contract.localBoundaryPresent).length,
    reportFileBoundaryCount: contracts.filter((contract) => contract.reportFileBoundaryPresent).length,
    externalActionBoundaryCount: contracts.filter((contract) => contract.externalActionBoundaryPresent).length,
    executionBoundaryCount: contracts.filter((contract) => contract.executionBoundaryPresent).length,
    orderCount: contracts.filter((contract) => contract.orderValid).length,
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
    sectionCount: analysis.sectionCount || 0,
    localBoundaryCount: analysis.localBoundaryCount || 0,
    reportFileBoundaryCount: analysis.reportFileBoundaryCount || 0,
    externalActionBoundaryCount: analysis.externalActionBoundaryCount || 0,
    executionBoundaryCount: analysis.executionBoundaryCount || 0,
    orderCount: analysis.orderCount || 0,
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      docsPath: item.docsPath || null,
    })),
  };
}

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeDocPageSafetySectionDetails(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_doc_page_safety_section_detail_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract docs page safety section analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_doc_page_safety_section_detail_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_doc_page_safety_section_detail_scenario' : 'pass_report_contract_doc_page_safety_section_detail_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractDocPageSafetySectionDetailRegressionInput({
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

export function buildReportContractDocPageSafetySectionDetailRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractDocPageSafetySectionDetailRegressionInput({
    manifest,
    docsByPath,
    docPathOverrides,
  });
  const actual = analyzeDocPageSafetySectionDetails(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_doc_page_safety_sections',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_DETAIL_REGRESSION_VERSION,
    kind: 'ReportContractDocPageSafetySectionDetailRegression',
    status: blockers.length ? 'blocked_report_contract_doc_page_safety_section_detail_regression' : 'pass_report_contract_doc_page_safety_section_detail_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_DETAIL_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_DETAIL_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docsPaths: uniqueSorted(baseInput.manifest.map((contract) => docsPathFor(contract, baseInput.docPathOverrides))),
      docPathOverrides: baseInput.docPathOverrides,
      sectionHeadingPrefix: SECTION_HEADING_PREFIX,
      localBoundarySentence: REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_LOCAL_BOUNDARY_SENTENCE,
      reportFileBoundarySentence: REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_REPORT_FILE_BOUNDARY_SENTENCE,
      externalActionBoundarySentence: REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_EXTERNAL_ACTION_BOUNDARY_SENTENCE,
      executionBoundarySentence: REPORT_CONTRACT_DOC_PAGE_SAFETY_SECTION_EXECUTION_BOUNDARY_SENTENCE,
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
      sectionCount: actual.sectionCount,
      localBoundaryCount: actual.localBoundaryCount,
      reportFileBoundaryCount: actual.reportFileBoundaryCount,
      externalActionBoundaryCount: actual.externalActionBoundaryCount,
      executionBoundaryCount: actual.executionBoundaryCount,
      orderCount: actual.orderCount,
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
  const contractDocPageSafetySectionDetailRegressionHash = digest({
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
      source: item.source || null,
    })),
    safety: report.safety,
  });
  return {
    ...report,
    contractDocPageSafetySectionDetailRegressionHash,
    hash: contractDocPageSafetySectionDetailRegressionHash,
  };
}

export function summarizeReportContractDocPageSafetySectionDetailRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractDocPageSafetySectionDetailRegressionHash: report.contractDocPageSafetySectionDetailRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    uniqueDocsPathCount: report.summary?.uniqueDocsPathCount ?? null,
    docsFileCount: report.summary?.docsFileCount ?? null,
    sectionCount: report.summary?.sectionCount ?? null,
    localBoundaryCount: report.summary?.localBoundaryCount ?? null,
    reportFileBoundaryCount: report.summary?.reportFileBoundaryCount ?? null,
    externalActionBoundaryCount: report.summary?.externalActionBoundaryCount ?? null,
    executionBoundaryCount: report.summary?.executionBoundaryCount ?? null,
    orderCount: report.summary?.orderCount ?? null,
    scenarioCount: report.summary?.scenarioCount ?? null,
    passedScenarioCount: report.summary?.passedScenarioCount ?? null,
    blockerCount: report.summary?.blockerCount ?? null,
    safety: report.safety || {},
  };
}
