PRAGMA foreign_keys = ON;

-- New writers must identify which delivery protocol owns each row. The
-- fail-closed default deliberately rejects mixed-version writers after this
-- migration rather than silently assigning their rows to either live stack.
ALTER TABLE submission_outbox ADD COLUMN delivery_kind TEXT NOT NULL
  DEFAULT 'quarantined_legacy'
  CHECK (delivery_kind IN ('reviewed','autonomous','quarantined_legacy'));

-- Existing autonomous rows have a reserved message-id namespace and a
-- self-describing, row-bound envelope. Classify only rows that satisfy every
-- cheap deterministic binding available to SQL. Anything that claims the
-- autonomous namespace/envelope but is not fully recognizable is quarantined;
-- it is never exposed to the reviewed or autonomous dispatcher.
UPDATE submission_outbox
SET delivery_kind = CASE
  WHEN message_id GLOB 'autonomous-submission:*'
    AND CASE WHEN json_valid(payload_json) THEN
      json_extract(payload_json, '$.version') = 1
      AND json_extract(payload_json, '$.kind') = 'AutonomousSubmissionOutboxEnvelope'
      AND json_extract(payload_json, '$.request.paperId') = paper_id
      AND json_extract(payload_json, '$.request.requestHash') = dispatch_hash
      AND json_extract(payload_json, '$.request.portalConfigurationHash') = account_id
      AND json_extract(payload_json, '$.request.idempotencyKey') = nonce
      AND json_extract(payload_json, '$.portalId') = provider
      AND message_id = 'autonomous-submission:'
        || json_extract(payload_json, '$.request.idempotencyKey')
      AND json_extract(payload_json, '$.stateReceipt.messageId') = message_id
      AND json_extract(payload_json, '$.stateReceipt.portalId') = provider
      ELSE 0 END
    THEN 'autonomous'
  WHEN message_id GLOB 'autonomous-submission:*'
    OR CASE WHEN json_valid(payload_json) THEN
      json_extract(payload_json, '$.kind') = 'AutonomousSubmissionOutboxEnvelope'
      ELSE 0 END
    THEN 'quarantined_legacy'
  ELSE 'reviewed'
END;

-- A post-migration old binary omits delivery_kind and receives the quarantined
-- default. Reject that insert so the operator must upgrade the writer instead
-- of accumulating ambiguous live work.
CREATE TRIGGER submission_outbox_delivery_kind_insert_required
BEFORE INSERT ON submission_outbox
WHEN NEW.delivery_kind = 'quarantined_legacy'
BEGIN
  SELECT RAISE(ABORT, 'submission_outbox_delivery_kind_required');
END;

CREATE TRIGGER submission_outbox_autonomous_binding_required
BEFORE INSERT ON submission_outbox
WHEN NEW.delivery_kind = 'autonomous' AND COALESCE((
  NEW.message_id GLOB 'autonomous-submission:*'
  AND CASE WHEN json_valid(NEW.payload_json) THEN
    json_extract(NEW.payload_json, '$.version') = 1
    AND json_extract(NEW.payload_json, '$.kind') = 'AutonomousSubmissionOutboxEnvelope'
    AND json_extract(NEW.payload_json, '$.request.paperId') = NEW.paper_id
    AND json_extract(NEW.payload_json, '$.request.requestHash') = NEW.dispatch_hash
    AND json_extract(NEW.payload_json, '$.request.portalConfigurationHash') = NEW.account_id
    AND json_extract(NEW.payload_json, '$.request.idempotencyKey') = NEW.nonce
    AND json_extract(NEW.payload_json, '$.portalId') = NEW.provider
    AND NEW.message_id = 'autonomous-submission:'
      || json_extract(NEW.payload_json, '$.request.idempotencyKey')
    AND json_extract(NEW.payload_json, '$.stateReceipt.messageId') = NEW.message_id
    AND json_extract(NEW.payload_json, '$.stateReceipt.portalId') = NEW.provider
    ELSE 0 END
), 0) <> 1
BEGIN
  SELECT RAISE(ABORT, 'submission_outbox_autonomous_binding_invalid');
END;

CREATE TRIGGER submission_outbox_reviewed_namespace_required
BEFORE INSERT ON submission_outbox
WHEN NEW.delivery_kind = 'reviewed' AND (
  NEW.message_id NOT GLOB 'submission:*'
  OR CASE WHEN json_valid(NEW.payload_json) THEN
    json_extract(NEW.payload_json, '$.kind') = 'AutonomousSubmissionOutboxEnvelope'
    ELSE 0 END
)
BEGIN
  SELECT RAISE(ABORT, 'submission_outbox_reviewed_binding_invalid');
END;

-- Delivery ownership is immutable. Reclassification of quarantined historical
-- rows requires a separately reviewed offline migration, never an online DML
-- path shared with either dispatcher.
CREATE TRIGGER submission_outbox_delivery_kind_immutable
BEFORE UPDATE OF delivery_kind ON submission_outbox
WHEN NEW.delivery_kind <> OLD.delivery_kind
BEGIN
  SELECT RAISE(ABORT, 'submission_outbox_delivery_kind_immutable');
END;

DROP INDEX IF EXISTS idx_submission_outbox_status_time;
CREATE INDEX idx_submission_outbox_status_time
  ON submission_outbox(delivery_kind,status,next_attempt_at);
DROP INDEX IF EXISTS idx_submission_outbox_claimable;
CREATE INDEX idx_submission_outbox_claimable
  ON submission_outbox(
    delivery_kind,provider,account_id,status,next_attempt_at,lease_expires_at,created_at
  );
CREATE INDEX idx_submission_outbox_kind_paper_created
  ON submission_outbox(delivery_kind,paper_id,created_at,message_id);

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','24',datetime('now')),
  ('submission_outbox_delivery_kind','enabled',datetime('now')),
  ('submission_outbox_quarantined_legacy_count',
    (SELECT CAST(count(*) AS TEXT) FROM submission_outbox
      WHERE delivery_kind='quarantined_legacy'),datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
