//! Bounded read-only boundary for the empirical plugin release route.
//!
//! The incumbent Node command builds data-only plugin plans, invokes an
//! externally owned Ed25519 signer, verifies the resulting bundle and writes an
//! immutable installation.  Native Rust only owns argument/template/reference
//! preflight here. It never loads private keys, runs a signer, or writes an
//! install directory; publication is always fail-closed.
#![forbid(unsafe_code)]

use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const MAX_REFERENCE_BYTES: u64 = 16 * 1024 * 1024;
const SHA256_PREFIX: &str = "sha256:";
const ALL_ORACLE_KINDS: &[&str] = &[
    "condition-number-bound-v1",
    "convergence-rate-bound-v1",
    "error-bound-v1",
    "optimality-gap-bound-v1",
    "property-oracle-v1",
    "residual-bound-v1",
];

pub const AUTONOMOUS_EMPIRICAL_PLUGIN_RELEASE_USAGE: &str = r#"{
  "version": 1,
  "kind": "AutonomousEmpiricalPluginReleaseUsage",
  "usage": "hepta-paper-rust autonomous-empirical-plugin-release --action template|plan|publish|inspect [--template PATH] [--package-id ID --package-version SEMVER --benchmark-family FAMILY] [--signing-config PATH] [--install-root PATH] [--activation PATH]",
  "rustBoundary": "read-only template/reference preflight; no private-key loading, signer execution, bundle verification authority, or installation",
  "externalAction": false,
  "serviceStateChanged": false,
  "semanticNotReadyExitCode": 2
}"#;

#[derive(Clone, Debug, Default)]
pub struct AutonomousEmpiricalPluginReleaseOptions {
    pub help: bool,
    pub action: String,
    pub activation: Option<PathBuf>,
    pub install_root: Option<PathBuf>,
    pub package_id: Option<String>,
    pub package_version: Option<String>,
    pub benchmark_families: Vec<String>,
    pub signing_config: Option<PathBuf>,
    pub template: Option<PathBuf>,
}

fn value(args: &[String], index: &mut usize, name: &str) -> Result<String, String> {
    if *index + 1 >= args.len() || args[*index + 1].starts_with("--") {
        return Err(format!(
            "autonomous_empirical_plugin_release_{name}_value_required"
        ));
    }
    let value = args[*index + 1].clone();
    if value.is_empty() {
        return Err(format!(
            "autonomous_empirical_plugin_release_{name}_invalid"
        ));
    }
    *index += 2;
    Ok(value)
}

fn safe_id(value: &str) -> bool {
    (1..=192).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
}

fn safe_version(value: &str) -> bool {
    let (core, suffix) = value
        .split_once('-')
        .map_or((value, None), |(core, suffix)| (core, Some(suffix)));
    let nums: Vec<_> = core.split('.').collect();
    (nums.len() == 3)
        && nums.iter().all(|part| {
            !part.is_empty() && part.len() <= 4 && part.bytes().all(|b| b.is_ascii_digit())
        })
        && suffix.is_none_or(|suffix| {
            !suffix.is_empty()
                && suffix.len() <= 64
                && suffix
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        })
}

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix(SHA256_PREFIX).is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

pub fn parse_autonomous_empirical_plugin_release_arguments(
    args: &[String],
) -> Result<AutonomousEmpiricalPluginReleaseOptions, String> {
    let mut options = AutonomousEmpiricalPluginReleaseOptions {
        action: "plan".into(),
        ..Default::default()
    };
    let mut seen = BTreeSet::new();
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        if !seen.insert(flag.to_owned()) && flag != "--benchmark-family" {
            return Err(format!("duplicate_cli_option:{flag}"));
        }
        match flag {
            "--help" => {
                options.help = true;
                index += 1;
            }
            "--action" => options.action = value(args, &mut index, "action")?,
            "--activation" => {
                options.activation = Some(PathBuf::from(value(args, &mut index, "activation")?))
            }
            "--install-root" => {
                options.install_root = Some(PathBuf::from(value(args, &mut index, "install_root")?))
            }
            "--package-id" => options.package_id = Some(value(args, &mut index, "package_id")?),
            "--package-version" => {
                options.package_version = Some(value(args, &mut index, "package_version")?)
            }
            "--signing-config" => {
                options.signing_config =
                    Some(PathBuf::from(value(args, &mut index, "signing_config")?))
            }
            "--template" => {
                options.template = Some(PathBuf::from(value(args, &mut index, "template")?))
            }
            "--benchmark-family" => {
                options
                    .benchmark_families
                    .push(value(args, &mut index, "benchmark_family")?)
            }
            _ => {
                return Err(format!(
                    "unsupported_autonomous_empirical_plugin_release_argument:{flag}"
                ));
            }
        }
    }
    if options.help {
        return Ok(options);
    }
    if !["template", "plan", "publish", "inspect"].contains(&options.action.as_str()) {
        return Err(format!(
            "autonomous_empirical_plugin_release_action_invalid:{}",
            options.action
        ));
    }
    if options.action == "inspect" {
        if options.activation.is_none() {
            return Err("autonomous_empirical_plugin_release_activation_required".into());
        }
        if options.template.is_some()
            || options.package_id.is_some()
            || options.package_version.is_some()
            || !options.benchmark_families.is_empty()
            || options.signing_config.is_some()
            || options.install_root.is_some()
        {
            return Err("autonomous_empirical_plugin_release_inspect_options_conflict".into());
        }
    } else {
        if options.activation.is_some() && options.action != "publish" {
            return Err("autonomous_empirical_plugin_release_activation_only_publish".into());
        }
        if options.template.is_some()
            && (options.package_id.is_some()
                || options.package_version.is_some()
                || !options.benchmark_families.is_empty())
        {
            return Err("autonomous_empirical_plugin_release_template_options_conflict".into());
        }
        if options
            .package_id
            .as_deref()
            .is_some_and(|value| !safe_id(value))
        {
            return Err("autonomous_empirical_plugin_release_package_id_invalid".into());
        }
        if options
            .package_version
            .as_deref()
            .is_some_and(|value| !safe_version(value))
        {
            return Err("autonomous_empirical_plugin_release_package_version_invalid".into());
        }
        if options.benchmark_families.is_empty() {
            options
                .benchmark_families
                .push("ml_algorithm_benchmark".into());
        }
        if options
            .benchmark_families
            .iter()
            .any(|value| !safe_id(value))
            || options.benchmark_families.len() > 128
            || options
                .benchmark_families
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                != options.benchmark_families.len()
        {
            return Err("autonomous_empirical_plugin_release_benchmark_family_invalid".into());
        }
        if options.action == "template" {
            if options.template.is_some()
                || options.signing_config.is_some()
                || options.install_root.is_some()
            {
                return Err("autonomous_empirical_plugin_release_template_options_conflict".into());
            }
        } else {
            if options.signing_config.is_none() {
                return Err(
                    "autonomous_empirical_plugin_release_signing_configuration_required".into(),
                );
            }
            if options.action == "publish" && options.install_root.is_none() {
                return Err("autonomous_empirical_plugin_release_install_root_required".into());
            }
        }
    }
    for path in [
        &options.activation,
        &options.install_root,
        &options.signing_config,
        &options.template,
    ]
    .into_iter()
    .flatten()
    {
        if !path.is_absolute() {
            return Err("autonomous_empirical_plugin_release_paths_must_be_absolute".into());
        }
    }
    Ok(options)
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn invalid_reference(path: Option<&Path>, reason: &str) -> Value {
    json!({"path": path.map(|p| p.to_string_lossy().into_owned()), "absolute": path.is_some_and(Path::is_absolute), "valid": false, "reason": reason, "regular": false, "symlink": false, "singleLink": false, "observedSha256": Value::Null, "hashMatches": false})
}

fn inspect_file(path: Option<&Path>, expected_hash: Option<&str>, parse_json: bool) -> Value {
    let Some(path) = path else {
        return invalid_reference(None, "not_supplied");
    };
    if !path.is_absolute() {
        return invalid_reference(Some(path), "not_absolute");
    }
    let Some(parent) = path.parent() else {
        return invalid_reference(Some(path), "parent_missing");
    };
    let Ok(parent_before) = fs::symlink_metadata(parent) else {
        return invalid_reference(Some(path), "parent_unreadable");
    };
    if !parent_before.is_dir() || fs::canonicalize(parent).ok().as_deref() != Some(parent) {
        return invalid_reference(Some(path), "parent_identity_invalid");
    }
    let Ok(link) = fs::symlink_metadata(path) else {
        return invalid_reference(Some(path), "missing");
    };
    if link.file_type().is_symlink() {
        return invalid_reference(Some(path), "symlink");
    }
    let mut open = OpenOptions::new();
    open.read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC);
    let Ok(mut file) = open.open(path) else {
        return invalid_reference(Some(path), "open_failed");
    };
    let Ok(before) = file.metadata() else {
        return invalid_reference(Some(path), "metadata_failed");
    };
    if !before.is_file() || before.nlink() != 1 || before.len() > MAX_REFERENCE_BYTES {
        return invalid_reference(Some(path), "file_identity_invalid");
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    if file
        .by_ref()
        .take(MAX_REFERENCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return invalid_reference(Some(path), "read_failed");
    }
    let Ok(after) = file.metadata() else {
        return invalid_reference(Some(path), "metadata_failed");
    };
    let Ok(parent_after) = fs::symlink_metadata(parent) else {
        return invalid_reference(Some(path), "parent_unreadable");
    };
    let stable = before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.mode() == after.mode()
        && before.nlink() == after.nlink()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && parent_before.dev() == parent_after.dev()
        && parent_before.ino() == parent_after.ino()
        && fs::canonicalize(parent).ok().as_deref() == Some(parent)
        && bytes.len() as u64 <= MAX_REFERENCE_BYTES;
    if !stable {
        return invalid_reference(Some(path), "changed_during_read");
    }
    let observed = digest(&bytes);
    let hash_matches =
        expected_hash.is_none_or(|expected| valid_sha256(expected) && expected == observed);
    let parsed = parse_json
        .then(|| serde_json::from_slice::<Value>(&bytes).ok())
        .flatten();
    let json_summary = parsed
        .as_ref()
        .filter(|value| value.is_object())
        .map(|value| {
            json!({
                "version": value["version"],
                "kind": value["kind"],
                "packageId": value["packageId"],
                "packageVersion": value["packageVersion"],
                "profileCount": value["profiles"].as_array().map_or(0, Vec::len),
            })
        });
    json!({"path": path.to_string_lossy(), "absolute": true, "valid": hash_matches && (!parse_json || parsed.as_ref().is_some_and(Value::is_object)), "regular": true, "symlink": false, "singleLink": true, "size": bytes.len(), "observedSha256": observed, "expectedSha256": expected_hash, "hashMatches": hash_matches, "jsonObject": parsed.as_ref().is_some_and(Value::is_object), "jsonSummary": json_summary})
}

fn inspect_directory(path: Option<&Path>) -> Value {
    let Some(path) = path else {
        return invalid_reference(None, "not_supplied");
    };
    if !path.is_absolute() {
        return invalid_reference(Some(path), "not_absolute");
    }
    let Some(parent) = path.parent() else {
        return invalid_reference(Some(path), "parent_missing");
    };
    let Ok(parent_before) = fs::symlink_metadata(parent) else {
        return invalid_reference(Some(path), "parent_unreadable");
    };
    if !parent_before.is_dir() || fs::canonicalize(parent).ok().as_deref() != Some(parent) {
        return invalid_reference(Some(path), "parent_identity_invalid");
    }
    let Ok(before) = fs::symlink_metadata(path) else {
        return invalid_reference(Some(path), "missing");
    };
    if before.file_type().is_symlink() || !before.is_dir() || before.nlink() == 0 {
        return invalid_reference(Some(path), "directory_identity_invalid");
    }
    let mut open = OpenOptions::new();
    open.read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_DIRECTORY | nix::libc::O_CLOEXEC);
    let Ok(file) = open.open(path) else {
        return invalid_reference(Some(path), "open_failed");
    };
    let Ok(opened) = file.metadata() else {
        return invalid_reference(Some(path), "metadata_failed");
    };
    let Ok(after) = fs::symlink_metadata(path) else {
        return invalid_reference(Some(path), "missing");
    };
    let Ok(parent_after) = fs::symlink_metadata(parent) else {
        return invalid_reference(Some(path), "parent_unreadable");
    };
    let stable = before.dev() == opened.dev()
        && before.ino() == opened.ino()
        && before.mode() == opened.mode()
        && before.nlink() == opened.nlink()
        && before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.mode() == after.mode()
        && before.nlink() == after.nlink()
        && parent_before.dev() == parent_after.dev()
        && parent_before.ino() == parent_after.ino()
        && fs::canonicalize(parent).ok().as_deref() == Some(parent);
    let identity = format!(
        "{}:{}:{}:{}",
        before.dev(),
        before.ino(),
        before.mode(),
        path.to_string_lossy()
    );
    json!({"path": path.to_string_lossy(), "absolute": true, "valid": stable, "directory": true, "symlink": false, "singleLink": false, "identityHash": digest(identity.as_bytes())})
}

fn generated_template(options: &AutonomousEmpiricalPluginReleaseOptions) -> Value {
    let package_id = options
        .package_id
        .clone()
        .unwrap_or_else(|| "hepta.advanced-numerical-empirical-families".into());
    let package_version = options
        .package_version
        .clone()
        .unwrap_or_else(|| "1.0.0".into());
    let profiles = options.benchmark_families.iter().map(|family| json!({"version":1,"kind":"AutonomousEmpiricalFamilyPluginProfile","benchmarkFamily":family,"typedOracleKinds":ALL_ORACLE_KINDS})).collect::<Vec<_>>();
    json!({"version":1,"kind":"AutonomousEmpiricalFamilyPluginReleaseTemplate","packageId":package_id,"packageVersion":package_version,"profiles":profiles})
}

fn inspect_template(options: &AutonomousEmpiricalPluginReleaseOptions) -> (Value, Option<Value>) {
    let Some(path) = options.template.as_deref() else {
        let template = generated_template(options);
        return (
            json!({"source":"generated","valid":true,"sha256":digest(serde_json::to_string(&template).unwrap().as_bytes()),"profileCount":template["profiles"].as_array().map_or(0, Vec::len)}),
            Some(template),
        );
    };
    let reference = inspect_file(Some(path), None, true);
    let summary = reference["jsonSummary"].clone();
    let valid = reference["valid"] == true
        && summary["version"] == 1
        && summary["kind"] == "AutonomousEmpiricalFamilyPluginReleaseTemplate"
        && summary["packageId"].as_str().is_some_and(safe_id)
        && summary["packageVersion"].as_str().is_some_and(safe_version)
        && summary["profileCount"]
            .as_u64()
            .is_some_and(|count| (1..=128).contains(&count));
    (
        json!({"source":"file","valid":valid,"reference":reference,"profileCount":summary["profileCount"],"packageId":summary["packageId"],"packageVersion":summary["packageVersion"]}),
        None,
    )
}

fn blocker(blockers: &mut Vec<String>, value: &str) {
    blockers.push(value.into());
}

pub fn autonomous_empirical_plugin_release_help_json_v1() -> Value {
    serde_json::from_str(AUTONOMOUS_EMPIRICAL_PLUGIN_RELEASE_USAGE).expect("static usage")
}

pub fn inspect_autonomous_empirical_plugin_release_v1(
    options: &AutonomousEmpiricalPluginReleaseOptions,
) -> Value {
    if options.action == "template" {
        return generated_template(options);
    }
    let (template, _) = inspect_template(options);
    let signing = options
        .signing_config
        .as_deref()
        .map(|path| inspect_file(Some(path), None, true));
    let activation = options
        .activation
        .as_deref()
        .map(|path| inspect_file(Some(path), None, true));
    let install_root = options
        .install_root
        .as_deref()
        .map(|path| inspect_directory(Some(path)));
    let mut blockers = vec![
        "rust_autonomous_empirical_plugin_external_ed25519_signer_not_ported".to_owned(),
        "rust_autonomous_empirical_plugin_bundle_verification_authority_not_ported".to_owned(),
        "rust_autonomous_empirical_plugin_installation_publication_not_ported".to_owned(),
    ];
    if template["valid"] != true {
        blocker(
            &mut blockers,
            "autonomous_empirical_plugin_release_template_invalid",
        );
    }
    if signing.as_ref().is_none_or(|value| value["valid"] != true) {
        blocker(
            &mut blockers,
            "autonomous_empirical_plugin_release_signing_configuration_invalid",
        );
    }
    if options.action == "publish"
        && install_root
            .as_ref()
            .is_none_or(|value| value["valid"] != true)
    {
        blocker(
            &mut blockers,
            "autonomous_empirical_plugin_release_install_root_invalid",
        );
    }
    if options.action == "inspect"
        && activation
            .as_ref()
            .is_none_or(|value| value["valid"] != true)
    {
        blocker(
            &mut blockers,
            "autonomous_empirical_plugin_release_activation_invalid",
        );
    }
    blockers.sort();
    blockers.dedup();
    let payload = json!({"version":1,"kind":"AutonomousEmpiricalPluginReleaseReport","status":"autonomous_empirical_plugin_release_blocked","action":options.action,"template":template,"signingConfiguration":signing,"activation":activation,"installRoot":install_root,"ready":false,"signatureProduced":false,"installed":false,"externalActionPerformed":false,"serviceStateChanged":false,"privateKeyMaterialLoadedByHepta":false,"advancedNumericalCoverageVerified":false,"strictProductionAdvancedNumericalFamilySetVerified":false,"blockers":blockers,"rustBoundary":"read-only-template-and-reference-preflight"});
    let hash = production_hash_record_v1("AutonomousEmpiricalPluginReleaseReport", &payload)
        .ok()
        .map(|value| value.as_str().to_owned());
    let mut report = payload;
    report["reportHash"] = hash.map_or(Value::Null, Value::String);
    report
}

pub fn execute_autonomous_empirical_plugin_release_v1(
    options: &AutonomousEmpiricalPluginReleaseOptions,
) -> Value {
    inspect_autonomous_empirical_plugin_release_v1(options)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parser_rejects_private_key_and_requires_publish_root() {
        assert!(
            parse_autonomous_empirical_plugin_release_arguments(&[
                "--private-key".into(),
                "/tmp/key".into()
            ])
            .is_err()
        );
        assert!(
            parse_autonomous_empirical_plugin_release_arguments(&[
                "--action".into(),
                "publish".into(),
                "--signing-config".into(),
                "/tmp/signer".into()
            ])
            .is_err()
        );
    }
    #[test]
    fn generated_template_is_unsigned_and_report_blocked() {
        let options = parse_autonomous_empirical_plugin_release_arguments(&[
            "--action".into(),
            "plan".into(),
            "--signing-config".into(),
            "/tmp/signer".into(),
        ])
        .unwrap();
        let report = inspect_autonomous_empirical_plugin_release_v1(&options);
        assert_eq!(report["ready"], false);
        assert_eq!(report["privateKeyMaterialLoadedByHepta"], false);
        assert_eq!(report["externalActionPerformed"], false);
    }
}
