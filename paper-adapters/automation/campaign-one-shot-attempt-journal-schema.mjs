import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_VERSION = 1;
export const CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_ID =
  'campaign-one-shot-attempt-journal-v1';

export const CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE campaign_one_shot_attempt_journal_metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    schema_version INTEGER NOT NULL CHECK(schema_version=1),
    schema_contract_id TEXT NOT NULL,
    schema_contract_hash TEXT NOT NULL,
    sqlite_schema_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;`,
  `CREATE TABLE campaign_one_shot_attempts (
    attempt_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    campaign_id TEXT NOT NULL UNIQUE,
    protected_campaign_id TEXT NOT NULL,
    execution_binding_hash TEXT NOT NULL,
    reservation_hash TEXT NOT NULL UNIQUE,
    reservation_json TEXT NOT NULL CHECK(json_valid(reservation_json)),
    reserved_at TEXT NOT NULL,
    CHECK(json_extract(reservation_json,'$.attemptId')=attempt_id),
    CHECK(json_extract(reservation_json,'$.idempotencyKey')=idempotency_key),
    CHECK(json_extract(reservation_json,'$.campaignId')=campaign_id),
    CHECK(json_extract(reservation_json,'$.protectedCampaignId')=protected_campaign_id),
    CHECK(json_extract(reservation_json,'$.executionBindingHash')=execution_binding_hash),
    CHECK(json_extract(reservation_json,'$.autonomousResearchOneShotCampaignAttemptReservationHash')=reservation_hash)
  ) STRICT;`,
  `CREATE TABLE campaign_one_shot_attempt_events (
    event_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence>=1 AND sequence<=7),
    phase TEXT NOT NULL CHECK(phase IN (
      'attempt_reserved','preconditions_verified','prepare_verified',
      'provider_started','provider_completed','launch_started','terminal'
    )),
    previous_event_hash TEXT,
    event_hash TEXT NOT NULL UNIQUE,
    event_json TEXT NOT NULL CHECK(json_valid(event_json)),
    recorded_at TEXT NOT NULL,
    UNIQUE(attempt_id,sequence),
    UNIQUE(attempt_id,phase),
    FOREIGN KEY(attempt_id) REFERENCES campaign_one_shot_attempts(attempt_id),
    CHECK(json_extract(event_json,'$.eventId')=event_id),
    CHECK(json_extract(event_json,'$.attemptId')=attempt_id),
    CHECK(json_extract(event_json,'$.sequence')=sequence),
    CHECK(json_extract(event_json,'$.phase')=phase),
    CHECK(coalesce(json_extract(event_json,'$.previousEventHash'),'')=coalesce(previous_event_hash,'')),
    CHECK(json_extract(event_json,'$.autonomousResearchOneShotCampaignAttemptEventHash')=event_hash)
  ) STRICT;`,
  `CREATE INDEX idx_campaign_one_shot_attempt_events_order
    ON campaign_one_shot_attempt_events(attempt_id,sequence);`,
  `CREATE TABLE campaign_one_shot_attempt_terminal_receipts (
    attempt_id TEXT PRIMARY KEY,
    receipt_hash TEXT NOT NULL UNIQUE,
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
    terminal_event_hash TEXT NOT NULL UNIQUE,
    completed_at TEXT NOT NULL,
    FOREIGN KEY(attempt_id) REFERENCES campaign_one_shot_attempts(attempt_id),
    CHECK(json_extract(receipt_json,'$.attemptId')=attempt_id),
    CHECK(json_extract(receipt_json,'$.autonomousResearchOneShotCampaignAttemptTerminalReceiptHash')=receipt_hash)
  ) STRICT;`,
  `CREATE TRIGGER campaign_one_shot_attempt_metadata_no_update
    BEFORE UPDATE ON campaign_one_shot_attempt_journal_metadata
    BEGIN SELECT RAISE(ABORT,'campaign_one_shot_attempt_journal_immutable'); END;`,
  `CREATE TRIGGER campaign_one_shot_attempt_metadata_no_delete
    BEFORE DELETE ON campaign_one_shot_attempt_journal_metadata
    BEGIN SELECT RAISE(ABORT,'campaign_one_shot_attempt_journal_immutable'); END;`,
  `CREATE TRIGGER campaign_one_shot_attempt_metadata_no_replace
    BEFORE INSERT ON campaign_one_shot_attempt_journal_metadata
    WHEN EXISTS(SELECT 1 FROM campaign_one_shot_attempt_journal_metadata
      WHERE singleton=NEW.singleton)
    BEGIN SELECT RAISE(ABORT,'campaign_one_shot_attempt_journal_immutable'); END;`,
  `CREATE TRIGGER campaign_one_shot_attempts_no_update
    BEFORE UPDATE ON campaign_one_shot_attempts
    BEGIN SELECT RAISE(ABORT,'campaign_one_shot_attempt_journal_immutable'); END;`,
  `CREATE TRIGGER campaign_one_shot_attempts_no_delete
    BEFORE DELETE ON campaign_one_shot_attempts
    BEGIN SELECT RAISE(ABORT,'campaign_one_shot_attempt_journal_immutable'); END;`,
  `CREATE TRIGGER campaign_one_shot_attempts_no_replace
    BEFORE INSERT ON campaign_one_shot_attempts
    WHEN EXISTS(SELECT 1 FROM campaign_one_shot_attempts
      WHERE attempt_id=NEW.attempt_id OR idempotency_key=NEW.idempotency_key
        OR campaign_id=NEW.campaign_id OR reservation_hash=NEW.reservation_hash)
    BEGIN SELECT RAISE(ABORT,'campaign_one_shot_attempt_journal_immutable'); END;`,
  `CREATE TRIGGER campaign_one_shot_attempt_events_no_update
    BEFORE UPDATE ON campaign_one_shot_attempt_events
    BEGIN SELECT RAISE(ABORT,'campaign_one_shot_attempt_journal_immutable'); END;`,
  `CREATE TRIGGER campaign_one_shot_attempt_events_no_delete
    BEFORE DELETE ON campaign_one_shot_attempt_events
    BEGIN SELECT RAISE(ABORT,'campaign_one_shot_attempt_journal_immutable'); END;`,
  `CREATE TRIGGER campaign_one_shot_attempt_events_no_replace
    BEFORE INSERT ON campaign_one_shot_attempt_events
    WHEN EXISTS(SELECT 1 FROM campaign_one_shot_attempt_events
      WHERE event_id=NEW.event_id OR event_hash=NEW.event_hash
        OR (attempt_id=NEW.attempt_id AND sequence=NEW.sequence)
        OR (attempt_id=NEW.attempt_id AND phase=NEW.phase))
    BEGIN SELECT RAISE(ABORT,'campaign_one_shot_attempt_journal_immutable'); END;`,
  `CREATE TRIGGER campaign_one_shot_attempt_terminal_no_update
    BEFORE UPDATE ON campaign_one_shot_attempt_terminal_receipts
    BEGIN SELECT RAISE(ABORT,'campaign_one_shot_attempt_journal_immutable'); END;`,
  `CREATE TRIGGER campaign_one_shot_attempt_terminal_no_delete
    BEFORE DELETE ON campaign_one_shot_attempt_terminal_receipts
    BEGIN SELECT RAISE(ABORT,'campaign_one_shot_attempt_journal_immutable'); END;`,
  `CREATE TRIGGER campaign_one_shot_attempt_terminal_no_replace
    BEFORE INSERT ON campaign_one_shot_attempt_terminal_receipts
    WHEN EXISTS(SELECT 1 FROM campaign_one_shot_attempt_terminal_receipts
      WHERE attempt_id=NEW.attempt_id OR receipt_hash=NEW.receipt_hash
        OR terminal_event_hash=NEW.terminal_event_hash)
    BEGIN SELECT RAISE(ABORT,'campaign_one_shot_attempt_journal_immutable'); END;`,
]);

export const CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_HASH = hashRecord(
  'CampaignOneShotAttemptJournalSchemaContract',
  {
    version: CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_VERSION,
    contractId: CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_CONTRACT_ID,
    statements: CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_SCHEMA_STATEMENTS,
  },
);

export const CAMPAIGN_ONE_SHOT_ATTEMPT_JOURNAL_EXPECTED_SCHEMA_OBJECTS = Object.freeze([
  'index:idx_campaign_one_shot_attempt_events_order',
  'table:campaign_one_shot_attempt_events',
  'table:campaign_one_shot_attempt_journal_metadata',
  'table:campaign_one_shot_attempt_terminal_receipts',
  'table:campaign_one_shot_attempts',
  'trigger:campaign_one_shot_attempt_events_no_delete',
  'trigger:campaign_one_shot_attempt_events_no_replace',
  'trigger:campaign_one_shot_attempt_events_no_update',
  'trigger:campaign_one_shot_attempt_metadata_no_delete',
  'trigger:campaign_one_shot_attempt_metadata_no_replace',
  'trigger:campaign_one_shot_attempt_metadata_no_update',
  'trigger:campaign_one_shot_attempt_terminal_no_delete',
  'trigger:campaign_one_shot_attempt_terminal_no_replace',
  'trigger:campaign_one_shot_attempt_terminal_no_update',
  'trigger:campaign_one_shot_attempts_no_delete',
  'trigger:campaign_one_shot_attempts_no_replace',
  'trigger:campaign_one_shot_attempts_no_update',
].sort());
