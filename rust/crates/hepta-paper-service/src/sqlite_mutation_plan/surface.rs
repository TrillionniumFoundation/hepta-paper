use super::*;
use rusqlite::Connection;

fn strings(db: &Connection, sql: &str) -> Result<Vec<String>> {
    Ok(db
        .prepare(sql)?
        .query_map([], |row| row.get(0))?
        .collect::<std::result::Result<_, _>>()?)
}
pub(super) fn columns(db: &Connection, table: &str) -> Result<Vec<(String, i64)>> {
    Ok(db
        .prepare(&format!("PRAGMA table_info({})", quoted(table)?))?
        .query_map([], |r| Ok((r.get(1)?, r.get(5)?)))?
        .collect::<std::result::Result<_, _>>()?)
}
struct ForeignKey {
    table: String,
    from: String,
    to: Option<String>,
    update: String,
    delete: String,
    rule: String,
}
fn foreign_keys(db: &Connection, table: &str) -> Result<Vec<ForeignKey>> {
    Ok(db
        .prepare(&format!("PRAGMA foreign_key_list({})", quoted(table)?))?
        .query_map([], |r| {
            Ok(ForeignKey {
                table: r.get(2)?,
                from: r.get(3)?,
                to: r.get(4)?,
                update: r.get(5)?,
                delete: r.get(6)?,
                rule: r.get(7)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?)
}
fn trigger_effects(sql: &str) -> Result<Option<Vec<(String, &'static str)>>> {
    let Some(start) = expression(r"\bBEGIN\b")?.find(sql).map(|m| m.end()) else {
        return Ok(None);
    };
    let body = expression(r"'(?:''|[^'])*'")?
        .replace_all(&sql[start..], "''")
        .into_owned();
    let body = expression(r"--[^\r\n]*")?
        .replace_all(&body, "")
        .into_owned();
    let body = expression(r"/\*(?s:.)*?\*/")?
        .replace_all(&body, "")
        .into_owned();
    let identifier =
        r#"(?:"((?:""|[^"])*)"|`((?:``|[^`])*)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))"#;
    let mut effects = Vec::new();
    for raw in body.split(';') {
        let statement = trim_js(raw);
        if statement.is_empty() || matches(r"^END\b|^SELECT\b", statement)? {
            continue;
        }
        let (prefix, operation) = if matches(r"^INSERT\b", statement)? {
            (
                r"INSERT(?:\s+OR\s+(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK))?\s+INTO",
                "INSERT",
            )
        } else if matches(r"^REPLACE\b", statement)? {
            (r"REPLACE\s+INTO", "INSERT")
        } else if matches(r"^UPDATE\b", statement)? {
            (
                r"UPDATE(?:\s+OR\s+(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK))?",
                "UPDATE",
            )
        } else if matches(r"^DELETE\b", statement)? {
            (r"DELETE\s+FROM", "DELETE")
        } else if matches(r"\b(?:INSERT|REPLACE|UPDATE|DELETE)\b", statement)? {
            return Ok(None);
        } else {
            continue;
        };
        let pattern = expression(&format!(r"^{prefix}\s+(?:main\s*\.\s*)?{identifier}"))?;
        let Some(captures) = pattern.captures(statement) else {
            return Ok(None);
        };
        let table = (1..=4).find_map(|i| {
            captures
                .get(i)
                .map(|v| v.as_str().replace("\"\"", "\"").replace("``", "`"))
        });
        let Some(table) = table.filter(|v| crate::sqlite_changeset::safe_table(v)) else {
            return Ok(None);
        };
        effects.push((table, operation));
    }
    Ok(Some(effects))
}
/// Reject attached/temp state, untracked writes, primary-key omissions, triggers
/// that could impersonate planned effects, and cascading foreign-key changes.
pub fn assert_sqlite_mutation_database_surface_v1(
    db: &Connection,
    plan: &ValidatedMutationPlanV1,
) -> Result<()> {
    let databases = db
        .prepare("PRAGMA database_list")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if databases
        .iter()
        .any(|v| !["main", "temp"].contains(&v.as_str()))
    {
        return Err(error(
            "externally_fenced_sqlite_mutation_attached_database_forbidden",
        ));
    }
    let temp: i64 = db.query_row(
        "SELECT count(*) FROM sqlite_temp_schema WHERE type IN ('table','trigger','view')",
        [],
        |r| r.get(0),
    )?;
    if temp != 0 {
        return Err(error(
            "externally_fenced_sqlite_mutation_temp_schema_forbidden",
        ));
    }
    let tables = strings(db,"SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")?
        .into_iter().filter(|v| !SYSTEM_TABLES.iter().any(|system| system.eq_ignore_ascii_case(v))).collect::<BTreeSet<_>>();
    let events = planned_events(plan)?;
    if events.keys().any(|v| !tables.contains(v)) {
        return Err(error(
            "externally_fenced_sqlite_mutation_planned_table_missing",
        ));
    }
    let triggers = db.prepare("SELECT name,tbl_name,coalesce(sql,'') FROM sqlite_schema WHERE type='trigger' ORDER BY name")?
        .query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?
        .collect::<std::result::Result<Vec<_>,_>>()?;
    for (name, table, sql) in triggers {
        if SYSTEM_TABLES
            .iter()
            .any(|system| system.eq_ignore_ascii_case(&table))
            || !events.contains_key(&table)
        {
            continue;
        }
        if trigger_effects(&sql)?.is_none_or(|effects| {
            effects.iter().any(|(table, op)| {
                events.iter().any(|(planned, events)| {
                    planned.eq_ignore_ascii_case(table) && events.contains(op)
                })
            })
        }) {
            return Err(error(&format!(
                "externally_fenced_sqlite_mutation_business_trigger_forbidden:{name}"
            )));
        }
    }
    for table in events.keys() {
        let cols = columns(db, table)?;
        if !cols.iter().any(|(_, pk)| *pk > 0) {
            return Err(error(&format!(
                "externally_fenced_sqlite_mutation_explicit_primary_key_required:{table}"
            )));
        }
        // SQLite Session silently omits rows with NULL in any primary-key
        // column. Such preexisting rows cannot be safely deleted or updated.
        let predicate = cols
            .iter()
            .filter(|(_, pk)| *pk > 0)
            .map(|(name, _)| format!("{} IS NULL", quote_column(name)))
            .collect::<Vec<_>>()
            .join(" OR ");
        let omitted: bool = db.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM {} WHERE {predicate})",
                quoted(table)?
            ),
            [],
            |r| r.get(0),
        )?;
        if omitted {
            return Err(error(&format!(
                "externally_fenced_sqlite_mutation_null_primary_key_forbidden:{table}"
            )));
        }
        for fk in foreign_keys(db, table)? {
            let target = if tables.contains(&fk.table) {
                columns(db, &fk.table)?
            } else {
                Vec::new()
            };
            if !cols.iter().any(|(name, _)| name == &fk.from)
                || !target
                    .iter()
                    .any(|(name, pk)| Some(name) == fk.to.as_ref() && *pk >= 1)
                || fk.rule != "NONE"
            {
                return Err(error(&format!(
                    "externally_fenced_sqlite_mutation_foreign_key_forbidden:{table}"
                )));
            }
        }
    }
    for table in &tables {
        for fk in foreign_keys(db, table)? {
            if let Some((_, events)) = events
                .iter()
                .find(|(table, _)| table.eq_ignore_ascii_case(&fk.table))
                && ((events.contains("UPDATE")
                    && !["NO ACTION", "RESTRICT"].contains(&fk.update.as_str()))
                    || (events.contains("DELETE")
                        && !["NO ACTION", "RESTRICT"].contains(&fk.delete.as_str())))
            {
                return Err(error(&format!(
                    "externally_fenced_sqlite_mutation_foreign_key_forbidden:{table}"
                )));
            }
        }
    }
    Ok(())
}

pub(super) fn quote_column(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}
