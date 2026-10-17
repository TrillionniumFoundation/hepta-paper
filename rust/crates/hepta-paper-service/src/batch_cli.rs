//! Ordinary operator batch option normalization, before any inventory or queue IO.
//! This uses the incumbent closed grammar and existing native Number/path owners.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeBatchCliOptionsV1 {
    pub root: String,
    pub runtime_root: String,
    pub mode: String,
    pub limit: Option<u64>,
    pub paper_ids: Vec<String>,
    pub include_retired: bool,
    pub include_quarantined: bool,
    pub inventory_source: String,
    pub execute: bool,
    pub write_report: bool,
    pub max_rounds: u64,
    pub target_override: Option<String>,
    pub dataset_root: Option<String>,
    pub benchmark_id: Option<String>,
    pub dataset_license_id: Option<String>,
    pub dataset_authorization_hash: Option<String>,
    pub dataset_harness_envelope: Option<String>,
    pub apply_manuscript: bool,
    pub quality_profile: Option<String>,
    pub languages: Vec<String>,
}
const BOOLEANS: &[&str] = &[
    "json",
    "help",
    "write-report",
    "execute",
    "include-retired",
    "include-quarantined",
    "materialize-source",
    "stage-inventory",
    "apply-manuscript",
];
const VALUES: &[&str] = &[
    "root",
    "runtime-root",
    "mode",
    "limit",
    "inventory-source",
    "max-rounds",
    "target",
    "venue",
    "dataset-root",
    "dataset",
    "benchmark-id",
    "benchmark",
    "dataset-license",
    "dataset-authorization",
    "dataset-harness",
    "quality-profile",
    "languages",
    "idea",
    "discipline",
    "title",
    "paper-type",
    "risk-preference",
    "scientific-claim-document",
    "approval-document",
];
const REPEATABLE: &[&str] = &["paper", "material", "constraint"];
fn batch_positive_integer(
    value: Option<&String>,
    key: &'static str,
) -> Result<Option<u64>, String> {
    value
        .map(|v| {
            let number = crate::automation_runtime_reconciliation::sqlite_number::string_number(v)
                .ok_or_else(|| format!("invalid_positive_integer:{key}"))?;
            if !number.is_finite()
                || number.fract() != 0.0
                || !(1.0..=9_007_199_254_740_991.0).contains(&number)
            {
                return Err(format!("invalid_positive_integer:{key}"));
            }
            Ok(number as u64)
        })
        .transpose()
}
#[derive(Debug)]
pub struct NativeBatchCliControlV1 {
    pub json: bool,
    pub help: bool,
}
struct ParsedBatchArguments {
    values: BTreeMap<String, String>,
    flags: BTreeSet<String>,
    repeated: BTreeMap<String, Vec<String>>,
}
fn parse_batch_arguments(argv: &[String]) -> Result<ParsedBatchArguments, String> {
    if argv.len() > 256
        || argv.iter().any(|v| v.len() > 64 * 1024 || v.contains('\0'))
        || argv.iter().map(String::len).sum::<usize>() > 1024 * 1024
    {
        return Err("native_batch_cli_input_budget_v1".into());
    }
    let mut values = BTreeMap::<String, String>::new();
    let mut flags = BTreeSet::<String>::new();
    let mut repeated = BTreeMap::<String, Vec<String>>::new();
    let mut index = 0;
    while index < argv.len() {
        let token = &argv[index];
        if token == "--" {
            return Err("unexpected_cli_argument_separator".into());
        }
        let raw = token
            .strip_prefix("--")
            .ok_or("too_many_cli_positionals:2")?;
        let (key, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(k, v)| (k, Some(v)));
        if key.is_empty() {
            return Err("empty_cli_option".into());
        }
        if key == "legacy-workflow-projection" {
            return Err("legacy_workflow_projection_removed_use_compat_script".into());
        }
        if key == "approved" {
            return Err("proposal_boolean_approval_removed_use_approval_document".into());
        }
        if BOOLEANS.contains(&key) {
            if inline.is_some() {
                return Err(format!("boolean_cli_option_does_not_take_value:--{key}"));
            }
            if !flags.insert(key.into()) {
                return Err(format!("duplicate_cli_option:--{key}"));
            }
        } else {
            if !VALUES.contains(&key) && !REPEATABLE.contains(&key) {
                return Err(format!("unknown_cli_option:--{key}"));
            }
            let value = match inline {
                Some(v) => v,
                None => {
                    index += 1;
                    argv.get(index)
                        .filter(|v| !v.starts_with("--"))
                        .map(String::as_str)
                        .ok_or_else(|| format!("missing_cli_option_value:--{key}"))?
                }
            };
            if value.is_empty() {
                return Err(format!("empty_cli_option_value:--{key}"));
            }
            if REPEATABLE.contains(&key) {
                repeated.entry(key.into()).or_default().push(value.into());
            } else if values.insert(key.into(), value.into()).is_some() {
                return Err(format!("duplicate_cli_option:--{key}"));
            }
        }
        index += 1;
    }
    Ok(ParsedBatchArguments {
        values,
        flags,
        repeated,
    })
}
/// Same closed syntax owner as normalization. Help runs after syntax validation
/// and before numeric/domain/path admission, just as the ordinary Node CLI.
pub fn native_batch_cli_control_v1(argv: &[String]) -> Result<NativeBatchCliControlV1, String> {
    let parsed = parse_batch_arguments(argv)?;
    Ok(NativeBatchCliControlV1 {
        json: parsed.flags.contains("json"),
        help: parsed.flags.contains("help"),
    })
}

/// `argv` is the forwarded operator batch argv after its fixed `batch-run`
/// command. The incumbent already consumes the sole allowed positional with
/// that fixed command. Native resource bounds are a separate finite v1 domain.
/// This function performs no filesystem access and grants no execution authority.
pub fn normalize_native_batch_cli_arguments_v1(
    argv: &[String],
    cwd: &str,
    default_root: &str,
    default_runtime_root: &str,
) -> Result<NativeBatchCliOptionsV1, String> {
    if !cwd.starts_with('/')
        || !default_root.starts_with('/')
        || !default_runtime_root.starts_with('/')
        || [cwd, default_root, default_runtime_root]
            .iter()
            .any(|v| v.len() > 64 * 1024 || v.contains('\0'))
        || argv.len() > 256
        || argv.iter().any(|v| v.len() > 64 * 1024 || v.contains('\0'))
        || argv.iter().map(|v| v.len()).sum::<usize>() > 1024 * 1024
    {
        return Err("native_batch_cli_input_budget_v1".into());
    }
    let ParsedBatchArguments {
        values,
        flags,
        mut repeated,
    } = parse_batch_arguments(argv)?;
    let limit = batch_positive_integer(values.get("limit"), "limit")?;
    let max_rounds = batch_positive_integer(values.get("max-rounds"), "max-rounds")?.unwrap_or(6);
    let authorization = values
        .get("dataset-authorization")
        .map(|v| {
            let digits = v.strip_prefix("sha256:").or_else(|| {
                v.get(..7)
                    .filter(|p| p.eq_ignore_ascii_case("sha256:"))
                    .and_then(|_| v.get(7..))
            });
            if !digits.is_some_and(|d| d.len() == 64 && d.bytes().all(|b| b.is_ascii_hexdigit())) {
                return Err("invalid_sha256:dataset-authorization".to_owned());
            }
            Ok(v.clone())
        })
        .transpose()?;
    let optional = |a: &str, b: Option<&str>| {
        values
            .get(a)
            .or_else(|| b.and_then(|b| values.get(b)))
            .cloned()
    };
    Ok(NativeBatchCliOptionsV1 {
        root: values.get("root").map_or_else(
            || default_root.into(),
            |v| crate::workspace_status::resolve(cwd, v),
        ),
        runtime_root: values.get("runtime-root").map_or_else(
            || default_runtime_root.into(),
            |v| crate::workspace_status::resolve(cwd, v),
        ),
        mode: values
            .get("mode")
            .cloned()
            .unwrap_or_else(|| "inventory".into()),
        limit,
        paper_ids: repeated.remove("paper").unwrap_or_default(),
        include_retired: flags.contains("include-retired"),
        include_quarantined: flags.contains("include-quarantined"),
        inventory_source: values
            .get("inventory-source")
            .cloned()
            .unwrap_or_else(|| "auto".into()),
        execute: flags.contains("execute"),
        write_report: flags.contains("write-report"),
        max_rounds,
        target_override: optional("target", Some("venue")),
        dataset_root: optional("dataset-root", Some("dataset")),
        benchmark_id: optional("benchmark-id", Some("benchmark")),
        dataset_license_id: optional("dataset-license", None),
        dataset_authorization_hash: authorization,
        dataset_harness_envelope: values
            .get("dataset-harness")
            .map(|v| crate::workspace_status::resolve(cwd, v)),
        apply_manuscript: flags.contains("apply-manuscript"),
        quality_profile: optional("quality-profile", None),
        languages: values
            .get("languages")
            .map(String::as_str)
            .unwrap_or("python,latex")
            .split(',')
            .map(crate::automation_runtime_reconciliation::sqlite_number::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
            .collect(),
    })
}
#[cfg(test)]
mod tests;
