import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-release-dispatch-implementation-denial-section-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-release-dispatch-implementation-denial-section-regression';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_REGRESSION_STEP_ID = 'report_contract_doc_page_release_dispatch_implementation_denial_section_regression_export';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_RUNNER_EXECUTION_GATE_ARTIFACT_SENTENCE = 'Release runner execution gate artifact implementation-denial entry: release dispatch implementation denial sections must name reports/report-contract-doc-page-release-runner-execution-gate-section-regression-latest.json and reports/report-contract-doc-page-release-runner-execution-gate-section-regression-latest.md as upstream runner lifecycle gate evidence, require the contractDocPageReleaseRunnerExecutionGateSectionRegressionHash sha256 plus zero blockers, and state that runner execution gate evidence only permits local pre-dispatch review, not dispatch implementation, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_STRICT_GATE_SENTENCE = 'Strict gate dispatch implementation denial entry: release dispatch implementation denial sections must name reports/integration-dependency-gate-latest.json and reports/integration-dependency-gate-latest.md as strict gate evidence and require the final gateHash sha256 plus zero blockers before any dispatch implementation can be discussed, while stating that a passing gate cannot grant archive, delete, upload, submit, IM, acceptance, payment, deployment, provider/model spend, browser live action, runner dispatch, approval, write-adapter implementation, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_FRESHNESS_SENTENCE = 'Freshness dispatch implementation denial entry: release dispatch implementation denial sections must name reports/report-freshness-latest.json and reports/report-freshness-latest.md as freshness evidence and require reportCount=okReportCount, comparableGateReportCount=gateHashMatchCount, gateHashMismatchCount=0, and the final freshnessHash to be bound before dispatch implementation denial can remain reviewable.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_CHECKPOINT_SENTENCE = 'Checkpoint dispatch implementation denial entry: release dispatch implementation denial sections must name reports/architecture-checkpoint-latest.json and reports/architecture-checkpoint-latest.md as checkpoint evidence and require checkpointHash plus final reportFreshnessHash, reportContractDocPageReleaseRunnerExecutionGateSectionRegressionHash, and reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionHash bindings to be recorded as dispatch-implementation-denial evidence, not as dispatch, local state transition, write-adapter enablement, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_RETENTION_SENTENCE = 'Retention dry-run dispatch implementation denial entry: release dispatch implementation denial sections must name reports/report-retention-latest.json plus npm run reports:prune:dry-run and require dryRun=true with archivedCount=0 to be recorded as retention evidence only, never as archive, delete, upload, submit, IM, acceptance, payment, deployment, runner dispatch, write-adapter implementation, approval, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SEED_CLEAN_SENTENCE = 'Seed-clean probe dispatch implementation denial entry: release dispatch implementation denial sections must name npm run reports:bootstrap-seeds -- --strict and require seededFileCount=0, skippedFileCount=5, activeBootstrapSeedReports=0, zero real placeholder tokens, and git diff --check -- . to be recorded as closeout proof only, not local state transition, runner dispatch, browser live action, write-adapter implementation, approval, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_PRECONDITION_DENIAL_SENTENCE = 'Dispatch implementation precondition-denial entry: release dispatch implementation denial sections must require any future implementation proposal to bind current chat id, approval message id, requester identity, timestamp, exact target, exact action, channel, artifact paths, artifact hashes, platform-state snapshot id, dry-run replay id, expected mutation plan, receipt schema, proof bundle path, ledger row id, audit evidence id, implementation nonce, executor identity, expiry, rollback plan, and explicit human-visible dispatch wording while rejecting standing authorization, inherited approval, broad batch approval, stale chat context, and any implementation record missing exact scope.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_WRITE_ADAPTER_DENIAL_SENTENCE = 'Write-adapter execution denial entry: release dispatch implementation denial sections must state that no runner dispatch, click, POST, browser session, API write, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, or external action may be implemented, enabled, called, or replayed from this guard; any future dispatch implementation still requires a separate implementation guard, exact platform-state, dry-run replay, post-action receipt, proof bundle, ledger, audit evidence, and a fresh current-chat approval before live execution can be considered.';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SENTENCES = Object.freeze([
  Object.freeze({
    key: 'releaseRunnerExecutionGateArtifactImplementationDenialEntry',
    label: 'release runner execution gate artifact implementation-denial entry',
    blockerCode: 'report_contract_doc_page_release_dispatch_implementation_denial_section_release_runner_execution_gate_artifact_implementation_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_RUNNER_EXECUTION_GATE_ARTIFACT_SENTENCE,
  }),
  Object.freeze({
    key: 'strictGateDispatchImplementationDenialEntry',
    label: 'strict gate dispatch implementation denial entry',
    blockerCode: 'report_contract_doc_page_release_dispatch_implementation_denial_section_strict_gate_dispatch_implementation_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_STRICT_GATE_SENTENCE,
  }),
  Object.freeze({
    key: 'freshnessDispatchImplementationDenialEntry',
    label: 'freshness dispatch implementation denial entry',
    blockerCode: 'report_contract_doc_page_release_dispatch_implementation_denial_section_freshness_dispatch_implementation_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_FRESHNESS_SENTENCE,
  }),
  Object.freeze({
    key: 'checkpointDispatchImplementationDenialEntry',
    label: 'checkpoint dispatch implementation denial entry',
    blockerCode: 'report_contract_doc_page_release_dispatch_implementation_denial_section_checkpoint_dispatch_implementation_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_CHECKPOINT_SENTENCE,
  }),
  Object.freeze({
    key: 'retentionDryRunDispatchImplementationDenialEntry',
    label: 'retention dry-run dispatch implementation denial entry',
    blockerCode: 'report_contract_doc_page_release_dispatch_implementation_denial_section_retention_dispatch_implementation_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_RETENTION_SENTENCE,
  }),
  Object.freeze({
    key: 'seedCleanProbeDispatchImplementationDenialEntry',
    label: 'seed-clean probe dispatch implementation denial entry',
    blockerCode: 'report_contract_doc_page_release_dispatch_implementation_denial_section_seed_clean_dispatch_implementation_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SEED_CLEAN_SENTENCE,
  }),
  Object.freeze({
    key: 'dispatchImplementationPreconditionDenialEntry',
    label: 'dispatch implementation precondition-denial entry',
    blockerCode: 'report_contract_doc_page_release_dispatch_implementation_denial_section_dispatch_implementation_precondition_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_PRECONDITION_DENIAL_SENTENCE,
  }),
  Object.freeze({
    key: 'writeAdapterExecutionDenialEntry',
    label: 'write-adapter execution denial entry',
    blockerCode: 'report_contract_doc_page_release_dispatch_implementation_denial_section_write_adapter_execution_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_WRITE_ADAPTER_DENIAL_SENTENCE,
  }),
]);

const TARGET_CONTRACT_ID = 'report_contract_manifest';
const SECTION_HEADING_PREFIX = '## Contract Page Release Dispatch Implementation Denial Section: ';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_release_dispatch_implementation_denial_section',
    label: 'A new manifest contract is added with docs but without a release dispatch implementation denial section',
    expectedBlockerCode: 'report_contract_doc_page_release_dispatch_implementation_denial_section_missing',
    mutate(input) {
      const contract = {
        contractId: 'report_future_doc_page_release_dispatch_implementation_denial_section',
        label: 'Report future doc page release dispatch implementation denial section',
        scriptId: 'reports:future-doc-page-release-dispatch-implementation-denial-section',
        fileId: 'report-future-doc-page-release-dispatch-implementation-denial-section-latest.json',
      };
      input.manifest.push(contract);
      input.docsByPath[docsPathFor(contract, input.docPathOverrides)] = '# Report Future Doc Page Release Dispatch Implementation Denial Section\n';
    },
  }),
  ...REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SENTENCES.map((binding) => Object.freeze({
    scenarioId: `${binding.label.replace(/\s+/g, '_')}_binding_missing`,
    label: `A contract release dispatch implementation denial section loses its ${binding.label} binding sentence`,
    expectedBlockerCode: binding.blockerCode,
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section.replace(binding.sentence, ''));
    },
  })),
  Object.freeze({
    scenarioId: 'release_dispatch_implementation_denial_section_order_drift',
    label: 'A contract release dispatch implementation denial section moves write-adapter denial before the runner execution gate artifact entry',
    expectedBlockerCode: 'report_contract_doc_page_release_dispatch_implementation_denial_section_order_invalid',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(
          `${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_RUNNER_EXECUTION_GATE_ARTIFACT_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_STRICT_GATE_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_FRESHNESS_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_CHECKPOINT_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_RETENTION_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SEED_CLEAN_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_PRECONDITION_DENIAL_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_WRITE_ADAPTER_DENIAL_SENTENCE}`,
          `${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_WRITE_ADAPTER_DENIAL_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_RUNNER_EXECUTION_GATE_ARTIFACT_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_STRICT_GATE_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_FRESHNESS_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_CHECKPOINT_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_RETENTION_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SEED_CLEAN_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_PRECONDITION_DENIAL_SENTENCE}`,
        ));
    },
  }),
  Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: 'report_contract_doc_page_release_dispatch_implementation_denial_section_docs_missing',
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

export function releaseDispatchImplementationDenialSectionHeadingFor(contractId = '') {
  return `${SECTION_HEADING_PREFIX}${contractId}`;
}

export function buildReportContractDocPageReleaseDispatchImplementationDenialSectionMarkdownBlock(contract = {}) {
  return [
    releaseDispatchImplementationDenialSectionHeadingFor(contract.contractId),
    '',
    ...REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SENTENCES.flatMap((binding) => [
      binding.sentence,
      '',
    ]),
  ].join('\n');
}

function extractReleaseDispatchImplementationDenialSection(text = '', contractId = '') {
  const heading = releaseDispatchImplementationDenialSectionHeadingFor(contractId);
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

function replaceReleaseDispatchImplementationDenialSection(text = '', contractId = '', replacer = (section) => section) {
  const heading = releaseDispatchImplementationDenialSectionHeadingFor(contractId);
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
  input.docsByPath[docsPath] = replaceReleaseDispatchImplementationDenialSection(
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
    { key: 'sectionHeading', part: releaseDispatchImplementationDenialSectionHeadingFor(contract.contractId) },
    ...REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SENTENCES.map((binding) => ({
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
  const sectionText = docsExists ? extractReleaseDispatchImplementationDenialSection(docsText, contract.contractId) : null;
  const expectedParts = expectedPartsFor(contract);
  const positions = Object.fromEntries(expectedParts.map((entry) => [
    entry.key,
    sectionText == null ? -1 : indexOfPart(sectionText, entry.part),
  ]));
  const bindingPresence = Object.fromEntries(
    REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SENTENCES.map((binding) => [
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
      'report_contract_doc_page_release_dispatch_implementation_denial_section_docs_missing',
      `${contract.contractId} docs file must exist at ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(sectionText != null ? [] : [blocker(
      'report_contract_doc_page_release_dispatch_implementation_denial_section_missing',
      `${docsPath} must include ${releaseDispatchImplementationDenialSectionHeadingFor(contract.contractId)}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SENTENCES.flatMap((binding) => (
      bindingPresence[presenceKey(binding.key)] ? [] : [blocker(
        binding.blockerCode,
        `${docsPath} release dispatch implementation denial section must include the canonical ${binding.label} binding sentence.`,
        { contractId: contract.contractId, docsPath },
      )]
    )),
    ...(orderValid ? [] : [blocker(
      'report_contract_doc_page_release_dispatch_implementation_denial_section_order_invalid',
      `${docsPath} release dispatch implementation denial section must order heading, release runner execution gate artifact implementation denial, strict gate dispatch implementation denial, freshness dispatch implementation denial, checkpoint dispatch implementation denial, retention dry-run dispatch implementation denial, seed-clean probe dispatch implementation denial, dispatch implementation precondition denial, then write-adapter execution denial.`,
      { contractId: contract.contractId, docsPath, positions },
    )]),
  ];
  return {
    contractId: contract.contractId,
    label: contract.label,
    scriptId: contract.scriptId,
    fileId: contract.fileId,
    docsPath,
    status: blockers.length ? 'blocked_report_contract_doc_page_release_dispatch_implementation_denial_section_contract' : 'pass_report_contract_doc_page_release_dispatch_implementation_denial_section_contract',
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
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SENTENCES.map((binding) => [
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

function analyzeDocPageReleaseDispatchImplementationDenialSections(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract).map((contract) => analyzeContract(contract, input));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_doc_page_release_dispatch_implementation_denial_section_analysis' : 'pass_report_contract_doc_page_release_dispatch_implementation_denial_section_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    uniqueDocsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    sectionCount: contracts.filter((contract) => contract.sectionPresent).length,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SENTENCES.map((binding) => [
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
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SENTENCES.map((binding) => [
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
  const analysis = analyzeDocPageReleaseDispatchImplementationDenialSections(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_doc_page_release_dispatch_implementation_denial_section_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract docs page release dispatch implementation denial section analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_doc_page_release_dispatch_implementation_denial_section_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_doc_page_release_dispatch_implementation_denial_section_scenario' : 'pass_report_contract_doc_page_release_dispatch_implementation_denial_section_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractDocPageReleaseDispatchImplementationDenialSectionRegressionInput({
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

export function buildReportContractDocPageReleaseDispatchImplementationDenialSectionRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractDocPageReleaseDispatchImplementationDenialSectionRegressionInput({
    manifest,
    docsByPath,
    docPathOverrides,
  });
  const actual = analyzeDocPageReleaseDispatchImplementationDenialSections(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_doc_page_release_dispatch_implementation_denial_sections',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_REGRESSION_VERSION,
    kind: 'ReportContractDocPageReleaseDispatchImplementationDenialSectionRegression',
    status: blockers.length ? 'blocked_report_contract_doc_page_release_dispatch_implementation_denial_section_regression' : 'pass_report_contract_doc_page_release_dispatch_implementation_denial_section_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docsPaths: uniqueSorted(baseInput.manifest.map((contract) => docsPathFor(contract, baseInput.docPathOverrides))),
      docPathOverrides: baseInput.docPathOverrides,
      sectionHeadingPrefix: SECTION_HEADING_PREFIX,
      requiredSentences: REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SENTENCES.map((binding) => ({
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
      ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SENTENCES.map((binding) => [
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
  const contractDocPageReleaseDispatchImplementationDenialSectionRegressionHash = digest({
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
    contractDocPageReleaseDispatchImplementationDenialSectionRegressionHash,
    hash: contractDocPageReleaseDispatchImplementationDenialSectionRegressionHash,
  };
}

export function summarizeReportContractDocPageReleaseDispatchImplementationDenialSectionRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractDocPageReleaseDispatchImplementationDenialSectionRegressionHash: report.contractDocPageReleaseDispatchImplementationDenialSectionRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    uniqueDocsPathCount: report.summary?.uniqueDocsPathCount ?? null,
    docsFileCount: report.summary?.docsFileCount ?? null,
    sectionCount: report.summary?.sectionCount ?? null,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_RELEASE_DISPATCH_IMPLEMENTATION_DENIAL_SECTION_SENTENCES.map((binding) => [
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
