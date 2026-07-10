import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-output-section-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-output-section-regression';
export const REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_REGRESSION_STEP_ID = 'report_contract_doc_page_output_section_regression_export';

export const REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_INDEX_BINDING_SENTENCE = 'Index binding: README.md and reports/README.md must list this contract command and latest artifacts.';
export const REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_CROSS_REPORT_BINDING_SENTENCE = 'Cross-report binding: freshness, output pairing, artifact reproducibility, schema, tooling, and architecture checkpoint must see this output.';

const TARGET_CONTRACT_ID = 'report_contract_manifest';
const SECTION_HEADING_PREFIX = '## Contract Page Output Section: ';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_output_section',
    label: 'A new manifest contract is added with docs but without an output section',
    expectedBlockerCode: 'report_contract_doc_page_output_section_missing',
    mutate(input) {
      const contract = {
        contractId: 'report_future_doc_page_output_section',
        label: 'Report future doc page output section',
        scriptId: 'reports:future-doc-page-output-section',
        fileId: 'report-future-doc-page-output-section-latest.json',
      };
      input.manifest.push(contract);
      input.docsByPath[docsPathFor(contract, input.docPathOverrides)] = '# Report Future Doc Page Output Section\n';
    },
  }),
  Object.freeze({
    scenarioId: 'json_output_missing',
    label: 'A contract output section loses its latest JSON output sentence',
    expectedBlockerCode: 'report_contract_doc_page_output_section_json_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(jsonOutputSentenceFor(targetContract(input)), ''));
    },
  }),
  Object.freeze({
    scenarioId: 'markdown_output_missing',
    label: 'A contract output section loses its latest Markdown output sentence',
    expectedBlockerCode: 'report_contract_doc_page_output_section_markdown_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(markdownOutputSentenceFor(targetContract(input)), ''));
    },
  }),
  Object.freeze({
    scenarioId: 'json_output_unqualified',
    label: 'A contract output section keeps the JSON basename but loses the reports path',
    expectedBlockerCode: 'report_contract_doc_page_output_section_json_missing',
    mutate(input) {
      const contract = targetContract(input);
      mutateTargetDocsSection(input, (section) => section
        .replace(`reports/${contract.fileId}`, contract.fileId));
    },
  }),
  Object.freeze({
    scenarioId: 'markdown_output_unqualified',
    label: 'A contract output section keeps the Markdown basename but loses the reports path',
    expectedBlockerCode: 'report_contract_doc_page_output_section_markdown_missing',
    mutate(input) {
      const contract = targetContract(input);
      const mdFileId = markdownFileIdFor(contract.fileId);
      mutateTargetDocsSection(input, (section) => section
        .replace(`reports/${mdFileId}`, mdFileId));
    },
  }),
  Object.freeze({
    scenarioId: 'index_binding_missing',
    label: 'A contract output section loses README and reports README binding',
    expectedBlockerCode: 'report_contract_doc_page_output_section_index_binding_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_INDEX_BINDING_SENTENCE, ''));
    },
  }),
  Object.freeze({
    scenarioId: 'index_binding_terms_missing',
    label: 'A contract output section loses README or latest artifact terms',
    expectedBlockerCode: 'report_contract_doc_page_output_section_index_binding_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace('README.md and reports/README.md must list this contract command and latest artifacts', 'README.md must mention this contract'));
    },
  }),
  Object.freeze({
    scenarioId: 'cross_report_binding_missing',
    label: 'A contract output section loses cross-report output binding',
    expectedBlockerCode: 'report_contract_doc_page_output_section_cross_report_binding_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_CROSS_REPORT_BINDING_SENTENCE, ''));
    },
  }),
  Object.freeze({
    scenarioId: 'cross_report_binding_terms_missing',
    label: 'A contract output section loses output pairing or artifact reproducibility terms',
    expectedBlockerCode: 'report_contract_doc_page_output_section_cross_report_binding_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace('output pairing, artifact reproducibility, ', ''));
    },
  }),
  Object.freeze({
    scenarioId: 'output_section_order_drift',
    label: 'A contract output section moves cross-report binding before artifact outputs',
    expectedBlockerCode: 'report_contract_doc_page_output_section_order_invalid',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(
          `${jsonOutputSentenceFor(targetContract(input))}\n\n${markdownOutputSentenceFor(targetContract(input))}\n\n${REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_INDEX_BINDING_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_CROSS_REPORT_BINDING_SENTENCE}`,
          `${REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_CROSS_REPORT_BINDING_SENTENCE}\n\n${jsonOutputSentenceFor(targetContract(input))}\n\n${markdownOutputSentenceFor(targetContract(input))}\n\n${REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_INDEX_BINDING_SENTENCE}`,
        ));
    },
  }),
  Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: 'report_contract_doc_page_output_section_docs_missing',
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

export function outputSectionHeadingFor(contractId = '') {
  return `${SECTION_HEADING_PREFIX}${contractId}`;
}

export function jsonOutputSentenceFor(contract = {}) {
  return `JSON output: reports/${contract.fileId} is this contract's latest JSON artifact.`;
}

export function markdownOutputSentenceFor(contract = {}) {
  return `Markdown output: reports/${markdownFileIdFor(contract.fileId)} is this contract's latest Markdown artifact.`;
}

export function buildReportContractDocPageOutputSectionMarkdownBlock(contract = {}) {
  return [
    outputSectionHeadingFor(contract.contractId),
    '',
    jsonOutputSentenceFor(contract),
    '',
    markdownOutputSentenceFor(contract),
    '',
    REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_INDEX_BINDING_SENTENCE,
    '',
    REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_CROSS_REPORT_BINDING_SENTENCE,
    '',
  ].join('\n');
}

function extractOutputSection(text = '', contractId = '') {
  const heading = outputSectionHeadingFor(contractId);
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

function replaceOutputSection(text = '', contractId = '', replacer = (section) => section) {
  const heading = outputSectionHeadingFor(contractId);
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
  input.docsByPath[docsPath] = replaceOutputSection(
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
  const sectionText = docsExists ? extractOutputSection(docsText, contract.contractId) : null;
  const mdFileId = markdownFileIdFor(contract.fileId);
  const expectedParts = [
    { key: 'sectionHeading', part: outputSectionHeadingFor(contract.contractId) },
    { key: 'jsonOutput', part: jsonOutputSentenceFor(contract) },
    { key: 'markdownOutput', part: markdownOutputSentenceFor(contract) },
    { key: 'indexBinding', part: REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_INDEX_BINDING_SENTENCE },
    { key: 'crossReportBinding', part: REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_CROSS_REPORT_BINDING_SENTENCE },
  ];
  const positions = Object.fromEntries(expectedParts.map((entry) => [
    entry.key,
    sectionText == null ? -1 : indexOfPart(sectionText, entry.part),
  ]));
  const jsonOutputPresent = positions.jsonOutput >= 0
    && String(sectionText || '').includes(`reports/${contract.fileId}`)
    && /latest JSON artifact/.test(sectionText || '');
  const markdownOutputPresent = positions.markdownOutput >= 0
    && String(sectionText || '').includes(`reports/${mdFileId}`)
    && /latest Markdown artifact/.test(sectionText || '');
  const indexBindingPresent = positions.indexBinding >= 0
    && ['README.md', 'reports/README.md', 'contract command', 'latest artifacts'].every((term) => (
      String(sectionText || '').includes(term)
    ));
  const crossReportBindingPresent = positions.crossReportBinding >= 0
    && [
      'freshness',
      'output pairing',
      'artifact reproducibility',
      'schema',
      'tooling',
      'architecture checkpoint',
    ].every((term) => String(sectionText || '').includes(term));
  const orderValues = expectedParts.map((entry) => positions[entry.key]);
  const orderValid = sectionText != null
    && orderValues.every((position) => position >= 0)
    && orderValues.every((position, index, values) => index === 0 || values[index - 1] < position);
  const blockers = [
    ...(docsExists ? [] : [blocker(
      'report_contract_doc_page_output_section_docs_missing',
      `${contract.contractId} docs file must exist at ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(sectionText != null ? [] : [blocker(
      'report_contract_doc_page_output_section_missing',
      `${docsPath} must include ${outputSectionHeadingFor(contract.contractId)}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(jsonOutputPresent ? [] : [blocker(
      'report_contract_doc_page_output_section_json_missing',
      `${docsPath} output section must include the canonical latest JSON output path.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(markdownOutputPresent ? [] : [blocker(
      'report_contract_doc_page_output_section_markdown_missing',
      `${docsPath} output section must include the canonical latest Markdown output path.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(indexBindingPresent ? [] : [blocker(
      'report_contract_doc_page_output_section_index_binding_missing',
      `${docsPath} output section must include the canonical README/reports README binding sentence.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(crossReportBindingPresent ? [] : [blocker(
      'report_contract_doc_page_output_section_cross_report_binding_missing',
      `${docsPath} output section must include the canonical cross-report output binding sentence.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(orderValid ? [] : [blocker(
      'report_contract_doc_page_output_section_order_invalid',
      `${docsPath} output section must order heading, JSON output, Markdown output, index binding, then cross-report binding.`,
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
    status: blockers.length ? 'blocked_report_contract_doc_page_output_section_contract' : 'pass_report_contract_doc_page_output_section_contract',
    ok: blockers.length === 0,
    docsExists,
    sectionPresent: sectionText != null,
    jsonOutputPresent,
    markdownOutputPresent,
    indexBindingPresent,
    crossReportBindingPresent,
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
    jsonOutputPresent: contract.jsonOutputPresent === true,
    markdownOutputPresent: contract.markdownOutputPresent === true,
    indexBindingPresent: contract.indexBindingPresent === true,
    crossReportBindingPresent: contract.crossReportBindingPresent === true,
    orderValid: contract.orderValid === true,
    blockerCount: contract.blockerCount || 0,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      docsPath: item.docsPath || null,
    })),
  };
}

function analyzeDocPageOutputSections(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract).map((contract) => analyzeContract(contract, input));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_doc_page_output_section_analysis' : 'pass_report_contract_doc_page_output_section_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    uniqueDocsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    sectionCount: contracts.filter((contract) => contract.sectionPresent).length,
    jsonOutputCount: contracts.filter((contract) => contract.jsonOutputPresent).length,
    markdownOutputCount: contracts.filter((contract) => contract.markdownOutputPresent).length,
    indexBindingCount: contracts.filter((contract) => contract.indexBindingPresent).length,
    crossReportBindingCount: contracts.filter((contract) => contract.crossReportBindingPresent).length,
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
    jsonOutputCount: analysis.jsonOutputCount || 0,
    markdownOutputCount: analysis.markdownOutputCount || 0,
    indexBindingCount: analysis.indexBindingCount || 0,
    crossReportBindingCount: analysis.crossReportBindingCount || 0,
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
  const analysis = analyzeDocPageOutputSections(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_doc_page_output_section_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract docs page output section analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_doc_page_output_section_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_doc_page_output_section_scenario' : 'pass_report_contract_doc_page_output_section_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractDocPageOutputSectionRegressionInput({
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

export function buildReportContractDocPageOutputSectionRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractDocPageOutputSectionRegressionInput({
    manifest,
    docsByPath,
    docPathOverrides,
  });
  const actual = analyzeDocPageOutputSections(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_doc_page_output_sections',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_REGRESSION_VERSION,
    kind: 'ReportContractDocPageOutputSectionRegression',
    status: blockers.length ? 'blocked_report_contract_doc_page_output_section_regression' : 'pass_report_contract_doc_page_output_section_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docsPaths: uniqueSorted(baseInput.manifest.map((contract) => docsPathFor(contract, baseInput.docPathOverrides))),
      docPathOverrides: baseInput.docPathOverrides,
      sectionHeadingPrefix: SECTION_HEADING_PREFIX,
      indexBindingSentence: REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_INDEX_BINDING_SENTENCE,
      crossReportBindingSentence: REPORT_CONTRACT_DOC_PAGE_OUTPUT_SECTION_CROSS_REPORT_BINDING_SENTENCE,
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
      jsonOutputCount: actual.jsonOutputCount,
      markdownOutputCount: actual.markdownOutputCount,
      indexBindingCount: actual.indexBindingCount,
      crossReportBindingCount: actual.crossReportBindingCount,
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
  const contractDocPageOutputSectionRegressionHash = digest({
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
    contractDocPageOutputSectionRegressionHash,
    hash: contractDocPageOutputSectionRegressionHash,
  };
}

export function summarizeReportContractDocPageOutputSectionRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractDocPageOutputSectionRegressionHash: report.contractDocPageOutputSectionRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    uniqueDocsPathCount: report.summary?.uniqueDocsPathCount ?? null,
    docsFileCount: report.summary?.docsFileCount ?? null,
    sectionCount: report.summary?.sectionCount ?? null,
    jsonOutputCount: report.summary?.jsonOutputCount ?? null,
    markdownOutputCount: report.summary?.markdownOutputCount ?? null,
    indexBindingCount: report.summary?.indexBindingCount ?? null,
    crossReportBindingCount: report.summary?.crossReportBindingCount ?? null,
    orderCount: report.summary?.orderCount ?? null,
    scenarioCount: report.summary?.scenarioCount ?? null,
    passedScenarioCount: report.summary?.passedScenarioCount ?? null,
    blockerCount: report.summary?.blockerCount ?? null,
    safety: report.safety || {},
  };
}
