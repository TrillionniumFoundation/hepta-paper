//! Native JavaScript AST and lexical-scope writer coverage inspection.
mod ast;
mod callback;
mod discovery;
mod inspection;
use crate::sqlite_mutation_coordinator::{Result, error, hash};
pub use discovery::discover_online_writer_mutation_entrypoints_v1;
pub(crate) use inspection::RetainedWriterStaticInputsV1;
pub use inspection::{
    VerifiedWriterStaticCoverageV1, inspect_online_writer_static_coverage_v1,
    verify_online_writer_static_coverage_v1,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
fn config() -> Result<Value> {
    serde_json::from_str(include_str!("online_writer_static/config.json"))
        .map_err(|e| error(e.to_string()))
}
fn js_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    values
}
fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}
fn mutation_sql(text: &str) -> Result<bool> {
    static PATTERN: std::sync::OnceLock<std::result::Result<regex::Regex, String>> =
        std::sync::OnceLock::new();
    let regex=PATTERN.get_or_init(||regex::Regex::new(r"(?i)(?:\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE\s+(?:TABLE|TRIGGER|INDEX|VIEW)|ALTER\s+TABLE|DROP\s+(?:TABLE|TRIGGER|INDEX|VIEW)|VACUUM\s+INTO)\b|\bPRAGMA\s+(?:journal_mode|user_version|application_id)\s*=)").map_err(|e|e.to_string())).as_ref().map_err(error)?;
    Ok(regex.is_match(text))
}
