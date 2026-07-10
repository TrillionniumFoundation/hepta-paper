import {
  REPORT_CONTRACT_MANIFEST,
} from './report-contract-manifest.mjs';
import {
  REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} from './report-contract-doc-coverage-regression.mjs';
import {
  buildSentenceSectionHeading,
  buildSentenceSectionMarkdownBlock,
  buildSentenceSectionRegressionInput,
  buildSentenceSectionRegressionReport,
  buildSentenceSectionRegressionScenarios,
  summarizeSentenceSectionRegressionReport,
} from './report-contract-doc-page-section-regression-core.mjs';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-release-post-action-receipt-denial-section-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-release-post-action-receipt-denial-section-regression';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_REGRESSION_STEP_ID = 'report_contract_doc_page_release_post_action_receipt_denial_section_regression_export';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_RECEIPT_EVIDENCE_DENIAL_ARTIFACT_SENTENCE = 'Release receipt-evidence denial artifact post-action receipt entry: release post-action receipt denial sections must name reports/report-contract-doc-page-release-receipt-evidence-denial-section-regression-latest.json and reports/report-contract-doc-page-release-receipt-evidence-denial-section-regression-latest.md as upstream receipt-evidence denial evidence, require the contractDocPageReleaseReceiptEvidenceDenialSectionRegressionHash sha256 plus zero blockers, name reports/post-action-evidence-matrix-latest.json and reports/post-action-evidence-matrix-latest.md as runtime post-action receipt/proof evidence, require the postActionEvidenceMatrixHash sha256 plus zero blockers, and state that receipt-evidence denial evidence only permits local read-only post-action receipt review, not post-action receipt write, receipt write, receipt append, receipt mutation, receipt replay, audit write, audit mutation, ledger mutation, ledger append, proof-bundle execution, live replay, runner dispatch, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, replay execution, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_STRICT_GATE_SENTENCE = 'Strict gate post-action receipt denial entry: release post-action receipt denial sections must name reports/integration-dependency-gate-latest.json and reports/integration-dependency-gate-latest.md as strict gate evidence and require the final gateHash sha256 plus zero blockers before any post-action receipt review can be discussed, while stating that a passing gate cannot grant archive, delete, upload, submit, IM, acceptance, payment, deployment, provider/model spend, browser live action, runner dispatch, approval, write-adapter implementation, dry-run replay execution, ledger mutation, audit write, receipt write, post-action receipt write, post-action receipt mutation, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_FRESHNESS_SENTENCE = 'Freshness post-action receipt denial entry: release post-action receipt denial sections must name reports/report-freshness-latest.json and reports/report-freshness-latest.md as freshness evidence and require reportCount=okReportCount, comparableGateReportCount=gateHashMatchCount, gateHashMismatchCount=0, and the final freshnessHash to be bound before post-action receipt denial can remain reviewable.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_CHECKPOINT_SENTENCE = 'Checkpoint post-action receipt denial entry: release post-action receipt denial sections must name reports/architecture-checkpoint-latest.json and reports/architecture-checkpoint-latest.md as checkpoint evidence and require checkpointHash plus final reportFreshnessHash, postActionRuntimeStatusRequiredSummaryMetrics=64, postActionRuntimeStatusRequiredSummaryMetricOk=64, postActionRuntimeStatusRequiredSummaryMetricsOk=true, reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionHash, and reportContractDocPageReleasePostActionReceiptDenialSectionRegressionHash bindings to be recorded as post-action-receipt-denial evidence, not as proof-bundle execution, live replay, dispatch, platform write, local state transition, write-adapter enablement, ledger mutation, ledger append, audit write, receipt write, post-action receipt write, post-action receipt mutation, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_RETENTION_SENTENCE = 'Retention post-action receipt denial entry: release post-action receipt denial sections must name reports/report-retention-latest.json plus npm run reports:prune:dry-run and require dryRun=true with archivedCount=0 to be recorded as retention evidence only, never as archive, delete, upload, submit, IM, acceptance, payment, deployment, runner dispatch, live replay, dry-run replay execution, ledger mutation, audit write, receipt write, post-action receipt write, post-action receipt mutation, write-adapter implementation, approval, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_SEED_CLEAN_SENTENCE = 'Seed-clean probe post-action receipt denial entry: release post-action receipt denial sections must name npm run reports:bootstrap-seeds -- --strict and require seededFileCount=0, skippedFileCount=5, activeBootstrapSeedReports=0, zero real placeholder tokens, and git diff --check -- . to be recorded as closeout proof only, not local state transition, runner dispatch, browser live action, dry-run replay execution, ledger mutation, audit write, receipt write, post-action receipt write, post-action receipt mutation, write-adapter implementation, approval, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_PRECONDITION_DENIAL_SENTENCE = 'Read-only post-action receipt precondition-denial entry: release post-action receipt denial sections must require any future post-action receipt review record to bind current chat id, requester identity, approval evidence id, intent evidence id, exact target, exact action, channel, task URL, account identity, seller identity, read-only platform-state snapshot id, snapshot capture method, snapshot timestamp, platform-state hash, DOM hash or API response hash when applicable, dry-run replay id, replay fixture path, replay input hash, expected mutation plan, proof bundle id, proof bundle path, proof bundle manifest hash, proof bundle artifact list hash, ledger id, ledger path, ledger schema path, ledger row id, ledger row hash, ledger append dry-run id, audit evidence id, audit evidence path, audit schema path, audit row id, audit row hash, audit append dry-run id, receipt evidence id, receipt evidence path, receipt schema path, receipt evidence hash, receipt append dry-run id, post-action receipt id, post-action receipt path, post-action receipt schema path, post-action receipt hash, post-action receipt append dry-run id, no-write adapter id, session target id, drift expiry, executor identity, and explicit no-live/no-write/no-ledger-mutation/no-audit-write/no-receipt-write/no-post-action-receipt-write wording while rejecting standing authorization, inherited approval, broad batch approval, stale snapshot, stale replay, stale proof bundle, stale ledger, stale audit evidence, stale receipt evidence, stale post-action receipt, and any post-action receipt record missing exact scope.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_LIVE_WRITE_DENIAL_SENTENCE = 'Post-action receipt/live write denial entry: release post-action receipt denial sections must state that post-action receipt evidence is evidence only; no post-action receipt write, post-action receipt append, post-action receipt mutation, post-action receipt replay, receipt write, receipt append, receipt mutation, receipt replay, audit write, audit append, audit mutation, audit replay, ledger mutation, ledger append, ledger replay, live replay, runner dispatch, click, POST, browser session, API write, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, snapshot replay, mutation replay, proof-bundle execution, proof-bundle replay, ledger execution, audit execution, receipt execution, or post-action receipt execution may be implemented, enabled, called, or consumed from this guard; any future dispatch implementation still requires a separate implementation gate, exact platform-state, dry-run replay, proof bundle, ledger, audit evidence, receipt evidence, post-action receipt evidence, and a fresh current-chat approval before live execution can even be considered.';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_SENTENCES = Object.freeze([
  Object.freeze({
    key: 'releaseReceiptEvidenceDenialArtifactPostActionReceiptEntry',
    label: 'release receipt-evidence denial artifact post-action receipt entry',
    blockerCode: 'report_contract_doc_page_release_post_action_receipt_denial_section_release_receipt_evidence_denial_artifact_post_action_receipt_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_RECEIPT_EVIDENCE_DENIAL_ARTIFACT_SENTENCE,
  }),
  Object.freeze({
    key: 'strictGatePostActionReceiptDenialEntry',
    label: 'strict gate post-action receipt denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_receipt_denial_section_strict_gate_post_action_receipt_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_STRICT_GATE_SENTENCE,
  }),
  Object.freeze({
    key: 'freshnessPostActionReceiptDenialEntry',
    label: 'freshness post-action receipt denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_receipt_denial_section_freshness_post_action_receipt_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_FRESHNESS_SENTENCE,
  }),
  Object.freeze({
    key: 'checkpointPostActionReceiptDenialEntry',
    label: 'checkpoint post-action receipt denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_receipt_denial_section_checkpoint_post_action_receipt_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_CHECKPOINT_SENTENCE,
  }),
  Object.freeze({
    key: 'retentionPostActionReceiptDenialEntry',
    label: 'retention post-action receipt denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_receipt_denial_section_retention_post_action_receipt_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_RETENTION_SENTENCE,
  }),
  Object.freeze({
    key: 'seedCleanProbePostActionReceiptDenialEntry',
    label: 'seed-clean probe post-action receipt denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_receipt_denial_section_seed_clean_post_action_receipt_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_SEED_CLEAN_SENTENCE,
  }),
  Object.freeze({
    key: 'readOnlyPostActionReceiptPreconditionDenialEntry',
    label: 'read-only post-action receipt precondition-denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_receipt_denial_section_read_only_post_action_receipt_precondition_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_PRECONDITION_DENIAL_SENTENCE,
  }),
  Object.freeze({
    key: 'postActionReceiptLiveWriteDenialEntry',
    label: 'post-action receipt/live write denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_receipt_denial_section_post_action_receipt_live_write_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_LIVE_WRITE_DENIAL_SENTENCE,
  }),
]);

const TARGET_CONTRACT_ID = 'report_contract_manifest';
const SECTION_HEADING_PREFIX = '## Contract Page Release Post-Action Receipt Denial Section: ';

const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_REGRESSION_CONFIG = Object.freeze({
  version: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_REGRESSION_VERSION,
  kind: 'ReportContractDocPageReleasePostActionReceiptDenialSectionRegression',
  reportFileId: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_REGRESSION_REPORT_FILE_ID,
  scriptId: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_REGRESSION_SCRIPT_ID,
  headingPrefix: SECTION_HEADING_PREFIX,
  targetContractId: TARGET_CONTRACT_ID,
  sectionKindLabel: 'release post-action receipt denial section',
  statusSlug: 'report_contract_doc_page_release_post_action_receipt_denial_section',
  hashField: 'contractDocPageReleasePostActionReceiptDenialSectionRegressionHash',
  sentenceBindings: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_SENTENCES,
  actualBlockerSource: 'actual_doc_page_release_post_action_receipt_denial_sections',
  missingSectionScenario: Object.freeze({
    scenarioId: 'new_manifest_contract_without_release_post_action_receipt_denial_section',
    label: 'A new manifest contract is added with docs but without a release post-action receipt denial section',
    expectedBlockerCode: 'report_contract_doc_page_release_post_action_receipt_denial_section_missing',
    futureContract: Object.freeze({
      contractId: 'report_future_doc_page_release_post_action_receipt_denial_section',
      label: 'Report future doc page release post-action receipt denial section',
      scriptId: 'reports:future-doc-page-release-post-action-receipt-denial-section',
      fileId: 'report-future-doc-page-release-post-action-receipt-denial-section-latest.json',
    }),
    docsText: '# Report Future Doc Page Release Post-Action Receipt Denial Section\n',
  }),
  orderScenario: Object.freeze({
    scenarioId: 'release_post_action_receipt_denial_section_order_drift',
    label: 'A contract release post-action receipt denial section moves live write denial before the receipt-evidence denial artifact post-action receipt entry',
    expectedBlockerCode: 'report_contract_doc_page_release_post_action_receipt_denial_section_order_invalid',
    reorderedBindingKeys: Object.freeze([
      'postActionReceiptLiveWriteDenialEntry',
      'releaseReceiptEvidenceDenialArtifactPostActionReceiptEntry',
      'strictGatePostActionReceiptDenialEntry',
      'freshnessPostActionReceiptDenialEntry',
      'checkpointPostActionReceiptDenialEntry',
      'retentionPostActionReceiptDenialEntry',
      'seedCleanProbePostActionReceiptDenialEntry',
      'readOnlyPostActionReceiptPreconditionDenialEntry',
    ]),
  }),
  orderInvalidNotes: 'release post-action receipt denial section must order heading, release receipt-evidence denial artifact post-action receipt, strict gate post-action receipt denial, freshness post-action receipt denial, checkpoint post-action receipt denial, retention post-action receipt denial, seed-clean probe post-action receipt denial, read-only post-action receipt precondition denial, then post-action receipt/live write denial.',
  sharedDocPathOverrideScenario: Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: 'report_contract_doc_page_release_post_action_receipt_denial_section_docs_missing',
    overrideContractId: 'report_freshness_regression',
  }),
});

const NEGATIVE_SCENARIOS = buildSentenceSectionRegressionScenarios(
  REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_REGRESSION_CONFIG,
);

export function releasePostActionReceiptDenialSectionHeadingFor(contractId = '') {
  return buildSentenceSectionHeading({
    headingPrefix: SECTION_HEADING_PREFIX,
    contractId,
  });
}

export function buildReportContractDocPageReleasePostActionReceiptDenialSectionMarkdownBlock(contract = {}) {
  return buildSentenceSectionMarkdownBlock({
    headingPrefix: SECTION_HEADING_PREFIX,
    sentenceBindings: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_SENTENCES,
    contract,
  });
}

export function buildReportContractDocPageReleasePostActionReceiptDenialSectionRegressionInput({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
} = {}) {
  return buildSentenceSectionRegressionInput({
    manifest,
    docsByPath,
    docPathOverrides,
  });
}

export function buildReportContractDocPageReleasePostActionReceiptDenialSectionRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  return buildSentenceSectionRegressionReport(
    {
      ...REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_REGRESSION_CONFIG,
      negativeScenarios: NEGATIVE_SCENARIOS,
    },
    {
      manifest,
      docsByPath,
      docPathOverrides,
      generatedAt,
    },
  );
}

export function summarizeReportContractDocPageReleasePostActionReceiptDenialSectionRegressionReport(report = {}) {
  return summarizeSentenceSectionRegressionReport(
    REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_RECEIPT_DENIAL_SECTION_REGRESSION_CONFIG,
    report,
  );
}
