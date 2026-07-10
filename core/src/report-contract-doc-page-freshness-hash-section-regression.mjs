import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-freshness-hash-section-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-freshness-hash-section-regression';
export const REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_REGRESSION_STEP_ID = 'report_contract_doc_page_freshness_hash_section_regression_export';

export const REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_GATE_HASH_PARITY_SENTENCE = 'Gate hash parity binding: reports/report-freshness-latest.json must match every gate-comparable latest report hash to the clean strict gate summary.';
export const REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_COMPARABLE_GATE_COUNT_SENTENCE = 'Comparable gate count binding: final freshness must expose comparableGateReportCount and gateHashMatchCount as equal counts with gateHashMismatchCount=0.';
export const REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_MISSING_HASH_BLOCKER_SENTENCE = 'Missing hash blocker binding: missing or non-sha256 latest report hashes must stay fail-closed through report freshness blockers.';
export const REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_GATE_REPORT_INCLUSION_SENTENCE = 'Gate report inclusion binding: final freshness must run with includeGateReport=true and gateReportHashMatchesFile=true.';
export const REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_RECOVERY_ORDERING_SENTENCE = 'Recovery ordering binding: after any post-gate writer, recovery must rerun npm run gate:integration:strict before npm run reports:freshness and checkpoint:architecture.';
export const REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_FRESHNESS_HASH_SAFETY_SENTENCE = 'Freshness/hash safety boundary: freshness/hash sections must state local-only read-only verification, no external actions, and no execution permission grant.';

export const REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_SENTENCES = Object.freeze([
  Object.freeze({
    key: 'gateHashParityBinding',
    label: 'gate hash parity',
    blockerCode: 'report_contract_doc_page_freshness_hash_section_gate_hash_parity_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_GATE_HASH_PARITY_SENTENCE,
  }),
  Object.freeze({
    key: 'comparableGateCountBinding',
    label: 'comparable gate count',
    blockerCode: 'report_contract_doc_page_freshness_hash_section_comparable_gate_count_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_COMPARABLE_GATE_COUNT_SENTENCE,
  }),
  Object.freeze({
    key: 'missingHashBlockerBinding',
    label: 'missing hash blocker',
    blockerCode: 'report_contract_doc_page_freshness_hash_section_missing_hash_blocker_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_MISSING_HASH_BLOCKER_SENTENCE,
  }),
  Object.freeze({
    key: 'gateReportInclusionBinding',
    label: 'gate report inclusion',
    blockerCode: 'report_contract_doc_page_freshness_hash_section_gate_report_inclusion_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_GATE_REPORT_INCLUSION_SENTENCE,
  }),
  Object.freeze({
    key: 'recoveryOrderingBinding',
    label: 'recovery ordering',
    blockerCode: 'report_contract_doc_page_freshness_hash_section_recovery_ordering_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_RECOVERY_ORDERING_SENTENCE,
  }),
  Object.freeze({
    key: 'freshnessHashSafetyBoundary',
    label: 'freshness/hash safety',
    blockerCode: 'report_contract_doc_page_freshness_hash_section_freshness_hash_safety_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_FRESHNESS_HASH_SAFETY_SENTENCE,
  }),
]);

const TARGET_CONTRACT_ID = 'report_contract_manifest';
const SECTION_HEADING_PREFIX = '## Contract Page Freshness Hash Section: ';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_freshness_hash_section',
    label: 'A new manifest contract is added with docs but without a freshness hash section',
    expectedBlockerCode: 'report_contract_doc_page_freshness_hash_section_missing',
    mutate(input) {
      const contract = {
        contractId: 'report_future_doc_page_freshness_hash_section',
        label: 'Report future doc page freshness hash section',
        scriptId: 'reports:future-doc-page-freshness-hash-section',
        fileId: 'report-future-doc-page-freshness-hash-section-latest.json',
      };
      input.manifest.push(contract);
      input.docsByPath[docsPathFor(contract, input.docPathOverrides)] = '# Report Future Doc Page Freshness Hash Section\n';
    },
  }),
  ...REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_SENTENCES.map((binding) => Object.freeze({
    scenarioId: `${binding.label.replace(/\s+/g, '_')}_binding_missing`,
    label: `A contract freshness hash section loses its ${binding.label} binding sentence`,
    expectedBlockerCode: binding.blockerCode,
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section.replace(binding.sentence, ''));
    },
  })),
  Object.freeze({
    scenarioId: 'freshness_hash_section_order_drift',
    label: 'A contract freshness hash section moves freshness/hash safety before gate hash parity',
    expectedBlockerCode: 'report_contract_doc_page_freshness_hash_section_order_invalid',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(
          `${REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_GATE_HASH_PARITY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_COMPARABLE_GATE_COUNT_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_MISSING_HASH_BLOCKER_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_GATE_REPORT_INCLUSION_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_RECOVERY_ORDERING_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_FRESHNESS_HASH_SAFETY_SENTENCE}`,
          `${REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_FRESHNESS_HASH_SAFETY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_GATE_HASH_PARITY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_COMPARABLE_GATE_COUNT_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_MISSING_HASH_BLOCKER_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_GATE_REPORT_INCLUSION_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_RECOVERY_ORDERING_SENTENCE}`,
        ));
    },
  }),
  Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: 'report_contract_doc_page_freshness_hash_section_docs_missing',
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

export function freshnessHashSectionHeadingFor(contractId = '') {
  return `${SECTION_HEADING_PREFIX}${contractId}`;
}

export function buildReportContractDocPageFreshnessHashSectionMarkdownBlock(contract = {}) {
  return [
    freshnessHashSectionHeadingFor(contract.contractId),
    '',
    ...REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_SENTENCES.flatMap((binding) => [
      binding.sentence,
      '',
    ]),
  ].join('\n');
}

function extractFreshnessHashSection(text = '', contractId = '') {
  const heading = freshnessHashSectionHeadingFor(contractId);
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

function replaceFreshnessHashSection(text = '', contractId = '', replacer = (section) => section) {
  const heading = freshnessHashSectionHeadingFor(contractId);
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
  input.docsByPath[docsPath] = replaceFreshnessHashSection(
    input.docsByPath[docsPath] || '',
    contract.contractId,
    (section) => sectionMutator(section, contract),
  );
}

function indexOfPart(sectionText = '', part = '') {
  return String(sectionText || '').indexOf(part);
}

function expectedPartsFor(contract = {}) {
  return [
    { key: 'sectionHeading', part: freshnessHashSectionHeadingFor(contract.contractId) },
    ...REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_SENTENCES.map((binding) => ({
      key: binding.key,
      part: binding.sentence,
    })),
  ];
}

function presenceKey(bindingKey = '') {
  return `${bindingKey}Present`;
}

function countPresent(contracts = [], bindingKey = '') {
  return contracts.filter((contract) => contract[presenceKey(bindingKey)]).length;
}

function analyzeContract(contract = {}, input = {}) {
  const docsPath = docsPathFor(contract, input.docPathOverrides);
  const docsExists = Object.hasOwn(input.docsByPath || {}, docsPath);
  const docsText = docsExists ? String(input.docsByPath[docsPath] || '') : '';
  const sectionText = docsExists ? extractFreshnessHashSection(docsText, contract.contractId) : null;
  const expectedParts = expectedPartsFor(contract);
  const positions = Object.fromEntries(expectedParts.map((entry) => [
    entry.key,
    sectionText == null ? -1 : indexOfPart(sectionText, entry.part),
  ]));
  const bindingPresence = Object.fromEntries(
    REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_SENTENCES.map((binding) => [
      presenceKey(binding.key),
      positions[binding.key] >= 0,
    ]),
  );
  const orderValues = expectedParts.map((entry) => positions[entry.key]);
  const orderValid = sectionText != null
    && orderValues.every((position) => position >= 0)
    && orderValues.every((position, index, values) => index === 0 || values[index - 1] < position);
  const blockers = [
    ...(docsExists ? [] : [blocker(
      'report_contract_doc_page_freshness_hash_section_docs_missing',
      `${contract.contractId} docs file must exist at ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(sectionText != null ? [] : [blocker(
      'report_contract_doc_page_freshness_hash_section_missing',
      `${docsPath} must include ${freshnessHashSectionHeadingFor(contract.contractId)}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_SENTENCES.flatMap((binding) => (
      bindingPresence[presenceKey(binding.key)] ? [] : [blocker(
        binding.blockerCode,
        `${docsPath} freshness hash section must include the canonical ${binding.label} binding sentence.`,
        { contractId: contract.contractId, docsPath },
      )]
    )),
    ...(orderValid ? [] : [blocker(
      'report_contract_doc_page_freshness_hash_section_order_invalid',
      `${docsPath} freshness hash section must order heading, gate hash parity, comparable gate count, missing hash blocker, gate report inclusion, recovery ordering, then freshness/hash safety.`,
      { contractId: contract.contractId, docsPath, positions },
    )]),
  ];
  return {
    contractId: contract.contractId,
    label: contract.label,
    scriptId: contract.scriptId,
    fileId: contract.fileId,
    docsPath,
    status: blockers.length ? 'blocked_report_contract_doc_page_freshness_hash_section_contract' : 'pass_report_contract_doc_page_freshness_hash_section_contract',
    ok: blockers.length === 0,
    docsExists,
    sectionPresent: sectionText != null,
    ...bindingPresence,
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
    docsPath: contract.docsPath,
    status: contract.status,
    ok: contract.ok === true,
    docsExists: contract.docsExists === true,
    sectionPresent: contract.sectionPresent === true,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_SENTENCES.map((binding) => [
      presenceKey(binding.key),
      contract[presenceKey(binding.key)] === true,
    ])),
    orderValid: contract.orderValid === true,
    blockerCount: contract.blockerCount || 0,
    blockers: (contract.blockers || []).map((item) => ({
      code: item.code,
      docsPath: item.docsPath || null,
    })),
  };
}

function analyzeDocPageFreshnessHashSections(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract).map((contract) => analyzeContract(contract, input));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_doc_page_freshness_hash_section_analysis' : 'pass_report_contract_doc_page_freshness_hash_section_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    uniqueDocsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    sectionCount: contracts.filter((contract) => contract.sectionPresent).length,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_SENTENCES.map((binding) => [
      `${binding.key}Count`,
      countPresent(contracts, binding.key),
    ])),
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
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_SENTENCES.map((binding) => [
      `${binding.key}Count`,
      analysis[`${binding.key}Count`] || 0,
    ])),
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
  const analysis = analyzeDocPageFreshnessHashSections(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_doc_page_freshness_hash_section_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract docs page freshness hash section analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_doc_page_freshness_hash_section_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_doc_page_freshness_hash_section_scenario' : 'pass_report_contract_doc_page_freshness_hash_section_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractDocPageFreshnessHashSectionRegressionInput({
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

export function buildReportContractDocPageFreshnessHashSectionRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractDocPageFreshnessHashSectionRegressionInput({
    manifest,
    docsByPath,
    docPathOverrides,
  });
  const actual = analyzeDocPageFreshnessHashSections(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_doc_page_freshness_hash_sections',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_REGRESSION_VERSION,
    kind: 'ReportContractDocPageFreshnessHashSectionRegression',
    status: blockers.length ? 'blocked_report_contract_doc_page_freshness_hash_section_regression' : 'pass_report_contract_doc_page_freshness_hash_section_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docsPaths: uniqueSorted(baseInput.manifest.map((contract) => docsPathFor(contract, baseInput.docPathOverrides))),
      docPathOverrides: baseInput.docPathOverrides,
      sectionHeadingPrefix: SECTION_HEADING_PREFIX,
      requiredSentences: REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_SENTENCES.map((binding) => ({
        key: binding.key,
        label: binding.label,
        blockerCode: binding.blockerCode,
        sentence: binding.sentence,
      })),
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
      ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_SENTENCES.map((binding) => [
        `${binding.key}Count`,
        actual[`${binding.key}Count`],
      ])),
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
  const contractDocPageFreshnessHashSectionRegressionHash = digest({
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
    contractDocPageFreshnessHashSectionRegressionHash,
    hash: contractDocPageFreshnessHashSectionRegressionHash,
  };
}

export function summarizeReportContractDocPageFreshnessHashSectionRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractDocPageFreshnessHashSectionRegressionHash: report.contractDocPageFreshnessHashSectionRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    uniqueDocsPathCount: report.summary?.uniqueDocsPathCount ?? null,
    docsFileCount: report.summary?.docsFileCount ?? null,
    sectionCount: report.summary?.sectionCount ?? null,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_FRESHNESS_HASH_SECTION_SENTENCES.map((binding) => [
      `${binding.key}Count`,
      report.summary?.[`${binding.key}Count`] ?? null,
    ])),
    orderCount: report.summary?.orderCount ?? null,
    scenarioCount: report.summary?.scenarioCount ?? null,
    passedScenarioCount: report.summary?.passedScenarioCount ?? null,
    blockerCount: report.summary?.blockerCount ?? null,
    safety: report.safety || {},
  };
}
