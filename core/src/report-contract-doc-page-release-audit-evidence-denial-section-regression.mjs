import { digest } from './hash-utils.mjs';
import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-release-audit-evidence-denial-section-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-release-audit-evidence-denial-section-regression';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_REGRESSION_STEP_ID = 'report_contract_doc_page_release_audit_evidence_denial_section_regression_export';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_LEDGER_DENIAL_ARTIFACT_SENTENCE = 'Release ledger denial artifact audit-evidence entry: release audit-evidence denial sections must name reports/report-contract-doc-page-release-ledger-denial-section-regression-latest.json and reports/report-contract-doc-page-release-ledger-denial-section-regression-latest.md as upstream ledger denial evidence, require the contractDocPageReleaseLedgerDenialSectionRegressionHash sha256 plus zero blockers, and state that ledger denial evidence only permits local read-only audit-evidence review, not audit write, audit mutation, ledger mutation, ledger append, proof-bundle execution, live replay, runner dispatch, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, replay execution, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_STRICT_GATE_SENTENCE = 'Strict gate audit-evidence denial entry: release audit-evidence denial sections must name reports/integration-dependency-gate-latest.json and reports/integration-dependency-gate-latest.md as strict gate evidence and require the final gateHash sha256 plus zero blockers before any audit-evidence review can be discussed, while stating that a passing gate cannot grant archive, delete, upload, submit, IM, acceptance, payment, deployment, provider/model spend, browser live action, runner dispatch, approval, write-adapter implementation, dry-run replay execution, ledger mutation, audit write, audit mutation, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_FRESHNESS_SENTENCE = 'Freshness audit-evidence denial entry: release audit-evidence denial sections must name reports/report-freshness-latest.json and reports/report-freshness-latest.md as freshness evidence and require reportCount=okReportCount, comparableGateReportCount=gateHashMatchCount, gateHashMismatchCount=0, and the final freshnessHash to be bound before audit-evidence denial can remain reviewable.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_CHECKPOINT_SENTENCE = 'Checkpoint audit-evidence denial entry: release audit-evidence denial sections must name reports/architecture-checkpoint-latest.json and reports/architecture-checkpoint-latest.md as checkpoint evidence and require checkpointHash plus final reportFreshnessHash, reportContractDocPageReleaseLedgerDenialSectionRegressionHash, and reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionHash bindings to be recorded as audit-evidence-denial evidence, not as proof-bundle execution, live replay, dispatch, platform write, local state transition, write-adapter enablement, ledger mutation, ledger append, audit write, audit mutation, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_RETENTION_SENTENCE = 'Retention audit-evidence denial entry: release audit-evidence denial sections must name reports/report-retention-latest.json plus npm run reports:prune:dry-run and require dryRun=true with archivedCount=0 to be recorded as retention evidence only, never as archive, delete, upload, submit, IM, acceptance, payment, deployment, runner dispatch, live replay, dry-run replay execution, ledger mutation, audit write, audit mutation, write-adapter implementation, approval, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SEED_CLEAN_SENTENCE = 'Seed-clean probe audit-evidence denial entry: release audit-evidence denial sections must name npm run reports:bootstrap-seeds -- --strict and require seededFileCount=0, skippedFileCount=5, activeBootstrapSeedReports=0, zero real placeholder tokens, and git diff --check -- . to be recorded as closeout proof only, not local state transition, runner dispatch, browser live action, dry-run replay execution, ledger mutation, audit write, audit mutation, write-adapter implementation, approval, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_PRECONDITION_DENIAL_SENTENCE = 'Read-only audit-evidence precondition-denial entry: release audit-evidence denial sections must require any future audit-evidence review record to bind current chat id, requester identity, approval evidence id, intent evidence id, exact target, exact action, channel, task URL, account identity, seller identity, read-only platform-state snapshot id, snapshot capture method, snapshot timestamp, platform-state hash, DOM hash or API response hash when applicable, dry-run replay id, replay fixture path, replay input hash, expected mutation plan, proof bundle id, proof bundle path, proof bundle manifest hash, proof bundle artifact list hash, receipt schema path, ledger id, ledger path, ledger schema path, ledger row id, ledger row hash, ledger append dry-run id, audit evidence id, audit evidence path, audit schema path, audit row id, audit row hash, audit append dry-run id, no-write adapter id, session target id, drift expiry, executor identity, and explicit no-live/no-write/no-ledger-mutation/no-audit-write wording while rejecting standing authorization, inherited approval, broad batch approval, stale snapshot, stale replay, stale proof bundle, stale ledger, stale audit evidence, and any audit record missing exact scope.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_LIVE_WRITE_DENIAL_SENTENCE = 'Audit evidence/live write denial entry: release audit-evidence denial sections must state that audit evidence is evidence only; no audit write, audit append, audit mutation, audit replay, ledger mutation, ledger append, ledger replay, live replay, runner dispatch, click, POST, browser session, API write, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, snapshot replay, mutation replay, proof-bundle execution, proof-bundle replay, ledger execution, or audit execution may be implemented, enabled, called, or consumed from this guard; any future dispatch implementation still requires a separate implementation gate, exact platform-state, dry-run replay, post-action receipt, proof bundle, ledger, audit evidence, and a fresh current-chat approval before live execution can even be considered.';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SENTENCES = Object.freeze([
  Object.freeze({
    key: 'releaseLedgerDenialArtifactAuditEvidenceEntry',
    label: 'release ledger denial artifact audit-evidence entry',
    blockerCode: 'report_contract_doc_page_release_audit_evidence_denial_section_release_ledger_denial_artifact_audit_evidence_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_LEDGER_DENIAL_ARTIFACT_SENTENCE,
  }),
  Object.freeze({
    key: 'strictGateAuditEvidenceDenialEntry',
    label: 'strict gate audit-evidence denial entry',
    blockerCode: 'report_contract_doc_page_release_audit_evidence_denial_section_strict_gate_audit_evidence_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_STRICT_GATE_SENTENCE,
  }),
  Object.freeze({
    key: 'freshnessAuditEvidenceDenialEntry',
    label: 'freshness audit-evidence denial entry',
    blockerCode: 'report_contract_doc_page_release_audit_evidence_denial_section_freshness_audit_evidence_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_FRESHNESS_SENTENCE,
  }),
  Object.freeze({
    key: 'checkpointAuditEvidenceDenialEntry',
    label: 'checkpoint audit-evidence denial entry',
    blockerCode: 'report_contract_doc_page_release_audit_evidence_denial_section_checkpoint_audit_evidence_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_CHECKPOINT_SENTENCE,
  }),
  Object.freeze({
    key: 'retentionAuditEvidenceDenialEntry',
    label: 'retention audit-evidence denial entry',
    blockerCode: 'report_contract_doc_page_release_audit_evidence_denial_section_retention_audit_evidence_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_RETENTION_SENTENCE,
  }),
  Object.freeze({
    key: 'seedCleanProbeAuditEvidenceDenialEntry',
    label: 'seed-clean probe audit-evidence denial entry',
    blockerCode: 'report_contract_doc_page_release_audit_evidence_denial_section_seed_clean_audit_evidence_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SEED_CLEAN_SENTENCE,
  }),
  Object.freeze({
    key: 'readOnlyAuditEvidencePreconditionDenialEntry',
    label: 'read-only audit-evidence precondition-denial entry',
    blockerCode: 'report_contract_doc_page_release_audit_evidence_denial_section_read_only_audit_evidence_precondition_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_PRECONDITION_DENIAL_SENTENCE,
  }),
  Object.freeze({
    key: 'auditEvidenceLiveWriteDenialEntry',
    label: 'audit evidence/live write denial entry',
    blockerCode: 'report_contract_doc_page_release_audit_evidence_denial_section_audit_evidence_live_write_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_LIVE_WRITE_DENIAL_SENTENCE,
  }),
]);

const TARGET_CONTRACT_ID = 'report_contract_manifest';
const SECTION_HEADING_PREFIX = '## Contract Page Release Audit-Evidence Denial Section: ';

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'new_manifest_contract_without_release_audit_evidence_denial_section',
    label: 'A new manifest contract is added with docs but without a release audit-evidence denial section',
    expectedBlockerCode: 'report_contract_doc_page_release_audit_evidence_denial_section_missing',
    mutate(input) {
      const contract = {
        contractId: 'report_future_doc_page_release_audit_evidence_denial_section',
        label: 'Report future doc page release audit-evidence denial section',
        scriptId: 'reports:future-doc-page-release-audit-evidence-denial-section',
        fileId: 'report-future-doc-page-release-audit-evidence-denial-section-latest.json',
      };
      input.manifest.push(contract);
      input.docsByPath[docsPathFor(contract, input.docPathOverrides)] = '# Report Future Doc Page Release Audit-Evidence Denial Section\n';
    },
  }),
  ...REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SENTENCES.map((binding) => Object.freeze({
    scenarioId: `${binding.label.replace(/\s+/g, '_')}_binding_missing`,
    label: `A contract release audit-evidence denial section loses its ${binding.label} binding sentence`,
    expectedBlockerCode: binding.blockerCode,
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section.replace(binding.sentence, ''));
    },
  })),
  Object.freeze({
    scenarioId: 'release_audit_evidence_denial_section_order_drift',
    label: 'A contract release audit-evidence denial section moves live write denial before the ledger denial artifact audit-evidence entry',
    expectedBlockerCode: 'report_contract_doc_page_release_audit_evidence_denial_section_order_invalid',
    mutate(input) {
      mutateTargetDocsSection(input, (section) => section
        .replace(
          `${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_LEDGER_DENIAL_ARTIFACT_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_STRICT_GATE_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_FRESHNESS_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_CHECKPOINT_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_RETENTION_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SEED_CLEAN_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_PRECONDITION_DENIAL_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_LIVE_WRITE_DENIAL_SENTENCE}`,
          `${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_LIVE_WRITE_DENIAL_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_LEDGER_DENIAL_ARTIFACT_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_STRICT_GATE_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_FRESHNESS_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_CHECKPOINT_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_RETENTION_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SEED_CLEAN_SENTENCE}\n\n${REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_PRECONDITION_DENIAL_SENTENCE}`,
        ));
    },
  }),
  Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: 'report_contract_doc_page_release_audit_evidence_denial_section_docs_missing',
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

export function releaseAuditEvidenceDenialSectionHeadingFor(contractId = '') {
  return `${SECTION_HEADING_PREFIX}${contractId}`;
}

export function buildReportContractDocPageReleaseAuditEvidenceDenialSectionMarkdownBlock(contract = {}) {
  return [
    releaseAuditEvidenceDenialSectionHeadingFor(contract.contractId),
    '',
    ...REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SENTENCES.flatMap((binding) => [
      binding.sentence,
      '',
    ]),
  ].join('\n');
}

function extractReleaseAuditEvidenceDenialSection(text = '', contractId = '') {
  const heading = releaseAuditEvidenceDenialSectionHeadingFor(contractId);
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

function replaceReleaseAuditEvidenceDenialSection(text = '', contractId = '', replacer = (section) => section) {
  const heading = releaseAuditEvidenceDenialSectionHeadingFor(contractId);
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
  input.docsByPath[docsPath] = replaceReleaseAuditEvidenceDenialSection(
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
    { key: 'sectionHeading', part: releaseAuditEvidenceDenialSectionHeadingFor(contract.contractId) },
    ...REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SENTENCES.map((binding) => ({
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
  const sectionText = docsExists ? extractReleaseAuditEvidenceDenialSection(docsText, contract.contractId) : null;
  const expectedParts = expectedPartsFor(contract);
  const positions = Object.fromEntries(expectedParts.map((entry) => [
    entry.key,
    sectionText == null ? -1 : indexOfPart(sectionText, entry.part),
  ]));
  const bindingPresence = Object.fromEntries(
    REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SENTENCES.map((binding) => [
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
      'report_contract_doc_page_release_audit_evidence_denial_section_docs_missing',
      `${contract.contractId} docs file must exist at ${docsPath}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...(sectionText != null ? [] : [blocker(
      'report_contract_doc_page_release_audit_evidence_denial_section_missing',
      `${docsPath} must include ${releaseAuditEvidenceDenialSectionHeadingFor(contract.contractId)}.`,
      { contractId: contract.contractId, docsPath },
    )]),
    ...REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SENTENCES.flatMap((binding) => (
      bindingPresence[presenceKey(binding.key)] ? [] : [blocker(
        binding.blockerCode,
        `${docsPath} release audit-evidence denial section must include the canonical ${binding.label} binding sentence.`,
        { contractId: contract.contractId, docsPath },
      )]
    )),
    ...(orderValid ? [] : [blocker(
      'report_contract_doc_page_release_audit_evidence_denial_section_order_invalid',
      `${docsPath} release audit-evidence denial section must order heading, release ledger denial artifact audit-evidence, strict gate audit-evidence denial, freshness audit-evidence denial, checkpoint audit-evidence denial, retention audit-evidence denial, seed-clean probe audit-evidence denial, read-only audit-evidence precondition denial, then audit evidence/live write denial.`,
      { contractId: contract.contractId, docsPath, positions },
    )]),
  ];
  return {
    contractId: contract.contractId,
    label: contract.label,
    scriptId: contract.scriptId,
    fileId: contract.fileId,
    docsPath,
    status: blockers.length ? 'blocked_report_contract_doc_page_release_audit_evidence_denial_section_contract' : 'pass_report_contract_doc_page_release_audit_evidence_denial_section_contract',
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
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SENTENCES.map((binding) => [
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

function analyzeDocPageReleaseAuditEvidenceDenialSections(input = {}) {
  const contracts = (input.manifest || []).map(normalizeContract).map((contract) => analyzeContract(contract, input));
  const blockers = contracts.flatMap((contract) => contract.blockers);
  return {
    status: blockers.length ? 'blocked_report_contract_doc_page_release_audit_evidence_denial_section_analysis' : 'pass_report_contract_doc_page_release_audit_evidence_denial_section_analysis',
    ok: blockers.length === 0,
    contractCount: contracts.length,
    okContractCount: contracts.filter((contract) => contract.ok).length,
    uniqueDocsPathCount: uniqueSorted(contracts.map((contract) => contract.docsPath)).length,
    docsFileCount: contracts.filter((contract) => contract.docsExists).length,
    sectionCount: contracts.filter((contract) => contract.sectionPresent).length,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SENTENCES.map((binding) => [
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
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SENTENCES.map((binding) => [
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
  const analysis = analyzeDocPageReleaseAuditEvidenceDenialSections(input);
  const observedBlockerCodes = uniqueSorted(analysis.blockers.map((item) => item.code));
  const blockers = [
    ...(analysis.ok === true ? [blocker(
      'report_contract_doc_page_release_audit_evidence_denial_section_scenario_unexpectedly_passed',
      `${scenario.scenarioId} must fail report contract docs page release audit-evidence denial section analysis.`,
    )] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [blocker(
      'report_contract_doc_page_release_audit_evidence_denial_section_expected_blocker_missing',
      `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, observed ${observedBlockerCodes.join(', ') || 'none'}.`,
    )] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_contract_doc_page_release_audit_evidence_denial_section_scenario' : 'pass_report_contract_doc_page_release_audit_evidence_denial_section_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportContractDocPageReleaseAuditEvidenceDenialSectionRegressionInput({
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

export function buildReportContractDocPageReleaseAuditEvidenceDenialSectionRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseInput = buildReportContractDocPageReleaseAuditEvidenceDenialSectionRegressionInput({
    manifest,
    docsByPath,
    docPathOverrides,
  });
  const actual = analyzeDocPageReleaseAuditEvidenceDenialSections(baseInput);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, baseInput));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_doc_page_release_audit_evidence_denial_sections',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_REGRESSION_VERSION,
    kind: 'ReportContractDocPageReleaseAuditEvidenceDenialSectionRegression',
    status: blockers.length ? 'blocked_report_contract_doc_page_release_audit_evidence_denial_section_regression' : 'pass_report_contract_doc_page_release_audit_evidence_denial_section_regression',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_REGRESSION_REPORT_FILE_ID,
    scriptId: REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_REGRESSION_SCRIPT_ID,
    fixture: {
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
      scenarioIds: NEGATIVE_SCENARIOS.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: NEGATIVE_SCENARIOS.map((scenario) => scenario.expectedBlockerCode),
      contractIds: baseInput.manifest.map((contract) => contract.contractId),
      docsPaths: uniqueSorted(baseInput.manifest.map((contract) => docsPathFor(contract, baseInput.docPathOverrides))),
      docPathOverrides: baseInput.docPathOverrides,
      sectionHeadingPrefix: SECTION_HEADING_PREFIX,
      requiredSentences: REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SENTENCES.map((binding) => ({
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
      ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SENTENCES.map((binding) => [
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
  const contractDocPageReleaseAuditEvidenceDenialSectionRegressionHash = digest({
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
    contractDocPageReleaseAuditEvidenceDenialSectionRegressionHash,
    hash: contractDocPageReleaseAuditEvidenceDenialSectionRegressionHash,
  };
}

export function summarizeReportContractDocPageReleaseAuditEvidenceDenialSectionRegressionReport(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || null,
    contractDocPageReleaseAuditEvidenceDenialSectionRegressionHash: report.contractDocPageReleaseAuditEvidenceDenialSectionRegressionHash || null,
    actualOk: report.summary?.actualOk === true,
    contractCount: report.summary?.contractCount ?? null,
    okContractCount: report.summary?.okContractCount ?? null,
    uniqueDocsPathCount: report.summary?.uniqueDocsPathCount ?? null,
    docsFileCount: report.summary?.docsFileCount ?? null,
    sectionCount: report.summary?.sectionCount ?? null,
    ...Object.fromEntries(REPORT_CONTRACT_DOC_PAGE_RELEASE_AUDIT_EVIDENCE_DENIAL_SECTION_SENTENCES.map((binding) => [
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
