export const REQUIRED_SCOPED_SCHEMA_MIGRATIONS = Object.freeze([
  Object.freeze({ version: 21, name: '021_job_lease_fencing' }),
  Object.freeze({ version: 22, name: '022_campaign_attempt_fencing' }),
  Object.freeze({ version: 23, name: '023_workspace_retention_qualification' }),
  Object.freeze({ version: 24, name: '024_submission_outbox_delivery_kind' }),
  Object.freeze({ version: 25, name: '025_external_autonomous_submission_handoff' }),
]);

export const REQUIRED_SCOPED_SCHEMA_VERSIONS = Object.freeze(
  REQUIRED_SCOPED_SCHEMA_MIGRATIONS.map((migration) => migration.version),
);
