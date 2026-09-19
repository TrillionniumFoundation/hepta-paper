//! Exact logical SQLite state comparison for installation recovery. This is
//! observation only: callers must independently authenticate the normalized
//! preimage and fixed migration/genesis replay before using equality.
//!
//! The caller owns both existing transactions (normally exclusive locks on the
//! live installation databases and a transaction on the private replay). This
//! function only observes them; it never begins, commits or rolls back a
//! transaction. It never opens a source path, runs migration SQL, issues an
//! authority capability, or canonicalizes row values.
//! SQLite page placement/rootpage and header write counters are physical state;
//! exact schema SQL, every effective cell/rowid and persistent control values
//! are compared. No heartbeat-specific system-field exceptions apply here.
use crate::sqlite_mutation_coordinator::{Result, SqliteMutationCoordinatorError};
use rusqlite::{Connection, limits::Limit, types::ValueRef};
use sha2::{Digest, Sha256};

const MAX_IDENTIFIER: usize = 4096;
const MAX_QUERY: usize = 1024 * 1024;
#[derive(Clone, Copy)]
struct Bounds {
    objects: usize,
    columns: usize,
    rows: usize,
    cells: usize,
    bytes: usize,
    cell: usize,
}
const BOUNDS: Bounds = Bounds {
    objects: 1024,
    columns: 4096,
    rows: 1_000_000,
    cells: 16_000_000,
    bytes: 1024 * 1024 * 1024,
    cell: 16 * 1024 * 1024,
};
fn failure(code: &str) -> SqliteMutationCoordinatorError {
    SqliteMutationCoordinatorError {
        code: code.into(),
        details: serde_json::json!({}),
        state_recoverability_fatal: false,
        state_recoverability_deferred: false,
        retryable: false,
    }
}
fn require(ok: bool, code: &str) -> Result<()> {
    if ok { Ok(()) } else { Err(failure(code)) }
}
const UNSUPPORTED: &str = "schema_transition_installation_state_unsupported";
const RESOURCE: &str = "schema_transition_installation_state_invalid";
const TRANSACTION: &str = "schema_transition_installation_state_invalid";
const MISMATCH: &str = "schema_transition_installation_state_mismatch";
struct Budget {
    bounds: Bounds,
    rows: usize,
    cells: usize,
    bytes: usize,
}
impl Budget {
    fn new(bounds: Bounds) -> Self {
        Self {
            bounds,
            rows: 0,
            cells: 0,
            bytes: 0,
        }
    }
    fn row(&mut self) -> Result<()> {
        self.rows = self.rows.checked_add(1).ok_or_else(|| failure(RESOURCE))?;
        require(self.rows <= self.bounds.rows, RESOURCE)
    }
    fn cell(&mut self, bytes: usize) -> Result<()> {
        self.cells = self.cells.checked_add(1).ok_or_else(|| failure(RESOURCE))?;
        // Include the framing and fixed-size values, so NULL/numeric-heavy rows
        // cannot evade aggregate accounting by containing no strings or blobs.
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .and_then(|n| n.checked_add(9))
            .ok_or_else(|| failure(RESOURCE))?;
        require(
            bytes <= self.bounds.cell
                && self.cells <= self.bounds.cells
                && self.bytes <= self.bounds.bytes,
            RESOURCE,
        )
    }
}
fn field(hash: &mut Sha256, tag: u8, bytes: &[u8]) {
    hash.update([tag]);
    hash.update((bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}
fn cell(hash: &mut Sha256, value: ValueRef<'_>, budget: &mut Budget) -> Result<()> {
    match value {
        ValueRef::Null => {
            budget.cell(0)?;
            field(hash, 0, &[]);
        }
        ValueRef::Integer(n) => {
            budget.cell(8)?;
            field(hash, 1, &n.to_be_bytes());
        }
        ValueRef::Real(n) => {
            budget.cell(8)?;
            field(hash, 2, &n.to_bits().to_be_bytes());
        }
        ValueRef::Text(bytes) => {
            budget.cell(bytes.len())?;
            field(hash, 3, bytes);
        }
        ValueRef::Blob(bytes) => {
            budget.cell(bytes.len())?;
            field(hash, 4, bytes);
        }
    }
    Ok(())
}
fn identifier(value: ValueRef<'_>) -> Result<String> {
    let ValueRef::Text(bytes) = value else {
        return Err(failure(UNSUPPORTED));
    };
    require(
        !bytes.is_empty() && bytes.len() <= MAX_IDENTIFIER && !bytes.contains(&0),
        UNSUPPORTED,
    )?;
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| failure(UNSUPPORTED))
}
fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn prepare_connection(database: &Connection, bounds: Bounds) -> Result<()> {
    // Set the C API limit before SQLite evaluates a query; preserve a caller's
    // stricter limit. This does not alter a busy handler or persistent state.
    let cap = i32::try_from(bounds.cell).map_err(|_| failure(RESOURCE))?;
    let limit = database.limit(Limit::SQLITE_LIMIT_LENGTH)?.min(cap);
    database.set_limit(Limit::SQLITE_LIMIT_LENGTH, limit)?;
    let trusted: bool = database.pragma_query_value(None, "trusted_schema", |row| row.get(0))?;
    let timeout: i64 = database.pragma_query_value(None, "busy_timeout", |row| row.get(0))?;
    require(!trusted && timeout == 0, UNSUPPORTED)
}
fn assert_surface(database: &Connection) -> Result<()> {
    let mut statement = database.prepare("PRAGMA database_list")?;
    let mut rows = statement.query([])?;
    let mut count = 0;
    while let Some(row) = rows.next()? {
        count += 1;
        require(count <= 2, UNSUPPORTED)?;
        let name = identifier(row.get_ref(1)?)?;
        require(name == "main" || name == "temp", UNSUPPORTED)?;
    }
    let present: bool = database.query_row(
        "SELECT EXISTS(SELECT 1 FROM temp.sqlite_schema)",
        [],
        |row| row.get(0),
    )?;
    require(!present, UNSUPPORTED)
}
fn pin_snapshot(database: &Connection) -> Result<()> {
    let mut statement = database.prepare("SELECT name FROM main.sqlite_schema LIMIT 1")?;
    let mut rows = statement.query([])?;
    let _ = rows.next()?;
    Ok(())
}
fn schema_digest(database: &Connection, budget: &mut Budget) -> Result<[u8; 32]> {
    let mut hash = Sha256::new();
    let mut statement=database.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY")?;
    let mut rows = statement.query([])?;
    let mut count = 0usize;
    while let Some(row) = rows.next()? {
        count += 1;
        require(count <= budget.bounds.objects, RESOURCE)?;
        field(&mut hash, 8, &(count as u64).to_be_bytes());
        for index in 0..4 {
            cell(&mut hash, row.get_ref(index)?, budget)?;
        }
    }
    field(&mut hash, 9, &(count as u64).to_be_bytes());
    Ok(hash.finalize().into())
}
fn table_digest(
    database: &Connection,
    table: &str,
    without_rowid: bool,
    budget: &mut Budget,
) -> Result<[u8; 32]> {
    let mut columns = Vec::new();
    let mut statement =
        database.prepare("SELECT name,hidden FROM pragma_table_xinfo(?1,'main') ORDER BY cid")?;
    let mut rows = statement.query([table])?;
    while let Some(row) = rows.next()? {
        require(columns.len() < budget.bounds.columns, RESOURCE)?;
        let name = identifier(row.get_ref(0)?)?;
        let hidden: i64 = row.get(1)?;
        require(matches!(hidden, 0 | 2 | 3), UNSUPPORTED)?;
        columns.push(name);
    }
    require(!columns.is_empty(), UNSUPPORTED)?;
    drop(rows);
    drop(statement);
    let mut projection = String::new();
    for name in &columns {
        let quoted = quote(name);
        require(
            projection
                .len()
                .checked_add(quoted.len() + 1)
                .is_some_and(|n| n <= MAX_QUERY / 2),
            RESOURCE,
        )?;
        if !projection.is_empty() {
            projection.push(',');
        }
        projection.push_str(&quoted);
    }
    let rowid = if without_rowid {
        None
    } else {
        Some(
            ["_rowid_", "rowid", "oid"]
                .into_iter()
                .find(|alias| {
                    columns
                        .iter()
                        .all(|column| !column.eq_ignore_ascii_case(alias))
                })
                .ok_or_else(|| failure(UNSUPPORTED))?,
        )
    };
    if let Some(name) = rowid {
        projection.push(',');
        projection.push_str(&quote(name));
    }
    let count = columns.len() + usize::from(rowid.is_some());
    let mut statement = database.prepare(&format!(
        "SELECT {projection} FROM main.{} NOT INDEXED",
        quote(table)
    ))?;
    let mut rows = statement.query([])?;
    let mut hashes: Vec<[u8; 32]> = Vec::new();
    while let Some(row) = rows.next()? {
        budget.row()?;
        let mut hash = Sha256::new();
        for index in 0..count {
            cell(&mut hash, row.get_ref(index)?, budget)?;
        }
        hashes.push(hash.finalize().into());
    }
    hashes.sort_unstable();
    let mut hash = Sha256::new();
    field(&mut hash, 0, table.as_bytes());
    field(&mut hash, 1, &[u8::from(without_rowid)]);
    for name in columns {
        field(&mut hash, 2, name.as_bytes());
    }
    field(&mut hash, 3, rowid.unwrap_or("").as_bytes());
    field(&mut hash, 4, &(hashes.len() as u64).to_be_bytes());
    for row in hashes {
        hash.update(row);
    }
    Ok(hash.finalize().into())
}
fn exact_digest(database: &Connection, bounds: Bounds) -> Result<[u8; 32]> {
    assert_surface(database)?;
    let mut budget = Budget::new(bounds);
    let mut hash = Sha256::new();
    hash.update(schema_digest(database, &mut budget)?);
    let mut tables = Vec::new();
    let mut count = 0;
    let mut statement=database.prepare("SELECT name,type,wr FROM pragma_table_list WHERE schema='main' AND name<>'sqlite_schema' ORDER BY name COLLATE BINARY")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        count += 1;
        require(count <= bounds.objects, RESOURCE)?;
        let name = identifier(row.get_ref(0)?)?;
        let kind = identifier(row.get_ref(1)?)?;
        if kind == "view" {
            continue;
        }
        require(kind == "table", UNSUPPORTED)?;
        let wr: i64 = row.get(2)?;
        require(wr == 0 || wr == 1, UNSUPPORTED)?;
        tables.push((name, wr == 1));
    }
    drop(rows);
    drop(statement);
    field(&mut hash, 10, &(tables.len() as u64).to_be_bytes());
    for (name, wr) in tables {
        hash.update(table_digest(database, &name, wr, &mut budget)?);
    }
    for pragma in ["user_version", "application_id", "encoding"] {
        let mut statement = database.prepare(&format!("PRAGMA main.{pragma}"))?;
        let mut rows = statement.query([])?;
        let row = rows.next()?.ok_or_else(|| failure(UNSUPPORTED))?;
        field(&mut hash, 11, pragma.as_bytes());
        cell(&mut hash, row.get_ref(0)?, &mut budget)?;
        require(rows.next()?.is_none(), UNSUPPORTED)?;
    }
    // quick_check omits correspondence between secondary indexes and table
    // rows. Only accept equality after SQLite verifies that persisted structure.
    // Run this after the bounded row scan, so over-limit inputs fail first.
    let mut check = database.prepare("PRAGMA main.integrity_check(1)")?;
    let mut checked = check.query([])?;
    let status = checked.next()?.ok_or_else(|| failure(UNSUPPORTED))?;
    require(
        matches!(status.get_ref(0)?,ValueRef::Text(bytes) if bytes==b"ok"),
        UNSUPPORTED,
    )?;
    require(checked.next()?.is_none(), UNSUPPORTED)?;
    drop(checked);
    drop(check);
    Ok(hash.finalize().into())
}
fn compare_with_bounds(expected: &Connection, actual: &Connection, bounds: Bounds) -> Result<()> {
    // The caller's existing transaction/lock remains active on every return.
    require(
        !expected.is_autocommit() && !actual.is_autocommit(),
        TRANSACTION,
    )?;
    prepare_connection(expected, bounds)?;
    prepare_connection(actual, bounds)?;
    pin_snapshot(expected)?;
    pin_snapshot(actual)?;
    require(
        exact_digest(expected, bounds)? == exact_digest(actual, bounds)?,
        MISMATCH,
    )
}
/// Observe exact logical state inside two caller-owned transactions. Requires
/// trusted_schema=false and busy_timeout=0 set by the caller before locking.
/// Lowers only the connection's length limit; never commits, rolls back, writes
/// rows/schema, canonicalizes JSON/time, or creates an authority capability.
pub(crate) fn compare_installation_state_v1(
    expected: &Connection,
    actual: &Connection,
) -> Result<()> {
    compare_with_bounds(expected, actual, BOUNDS).map_err(|cause| {
        if cause
            .code
            .starts_with("schema_transition_installation_state_")
        {
            cause
        } else {
            let mut error = failure(UNSUPPORTED);
            error.details = serde_json::json!({"cause":cause.code});
            error
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bounded(schema: &str, rows: &str, bounds: Bounds) -> SqliteMutationCoordinatorError {
        let left = Connection::open_in_memory().unwrap();
        let right = Connection::open_in_memory().unwrap();
        for db in [&left, &right] {
            db.execute_batch(schema).unwrap();
            db.execute_batch(rows).unwrap();
            db.busy_timeout(std::time::Duration::ZERO).unwrap();
            db.pragma_update(None, "trusted_schema", false).unwrap();
            db.execute_batch("BEGIN").unwrap();
        }
        let error = compare_with_bounds(&left, &right, bounds).unwrap_err();
        assert!(!left.is_autocommit() && !right.is_autocommit());
        for db in [&left, &right] {
            db.execute_batch("ROLLBACK").unwrap();
        }
        error
    }
    #[test]
    fn schema_object_column_and_total_row_budgets_fail_inside_existing_transactions() {
        for (schema, rows, bounds) in [
            (
                "CREATE TABLE a(v);CREATE TABLE b(v);CREATE TABLE c(v);",
                "",
                Bounds {
                    objects: 2,
                    ..BOUNDS
                },
            ),
            (
                "CREATE TABLE a(first,second);",
                "",
                Bounds {
                    columns: 1,
                    ..BOUNDS
                },
            ),
            (
                "CREATE TABLE a(v);",
                "INSERT INTO a VALUES(NULL),(NULL),(NULL);",
                Bounds { rows: 2, ..BOUNDS },
            ),
        ] {
            assert_eq!(bounded(schema, rows, bounds).code, RESOURCE);
        }
    }
    #[test]
    fn aggregate_limits_count_numeric_and_null_cells_with_framing() {
        assert_eq!(
            bounded(
                "CREATE TABLE a(v);",
                "INSERT INTO a VALUES(NULL),(NULL),(NULL);",
                Bounds { cells: 6, ..BOUNDS }
            )
            .code,
            RESOURCE
        );
        assert_eq!(
            bounded(
                "CREATE TABLE a(v);",
                "INSERT INTO a VALUES(1),(2),(3);",
                Bounds {
                    bytes: 110,
                    ..BOUNDS
                }
            )
            .code,
            RESOURCE
        );
    }
}
