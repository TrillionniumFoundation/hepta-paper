//! Fixed statement plans and a revocable SQLite mutation surface.
//!
//! This layer never commits, reserves external authority, or issues a permit.
//! The coordinator owns transaction lifetime and authenticated fencing.
mod surface;
mod transaction;

use hepta_legacy_compatibility::{ProductionCollationV1, production_hash_record_v1};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{LazyLock, Mutex},
};

pub use surface::assert_sqlite_mutation_database_surface_v1;
pub use transaction::{RestrictedMutationTransactionV1, with_restricted_sqlite_mutation_v1};
pub(crate) const SYSTEM_TABLES: [&str; 3] = [
    "autonomous_research_online_mutation_authority_metadata",
    "autonomous_research_online_mutation_authority_marker",
    "autonomous_research_online_mutation_finalization_receipt",
];
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct SqliteMutationPlanError(pub String);
pub type Result<T> = std::result::Result<T, SqliteMutationPlanError>;
fn error(code: &str) -> SqliteMutationPlanError {
    SqliteMutationPlanError(code.to_owned())
}
impl From<rusqlite::Error> for SqliteMutationPlanError {
    fn from(value: rusqlite::Error) -> Self {
        Self(format!(
            "externally_fenced_sqlite_mutation_sqlite_error:{value}"
        ))
    }
}

#[derive(Clone, Debug)]
struct Statement {
    id: String,
    raw_id: Value,
    mode: String,
    sql: String,
    table: Option<String>,
}
impl Statement {
    fn value(&self) -> Value {
        json!({"statementId":self.raw_id,"mode":self.mode,"sql":self.sql,"writeTable":self.table})
    }
}
/// Construction always validates the entire fixed plan. Fields are private.
#[derive(Clone, Debug)]
pub struct ValidatedMutationPlanV1 {
    id: String,
    raw_id: Value,
    statements: Vec<Statement>,
}
impl ValidatedMutationPlanV1 {
    pub fn operation_id(&self) -> &str {
        &self.id
    }
    pub fn projection(&self) -> Value {
        json!({"version":1,"operationId":self.raw_id,"statements":self.statements.iter().map(Statement::value).collect::<Vec<_>>()})
    }
    /// Historical replay can authenticate plan membership and the signed
    /// effects. It cannot reconstruct which callback statements were invoked.
    /// Reuse the exact live guard's plan projection rather than another parser.
    pub(crate) fn allowed_replay_effects(
        &self,
    ) -> Result<Vec<crate::sqlite_changeset::ChangesetEffectV1>> {
        Ok(planned_events(self)?
            .into_iter()
            .flat_map(|(table, events)| {
                events.into_iter().map(move |operation| {
                    crate::sqlite_changeset::ChangesetEffectV1 {
                        table: table.clone(),
                        operation: operation.into(),
                    }
                })
            })
            .collect())
    }
}
#[derive(Debug)]
pub struct ValidatedPlanRegistryV1 {
    plans: BTreeMap<String, ValidatedMutationPlanV1>,
    manifest_hash: String,
}
impl ValidatedPlanRegistryV1 {
    pub fn get(&self, operation_id: &str) -> Option<&ValidatedMutationPlanV1> {
        self.plans.get(operation_id)
    }
    pub fn manifest_hash(&self) -> &str {
        &self.manifest_hash
    }
}
fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|map| map.len() == keys.len() && keys.iter().all(|key| map.contains_key(*key)))
}
fn safe_id(value: &str) -> bool {
    (2..=192).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
// The legacy plan predicate tests String(value || '') but preserves the original
// JSON value in the signed projection. Registry identity remains strictly string.
fn predicate_id(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(v) => v.clone(),
        Value::Bool(true) => "true".into(),
        Value::Number(v) => {
            let n = v.as_f64()?;
            if n == 0.0 {
                return None;
            }
            if n.fract() == 0.0 && n.abs() < 1e21 {
                format!("{n:.0}")
            } else {
                v.to_string()
            }
        }
        // A SAFE_ID cannot contain the comma from a multi-element array.
        Value::Array(v) if v.len() == 1 => predicate_id(&v[0])?,
        _ => return None,
    };
    safe_id(&text).then_some(text)
}
fn same_primitive_id(left: &Value, right: &Value) -> bool {
    !left.is_array() && !left.is_object() && left == right
}
// JavaScript's non-Unicode /i case folding and \s set, including BOM and
// excluding U+0085. SQL keyword boundaries must remain ASCII word boundaries.
// All callers use module-owned literal patterns; SQL remains input only. Cache
// compilation rather than recompiling these predicates for every statement and
// writer hash. Matching runs on a cheap clone after releasing the cache lock.
static PATTERNS: LazyLock<Mutex<BTreeMap<&'static str, Regex>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));
fn cached_expression(pattern: &'static str) -> Result<Regex> {
    let mut patterns = PATTERNS
        .lock()
        .map_err(|_| error("externally_fenced_sqlite_mutation_pattern_invalid"))?;
    if let Some(expression) = patterns.get(pattern) {
        return Ok(expression.clone());
    }
    let expression = expression(pattern)?;
    // Keep a fixed bound even if future source adds more literal predicates.
    if patterns.len() < 16 {
        patterns.insert(pattern, expression.clone());
    }
    Ok(expression)
}
fn expression(pattern: &str) -> Result<Regex> {
    let whitespace = r"(?u:[\x09-\x0d\x20\u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}])";
    // Only ASCII literal letters are folded. Keep UTF-8-aware wildcard and
    // negated classes, which may contain arbitrary valid SQL text.
    let chars: Vec<char> = pattern.chars().collect();
    let mut converted = String::new();
    let mut index = 0;
    let mut in_class = false;
    while index < chars.len() {
        let c = chars[index];
        if c == '\\' && index + 1 < chars.len() {
            let next = chars[index + 1];
            if next == 's' {
                converted.push_str(whitespace);
            } else if next == 'b' {
                converted.push_str(r"(?-u:\b)");
            } else {
                converted.push(c);
                converted.push(next);
            }
            index += 2;
            continue;
        }
        if c == '[' {
            in_class = true;
        }
        if c == ']' {
            in_class = false;
        }
        if !in_class
            && c.is_ascii_alphabetic()
            && !(index > 0 && chars[index - 1] == '?' && chars.get(index + 1) == Some(&':'))
        {
            converted.push('[');
            converted.push(c.to_ascii_lowercase());
            converted.push(c.to_ascii_uppercase());
            converted.push(']');
        } else {
            converted.push(c);
        }
        index += 1;
    }
    Regex::new(&converted).map_err(|_| error("externally_fenced_sqlite_mutation_pattern_invalid"))
}
fn matches(pattern: &'static str, input: &str) -> Result<bool> {
    Ok(cached_expression(pattern)?.is_match(input))
}
fn trim_js(value: &str) -> &str {
    value.trim_matches(|c| matches!(c, '\u{9}'..='\u{d}' | '\u{20}' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
fn write_table(sql: &str) -> Result<Option<String>> {
    for pattern in [
        r"^INSERT\s+(?:OR\s+(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK)\s+)?INTO\s+([A-Za-z_][A-Za-z0-9_]*)\b",
        r"^REPLACE\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\b",
        r"^UPDATE\s+([A-Za-z_][A-Za-z0-9_]*)\s+SET\b",
        r"^DELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)\b",
    ] {
        if let Some(captures) = cached_expression(pattern)?.captures(trim_js(sql)) {
            return captures
                .get(1)
                .map(|v| Some(v.as_str().to_owned()))
                .ok_or_else(|| error("externally_fenced_sqlite_mutation_pattern_invalid"));
        }
    }
    Ok(None)
}
fn statement(value: &Value) -> Result<Statement> {
    let invalid = || error("externally_fenced_sqlite_mutation_statement_plan_invalid");
    if !exact(value, &["statementId", "mode", "sql"]) {
        return Err(invalid());
    }
    let id = predicate_id(&value["statementId"]).ok_or_else(invalid)?;
    let mode = value["mode"]
        .as_str()
        .filter(|v| ["get", "all", "run"].contains(v))
        .ok_or_else(invalid)?;
    let sql = value["sql"]
        .as_str()
        .filter(|v| !v.is_empty() && v.encode_utf16().count() <= 64 * 1024)
        .ok_or_else(invalid)?;
    if matches(
        r"(?:;|--|/\*|\*/|\b(?:ATTACH|DETACH|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|CREATE|ALTER|DROP|VACUUM|REINDEX|ANALYZE)\b|^\s*END\b)",
        sql,
    )? {
        return Err(invalid());
    }
    let table = write_table(sql)?;
    if (mode == "run") != table.is_some()
        || (mode != "run" && !matches(r"^\s*SELECT\b", sql)?)
        || table.as_ref().is_some_and(|t| {
            SYSTEM_TABLES
                .iter()
                .any(|system| system.eq_ignore_ascii_case(t))
                || !crate::sqlite_changeset::safe_table(t)
        })
    {
        return Err(invalid());
    }
    Ok(Statement {
        id,
        raw_id: value["statementId"].clone(),
        mode: mode.into(),
        sql: sql.into(),
        table,
    })
}
/// Validate the canonical Node plan, including sorted unique statement IDs.
pub fn validate_sqlite_mutation_operation_v1(value: &Value) -> Result<ValidatedMutationPlanV1> {
    let invalid = || error("externally_fenced_sqlite_mutation_operation_plan_invalid");
    if !exact(value, &["version", "operationId", "statements"])
        || value["version"].as_f64() != Some(1.0)
    {
        return Err(invalid());
    }
    let id = predicate_id(&value["operationId"]).ok_or_else(invalid)?;
    let input = value["statements"]
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(invalid)?;
    let statements = input.iter().map(statement).collect::<Result<Vec<_>>>()?;
    if statements.windows(2).any(|w| w[0].id > w[1].id)
        || statements.iter().enumerate().any(|(i, s)| {
            statements[..i]
                .iter()
                .any(|p| same_primitive_id(&s.raw_id, &p.raw_id))
        })
        || statements.iter().all(|v| v.mode != "run")
    {
        return Err(invalid());
    }
    Ok(ValidatedMutationPlanV1 {
        id,
        raw_id: value["operationId"].clone(),
        statements,
    })
}
/// Deterministic writer implementation digest over canonical fixed plans.
pub fn externally_fenced_sqlite_writer_plan_hash_v1(
    writer_id: &str,
    input: &[Value],
) -> Result<String> {
    if !safe_id(writer_id) || input.is_empty() {
        return Err(error(
            "externally_fenced_sqlite_mutation_writer_plan_invalid",
        ));
    }
    let mut plans = input
        .iter()
        .map(validate_sqlite_mutation_operation_v1)
        .collect::<Result<Vec<_>>>()?;
    let collation = ProductionCollationV1::load()
        .map_err(|_| error("externally_fenced_sqlite_mutation_collation_invalid"))?;
    plans.sort_by(|a, b| collation.compare(&a.id, &b.id));
    if plans.iter().map(|v| &v.id).collect::<BTreeSet<_>>().len() != plans.len() {
        return Err(error(
            "externally_fenced_sqlite_mutation_writer_plan_invalid",
        ));
    }
    hash(
        "ExternallyFencedSqliteWriterPlan",
        &json!({"version":1,"writerId":writer_id,"operationPlans":plans.iter().map(ValidatedMutationPlanV1::projection).collect::<Vec<_>>()}),
    )
}
fn hash(kind: &str, value: &Value) -> Result<String> {
    production_hash_record_v1(kind, value)
        .map(|h| h.as_str().to_owned())
        .map_err(|_| error("externally_fenced_sqlite_mutation_hash_invalid"))
}
/// Validate plans against a writer manifest. The coordinator must independently
/// validate/authenticate the complete manifest before accepting external trust.
pub fn validate_sqlite_mutation_plans_v1(
    manifest: &Value,
    input: &Value,
) -> Result<ValidatedPlanRegistryV1> {
    let plans = input
        .as_object()
        .ok_or_else(|| error("externally_fenced_sqlite_mutation_operation_plans_incomplete"))?;
    let ops = manifest["operations"]
        .as_array()
        .ok_or_else(|| error("externally_fenced_sqlite_mutation_operation_plans_incomplete"))?;
    let supplied: BTreeSet<&str> = plans.keys().map(String::as_str).collect();
    let integrated: Vec<&str> = ops
        .iter()
        .filter(|o| o["coordinatorIntegrated"] == true)
        .map(|o| {
            o["operationId"].as_str().ok_or_else(|| {
                error("externally_fenced_sqlite_mutation_operation_plans_incomplete")
            })
        })
        .collect::<Result<_>>()?;
    if integrated.len() != supplied.len()
        || integrated.iter().copied().collect::<BTreeSet<_>>() != supplied
    {
        return Err(error(
            "externally_fenced_sqlite_mutation_operation_plans_incomplete",
        ));
    }
    let mut checked = BTreeMap::new();
    for (id, value) in plans {
        let plan = validate_sqlite_mutation_operation_v1(value)?;
        if plan.raw_id.as_str() != Some(id.as_str()) {
            return Err(error(
                "externally_fenced_sqlite_mutation_operation_plan_identity_mismatch",
            ));
        }
        checked.insert(id.clone(), plan);
    }
    let writers = manifest["writers"]
        .as_array()
        .ok_or_else(|| error("externally_fenced_sqlite_mutation_writer_plan_hash_mismatch"))?;
    for writer in writers {
        let invalid = || error("externally_fenced_sqlite_mutation_writer_plan_hash_mismatch");
        let ids = writer["operationIds"].as_array().ok_or_else(invalid)?;
        let entries = ids
            .iter()
            .map(|id| {
                id.as_str()
                    .and_then(|id| plans.get(id))
                    .cloned()
                    .ok_or_else(invalid)
            })
            .collect::<Result<Vec<_>>>()?;
        let writer_id = writer["writerId"].as_str().ok_or_else(invalid)?;
        if writer["implementationHash"]
            != externally_fenced_sqlite_writer_plan_hash_v1(writer_id, &entries)?
        {
            return Err(invalid());
        }
    }
    Ok(ValidatedPlanRegistryV1 {
        plans: checked,
        manifest_hash: crate::sqlite_mutation_coordinator::manifest::writer_manifest_hash_v1(
            manifest,
        )
        .map_err(|e| error(&e.to_string()))?,
    })
}
fn write_events(statement: &Statement) -> Result<BTreeSet<&'static str>> {
    let sql = trim_js(&statement.sql);
    let values = if matches(r"^REPLACE\s+INTO\b|^INSERT\s+OR\s+REPLACE\s+INTO\b", sql)? {
        vec!["DELETE", "INSERT", "UPDATE"]
    } else if matches(
        r"^INSERT\s+(?:OR\s+(?:ABORT|FAIL|IGNORE|ROLLBACK)\s+)?INTO\b",
        sql,
    )? {
        if matches(r"\bON\s+CONFLICT\b(?s:.)*\bDO\s+UPDATE\b", sql)? {
            vec!["INSERT", "UPDATE"]
        } else {
            vec!["INSERT"]
        }
    } else if matches(r"^UPDATE\s+", sql)? {
        vec!["UPDATE"]
    } else if matches(r"^DELETE\s+FROM\b", sql)? {
        vec!["DELETE"]
    } else {
        vec!["DELETE", "INSERT", "UPDATE"]
    };
    Ok(values.into_iter().collect())
}
fn planned_events(
    plan: &ValidatedMutationPlanV1,
) -> Result<BTreeMap<String, BTreeSet<&'static str>>> {
    let mut events: BTreeMap<String, BTreeSet<&'static str>> = BTreeMap::new();
    for statement in &plan.statements {
        if let Some(table) = &statement.table {
            events
                .entry(table.clone())
                .or_default()
                .extend(write_events(statement)?);
        }
    }
    Ok(events)
}
fn quoted(value: &str) -> Result<String> {
    if !crate::sqlite_changeset::safe_table(value) {
        return Err(error("externally_fenced_sqlite_mutation_table_invalid"));
    }
    Ok(format!("\"{value}\""))
}
