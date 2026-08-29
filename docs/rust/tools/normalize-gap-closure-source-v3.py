#!/usr/bin/env python3
"""Third deterministic normalization pass for qualification evidence and ledger authority."""

from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]


def replace_once(path: str, old: str, new: str) -> None:
    selected = ROOT / path
    text = selected.read_text(encoding="utf-8")
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise ValueError(f"{path}: expected one source form, found {count}")
    selected.write_text(text.replace(old, new), encoding="utf-8")


def insert_before(path: str, marker: str, addition: str) -> None:
    selected = ROOT / path
    text = selected.read_text(encoding="utf-8")
    if addition in text:
        return
    count = text.count(marker)
    if count != 1:
        raise ValueError(f"{path}: expected one insertion marker, found {count}")
    selected.write_text(text.replace(marker, addition + marker), encoding="utf-8")


def main() -> int:
    replace_once(
        "rust/Cargo.toml",
        """  \"crates/hepta-legacy-compat\",
  \"crates/hepta-readonly-store\",
""",
        """  \"crates/hepta-legacy-compat\",
  \"crates/hepta-qualification-evidence\",
  \"crates/hepta-readonly-store\",
""",
    )
    replace_once(
        "rust/crates/hepta-qualification-evidence/src/lib.rs",
        """    path::{Component, Path, PathBuf},
    str::FromStr,
    time::Duration,
""",
        """    path::{Component, Path, PathBuf},
    time::Duration,
""",
    )
    replace_once(
        "rust/crates/hepta-qualification-evidence/src/lib.rs",
        """#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = \"camelCase\", deny_unknown_fields)]
pub struct QualificationTrustStoreDocumentV1 {
""",
        """#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = \"camelCase\", deny_unknown_fields)]
pub struct QualificationTrustStoreDocumentV1 {
""",
    )
    replace_once(
        "rust/crates/hepta-qualification-evidence/src/lib.rs",
        """#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = \"camelCase\", deny_unknown_fields)]
pub struct QualificationTrustKeyDocumentV1 {
""",
        """#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = \"camelCase\", deny_unknown_fields)]
pub struct QualificationTrustKeyDocumentV1 {
""",
    )
    replace_once(
        "rust/crates/hepta-qualification-evidence/src/lib.rs",
        """        previous_evidence_hash: &'a Option<String>,
""",
        """        #[serde(skip_serializing_if = \"Option::is_none\")]
        previous_evidence_hash: &'a Option<String>,
""",
    )

    replace_once(
        "rust/crates/hepta-qualification-evidence/src/lib.rs",
        """        inspect_private_file(requested, owner_uid, MAXIMUM_EVIDENCE_BYTES * 16)?;
        let connection = Connection::open_with_flags(
            requested,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.busy_timeout(Duration::from_millis(5_000))?;
        connection.execute_batch(
            \"PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA trusted_schema = OFF;
             PRAGMA application_id = 1213224757;
             PRAGMA user_version = 1;
             CREATE TABLE IF NOT EXISTS consumed_challenges (
                 challenge_id TEXT PRIMARY KEY,
                 nonce_hash TEXT NOT NULL,
                 evidence_kind TEXT NOT NULL,
                 record_hash TEXT NOT NULL UNIQUE,
                 consumed_at_unix_ms INTEGER NOT NULL CHECK (consumed_at_unix_ms > 0)
             ) STRICT;\",
        )?;
        let application_id: i64 =
            connection.query_row(\"PRAGMA application_id\", [], |row| row.get(0))?;
        let user_version: i64 =
            connection.query_row(\"PRAGMA user_version\", [], |row| row.get(0))?;
        if application_id != LEDGER_APPLICATION_ID || user_version != LEDGER_USER_VERSION {
            return Err(QualificationEvidenceError::LedgerInvalid);
        }
""",
        """        inspect_private_file(requested, owner_uid, MAXIMUM_EVIDENCE_BYTES * 16)?;
        let initialize = preflight_ledger(requested, owner_uid)?;
        let connection = Connection::open_with_flags(
            requested,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        connection.busy_timeout(Duration::from_millis(5_000))?;
        connection.execute_batch(
            \"PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA trusted_schema = OFF;\",
        )?;
        if initialize {
            connection.execute_batch(
                \"PRAGMA application_id = 1213224757;
                 PRAGMA user_version = 1;
                 CREATE TABLE consumed_challenges (
                     challenge_id TEXT PRIMARY KEY,
                     nonce_hash TEXT NOT NULL,
                     evidence_kind TEXT NOT NULL,
                     record_hash TEXT NOT NULL UNIQUE,
                     consumed_at_unix_ms INTEGER NOT NULL CHECK (consumed_at_unix_ms > 0)
                 ) STRICT;\",
            )?;
        } else {
            verify_ledger_identity(&connection)?;
        }
        inspect_optional_ledger_sidecars(requested, owner_uid)?;
""",
    )
    insert_before(
        "rust/crates/hepta-qualification-evidence/src/lib.rs",
        """pub struct ChallengeLedgerV1 {
""",
        """fn preflight_ledger(path: &Path, owner_uid: u32) -> Result<bool, QualificationEvidenceError> {
    inspect_private_file(path, owner_uid, MAXIMUM_EVIDENCE_BYTES * 16)?;
    inspect_optional_ledger_sidecars(path, owner_uid)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| QualificationEvidenceError::Filesystem(\"ledger_preflight\", error.kind()))?;
    if metadata.size() == 0 {
        return Ok(true);
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.busy_timeout(Duration::from_millis(5_000))?;
    connection.execute_batch(
        \"PRAGMA query_only = ON;
         PRAGMA trusted_schema = OFF;
         PRAGMA temp_store = MEMORY;\",
    )?;
    verify_ledger_identity(&connection)?;
    let integrity: String = connection.query_row(\"PRAGMA integrity_check\", [], |row| row.get(0))?;
    if integrity != \"ok\" {
        return Err(QualificationEvidenceError::LedgerInvalid);
    }
    inspect_private_file(path, owner_uid, MAXIMUM_EVIDENCE_BYTES * 16)?;
    inspect_optional_ledger_sidecars(path, owner_uid)?;
    Ok(false)
}

fn verify_ledger_identity(connection: &Connection) -> Result<(), QualificationEvidenceError> {
    let application_id: i64 =
        connection.query_row(\"PRAGMA application_id\", [], |row| row.get(0))?;
    let user_version: i64 =
        connection.query_row(\"PRAGMA user_version\", [], |row| row.get(0))?;
    let table_count: i64 = connection.query_row(
        \"SELECT count(*) FROM sqlite_schema
         WHERE type = 'table' AND name = 'consumed_challenges'\",
        [],
        |row| row.get(0),
    )?;
    if application_id != LEDGER_APPLICATION_ID
        || user_version != LEDGER_USER_VERSION
        || table_count != 1
    {
        return Err(QualificationEvidenceError::LedgerInvalid);
    }
    Ok(())
}

fn inspect_optional_ledger_sidecars(
    path: &Path,
    owner_uid: u32,
) -> Result<(), QualificationEvidenceError> {
    for suffix in [\"-wal\", \"-shm\"] {
        let selected = PathBuf::from(format!(\"{}{}\", path.display(), suffix));
        match fs::symlink_metadata(&selected) {
            Ok(metadata)
                if metadata.file_type().is_symlink()
                    || !metadata.is_file()
                    || metadata.uid() != owner_uid
                    || metadata.mode() & 0o7777 != 0o600
                    || metadata.nlink() != 1
                    || metadata.size() > MAXIMUM_EVIDENCE_BYTES * 16 =>
            {
                return Err(QualificationEvidenceError::LedgerInvalid);
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(QualificationEvidenceError::Filesystem(
                    \"ledger_sidecar\",
                    error.kind(),
                ));
            }
        }
    }
    Ok(())
}

""",
    )
    replace_once(
        "rust/crates/hepta-qualification-evidence/src/lib.rs",
        """        tx.commit()?;
        inspect_private_file(&self.path, self.owner_uid, MAXIMUM_EVIDENCE_BYTES * 16)
""",
        """        tx.commit()?;
        inspect_private_file(&self.path, self.owner_uid, MAXIMUM_EVIDENCE_BYTES * 16)?;
        inspect_optional_ledger_sidecars(&self.path, self.owner_uid)
""",
    )

    print("normalized external qualification evidence and ledger authority")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        print(f"source normalization v3 failed: {error}", file=sys.stderr)
        raise SystemExit(1)
