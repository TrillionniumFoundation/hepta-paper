import {
  compileExternallyFencedSqliteMutationOperation as operation,
  externallyFencedSqliteWriterPlanHash,
} from '../automation/externally-fenced-sqlite-mutation-plan.mjs';

export const NATIVE_STORE_QUALITY_RELEASE_WRITER_ID =
  'writer:native-store:quality-release:v1';

export const NATIVE_STORE_QUALITY_RELEASE_OPERATION_IDS = Object.freeze({
  promoteCompletedRelease:
    'native-store.campaign-release-authority-repository.promoteCompletedRelease.v1',
  recordTheoremQualityRevision:
    'native-store.theorem-quality-revision-sink.record.v1',
});

export const NATIVE_STORE_QUALITY_RELEASE_STATEMENT_IDS = Object.freeze({
  insertCurrentCampaignRelease:
    'native-store.campaign-release.insert-current.v1',
  upsertTheoremQualityRevision:
    'native-store.theorem-quality-revision.upsert.v1',
});

const O = NATIVE_STORE_QUALITY_RELEASE_OPERATION_IDS;
const S = NATIVE_STORE_QUALITY_RELEASE_STATEMENT_IDS;

function run(statementId, sql) {
  return Object.freeze({ statementId, mode: 'run', sql });
}

const plans = [
  operation(O.recordTheoremQualityRevision, [
    run(S.upsertTheoremQualityRevision, `INSERT INTO referee_revision_requests(
      slug,request_key,status,risk_class,objection,source_locator,
      evidence_locator,proposed_fix,evidence_needed,verification,patch_scope,
      assignee,state_reason,last_transition_at,metadata_json
    ) VALUES(?,?,'requested','theorem_readiness',?,?,?,?,'source-bound proof/evidence',
      'rerun theorem manuscript readiness policy','manuscript_and_proof_evidence',
      'campaign-reviser','materialized_by_theorem_quality_gate',?,?)
    ON CONFLICT(slug,request_key) DO UPDATE SET
      status='requested',objection=excluded.objection,
      evidence_locator=excluded.evidence_locator,
      proposed_fix=excluded.proposed_fix,state_reason=excluded.state_reason,
      last_transition_at=excluded.last_transition_at,
      metadata_json=excluded.metadata_json,updated_at=?`),
  ]),
  operation(O.promoteCompletedRelease, [
    run(S.insertCurrentCampaignRelease, `INSERT OR IGNORE INTO campaign_current_releases(
      campaign_id,paper_id,campaign_plan_hash,package_node_id,package_attempt_id,
      lease_generation,package_result_hash,integration_descriptor_hash,
      integration_receipt_hash,campaign_release_bundle_hash,
      materialization_receipt_hash,release_bundle_json,promotion_receipt_json,
      promotion_receipt_hash,package_node_status,campaign_status,
      package_completed_at,promoted_at,status
    ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'completed','completed',?,?,'current_completed_release'
    WHERE EXISTS(SELECT 1
      FROM campaign_nodes n JOIN paper_campaigns c ON c.campaign_id=n.campaign_id
      WHERE n.node_id=? AND n.campaign_id=? AND n.kind='package'
        AND n.status='completed' AND n.attempt_id=? AND n.lease_generation=?
        AND n.result_sha256=? AND n.prepared_integration_status='integrated'
        AND n.prepared_integration_key=?
        AND n.prepared_integration_receipt_sha256=?
        AND c.status='completed' AND c.paper_id=?
        AND json_extract(c.spec_json,'$.campaignPlanHash')=?)`),
  ]),
];

export const NATIVE_STORE_QUALITY_RELEASE_MUTATION_PLANS = Object.freeze(
  Object.fromEntries(plans.map((plan) => [plan.operationId, plan])),
);

export const NATIVE_STORE_QUALITY_RELEASE_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: NATIVE_STORE_QUALITY_RELEASE_WRITER_ID,
    operationPlans: Object.values(NATIVE_STORE_QUALITY_RELEASE_MUTATION_PLANS),
  });
