//! Exact, bounded SQL values from one held main snapshot. JSON TEXT is kept
//! byte-for-byte, including whitespace; its signed content is parsed later.
use crate::sqlite_mutation_coordinator::{Result, error};
use rusqlite::{Connection, TransactionState, types::ValueRef};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const MAX_CELL: usize = 1024 * 1024;
const MAX_TOTAL: usize = 64 * 1024 * 1024;
const DOMAIN: &[u8] = b"HeptaLocalStateAuthorityLegacySqlRowsV1\0";

struct Table {
    name: &'static str,
    columns: &'static str,
    maximum: usize,
}
const TABLES: [Table; 6] = [
    Table {
        name: "authority_metadata",
        columns: "rowid,singleton,configuration_hash,authority_id,key_id,scope_id,database_scope_hash,writer_manifest_hash,global_sequence,global_hash,schema_transition_state",
        maximum: 1,
    },
    Table {
        name: "authority_database_head",
        columns: "rowid,database_instance_id,database_role,sequence,hash,schema_hash,state_hash",
        maximum: 10,
    },
    Table {
        name: "authority_schema_transition",
        columns: "rowid,singleton,reserve_request_json,reservation_receipt_json,finalize_request_json,finalization_receipt_json",
        maximum: 1,
    },
    Table {
        name: "authority_schema_rebind",
        columns: "rowid,transition_id,reserve_request_json,reservation_receipt_json,finalize_request_json,finalization_receipt_json,target_configuration_hash",
        maximum: 64,
    },
    Table {
        name: "authority_mutation",
        columns: "rowid,mutation_attempt_id,reservation_id,status,global_sequence,database_instance_id,reserve_request_json,reservation_receipt_json,finalize_request_json,finalization_receipt_json,abort_request_json,abort_receipt_json",
        maximum: 10_000,
    },
    // The initial verifier refuses every backup row. Reading at most one is
    // sufficient to distinguish an empty history without unbounded collection.
    Table {
        name: "authority_backup_reservation",
        columns: "rowid,reservation_id,reserve_request_json,reservation_receipt_json,finalize_request_json,finalization_receipt_json",
        maximum: 1,
    },
];

pub(super) struct JournalRows {
    tables: [Vec<Vec<Value>>; 6],
    logical_hash: String,
}
impl JournalRows {
    pub(super) fn metadata(&self) -> &[Vec<Value>] {
        &self.tables[0]
    }
    pub(super) fn heads(&self) -> &[Vec<Value>] {
        &self.tables[1]
    }
    pub(super) fn schema_transition(&self) -> &[Vec<Value>] {
        &self.tables[2]
    }
    pub(super) fn schema_rebind(&self) -> &[Vec<Value>] {
        &self.tables[3]
    }
    pub(super) fn mutations(&self) -> &[Vec<Value>] {
        &self.tables[4]
    }
    pub(super) fn backups(&self) -> &[Vec<Value>] {
        &self.tables[5]
    }
    pub(super) fn logical_hash(&self) -> &str {
        &self.logical_hash
    }
    pub(super) fn counts(&self) -> Value {
        Value::Object(
            TABLES
                .iter()
                .zip(&self.tables)
                .map(|(table, rows)| (table.name.to_owned(), json!(rows.len())))
                .collect(),
        )
    }
}

fn framed(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}
pub(super) fn read_source_rows(db: &Connection) -> Result<JournalRows> {
    let transaction = db.transaction_state(Some("main"))?;
    if !matches!(
        transaction,
        TransactionState::Read | TransactionState::Write
    ) {
        return Err(error("local_authority_history_main_transaction_required"));
    }
    let changes = db.total_changes();
    let mut total = 0usize;
    let mut tables = std::array::from_fn(|_| Vec::new());
    let mut digest = Sha256::new();
    digest.update(DOMAIN);
    digest.update((TABLES.len() as u64).to_le_bytes());
    for (table, output) in TABLES.iter().zip(&mut tables) {
        framed(&mut digest, table.name.as_bytes());
        framed(&mut digest, table.columns.as_bytes());
        // Identifiers are source-owned literals, never request or database text.
        let sql = format!(
            "SELECT {} FROM main.{} ORDER BY rowid",
            table.columns, table.name
        );
        let mut statement = db.prepare(&sql)?;
        let columns = table.columns.split(',').count();
        if !statement.readonly() || statement.column_count() != columns {
            return Err(error("local_authority_history_readonly_required"));
        }
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            if output.len() >= table.maximum {
                return Err(error("local_authority_history_row_limit_exceeded"));
            }
            digest.update([1]);
            let mut values = Vec::with_capacity(columns);
            for index in 0..columns {
                let raw = row.get_ref(index)?;
                let size = match raw {
                    ValueRef::Null => 0,
                    ValueRef::Integer(_) => 8,
                    ValueRef::Text(bytes) => bytes.len(),
                    _ => return Err(error("local_authority_history_sql_type_invalid")),
                };
                total = total
                    .checked_add(size)
                    .ok_or_else(|| error("local_authority_history_byte_limit_exceeded"))?;
                if size > MAX_CELL || total > MAX_TOTAL {
                    return Err(error("local_authority_history_byte_limit_exceeded"));
                }
                let value = match raw {
                    ValueRef::Null => {
                        digest.update([0]);
                        Value::Null
                    }
                    ValueRef::Integer(number) => {
                        digest.update([1]);
                        digest.update(number.to_le_bytes());
                        json!(number)
                    }
                    ValueRef::Text(bytes) => {
                        let text = std::str::from_utf8(bytes)
                            .map_err(|_| error("local_authority_history_sql_text_invalid"))?;
                        digest.update([2]);
                        framed(&mut digest, bytes);
                        json!(text)
                    }
                    _ => unreachable!("SQL types were checked above"),
                };
                values.push(value);
            }
            output.push(values);
        }
        digest.update([0]);
        digest.update((output.len() as u64).to_le_bytes());
    }
    if db.total_changes() != changes || db.transaction_state(Some("main"))? != transaction {
        return Err(error("local_authority_history_transaction_changed"));
    }
    Ok(JournalRows {
        tables,
        logical_hash: format!("sha256:{}", hex::encode(digest.finalize())),
    })
}

#[cfg(test)]
mod tests;
