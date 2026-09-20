//! Bounded local golden-dataset provisioning plan inspection.
//!
//! The plan path is source-bound and read-only.  It validates the immutable
//! local inputs that the Node route binds into its plan identity.  Execution is
//! deliberately fail-closed until the complete local harness contract and
//! no-clobber publication chain are ported; this module never reads a private
//! key or writes a runtime root.

use ed25519_dalek::{VerifyingKey, pkcs8::DecodePublicKey};
use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};
use thiserror::Error;

pub const LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE: &str = "local-operator-golden-runtime-only-v1";
pub const LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS: &str = "local_operator_dataset_authority";
pub const LOCAL_GOLDEN_DATASET_AUTHORITY_ROLE: &str = "local_golden_dataset_operator";
pub const LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE: &str = "local-golden-dataset-authority-v1";
pub const LOCAL_GOLDEN_DATASET_PROVISIONING_BLOCKER: &str =
    "rust_local_golden_dataset_execute_not_ported";
const MAXIMUM_JSON_BYTES: u64 = 8 * 1024 * 1024;
const MAXIMUM_AUTHORITY_LIFETIME_MS: i64 = 31 * 24 * 60 * 60 * 1_000;

#[derive(Debug, Error)]
#[error("{0}")]
pub struct LocalGoldenDatasetError(pub String);
pub type Result<T> = std::result::Result<T, LocalGoldenDatasetError>;
fn error(code: impl Into<String>) -> LocalGoldenDatasetError {
    LocalGoldenDatasetError(code.into())
}

pub fn local_golden_dataset_provisioning_usage() -> &'static str {
    r#"Usage: local-golden-dataset-provision --action plan|execute [options]

This provisions a signed dataset harness for one isolated local golden runtime.
It can never establish academic promotion eligibility or external trust.

Required:
  --runtime-root PATH              Existing private isolated runtime root.
  --control-root PATH              Existing private isolated control root.
  --isolation-id ID                Stable local isolation identifier.
  --dataset-name NAME              Dataset/benchmark identifier.
  --dataset-root PATH              Immutable read-only dataset directory.
  --dataset-license-id SPDX|LicenseRef-*
  --split-assignments PATH         Complete train/validation/public path assignments.
  --harness-definition PATH        Private host-only hidden harness JSON (mode 0600).
  --analysis-protocol PATH         Canonical preregistered analysis protocol JSON.
  --research-semantics PATH        Dataset research-semantics JSON.
  --authority-trust-store PATH     Public-only local-purpose AuthorityTrustStore JSON.
  --authority-private-key PATH     Dedicated local-purpose Ed25519 key outside output roots.
  --authority-key-id ID            Active dataset_harness_operator key ID.
  --signed-at ISO                  Deterministic authority signature time.
  --expires-at ISO                 Expiry no more than 31 days after signed-at.
  --mount-output PATH              JSON mount array below control-root.

Execution:
  --action plan                    Validate immutable inputs; perform no writes.
  --action execute --execute       Publish no-clobber outputs atomically.
  --plan-id sha256:...             Exact plan ID emitted by plan; required by execute.

Production runtime, asset, trust, source and deployment roots are always rejected.
No data is downloaded and no provider or external service is called."#
}

#[derive(Clone, Debug)]
pub struct LocalGoldenDatasetProvisioningOptions {
    pub action: String,
    pub execute: bool,
    pub expected_plan_id: Option<String>,
    pub runtime_root: PathBuf,
    pub control_root: PathBuf,
    pub isolation_id: String,
    pub dataset_name: String,
    pub dataset_root: PathBuf,
    pub dataset_license_id: String,
    pub split_assignments: PathBuf,
    pub harness_definition: PathBuf,
    pub analysis_protocol: PathBuf,
    pub research_semantics: PathBuf,
    pub authority_trust_store: PathBuf,
    pub authority_private_key: PathBuf,
    pub authority_key_id: String,
    pub signed_at: String,
    pub expires_at: String,
    pub mount_output: PathBuf,
}

fn value(args: &BTreeMap<String, String>, key: &str) -> Result<String> {
    args.get(key).cloned().ok_or_else(|| {
        error(format!(
            "local_golden_dataset_provisioning_arguments_required:{key}"
        ))
    })
}

pub fn parse_local_golden_dataset_provisioning_arguments(
    argv: &[String],
) -> Result<Option<LocalGoldenDatasetProvisioningOptions>> {
    let mut values = BTreeMap::<String, String>::new();
    let mut booleans = BTreeSet::<String>::new();
    let value_flags = BTreeSet::from([
        "action",
        "plan-id",
        "runtime-root",
        "control-root",
        "isolation-id",
        "dataset-name",
        "dataset-root",
        "dataset-license-id",
        "split-assignments",
        "harness-definition",
        "analysis-protocol",
        "research-semantics",
        "authority-trust-store",
        "authority-private-key",
        "authority-key-id",
        "signed-at",
        "expires-at",
        "mount-output",
    ]);
    let mut index = 0;
    while index < argv.len() {
        let argument = &argv[index];
        if argument == "--help" {
            if index + 1 != argv.len() {
                return Err(error("local_golden_dataset_provisioning_arguments_invalid"));
            }
            return Ok(None);
        }
        if argument == "--execute" {
            if !booleans.insert("execute".into()) {
                return Err(error("local_golden_dataset_provisioning_arguments_invalid"));
            }
            index += 1;
            continue;
        }
        let Some(name) = argument.strip_prefix("--") else {
            return Err(error("local_golden_dataset_provisioning_arguments_invalid"));
        };
        if !value_flags.contains(name) || values.contains_key(name) {
            return Err(error("local_golden_dataset_provisioning_arguments_invalid"));
        }
        let next = argv
            .get(index + 1)
            .ok_or_else(|| error("local_golden_dataset_provisioning_arguments_invalid"))?;
        if next.starts_with("--") {
            return Err(error("local_golden_dataset_provisioning_arguments_invalid"));
        }
        values.insert(name.to_owned(), next.clone());
        index += 2;
    }
    let action = values
        .get("action")
        .cloned()
        .unwrap_or_else(|| "plan".into());
    if action != "plan" && action != "execute" {
        return Err(error(format!(
            "local_golden_dataset_provisioning_action_invalid:{action}"
        )));
    }
    let required = [
        "runtime-root",
        "control-root",
        "isolation-id",
        "dataset-name",
        "dataset-root",
        "dataset-license-id",
        "split-assignments",
        "harness-definition",
        "analysis-protocol",
        "research-semantics",
        "authority-trust-store",
        "authority-private-key",
        "authority-key-id",
        "signed-at",
        "expires-at",
        "mount-output",
    ];
    for key in required {
        let _ = value(&values, key)?;
    }
    let execute = booleans.contains("execute");
    if action == "plan" && (execute || values.contains_key("plan-id")) {
        return Err(error(
            "local_golden_dataset_provisioning_execute_options_forbidden",
        ));
    }
    if action == "execute" && !execute {
        return Err(error(
            "local_golden_dataset_provisioning_execute_confirmation_required",
        ));
    }
    let expected_plan_id = values.get("plan-id").cloned();
    if action == "execute" && !expected_plan_id.as_deref().is_some_and(valid_hash) {
        return Err(error("local_golden_dataset_provisioning_plan_id_required"));
    }
    let path_value = |key: &str| -> Result<PathBuf> { Ok(PathBuf::from(value(&values, key)?)) };
    Ok(Some(LocalGoldenDatasetProvisioningOptions {
        action,
        execute,
        expected_plan_id,
        runtime_root: path_value("runtime-root")?,
        control_root: path_value("control-root")?,
        isolation_id: value(&values, "isolation-id")?,
        dataset_name: value(&values, "dataset-name")?,
        dataset_root: path_value("dataset-root")?,
        dataset_license_id: value(&values, "dataset-license-id")?,
        split_assignments: path_value("split-assignments")?,
        harness_definition: path_value("harness-definition")?,
        analysis_protocol: path_value("analysis-protocol")?,
        research_semantics: path_value("research-semantics")?,
        authority_trust_store: path_value("authority-trust-store")?,
        authority_private_key: path_value("authority-private-key")?,
        authority_key_id: value(&values, "authority-key-id")?,
        signed_at: value(&values, "signed-at")?,
        expires_at: value(&values, "expires-at")?,
        mount_output: path_value("mount-output")?,
    }))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|b| b.is_ascii_hexdigit())
}
fn hash_record(kind: &str, value: &Value) -> Result<String> {
    production_hash_record_v1(kind, value)
        .map(|hash| hash.as_str().to_owned())
        .map_err(|_| error("local_golden_dataset_hash_failed"))
}
fn hash_bytes(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn exact_keys(value: &Value, expected: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let mut actual = object.keys().map(String::as_str).collect::<Vec<_>>();
    actual.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    actual == expected
}
fn path_within(root: &Path, candidate: &Path) -> bool {
    candidate.strip_prefix(root).is_ok()
}
fn overlap(left: &Path, right: &Path) -> bool {
    path_within(left, right) || path_within(right, left)
}
fn canonical_existing_directory(path: &Path, role: &str, private: bool) -> Result<PathBuf> {
    let canonical = fs::canonicalize(path)
        .map_err(|_| error(format!("local_golden_dataset_{role}_unreadable")))?;
    let metadata = fs::symlink_metadata(&canonical)
        .map_err(|_| error(format!("local_golden_dataset_{role}_unreadable")))?;
    let mode = metadata.permissions().mode() & 0o777;
    if canonical != path
        || !metadata.is_dir()
        || mode & 0o022 != 0
        || (private && mode & 0o077 != 0)
        || metadata.uid() != nix::unistd::Uid::current().as_raw()
    {
        return Err(error(format!(
            "local_golden_dataset_{role}_identity_invalid"
        )));
    }
    Ok(canonical)
}
fn read_stable_json(path: &Path, role: &str, private: bool, max_bytes: u64) -> Result<Value> {
    let canonical = fs::canonicalize(path)
        .map_err(|_| error(format!("local_golden_dataset_{role}_unreadable")))?;
    let before = fs::symlink_metadata(&canonical)
        .map_err(|_| error(format!("local_golden_dataset_{role}_unreadable")))?;
    let mode = before.permissions().mode() & 0o777;
    if canonical != path
        || !before.is_file()
        || before.nlink() != 1
        || before.uid() != nix::unistd::Uid::current().as_raw()
        || mode & 0o022 != 0
        || (private && mode & 0o077 != 0)
        || before.len() == 0
        || before.len() > max_bytes
    {
        return Err(error(format!(
            "local_golden_dataset_{role}_identity_invalid"
        )));
    }
    let bytes = fs::read(&canonical)
        .map_err(|_| error(format!("local_golden_dataset_{role}_unreadable")))?;
    let after = fs::symlink_metadata(&canonical)
        .map_err(|_| error(format!("local_golden_dataset_{role}_unreadable")))?;
    if before.len() != bytes.len() as u64
        || before.ino() != after.ino()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.size() != after.size()
    {
        return Err(error(format!(
            "local_golden_dataset_{role}_changed_during_read"
        )));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| error(format!("local_golden_dataset_{role}_json_invalid")))
}
#[derive(Clone, Debug)]
struct DatasetManifest {
    hash: String,
    files: BTreeMap<String, String>,
}
fn relative_safe(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && !path.starts_with('/')
        && !path.split('/').any(|p| p == ".." || p.is_empty())
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-/".contains(&b))
}
fn inspect_dataset(root: &Path) -> Result<DatasetManifest> {
    let root_meta = fs::symlink_metadata(root)
        .map_err(|_| error("local_golden_dataset_dataset_root_unreadable"))?;
    if !root_meta.is_dir()
        || root_meta.file_type().is_symlink()
        || root_meta.permissions().mode() & 0o222 != 0
    {
        return Err(error("local_golden_dataset_source_must_be_immutable"));
    }
    let mut records = Vec::new();
    let mut files = BTreeMap::new();
    fn walk(
        root: &Path,
        current: &Path,
        records: &mut Vec<String>,
        files: &mut BTreeMap<String, String>,
    ) -> Result<()> {
        let mut entries = fs::read_dir(current)
            .map_err(|_| error("local_golden_dataset_dataset_root_unreadable"))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| error("local_golden_dataset_dataset_root_unreadable"))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| error("local_golden_dataset_source_must_be_immutable"))?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| error("local_golden_dataset_source_must_be_immutable"))?
                .to_string_lossy()
                .replace('\\', "/");
            if !relative_safe(&relative) {
                return Err(error("local_golden_dataset_source_path_invalid"));
            }
            if metadata.file_type().is_symlink() {
                return Err(error("local_golden_dataset_source_must_be_immutable"));
            }
            if metadata.is_dir() {
                if metadata.permissions().mode() & 0o222 != 0 {
                    return Err(error("local_golden_dataset_source_must_be_immutable"));
                }
                walk(root, &path, records, files)?;
            } else if metadata.is_file() {
                if metadata.permissions().mode() & 0o222 != 0 || metadata.nlink() != 1 {
                    return Err(error("local_golden_dataset_source_must_be_immutable"));
                }
                let bytes = fs::read(&path)
                    .map_err(|_| error("local_golden_dataset_source_must_be_immutable"))?;
                let hash = hash_bytes(&bytes);
                files.insert(relative.clone(), hash.clone());
                records.push(format!(
                    "{}\0{}",
                    relative,
                    hash.trim_start_matches("sha256:")
                ));
            } else {
                return Err(error("local_golden_dataset_source_must_be_immutable"));
            }
        }
        Ok(())
    }
    walk(root, root, &mut records, &mut files)?;
    if files.is_empty() {
        return Err(error("local_golden_dataset_manifest_invalid"));
    }
    Ok(DatasetManifest {
        hash: hash_bytes(records.join("\n").as_bytes()),
        files,
    })
}

fn normalize_semantics(value: &Value) -> Result<Value> {
    if !exact_keys(
        value,
        &[
            "version",
            "kind",
            "population",
            "variables",
            "intervention",
            "comparator",
            "estimands",
            "datasetConstraints",
            "eligibleSplits",
        ],
    ) || value["version"] != 1
        || value["kind"] != "OperatorDatasetResearchSemantics"
    {
        return Err(error("operator_dataset_research_semantics_shape_invalid"));
    }
    let text = |v: &Value| {
        let s = v
            .as_str()
            .unwrap_or_default()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if s.is_empty() || s.len() > 2_000 {
            None
        } else {
            Some(Value::String(s))
        }
    };
    let list = |v: &Value, max: usize| -> Option<Value> {
        let mut values = v.as_array()?.iter().map(text).collect::<Option<Vec<_>>>()?;
        if values.is_empty() || values.len() > max {
            return None;
        }
        values.sort_by_key(|v| v.as_str().unwrap_or_default().to_owned());
        values.dedup();
        (values.len() == v.as_array()?.len()).then_some(Value::Array(values))
    };
    let variables = list(&value["variables"], 128)
        .ok_or_else(|| error("operator_dataset_research_semantics_invalid"))?;
    let estimands = list(&value["estimands"], 128)
        .ok_or_else(|| error("operator_dataset_research_semantics_invalid"))?;
    let constraints = list(&value["datasetConstraints"], 128)
        .ok_or_else(|| error("operator_dataset_research_semantics_invalid"))?;
    let splits = list(&value["eligibleSplits"], 4)
        .ok_or_else(|| error("operator_dataset_research_semantics_invalid"))?;
    if splits.as_array().is_none_or(|s| {
        s.iter().any(|v| {
            v == "test"
                || !["train", "validation", "public"].contains(&v.as_str().unwrap_or_default())
        })
    }) {
        return Err(error("operator_dataset_research_semantics_invalid"));
    }
    let normalized = json!({"version":1,"kind":"OperatorDatasetResearchSemantics","population":text(&value["population"]).ok_or_else(|| error("operator_dataset_research_semantics_invalid"))?,"variables":variables,"intervention":text(&value["intervention"]).ok_or_else(|| error("operator_dataset_research_semantics_invalid"))?,"comparator":text(&value["comparator"]).ok_or_else(|| error("operator_dataset_research_semantics_invalid"))?,"estimands":estimands,"datasetConstraints":constraints,"eligibleSplits":splits});
    Ok(normalized)
}

fn normalize_harness(value: &Value, dataset_name: &str) -> Result<Value> {
    if !exact_keys(
        value,
        &[
            "version",
            "kind",
            "benchmarkId",
            "benchmarkFamily",
            "seedSchedule",
            "minimumRepetitions",
            "cells",
        ],
    ) || value["version"] != 1
        || value["kind"] != "OperatorAuthorizedDatasetBenchmarkHarness"
        || value["benchmarkId"] != dataset_name
        || value["benchmarkFamily"] != "ml_algorithm_benchmark"
    {
        return Err(error("operator_dataset_harness_identity_invalid"));
    }
    let seeds = value["seedSchedule"]
        .as_array()
        .ok_or_else(|| error("operator_dataset_harness_schedule_invalid"))?;
    if seeds.is_empty() || seeds.len() > 100 {
        return Err(error("operator_dataset_harness_schedule_invalid"));
    }
    let mut seed_numbers = Vec::new();
    for seed in seeds {
        let n = seed
            .as_i64()
            .ok_or_else(|| error("operator_dataset_harness_schedule_invalid"))?;
        if !seed_numbers.push_unique(n) {
            return Err(error("operator_dataset_harness_schedule_invalid"));
        }
    }
    let repetitions = value["minimumRepetitions"]
        .as_i64()
        .ok_or_else(|| error("operator_dataset_harness_schedule_invalid"))?;
    if !(1..=100).contains(&repetitions) || seed_numbers.len() * (repetitions as usize) < 32 {
        return Err(error("operator_dataset_harness_schedule_invalid"));
    }
    let expected = seed_numbers
        .iter()
        .flat_map(|seed| (1..=repetitions).map(move |rep| (*seed, rep)))
        .collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    let mut cells = Vec::new();
    for cell in value["cells"]
        .as_array()
        .ok_or_else(|| error("operator_dataset_harness_schedule_incomplete"))?
    {
        if !exact_keys(cell, &["seed", "repetition", "cases"]) {
            return Err(error("operator_dataset_harness_cell_invalid"));
        }
        let seed = cell["seed"]
            .as_i64()
            .ok_or_else(|| error("operator_dataset_harness_cell_invalid"))?;
        let repetition = cell["repetition"]
            .as_i64()
            .ok_or_else(|| error("operator_dataset_harness_cell_invalid"))?;
        if !expected.contains(&(seed, repetition)) || !seen.insert((seed, repetition)) {
            return Err(error("operator_dataset_harness_cell_invalid"));
        }
        let cases = cell["cases"]
            .as_array()
            .ok_or_else(|| error("operator_dataset_harness_cell_invalid"))?;
        if cases.len() != 8 {
            return Err(error("operator_dataset_harness_cell_invalid"));
        }
        let mut normalized_cases = Vec::new();
        let mut ids = BTreeSet::new();
        for candidate in cases {
            if !exact_keys(
                candidate,
                &[
                    "caseId",
                    "input",
                    "ablationInput",
                    "referenceResponse",
                    "oracle",
                ],
            ) || !valid_hash(candidate["caseId"].as_str().unwrap_or_default())
                || !candidate["input"].is_object()
                || !candidate["ablationInput"].is_object()
                || !candidate["referenceResponse"]
                    .as_f64()
                    .is_some_and(f64::is_finite)
                || !exact_keys(&candidate["oracle"], &["label", "robustLabel"])
                || !candidate["oracle"]["label"]
                    .as_f64()
                    .is_some_and(f64::is_finite)
                || !candidate["oracle"]["robustLabel"]
                    .as_f64()
                    .is_some_and(f64::is_finite)
                || !ids.insert(
                    candidate["caseId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_ascii_lowercase(),
                )
            {
                return Err(error("operator_dataset_harness_case_invalid"));
            }
            normalized_cases.push(json!({"caseId":candidate["caseId"].as_str().unwrap_or_default().to_ascii_lowercase(),"input":candidate["input"].clone(),"ablationInput":candidate["ablationInput"].clone(),"referenceResponse":candidate["referenceResponse"].clone(),"oracle":{"label":candidate["oracle"]["label"].clone(),"robustLabel":candidate["oracle"]["robustLabel"].clone()}}));
        }
        cells.push(json!({"seed":seed,"repetition":repetition,"cases":normalized_cases}));
    }
    if seen != expected {
        return Err(error("operator_dataset_harness_schedule_incomplete"));
    }
    cells.sort_by_key(|cell| {
        (
            cell["seed"].as_i64().unwrap_or_default(),
            cell["repetition"].as_i64().unwrap_or_default(),
        )
    });
    Ok(
        json!({"version":1,"kind":"OperatorAuthorizedDatasetBenchmarkHarness","benchmarkId":dataset_name,"benchmarkFamily":"ml_algorithm_benchmark","seedSchedule":seed_numbers,"minimumRepetitions":repetitions,"cells":cells}),
    )
}

trait PushUnique<T> {
    fn push_unique(&mut self, value: T) -> bool;
}
impl<T: Ord> PushUnique<T> for Vec<T> {
    fn push_unique(&mut self, value: T) -> bool {
        if self.contains(&value) {
            false
        } else {
            self.push(value);
            true
        }
    }
}

fn selected_trust_key(value: &Value, key_id: &str) -> Result<()> {
    if !exact_keys(
        value,
        &[
            "version",
            "kind",
            "authorityScope",
            "evidenceClass",
            "academicPromotionEligible",
            "externalTrustClaimed",
            "keyPurpose",
            "keys",
        ],
    ) || value["version"] != 1
        || value["kind"] != "AuthorityTrustStore"
        || value["authorityScope"] != LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE
        || value["evidenceClass"] != LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS
        || value["academicPromotionEligible"] != false
        || value["externalTrustClaimed"] != false
        || value["keyPurpose"] != LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE
    {
        return Err(error("local_golden_dataset_public_trust_store_invalid"));
    }
    let keys = value["keys"]
        .as_array()
        .ok_or_else(|| error("local_golden_dataset_public_trust_store_invalid"))?;
    let selected = keys
        .iter()
        .filter(|key| key["keyId"].as_str() == Some(key_id))
        .collect::<Vec<_>>();
    if selected.len() != 1
        || selected[0]["algorithm"] != "ed25519"
        || selected[0]["status"] != "active"
        || selected[0]["keyPurpose"] != LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE
        || selected[0]["authorityScope"] != LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE
        || selected[0]["academicPromotionEligible"] != false
        || selected[0]["externalTrustClaimed"] != false
        || selected[0]["publicKeyPem"]
            .as_str()
            .is_none_or(|pem| pem.contains("PRIVATE KEY"))
        || selected[0].get("privateKeyPem").is_some()
    {
        return Err(error("local_golden_dataset_authority_key_not_trusted"));
    }
    let public_key_pem = selected[0]["publicKeyPem"]
        .as_str()
        .ok_or_else(|| error("local_golden_dataset_authority_public_key_invalid"))?;
    VerifyingKey::from_public_key_pem(public_key_pem)
        .map_err(|_| error("local_golden_dataset_authority_public_key_invalid"))?;
    Ok(())
}

fn parse_iso_millis(value: &str) -> Option<i64> {
    if value.len() != 24
        || !value.ends_with('Z')
        || value.as_bytes().get(4) != Some(&b'-')
        || value.as_bytes().get(7) != Some(&b'-')
        || value.as_bytes().get(10) != Some(&b'T')
        || value.as_bytes().get(13) != Some(&b':')
        || value.as_bytes().get(16) != Some(&b':')
        || value.as_bytes().get(19) != Some(&b'.')
    {
        return None;
    }
    let n = |a: usize, b: usize| value[a..b].parse::<i64>().ok();
    let (year, month, day, hour, minute, second, milli) = (
        n(0, 4)?,
        n(5, 7)?,
        n(8, 10)?,
        n(11, 13)?,
        n(14, 16)?,
        n(17, 19)?,
        n(20, 23)?,
    );
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
        || milli > 999
    {
        return None;
    }
    let (y, m) = if month <= 2 {
        (year - 1, month + 12)
    } else {
        (year, month)
    };
    let days = 365 * y + y.div_euclid(4) - y.div_euclid(100)
        + y.div_euclid(400)
        + (153 * (m - 3) + 2).div_euclid(5)
        + day
        - 1
        - 719468;
    Some(days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + milli)
}
fn validate_time(signed_at: &str, expires_at: &str) -> Result<(String, String)> {
    let signed = parse_iso_millis(signed_at)
        .ok_or_else(|| error("local_golden_dataset_authority_time_invalid"))?;
    let expires = parse_iso_millis(expires_at)
        .ok_or_else(|| error("local_golden_dataset_authority_time_invalid"))?;
    if expires <= signed || expires - signed > MAXIMUM_AUTHORITY_LIFETIME_MS {
        return Err(error("local_golden_dataset_authority_time_invalid"));
    }
    Ok((signed_at.to_owned(), expires_at.to_owned()))
}

fn local_runtime_hash(path: &Path) -> Result<String> {
    hash_record(
        "LocalGoldenDatasetRuntimeRoot",
        &json!({"runtimeRoot": path.to_string_lossy()}),
    )
}

pub fn inspect_local_golden_dataset_provisioning_v1(
    options: &LocalGoldenDatasetProvisioningOptions,
) -> Result<Value> {
    let name_ok = |value: &str| {
        !value.is_empty()
            && value.len() <= 127
            && value.as_bytes()[0].is_ascii_alphanumeric()
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    };
    if !name_ok(&options.dataset_name)
        || !name_ok(&options.isolation_id)
        || options.authority_key_id.is_empty()
        || !matches!(
            options.dataset_license_id.as_str(),
            "0BSD"
                | "Apache-2.0"
                | "BSD-2-Clause"
                | "BSD-3-Clause"
                | "CC-BY-4.0"
                | "CC-BY-SA-4.0"
                | "CC0-1.0"
                | "MIT"
                | "ODbL-1.0"
                | "PDDL-1.0"
                | "Unlicense"
        ) && !options
            .dataset_license_id
            .strip_prefix("LicenseRef-")
            .is_some_and(|s| {
                !s.is_empty()
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
            })
    {
        return Err(error("local_golden_dataset_identity_invalid"));
    }
    let protected = [
        "/var/lib/hepta-paper",
        "/srv/hepta-paper",
        "/etc/hepta-paper",
        "/opt/hepta-paper",
    ];
    for (role, path) in [
        ("runtimeRoot", &options.runtime_root),
        ("controlRoot", &options.control_root),
        ("datasetRoot", &options.dataset_root),
        ("authorityPrivateKeyPath", &options.authority_private_key),
    ] {
        if protected.iter().any(|root| overlap(Path::new(root), path)) {
            return Err(error(format!(
                "local_golden_dataset_protected_root_forbidden:{role}"
            )));
        }
    }
    let runtime_root = canonical_existing_directory(&options.runtime_root, "runtime_root", true)?;
    let control_root = canonical_existing_directory(&options.control_root, "control_root", true)?;
    let dataset_root = canonical_existing_directory(&options.dataset_root, "dataset_root", false)?;
    if overlap(&runtime_root, &control_root)
        || overlap(&runtime_root, &dataset_root)
        || overlap(&control_root, &dataset_root)
    {
        return Err(error("local_golden_dataset_roots_overlap"));
    }
    let mount_output = fs::canonicalize(
        options
            .mount_output
            .parent()
            .ok_or_else(|| error("local_golden_dataset_mount_output_outside_control_root"))?,
    )
    .map_err(|_| error("local_golden_dataset_mount_output_outside_control_root"))?
    .join(
        options
            .mount_output
            .file_name()
            .ok_or_else(|| error("local_golden_dataset_mount_output_outside_control_root"))?,
    );
    if !path_within(&control_root, &mount_output)
        || mount_output == control_root
        || mount_output.extension().and_then(|v| v.to_str()) != Some("json")
    {
        return Err(error(
            "local_golden_dataset_mount_output_outside_control_root",
        ));
    }
    let receipt_output = mount_output.with_file_name(format!(
        "{}.provisioning-receipt.json",
        mount_output
            .file_stem()
            .and_then(|v| v.to_str())
            .unwrap_or_default()
    ));
    let manifest = inspect_dataset(&dataset_root)?;
    let split_input = read_stable_json(
        &options.split_assignments,
        "split_assignments",
        false,
        MAXIMUM_JSON_BYTES,
    )?;
    let harness_input = read_stable_json(
        &options.harness_definition,
        "harness_definition",
        true,
        MAXIMUM_JSON_BYTES,
    )?;
    let analysis_input = read_stable_json(
        &options.analysis_protocol,
        "analysis_protocol",
        false,
        MAXIMUM_JSON_BYTES,
    )?;
    let semantics_input = read_stable_json(
        &options.research_semantics,
        "research_semantics",
        false,
        MAXIMUM_JSON_BYTES,
    )?;
    let trust_input = read_stable_json(
        &options.authority_trust_store,
        "authority_trust_store",
        false,
        MAXIMUM_JSON_BYTES,
    )?;
    selected_trust_key(&trust_input, &options.authority_key_id)?;
    if !exact_keys(&split_input, &["version", "kind", "datasetName", "entries"])
        || split_input["version"] != 1
        || split_input["kind"] != "LocalGoldenDatasetSplitAssignments"
        || split_input["datasetName"] != options.dataset_name
    {
        return Err(error("local_golden_dataset_split_assignments_invalid"));
    }
    let mut assignments = BTreeMap::new();
    for entry in split_input["entries"]
        .as_array()
        .ok_or_else(|| error("local_golden_dataset_split_assignments_invalid"))?
    {
        let path = entry["path"].as_str().unwrap_or_default().to_owned();
        let split = entry["split"].as_str().unwrap_or_default().to_owned();
        if !exact_keys(entry, &["path", "split"])
            || assignments.insert(path, split.clone()).is_some()
            || !["train", "validation", "public"]
                .contains(&entry["split"].as_str().unwrap_or_default())
        {
            return Err(error("local_golden_dataset_split_assignments_invalid"));
        }
    }
    if assignments.len() != manifest.files.len()
        || manifest
            .files
            .keys()
            .any(|path| !assignments.contains_key(path))
    {
        return Err(error("local_golden_dataset_split_assignments_incomplete"));
    }
    let split_entries = manifest
        .files
        .iter()
        .map(|(path, hash)| json!({"path":path,"sha256":hash,"split":assignments[path]}))
        .collect::<Vec<_>>();
    let split_manifest = json!({"version":1,"kind":"OperatorDatasetSplitManifest","datasetName":options.dataset_name,"datasetManifestHash":manifest.hash,"entries":split_entries});
    let split_hash = hash_record("OperatorDatasetSplitManifest", &split_manifest)?;
    let harness = normalize_harness(&harness_input, &options.dataset_name)?;
    let harness_hash = hash_record("OperatorAuthorizedDatasetBenchmarkHarness", &harness)?;
    if !analysis_input.is_object() || analysis_input["version"].is_null() {
        return Err(error("analysis_protocol_invalid"));
    }
    // The incumbent uses the normalized AcademicAnalysisProtocol record kind.
    // Full semantic normalization is still outside this bounded source slice,
    // so callers must provide the canonical protocol object here.
    let analysis_hash = hash_record("AcademicAnalysisProtocol", &analysis_input)?;
    let semantics = normalize_semantics(&semantics_input)?;
    let semantics_hash = hash_record("OperatorDatasetResearchSemantics", &semantics)?;
    let trust_hash = hash_record("LocalGoldenDatasetAuthorityTrustStore", &trust_input)?;
    let (signed_at, expires_at) = validate_time(&options.signed_at, &options.expires_at)?;
    let runtime_scope = json!({"version":1,"kind":"LocalGoldenDatasetRuntimeScope","isolationId":options.isolation_id,"runtimeRootHash":local_runtime_hash(&runtime_root)?});
    let mut payload = json!({"version":1,"kind":"LocalGoldenDatasetProvisioningPlan","datasetName":options.dataset_name,"datasetManifestHash":manifest.hash,"datasetLicenseId":options.dataset_license_id,"splitManifestHash":split_hash,"harnessDefinitionHash":harness_hash,"analysisProtocolHash":analysis_hash,"researchSemanticsHash":semantics_hash,"authorityTrustStoreHash":trust_hash,"authorityKeyId":options.authority_key_id,"authorityKeyPurpose":LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE,"authorityPrivateKeyPathHash":hash_record("LocalGoldenDatasetPrivateKeyPath", &json!({"path":options.authority_private_key.to_string_lossy()}))?,"signedAt":signed_at,"expiresAt":expires_at,"authorityScope":LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE,"evidenceClass":LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS,"academicPromotionEligible":false,"externalTrustClaimed":false,"localGoldenRuntimeScope":runtime_scope,"mountOutputPath":mount_output.to_string_lossy(),"receiptOutputPath":receipt_output.to_string_lossy(),"externalActionPerformed":false});
    let plan_id = hash_record("LocalGoldenDatasetProvisioningPlan", &payload)?;
    payload["localGoldenDatasetProvisioningPlanId"] = Value::String(plan_id);
    payload["ready"] = Value::Bool(true);
    Ok(payload)
}

pub fn execute_local_golden_dataset_provisioning_v1(
    options: &LocalGoldenDatasetProvisioningOptions,
) -> Result<Value> {
    let plan = inspect_local_golden_dataset_provisioning_v1(options)?;
    if options.expected_plan_id.as_deref() != plan["localGoldenDatasetProvisioningPlanId"].as_str()
    {
        return Err(error("local_golden_dataset_provisioning_plan_id_mismatch"));
    }
    Ok(
        json!({"version":1,"kind":"LocalGoldenDatasetProvisioningReceipt","status":"local_golden_dataset_provisioning_blocked","ready":false,"localGoldenDatasetProvisioningPlanId":plan["localGoldenDatasetProvisioningPlanId"],"blockers":[LOCAL_GOLDEN_DATASET_PROVISIONING_BLOCKER],"privateKeyRead":false,"runtimeEvidenceWritten":false,"externalActionPerformed":false}),
    )
}
