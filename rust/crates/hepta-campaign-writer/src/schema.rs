pub(crate) const APPLICATION_ID: i64 = 1_213_224_753;
pub(crate) const USER_VERSION: i64 = 25;

pub(crate) const SCHEMA_SQL: &str = r#"
PRAGMA application_id = 1213224753;
PRAGMA user_version = 25;

CREATE TABLE writer_authority (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation INTEGER NOT NULL CHECK (generation > 0),
    token TEXT NOT NULL,
    acquired_at_unix_ms INTEGER NOT NULL CHECK (acquired_at_unix_ms > 0)
) STRICT;

CREATE TABLE campaigns (
    campaign_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    budget_remaining_microusd INTEGER NOT NULL CHECK (budget_remaining_microusd >= 0),
    cpu_jobs_remaining INTEGER NOT NULL CHECK (cpu_jobs_remaining >= 0),
    created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms > 0),
    updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms > 0)
) STRICT;

CREATE TABLE nodes (
    campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
    node_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'ready', 'claimed', 'prepared', 'completed', 'failed_pre_provider', 'ambiguous'
    )),
    lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
    attempt_id TEXT,
    claim_owner TEXT,
    claim_deadline_unix_ms INTEGER,
    reserved_microusd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_microusd >= 0),
    reserved_cpu_jobs INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cpu_jobs >= 0),
    provider_action_may_have_started INTEGER NOT NULL DEFAULT 0 CHECK (
        provider_action_may_have_started IN (0, 1)
    ),
    prepared_receipt_hash TEXT,
    integrated_result_hash TEXT,
    updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms > 0),
    PRIMARY KEY (campaign_id, node_id),
    CHECK ((state = 'ready' AND attempt_id IS NULL AND claim_owner IS NULL AND claim_deadline_unix_ms IS NULL)
        OR state <> 'ready'),
    CHECK ((state IN ('prepared', 'completed') AND prepared_receipt_hash IS NOT NULL)
        OR state NOT IN ('prepared', 'completed')),
    CHECK ((state = 'completed' AND integrated_result_hash IS NOT NULL)
        OR state <> 'completed')
) STRICT;

CREATE TABLE campaign_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
    campaign_revision INTEGER NOT NULL CHECK (campaign_revision >= 0),
    event_kind TEXT NOT NULL,
    subject_id TEXT,
    recorded_at_unix_ms INTEGER NOT NULL CHECK (recorded_at_unix_ms > 0),
    payload_json BLOB NOT NULL,
    previous_event_hash TEXT,
    event_hash TEXT NOT NULL UNIQUE
) STRICT;

CREATE INDEX campaign_events_campaign_sequence
ON campaign_events(campaign_id, sequence);

CREATE INDEX nodes_state_deadline
ON nodes(state, claim_deadline_unix_ms);
"#;
