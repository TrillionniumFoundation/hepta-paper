//! Bounded, read-only SQLite session changeset validation.
//!
//! Every actual table/operation must occur both in the authorized plan and in a
//! successfully invoked statement. This validator grants no writer authority,
//! applies no changeset, and rejects patchsets and indirect changes.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MAX_CHANGESET_BYTES: usize = 16 * 1024 * 1024;
const MAX_TABLES: usize = 1024;
const MAX_COLUMNS: usize = 4096;
const MAX_CHANGES: usize = 1_000_000;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{0}")]
pub struct ChangesetError(pub &'static str);
type Result<T> = std::result::Result<T, ChangesetError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangesetEffectV1 {
    pub table: String,
    pub operation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesetAuthorizationReportV1 {
    pub effects: Vec<ChangesetEffectV1>,
    pub effect_count: usize,
    pub table_operation_keys: Vec<String>,
}

pub(crate) fn safe_table(value: &str) -> bool {
    let mut bytes = value.bytes();
    !value.is_empty()
        && value.len() <= 128
        && bytes
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

struct Cursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl Cursor<'_> {
    fn byte(&mut self) -> Result<u8> {
        let byte = self
            .bytes
            .get(self.offset)
            .copied()
            .ok_or(ChangesetError("sqlite_changeset_truncated"))?;
        self.offset += 1;
        Ok(byte)
    }
    fn varint(&mut self) -> Result<usize> {
        let mut value = 0_u64;
        for _ in 0..8 {
            let byte = self.byte()?;
            value = (value << 7) | u64::from(byte & 0x7f);
            if byte & 0x80 == 0 {
                return Self::safe_integer(value);
            }
        }
        value = (value << 8) | u64::from(self.byte()?);
        Self::safe_integer(value)
    }
    fn safe_integer(value: u64) -> Result<usize> {
        if value > 9_007_199_254_740_991 {
            return Err(ChangesetError("sqlite_changeset_varint_overflow"));
        }
        usize::try_from(value).map_err(|_| ChangesetError("sqlite_changeset_varint_overflow"))
    }
    fn skip(&mut self, length: usize) -> Result<()> {
        let end = self
            .offset
            .checked_add(length)
            .filter(|end| *end <= self.bytes.len())
            .ok_or(ChangesetError("sqlite_changeset_truncated"))?;
        self.offset = end;
        Ok(())
    }
    fn record(&mut self, columns: usize) -> Result<()> {
        for _ in 0..columns {
            match self.byte()? {
                0 | 5 => {}
                1 | 2 => self.skip(8)?,
                3 | 4 => {
                    let length = self.varint()?;
                    if length > MAX_CHANGESET_BYTES {
                        return Err(ChangesetError("sqlite_changeset_value_too_large"));
                    }
                    self.skip(length)?;
                }
                _ => return Err(ChangesetError("sqlite_changeset_value_type_invalid")),
            }
        }
        Ok(())
    }
    fn table(&mut self) -> Result<String> {
        let start = self.offset;
        while self.offset < self.bytes.len() && self.bytes[self.offset] != 0 {
            self.offset += 1;
        }
        if self.offset == self.bytes.len() {
            return Err(ChangesetError("sqlite_changeset_table_name_unterminated"));
        }
        let value = std::str::from_utf8(&self.bytes[start..self.offset])
            .map_err(|_| ChangesetError("sqlite_changeset_table_name_invalid_utf8"))?;
        // The incumbent fatal UTF-8 TextDecoder removes one initial BOM.
        let value = value.strip_prefix('\u{feff}').unwrap_or(value);
        self.offset += 1;
        if !safe_table(value) {
            return Err(ChangesetError("sqlite_changeset_table_name_invalid"));
        }
        Ok(value.to_owned())
    }
}

/// Inspect the stable SQLite session wire format without applying it.
pub fn inspect_sqlite_changeset_effects_v1(bytes: &[u8]) -> Result<Vec<ChangesetEffectV1>> {
    if bytes.len() > MAX_CHANGESET_BYTES {
        return Err(ChangesetError("sqlite_changeset_too_large"));
    }
    let mut cursor = Cursor { bytes, offset: 0 };
    let mut effects = Vec::new();
    let mut tables = 0;
    while cursor.offset < bytes.len() {
        if cursor.byte()? != b'T' {
            return Err(ChangesetError("sqlite_changeset_header_invalid"));
        }
        tables += 1;
        if tables > MAX_TABLES {
            return Err(ChangesetError("sqlite_changeset_table_limit_exceeded"));
        }
        let columns = cursor.varint()?;
        if !(1..=MAX_COLUMNS).contains(&columns) {
            return Err(ChangesetError("sqlite_changeset_column_count_invalid"));
        }
        let mut primary_key = Vec::new();
        for _ in 0..columns {
            let order = usize::from(cursor.byte()?);
            if order > columns {
                return Err(ChangesetError("sqlite_changeset_primary_key_invalid"));
            }
            if order != 0 {
                primary_key.push(order);
            }
        }
        primary_key.sort_unstable();
        if primary_key.is_empty()
            || primary_key
                .iter()
                .enumerate()
                .any(|(index, order)| *order != index + 1)
        {
            return Err(ChangesetError("sqlite_changeset_primary_key_required"));
        }
        let table = cursor.table()?;
        while cursor.offset < bytes.len() && bytes[cursor.offset] != b'T' {
            let opcode = cursor.byte()?;
            if cursor.byte()? != 0 {
                return Err(ChangesetError("sqlite_changeset_indirect_change_forbidden"));
            }
            let operation = match opcode {
                0x12 => "INSERT",
                0x17 => "UPDATE",
                0x09 => "DELETE",
                _ => return Err(ChangesetError("sqlite_changeset_operation_invalid")),
            };
            cursor.record(columns)?;
            if opcode == 0x17 {
                cursor.record(columns)?;
            }
            if effects.len() == MAX_CHANGES {
                return Err(ChangesetError("sqlite_changeset_change_limit_exceeded"));
            }
            effects.push(ChangesetEffectV1 {
                table: table.clone(),
                operation: operation.to_owned(),
            });
        }
    }
    Ok(effects)
}

fn effect_key(effect: &ChangesetEffectV1) -> Result<String> {
    let operation = effect.operation.to_uppercase();
    if !safe_table(&effect.table) || !["INSERT", "UPDATE", "DELETE"].contains(&operation.as_str()) {
        return Err(ChangesetError(
            "sqlite_changeset_authorization_effect_invalid",
        ));
    }
    Ok(format!("{}\0{operation}", effect.table))
}

/// Require both signed-plan permission and a successfully invoked statement for
/// each observed effect. Empty effects still require valid authorization inputs.
pub fn assert_sqlite_changeset_effects_authorized_v1(
    changeset: &[u8],
    authorized: &[ChangesetEffectV1],
    executed: &[ChangesetEffectV1],
) -> Result<ChangesetAuthorizationReportV1> {
    let authorized = authorized
        .iter()
        .map(effect_key)
        .collect::<Result<BTreeSet<_>>>()?;
    let executed = executed
        .iter()
        .map(effect_key)
        .collect::<Result<BTreeSet<_>>>()?;
    let actual = inspect_sqlite_changeset_effects_v1(changeset)?;
    let mut keys = BTreeSet::new();
    for effect in &actual {
        let key = effect_key(effect)?;
        if !authorized.contains(&key) || !executed.contains(&key) {
            return Err(ChangesetError(
                "externally_fenced_sqlite_mutation_changeset_not_authorized",
            ));
        }
        keys.insert(key);
    }
    Ok(ChangesetAuthorizationReportV1 {
        effect_count: actual.len(),
        effects: actual,
        table_operation_keys: keys.into_iter().collect(),
    })
}
