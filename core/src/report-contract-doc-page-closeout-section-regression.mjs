import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-closeout-section-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-closeout-section-regression';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_REGRESSION_STEP_ID = 'report_contract_doc_page_closeout_section_regression_export';

export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_FINAL_FRESHNESS_PROBE_SENTENCE = 'Final freshness probe: npm run reports:freshness must pass after the clean strict gate and match every gate-comparable latest hash.';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_CHECKPOINT_PROBE_SENTENCE = 'Architecture checkpoint probe: npm run checkpoint:architecture must pass and expose this contract hash, scenario counts, and blockers.';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_BOOTSTRAP_SEED_CLEAN_PROBE_SENTENCE = 'Bootstrap seed clean probe: npm run reports:bootstrap-seeds -- --strict must write zero seeds and skip every allowlisted final latest report.';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_ACTIVE_SEED_PROBE_SENTENCE = 'Active seed probe: final allowlisted latest reports must not expose active bootstrap seed markers or seed reasons.';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_DOCS_PLACEHOLDER_PROBE_SENTENCE = 'Docs placeholder probe: docs, README.md, and reports/README.md must not contain placeholder text before closeout.';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_DIFF_CHECK_PROBE_SENTENCE = 'Diff-check probe: git diff --check -- . must stay clean before closeout.';

export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_SENTENCES = Object.freeze([
  Object.freeze({
    key: 'finalFreshnessProbe',
    label: 'final freshness',
    blockerCode: 'report_contract_doc_page_closeout_section_final_freshness_probe_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_FINAL_FRESHNESS_PROBE_SENTENCE,
  }),
  Object.freeze({
    key: 'checkpointProbe',
    label: 'checkpoint',
    blockerCode: 'report_contract_doc_page_closeout_section_checkpoint_probe_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_CHECKPOINT_PROBE_SENTENCE,
  }),
  Object.freeze({
    key: 'bootstrapSeedCleanProbe',
    label: 'bootstrap seed clean',
    blockerCode: 'report_contract_doc_page_closeout_section_bootstrap_seed_clean_probe_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_BOOTSTRAP_SEED_CLEAN_PROBE_SENTENCE,
  }),
  Object.freeze({
    key: 'activeSeedProbe',
    label: 'active seed',
    blockerCode: 'report_contract_doc_page_closeout_section_active_seed_probe_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_ACTIVE_SEED_PROBE_SENTENCE,
  }),
  Object.freeze({
    key: 'docsPlaceholderProbe',
    label: 'docs placeholder',
    blockerCode: 'report_contract_doc_page_closeout_section_docs_placeholder_probe_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_DOCS_PLACEHOLDER_PROBE_SENTENCE,
  }),
  Object.freeze({
    key: 'diffCheckProbe',
    label: 'diff-check',
    blockerCode: 'report_contract_doc_page_closeout_section_diff_check_probe_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_DIFF_CHECK_PROBE_SENTENCE,
  }),
]);

const TARGET_CONTRACT_ID = 'report_contract_manifest';
const SECTION_HEADING_PREFIX = '## Contract Page Closeout Section: ';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_closeout_section',
    label: 'A new manifest contract is added with docs but without a closeout section',
    expectedBlockerCode: 'report_contract_doc_page_closeout_section_missing',
    mutate(input) {
      const contract = {
        contractId: 'report_future_doc_page_closeout_section',
        label: 'Report future doc page closeout section',
        scriptId: 'reports:future-doc-page-closeout-section',
        fileId: 'report-future-doc-page-closeout-section-latest.json',
      };
      input.manifest.push(contract);
      input.docsByPath[docsPathFor(contract, input.docPathOverrides)] = '# Report Future Doc Page Closeout Section\n';
    },
  }),
  ...REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_SENTENCES.map((binding) => Object.freeze({
    scenarioId: `${binding.label.replace(/\s+/g, '_')}_binding_missing`,
    label: `A contract closeout section loses its ${binding.label} binding sentence`,
    expectedBlockerCode: binding.blockerCode,
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section.replace(binding.sentence, ''));
    },
  })),
  Object.freeze({
    scenarioId: 'closeout_section_order_drift',
    label: 'A contract closeout section moves diff-check before final freshness',
    expectedBlockerCode: 'report_contract_doc_page_closeout_section_order_invalid',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(
          `${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_FINAL_FRESHNESS_PROBE_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_CHECKPOINT_PROBE_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_BOOTSTRAP_SEED_CLEAN_PROBE_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_ACTIVE_SEED_PROBE_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_DOCS_PLACEHOLDER_PROBE_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_DIFF_CHECK_PROBE_SENTENCE}`,
          `${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_DIFF_CHECK_PROBE_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_FINAL_FRESHNESS_PROBE_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_CHECKPOINT_PROBE_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_BOOTSTRAP_SEED_CLEAN_PROBE_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_ACTIVE_SEED_PROBE_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_DOCS_PLACEHOLDER_PROBE_SENTENCE}`,
        ));
    },
  }),
  Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: 'report_contract_doc_page_closeout_section_docs_missing',
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

export function closeoutSectionHeadingFor(contractId = '') {
  return `${SECTION_HEADING_PREFIX}${contractId}`;
}

export function buildReportContractDocPageCloseoutSectionMarkdownBlock(contract = {}) {
  return [
    closeoutSectionHeadingFor(contract.contractId),
    '',
    ...REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_SENTENCES.flatMap((binding) => [
      binding.sentence,
      '',
    ]),
  ].join('\n');
}

function extractCloseoutSection(text = '', contractId = '') {
  const heading = closeoutSectionHeadingFor(contractId);
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

function replaceCloseoutSection(text = '', contractId = '', replacer = (section) => section) {
  const heading = closeoutSectionHeadingFor(contractId);
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
  input.docsByPath[docsPath] = replaceCloseoutSection(
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
    { key: 'sectionHeading', part: closeoutSectionHeadingFor(contract.contractId) },
    ...REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_SENTENCES.map((binding) => ({
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
  const sectionText = docsExists ? extractCloseoutSection(docsText, contract.contractId) : null;
  const expectedParts = expectedPartsFor(contract);
  const positions = Object.fromEntries(expectedParts.map((entry) => [
    entry.key,
    sectionText == null ? -1 : indexOfPart(sectionText, entry.part),
  ]));
  const bindingPresence = Object.fromEntries(
    REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_SENTENCES.map((binding) => [
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
      'report_contract_doc_page_closeout_section_docs_missing',
      `${contract.contractId} docs file must exist at ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(sectionText != null ? [] : [blocker(
      'report_contract_doc_page_closeout_section_missing',
      `${docsPath} must include ${closeoutSectionHeadingFor(contract.contractId)}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_SENTENCES.flatMap((binding) => (
      bindingPresence[presenceKey(binding.key)] ? [] : [blocker(
        binding.blockerCode,
        `${docsPath} closeout section must include the canonical ${binding.label} binding sentence.`,
        { contractId: contract.contractId, docsPath },
      )]
    )),
    ...(orderValid ? [] : [blocker(
      'report_contract_doc_page_closeout_section_order_invalid',
      `${docsPath} closeout section must order heading, final freshness, checkpoint, bootstrap seed clean, active seed, docs placeholder, then diff-check.`,
      { contractId: contract.contractId, docsPath, positions },
    )]),
  ];
  return {
    contractId: contract.contractId,
    label: contract.label,
    scriptId: contract.scriptId,
    fileId: contract.fileId,
    docsPath,
    status: blockers.length ? 'blocked_report_contract_doc_page_closeout_section_contract' : 'pass_report_contract_doc_page_closeout_section_contract',
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
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_SENTENCES.map((binding) => [
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

function analyzeDocPageCloseoutSections(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract).map((contract) => analyzeContract(contract, input));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_doc_page_closeout_section_analysis' : 'pass_report_contract_doc_page_closeout_section_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    uniqueDocsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    sectionCount: contracts.filter((contract) => contract.sectionPresent).length,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_SENTENCES.map((binding) => [
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
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_SENTENCES.map((binding) => [
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
  const analysis = analyzeDocPageCloseoutSections(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_doc_page_closeout_section_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract docs page closeout section analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_doc_page_closeout_section_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_doc_page_closeout_section_scenario' : 'pass_report_contract_doc_page_closeout_section_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractDocPageCloseoutSectionRegressionInput({
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

export function buildReportContractDocPageCloseoutSectionRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractDocPageCloseoutSectionRegressionInput({
    manifest,
    docsByPath,
    docPathOverrides,
  });
  const actual = analyzeDocPageCloseoutSections(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_doc_page_closeout_sections',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_REGRESSION_VERSION,
    kind: 'ReportContractDocPageCloseoutSectionRegression',
    status: blockers.length ? 'blocked_report_contract_doc_page_closeout_section_regression' : 'pass_report_contract_doc_page_closeout_section_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docsPaths: uniqueSorted(baseInput.manifest.map((contract) => docsPathFor(contract, baseInput.docPathOverrides))),
      docPathOverrides: baseInput.docPathOverrides,
      sectionHeadingPrefix: SECTION_HEADING_PREFIX,
      requiredSentences: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_SENTENCES.map((binding) => ({
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
      ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_SENTENCES.map((binding) => [
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
  const contractDocPageCloseoutSectionRegressionHash = digest({
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
    contractDocPageCloseoutSectionRegressionHash,
    hash: contractDocPageCloseoutSectionRegressionHash,
  };
}

export function summarizeReportContractDocPageCloseoutSectionRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractDocPageCloseoutSectionRegressionHash: report.contractDocPageCloseoutSectionRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    uniqueDocsPathCount: report.summary?.uniqueDocsPathCount ?? null,
    docsFileCount: report.summary?.docsFileCount ?? null,
    sectionCount: report.summary?.sectionCount ?? null,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_SECTION_SENTENCES.map((binding) => [
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
