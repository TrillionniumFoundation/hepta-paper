PRAGMA foreign_keys = ON;

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
  ON qualification.sequence = (
    SELECT MAX(candidate.sequence)
    FROM receipt_ledger_qualifications AS candidate
    WHERE candidate.receipt_id = receipt.receipt_id
  );

INSERT INTO store_metadata(key,value,updated_at) VALUES
  ('schema_version','19',datetime('now')),
  ('receipt_ledger_qualification_projection','effective_view_fail_closed',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
