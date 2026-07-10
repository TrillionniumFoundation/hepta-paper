import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-closeout-ledger-section-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-closeout-ledger-section-regression';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_REGRESSION_STEP_ID = 'report_contract_doc_page_closeout_ledger_section_regression_export';

export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_COMMAND_LEDGER_SENTENCE = 'Closeout command ledger binding: closeout ledger sections must name the local closeout order as npm run gate:integration:strict, npm run reports:prune:dry-run, npm run reports:freshness, npm run checkpoint:architecture, npm run reports:bootstrap-seeds -- --strict, active seed marker scan, placeholder token scan, and git diff --check -- . as the final local diff probe.';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_EVIDENCE_HASH_LEDGER_SENTENCE = 'Evidence hash ledger binding: closeout ledger sections must name the strict gate, retention, freshness, checkpoint, seed-clean, and diff-check evidence hashes as local latest-report ledger entries rather than external platform state.';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_OWNER_LEDGER_SENTENCE = 'Pass/fail owner ledger binding: closeout ledger sections must assign local owner surfaces for each ledger row: strict gate owns mapped report writes, retention owns archive decisions, freshness owns gate hash parity, checkpoint owns architecture binding, seed-clean owns bootstrap recovery, and scans/diff-check own final local safety.';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_RECOVERY_LEDGER_SENTENCE = 'Recovery ledger binding: closeout ledger sections must state that any mapped report writer after final gate invalidates the ledger and requires rerunning strict gate before freshness and checkpoint closeout.';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_NO_GRANT_LEDGER_SENTENCE = 'No-grant ledger binding: closeout ledger sections must record that the ledger is local-only evidence and grants no upload, submit, IM, acceptance, payment, deployment, provider/model spend, browser live action, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_RETENTION_LEDGER_SENTENCE = 'Ledger retention binding: closeout ledger sections must keep current latest JSON/Markdown reports protected and require archivedCount=0 in final dry-run retention before ledger closeout.';

export const REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_SENTENCES = Object.freeze([
  Object.freeze({
    key: 'commandLedgerBinding',
    label: 'closeout command ledger',
    blockerCode: 'report_contract_doc_page_closeout_ledger_section_command_ledger_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_COMMAND_LEDGER_SENTENCE,
  }),
  Object.freeze({
    key: 'evidenceHashLedgerBinding',
    label: 'evidence hash ledger',
    blockerCode: 'report_contract_doc_page_closeout_ledger_section_evidence_hash_ledger_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_EVIDENCE_HASH_LEDGER_SENTENCE,
  }),
  Object.freeze({
    key: 'ownerLedgerBinding',
    label: 'pass/fail owner ledger',
    blockerCode: 'report_contract_doc_page_closeout_ledger_section_owner_ledger_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_OWNER_LEDGER_SENTENCE,
  }),
  Object.freeze({
    key: 'recoveryLedgerBinding',
    label: 'recovery ledger',
    blockerCode: 'report_contract_doc_page_closeout_ledger_section_recovery_ledger_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_RECOVERY_LEDGER_SENTENCE,
  }),
  Object.freeze({
    key: 'noGrantLedgerBinding',
    label: 'no-grant ledger',
    blockerCode: 'report_contract_doc_page_closeout_ledger_section_no_grant_ledger_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_NO_GRANT_LEDGER_SENTENCE,
  }),
  Object.freeze({
    key: 'retentionLedgerBinding',
    label: 'ledger retention',
    blockerCode: 'report_contract_doc_page_closeout_ledger_section_retention_ledger_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_RETENTION_LEDGER_SENTENCE,
  }),
]);

const TARGET_CONTRACT_ID = 'report_contract_manifest';
const SECTION_HEADING_PREFIX = '## Contract Page Closeout Ledger Section: ';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_closeout_ledger_section',
    label: 'A new manifest contract is added with docs but without a closeout ledger section',
    expectedBlockerCode: 'report_contract_doc_page_closeout_ledger_section_missing',
    mutate(input) {
      const contract = {
        contractId: 'report_future_doc_page_closeout_ledger_section',
        label: 'Report future doc page closeout ledger section',
        scriptId: 'reports:future-doc-page-closeout-ledger-section',
        fileId: 'report-future-doc-page-closeout-ledger-section-latest.json',
      };
      input.manifest.push(contract);
      input.docsByPath[docsPathFor(contract, input.docPathOverrides)] = '# Report Future Doc Page Closeout Ledger Section\n';
    },
  }),
  ...REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_SENTENCES.map((binding) => Object.freeze({
    scenarioId: `${binding.label.replace(/\s+/g, '_')}_binding_missing`,
    label: `A contract closeout ledger section loses its ${binding.label} binding sentence`,
    expectedBlockerCode: binding.blockerCode,
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section.replace(binding.sentence, ''));
    },
  })),
  Object.freeze({
    scenarioId: 'closeout_ledger_section_order_drift',
    label: 'A contract closeout ledger section moves ledger retention before the closeout command ledger',
    expectedBlockerCode: 'report_contract_doc_page_closeout_ledger_section_order_invalid',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(
          `${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_COMMAND_LEDGER_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_EVIDENCE_HASH_LEDGER_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_OWNER_LEDGER_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_RECOVERY_LEDGER_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_NO_GRANT_LEDGER_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_RETENTION_LEDGER_SENTENCE}`,
          `${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_RETENTION_LEDGER_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_COMMAND_LEDGER_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_EVIDENCE_HASH_LEDGER_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_OWNER_LEDGER_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_RECOVERY_LEDGER_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_NO_GRANT_LEDGER_SENTENCE}`,
        ));
    },
  }),
  Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: 'report_contract_doc_page_closeout_ledger_section_docs_missing',
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

export function closeoutLedgerSectionHeadingFor(contractId = '') {
  return `${SECTION_HEADING_PREFIX}${contractId}`;
}

export function buildReportContractDocPageCloseoutLedgerSectionMarkdownBlock(contract = {}) {
  return [
    closeoutLedgerSectionHeadingFor(contract.contractId),
    '',
    ...REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_SENTENCES.flatMap((binding) => [
      binding.sentence,
      '',
    ]),
  ].join('\n');
}

function extractCloseoutLedgerSection(text = '', contractId = '') {
  const heading = closeoutLedgerSectionHeadingFor(contractId);
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

function replaceCloseoutLedgerSection(text = '', contractId = '', replacer = (section) => section) {
  const heading = closeoutLedgerSectionHeadingFor(contractId);
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
  input.docsByPath[docsPath] = replaceCloseoutLedgerSection(
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
    { key: 'sectionHeading', part: closeoutLedgerSectionHeadingFor(contract.contractId) },
    ...REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_SENTENCES.map((binding) => ({
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
  const sectionText = docsExists ? extractCloseoutLedgerSection(docsText, contract.contractId) : null;
  const expectedParts = expectedPartsFor(contract);
  const positions = Object.fromEntries(expectedParts.map((entry) => [
    entry.key,
    sectionText == null ? -1 : indexOfPart(sectionText, entry.part),
  ]));
  const bindingPresence = Object.fromEntries(
    REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_SENTENCES.map((binding) => [
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
      'report_contract_doc_page_closeout_ledger_section_docs_missing',
      `${contract.contractId} docs file must exist at ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(sectionText != null ? [] : [blocker(
      'report_contract_doc_page_closeout_ledger_section_missing',
      `${docsPath} must include ${closeoutLedgerSectionHeadingFor(contract.contractId)}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_SENTENCES.flatMap((binding) => (
      bindingPresence[presenceKey(binding.key)] ? [] : [blocker(
        binding.blockerCode,
        `${docsPath} closeout ledger section must include the canonical ${binding.label} binding sentence.`,
        { contractId: contract.contractId, docsPath },
      )]
    )),
    ...(orderValid ? [] : [blocker(
      'report_contract_doc_page_closeout_ledger_section_order_invalid',
      `${docsPath} closeout ledger section must order heading, closeout command ledger, evidence hash ledger, pass/fail owner ledger, recovery ledger, no-grant ledger, then ledger retention.`,
      { contractId: contract.contractId, docsPath, positions },
    )]),
  ];
  return {
    contractId: contract.contractId,
    label: contract.label,
    scriptId: contract.scriptId,
    fileId: contract.fileId,
    docsPath,
    status: blockers.length ? 'blocked_report_contract_doc_page_closeout_ledger_section_contract' : 'pass_report_contract_doc_page_closeout_ledger_section_contract',
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
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_SENTENCES.map((binding) => [
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

function analyzeDocPageCloseoutLedgerSections(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract).map((contract) => analyzeContract(contract, input));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_doc_page_closeout_ledger_section_analysis' : 'pass_report_contract_doc_page_closeout_ledger_section_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    uniqueDocsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    sectionCount: contracts.filter((contract) => contract.sectionPresent).length,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_SENTENCES.map((binding) => [
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
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_SENTENCES.map((binding) => [
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
  const analysis = analyzeDocPageCloseoutLedgerSections(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_doc_page_closeout_ledger_section_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract docs page closeout ledger section analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_doc_page_closeout_ledger_section_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_doc_page_closeout_ledger_section_scenario' : 'pass_report_contract_doc_page_closeout_ledger_section_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractDocPageCloseoutLedgerSectionRegressionInput({
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

export function buildReportContractDocPageCloseoutLedgerSectionRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractDocPageCloseoutLedgerSectionRegressionInput({
    manifest,
    docsByPath,
    docPathOverrides,
  });
  const actual = analyzeDocPageCloseoutLedgerSections(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_doc_page_closeout_ledger_sections',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_REGRESSION_VERSION,
    kind: 'ReportContractDocPageCloseoutLedgerSectionRegression',
    status: blockers.length ? 'blocked_report_contract_doc_page_closeout_ledger_section_regression' : 'pass_report_contract_doc_page_closeout_ledger_section_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docsPaths: uniqueSorted(baseInput.manifest.map((contract) => docsPathFor(contract, baseInput.docPathOverrides))),
      docPathOverrides: baseInput.docPathOverrides,
      sectionHeadingPrefix: SECTION_HEADING_PREFIX,
      requiredSentences: REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_SENTENCES.map((binding) => ({
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
      ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_SENTENCES.map((binding) => [
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
  const contractDocPageCloseoutLedgerSectionRegressionHash = digest({
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
    contractDocPageCloseoutLedgerSectionRegressionHash,
    hash: contractDocPageCloseoutLedgerSectionRegressionHash,
  };
}

export function summarizeReportContractDocPageCloseoutLedgerSectionRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractDocPageCloseoutLedgerSectionRegressionHash: report.contractDocPageCloseoutLedgerSectionRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    uniqueDocsPathCount: report.summary?.uniqueDocsPathCount ?? null,
    docsFileCount: report.summary?.docsFileCount ?? null,
    sectionCount: report.summary?.sectionCount ?? null,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_CLOSEOUT_LEDGER_SECTION_SENTENCES.map((binding) => [
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
