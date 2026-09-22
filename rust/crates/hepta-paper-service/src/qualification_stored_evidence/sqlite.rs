use super::{Error, Result, ensure};
use rusqlite::{Connection, OpenFlags, Row, limits::Limit, types::ValueRef};
use std::{collections::BTreeSet, path::Path, time::Duration};

const MAXIMUM_SCHEMA_ENTRIES: usize = 128;
const MAXIMUM_SCHEMA_SQL_BYTES: usize = 65_536;
const MAXIMUM_COLUMNS: usize = 64;

pub(super) fn open(path: &Path, maximum_payload: usize, invalid: &str) -> Result<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| Error::new(invalid))?;
    let cell_limit = maximum_payload
        .checked_add(65_536)
        .and_then(|size| i32::try_from(size).ok())
        .ok_or_else(|| Error::new(invalid))?;
    for (limit, value) in [
        (Limit::SQLITE_LIMIT_LENGTH, cell_limit),
        (Limit::SQLITE_LIMIT_SQL_LENGTH, 512 * 1024),
        (Limit::SQLITE_LIMIT_COLUMN, 64),
        (Limit::SQLITE_LIMIT_EXPR_DEPTH, 100),
        (Limit::SQLITE_LIMIT_ATTACHED, 0),
        (Limit::SQLITE_LIMIT_WORKER_THREADS, 0),
    ] {
        connection
            .set_limit(limit, value)
            .map_err(|_| Error::new(invalid))?;
    }
    connection
        .busy_timeout(Duration::from_millis(1000))
        .map_err(|_| Error::new(invalid))?;
    let mut ticks = 0u32;
    connection
        .progress_handler(
            1000,
            Some(move || {
                ticks = ticks.saturating_add(1);
                ticks > 10_000
            }),
        )
        .map_err(|_| Error::new(invalid))?;
    connection
        .execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")
        .map_err(|_| Error::new(invalid))?;
    Ok(connection)
}

pub(super) fn table(
    connection: &Connection,
    name: &str,
    required: &[&str],
    invalid: &str,
) -> Result<()> {
    let unsupported = format!("{invalid}_schema_unsupported");
    let mut statement = connection.prepare(
        "SELECT type,name,CASE WHEN length(CAST(sql AS BLOB))<=65536 THEN sql END FROM sqlite_schema LIMIT 129"
    ).map_err(|_| Error::new(&unsupported))?;
    let mut rows = statement.query([]).map_err(|_| Error::new(&unsupported))?;
    let mut count = 0;
    let mut found = false;
    while let Some(row) = rows.next().map_err(|_| Error::new(&unsupported))? {
        count += 1;
        ensure(count <= MAXIMUM_SCHEMA_ENTRIES, &unsupported)?;
        let kind = text(row, 0, 16, &unsupported)?;
        let actual_name = text(row, 1, 256, &unsupported)?;
        match row.get_ref(2).map_err(|_| Error::new(&unsupported))? {
            ValueRef::Null if kind == "index" && actual_name.starts_with("sqlite_autoindex_") => (),
            ValueRef::Text(bytes) if bytes.len() <= MAXIMUM_SCHEMA_SQL_BYTES => {
                if actual_name == name {
                    let sql = std::str::from_utf8(bytes).map_err(|_| Error::new(&unsupported))?;
                    let mut words = sql.split_whitespace();
                    ensure(
                        kind == "table"
                            && words
                                .next()
                                .is_some_and(|word| word.eq_ignore_ascii_case("CREATE"))
                            && words
                                .next()
                                .is_some_and(|word| word.eq_ignore_ascii_case("TABLE")),
                        &unsupported,
                    )?;
                    found = true;
                }
            }
            _ => return Err(Error::new(&unsupported)),
        }
    }
    ensure(found, invalid)?;
    // `name` is a source constant, never an identifier derived from caller data.
    let mut statement = connection
        .prepare(&format!("PRAGMA table_xinfo({name})"))
        .map_err(|_| Error::new(&unsupported))?;
    let mut rows = statement.query([]).map_err(|_| Error::new(&unsupported))?;
    let mut names = BTreeSet::new();
    while let Some(row) = rows.next().map_err(|_| Error::new(&unsupported))? {
        ensure(names.len() < MAXIMUM_COLUMNS, &unsupported)?;
        let column = text(row, 1, 128, &unsupported)?;
        let hidden = integer(row, 6, &unsupported)?;
        ensure(hidden == 0 && names.insert(column), &unsupported)?;
    }
    ensure(required.iter().all(|name| names.contains(*name)), invalid)
}

pub(super) fn text(row: &Row<'_>, index: usize, maximum: usize, invalid: &str) -> Result<String> {
    match row.get_ref(index).map_err(|_| Error::new(invalid))? {
        ValueRef::Text(bytes) if bytes.len() <= maximum => {
            Ok(String::from_utf8_lossy(bytes).into_owned())
        }
        _ => Err(Error::new(invalid)),
    }
}

pub(super) fn integer(row: &Row<'_>, index: usize, invalid: &str) -> Result<i64> {
    match row.get_ref(index).map_err(|_| Error::new(invalid))? {
        ValueRef::Integer(value) if value.unsigned_abs() <= 9_007_199_254_740_991 => Ok(value),
        _ => Err(Error::new(invalid)),
    }
}
