import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-command-section-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-command-section-regression';
export const REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_REGRESSION_STEP_ID = 'report_contract_doc_page_command_section_regression_export';

export const REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_STRICT_GATE_SENTENCE = 'Strict gate: `npm run gate:integration:strict` runs this contract before final freshness and architecture checkpoint closeout.';
export const REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_SAFETY_SENTENCE = 'Safety: local-only/read-only report inspection; no external actions.';

const TARGET_CONTRACT_ID = 'report_contract_manifest';
const SECTION_HEADING_PREFIX = '## Contract Page Command Section: ';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_command_section',
    label: 'A new manifest contract is added with docs but without a command section',
    expectedBlockerCode: 'report_contract_doc_page_command_section_missing',
    mutate(input) {
      const contract = {
        contractId: 'report_future_doc_page_command_section',
        label: 'Report future doc page command section',
        scriptId: 'reports:future-doc-page-command-section',
        fileId: 'report-future-doc-page-command-section-latest.json',
      };
      input.manifest.push(contract);
      input.docsByPath[docsPathFor(contract, input.docPathOverrides)] = '# Report Future Doc Page Command Section\n';
    },
  }),
  Object.freeze({
    scenarioId: 'doc_page_command_missing',
    label: 'A contract docs page loses its command snippet',
    expectedBlockerCode: 'report_contract_doc_page_command_section_command_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section, contract) => section
        .replace(commandSnippetFor(contract), ''));
    },
  }),
  Object.freeze({
    scenarioId: 'doc_page_command_script_drift',
    label: 'A contract docs page command snippet points at the wrong script',
    expectedBlockerCode: 'report_contract_doc_page_command_section_command_mismatch',
    mutate(input) {
      mutateTargetDocsSection(input, (section, contract) => section
        .replace(`npm run ${contract.scriptId}`, 'npm run reports:wrong-contract-command-section'));
    },
  }),
  Object.freeze({
    scenarioId: 'doc_page_latest_json_missing',
    label: 'A contract command section loses the qualified latest JSON path',
    expectedBlockerCode: 'report_contract_doc_page_command_section_latest_json_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section, contract) => section
        .replaceAll(`reports/${contract.fileId}`, contract.fileId));
    },
  }),
  Object.freeze({
    scenarioId: 'doc_page_latest_markdown_missing',
    label: 'A contract command section loses the qualified latest Markdown path',
    expectedBlockerCode: 'report_contract_doc_page_command_section_latest_markdown_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section, contract) => section
        .replaceAll(`reports/${markdownFileIdFor(contract.fileId)}`, markdownFileIdFor(contract.fileId)));
    },
  }),
  Object.freeze({
    scenarioId: 'doc_page_strict_gate_sentence_missing',
    label: 'A contract command section loses its strict-gate sentence',
    expectedBlockerCode: 'report_contract_doc_page_command_section_strict_gate_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_STRICT_GATE_SENTENCE, ''));
    },
  }),
  Object.freeze({
    scenarioId: 'doc_page_safety_sentence_missing',
    label: 'A contract command section loses its safety sentence',
    expectedBlockerCode: 'report_contract_doc_page_command_section_safety_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_SAFETY_SENTENCE, ''));
    },
  }),
  Object.freeze({
    scenarioId: 'doc_page_command_section_order_drift',
    label: 'A contract command section moves the safety sentence before the strict-gate sentence',
    expectedBlockerCode: 'report_contract_doc_page_command_section_order_invalid',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(`${REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_STRICT_GATE_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_SAFETY_SENTENCE}`, `${REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_SAFETY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_STRICT_GATE_SENTENCE}`));
    },
  }),
  Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: 'report_contract_doc_page_command_section_docs_missing',
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

export function commandSectionHeadingFor(contractId = '') {
  return `${SECTION_HEADING_PREFIX}${contractId}`;
}

function commandSnippetFor(contract = {}) {
  return `\`\`\`bash\nnpm run ${contract.scriptId}\n\`\`\``;
}

export function buildReportContractDocPageCommandSectionMarkdownBlock(contract = {}) {
  const mdFileId = markdownFileIdFor(contract.fileId);
  return [
    commandSectionHeadingFor(contract.contractId),
    '',
    'Command:',
    '',
    commandSnippetFor(contract),
    '',
    'Latest outputs:',
    '',
    `- \`reports/${contract.fileId}\``,
    `- \`reports/${mdFileId}\``,
    '',
    REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_STRICT_GATE_SENTENCE,
    '',
    REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_SAFETY_SENTENCE,
    '',
  ].join('\n');
}

function extractCommandSection(text = '', contractId = '') {
  const heading = commandSectionHeadingFor(contractId);
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

function replaceCommandSection(text = '', contractId = '', replacer = (section) => section) {
  const heading = commandSectionHeadingFor(contractId);
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
  input.docsByPath[docsPath] = replaceCommandSection(
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
  const sectionText = docsExists ? extractCommandSection(docsText, contract.contractId) : null;
  const mdFileId = markdownFileIdFor(contract.fileId);
  const expectedCommandSnippet = commandSnippetFor(contract);
  const latestJsonPath = `reports/${contract.fileId}`;
  const latestMarkdownPath = `reports/${mdFileId}`;
  const expectedParts = [
    { key: 'sectionHeading', part: commandSectionHeadingFor(contract.contractId) },
    { key: 'commandLabel', part: 'Command:' },
    { key: 'commandSnippet', part: expectedCommandSnippet },
    { key: 'latestOutputsLabel', part: 'Latest outputs:' },
    { key: 'latestJson', part: latestJsonPath },
    { key: 'latestMarkdown', part: latestMarkdownPath },
    { key: 'strictGate', part: REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_STRICT_GATE_SENTENCE },
    { key: 'safety', part: REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_SAFETY_SENTENCE },
  ];
  const positions = Object.fromEntries(expectedParts.map((entry) => [
    entry.key,
    sectionText == null ? -1 : indexOfPart(sectionText, entry.part),
  ]));
  const commandLabelPresent = positions.commandLabel >= 0;
  const commandSnippetPresent = positions.commandSnippet >= 0;
  const commandMismatch = commandLabelPresent
    && !commandSnippetPresent
    && sectionText != null
    && /```bash\nnpm run [^\n]+\n```/.test(sectionText);
  const latestJsonPresent = positions.latestJson >= 0;
  const latestMarkdownPresent = positions.latestMarkdown >= 0;
  const strictGatePresent = positions.strictGate >= 0;
  const safetyPresent = positions.safety >= 0;
  const orderValues = expectedParts.map((entry) => positions[entry.key]);
  const orderValid = sectionText != null
    && orderValues.every((position) => position >= 0)
    && orderValues.every((position, index, values) => index === 0 || values[index - 1] < position);
  const blockers = [
    ...(docsExists ? [] : [blocker(
      'report_contract_doc_page_command_section_docs_missing',
      `${contract.contractId} docs file must exist at ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(sectionText != null ? [] : [blocker(
      'report_contract_doc_page_command_section_missing',
      `${docsPath} must include ${commandSectionHeadingFor(contract.contractId)}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(commandLabelPresent && commandSnippetPresent ? [] : [blocker(
      commandMismatch
        ? 'report_contract_doc_page_command_section_command_mismatch'
        : 'report_contract_doc_page_command_section_command_missing',
      `${docsPath} command section must include npm run ${contract.scriptId}.`,
      { contractId: contract.contractId, docsPath, scriptId: contract.scriptId },
    )]),
    ...(latestJsonPresent ? [] : [blocker(
      'report_contract_doc_page_command_section_latest_json_missing',
      `${docsPath} command section must explicitly name ${latestJsonPath}.`,
      { contractId: contract.contractId, docsPath, fileId: contract.fileId },
    )]),
    ...(latestMarkdownPresent ? [] : [blocker(
      'report_contract_doc_page_command_section_latest_markdown_missing',
      `${docsPath} command section must explicitly name ${latestMarkdownPath}.`,
      { contractId: contract.contractId, docsPath, mdFileId },
    )]),
    ...(strictGatePresent ? [] : [blocker(
      'report_contract_doc_page_command_section_strict_gate_missing',
      `${docsPath} command section must include the canonical strict-gate sentence.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(safetyPresent ? [] : [blocker(
      'report_contract_doc_page_command_section_safety_missing',
      `${docsPath} command section must include the canonical safety sentence.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(orderValid ? [] : [blocker(
      'report_contract_doc_page_command_section_order_invalid',
      `${docsPath} command section must order heading, command, latest outputs, strict-gate sentence, then safety sentence.`,
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
    status: blockers.length ? 'blocked_report_contract_doc_page_command_section_contract' : 'pass_report_contract_doc_page_command_section_contract',
    ok: blockers.length === 0,
    docsExists,
    sectionPresent: sectionText != null,
    commandPresent: commandLabelPresent && commandSnippetPresent,
    commandMismatch,
    latestJsonPresent,
    latestMarkdownPresent,
    strictGatePresent,
    safetyPresent,
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
    commandPresent: contract.commandPresent === true,
    latestJsonPresent: contract.latestJsonPresent === true,
    latestMarkdownPresent: contract.latestMarkdownPresent === true,
    strictGatePresent: contract.strictGatePresent === true,
    safetyPresent: contract.safetyPresent === true,
    orderValid: contract.orderValid === true,
    blockerCount: contract.blockerCount || 0,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      docsPath: item.docsPath || null,
      fileId: item.fileId || null,
      mdFileId: item.mdFileId || null,
      scriptId: item.scriptId || null,
    })),
  };
}

function analyzeDocPageCommandSections(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract).map((contract) => analyzeContract(contract, input));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_doc_page_command_section_analysis' : 'pass_report_contract_doc_page_command_section_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    uniqueDocsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    sectionCount: contracts.filter((contract) => contract.sectionPresent).length,
    commandCount: contracts.filter((contract) => contract.commandPresent).length,
    latestJsonCount: contracts.filter((contract) => contract.latestJsonPresent).length,
    latestMarkdownCount: contracts.filter((contract) => contract.latestMarkdownPresent).length,
    strictGateCount: contracts.filter((contract) => contract.strictGatePresent).length,
    safetyCount: contracts.filter((contract) => contract.safetyPresent).length,
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
    commandCount: analysis.commandCount || 0,
    latestJsonCount: analysis.latestJsonCount || 0,
    latestMarkdownCount: analysis.latestMarkdownCount || 0,
    strictGateCount: analysis.strictGateCount || 0,
    safetyCount: analysis.safetyCount || 0,
    orderCount: analysis.orderCount || 0,
    blockers: (analysis.blockers || []).map((item) => ({
      code: item.code,
      contractId: item.contractId || null,
      docsPath: item.docsPath || null,
      fileId: item.fileId || null,
      mdFileId: item.mdFileId || null,
      scriptId: item.scriptId || null,
    })),
  };
}

function runScenario(scenario, baseInput) {
  const input = clone(baseInput);
  scenario.mutate(input);
  const analysis = analyzeDocPageCommandSections(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_doc_page_command_section_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract docs page command section analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_doc_page_command_section_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_doc_page_command_section_scenario' : 'pass_report_contract_doc_page_command_section_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractDocPageCommandSectionRegressionInput({
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

export function buildReportContractDocPageCommandSectionRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractDocPageCommandSectionRegressionInput({
    manifest,
    docsByPath,
    docPathOverrides,
  });
  const actual = analyzeDocPageCommandSections(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_doc_page_command_sections',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_REGRESSION_VERSION,
    kind: 'ReportContractDocPageCommandSectionRegression',
    status: blockers.length ? 'blocked_report_contract_doc_page_command_section_regression' : 'pass_report_contract_doc_page_command_section_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docsPaths: uniqueSorted(baseInput.manifest.map((contract) => docsPathFor(contract, baseInput.docPathOverrides))),
      docPathOverrides: baseInput.docPathOverrides,
      sectionHeadingPrefix: SECTION_HEADING_PREFIX,
      strictGateSentence: REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_STRICT_GATE_SENTENCE,
      safetySentence: REPORT_CONTRACT_DOC_PAGE_COMMAND_SECTION_SAFETY_SENTENCE,
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
      commandCount: actual.commandCount,
      latestJsonCount: actual.latestJsonCount,
      latestMarkdownCount: actual.latestMarkdownCount,
      strictGateCount: actual.strictGateCount,
      safetyCount: actual.safetyCount,
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
  const contractDocPageCommandSectionRegressionHash = digest({
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
      scriptId: item.scriptId || null,
      source: item.source || null,
    })),
    safety: report.safety,
  });
  return {
    ...report,
    contractDocPageCommandSectionRegressionHash,
    hash: contractDocPageCommandSectionRegressionHash,
  };
}

export function summarizeReportContractDocPageCommandSectionRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractDocPageCommandSectionRegressionHash: report.contractDocPageCommandSectionRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    uniqueDocsPathCount: report.summary?.uniqueDocsPathCount ?? null,
    docsFileCount: report.summary?.docsFileCount ?? null,
    sectionCount: report.summary?.sectionCount ?? null,
    commandCount: report.summary?.commandCount ?? null,
    latestJsonCount: report.summary?.latestJsonCount ?? null,
    latestMarkdownCount: report.summary?.latestMarkdownCount ?? null,
    strictGateCount: report.summary?.strictGateCount ?? null,
    safetyCount: report.summary?.safetyCount ?? null,
    orderCount: report.summary?.orderCount ?? null,
    scenarioCount: report.summary?.scenarioCount ?? null,
    passedScenarioCount: report.summary?.passedScenarioCount ?? null,
    blockerCount: report.summary?.blockerCount ?? null,
    safety: report.safety || {},
  };
}
