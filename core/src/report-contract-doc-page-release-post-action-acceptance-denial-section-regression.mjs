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

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-release-post-action-acceptance-denial-section-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-release-post-action-acceptance-denial-section-regression';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_REGRESSION_STEP_ID = 'report_contract_doc_page_release_post_action_acceptance_denial_section_regression_export';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_POST_ACTION_SETTLEMENT_DENIAL_ARTIFACT_SENTENCE = 'Release post-action settlement denial artifact post-action acceptance entry: release post-action acceptance denial sections must name reports/report-contract-doc-page-release-post-action-settlement-denial-section-regression-latest.json and reports/report-contract-doc-page-release-post-action-settlement-denial-section-regression-latest.md as upstream post-action settlement denial evidence, require the contractDocPageReleasePostActionSettlementDenialSectionRegressionHash sha256 plus zero blockers, name reports/post-action-reconciliation-matrix-latest.json and reports/post-action-reconciliation-matrix-latest.md as runtime post-action reconciliation evidence required before acceptance review, require the postActionReconciliationMatrixHash sha256 plus zero blockers, and state that post-action settlement denial evidence only permits local read-only post-action acceptance review, not post-action acceptance write, post-action acceptance append, post-action acceptance mutation, post-action acceptance replay, post-action settlement write, post-action settlement append, post-action settlement mutation, post-action settlement replay, post-action reconciliation write, post-action reconciliation append, post-action reconciliation mutation, post-action reconciliation replay, post-action audit write, post-action audit append, post-action audit mutation, post-action audit replay, post-action receipt write, post-action receipt append, post-action receipt mutation, post-action receipt replay, receipt write, receipt append, receipt mutation, receipt replay, audit write, audit mutation, ledger mutation, ledger append, proof-bundle execution, live replay, runner dispatch, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, replay execution, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_STRICT_GATE_SENTENCE = 'Strict gate post-action acceptance denial entry: release post-action acceptance denial sections must name reports/integration-dependency-gate-latest.json and reports/integration-dependency-gate-latest.md as strict gate evidence and require the final gateHash sha256 plus zero blockers before any post-action acceptance review can be discussed, while stating that a passing gate cannot grant archive, delete, upload, submit, IM, acceptance, payment, deployment, provider/model spend, browser live action, runner dispatch, approval, write-adapter implementation, dry-run replay execution, ledger mutation, audit write, receipt write, post-action receipt write, post-action receipt mutation, post-action audit write, post-action audit mutation, post-action reconciliation write, post-action reconciliation mutation, post-action settlement write, post-action settlement mutation, post-action acceptance write, post-action acceptance mutation, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_FRESHNESS_SENTENCE = 'Freshness post-action acceptance denial entry: release post-action acceptance denial sections must name reports/report-freshness-latest.json and reports/report-freshness-latest.md as freshness evidence and require reportCount=okReportCount, comparableGateReportCount=gateHashMatchCount, gateHashMismatchCount=0, and the final freshnessHash to be bound before post-action acceptance denial can remain reviewable.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_CHECKPOINT_SENTENCE = 'Checkpoint post-action acceptance denial entry: release post-action acceptance denial sections must name reports/architecture-checkpoint-latest.json and reports/architecture-checkpoint-latest.md as checkpoint evidence and require checkpointHash plus final reportFreshnessHash, postActionRuntimeStatusRequiredSummaryMetrics=64, postActionRuntimeStatusRequiredSummaryMetricOk=64, postActionRuntimeStatusRequiredSummaryMetricsOk=true, reportContractDocPageReleasePostActionSettlementDenialSectionRegressionHash, and reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionHash bindings to be recorded as post-action-acceptance-denial evidence, not as proof-bundle execution, live replay, dispatch, platform write, local state transition, write-adapter enablement, ledger mutation, ledger append, audit write, receipt write, post-action receipt write, post-action receipt mutation, post-action audit write, post-action audit mutation, post-action reconciliation write, post-action reconciliation mutation, post-action settlement write, post-action settlement mutation, post-action acceptance write, post-action acceptance mutation, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_RETENTION_SENTENCE = 'Retention post-action acceptance denial entry: release post-action acceptance denial sections must name reports/report-retention-latest.json plus npm run reports:prune:dry-run and require dryRun=true with archivedCount=0 to be recorded as retention evidence only, never as archive, delete, upload, submit, IM, acceptance, payment, deployment, runner dispatch, live replay, dry-run replay execution, ledger mutation, audit write, receipt write, post-action receipt write, post-action receipt mutation, post-action audit write, post-action audit mutation, post-action reconciliation write, post-action reconciliation mutation, post-action settlement write, post-action settlement mutation, post-action acceptance write, post-action acceptance mutation, write-adapter implementation, approval, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_SEED_CLEAN_SENTENCE = 'Seed-clean probe post-action acceptance denial entry: release post-action acceptance denial sections must name npm run reports:bootstrap-seeds -- --strict and require seededFileCount=0, skippedFileCount=5, activeBootstrapSeedReports=0, zero real placeholder tokens, and git diff --check -- . to be recorded as closeout proof only, not local state transition, runner dispatch, browser live action, dry-run replay execution, ledger mutation, audit write, receipt write, post-action receipt write, post-action receipt mutation, post-action audit write, post-action audit mutation, post-action reconciliation write, post-action reconciliation mutation, post-action settlement write, post-action settlement mutation, post-action acceptance write, post-action acceptance mutation, write-adapter implementation, approval, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_PRECONDITION_DENIAL_SENTENCE = 'Read-only post-action acceptance precondition-denial entry: release post-action acceptance denial sections must require any future post-action acceptance review record to bind current chat id, requester identity, approval evidence id, intent evidence id, exact target, exact action, channel, task URL, account identity, seller identity, read-only platform-state snapshot id, snapshot capture method, snapshot timestamp, platform-state hash, DOM hash or API response hash when applicable, dry-run replay id, replay fixture path, replay input hash, expected mutation plan, proof bundle id, proof bundle path, proof bundle manifest hash, proof bundle artifact list hash, ledger id, ledger path, ledger schema path, ledger row id, ledger row hash, ledger append dry-run id, audit evidence id, audit evidence path, audit schema path, audit row id, audit row hash, audit append dry-run id, receipt evidence id, receipt evidence path, receipt schema path, receipt evidence hash, receipt append dry-run id, post-action receipt id, post-action receipt path, post-action receipt schema path, post-action receipt hash, post-action receipt append dry-run id, post-action audit id, post-action audit path, post-action audit schema path, post-action audit hash, post-action audit append dry-run id, post-action reconciliation id, post-action reconciliation path, post-action reconciliation schema path, post-action reconciliation hash, post-action reconciliation append dry-run id, post-action settlement id, post-action settlement path, post-action settlement schema path, post-action settlement hash, post-action settlement append dry-run id, post-action acceptance id, post-action acceptance path, post-action acceptance schema path, post-action acceptance hash, post-action acceptance append dry-run id, no-write adapter id, session target id, drift expiry, executor identity, and explicit no-live/no-write/no-ledger-mutation/no-audit-write/no-receipt-write/no-post-action-receipt-write/no-post-action-audit-write/no-post-action-reconciliation-write/no-post-action-settlement-write/no-post-action-acceptance-write wording while rejecting standing authorization, inherited approval, broad batch approval, stale snapshot, stale replay, stale proof bundle, stale ledger, stale audit evidence, stale receipt evidence, stale post-action receipt, stale post-action audit, stale post-action reconciliation, stale post-action settlement, stale post-action acceptance, and any post-action acceptance record missing exact scope.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_LIVE_WRITE_DENIAL_SENTENCE = 'Post-action acceptance/live write denial entry: release post-action acceptance denial sections must state that post-action acceptance evidence is evidence only; no post-action acceptance write, post-action acceptance append, post-action acceptance mutation, post-action acceptance replay, post-action settlement write, post-action settlement append, post-action settlement mutation, post-action settlement replay, post-action reconciliation write, post-action reconciliation append, post-action reconciliation mutation, post-action reconciliation replay, post-action audit write, post-action audit append, post-action audit mutation, post-action audit replay, post-action receipt write, post-action receipt append, post-action receipt mutation, post-action receipt replay, receipt write, receipt append, receipt mutation, receipt replay, audit write, audit append, audit mutation, audit replay, ledger mutation, ledger append, ledger replay, live replay, runner dispatch, click, POST, browser session, API write, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, background runner action, external action, snapshot replay, mutation replay, proof-bundle execution, proof-bundle replay, ledger execution, audit execution, receipt execution, post-action receipt execution, post-action audit execution, post-action reconciliation execution, post-action settlement execution, or post-action acceptance execution may be implemented, enabled, called, or consumed from this guard; any future dispatch implementation still requires a separate implementation gate, exact platform-state, dry-run replay, proof bundle, ledger, audit evidence, receipt evidence, post-action receipt evidence, post-action audit evidence, post-action reconciliation evidence, post-action settlement evidence, post-action acceptance evidence, and a fresh current-chat approval before live execution can even be considered.';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_SENTENCES = Object.freeze([
  Object.freeze({
    key: 'releasePostActionSettlementDenialArtifactPostActionAcceptanceEntry',
    label: 'release post-action settlement denial artifact post-action acceptance entry',
    blockerCode: 'report_contract_doc_page_release_post_action_acceptance_denial_section_release_post_action_settlement_denial_artifact_post_action_acceptance_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_POST_ACTION_SETTLEMENT_DENIAL_ARTIFACT_SENTENCE,
  }),
  Object.freeze({
    key: 'strictGatePostActionAcceptanceDenialEntry',
    label: 'strict gate post-action acceptance denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_acceptance_denial_section_strict_gate_post_action_acceptance_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_STRICT_GATE_SENTENCE,
  }),
  Object.freeze({
    key: 'freshnessPostActionAcceptanceDenialEntry',
    label: 'freshness post-action acceptance denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_acceptance_denial_section_freshness_post_action_acceptance_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_FRESHNESS_SENTENCE,
  }),
  Object.freeze({
    key: 'checkpointPostActionAcceptanceDenialEntry',
    label: 'checkpoint post-action acceptance denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_acceptance_denial_section_checkpoint_post_action_acceptance_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_CHECKPOINT_SENTENCE,
  }),
  Object.freeze({
    key: 'retentionPostActionAcceptanceDenialEntry',
    label: 'retention post-action acceptance denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_acceptance_denial_section_retention_post_action_acceptance_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_RETENTION_SENTENCE,
  }),
  Object.freeze({
    key: 'seedCleanProbePostActionAcceptanceDenialEntry',
    label: 'seed-clean probe post-action acceptance denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_acceptance_denial_section_seed_clean_post_action_acceptance_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_SEED_CLEAN_SENTENCE,
  }),
  Object.freeze({
    key: 'readOnlyPostActionAcceptancePreconditionDenialEntry',
    label: 'read-only post-action acceptance precondition-denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_acceptance_denial_section_read_only_post_action_acceptance_precondition_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_PRECONDITION_DENIAL_SENTENCE,
  }),
  Object.freeze({
    key: 'postActionAcceptanceLiveWriteDenialEntry',
    label: 'post-action acceptance/live write denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_acceptance_denial_section_post_action_acceptance_live_write_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_LIVE_WRITE_DENIAL_SENTENCE,
  }),
]);

const TARGET_CONTRACT_ID = 'report_contract_manifest';
const SECTION_HEADING_PREFIX = "## Contract Page Release Post-Action Acceptance Denial Section: ";

const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_REGRESSION_CONFIG = Object.freeze({
  version: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_REGRESSION_VERSION,
  kind: "ReportContractDocPageReleasePostActionAcceptanceDenialSectionRegression",
  reportFileId: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_REGRESSION_REPORT_FILE_ID,
  scriptId: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_REGRESSION_SCRIPT_ID,
  headingPrefix: SECTION_HEADING_PREFIX,
  targetContractId: TARGET_CONTRACT_ID,
  sectionKindLabel: "release post-action acceptance denial section",
  statusSlug: "report_contract_doc_page_release_post_action_acceptance_denial_section",
  hashField: "contractDocPageReleasePostActionAcceptanceDenialSectionRegressionHash",
  sentenceBindings: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_SENTENCES,
  actualBlockerSource: "actual_doc_page_release_post_action_acceptance_denial_sections",
  missingSectionScenario: Object.freeze({
    scenarioId: "new_manifest_contract_without_release_post_action_acceptance_denial_section",
    label: "A new manifest contract is added with docs but without a release post-action acceptance denial section",
    expectedBlockerCode: "report_contract_doc_page_release_post_action_acceptance_denial_section_missing",
    futureContract: Object.freeze({
      contractId: "report_future_doc_page_release_post_action_acceptance_denial_section",
      label: "Report future doc page release post-action acceptance denial section",
      scriptId: "reports:future-doc-page-release-post-action-acceptance-denial-section",
      fileId: "report-future-doc-page-release-post-action-acceptance-denial-section-latest.json",
    }),
    docsText: "# Report Future Doc Page Release Post-Action Acceptance Denial Section\\n",
  }),
  orderScenario: Object.freeze({
    scenarioId: "release_post_action_acceptance_denial_section_order_drift",
    label: "A contract release post-action acceptance denial section moves live write denial before the first evidence binding",
    expectedBlockerCode: "report_contract_doc_page_release_post_action_acceptance_denial_section_order_invalid",
    reorderedBindingKeys: Object.freeze([
      "postActionAcceptanceLiveWriteDenialEntry",
      "releasePostActionSettlementDenialArtifactPostActionAcceptanceEntry",
      "strictGatePostActionAcceptanceDenialEntry",
      "freshnessPostActionAcceptanceDenialEntry",
      "checkpointPostActionAcceptanceDenialEntry",
      "retentionPostActionAcceptanceDenialEntry",
      "seedCleanProbePostActionAcceptanceDenialEntry",
      "readOnlyPostActionAcceptancePreconditionDenialEntry",
    ]),
  }),
  orderInvalidNotes: "release post-action acceptance denial section must preserve canonical heading and binding sentence order.",
  sharedDocPathOverrideScenario: Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: "report_contract_doc_page_release_post_action_acceptance_denial_section_docs_missing",
    overrideContractId: 'report_freshness_regression',
  }),
});

const NEGATIVE_SCENARIOS = buildSentenceSectionRegressionScenarios(REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_REGRESSION_CONFIG);

export function releasePostActionAcceptanceDenialSectionHeadingFor(contractId = '') {
  return buildSentenceSectionHeading({
    headingPrefix: SECTION_HEADING_PREFIX,
    contractId,
  });
}

export function buildReportContractDocPageReleasePostActionAcceptanceDenialSectionMarkdownBlock(contract = {}) {
  return buildSentenceSectionMarkdownBlock({
    headingPrefix: SECTION_HEADING_PREFIX,
    sentenceBindings: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_SENTENCES,
    contract,
  });
}

export function buildReportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionInput({
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

export function buildReportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  return buildSentenceSectionRegressionReport(
    {
      ...REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_REGRESSION_CONFIG,
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

export function summarizeReportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionReport(report = {}) {
  return summarizeSentenceSectionRegressionReport(REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_ACCEPTANCE_DENIAL_SECTION_REGRESSION_CONFIG, report);
}
