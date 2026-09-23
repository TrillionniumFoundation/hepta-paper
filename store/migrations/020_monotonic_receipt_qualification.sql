PRAGMA foreign_keys = ON;

-- A receipt may be qualified once.  Supersession remains composable because
-- the replacement may itself be superseded, but a terminal decision on the
-- source can never be overwritten by a later row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipt_ledger_qualification_source
  ON receipt_ledger_qualifications(receipt_id);

CREATE TRIGGER IF NOT EXISTS receipt_qualification_validate_insert
BEFORE INSERT ON receipt_ledger_qualifications
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM receipt_ledger_qualifications prior
      WHERE prior.receipt_id = NEW.receipt_id
    ) THEN RAISE(ABORT, 'receipt_qualification_is_monotonic')
  END;
  SELECT CASE
    WHEN NEW.disposition = 'superseded' AND NEW.replacement_receipt_id IS NULL
      THEN RAISE(ABORT, 'receipt_supersession_replacement_required')
    WHEN NEW.disposition <> 'superseded' AND NEW.replacement_receipt_id IS NOT NULL
      THEN RAISE(ABORT, 'terminal_receipt_qualification_forbids_replacement')
    WHEN NEW.replacement_receipt_id = NEW.receipt_id
      THEN RAISE(ABORT, 'receipt_supersession_self_cycle')
  END;
  SELECT CASE
    WHEN NEW.disposition = 'superseded' AND EXISTS (
      SELECT 1
      FROM receipt_ledger source
      JOIN receipt_ledger replacement ON replacement.receipt_id = NEW.replacement_receipt_id
      WHERE source.receipt_id = NEW.receipt_id
        AND (
          source.kind <> replacement.kind
          OR source.stream <> replacement.stream
          OR source.writer_id <> replacement.writer_id
          OR source.writer_kind <> replacement.writer_kind
          OR source.writer_trusted <> replacement.writer_trusted
          OR coalesce(source.issuer_policy_id, '') <> coalesce(replacement.issuer_policy_id, '')
          OR coalesce(source.issuer_policy_hash, '') <> coalesce(replacement.issuer_policy_hash, '')
        )
    ) THEN RAISE(ABORT, 'receipt_supersession_identity_mismatch')
  END;
  SELECT CASE
    WHEN NEW.disposition = 'superseded' AND EXISTS (
      WITH RECURSIVE lineage(receipt_id) AS (
        SELECT NEW.replacement_receipt_id
        UNION
        SELECT q.replacement_receipt_id
        FROM receipt_ledger_qualifications q
        JOIN lineage l ON q.receipt_id = l.receipt_id
        WHERE q.disposition = 'superseded'
          AND q.replacement_receipt_id IS NOT NULL
      )
      SELECT 1 FROM lineage WHERE receipt_id = NEW.receipt_id
    ) THEN RAISE(ABORT, 'receipt_supersession_cycle')
  END;
END;

DROP VIEW IF EXISTS effective_receipt_ledger;
CREATE VIEW effective_receipt_ledger AS
SELECT
  receipt.*,
  qualification.qualification_id AS effective_qualification_id,
  qualification.disposition AS effective_disposition,
  qualification.reason AS effective_qualification_reason,
  qualification.replacement_receipt_id AS effective_replacement_receipt_id,
  qualification.qualification_sha256 AS effective_qualification_sha256,
  qualification.created_at AS effective_qualification_created_at,
  CASE WHEN qualification.sequence IS NULL THEN 1 ELSE 0 END AS effective_receipt_usable
FROM receipt_ledger AS receipt
LEFT JOIN receipt_ledger_qualifications AS qualification
  ON qualification.receipt_id = receipt.receipt_id;

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','20',datetime('now')),
  ('receipt_ledger_qualification_projection','monotonic_terminal_state_machine',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
