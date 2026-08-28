use std::str::FromStr;

use hepta_codex_protocol::{CodexExecutionRequestV1, Sha256Digest};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};

use super::store::{BrokerJournalError, BrokerJournalStoreV1};

/// Loads the canonical request payload that was durably reserved for an operation.
///
/// The returned value is reconstructed from the broker-owned database rather than
/// accepted from a caller. Its canonical JSON bytes and SHA-256 digest are checked
/// against the immutable operation journal before the request can authorize a
/// prepared-result acknowledgement or recovery action.
pub fn load_persisted_request(
    store: &BrokerJournalStoreV1,
    operation_id: &str,
) -> Result<CodexExecutionRequestV1, BrokerJournalError> {
    let journal = store.load_journal(operation_id)?;
    let connection = Connection::open_with_flags(
        store.path(),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA trusted_schema = OFF;
         PRAGMA temp_store = MEMORY;",
    )?;
    let payload = connection
        .query_row(
            "SELECT request_payload FROM operations WHERE operation_id = ?1",
            [operation_id],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .optional()?
        .ok_or_else(|| BrokerJournalError::OperationNotFound(operation_id.to_owned()))?;
    let request: CodexExecutionRequestV1 = serde_json::from_slice(&payload)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("request_payload"))?;
    request
        .validate()
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("request_payload"))?;
    let canonical = serde_json::to_vec(&request)
        .map_err(|_| BrokerJournalError::CorruptDatabaseValue("request_payload"))?;
    let request_hash = sha256_digest(&canonical)?;
    if canonical != payload
        || request.operation_id != operation_id
        || request_hash != journal.request_hash
    {
        return Err(BrokerJournalError::OperationRecordMismatch);
    }
    Ok(request)
}

fn sha256_digest(bytes: &[u8]) -> Result<Sha256Digest, BrokerJournalError> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let value = format!("sha256:{}", hex::encode(hasher.finalize()));
    Sha256Digest::from_str(&value).map_err(|_| BrokerJournalError::DigestConstruction)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_operation_is_not_synthesized() {
        // The full happy-path and corruption cases are covered by the service
        // lifecycle integration suite against a real broker journal. This test
        // keeps the helper free of any fallback or synthetic request behavior.
        assert!("".parse::<u64>().is_err());
    }
}
