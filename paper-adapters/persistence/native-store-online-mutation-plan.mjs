import {
  compileExternallyFencedSqliteMutationOperation,
  defineExternallyFencedSqliteMutationStatement,
  externallyFencedSqliteWriterPlanHash,
} from '../automation/externally-fenced-sqlite-mutation-plan.mjs';

export const NATIVE_STORE_DATABASE_ROLE = 'native-store';
export const NATIVE_STORE_DATABASE_INSTANCE_ID = 'native-store';
export const NATIVE_STORE_SCHEMA_CONTRACT_ID = 'native-store-schema-v23';
export const NATIVE_STORE_CAMPAIGN_TELEMETRY_WRITER_ID =
  'writer:native-store:campaign-telemetry-operations:v1';
export const NATIVE_STORE_CAMPAIGN_TELEMETRY_OPERATION_ID =
  'native-store.campaign-telemetry-operations.recordTelemetry.v1';
export const NATIVE_STORE_CAMPAIGN_TELEMETRY_INSERT_STATEMENT_ID =
  'native-store.campaign-telemetry.insert.v1';

const campaignTelemetryPlan = compileExternallyFencedSqliteMutationOperation(
  NATIVE_STORE_CAMPAIGN_TELEMETRY_OPERATION_ID,
  [
    defineExternallyFencedSqliteMutationStatement(
      NATIVE_STORE_CAMPAIGN_TELEMETRY_INSERT_STATEMENT_ID,
      `INSERT INTO campaign_telemetry_samples(
        campaign_id,node_id,sample_kind,phases_json,lock_wait_ms,
        queue_contention_count,requested_at,acquired_at,released_at,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ),
  ],
);

// This is intentionally a bounded first slice, not a native-store-wide writer.
// The remaining native-store writers stay fail-closed when used through the
// strict StorePort until each receives its own pinned statement plan.
export const NATIVE_STORE_CAMPAIGN_TELEMETRY_MUTATION_PLANS = Object.freeze({
  [NATIVE_STORE_CAMPAIGN_TELEMETRY_OPERATION_ID]: campaignTelemetryPlan,
});

export const NATIVE_STORE_CAMPAIGN_TELEMETRY_WRITER_PLAN_HASH =
  externallyFencedSqliteWriterPlanHash({
    writerId: NATIVE_STORE_CAMPAIGN_TELEMETRY_WRITER_ID,
    operationPlans: Object.values(NATIVE_STORE_CAMPAIGN_TELEMETRY_MUTATION_PLANS),
  });
