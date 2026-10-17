use super::{INVALID, LIMIT, SCHEMA, STORAGE};
use rusqlite::{Connection, OpenFlags, Row, limits::Limit, types::ValueRef};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::Duration,
};

pub(super) type Result<T> = std::result::Result<T, String>;
pub(super) const MAXIMUM_GENERATIONS: usize = 10_000;
const MAXIMUM_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAXIMUM_TEXT_BYTES: usize = 4096;
const MAXIMUM_AGGREGATE_BYTES: usize = 32 * 1024 * 1024;

pub(super) fn error(error: rusqlite::Error) -> String {
    if matches!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::OperationInterrupted | rusqlite::ErrorCode::TooBig)
    ) {
        LIMIT.to_owned()
    } else {
        INVALID.to_owned()
    }
}

pub(super) fn open(path: &Path) -> Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(error)?;
    for (limit, size) in [
        (Limit::SQLITE_LIMIT_LENGTH, (8 * 1024 * 1024) + 65_536),
        (Limit::SQLITE_LIMIT_SQL_LENGTH, 512 * 1024),
        (Limit::SQLITE_LIMIT_COLUMN, 64),
        (Limit::SQLITE_LIMIT_EXPR_DEPTH, 100),
        (Limit::SQLITE_LIMIT_ATTACHED, 0),
        (Limit::SQLITE_LIMIT_WORKER_THREADS, 0),
    ] {
        connection.set_limit(limit, size).map_err(error)?;
    }
    connection
        .busy_timeout(Duration::from_millis(1000))
        .map_err(error)?;
    let mut ticks = 0u32;
    connection
        .progress_handler(
            1000,
            Some(move || {
                ticks = ticks.saturating_add(1);
                ticks > 10_000
            }),
        )
        .map_err(error)?;
    connection
        .execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")
        .map_err(error)?;
    Ok(connection)
}

pub(super) struct Schema {
    entries: BTreeMap<String, (String, String)>,
}
impl Schema {
    pub fn observe(connection: &Connection) -> Result<Self> {
        let mut statement = connection.prepare("SELECT type,name,CASE WHEN length(CAST(sql AS BLOB))<=65536 THEN sql END FROM sqlite_schema LIMIT 129").map_err(|_| SCHEMA)?;
        let mut rows = statement.query([]).map_err(|_| SCHEMA)?;
        let mut entries = BTreeMap::new();
        while let Some(row) = rows.next().map_err(|_| SCHEMA)? {
            if entries.len() >= 128 {
                return Err(LIMIT.into());
            }
            let kind = text(row, 0, 16, SCHEMA)?;
            let name = text(row, 1, 256, SCHEMA)?;
            let sql = match row.get_ref(2).map_err(|_| SCHEMA)? {
                ValueRef::Null if kind == "index" && name.starts_with("sqlite_autoindex_") => {
                    String::new()
                }
                ValueRef::Text(bytes) if bytes.len() <= 65_536 => {
                    std::str::from_utf8(bytes).map_err(|_| SCHEMA)?.to_owned()
                }
                _ => return Err(SCHEMA.into()),
            };
            if entries.insert(name, (kind, sql)).is_some() {
                return Err(SCHEMA.into());
            }
        }
        Ok(Self { entries })
    }
    pub fn columns(
        &self,
        connection: &Connection,
        table: &str,
    ) -> Result<Option<BTreeSet<String>>> {
        let Some((kind, sql)) = self.entries.get(table) else {
            return Ok(None);
        };
        let mut words = sql.split_whitespace();
        if kind != "table"
            || !words
                .next()
                .is_some_and(|word| word.eq_ignore_ascii_case("CREATE"))
            || !words
                .next()
                .is_some_and(|word| word.eq_ignore_ascii_case("TABLE"))
        {
            return Err(SCHEMA.into());
        }
        // All identifiers are source constants, never caller/schema content.
        let mut statement = connection
            .prepare(&format!("PRAGMA table_xinfo({table})"))
            .map_err(|_| SCHEMA)?;
        let mut rows = statement.query([]).map_err(|_| SCHEMA)?;
        let mut columns = BTreeSet::new();
        while let Some(row) = rows.next().map_err(|_| SCHEMA)? {
            if columns.len() >= 64 {
                return Err(LIMIT.into());
            }
            let name = text(row, 1, 128, SCHEMA)?;
            let hidden: i64 = row.get(6).map_err(|_| SCHEMA)?;
            if hidden != 0 || !columns.insert(name) {
                return Err(SCHEMA.into());
            }
        }
        Ok(Some(columns))
    }
}

pub(super) fn require_columns(columns: Option<&BTreeSet<String>>, fields: &[Field]) -> Result<()> {
    if columns.is_some_and(|columns| fields.iter().all(|field| columns.contains(field.name))) {
        Ok(())
    } else {
        Err(SCHEMA.into())
    }
}

#[derive(Clone, Copy)]
pub(super) enum Kind {
    Integer,
    Number,
    Text,
    NullableText,
    Json,
    NullableJson,
}
pub(super) struct Field {
    pub name: &'static str,
    pub kind: Kind,
}
impl Field {
    pub const fn new(name: &'static str, kind: Kind) -> Self {
        Self { name, kind }
    }
    fn maximum(&self) -> usize {
        if matches!(self.kind, Kind::Json | Kind::NullableJson) {
            MAXIMUM_JSON_BYTES
        } else {
            MAXIMUM_TEXT_BYTES
        }
    }
    fn guard(&self) -> String {
        let column = self.name;
        match self.kind {
            Kind::Integer => format!("typeof({column})='integer'"),
            Kind::Number => format!("typeof({column}) IN ('integer','real')"),
            Kind::Text | Kind::Json => format!(
                "(typeof({column})='text' AND length(CAST({column} AS BLOB))<={})",
                self.maximum()
            ),
            Kind::NullableText | Kind::NullableJson => format!(
                "({column} IS NULL OR (typeof({column})='text' AND length(CAST({column} AS BLOB))<={}))",
                self.maximum()
            ),
        }
    }
}

pub(super) fn select(fields: &[Field]) -> String {
    let guards = fields.iter().map(Field::guard).collect::<Vec<_>>();
    let mut expressions = vec![format!("({}) AS __native_profile", guards.join(" AND "))];
    expressions.extend(fields.iter().zip(guards).map(|(field, guard)| {
        format!(
            "CASE WHEN {guard} THEN {} END AS {}",
            field.name, field.name
        )
    }));
    expressions.join(",")
}

#[derive(Default)]
pub(super) struct Budget {
    bytes: usize,
}
impl Budget {
    fn charge(&mut self, bytes: usize) -> Result<()> {
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .filter(|bytes| *bytes <= MAXIMUM_AGGREGATE_BYTES)
            .ok_or(LIMIT)?;
        Ok(())
    }
}

pub(super) fn record(row: &Row<'_>, fields: &[Field], budget: &mut Budget) -> Result<Value> {
    if row.get::<_, i64>(0).map_err(|_| STORAGE)? != 1 {
        return Err(STORAGE.into());
    }
    let mut output = Map::new();
    for (index, field) in fields.iter().enumerate() {
        let value = match row.get_ref(index + 1).map_err(error)? {
            ValueRef::Integer(number) if number.unsigned_abs() <= 9_007_199_254_740_991 => {
                budget.charge(32)?;
                Value::from(number)
            }
            ValueRef::Real(number) if number.is_finite() => {
                budget.charge(32)?;
                serde_json::Number::from_f64(number)
                    .map(Value::Number)
                    .ok_or(STORAGE)?
            }
            ValueRef::Text(bytes) if bytes.len() <= field.maximum() => {
                budget.charge(bytes.len())?;
                Value::String(std::str::from_utf8(bytes).map_err(|_| STORAGE)?.to_owned())
            }
            ValueRef::Null if matches!(field.kind, Kind::NullableText | Kind::NullableJson) => {
                Value::Null
            }
            _ => return Err(STORAGE.into()),
        };
        output.insert(field.name.to_owned(), value);
    }
    Ok(Value::Object(output))
}

fn text(row: &Row<'_>, index: usize, maximum: usize, code: &str) -> Result<String> {
    match row.get_ref(index).map_err(|_| code)? {
        ValueRef::Text(bytes) if bytes.len() <= maximum => {
            Ok(std::str::from_utf8(bytes).map_err(|_| code)?.to_owned())
        }
        _ => Err(code.into()),
    }
}
