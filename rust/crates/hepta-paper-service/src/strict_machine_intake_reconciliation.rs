//! Read-only original-format strict machine-intake reconciliation diagnostics.
//!
//! Record hashes bind data; this module neither publishes receipts nor proves a
//! supervisor cycle ran. The caller supplies its actual intake observation. That
//! observation and this file read are not an atomic cross-file/database snapshot.

use hepta_legacy_compatibility::{production_hash_record_v1, production_stable_json_v1};
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use serde_json::{Value, json};
use std::{
    fs::{self, File, Metadata},
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path, PathBuf},
};

#[cfg(test)]
#[path = "strict_machine_intake_reconciliation/file_tests.rs"]
mod file_tests;

const MAXIMUM_RECEIPT_BYTES: u64 = 2 * 1024 * 1024;
const INNER_KIND: &str = "AutonomousResearchSupervisorMachineIntakeReconciliationReceipt";
const INNER_HASH: &str = "autonomousResearchSupervisorMachineIntakeReconciliationReceiptHash";
const STRICT_KIND: &str = "AutonomousResearchStrictMachineIntakeReconciliationReceipt";
const STRICT_HASH: &str = "autonomousResearchStrictMachineIntakeReconciliationReceiptHash";
const MISSING: &str = "autonomous_research_strict_machine_intake_receipt_missing_or_invalid";
const INVALID: &str = "autonomous_research_strict_machine_intake_receipt_invalid";
const ACCEPTANCE_MISMATCH: &str =
    "autonomous_research_strict_machine_intake_acceptance_binding_mismatch";
const IDENTITY_MISMATCH: &str =
    "autonomous_research_strict_machine_intake_current_identity_mismatch";
const TIME_INVALID: &str = "autonomous_research_strict_machine_intake_inspection_time_invalid";
const RECEIPT_KEYS: [&str; 15] = [
    "acceptancePlanHash",
    "acceptanceStepIdempotencyKey",
    STRICT_HASH,
    "automaticBudgetExpansionPerformed",
    "cycleReceiptHash",
    "externalSubmissionPerformed",
    "kind",
    "machineIntakeConfigurationHash",
    "machineIntakeReconciliationReceipt",
    "observedAt",
    "ready",
    "runtimeRoot",
    "status",
    "topicProducerDatasetSnapshotHash",
    "version",
];

/// Inspect the original published receipt without modifying state or granting
/// authority. `None` expected bindings correspond to absent Node options, not
/// JSON null. Relative roots resolve against the process working directory.
/// All file/directory descriptors close before this function returns. Call it
/// before acquiring caller-owned SQLite connections or long-lived database FDs.
#[must_use]
pub fn inspect_strict_machine_intake_reconciliation_v1(
    runtime_root: &Path,
    acceptance_plan_hash: Option<&str>,
    acceptance_step_idempotency_key: Option<&str>,
    machine_intake: &Value,
    now_millis: i64,
) -> Value {
    let selected_root = absolute_root(runtime_root);
    let observed = selected_root.as_ref().and_then(|root| {
        ObservedReceiptFile::read(
            &root
                .join("strict-full-auto-acceptance")
                .join("machine-intake-reconciliation.json"),
        )
        .ok()
    });
    let receipt = observed
        .as_ref()
        .and_then(|file| serde_json::from_slice::<Value>(&file.bytes).ok());
    let mut blockers = Vec::new();
    if let Some(receipt) = &receipt {
        // Unlike the incumbent's `if (receipt)` guard, falsy parsed JSON always
        // fails validation. A successfully parsed null/false/0 is not readiness.
        if !strict_receipt_valid(receipt) {
            blockers.push(INVALID);
        }
        if js_truthy(receipt) {
            if !optional_string_equal(
                receipt.get("runtimeRoot"),
                selected_root.as_deref().and_then(Path::to_str),
            ) || !optional_string_equal(receipt.get("acceptancePlanHash"), acceptance_plan_hash)
                || !optional_string_equal(
                    receipt.get("acceptanceStepIdempotencyKey"),
                    acceptance_step_idempotency_key,
                )
            {
                blockers.push(ACCEPTANCE_MISMATCH);
            }
            if machine_intake.get("coldStartAutonomyReady") != Some(&Value::Bool(true))
                || !js_strict_equal(
                    machine_intake.get("configurationHash"),
                    receipt.get("machineIntakeConfigurationHash"),
                )
                || !js_strict_equal(
                    machine_intake.get("topicProducerDatasetSnapshotHash"),
                    receipt.get("topicProducerDatasetSnapshotHash"),
                )
            {
                blockers.push(IDENTITY_MISMATCH);
            }
        }
    } else {
        blockers.push(MISSING);
    }
    let inspected_at = crate::sqlite_mutation_coordinator::clock::iso(now_millis).ok();
    if inspected_at.is_none() {
        blockers.push(TIME_INVALID);
    }

    let mut projected_receipt = if blockers.is_empty() {
        receipt.as_ref().and_then(|value| {
            production_stable_json_v1(value)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        })
    } else {
        None
    };
    if blockers.is_empty() && projected_receipt.is_none() {
        blockers.push(INVALID);
    }
    // Recheck the actual held file and original namespace after hash/contract
    // and projection work. This detects observed drift; it does not exclude
    // arbitrary writers, and no retained descriptor escapes this function.
    if observed
        .as_ref()
        .is_some_and(|file| file.assert_current().is_err())
        && !blockers.contains(&MISSING)
    {
        blockers.insert(0, MISSING);
        projected_receipt = None;
    }
    drop(observed);
    let ready = blockers.is_empty();
    json!({
        "version": 1,
        "kind": "AutonomousResearchStrictMachineIntakeReconciliationStatus",
        "status": if ready {
            "autonomous_research_strict_machine_intake_reconciliation_ready"
        } else {
            "autonomous_research_strict_machine_intake_reconciliation_blocked"
        },
        "ready": ready,
        "receipt": projected_receipt,
        "inspectedAt": inspected_at,
        "statusReadOnly": true,
        "blockers": blockers,
    })
}

fn canonical_timestamp(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .and_then(crate::journal_connector_coverage::qualification::canonical_instant_millis)
        .is_some()
}

// Node applies String(value || '') before its case-insensitive SHA regex. JSON
// singleton arrays recursively stringify to their element; other nonstrings
// cannot match a SHA string. The claimed record hash separately requires a string
// because Node's final comparison is strict equality with the computed string.
fn sha_like(value: Option<&Value>) -> bool {
    let mut value = value;
    loop {
        match value {
            Some(Value::String(text)) => {
                return text.len() == 71
                    && text
                        .get(..7)
                        .is_some_and(|s| s.eq_ignore_ascii_case("sha256:"))
                    && text.as_bytes()[7..].iter().all(u8::is_ascii_hexdigit);
            }
            Some(Value::Array(items)) if items.len() == 1 => value = items.first(),
            _ => return false,
        }
    }
}

fn record_hash_valid(receipt: &Value, kind: &str, hash_key: &str) -> bool {
    let Some(mut payload) = receipt.as_object().cloned() else {
        return false;
    };
    let Some(Value::String(claimed)) = payload.remove(hash_key) else {
        return false;
    };
    production_hash_record_v1(kind, &Value::Object(payload))
        .is_ok_and(|actual| actual.as_str() == claimed)
}

fn reconciliation_receipt_valid(receipt: &Value) -> bool {
    receipt.get("version").and_then(Value::as_f64) == Some(1.0)
        && receipt.get("kind").and_then(Value::as_str) == Some(INNER_KIND)
        && sha_like(receipt.get("machineIntakeConfigurationHash"))
        && (receipt.get("topicProducerDatasetSnapshotHash") == Some(&Value::Null)
            || sha_like(receipt.get("topicProducerDatasetSnapshotHash")))
        && sha_like(receipt.get("machineIntakeCycleResultHash"))
        && canonical_timestamp(receipt.get("reconciledAt"))
        && receipt.get("externalSubmissionPerformed") == Some(&Value::Bool(false))
        && receipt.get("automaticBudgetExpansionPerformed") == Some(&Value::Bool(false))
        && sha_like(receipt.get(INNER_HASH))
        // The original inner contract deliberately has no exact-key check:
        // additional fields are accepted only when included in this real hash.
        && record_hash_valid(receipt, INNER_KIND, INNER_HASH)
}

fn strict_receipt_valid(receipt: &Value) -> bool {
    let Some(fields) = receipt.as_object() else {
        return false;
    };
    let Some(inner) = fields.get("machineIntakeReconciliationReceipt") else {
        return false;
    };
    fields.len() == RECEIPT_KEYS.len()
        && RECEIPT_KEYS.iter().all(|key| fields.contains_key(*key))
        && receipt.get("version").and_then(Value::as_f64) == Some(1.0)
        && receipt.get("kind").and_then(Value::as_str) == Some(STRICT_KIND)
        && receipt.get("status").and_then(Value::as_str)
            == Some("autonomous_research_strict_machine_intake_reconciled")
        && receipt.get("ready") == Some(&Value::Bool(true))
        && js_string_starts_with_slash(receipt.get("runtimeRoot"))
        && sha_like(receipt.get("acceptancePlanHash"))
        && sha_like(receipt.get("acceptanceStepIdempotencyKey"))
        && sha_like(receipt.get("cycleReceiptHash"))
        && reconciliation_receipt_valid(inner)
        && js_strict_equal(
            receipt.get("machineIntakeConfigurationHash"),
            inner.get("machineIntakeConfigurationHash"),
        )
        && js_strict_equal(
            receipt.get("topicProducerDatasetSnapshotHash"),
            inner.get("topicProducerDatasetSnapshotHash"),
        )
        && canonical_timestamp(receipt.get("observedAt"))
        && receipt.get("externalSubmissionPerformed") == Some(&Value::Bool(false))
        && receipt.get("automaticBudgetExpansionPerformed") == Some(&Value::Bool(false))
        && sha_like(receipt.get(STRICT_HASH))
        && record_hash_valid(receipt, STRICT_KIND, STRICT_HASH)
}

fn optional_string_equal(value: Option<&Value>, expected: Option<&str>) -> bool {
    match (value, expected) {
        (None, None) => true,
        (Some(Value::String(value)), Some(expected)) => value == expected,
        _ => false,
    }
}

// POSIX path.isAbsolute(String(value || '')) only observes the first character.
// Array stringification begins with its first item's string (then commas), so
// this also preserves unusual but accepted array-shaped Node validator inputs.
fn js_string_starts_with_slash(mut value: Option<&Value>) -> bool {
    loop {
        match value {
            Some(Value::String(text)) => return text.starts_with('/'),
            Some(Value::Array(items)) => value = items.first(),
            _ => return false,
        }
    }
}

fn js_strict_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(left)), Some(Value::Bool(right))) => left == right,
        (Some(Value::Number(left)), Some(Value::Number(right))) => left.as_f64() == right.as_f64(),
        (Some(Value::String(left)), Some(Value::String(right))) => left == right,
        (Some(left @ Value::Array(_)), Some(right @ Value::Array(_)))
        | (Some(left @ Value::Object(_)), Some(right @ Value::Object(_))) => {
            std::ptr::eq(left, right)
        }
        _ => false,
    }
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn absolute_root(path: &Path) -> Option<PathBuf> {
    let joined = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    joined.to_str()?;
    let mut result = PathBuf::from("/");
    for part in joined.components() {
        match part {
            Component::Normal(name) => result.push(name),
            Component::ParentDir => {
                result.pop();
            }
            Component::RootDir | Component::CurDir => (),
            _ => return None,
        }
    }
    Some(result)
}

struct ObservedReceiptFile {
    bytes: Vec<u8>,
    file: File,
    path: PathBuf,
    before: Metadata,
    parents: Vec<(PathBuf, File, Metadata)>,
}

impl ObservedReceiptFile {
    fn read(path: &Path) -> Result<Self, ()> {
        let directory_flags =
            OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let mut directory =
            File::from(open(Path::new("/"), directory_flags, Mode::empty()).map_err(|_| ())?);
        let mut cursor = PathBuf::from("/");
        let mut parents = Vec::new();
        let mut parts = path
            .components()
            .filter_map(|component| match component {
                Component::Normal(part) => Some(part),
                _ => None,
            })
            .peekable();
        let mut selected = None;
        while let Some(part) = parts.next() {
            let last = parts.peek().is_none();
            let flags = if last {
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC
            } else {
                directory_flags
            };
            let next = File::from(
                openat(directory.as_fd(), Path::new(part), flags, Mode::empty()).map_err(|_| ())?,
            );
            let metadata = directory.metadata().map_err(|_| ())?;
            parents.push((cursor.clone(), directory, metadata));
            cursor.push(part);
            if last {
                selected = Some(next);
                break;
            }
            directory = next;
        }
        let mut file = selected.ok_or(())?;
        let before = file.metadata().map_err(|_| ())?;
        if !before.is_file()
            || before.mode() & 0o022 != 0
            || !(2..=MAXIMUM_RECEIPT_BYTES).contains(&before.len())
        {
            return Err(());
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take(MAXIMUM_RECEIPT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if bytes.len() as u64 != before.len() || bytes.len() as u64 > MAXIMUM_RECEIPT_BYTES {
            return Err(());
        }
        let observed = Self {
            bytes,
            file,
            path: path.to_owned(),
            before,
            parents,
        };
        observed.assert_current()?;
        Ok(observed)
    }

    fn assert_current(&self) -> Result<(), ()> {
        for (path, held, before) in &self.parents {
            let named = fs::symlink_metadata(path).map_err(|_| ())?;
            let opened = held.metadata().map_err(|_| ())?;
            if !same_directory(before, &opened) || !same_directory(before, &named) {
                return Err(());
            }
        }
        if !same_file(&self.before, &self.file.metadata().map_err(|_| ())?)
            || !same_file(
                &self.before,
                &fs::symlink_metadata(&self.path).map_err(|_| ())?,
            )
        {
            return Err(());
        }
        Ok(())
    }
}

fn same_directory(before: &Metadata, now: &Metadata) -> bool {
    now.is_dir()
        && !now.is_symlink()
        && before.dev() == now.dev()
        && before.ino() == now.ino()
        && before.mode() == now.mode()
        && before.uid() == now.uid()
        && before.gid() == now.gid()
}

fn same_file(before: &Metadata, now: &Metadata) -> bool {
    before.dev() == now.dev()
        && before.ino() == now.ino()
        && before.mode() == now.mode()
        && before.nlink() == now.nlink()
        && before.uid() == now.uid()
        && before.gid() == now.gid()
        && before.len() == now.len()
        && before.mtime() == now.mtime()
        && before.mtime_nsec() == now.mtime_nsec()
        && before.ctime() == now.ctime()
        && before.ctime_nsec() == now.ctime_nsec()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bind_hash(value: &mut Value, kind: &str, key: &str) {
        value.as_object_mut().expect("fixture object").remove(key);
        value[key] = json!(
            production_hash_record_v1(kind, value)
                .expect("real production hash")
                .as_str()
        );
    }

    fn contract_fixture() -> Value {
        let hash = format!("SHA256:{}", "A".repeat(64));
        let mut inner = json!({
            "version": 1.0,
            "kind": INNER_KIND,
            "machineIntakeConfigurationHash": hash,
            "topicProducerDatasetSnapshotHash": null,
            "machineIntakeCycleResultHash": [[hash]],
            "reconciledAt": "2026-01-01T00:00:00.000Z",
            "externalSubmissionPerformed": false,
            "automaticBudgetExpansionPerformed": false,
            "extraInnerData": {"includedInHash": true},
        });
        bind_hash(&mut inner, INNER_KIND, INNER_HASH);
        let mut receipt = json!({
            "version": 1.0,
            "kind": STRICT_KIND,
            "status": "autonomous_research_strict_machine_intake_reconciled",
            "ready": true,
            "runtimeRoot": "/fixture",
            "acceptancePlanHash": hash,
            "acceptanceStepIdempotencyKey": hash,
            "cycleReceiptHash": [hash],
            "machineIntakeConfigurationHash": hash,
            "topicProducerDatasetSnapshotHash": null,
            "machineIntakeReconciliationReceipt": inner,
            "observedAt": "2026-01-01T00:00:00.000Z",
            "externalSubmissionPerformed": false,
            "automaticBudgetExpansionPerformed": false,
        });
        bind_hash(&mut receipt, STRICT_KIND, STRICT_HASH);
        receipt
    }

    #[test]
    fn real_production_hash_binds_inner_extra_fields_and_outer_exact_keys() {
        // This is a data-contract fixture, not proof of a running supervisor.
        let mut receipt = contract_fixture();
        assert!(strict_receipt_valid(&receipt));
        receipt["machineIntakeReconciliationReceipt"]["extraInnerData"]["includedInHash"] =
            json!(false);
        bind_hash(&mut receipt, STRICT_KIND, STRICT_HASH);
        assert!(!strict_receipt_valid(&receipt));
        bind_hash(
            &mut receipt["machineIntakeReconciliationReceipt"],
            INNER_KIND,
            INNER_HASH,
        );
        bind_hash(&mut receipt, STRICT_KIND, STRICT_HASH);
        assert!(strict_receipt_valid(&receipt));
        receipt["unexpectedOuterField"] = json!(true);
        bind_hash(&mut receipt, STRICT_KIND, STRICT_HASH);
        assert!(!strict_receipt_valid(&receipt));
    }

    #[test]
    fn missing_nullable_field_and_array_identity_are_not_json_null_or_equal_strings() {
        let mut receipt = contract_fixture();
        receipt["machineIntakeReconciliationReceipt"]
            .as_object_mut()
            .expect("inner object")
            .remove("topicProducerDatasetSnapshotHash");
        bind_hash(
            &mut receipt["machineIntakeReconciliationReceipt"],
            INNER_KIND,
            INNER_HASH,
        );
        bind_hash(&mut receipt, STRICT_KIND, STRICT_HASH);
        assert!(!strict_receipt_valid(&receipt));
        let mut receipt = contract_fixture();
        let hash = receipt["machineIntakeConfigurationHash"].clone();
        receipt["machineIntakeConfigurationHash"] = json!([hash]);
        receipt["machineIntakeReconciliationReceipt"]["machineIntakeConfigurationHash"] =
            json!([hash]);
        bind_hash(
            &mut receipt["machineIntakeReconciliationReceipt"],
            INNER_KIND,
            INNER_HASH,
        );
        bind_hash(&mut receipt, STRICT_KIND, STRICT_HASH);
        assert!(!strict_receipt_valid(&receipt));
    }

    #[test]
    fn strict_and_inner_shape_guards_do_not_treat_falsy_json_as_receipts() {
        for value in [
            Value::Null,
            json!(false),
            json!(0),
            json!(""),
            json!([]),
            json!({}),
        ] {
            assert!(!strict_receipt_valid(&value));
            assert!(!reconciliation_receipt_valid(&value));
        }
    }

    #[test]
    fn case_insensitive_sha_coercion_does_not_conflate_json_object_identity() {
        let hash = format!("SHA256:{}", "A".repeat(64));
        assert!(sha_like(Some(&json!(hash))));
        assert!(sha_like(Some(&json!([[hash]]))));
        assert!(!sha_like(Some(&json!([hash, ""]))));
        assert!(!sha_like(Some(&json!(null))));
        let left = json!([hash]);
        let right = left.clone();
        assert!(!js_strict_equal(Some(&left), Some(&right)));
        assert!(js_strict_equal(Some(&left), Some(&left)));
        assert!(!js_strict_equal(None, Some(&Value::Null)));
        assert!(js_strict_equal(Some(&json!(1)), Some(&json!(1.0))));
    }

    #[test]
    fn canonical_timestamp_and_absent_expected_options_keep_original_contract() {
        assert!(canonical_timestamp(Some(&json!(
            "2026-01-01T00:00:00.000Z"
        ))));
        assert!(!canonical_timestamp(Some(&json!("2026-01-01T00:00:00Z"))));
        assert!(!canonical_timestamp(Some(&json!(
            "2026-02-29T00:00:00.000Z"
        ))));
        assert!(optional_string_equal(None, None));
        assert!(!optional_string_equal(Some(&Value::Null), None));
        assert!(!optional_string_equal(Some(&json!(["hash"])), Some("hash")));
    }
}
