use super::*;
use rusqlite::{Connection, OpenFlags, types::ValueRef};
fn open_private(location: &str, immutable: bool) -> Result<Connection> {
    // SQLite canonicalizes filenames, including /proc descriptor paths. Never
    // use that mechanism to claim a pinned source inode: open only our private
    // copy, and use immutable mode only when no effective WAL is present.
    let location = if immutable {
        let escaped = location
            .bytes()
            .map(|byte| {
                if byte.is_ascii_alphanumeric() || b"/-_.~".contains(&byte) {
                    (byte as char).to_string()
                } else {
                    format!("%{byte:02X}")
                }
            })
            .collect::<String>();
        format!("file:{escaped}?mode=ro&immutable=1")
    } else {
        location.to_owned()
    };
    let database = Connection::open_with_flags(
        location,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|e| error(e.to_string()))?;
    database
        .pragma_update(None, "trusted_schema", false)
        .map_err(|e| error(e.to_string()))?;
    Ok(database)
}
pub(super) fn pending(path: &Path, role: &str, instance: &str) -> Result<Value> {
    let wal = PathBuf::from(format!("{}-wal", path.display()));
    let database = open_private(path.to_str().ok_or_else(files::changed)?, !wal.exists())?;
    let count:i64=database.query_row("SELECT count(*) FROM autonomous_research_online_mutation_authority_marker marker LEFT JOIN autonomous_research_online_mutation_finalization_receipt finalized ON finalized.reservation_id=marker.reservation_id WHERE finalized.reservation_id IS NULL",[],|row|row.get(0))?;
    ensure(
        (0..=9_007_199_254_740_991).contains(&count),
        "autonomous_research_state_pending_finalization_inspection_invalid",
    )?;
    Ok(
        json!({"version":1,"kind":"AutonomousResearchStatePendingFinalizationInspection","databaseRole":role,"databaseInstanceId":instance,"pendingFinalizationCount":count}),
    )
}
pub(super) fn inspect_uri(location: &str, immutable: bool) -> Result<Value> {
    let database = open_private(location, immutable)?;
    let quick = rows(&database, "PRAGMA quick_check;", 100_000)?;
    let foreign = rows(&database, "PRAGMA foreign_key_check;", 100_000)?;
    let schema = rows(
        &database,
        "SELECT type,name,tbl_name,coalesce(sql,'') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name,sql;",
        100_000,
    )?;
    let complete = rows(
        &database,
        "SELECT type,name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name;",
        100_000,
    )?;
    let hidden = complete.iter().any(|row| {
        !schema
            .iter()
            .any(|r| r["type"] == row["type"] && r["name"] == row["name"])
    });
    ensure(
        !hidden,
        "autonomous_research_state_database_hidden_schema_object",
    )?;
    let user: i64 = database
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| error(e.to_string()))?;
    let application: i64 = database
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(|e| error(e.to_string()))?;
    let first = quick.first();
    let quick = first
        .and_then(|v| v.get("quick_check").or_else(|| v.get("integrity_check")))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let objects = schema
        .iter()
        .map(|row| {
            format!(
                "{}:{}",
                row["type"].as_str().unwrap_or_default(),
                row["name"].as_str().unwrap_or_default()
            )
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"quickCheck":quick,"foreignKeyViolationCount":foreign.len(),"schemaHash":hash("AutonomousResearchStateDatabaseSchema",&json!(schema))?,"schemaObjects":objects,"userVersion":user,"applicationId":application}),
    )
}
fn rows(database: &Connection, sql: &str, maximum: usize) -> Result<Vec<Value>> {
    let mut statement = database.prepare(sql).map_err(|e| error(e.to_string()))?;
    let names = statement
        .column_names()
        .iter()
        .map(|s| (*s).to_owned())
        .collect::<Vec<_>>();
    let mut cursor = statement.query([]).map_err(|e| error(e.to_string()))?;
    let mut rows = Vec::new();
    let mut bytes = 0usize;
    while let Some(row) = cursor.next().map_err(|e| error(e.to_string()))? {
        ensure(
            rows.len() < maximum,
            "autonomous_research_state_database_inventory_limit_exceeded",
        )?;
        let mut value = serde_json::Map::new();
        for (index, name) in names.iter().enumerate() {
            let cell =
                match row.get_ref(index).map_err(|e| error(e.to_string()))? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => json!(v),
                    ValueRef::Real(v) => json!(v),
                    ValueRef::Text(v) => {
                        bytes = bytes.checked_add(v.len()).ok_or_else(files::changed)?;
                        ensure(
                            v.len() <= 4 * 1024 * 1024 && bytes <= 64 * 1024 * 1024,
                            "autonomous_research_state_database_inventory_limit_exceeded",
                        )?;
                        json!(std::str::from_utf8(v).map_err(|_| error(
                            "autonomous_research_state_database_utf8_invalid"
                        ))?)
                    }
                    ValueRef::Blob(_) => {
                        return Err(error("autonomous_research_state_database_value_invalid"));
                    }
                };
            value.insert(name.clone(), cell);
        }
        rows.push(Value::Object(value));
    }
    Ok(rows)
}
pub(super) fn candidate(
    root: &files::Directory,
    row: &tree::Candidate,
    budget: &mut files::Budget,
) -> Result<(Value, files::DatabaseObservation)> {
    let source = files::DatabaseObservation::observe(
        root,
        &row.relative,
        text(&row.definition, "role")?,
        budget,
    )?;
    let inspected = snapshot::with_snapshot(&source, |path| {
        inspect_uri(
            path.to_str().ok_or_else(files::changed)?,
            source.wal.is_none() && source.shm.is_none(),
        )
    })?;
    source.assert_current()?;
    let objects = inspected["schemaObjects"]
        .as_array()
        .ok_or_else(files::changed)?;
    let missing = row.definition["requiredSchemaObjects"]
        .as_array()
        .ok_or_else(files::changed)?
        .iter()
        .filter(|v| !objects.contains(v))
        .cloned()
        .collect::<Vec<_>>();
    let role = text(&row.definition, "role")?;
    let id = if let Some(paper) = &row.paper_id {
        format!("{role}:{paper}")
    } else {
        role.to_owned()
    };
    let mut value = json!({"instanceId":id,"role":role,"paperId":row.paper_id,"sourceRelativePath":row.relative,"schemaContractId":row.definition["schemaContractId"],"missingSchemaObjects":missing,"sourceFileIdentity":source.source.metadata,"sourceSha256":source.source.sha256,"walFileIdentity":source.wal.as_ref().map(|f|&f.metadata),"walSha256":source.wal.as_ref().map(|f|&f.sha256)});
    for (k, v) in inspected.as_object().ok_or_else(files::changed)? {
        value[k] = v.clone();
    }
    Ok((value, source))
}
