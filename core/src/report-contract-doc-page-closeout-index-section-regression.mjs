import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-closeout-index-section-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-closeout-index-section-regression';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_REGRESSION_STEP_ID = 'report_contract_doc_page_closeout_index_section_regression_export';

export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_STRICT_GATE_INDEX_SENTENCE = 'Strict gate index binding: closeout index sections must name npm run gate:integration:strict as the first indexed closeout command before any final report probe.';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_RETENTION_DRY_RUN_INDEX_SENTENCE = 'Retention dry-run index binding: closeout index sections must name npm run reports:prune:dry-run after the strict gate and require archivedCount=0 for current latest artifacts.';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_FRESHNESS_CHECKPOINT_INDEX_SENTENCE = 'Freshness/checkpoint index binding: closeout index sections must name npm run reports:freshness followed by npm run checkpoint:architecture, require gateHashMismatchCount=0, and require the checkpoint to bind the final report freshness hash.';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SEED_CLEAN_INDEX_SENTENCE = 'Seed-clean index binding: closeout index sections must name npm run reports:bootstrap-seeds -- --strict after checkpoint and require seededFileCount=0 with skippedFileCount=5.';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_FINAL_SCANS_INDEX_SENTENCE = 'Final scans index binding: closeout index sections must require a final active bootstrap seed marker scan and placeholder token scan with zero active seed markers and zero real placeholder tokens.';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_DIFF_CHECK_SAFETY_SENTENCE = 'Diff-check safety index binding: closeout index sections must require git diff --check -- . after all local report/doc/code writes and state local-only verification, no external actions, and no execution permission grant.';

export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SENTENCES = Object.freeze([
  Object.freeze({
    key: 'strictGateIndexBinding',
    label: 'strict gate index',
    blockerCode: 'report_contract_doc_page_closeout_index_section_strict_gate_index_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_STRICT_GATE_INDEX_SENTENCE,
  }),
  Object.freeze({
    key: 'retentionDryRunIndexBinding',
    label: 'retention dry-run index',
    blockerCode: 'report_contract_doc_page_closeout_index_section_retention_dry_run_index_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_RETENTION_DRY_RUN_INDEX_SENTENCE,
  }),
  Object.freeze({
    key: 'freshnessCheckpointIndexBinding',
    label: 'freshness/checkpoint index',
    blockerCode: 'report_contract_doc_page_closeout_index_section_freshness_checkpoint_index_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_FRESHNESS_CHECKPOINT_INDEX_SENTENCE,
  }),
  Object.freeze({
    key: 'seedCleanIndexBinding',
    label: 'seed-clean index',
    blockerCode: 'report_contract_doc_page_closeout_index_section_seed_clean_index_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SEED_CLEAN_INDEX_SENTENCE,
  }),
  Object.freeze({
    key: 'finalScansIndexBinding',
    label: 'final scans index',
    blockerCode: 'report_contract_doc_page_closeout_index_section_final_scans_index_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_FINAL_SCANS_INDEX_SENTENCE,
  }),
  Object.freeze({
    key: 'diffCheckSafetyBinding',
    label: 'diff-check safety index',
    blockerCode: 'report_contract_doc_page_closeout_index_section_diff_check_safety_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_DIFF_CHECK_SAFETY_SENTENCE,
  }),
]);

const TARGET_CONTRACT_ID = 'report_contract_manifest';
const SECTION_HEADING_PREFIX = '## Contract Page Closeout Index Section: ';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_closeout_index_section',
    label: 'A new manifest contract is added with docs but without a closeout index section',
    expectedBlockerCode: 'report_contract_doc_page_closeout_index_section_missing',
    mutate(input) {
      const contract = {
        contractId: 'report_future_doc_page_closeout_index_section',
        label: 'Report future doc page closeout index section',
        scriptId: 'reports:future-doc-page-closeout-index-section',
        fileId: 'report-future-doc-page-closeout-index-section-latest.json',
      };
      input.manifest.push(contract);
      input.docsByPath[docsPathFor(contract, input.docPathOverrides)] = '# Report Future Doc Page Closeout Index Section\n';
    },
  }),
  ...REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SENTENCES.map((binding) => Object.freeze({
    scenarioId: `${binding.label.replace(/\s+/g, '_')}_binding_missing`,
    label: `A contract closeout index section loses its ${binding.label} binding sentence`,
    expectedBlockerCode: binding.blockerCode,
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section.replace(binding.sentence, ''));
    },
  })),
  Object.freeze({
    scenarioId: 'closeout_index_section_order_drift',
    label: 'A contract closeout index section moves diff-check safety before the indexed closeout commands',
    expectedBlockerCode: 'report_contract_doc_page_closeout_index_section_order_invalid',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(
          `${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_STRICT_GATE_INDEX_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_RETENTION_DRY_RUN_INDEX_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_FRESHNESS_CHECKPOINT_INDEX_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SEED_CLEAN_INDEX_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_FINAL_SCANS_INDEX_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_DIFF_CHECK_SAFETY_SENTENCE}`,
          `${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_DIFF_CHECK_SAFETY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_STRICT_GATE_INDEX_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_RETENTION_DRY_RUN_INDEX_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_FRESHNESS_CHECKPOINT_INDEX_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SEED_CLEAN_INDEX_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_FINAL_SCANS_INDEX_SENTENCE}`,
        ));
    },
  }),
  Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: 'report_contract_doc_page_closeout_index_section_docs_missing',
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

export function closeoutIndexSectionHeadingFor(contractId = '') {
  return `${SECTION_HEADING_PREFIX}${contractId}`;
}

export function buildReportContractDocPageCloseoutIndexSectionMarkdownBlock(contract = {}) {
  return [
    closeoutIndexSectionHeadingFor(contract.contractId),
    '',
    ...REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SENTENCES.flatMap((binding) => [
      binding.sentence,
      '',
    ]),
  ].join('\n');
}

function extractCloseoutIndexSection(text = '', contractId = '') {
  const heading = closeoutIndexSectionHeadingFor(contractId);
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

function replaceCloseoutIndexSection(text = '', contractId = '', replacer = (section) => section) {
  const heading = closeoutIndexSectionHeadingFor(contractId);
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
  input.docsByPath[docsPath] = replaceCloseoutIndexSection(
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
    { key: 'sectionHeading', part: closeoutIndexSectionHeadingFor(contract.contractId) },
    ...REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SENTENCES.map((binding) => ({
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
  const sectionText = docsExists ? extractCloseoutIndexSection(docsText, contract.contractId) : null;
  const expectedParts = expectedPartsFor(contract);
  const positions = Object.fromEntries(expectedParts.map((entry) => [
    entry.key,
    sectionText == null ? -1 : indexOfPart(sectionText, entry.part),
  ]));
  const bindingPresence = Object.fromEntries(
    REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SENTENCES.map((binding) => [
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
      'report_contract_doc_page_closeout_index_section_docs_missing',
      `${contract.contractId} docs file must exist at ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(sectionText != null ? [] : [blocker(
      'report_contract_doc_page_closeout_index_section_missing',
      `${docsPath} must include ${closeoutIndexSectionHeadingFor(contract.contractId)}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SENTENCES.flatMap((binding) => (
      bindingPresence[presenceKey(binding.key)] ? [] : [blocker(
        binding.blockerCode,
        `${docsPath} closeout index section must include the canonical ${binding.label} binding sentence.`,
        { contractId: contract.contractId, docsPath },
      )]
    )),
    ...(orderValid ? [] : [blocker(
      'report_contract_doc_page_closeout_index_section_order_invalid',
      `${docsPath} closeout index section must order heading, strict gate index, retention dry-run index, freshness/checkpoint index, seed-clean index, final scans index, then diff-check safety index.`,
      { contractId: contract.contractId, docsPath, positions },
    )]),
  ];
  return {
    contractId: contract.contractId,
    label: contract.label,
    scriptId: contract.scriptId,
    fileId: contract.fileId,
    docsPath,
    status: blockers.length ? 'blocked_report_contract_doc_page_closeout_index_section_contract' : 'pass_report_contract_doc_page_closeout_index_section_contract',
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
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SENTENCES.map((binding) => [
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

function analyzeDocPageCloseoutIndexSections(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract).map((contract) => analyzeContract(contract, input));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_doc_page_closeout_index_section_analysis' : 'pass_report_contract_doc_page_closeout_index_section_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    uniqueDocsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    sectionCount: contracts.filter((contract) => contract.sectionPresent).length,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SENTENCES.map((binding) => [
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
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SENTENCES.map((binding) => [
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
  const analysis = analyzeDocPageCloseoutIndexSections(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_doc_page_closeout_index_section_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract docs page closeout index section analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_doc_page_closeout_index_section_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_doc_page_closeout_index_section_scenario' : 'pass_report_contract_doc_page_closeout_index_section_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractDocPageCloseoutIndexSectionRegressionInput({
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

export function buildReportContractDocPageCloseoutIndexSectionRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractDocPageCloseoutIndexSectionRegressionInput({
    manifest,
    docsByPath,
    docPathOverrides,
  });
  const actual = analyzeDocPageCloseoutIndexSections(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_doc_page_closeout_index_sections',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_REGRESSION_VERSION,
    kind: 'ReportContractDocPageCloseoutIndexSectionRegression',
    status: blockers.length ? 'blocked_report_contract_doc_page_closeout_index_section_regression' : 'pass_report_contract_doc_page_closeout_index_section_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docsPaths: uniqueSorted(baseInput.manifest.map((contract) => docsPathFor(contract, baseInput.docPathOverrides))),
      docPathOverrides: baseInput.docPathOverrides,
      sectionHeadingPrefix: SECTION_HEADING_PREFIX,
      requiredSentences: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SENTENCES.map((binding) => ({
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
      ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SENTENCES.map((binding) => [
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
  const contractDocPageCloseoutIndexSectionRegressionHash = digest({
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
    contractDocPageCloseoutIndexSectionRegressionHash,
    hash: contractDocPageCloseoutIndexSectionRegressionHash,
  };
}

export function summarizeReportContractDocPageCloseoutIndexSectionRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractDocPageCloseoutIndexSectionRegressionHash: report.contractDocPageCloseoutIndexSectionRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    uniqueDocsPathCount: report.summary?.uniqueDocsPathCount ?? null,
    docsFileCount: report.summary?.docsFileCount ?? null,
    sectionCount: report.summary?.sectionCount ?? null,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_INDEX_SECTION_SENTENCES.map((binding) => [
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
