import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-bootstrap-seed-section-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-bootstrap-seed-section-regression';
export const REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_REGRESSION_STEP_ID = 'report_contract_doc_page_bootstrap_seed_section_regression_export';

export const REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_ALLOWED_SEED_FILES_SENTENCE = 'Allowed seed files binding: reports:bootstrap-seeds may only write integration-dependency-audit-latest.json, integration-dependency-gate-latest.json, integration-gate-tooling-latest.json, report-freshness-latest.json, and report-schema-contract-latest.json.';
export const REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SELF_REFERENCE_BREAK_SENTENCE = 'Self-reference break binding: bootstrap seeds are temporary cycle breakers for missing, not-ok, or already-seeded latest reports, never steady-state contract outputs.';
export const REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_FINAL_CLEAN_SEED_SENTENCE = 'Final clean seed binding: final closeout must run npm run reports:bootstrap-seeds -- --strict and observe seededFileCount=0 with skippedFileCount=5.';
export const REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_ACTIVE_SEED_MARKER_SENTENCE = 'Active seed marker binding: final latest-report scans must find zero active bootstrapSeed, seedReason, seeded, or seed markers outside synthetic regression fixtures.';
export const REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SEED_REPORT_SENTENCE = 'Seed report binding: report-bootstrap-seed-regression, report-latest-recovery-regression, report-gate-clean-rerun-regression, and report-clean-gate-idempotence-regression must preserve bootstrap recovery evidence.';
export const REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_BOOTSTRAP_SEED_SAFETY_SENTENCE = 'Bootstrap seed safety boundary: bootstrap seed sections must state local-only conditional latest-report recovery, no external actions, and no execution permission grant.';

export const REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SENTENCES = Object.freeze([
  Object.freeze({
    key: 'allowedSeedFilesBinding',
    label: 'allowed seed files',
    blockerCode: 'report_contract_doc_page_bootstrap_seed_section_allowed_seed_files_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_ALLOWED_SEED_FILES_SENTENCE,
  }),
  Object.freeze({
    key: 'selfReferenceBreakBinding',
    label: 'self-reference break',
    blockerCode: 'report_contract_doc_page_bootstrap_seed_section_self_reference_break_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SELF_REFERENCE_BREAK_SENTENCE,
  }),
  Object.freeze({
    key: 'finalCleanSeedBinding',
    label: 'final clean seed',
    blockerCode: 'report_contract_doc_page_bootstrap_seed_section_final_clean_seed_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_FINAL_CLEAN_SEED_SENTENCE,
  }),
  Object.freeze({
    key: 'activeSeedMarkerBinding',
    label: 'active seed marker',
    blockerCode: 'report_contract_doc_page_bootstrap_seed_section_active_seed_marker_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_ACTIVE_SEED_MARKER_SENTENCE,
  }),
  Object.freeze({
    key: 'seedReportBinding',
    label: 'seed report',
    blockerCode: 'report_contract_doc_page_bootstrap_seed_section_seed_report_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SEED_REPORT_SENTENCE,
  }),
  Object.freeze({
    key: 'bootstrapSeedSafetyBoundary',
    label: 'bootstrap-seed safety',
    blockerCode: 'report_contract_doc_page_bootstrap_seed_section_bootstrap_seed_safety_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_BOOTSTRAP_SEED_SAFETY_SENTENCE,
  }),
]);

const TARGET_CONTRACT_ID = 'report_contract_manifest';
const SECTION_HEADING_PREFIX = '## Contract Page Bootstrap Seed Section: ';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_bootstrap_seed_section',
    label: 'A new manifest contract is added with docs but without a bootstrap seed section',
    expectedBlockerCode: 'report_contract_doc_page_bootstrap_seed_section_missing',
    mutate(input) {
      const contract = {
        contractId: 'report_future_doc_page_bootstrap_seed_section',
        label: 'Report future doc page bootstrap seed section',
        scriptId: 'reports:future-doc-page-bootstrap-seed-section',
        fileId: 'report-future-doc-page-bootstrap-seed-section-latest.json',
      };
      input.manifest.push(contract);
      input.docsByPath[docsPathFor(contract, input.docPathOverrides)] = '# Report Future Doc Page Bootstrap Seed Section\n';
    },
  }),
  ...REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SENTENCES.map((binding) => Object.freeze({
    scenarioId: `${binding.label.replace(/\s+/g, '_')}_binding_missing`,
    label: `A contract bootstrap seed section loses its ${binding.label} binding sentence`,
    expectedBlockerCode: binding.blockerCode,
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section.replace(binding.sentence, ''));
    },
  })),
  Object.freeze({
    scenarioId: 'bootstrap_seed_section_order_drift',
    label: 'A contract bootstrap seed section moves bootstrap-seed safety before bootstrap seed binding',
    expectedBlockerCode: 'report_contract_doc_page_bootstrap_seed_section_order_invalid',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(
          `${REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_ALLOWED_SEED_FILES_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SELF_REFERENCE_BREAK_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_FINAL_CLEAN_SEED_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_ACTIVE_SEED_MARKER_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SEED_REPORT_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_BOOTSTRAP_SEED_SAFETY_SENTENCE}`,
          `${REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_BOOTSTRAP_SEED_SAFETY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_ALLOWED_SEED_FILES_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SELF_REFERENCE_BREAK_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_FINAL_CLEAN_SEED_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_ACTIVE_SEED_MARKER_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SEED_REPORT_SENTENCE}`,
        ));
    },
  }),
  Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: 'report_contract_doc_page_bootstrap_seed_section_docs_missing',
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

export function bootstrapSeedSectionHeadingFor(contractId = '') {
  return `${SECTION_HEADING_PREFIX}${contractId}`;
}

export function buildReportContractDocPageBootstrapSeedSectionMarkdownBlock(contract = {}) {
  return [
    bootstrapSeedSectionHeadingFor(contract.contractId),
    '',
    ...REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SENTENCES.flatMap((binding) => [
      binding.sentence,
      '',
    ]),
  ].join('\n');
}

function extractBootstrapSeedSection(text = '', contractId = '') {
  const heading = bootstrapSeedSectionHeadingFor(contractId);
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

function replaceBootstrapSeedSection(text = '', contractId = '', replacer = (section) => section) {
  const heading = bootstrapSeedSectionHeadingFor(contractId);
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
  input.docsByPath[docsPath] = replaceBootstrapSeedSection(
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
    { key: 'sectionHeading', part: bootstrapSeedSectionHeadingFor(contract.contractId) },
    ...REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SENTENCES.map((binding) => ({
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
  const sectionText = docsExists ? extractBootstrapSeedSection(docsText, contract.contractId) : null;
  const expectedParts = expectedPartsFor(contract);
  const positions = Object.fromEntries(expectedParts.map((entry) => [
    entry.key,
    sectionText == null ? -1 : indexOfPart(sectionText, entry.part),
  ]));
  const bindingPresence = Object.fromEntries(
    REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SENTENCES.map((binding) => [
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
      'report_contract_doc_page_bootstrap_seed_section_docs_missing',
      `${contract.contractId} docs file must exist at ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(sectionText != null ? [] : [blocker(
      'report_contract_doc_page_bootstrap_seed_section_missing',
      `${docsPath} must include ${bootstrapSeedSectionHeadingFor(contract.contractId)}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SENTENCES.flatMap((binding) => (
      bindingPresence[presenceKey(binding.key)] ? [] : [blocker(
        binding.blockerCode,
        `${docsPath} bootstrap seed section must include the canonical ${binding.label} binding sentence.`,
        { contractId: contract.contractId, docsPath },
      )]
    )),
    ...(orderValid ? [] : [blocker(
      'report_contract_doc_page_bootstrap_seed_section_order_invalid',
      `${docsPath} bootstrap seed section must order heading, allowed seed files, self-reference break, final clean seed, active seed marker, seed report, then bootstrap seed safety.`,
      { contractId: contract.contractId, docsPath, positions },
    )]),
  ];
  return {
    contractId: contract.contractId,
    label: contract.label,
    scriptId: contract.scriptId,
    fileId: contract.fileId,
    docsPath,
    status: blockers.length ? 'blocked_report_contract_doc_page_bootstrap_seed_section_contract' : 'pass_report_contract_doc_page_bootstrap_seed_section_contract',
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
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SENTENCES.map((binding) => [
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

function analyzeDocPageBootstrapSeedSections(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract).map((contract) => analyzeContract(contract, input));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_doc_page_bootstrap_seed_section_analysis' : 'pass_report_contract_doc_page_bootstrap_seed_section_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    uniqueDocsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    sectionCount: contracts.filter((contract) => contract.sectionPresent).length,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SENTENCES.map((binding) => [
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
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SENTENCES.map((binding) => [
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
  const analysis = analyzeDocPageBootstrapSeedSections(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_doc_page_bootstrap_seed_section_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract docs page bootstrap seed section analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_doc_page_bootstrap_seed_section_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_doc_page_bootstrap_seed_section_scenario' : 'pass_report_contract_doc_page_bootstrap_seed_section_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractDocPageBootstrapSeedSectionRegressionInput({
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

export function buildReportContractDocPageBootstrapSeedSectionRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractDocPageBootstrapSeedSectionRegressionInput({
    manifest,
    docsByPath,
    docPathOverrides,
  });
  const actual = analyzeDocPageBootstrapSeedSections(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_doc_page_bootstrap_seed_sections',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_REGRESSION_VERSION,
    kind: 'ReportContractDocPageBootstrapSeedSectionRegression',
    status: blockers.length ? 'blocked_report_contract_doc_page_bootstrap_seed_section_regression' : 'pass_report_contract_doc_page_bootstrap_seed_section_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docsPaths: uniqueSorted(baseInput.manifest.map((contract) => docsPathFor(contract, baseInput.docPathOverrides))),
      docPathOverrides: baseInput.docPathOverrides,
      sectionHeadingPrefix: SECTION_HEADING_PREFIX,
      requiredSentences: REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SENTENCES.map((binding) => ({
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
      ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SENTENCES.map((binding) => [
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
  const contractDocPageBootstrapSeedSectionRegressionHash = digest({
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
    contractDocPageBootstrapSeedSectionRegressionHash,
    hash: contractDocPageBootstrapSeedSectionRegressionHash,
  };
}

export function summarizeReportContractDocPageBootstrapSeedSectionRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractDocPageBootstrapSeedSectionRegressionHash: report.contractDocPageBootstrapSeedSectionRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    uniqueDocsPathCount: report.summary?.uniqueDocsPathCount ?? null,
    docsFileCount: report.summary?.docsFileCount ?? null,
    sectionCount: report.summary?.sectionCount ?? null,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_BOOTSTRAP_SEED_SECTION_SENTENCES.map((binding) => [
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
