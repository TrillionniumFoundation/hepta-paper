//! Ordinary numerical status over actual held V1/V2 CPU plugin inputs.
//! A local signed inspection never authorizes activation or external actions.
mod configuration;
mod cpu;
mod descriptor;
mod environment_bom;
mod execution_contract;
mod inputs;
mod qualification;
mod sandbox;
#[cfg(test)]
mod tests;
use crate::{
    native_workspace::current_native_command_workspace_root_v1,
    ordinary_readonly_frontend::OrdinaryReadonlyOutputV1,
    runtime_source_cas::observation::SourceObservation,
};
use hepta_legacy_compatibility::{
    ProductionJsonEncodingLimitsV1, ProductionJsonValue as Json, parse_production_json_v1,
    production_json_pretty_resources_v1, production_json_pretty_with_limits_v1,
    production_json_stringify_with_limits_v1,
};
use inputs::StatusInputs;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
fn check(c: &AtomicBool, d: Instant) -> Result<(), String> {
    if c.load(Ordering::Acquire) {
        Err("advanced_numerical_plugin_cancelled".into())
    } else if Instant::now() >= d {
        Err("advanced_numerical_plugin_deadline_exceeded".into())
    } else {
        Ok(())
    }
}
fn text(s: &str) -> Json {
    Json::String(s.encode_utf16().collect())
}
fn object<const N: usize>(fields: [(&str, Json); N]) -> Json {
    Json::Object(
        fields
            .into_iter()
            .map(|(k, v)| (k.encode_utf16().collect(), v))
            .collect(),
    )
}
fn field<'a>(v: &'a Json, key: &str) -> &'a Json {
    const NULL: Json = Json::Null;
    match v {
        Json::Object(o) => o
            .iter()
            .find(|(k, _)| k.iter().copied().eq(key.encode_utf16()))
            .map_or(&NULL, |(_, v)| v),
        _ => &NULL,
    }
}
fn json_value(v: &Value) -> Result<Json, String> {
    parse_production_json_v1(
        &serde_json::to_vec(v).map_err(|_| "advanced_numerical_plugin_json_invalid")?,
    )
    .map_err(|_| "advanced_numerical_plugin_json_invalid".into())
}
fn value(v: &Json, c: &AtomicBool) -> Result<Value, String> {
    let bytes = production_json_stringify_with_limits_v1(
        v,
        ProductionJsonEncodingLimitsV1 {
            maximum_bytes: 4 * 1024 * 1024,
            maximum_values: 200_000,
            maximum_utf16_units: 4 * 1024 * 1024,
        },
        c,
    )
    .map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes)
        .map_err(|_| "advanced_numerical_plugin_json_data_domain_v1_unaccepted".into())
}
fn exact(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}
fn sha(s: &str) -> bool {
    s.strip_prefix("sha256:").is_some_and(|v| {
        v.len() == 64
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn hash(kind: &str, v: &Json, c: &AtomicBool) -> Result<String, String> {
    let bytes = production_json_stringify_with_limits_v1(
        v,
        ProductionJsonEncodingLimitsV1 {
            maximum_bytes: 4 * 1024 * 1024,
            maximum_values: 200_000,
            maximum_utf16_units: 4 * 1024 * 1024,
        },
        c,
    )
    .map_err(|e| e.to_string())?;
    hepta_legacy_compatibility::parse_and_hash_production_record_v1(kind, &bytes)
        .map(|h| h.as_str().to_owned())
        .map_err(|e| e.to_string())
}
#[derive(Default)]
struct Arguments {
    values: BTreeMap<String, String>,
    flags: BTreeSet<String>,
}
fn parse(args: &[String]) -> Result<Arguments, String> {
    if args.len() > 64
        || args
            .iter()
            .try_fold(0usize, |n, v| n.checked_add(v.len()))
            .is_none_or(|n| n > 32 * 1024)
    {
        return Err("advanced_numerical_plugin_arguments_limit_exceeded".into());
    }
    let mut out = Arguments::default();
    let mut i = 0;
    while i < args.len() {
        let token = &args[i];
        if token == "--" {
            return Err("unexpected_cli_argument_separator".into());
        }
        if !token.starts_with("--") {
            return Err(format!("unexpected_cli_positional:{token}"));
        }
        let (key, inline) = token[2..]
            .split_once('=')
            .map_or((&token[2..], None), |(k, v)| (k, Some(v)));
        if key.is_empty() {
            return Err("empty_cli_option".into());
        }
        let boolean = ["help", "require-runner-ready"].contains(&key);
        if !boolean && !["action", "config", "output-directory", "request"].contains(&key) {
            return Err(format!("unknown_cli_option:--{key}"));
        }
        if boolean {
            if inline.is_some() {
                return Err(format!("boolean_cli_option_does_not_take_value:--{key}"));
            }
            if !out.flags.insert(key.into()) {
                return Err(format!("duplicate_cli_option:--{key}"));
            }
        } else {
            let v = if let Some(v) = inline {
                v
            } else {
                i += 1;
                args.get(i)
                    .map(String::as_str)
                    .filter(|s| !s.starts_with("--"))
                    .ok_or_else(|| format!("missing_cli_option_value:--{key}"))?
            };
            if v.is_empty() {
                return Err(format!("empty_cli_option_value:--{key}"));
            }
            if out.values.contains_key(key) {
                return Err(format!("duplicate_cli_option:--{key}"));
            }
            out.values.insert(key.into(), v.into());
        }
        i += 1;
    }
    Ok(out)
}
pub(crate) fn validate_ordinary_numerical_grammar_v1(args: &[String]) -> Result<(), String> {
    parse(args).map(|_| ())
}
fn usage() -> Json {
    object([
        ("version", Json::Number(1.0)),
        ("kind", text("AdvancedNumericalPluginUsage")),
        (
            "usage",
            text(
                "advanced-numerical-plugin --config PATH [--action status|run] [--request PATH --output-directory PATH]",
            ),
        ),
        (
            "status",
            text(
                "verifies pinned runtime documents, signed evidence, local identity and sandbox availability",
            ),
        ),
        (
            "run",
            text(
                "executes one bounded request; qualified status requires the complete external evidence chain",
            ),
        ),
    ])
}
struct ObservedStatus<'a> {
    report: Json,
    cpu_witness: Option<cpu::RunWitness<'a>>,
    source: StatusInputs<'a>,
    c: &'a AtomicBool,
    d: Instant,
    exit: i32,
    authority: Option<(Value, Value)>,
    qualification: Option<qualification::QualificationInputs>,
}
impl ObservedStatus<'_> {
    fn finish(self) -> Result<OrdinaryReadonlyOutputV1, String> {
        self.finish_inner().map_err(|error| {
            self.cpu_witness
                .as_ref()
                .map_or(error.clone(), |witness| witness.error_context(error))
        })
    }
    fn finish_inner(&self) -> Result<OrdinaryReadonlyOutputV1, String> {
        check(self.c, self.d)?;
        let limits = ProductionJsonEncodingLimitsV1 {
            maximum_bytes: 4 * 1024 * 1024,
            ..ProductionJsonEncodingLimitsV1::default()
        };
        let res = production_json_pretty_resources_v1(&self.report, limits, self.c)
            .map_err(|e| e.to_string())?;
        if res.bytes >= limits.maximum_bytes {
            return Err("advanced_numerical_plugin_output_limit_exceeded".into());
        }
        let mut bytes = production_json_pretty_with_limits_v1(&self.report, limits, self.c)
            .map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        if let Some(witness) = &self.cpu_witness {
            witness.assert_current()?;
        }
        self.source.assert_current()?;
        if let Some((authority, trust)) = &self.authority {
            crate::runtime_image_reproducibility::numerical_plugin_signatures_v1(
                authority, trust, self.c, self.d,
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(qualification) = &self.qualification {
            qualification.inspect(self.c, self.d)?;
        }
        if let Some(witness) = &self.cpu_witness {
            witness.assert_current()?;
        }
        self.source.assert_current()?;
        check(self.c, self.d)?;
        Ok(OrdinaryReadonlyOutputV1 {
            stdout: bytes,
            stderr: vec![],
            exit_code: self.exit,
        })
    }
}
fn blocked(path: Option<&Path>, error: &configuration::Failure) -> Json {
    let code = &error.code;
    let blocker = if code == "advanced_numerical_plugin_document_missing" {
        if error.path.as_deref() == path {
            "advanced_numerical_plugin_runtime_configuration_missing"
        } else {
            "advanced_numerical_plugin_runtime_dependency_missing"
        }
    } else {
        code
    };
    object([
        ("version", Json::Number(1.0)),
        ("kind", text("AdvancedNumericalPluginRuntimeInspection")),
        ("status", text("advanced_numerical_plugin_runner_blocked")),
        ("productionQualified", Json::Bool(false)),
        ("blockers", Json::Array(vec![text(blocker)])),
        (
            "configurationPath",
            path.map_or(Json::Null, |p| text(&p.to_string_lossy())),
        ),
        ("errorCode", text(code)),
    ])
}
/// Inspect the actual normal V1 configuration, signature, files and sandbox.
/// Writer, qualification V2 and GPU domains remain explicit v1 refusals.
pub fn run_ordinary_advanced_numerical_plugin_status_v1(
    args: &[String],
    c: &AtomicBool,
    d: Instant,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    check(c, d)?;
    let a = parse(args)?;
    if a.flags.contains("help") {
        let mut stdout = production_json_pretty_with_limits_v1(
            &usage(),
            ProductionJsonEncodingLimitsV1::default(),
            c,
        )
        .map_err(|e| e.to_string())?;
        stdout.push(b'\n');
        check(c, d)?;
        return Ok(OrdinaryReadonlyOutputV1 {
            stdout,
            stderr: vec![],
            exit_code: 0,
        });
    }
    let action = a.values.get("action").map_or("status", String::as_str);
    if !["status", "run"].contains(&action) {
        return Err(format!("advanced_numerical_plugin_action_invalid:{action}"));
    }
    let root = current_native_command_workspace_root_v1(None)?;
    let raw = a.values.get("config").map_or("", String::as_str);
    let raw = crate::automation_runtime_reconciliation::sqlite_number::trim(raw);
    let path = if raw.is_empty() {
        None
    } else {
        Some(configuration::resolve(&root, raw)?)
    };
    let mut source = StatusInputs::new(c, d)?;
    let observed = match path.as_deref() {
        None => Err(configuration::Failure::new(
            "advanced_numerical_plugin_configuration_path_required",
        )),
        Some(p) => configuration::inspect(&mut source, p, c, d),
    };
    if action == "run" {
        let prepared = observed.map_err(|e| e.code)?;
        let (report, exit, cpu_witness) = cpu::run(&a, &prepared, &mut source, &root, c, d)?;
        return ObservedStatus {
            report,
            cpu_witness,
            source,
            c,
            d,
            exit,
            authority: Some((prepared.authority, prepared.trust)),
            qualification: prepared.qualification,
        }
        .finish();
    }
    let (report, exit, authority, qualification) = match observed {
        Ok(v) => {
            let exit = if a.flags.contains("require-runner-ready")
                && !matches!(field(&v.report, "status"), Json::String(v) if v.iter().copied().eq("advanced_numerical_plugin_runner_ready_qualified".encode_utf16()))
            {
                1
            } else {
                0
            };
            (
                v.report,
                exit,
                Some((v.authority, v.trust)),
                v.qualification,
            )
        }
        Err(e) => {
            check(c, d)?;
            (blocked(path.as_deref(), &e), 1, None, None)
        }
    };
    ObservedStatus {
        report,
        cpu_witness: None,
        source,
        c,
        d,
        exit,
        authority,
        qualification,
    }
    .finish()
}
