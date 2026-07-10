import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-release-execution-approval-boundary-section-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-release-execution-approval-boundary-section-regression';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_REGRESSION_STEP_ID = 'report_contract_doc_page_release_execution_approval_boundary_section_regression_export';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_EXECUTION_INTENT_CAPTURE_ARTIFACT_SENTENCE = 'Release execution intent capture artifact approval entry: release execution approval boundary sections must name reports/report-contract-doc-page-release-execution-intent-capture-section-regression-latest.json and reports/report-contract-doc-page-release-execution-intent-capture-section-regression-latest.md as upstream current-chat intent evidence, require the contractDocPageReleaseExecutionIntentCaptureSectionRegressionHash sha256 plus zero blockers, and state that intent evidence only permits an explicit approval-boundary review, not runner dispatch, browser/API write, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, approval, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_STRICT_GATE_APPROVAL_BOUNDARY_SENTENCE = 'Strict gate execution approval boundary entry: release execution approval boundary sections must name reports/integration-dependency-gate-latest.json and reports/integration-dependency-gate-latest.md as strict gate evidence and require the final gateHash sha256 plus zero blockers before an explicit approval boundary can be reviewed, while stating that a passing gate cannot grant archive, delete, upload, submit, IM, acceptance, payment, deployment, provider/model spend, browser live action, runner dispatch, approval, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_FRESHNESS_APPROVAL_BOUNDARY_SENTENCE = 'Freshness execution approval boundary entry: release execution approval boundary sections must name reports/report-freshness-latest.json and reports/report-freshness-latest.md as freshness evidence and require reportCount=okReportCount, comparableGateReportCount=gateHashMatchCount, gateHashMismatchCount=0, and the final freshnessHash to be bound before any explicit approval boundary can remain reviewable.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_CHECKPOINT_APPROVAL_BOUNDARY_SENTENCE = 'Checkpoint execution approval boundary entry: release execution approval boundary sections must name reports/architecture-checkpoint-latest.json and reports/architecture-checkpoint-latest.md as checkpoint evidence and require checkpointHash plus final reportFreshnessHash, reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionHash, and reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionHash bindings to be recorded as approval-boundary evidence, not as dispatch, local state transition, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_RETENTION_APPROVAL_BOUNDARY_SENTENCE = 'Retention dry-run execution approval boundary entry: release execution approval boundary sections must name reports/report-retention-latest.json plus npm run reports:prune:dry-run and require dryRun=true with archivedCount=0 to be recorded as retention evidence only, never as archive, delete, upload, submit, IM, acceptance, payment, deployment, runner dispatch, approval, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SEED_CLEAN_APPROVAL_BOUNDARY_SENTENCE = 'Seed-clean probe execution approval boundary entry: release execution approval boundary sections must name npm run reports:bootstrap-seeds -- --strict and require seededFileCount=0, skippedFileCount=5, activeBootstrapSeedReports=0, zero real placeholder tokens, and git diff --check -- . to be recorded as closeout proof only, not local state transition, runner dispatch, browser live action, approval, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_CURRENT_CHAT_EXPLICIT_APPROVAL_SENTENCE = 'Current-chat explicit execution approval entry: release execution approval boundary sections must require every approval record to include current chat id, source message or evidence id, requester identity, timestamp, exact target, exact action, channel, artifact paths, artifact hashes, preflight evidence id, intent evidence id, intent nonce, approval nonce, expiry, and explicit approval wording while rejecting standing authorization, inherited approval, broad batch approval, stale chat context, and any approval record missing exact scope.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_APPROVAL_PREREQUISITE_WRITE_DENIAL_SENTENCE = 'Approval prerequisite and write-denial entry: release execution approval boundary sections must state an explicit approval boundary is necessary but never sufficient for runner dispatch or external execution, expires on approval, artifact, report, replay, platform-state, receipt, or audit drift, cannot be forwarded, batched, replayed, or consumed by background runners, and still requires a later runner/external-action lifecycle gate before any browser session, API write, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, or external action can be considered.';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SENTENCES = Object.freeze([
  Object.freeze({
    key: 'releaseExecutionIntentCaptureArtifactApprovalEntry',
    label: 'release execution intent capture artifact approval entry',
    blockerCode: 'report_contract_doc_page_release_execution_approval_boundary_section_release_execution_intent_capture_artifact_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_EXECUTION_INTENT_CAPTURE_ARTIFACT_SENTENCE,
  }),
  Object.freeze({
    key: 'strictGateExecutionApprovalBoundaryEntry',
    label: 'strict gate execution approval boundary entry',
    blockerCode: 'report_contract_doc_page_release_execution_approval_boundary_section_strict_gate_approval_boundary_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_STRICT_GATE_APPROVAL_BOUNDARY_SENTENCE,
  }),
  Object.freeze({
    key: 'freshnessExecutionApprovalBoundaryEntry',
    label: 'freshness execution approval boundary entry',
    blockerCode: 'report_contract_doc_page_release_execution_approval_boundary_section_freshness_approval_boundary_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_FRESHNESS_APPROVAL_BOUNDARY_SENTENCE,
  }),
  Object.freeze({
    key: 'checkpointExecutionApprovalBoundaryEntry',
    label: 'checkpoint execution approval boundary entry',
    blockerCode: 'report_contract_doc_page_release_execution_approval_boundary_section_checkpoint_approval_boundary_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_CHECKPOINT_APPROVAL_BOUNDARY_SENTENCE,
  }),
  Object.freeze({
    key: 'retentionDryRunExecutionApprovalBoundaryEntry',
    label: 'retention dry-run execution approval boundary entry',
    blockerCode: 'report_contract_doc_page_release_execution_approval_boundary_section_retention_approval_boundary_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_RETENTION_APPROVAL_BOUNDARY_SENTENCE,
  }),
  Object.freeze({
    key: 'seedCleanProbeExecutionApprovalBoundaryEntry',
    label: 'seed-clean probe execution approval boundary entry',
    blockerCode: 'report_contract_doc_page_release_execution_approval_boundary_section_seed_clean_approval_boundary_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SEED_CLEAN_APPROVAL_BOUNDARY_SENTENCE,
  }),
  Object.freeze({
    key: 'currentChatExplicitExecutionApprovalEntry',
    label: 'current-chat explicit execution approval entry',
    blockerCode: 'report_contract_doc_page_release_execution_approval_boundary_section_current_chat_explicit_execution_approval_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_CURRENT_CHAT_EXPLICIT_APPROVAL_SENTENCE,
  }),
  Object.freeze({
    key: 'approvalPrerequisiteWriteDenialEntry',
    label: 'approval prerequisite and write-denial entry',
    blockerCode: 'report_contract_doc_page_release_execution_approval_boundary_section_approval_prerequisite_write_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_APPROVAL_PREREQUISITE_WRITE_DENIAL_SENTENCE,
  }),
]);

const TARGET_CONTRACT_ID = 'report_contract_manifest';
const SECTION_HEADING_PREFIX = '## Contract Page Release Execution Approval Boundary Section: ';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_release_execution_approval_boundary_section',
    label: 'A new manifest contract is added with docs but without a release execution approval boundary section',
    expectedBlockerCode: 'report_contract_doc_page_release_execution_approval_boundary_section_missing',
    mutate(input) {
      const contract = {
        contractId: 'report_future_doc_page_release_execution_approval_boundary_section',
        label: 'Report future doc page release execution approval boundary section',
        scriptId: 'reports:future-doc-page-release-execution-approval-boundary-section',
        fileId: 'report-future-doc-page-release-execution-approval-boundary-section-latest.json',
      };
      input.manifest.push(contract);
      input.docsByPath[docsPathFor(contract, input.docPathOverrides)] = '# Report Future Doc Page Release Execution Approval Boundary Section\n';
    },
  }),
  ...REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SENTENCES.map((binding) => Object.freeze({
    scenarioId: `${binding.label.replace(/\s+/g, '_')}_binding_missing`,
    label: `A contract release execution approval boundary section loses its ${binding.label} binding sentence`,
    expectedBlockerCode: binding.blockerCode,
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section.replace(binding.sentence, ''));
    },
  })),
  Object.freeze({
    scenarioId: 'release_execution_approval_boundary_section_order_drift',
    label: 'A contract release execution approval boundary section moves approval prerequisites before the intent capture artifact entry',
    expectedBlockerCode: 'report_contract_doc_page_release_execution_approval_boundary_section_order_invalid',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(
          `${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_EXECUTION_INTENT_CAPTURE_ARTIFACT_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_STRICT_GATE_APPROVAL_BOUNDARY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_FRESHNESS_APPROVAL_BOUNDARY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_CHECKPOINT_APPROVAL_BOUNDARY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_RETENTION_APPROVAL_BOUNDARY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SEED_CLEAN_APPROVAL_BOUNDARY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_CURRENT_CHAT_EXPLICIT_APPROVAL_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_APPROVAL_PREREQUISITE_WRITE_DENIAL_SENTENCE}`,
          `${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_APPROVAL_PREREQUISITE_WRITE_DENIAL_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_EXECUTION_INTENT_CAPTURE_ARTIFACT_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_STRICT_GATE_APPROVAL_BOUNDARY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_FRESHNESS_APPROVAL_BOUNDARY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_CHECKPOINT_APPROVAL_BOUNDARY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_RETENTION_APPROVAL_BOUNDARY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SEED_CLEAN_APPROVAL_BOUNDARY_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_CURRENT_CHAT_EXPLICIT_APPROVAL_SENTENCE}`,
        ));
    },
  }),
  Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: 'report_contract_doc_page_release_execution_approval_boundary_section_docs_missing',
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

export function releaseExecutionApprovalBoundarySectionHeadingFor(contractId = '') {
  return `${SECTION_HEADING_PREFIX}${contractId}`;
}

export function buildReportContractDocPageReleaseExecutionApprovalBoundarySectionMarkdownBlock(contract = {}) {
  return [
    releaseExecutionApprovalBoundarySectionHeadingFor(contract.contractId),
    '',
    ...REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SENTENCES.flatMap((binding) => [
      binding.sentence,
      '',
    ]),
  ].join('\n');
}

function extractReleaseExecutionApprovalBoundarySection(text = '', contractId = '') {
  const heading = releaseExecutionApprovalBoundarySectionHeadingFor(contractId);
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

function replaceReleaseExecutionApprovalBoundarySection(text = '', contractId = '', replacer = (section) => section) {
  const heading = releaseExecutionApprovalBoundarySectionHeadingFor(contractId);
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
  input.docsByPath[docsPath] = replaceReleaseExecutionApprovalBoundarySection(
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
    { key: 'sectionHeading', part: releaseExecutionApprovalBoundarySectionHeadingFor(contract.contractId) },
    ...REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SENTENCES.map((binding) => ({
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
  const sectionText = docsExists ? extractReleaseExecutionApprovalBoundarySection(docsText, contract.contractId) : null;
  const expectedParts = expectedPartsFor(contract);
  const positions = Object.fromEntries(expectedParts.map((entry) => [
    entry.key,
    sectionText == null ? -1 : indexOfPart(sectionText, entry.part),
  ]));
  const bindingPresence = Object.fromEntries(
    REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SENTENCES.map((binding) => [
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
      'report_contract_doc_page_release_execution_approval_boundary_section_docs_missing',
      `${contract.contractId} docs file must exist at ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(sectionText != null ? [] : [blocker(
      'report_contract_doc_page_release_execution_approval_boundary_section_missing',
      `${docsPath} must include ${releaseExecutionApprovalBoundarySectionHeadingFor(contract.contractId)}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SENTENCES.flatMap((binding) => (
      bindingPresence[presenceKey(binding.key)] ? [] : [blocker(
        binding.blockerCode,
        `${docsPath} release execution approval boundary section must include the canonical ${binding.label} binding sentence.`,
        { contractId: contract.contractId, docsPath },
      )]
    )),
    ...(orderValid ? [] : [blocker(
      'report_contract_doc_page_release_execution_approval_boundary_section_order_invalid',
      `${docsPath} release execution approval boundary section must order heading, release execution intent capture artifact approval, strict gate execution approval boundary, freshness execution approval boundary, checkpoint execution approval boundary, retention dry-run execution approval boundary, seed-clean probe execution approval boundary, current-chat explicit execution approval, then approval prerequisite and write-denial.`,
      { contractId: contract.contractId, docsPath, positions },
    )]),
  ];
  return {
    contractId: contract.contractId,
    label: contract.label,
    scriptId: contract.scriptId,
    fileId: contract.fileId,
    docsPath,
    status: blockers.length ? 'blocked_report_contract_doc_page_release_execution_approval_boundary_section_contract' : 'pass_report_contract_doc_page_release_execution_approval_boundary_section_contract',
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
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SENTENCES.map((binding) => [
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

function analyzeDocPageReleaseExecutionApprovalBoundarySections(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract).map((contract) => analyzeContract(contract, input));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_doc_page_release_execution_approval_boundary_section_analysis' : 'pass_report_contract_doc_page_release_execution_approval_boundary_section_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    uniqueDocsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    sectionCount: contracts.filter((contract) => contract.sectionPresent).length,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SENTENCES.map((binding) => [
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
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SENTENCES.map((binding) => [
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
  const analysis = analyzeDocPageReleaseExecutionApprovalBoundarySections(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_doc_page_release_execution_approval_boundary_section_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract docs page release execution approval boundary section analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_doc_page_release_execution_approval_boundary_section_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_doc_page_release_execution_approval_boundary_section_scenario' : 'pass_report_contract_doc_page_release_execution_approval_boundary_section_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionInput({
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

export function buildReportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionInput({
    manifest,
    docsByPath,
    docPathOverrides,
  });
  const actual = analyzeDocPageReleaseExecutionApprovalBoundarySections(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_doc_page_release_execution_approval_boundary_sections',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_REGRESSION_VERSION,
    kind: 'ReportContractDocPageReleaseExecutionApprovalBoundarySectionRegression',
    status: blockers.length ? 'blocked_report_contract_doc_page_release_execution_approval_boundary_section_regression' : 'pass_report_contract_doc_page_release_execution_approval_boundary_section_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docsPaths: uniqueSorted(baseInput.manifest.map((contract) => docsPathFor(contract, baseInput.docPathOverrides))),
      docPathOverrides: baseInput.docPathOverrides,
      sectionHeadingPrefix: SECTION_HEADING_PREFIX,
      requiredSentences: REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SENTENCES.map((binding) => ({
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
      ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SENTENCES.map((binding) => [
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
  const contractDocPageReleaseExecutionApprovalBoundarySectionRegressionHash = digest({
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
    contractDocPageReleaseExecutionApprovalBoundarySectionRegressionHash,
    hash: contractDocPageReleaseExecutionApprovalBoundarySectionRegressionHash,
  };
}

export function summarizeReportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractDocPageReleaseExecutionApprovalBoundarySectionRegressionHash: report.contractDocPageReleaseExecutionApprovalBoundarySectionRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    uniqueDocsPathCount: report.summary?.uniqueDocsPathCount ?? null,
    docsFileCount: report.summary?.docsFileCount ?? null,
    sectionCount: report.summary?.sectionCount ?? null,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_RELEASE_EXECUTION_APPROVAL_BOUNDARY_SECTION_SENTENCES.map((binding) => [
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
