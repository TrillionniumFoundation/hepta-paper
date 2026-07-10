import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-strict-gate-section-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-strict-gate-section-regression';
export const REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_REGRESSION_STEP_ID = 'report_contract_doc_page_strict_gate_section_regression_export';

export const REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_COMMAND_SENTENCE = 'Strict gate command: npm run gate:integration:strict.';
export const REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_PARTICIPATION_SENTENCE = 'Gate participation: this contract is wired into manifest required IDs, sequence, lineage, audit, selftest, selftest lanes, schema, freshness, tooling, output pairing, artifact reproducibility, and architecture checkpoint.';
export const REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_CLOSEOUT_SENTENCE = 'Closeout expectation: final freshness, architecture checkpoint, bootstrap seed clean probe, active seed scan, docs placeholder scan, and diff-check must stay clean.';
export const REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_RECOVERY_SENTENCE = 'Recovery boundary: rerun the clean strict gate before freshness/checkpoint closeout after any post-gate report writer.';

const TARGET_CONTRACT_ID = 'report_contract_manifest';
const SECTION_HEADING_PREFIX = '## Contract Page Strict Gate Section: ';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_strict_gate_section',
    label: 'A new manifest contract is added with docs but without a strict gate section',
    expectedBlockerCode: 'report_contract_doc_page_strict_gate_section_missing',
    mutate(input) {
      const contract = {
        contractId: 'report_future_doc_page_strict_gate_section',
        label: 'Report future doc page strict gate section',
        scriptId: 'reports:future-doc-page-strict-gate-section',
        fileId: 'report-future-doc-page-strict-gate-section-latest.json',
      };
      input.manifest.push(contract);
      input.docsByPath[docsPathFor(contract, input.docPathOverrides)] = '# Report Future Doc Page Strict Gate Section\n';
    },
  }),
  Object.freeze({
    scenarioId: 'strict_gate_command_missing',
    label: 'A contract strict gate section loses its strict gate command',
    expectedBlockerCode: 'report_contract_doc_page_strict_gate_section_command_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_COMMAND_SENTENCE, ''));
    },
  }),
  Object.freeze({
    scenarioId: 'strict_gate_command_wording_drift',
    label: 'A contract strict gate section loses the exact integration strict gate command',
    expectedBlockerCode: 'report_contract_doc_page_strict_gate_section_command_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace('npm run gate:integration:strict', 'npm run gate:integration'));
    },
  }),
  Object.freeze({
    scenarioId: 'gate_participation_missing',
    label: 'A contract strict gate section loses its cross-report participation sentence',
    expectedBlockerCode: 'report_contract_doc_page_strict_gate_section_participation_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_PARTICIPATION_SENTENCE, ''));
    },
  }),
  Object.freeze({
    scenarioId: 'gate_participation_terms_missing',
    label: 'A contract strict gate section loses key cross-report binding terms',
    expectedBlockerCode: 'report_contract_doc_page_strict_gate_section_participation_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace('schema, freshness, tooling, output pairing, artifact reproducibility, and architecture checkpoint', 'schema and freshness'));
    },
  }),
  Object.freeze({
    scenarioId: 'closeout_expectation_missing',
    label: 'A contract strict gate section loses its final closeout expectation',
    expectedBlockerCode: 'report_contract_doc_page_strict_gate_section_closeout_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_CLOSEOUT_SENTENCE, ''));
    },
  }),
  Object.freeze({
    scenarioId: 'closeout_probe_terms_missing',
    label: 'A contract strict gate section loses seed or docs scan closeout terms',
    expectedBlockerCode: 'report_contract_doc_page_strict_gate_section_closeout_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace('bootstrap seed clean probe, active seed scan, docs placeholder scan, ', ''));
    },
  }),
  Object.freeze({
    scenarioId: 'recovery_boundary_missing',
    label: 'A contract strict gate section loses its post-gate writer recovery boundary',
    expectedBlockerCode: 'report_contract_doc_page_strict_gate_section_recovery_missing',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_RECOVERY_SENTENCE, ''));
    },
  }),
  Object.freeze({
    scenarioId: 'strict_gate_section_order_drift',
    label: 'A contract strict gate section moves recovery before closeout',
    expectedBlockerCode: 'report_contract_doc_page_strict_gate_section_order_invalid',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(
          `${REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_CLOSEOUT_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_RECOVERY_SENTENCE}`,
          `${REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_RECOVERY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_CLOSEOUT_SENTENCE}`,
        ));
    },
  }),
  Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: 'report_contract_doc_page_strict_gate_section_docs_missing',
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

export function strictGateSectionHeadingFor(contractId = '') {
  return `${SECTION_HEADING_PREFIX}${contractId}`;
}

export function buildReportContractDocPageStrictGateSectionMarkdownBlock(contract = {}) {
  return [
    strictGateSectionHeadingFor(contract.contractId),
    '',
    REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_COMMAND_SENTENCE,
    '',
    REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_PARTICIPATION_SENTENCE,
    '',
    REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_CLOSEOUT_SENTENCE,
    '',
    REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_RECOVERY_SENTENCE,
    '',
  ].join('\n');
}

function extractStrictGateSection(text = '', contractId = '') {
  const heading = strictGateSectionHeadingFor(contractId);
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

function replaceStrictGateSection(text = '', contractId = '', replacer = (section) => section) {
  const heading = strictGateSectionHeadingFor(contractId);
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
  input.docsByPath[docsPath] = replaceStrictGateSection(
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
  const sectionText = docsExists ? extractStrictGateSection(docsText, contract.contractId) : null;
  const mdFileId = markdownFileIdFor(contract.fileId);
  const expectedParts = [
    { key: 'sectionHeading', part: strictGateSectionHeadingFor(contract.contractId) },
    { key: 'command', part: REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_COMMAND_SENTENCE },
    { key: 'participation', part: REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_PARTICIPATION_SENTENCE },
    { key: 'closeout', part: REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_CLOSEOUT_SENTENCE },
    { key: 'recovery', part: REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_RECOVERY_SENTENCE },
  ];
  const positions = Object.fromEntries(expectedParts.map((entry) => [
    entry.key,
    sectionText == null ? -1 : indexOfPart(sectionText, entry.part),
  ]));
  const commandPresent = positions.command >= 0
    && /npm run gate:integration:strict/.test(sectionText || '');
  const participationPresent = positions.participation >= 0
    && [
      'manifest required IDs',
      'sequence',
      'lineage',
      'audit',
      'selftest',
      'selftest lanes',
      'schema',
      'freshness',
      'tooling',
      'output pairing',
      'artifact reproducibility',
      'architecture checkpoint',
    ].every((term) => String(sectionText || '').includes(term));
  const closeoutPresent = positions.closeout >= 0
    && [
      'final freshness',
      'architecture checkpoint',
      'bootstrap seed clean probe',
      'active seed scan',
      'docs placeholder scan',
      'diff-check',
    ].every((term) => String(sectionText || '').includes(term));
  const recoveryPresent = positions.recovery >= 0
    && ['clean strict gate', 'freshness/checkpoint closeout', 'post-gate report writer'].every((term) => String(sectionText || '').includes(term));
  const orderValues = expectedParts.map((entry) => positions[entry.key]);
  const orderValid = sectionText != null
    && orderValues.every((position) => position >= 0)
    && orderValues.every((position, index, values) => index === 0 || values[index - 1] < position);
  const blockers = [
    ...(docsExists ? [] : [blocker(
      'report_contract_doc_page_strict_gate_section_docs_missing',
      `${contract.contractId} docs file must exist at ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(sectionText != null ? [] : [blocker(
      'report_contract_doc_page_strict_gate_section_missing',
      `${docsPath} must include ${strictGateSectionHeadingFor(contract.contractId)}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(commandPresent ? [] : [blocker(
      'report_contract_doc_page_strict_gate_section_command_missing',
      `${docsPath} strict gate section must include the canonical strict gate command.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(participationPresent ? [] : [blocker(
      'report_contract_doc_page_strict_gate_section_participation_missing',
      `${docsPath} strict gate section must include the canonical cross-report participation sentence.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(closeoutPresent ? [] : [blocker(
      'report_contract_doc_page_strict_gate_section_closeout_missing',
      `${docsPath} strict gate section must include the canonical final closeout expectation.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(recoveryPresent ? [] : [blocker(
      'report_contract_doc_page_strict_gate_section_recovery_missing',
      `${docsPath} strict gate section must include the canonical post-gate writer recovery boundary.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(orderValid ? [] : [blocker(
      'report_contract_doc_page_strict_gate_section_order_invalid',
      `${docsPath} strict gate section must order heading, command, participation, closeout, then recovery.`,
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
    status: blockers.length ? 'blocked_report_contract_doc_page_strict_gate_section_contract' : 'pass_report_contract_doc_page_strict_gate_section_contract',
    ok: blockers.length === 0,
    docsExists,
    sectionPresent: sectionText != null,
    commandPresent,
    participationPresent,
    closeoutPresent,
    recoveryPresent,
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
    participationPresent: contract.participationPresent === true,
    closeoutPresent: contract.closeoutPresent === true,
    recoveryPresent: contract.recoveryPresent === true,
    orderValid: contract.orderValid === true,
    blockerCount: contract.blockerCount || 0,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      docsPath: item.docsPath || null,
    })),
  };
}

function analyzeDocPageStrictGateSections(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract).map((contract) => analyzeContract(contract, input));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_doc_page_strict_gate_section_analysis' : 'pass_report_contract_doc_page_strict_gate_section_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    uniqueDocsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    sectionCount: contracts.filter((contract) => contract.sectionPresent).length,
    commandCount: contracts.filter((contract) => contract.commandPresent).length,
    participationCount: contracts.filter((contract) => contract.participationPresent).length,
    closeoutCount: contracts.filter((contract) => contract.closeoutPresent).length,
    recoveryCount: contracts.filter((contract) => contract.recoveryPresent).length,
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
    participationCount: analysis.participationCount || 0,
    closeoutCount: analysis.closeoutCount || 0,
    recoveryCount: analysis.recoveryCount || 0,
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
  const analysis = analyzeDocPageStrictGateSections(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_doc_page_strict_gate_section_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract docs page strict gate section analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_doc_page_strict_gate_section_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_doc_page_strict_gate_section_scenario' : 'pass_report_contract_doc_page_strict_gate_section_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractDocPageStrictGateSectionRegressionInput({
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

export function buildReportContractDocPageStrictGateSectionRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractDocPageStrictGateSectionRegressionInput({
    manifest,
    docsByPath,
    docPathOverrides,
  });
  const actual = analyzeDocPageStrictGateSections(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_doc_page_strict_gate_sections',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_REGRESSION_VERSION,
    kind: 'ReportContractDocPageStrictGateSectionRegression',
    status: blockers.length ? 'blocked_report_contract_doc_page_strict_gate_section_regression' : 'pass_report_contract_doc_page_strict_gate_section_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docsPaths: uniqueSorted(baseInput.manifest.map((contract) => docsPathFor(contract, baseInput.docPathOverrides))),
      docPathOverrides: baseInput.docPathOverrides,
      sectionHeadingPrefix: SECTION_HEADING_PREFIX,
      commandSentence: REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_COMMAND_SENTENCE,
      participationSentence: REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_PARTICIPATION_SENTENCE,
      closeoutSentence: REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_CLOSEOUT_SENTENCE,
      recoverySentence: REPORT_CONTRACT_DOC_PAGE_STRICT_GATE_SECTION_RECOVERY_SENTENCE,
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
      participationCount: actual.participationCount,
      closeoutCount: actual.closeoutCount,
      recoveryCount: actual.recoveryCount,
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
  const contractDocPageStrictGateSectionRegressionHash = digest({
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
    contractDocPageStrictGateSectionRegressionHash,
    hash: contractDocPageStrictGateSectionRegressionHash,
  };
}

export function summarizeReportContractDocPageStrictGateSectionRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractDocPageStrictGateSectionRegressionHash: report.contractDocPageStrictGateSectionRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    uniqueDocsPathCount: report.summary?.uniqueDocsPathCount ?? null,
    docsFileCount: report.summary?.docsFileCount ?? null,
    sectionCount: report.summary?.sectionCount ?? null,
    commandCount: report.summary?.commandCount ?? null,
    participationCount: report.summary?.participationCount ?? null,
    closeoutCount: report.summary?.closeoutCount ?? null,
    recoveryCount: report.summary?.recoveryCount ?? null,
    orderCount: report.summary?.orderCount ?? null,
    scenarioCount: report.summary?.scenarioCount ?? null,
    passedScenarioCount: report.summary?.passedScenarioCount ?? null,
    blockerCount: report.summary?.blockerCount ?? null,
    safety: report.safety || {},
  };
}
