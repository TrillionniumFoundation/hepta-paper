//! Original unsigned template mode; this path never selects a signer or loads
//! an activation/template reference. Legacy standalone preflight stays separate.
use super::{AutonomousEmpiricalPluginReleaseOptions, lex_arguments, safe_id, safe_version};
use crate::{
    automation_runtime_reconciliation::sqlite_number::trim,
    native_workspace::current_native_command_workspace_root_v1,
    ordinary_readonly_frontend::OrdinaryReadonlyOutputV1,
};
use hepta_legacy_compatibility::{
    ProductionJsonEncodingLimitsV1, ProductionJsonValue as Json, parse_production_json_v1,
    production_json_pretty_resources_v1, production_json_pretty_with_limits_v1,
};
use std::{
    collections::BTreeSet,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

const INPUTS: &str = include_str!("../runtime_image_reproducibility/plugin-inputs.v1.json");
const SCALAR: &str = r#"{"version":1,"kind":"AutonomousEmpiricalFamilyPluginProfile","profileId":"registered-scalar-response-v1","benchmarkFamily":"registered_scalar_response_benchmark","executionProfile":{"label":"python","language":"python","requiresGpu":false},"executionAdapterId":"repository-system-benchmark-harness-v1","fixtureEvaluatorId":"operator-authorized-registered-scalar-response-fixture-v1","responseField":"response","inferenceMode":"seed-repetition-cell","primaryMetric":"mean_score","secondaryMetric":"robustness_gap","requiredMetrics":["mean_score","standard_error","constraint_violation_rate","robustness_gap"],"metricSpecs":{"mean_score":{"unit":"negative-squared-error","direction":"maximize","minimum":-4000000000000,"maximum":0},"standard_error":{"unit":"negative-squared-error","direction":"minimize","minimum":0,"maximum":4000000000000},"constraint_violation_rate":{"unit":"ratio","direction":"minimize","minimum":0,"maximum":1},"robustness_gap":{"unit":"negative-squared-error","direction":"maximize","minimum":-4000000000000,"maximum":4000000000000}},"seedSchedule":[17,23,31,43,59],"minimumRepetitions":7,"typedOracleKinds":[]}"#;
const USAGE: &str = "Usage: autonomous-empirical-plugin-release --action template|plan|publish|inspect [options]\n\n  template                         Emit a canonical unsigned advanced-oracle template.\n  plan                             Validate template and configured external signer.\n  publish                          Generate, externally sign, verify, and atomically install.\n  inspect                          Reverify an installed activation without signing.\n\n  --template PATH                  Immutable release template; omit to use generated template.\n  --package-id ID                  Generated-template package identity.\n  --package-version SEMVER         Generated-template package version.\n  --benchmark-family FAMILY        Repeat for generated-template family selection.\n  --signing-config PATH            External-command Ed25519 authority configuration.\n  --install-root PATH              Content-addressed release installation root.\n  --activation PATH                Installed activation.json for inspect.\n\nThe signing command receives a canonical payload on stdin. Hepta never loads private-key\nmaterial; publication succeeds only after verification against the configured public trust store.";

fn check(cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err("autonomous_empirical_plugin_release_cancelled".into());
    }
    if Instant::now() >= deadline {
        return Err("autonomous_empirical_plugin_release_deadline_exceeded".into());
    }
    Ok(())
}
fn invalid() -> String {
    "autonomous_empirical_plugin_release_builtin_template_invalid".into()
}
fn text(value: &str) -> Json {
    Json::String(value.encode_utf16().collect())
}
fn field<'a>(value: &'a Json, name: &str) -> Result<&'a Json, String> {
    let Json::Object(fields) = value else {
        return Err(invalid());
    };
    let key: Vec<u16> = name.encode_utf16().collect();
    fields
        .iter()
        .find_map(|(k, v)| (*k == key).then_some(v))
        .ok_or_else(invalid)
}
fn family(profile: &Json, expected: &str) -> bool {
    matches!(field(profile, "benchmarkFamily"), Ok(Json::String(v)) if *v==expected.encode_utf16().collect::<Vec<_>>())
}
fn generated_template(
    options: &AutonomousEmpiricalPluginReleaseOptions,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Json, String> {
    check(cancelled, deadline)?;
    let input = parse_production_json_v1(INPUTS.as_bytes()).map_err(|_| invalid())?;
    let Json::Array(builtins) = field(&input, "profiles")? else {
        return Err(invalid());
    };
    let oracle_types = field(&input, "oracleTypes")?;
    let scalar = parse_production_json_v1(SCALAR.as_bytes()).map_err(|_| invalid())?;
    let families: Vec<&str> = if options.benchmark_families.is_empty() {
        vec!["ml_algorithm_benchmark"]
    } else {
        options.benchmark_families.iter().map(|v| trim(v)).collect()
    };
    // Only six fixed source profiles can be selected. Reject duplicates and
    // unknown inputs before allocating any profile copies.
    if families.len() > 6
        || families.iter().collect::<BTreeSet<_>>().len() != families.len()
        || families.iter().any(|f| {
            !builtins
                .iter()
                .chain(std::iter::once(&scalar))
                .any(|p| family(p, f))
        })
    {
        return Err("autonomous_empirical_plugin_release_template_family_invalid".into());
    }
    let package_id = trim(
        options
            .package_id
            .as_deref()
            .unwrap_or("hepta.advanced-numerical-empirical-families"),
    );
    let package_version = trim(options.package_version.as_deref().unwrap_or("1.0.0"));
    // The original composition compiles its plan before returning the template.
    // These are the plan's package identity constraints; fixed raw profiles and
    // all oracle kinds are pinned compile-time source data, never authority.
    if !safe_id(package_id) || !safe_version(package_version) {
        return Err("autonomous_empirical_family_plugin_package_invalid".into());
    }
    let mut selected = Vec::with_capacity(families.len());
    for name in families {
        check(cancelled, deadline)?;
        let mut profile = builtins
            .iter()
            .chain(std::iter::once(&scalar))
            .find(|v| family(v, name))
            .ok_or_else(invalid)?
            .clone();
        let Json::Object(fields) = &mut profile else {
            return Err(invalid());
        };
        let key: Vec<u16> = "typedOracleKinds".encode_utf16().collect();
        let slot = fields
            .iter_mut()
            .find(|(k, _)| *k == key)
            .ok_or_else(invalid)?;
        slot.1 = oracle_types.clone();
        selected.push(profile);
    }
    Ok(Json::Object(vec![
        ("version".encode_utf16().collect(), Json::Number(1.0)),
        (
            "kind".encode_utf16().collect(),
            text("AutonomousEmpiricalFamilyPluginReleaseTemplate"),
        ),
        ("packageId".encode_utf16().collect(), text(package_id)),
        (
            "packageVersion".encode_utf16().collect(),
            text(package_version),
        ),
        ("profiles".encode_utf16().collect(), Json::Array(selected)),
    ]))
}
pub(crate) fn validate_grammar_v1(args: &[String]) -> Result<(), String> {
    if args.len() > 64
        || args
            .iter()
            .map(String::len)
            .try_fold(0usize, |n, s| n.checked_add(s))
            .is_none_or(|n| n > 32 * 1024)
    {
        return Err("autonomous_empirical_plugin_release_arguments_limit".into());
    }
    lex_arguments(args, true).map(|_| ())
}
fn original_request(
    args: &[String],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Option<Json>, String> {
    check(cancelled, deadline)?;
    validate_grammar_v1(args)?;
    let options = lex_arguments(args, true)?;
    if options.help {
        return Ok(None);
    }
    if !["inspect", "plan", "publish", "template"].contains(&options.action.as_str()) {
        return Err(format!(
            "autonomous_empirical_plugin_release_action_invalid:{}",
            options.action
        ));
    }
    if options.action == "inspect" {
        if options.activation.is_none() {
            return Err("autonomous_empirical_plugin_release_activation_required".into());
        }
        return Err(
            "autonomous_empirical_plugin_release_ordinary_unsigned_template_action_required".into(),
        );
    }
    if options.template.is_some()
        && (options.package_id.is_some()
            || options.package_version.is_some()
            || !options.benchmark_families.is_empty())
    {
        return Err("autonomous_empirical_plugin_release_template_options_conflict".into());
    }
    if options.template.is_none()
        && options.package_version.is_none()
        && options.action != "template"
    {
        return Err("autonomous_empirical_plugin_release_package_version_required".into());
    }
    let template = if options.template.is_some() {
        Json::Null
    } else {
        generated_template(&options, cancelled, deadline)?
    };
    if options.action == "template" {
        return Ok(Some(template));
    }
    if options.signing_config.is_none() {
        return Err("autonomous_empirical_plugin_release_signing_configuration_required".into());
    }
    if options.action == "publish" && options.install_root.is_none() {
        return Err("autonomous_empirical_plugin_release_install_root_required".into());
    }
    Err("autonomous_empirical_plugin_release_ordinary_unsigned_template_action_required".into())
}
fn startup_pair(bundle: Option<&str>, trust: Option<&str>) -> Result<(), String> {
    let values = [bundle.unwrap_or_default(), trust.unwrap_or_default()];
    if values.iter().any(|value| value.len() > 64 * 1024) {
        return Err("autonomous_empirical_plugin_release_startup_configuration_limit".into());
    }
    let configured = values.map(|value| !trim(value).is_empty());
    match configured {
        [false, false] => Ok(()),
        [true, true] => Err(
            "autonomous_empirical_plugin_release_configured_startup_domain_unaccepted_v1".into(),
        ),
        _ => Err("immutable_signed_json_bundle_configuration_incomplete".into()),
    }
}
fn startup_environment(cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
    check(cancelled, deadline)?;
    let selected = [
        "HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE",
        "HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE",
    ]
    .map(|key| match std::env::var(key) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(
            "autonomous_empirical_plugin_release_startup_configuration_encoding_invalid".to_owned(),
        ),
    });
    let [bundle, trust] = selected;
    let bundle = bundle?;
    let trust = trust?;
    startup_pair(bundle.as_deref(), trust.as_deref())?;
    check(cancelled, deadline)
}
/// Original template/null/help streams. Signer, activation, template references
/// and installation are never read or invoked, even when unused flags are set.
pub fn run_ordinary_autonomous_empirical_plugin_template_v1(
    args: &[String],
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    // Original module startup precedes worker parsing/help. External startup
    // bundles remain a versioned unaccepted domain, never silently ignored.
    startup_environment(cancelled, deadline)?;
    let template = original_request(args, cancelled, deadline)?;
    if template.is_none() {
        check(cancelled, deadline)?;
        return Ok(OrdinaryReadonlyOutputV1 {
            stdout: format!("{USAGE}\n").into_bytes(),
            stderr: vec![],
            exit_code: 0,
        });
    }
    current_native_command_workspace_root_v1(None)?;
    let template = template.ok_or_else(invalid)?;
    let limits = ProductionJsonEncodingLimitsV1::default();
    let resources =
        production_json_pretty_resources_v1(&template, limits, cancelled).map_err(|_| invalid())?;
    if resources.bytes >= limits.maximum_bytes {
        return Err("autonomous_empirical_plugin_release_output_limit".into());
    }
    check(cancelled, deadline)?;
    let mut stdout = production_json_pretty_with_limits_v1(&template, limits, cancelled)
        .map_err(|_| invalid())?;
    stdout.push(b'\n');
    check(cancelled, deadline)?;
    Ok(OrdinaryReadonlyOutputV1 {
        stdout,
        stderr: vec![],
        exit_code: 0,
    })
}

#[cfg(test)]
mod tests;
