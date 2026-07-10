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

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_REGRESSION_VERSION = 1;
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_REGRESSION_REPORT_FILE_ID = 'report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression-latest.json';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_REGRESSION_SCRIPT_ID = 'reports:contract-doc-page-release-post-action-queue-consumption-denial-section-regression';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_REGRESSION_STEP_ID = 'report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression_export';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_POST_ACTION_STATE_TRANSITION_DENIAL_ARTIFACT_SENTENCE = 'Release post-action state transition denial artifact post-action queue consumption entry: release post-action queue consumption denial sections must name reports/report-contract-doc-page-release-post-action-state-transition-denial-section-regression-latest.json and reports/report-contract-doc-page-release-post-action-state-transition-denial-section-regression-latest.md as upstream post-action state transition denial evidence, require the contractDocPageReleasePostActionStateTransitionDenialSectionRegressionHash sha256 plus zero blockers, name reports/post-action-dispatch-envelope-matrix-latest.json and reports/post-action-dispatch-envelope-matrix-latest.md as runtime post-action dispatch envelope evidence required before queue consumption review, require the postActionDispatchEnvelopeMatrixHash sha256 plus zero blockers, and state that post-action state transition denial evidence only permits local read-only post-action queue consumption review, not post-action queue consumption write, queue consumption append, queue consumption mutation, queue consumption replay, consume, dequeue, ack, acknowledgement, background runner action, runner dispatch, post-action local state transition write, local state transition append, local state transition mutation, local state transition replay, post-action provider/model spend write, provider/model spend append, provider/model spend mutation, provider/model spend replay, post-action deployment write, post-action deployment append, post-action deployment mutation, post-action deployment replay, post-action payment write, post-action payment append, post-action payment mutation, post-action payment replay, post-action acceptance write, post-action acceptance append, post-action acceptance mutation, post-action acceptance replay, post-action settlement write, post-action settlement append, post-action settlement mutation, post-action settlement replay, post-action reconciliation write, post-action reconciliation append, post-action reconciliation mutation, post-action reconciliation replay, post-action audit write, post-action audit append, post-action audit mutation, post-action audit replay, post-action receipt write, post-action receipt append, post-action receipt mutation, post-action receipt replay, receipt write, receipt append, receipt mutation, receipt replay, audit write, audit mutation, ledger mutation, ledger append, proof-bundle execution, live replay, browser/API write, click, POST, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, external action, replay execution, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_STRICT_GATE_SENTENCE = 'Strict gate post-action queue consumption denial entry: release post-action queue consumption denial sections must name reports/integration-dependency-gate-latest.json and reports/integration-dependency-gate-latest.md as strict gate evidence and require the final gateHash sha256 plus zero blockers before any post-action queue consumption review can be discussed, while stating that a passing gate cannot grant archive, delete, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, browser live action, runner dispatch, approval, write-adapter implementation, dry-run replay execution, ledger mutation, audit write, receipt write, post-action receipt write, post-action receipt mutation, post-action audit write, post-action audit mutation, post-action reconciliation write, post-action reconciliation mutation, post-action settlement write, post-action settlement mutation, post-action acceptance write, post-action acceptance mutation, post-action payment write, post-action payment mutation, post-action deployment write, post-action deployment mutation, post-action provider/model spend write, post-action provider/model spend mutation, post-action local state transition write, post-action local state transition mutation, post-action queue consumption write, post-action queue consumption mutation, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_FRESHNESS_SENTENCE = 'Freshness post-action queue consumption denial entry: release post-action queue consumption denial sections must name reports/report-freshness-latest.json and reports/report-freshness-latest.md as freshness evidence and require reportCount=okReportCount, comparableGateReportCount=gateHashMatchCount, gateHashMismatchCount=0, and the final freshnessHash to be bound before post-action queue consumption denial can remain reviewable.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_CHECKPOINT_SENTENCE = 'Checkpoint post-action queue consumption denial entry: release post-action queue consumption denial sections must name reports/architecture-checkpoint-latest.json and reports/architecture-checkpoint-latest.md as checkpoint evidence and require checkpointHash plus final reportFreshnessHash, postActionRuntimeStatusRequiredSummaryMetrics=64, postActionRuntimeStatusRequiredSummaryMetricOk=64, postActionRuntimeStatusRequiredSummaryMetricsOk=true, reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionHash, and reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionHash bindings to be recorded as post-action-queue-consumption-denial evidence, not as proof-bundle execution, live replay, dispatch, platform write, local state transition, queue consumption, write-adapter enablement, ledger mutation, ledger append, audit write, receipt write, post-action receipt write, post-action receipt mutation, post-action audit write, post-action audit mutation, post-action reconciliation write, post-action reconciliation mutation, post-action settlement write, post-action settlement mutation, post-action acceptance write, post-action acceptance mutation, post-action payment write, post-action payment mutation, post-action deployment write, post-action deployment mutation, post-action provider/model spend write, post-action provider/model spend mutation, post-action local state transition write, post-action local state transition mutation, post-action queue consumption write, post-action queue consumption mutation, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_RETENTION_SENTENCE = 'Retention post-action queue consumption denial entry: release post-action queue consumption denial sections must name reports/report-retention-latest.json plus npm run reports:prune:dry-run and require dryRun=true with archivedCount=0 to be recorded as retention evidence only, never as archive, delete, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, runner dispatch, live replay, dry-run replay execution, ledger mutation, audit write, receipt write, post-action receipt write, post-action receipt mutation, post-action audit write, post-action audit mutation, post-action reconciliation write, post-action reconciliation mutation, post-action settlement write, post-action settlement mutation, post-action acceptance write, post-action acceptance mutation, post-action payment write, post-action payment mutation, post-action deployment write, post-action deployment mutation, post-action provider/model spend write, post-action provider/model spend mutation, post-action local state transition write, post-action local state transition mutation, post-action queue consumption write, post-action queue consumption mutation, write-adapter implementation, approval, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_SEED_CLEAN_SENTENCE = 'Seed-clean probe post-action queue consumption denial entry: release post-action queue consumption denial sections must name npm run reports:bootstrap-seeds -- --strict and require seededFileCount=0, skippedFileCount=5, activeBootstrapSeedReports=0, zero real placeholder tokens, and git diff --check -- . to be recorded as closeout proof only, not local state transition, queue consumption, provider/model spend, runner dispatch, browser live action, dry-run replay execution, ledger mutation, audit write, receipt write, post-action receipt write, post-action receipt mutation, post-action audit write, post-action audit mutation, post-action reconciliation write, post-action reconciliation mutation, post-action settlement write, post-action settlement mutation, post-action acceptance write, post-action acceptance mutation, post-action payment write, post-action payment mutation, post-action deployment write, post-action deployment mutation, post-action provider/model spend write, post-action provider/model spend mutation, post-action local state transition write, post-action local state transition mutation, post-action queue consumption write, post-action queue consumption mutation, write-adapter implementation, approval, or execution permission.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_PRECONDITION_DENIAL_SENTENCE = 'Read-only post-action queue consumption precondition-denial entry: release post-action queue consumption denial sections must require any future post-action queue consumption review record to bind current chat id, requester identity, approval evidence id, intent evidence id, exact target, exact action, channel, task URL, account identity, seller identity, read-only platform-state snapshot id, snapshot capture method, snapshot timestamp, platform-state hash, DOM hash or API response hash when applicable, dry-run replay id, replay fixture path, replay input hash, expected mutation plan, proof bundle id, proof bundle path, proof bundle manifest hash, proof bundle artifact list hash, ledger id, ledger path, ledger schema path, ledger row id, ledger row hash, ledger append dry-run id, audit evidence id, audit evidence path, audit schema path, audit row id, audit row hash, audit append dry-run id, receipt evidence id, receipt evidence path, receipt schema path, receipt evidence hash, receipt append dry-run id, post-action receipt id, post-action receipt path, post-action receipt schema path, post-action receipt hash, post-action receipt append dry-run id, post-action audit id, post-action audit path, post-action audit schema path, post-action audit hash, post-action audit append dry-run id, post-action reconciliation id, post-action reconciliation path, post-action reconciliation schema path, post-action reconciliation hash, post-action reconciliation append dry-run id, post-action settlement id, post-action settlement path, post-action settlement schema path, post-action settlement hash, post-action settlement append dry-run id, post-action acceptance id, post-action acceptance path, post-action acceptance schema path, post-action acceptance hash, post-action acceptance append dry-run id, post-action payment id, post-action payment path, post-action payment schema path, post-action payment hash, post-action payment append dry-run id, post-action deployment id, post-action deployment path, post-action deployment schema path, post-action deployment hash, post-action deployment append dry-run id, post-action provider spend id, post-action provider spend path, post-action provider spend schema path, post-action provider spend hash, post-action provider spend append dry-run id, post-action state transition id, post-action state transition path, post-action state transition schema path, post-action state transition hash, post-action state transition append dry-run id, post-action queue consumption id, post-action queue consumption path, post-action queue consumption schema path, post-action queue consumption hash, post-action queue consumption append dry-run id, queue id, queue record id, queue record hash, queue consumer identity, queue snapshot id, queue snapshot hash, queue snapshot capture method, no-write adapter id, session target id, drift expiry, executor identity, and explicit no-live/no-write/no-ledger-mutation/no-audit-write/no-receipt-write/no-post-action-receipt-write/no-post-action-audit-write/no-post-action-reconciliation-write/no-post-action-settlement-write/no-post-action-acceptance-write/no-post-action-payment-write/no-post-action-deployment-write/no-post-action-provider-spend-write/no-post-action-state-transition-write/no-post-action-queue-consumption-write wording while rejecting standing authorization, inherited approval, broad batch approval, stale snapshot, stale replay, stale proof bundle, stale ledger, stale audit evidence, stale receipt evidence, stale post-action receipt, stale post-action audit, stale post-action reconciliation, stale post-action settlement, stale post-action acceptance, stale post-action payment, stale post-action deployment, stale post-action provider spend, stale post-action state transition, stale post-action queue consumption, and any post-action queue consumption record missing exact scope.';
export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_LIVE_WRITE_DENIAL_SENTENCE = 'Post-action queue consumption/live write denial entry: release post-action queue consumption denial sections must state that post-action queue consumption evidence is evidence only; no post-action queue consumption write, queue consumption append, queue consumption mutation, queue consumption replay, queue consumption consume, queue consumption dequeue, queue consumption ack, queue consumption acknowledgement, queue consumption commit, queue consumer dispatch, background runner action, runner dispatch, post-action local state transition write, local state transition append, local state transition mutation, local state transition replay, local state transition apply, state transition commit, post-action provider/model spend write, provider/model spend append, provider/model spend mutation, provider/model spend replay, post-action deployment write, post-action deployment append, post-action deployment mutation, post-action deployment replay, post-action payment write, post-action payment append, post-action payment mutation, post-action payment replay, post-action acceptance write, post-action acceptance append, post-action acceptance mutation, post-action acceptance replay, post-action settlement write, post-action settlement append, post-action settlement mutation, post-action settlement replay, post-action reconciliation write, post-action reconciliation append, post-action reconciliation mutation, post-action reconciliation replay, post-action audit write, post-action audit append, post-action audit mutation, post-action audit replay, post-action receipt write, post-action receipt append, post-action receipt mutation, post-action receipt replay, receipt write, receipt append, receipt mutation, receipt replay, audit write, audit append, audit mutation, audit replay, ledger mutation, ledger append, ledger replay, live replay, click, POST, browser session, API write, upload, submit, IM, acceptance, payment, deployment, provider/model spend, local state transition, queue consumption, external action, snapshot replay, mutation replay, proof-bundle execution, proof-bundle replay, ledger execution, audit execution, receipt execution, post-action receipt execution, post-action audit execution, post-action reconciliation execution, post-action settlement execution, post-action acceptance execution, post-action payment execution, post-action deployment execution, post-action provider/model spend execution, post-action local state transition execution, or post-action queue consumption execution may be implemented, enabled, called, acknowledged, dispatched, or consumed from this guard; any future queue consumption implementation still requires a separate implementation gate, exact platform-state, dry-run replay, proof bundle, ledger, audit evidence, receipt evidence, post-action receipt evidence, post-action audit evidence, post-action reconciliation evidence, post-action settlement evidence, post-action acceptance evidence, post-action payment evidence, post-action deployment evidence, post-action provider/model spend evidence, post-action local state transition evidence, post-action queue consumption evidence, and a fresh current-chat approval before live execution can even be considered.';

export const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_SENTENCES = Object.freeze([
  Object.freeze({
    key: 'releasePostActionStateTransitionDenialArtifactPostActionQueueConsumptionEntry',
    label: 'release post-action state transition denial artifact post-action queue consumption entry',
    blockerCode: 'report_contract_doc_page_release_post_action_queue_consumption_denial_section_release_post_action_state_transition_denial_artifact_post_action_queue_consumption_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_POST_ACTION_STATE_TRANSITION_DENIAL_ARTIFACT_SENTENCE,
  }),
  Object.freeze({
    key: 'strictGatePostActionQueueConsumptionDenialEntry',
    label: 'strict gate post-action queue consumption denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_queue_consumption_denial_section_strict_gate_post_action_queue_consumption_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_STRICT_GATE_SENTENCE,
  }),
  Object.freeze({
    key: 'freshnessPostActionQueueConsumptionDenialEntry',
    label: 'freshness post-action queue consumption denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_queue_consumption_denial_section_freshness_post_action_queue_consumption_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_FRESHNESS_SENTENCE,
  }),
  Object.freeze({
    key: 'checkpointPostActionQueueConsumptionDenialEntry',
    label: 'checkpoint post-action queue consumption denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_queue_consumption_denial_section_checkpoint_post_action_queue_consumption_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_CHECKPOINT_SENTENCE,
  }),
  Object.freeze({
    key: 'retentionPostActionQueueConsumptionDenialEntry',
    label: 'retention post-action queue consumption denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_queue_consumption_denial_section_retention_post_action_queue_consumption_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_RETENTION_SENTENCE,
  }),
  Object.freeze({
    key: 'seedCleanProbePostActionQueueConsumptionDenialEntry',
    label: 'seed-clean probe post-action queue consumption denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_queue_consumption_denial_section_seed_clean_post_action_queue_consumption_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_SEED_CLEAN_SENTENCE,
  }),
  Object.freeze({
    key: 'readOnlyPostActionQueueConsumptionPreconditionDenialEntry',
    label: 'read-only post-action queue consumption precondition-denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_queue_consumption_denial_section_read_only_post_action_queue_consumption_precondition_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_PRECONDITION_DENIAL_SENTENCE,
  }),
  Object.freeze({
    key: 'postActionQueueConsumptionLiveWriteDenialEntry',
    label: 'post-action queue consumption/live write denial entry',
    blockerCode: 'report_contract_doc_page_release_post_action_queue_consumption_denial_section_post_action_queue_consumption_live_write_denial_missing',
    sentence: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_LIVE_WRITE_DENIAL_SENTENCE,
  }),
]);

const TARGET_CONTRACT_ID = 'report_contract_manifest';
const SECTION_HEADING_PREFIX = "## Contract Page Release Post-Action Queue Consumption Denial Section: ";

const REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_REGRESSION_CONFIG = Object.freeze({
  version: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_REGRESSION_VERSION,
  kind: "ReportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegression",
  reportFileId: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_REGRESSION_REPORT_FILE_ID,
  scriptId: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_REGRESSION_SCRIPT_ID,
  headingPrefix: SECTION_HEADING_PREFIX,
  targetContractId: TARGET_CONTRACT_ID,
  sectionKindLabel: "release post-action queue consumption denial section",
  statusSlug: "report_contract_doc_page_release_post_action_queue_consumption_denial_section",
  hashField: "contractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionHash",
  sentenceBindings: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_SENTENCES,
  actualBlockerSource: "actual_doc_page_release_post_action_queue_consumption_denial_sections",
  extraSafetyFlags: Object.freeze({
    appliesLocalQueueConsumption: false,
  }),
  missingSectionScenario: Object.freeze({
    scenarioId: "new_manifest_contract_without_release_post_action_queue_consumption_denial_section",
    label: "A new manifest contract is added with docs but without a release post-action queue consumption denial section",
    expectedBlockerCode: "report_contract_doc_page_release_post_action_queue_consumption_denial_section_missing",
    futureContract: Object.freeze({
      contractId: "report_future_doc_page_release_post_action_queue_consumption_denial_section",
      label: "Report future doc page release post-action queue consumption denial section",
      scriptId: "reports:future-doc-page-release-post-action-queue-consumption-denial-section",
      fileId: "report-future-doc-page-release-post-action-queue-consumption-denial-section-latest.json",
    }),
    docsText: "# Report Future Doc Page Release Post-Action Queue Consumption Denial Section\\n",
  }),
  orderScenario: Object.freeze({
    scenarioId: "release_post_action_queue_consumption_denial_section_order_drift",
    label: "A contract release post-action queue consumption denial section moves live write denial before the first evidence binding",
    expectedBlockerCode: "report_contract_doc_page_release_post_action_queue_consumption_denial_section_order_invalid",
    reorderedBindingKeys: Object.freeze([
      "postActionQueueConsumptionLiveWriteDenialEntry",
      "releasePostActionStateTransitionDenialArtifactPostActionQueueConsumptionEntry",
      "strictGatePostActionQueueConsumptionDenialEntry",
      "freshnessPostActionQueueConsumptionDenialEntry",
      "checkpointPostActionQueueConsumptionDenialEntry",
      "retentionPostActionQueueConsumptionDenialEntry",
      "seedCleanProbePostActionQueueConsumptionDenialEntry",
      "readOnlyPostActionQueueConsumptionPreconditionDenialEntry",
    ]),
  }),
  orderInvalidNotes: "release post-action queue consumption denial section must preserve canonical heading and binding sentence order.",
  sharedDocPathOverrideScenario: Object.freeze({
    scenarioId: 'shared_doc_path_override_missing',
    label: 'A shared docs page loses its explicit manifest-to-doc mapping',
    expectedBlockerCode: "report_contract_doc_page_release_post_action_queue_consumption_denial_section_docs_missing",
    overrideContractId: 'report_freshness_regression',
  }),
});

const NEGATIVE_SCENARIOS = buildSentenceSectionRegressionScenarios(REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_REGRESSION_CONFIG);

export function releasePostActionQueueConsumptionDenialSectionHeadingFor(contractId = '') {
  return buildSentenceSectionHeading({
    headingPrefix: SECTION_HEADING_PREFIX,
    contractId,
  });
}

export function buildReportContractDocPageReleasePostActionQueueConsumptionDenialSectionMarkdownBlock(contract = {}) {
  return buildSentenceSectionMarkdownBlock({
    headingPrefix: SECTION_HEADING_PREFIX,
    sentenceBindings: REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_SENTENCES,
    contract,
  });
}

export function buildReportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionInput({
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

export function buildReportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionReport({
  manifest = REPORT_CONTRACT_MANIFEST,
  docsByPath = {},
  docPathOverrides = REPORT_CONTRACT_DOC_COVERAGE_OVERRIDES,
  generatedAt = new Date().toISOString(),
} = {}) {
  return buildSentenceSectionRegressionReport(
    {
      ...REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_REGRESSION_CONFIG,
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

export function summarizeReportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionReport(report = {}) {
  return summarizeSentenceSectionRegressionReport(REPORT_CONTRACT_DOC_PAGE_RELEASE_POST_ACTION_QUEUE_CONSUMPTION_DENIAL_SECTION_REGRESSION_CONFIG, report);
}
