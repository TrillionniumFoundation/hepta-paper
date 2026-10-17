//! The retired local runner-contract writer, confined to an existing private
//! policy tree. A local JSON artifact never grants executor or external authority.
use super::{error, facts::relative};
use crate::state_recoverability::publication::Directory;
use nix::{
    fcntl::{OFlag, openat},
    sys::stat::Mode,
};
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::{Read, Seek, Write},
    os::{
        fd::AsFd,
        unix::fs::{FileExt, MetadataExt},
    },
    path::Path,
};

pub(super) const LOCAL_WRITER: &str =
    "paperctl_modules/paper_production_runner_execution_contract_artifact_queue.py";
const CONTRACT_ROOT: &str = "logs/paperctl/_contracts/runner_execution";
const CONTRACT_SCHEMA: &str =
    "paper_factory.paper_production.runner_execution_contract_artifact.v1";
const REPORT_SCHEMA: &str =
    "paper_factory.paper_production.runner_execution_contract_artifact_queue.v1";
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MANUAL_BOUNDARY: &[&str] = &[
    "This queue materializes and validates local runner contract files only.",
    "A valid delegated runner contract file does not authorize dispatch and does not make the runner executable; external lifecycle readiness is still required by the runner execution contract matrix.",
    "This command never creates approval/fresh evidence, source packets, action manifests, outbox entries, receipts, archives, reconciliation records, settlement, uploads, emails, portal submissions, or external actions.",
];
fn invalid() -> String {
    error("native_runner_contract_input_invalid")
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => {
            v.as_i64().is_some_and(|v| v != 0) || v.as_u64().is_some_and(|v| v != 0)
        }
        Value::String(v) => !v.is_empty(),
        Value::Array(v) => !v.is_empty(),
        Value::Object(v) => !v.is_empty(),
    }
}
fn text(value: &Value) -> String {
    value
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or("")
        .to_owned()
}
fn default_text(value: &Value, default: &str) -> String {
    if truthy(value) {
        text(value)
    } else {
        default.into()
    }
}
fn count(value: &Value) -> i64 {
    match value {
        Value::Bool(v) => i64::from(*v),
        Value::Number(v) => v.as_i64().unwrap_or(0),
        Value::String(v) => v.trim().parse().unwrap_or(0),
        _ => 0,
    }
}
fn input_bounds(value: &Value, depth: usize, count: &mut usize) -> Result<(), String> {
    *count += 1;
    if depth > 16 || *count > 8192 {
        return Err(invalid());
    }
    match value {
        Value::Number(v) if !v.is_i64() && !v.is_u64() => return Err(invalid()),
        Value::String(v) if v.len() > 4096 || v.contains('\0') => return Err(invalid()),
        Value::Array(v) if v.len() > 256 => return Err(invalid()),
        Value::Array(v) => {
            for item in v {
                input_bounds(item, depth + 1, count)?;
            }
        }
        Value::Object(v) if v.len() > 128 => return Err(invalid()),
        Value::Object(v) => {
            for (key, item) in v {
                if key.len() > 256 {
                    return Err(invalid());
                }
                input_bounds(item, depth + 1, count)?;
            }
        }
        _ => {}
    }
    Ok(())
}
// Python's fixed integer/string corpus uses sort_keys=True and ensure_ascii=True.
// Serialize that domain exactly, including UTF-16 surrogate escapes for astral text.
fn ascii_string(value: &str, out: &mut String) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (' '..='~').contains(&c) => out.push(c),
            c => {
                for unit in c.encode_utf16(&mut [0; 2]) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
        }
    }
    out.push('"');
}
fn ascii_json(value: &Value, out: &mut String, pretty: bool, depth: usize) -> Result<(), String> {
    let separator = if pretty { ": " } else { ":" };
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(v) => out.push_str(if *v { "true" } else { "false" }),
        Value::Number(v) => {
            if !v.is_i64() && !v.is_u64() {
                return Err(invalid());
            }
            out.push_str(&v.to_string());
        }
        Value::String(v) => ascii_string(v, out),
        Value::Array(values) => {
            out.push('[');
            for (index, item) in values.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                if pretty {
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth + 1));
                }
                ascii_json(item, out, pretty, depth + 1)?;
            }
            if pretty && !values.is_empty() {
                out.push('\n');
                out.push_str(&"  ".repeat(depth));
            }
            out.push(']');
        }
        Value::Object(values) => {
            out.push('{');
            let mut ordered: Vec<_> = values.iter().collect();
            ordered.sort_by(|a, b| a.0.cmp(b.0));
            for (index, (key, item)) in ordered.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                if pretty {
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth + 1));
                }
                ascii_string(key, out);
                out.push_str(separator);
                ascii_json(item, out, pretty, depth + 1)?;
            }
            if pretty && !values.is_empty() {
                out.push('\n');
                out.push_str(&"  ".repeat(depth));
            }
            out.push('}');
        }
    }
    Ok(())
}
fn stable_hash(kind: &str, payload: &Value) -> Result<String, String> {
    let mut encoded = String::new();
    ascii_json(
        &json!({"kind":kind,"payload":payload}),
        &mut encoded,
        false,
        0,
    )?;
    Ok(super::digest(encoded.as_bytes())
        .trim_start_matches("sha256:")
        .into())
}
fn payload(record: &Value, label: &str, target_hash: &str) -> Result<Value, String> {
    let kind = text(&record["contract_kind"]);
    let live = kind == "live_entrypoint_adapter";
    let id = text(&record["expected_contract_id"]);
    let mut value = json!({"schema_id":CONTRACT_SCHEMA,"contract_id":id,"route_id":text(&record["route_id"]),"command":text(&record["command"]),"runner_lane":text(&record["runner_lane"]),"contract_kind":kind,"target_label":label,"target_slug_set_hash":target_hash,"external_lifecycle_stage":text(&record["external_lifecycle_stage"]),"external_lifecycle_readiness_report":text(&record["external_lifecycle_readiness_report"]),"required_contract_fields":record.get("required_contract_fields").filter(|v|truthy(v)).cloned().unwrap_or(json!([])),"validation_sequence":record.get("validation_sequence").filter(|v|truthy(v)).cloned().unwrap_or(json!([])),"source_authoring_record_hash":text(&record["matrix_hash"]),"no_external_action_authorized":true,"no_external_action_performed":true,"external_action_authorized":false,"external_action_performed":false,"report_only_boundary":true,"contract_artifact_only":true,"does_not_make_runner_executable":true,"does_not_create_outbox":true,"does_not_create_receipt_or_closure":true,"execution_blocked_until_external_lifecycle_ready":!live});
    if live {
        value["adapter_contract_id"] = json!(id);
        value["entrypoint"] = json!(text(&record["entrypoint"]));
        value["execution_mode"] = json!("live");
    } else {
        value["delegated_contract_id"] = json!(id);
    }
    value["contract_payload_sha256"] = json!(stable_hash(
        "runner_execution_contract_artifact_payload",
        &value
    )?);
    Ok(value)
}
fn validate(value: &Value, expected: &Value, record: &Value) -> Result<Vec<String>, String> {
    let mut issues = Vec::new();
    if value["schema_id"] != CONTRACT_SCHEMA {
        issues.push("schema_id_mismatch".into());
    }
    for key in [
        "contract_id",
        "route_id",
        "command",
        "runner_lane",
        "contract_kind",
        "target_label",
        "target_slug_set_hash",
        "external_lifecycle_stage",
        "external_lifecycle_readiness_report",
    ] {
        if value.get(key) != expected.get(key) {
            issues.push(format!("{key}_mismatch"));
        }
    }
    for field in record
        .get("required_contract_fields")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let field = field.as_str().ok_or_else(invalid)?;
        if value.get(field).is_none() {
            issues.push(format!("required_field_missing:{field}"));
        }
    }
    for key in [
        "no_external_action_authorized",
        "no_external_action_performed",
        "report_only_boundary",
        "contract_artifact_only",
        "does_not_make_runner_executable",
    ] {
        if value.get(key) != Some(&Value::Bool(true)) {
            issues.push(format!("{key}_not_true"));
        }
    }
    for key in ["external_action_authorized", "external_action_performed"] {
        if value.get(key) != Some(&Value::Bool(false)) {
            issues.push(format!("{key}_not_false"));
        }
    }
    if value.get("contract_payload_sha256") != expected.get("contract_payload_sha256") {
        issues.push("contract_payload_sha256_mismatch".into());
    }
    Ok(issues)
}
fn same(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    super::super::same(a, b)
}
fn read_file(directory: &Directory, name: &str) -> Result<(File, fs::Metadata, Vec<u8>), String> {
    directory
        .assert_current()
        .map_err(|_| error("native_runner_contract_path_changed"))?;
    let mut file = File::from(
        openat(
            directory.held.as_fd(),
            name,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| error("native_runner_contract_file_unsafe"))?,
    );
    let metadata = file.metadata().map_err(|_| invalid())?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != nix::unistd::getuid().as_raw()
        || metadata.len() > MAX_FILE_BYTES
    {
        return Err(error("native_runner_contract_file_unsafe"));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() as u64 != metadata.len()
        || !same(&metadata, &file.metadata().map_err(|_| invalid())?)
        || !same(
            &metadata,
            &fs::symlink_metadata(directory.path.join(name)).map_err(|_| invalid())?,
        )
    {
        return Err(error("native_runner_contract_file_changed"));
    }
    Ok((file, metadata, bytes))
}
pub(super) struct ObservedArtifact {
    directory: Directory,
    name: String,
    file: File,
    metadata: fs::Metadata,
    pub bytes: Vec<u8>,
}
impl ObservedArtifact {
    pub(super) fn assert_current(&self) -> Result<(), String> {
        assert_retained_file(
            &self.directory,
            &self.name,
            &self.file,
            &self.metadata,
            &self.bytes,
        )
    }
}
fn assert_retained_file(
    directory: &Directory,
    name: &str,
    file: &File,
    metadata: &fs::Metadata,
    bytes: &[u8],
) -> Result<(), String> {
    directory.assert_current().map_err(|_| invalid())?;
    if metadata.len() != bytes.len() as u64 {
        return Err(error("native_runner_contract_file_changed"));
    }
    for after in [false, true] {
        if !same(metadata, &file.metadata().map_err(|_| invalid())?)
            || !same(
                metadata,
                &fs::symlink_metadata(directory.path.join(name)).map_err(|_| invalid())?,
            )
        {
            return Err(error("native_runner_contract_file_changed"));
        }
        if !after {
            let mut buffer = [0; 64 * 1024];
            for (index, expected) in bytes.chunks(buffer.len()).enumerate() {
                file.read_exact_at(&mut buffer[..expected.len()], (index * 64 * 1024) as u64)
                    .map_err(|_| invalid())?;
                if &buffer[..expected.len()] != expected {
                    return Err(error("native_runner_contract_file_changed"));
                }
            }
        }
    }
    directory.assert_current().map_err(|_| invalid())
}
pub(super) fn observe_artifact(
    root: &Directory,
    selected: &str,
) -> Result<ObservedArtifact, String> {
    root.assert_current().map_err(|_| invalid())?;
    if !relative(selected) || !selected.starts_with(&format!("{CONTRACT_ROOT}/")) {
        return Err(invalid());
    }
    let path = root.path.join(selected);
    let directory = Directory::open_or_create(path.parent().ok_or_else(invalid)?, false)
        .map_err(|_| invalid())?;
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(invalid)?
        .to_owned();
    let (file, metadata, bytes) = read_file(&directory, &name)?;
    let observed = ObservedArtifact {
        directory,
        name,
        file,
        metadata,
        bytes,
    };
    observed.assert_current()?;
    root.assert_current().map_err(|_| invalid())?;
    Ok(observed)
}
fn encode_payload(value: &Value) -> Result<Vec<u8>, String> {
    let mut encoded = String::new();
    ascii_json(value, &mut encoded, true, 0)?;
    encoded.push('\n');
    Ok(encoded.into_bytes())
}
fn artifact(
    root: &Directory,
    record: &Value,
    label: &str,
    target_hash: &str,
    materialize: bool,
) -> Result<Value, String> {
    root.assert_current().map_err(|_| invalid())?;
    let selected = text(&record["expected_contract_path"]);
    let path = root.path.join(&selected);
    let mut issues = Vec::<String>::new();
    let mut materialized = false;
    let safe = relative(&selected) && selected.starts_with(&format!("{CONTRACT_ROOT}/"));
    if selected.is_empty() {
        issues.push("expected_contract_path_missing".into());
    } else if Path::new(&selected).is_absolute() {
        issues.push("expected_contract_path_absolute".into());
    } else if !safe {
        issues.push("expected_contract_path_outside_contract_root".into());
    }
    let expected = payload(record, label, target_hash)?;
    let mut sha = String::new();
    let mut bytes = 0u64;
    let mut present = false;
    let mut symlink = false;
    // Unsafe names never become read/write targets. They remain invalid records.
    if safe {
        let parent = path.parent().ok_or_else(invalid)?;
        let name = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(invalid)?;
        let exists = match fs::symlink_metadata(&path) {
            Ok(m) => Some(m),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(error("native_runner_contract_file_unsafe")),
        };
        if materialize && exists.is_none() {
            let directory = Directory::open_or_create(parent, true).map_err(|_| invalid())?;
            directory
                .write_new(name, &encode_payload(&expected)?)
                .map_err(|_| invalid())?;
            materialized = true;
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(m) => Some(m),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(error("native_runner_contract_file_unsafe")),
        };
        if let Some(m) = metadata {
            symlink = m.is_symlink();
            present = m.is_file() || symlink;
            if symlink {
                issues.push("contract_path_is_symlink".into());
            } else if m.is_file() {
                let directory = Directory::open_or_create(parent, false).map_err(|_| invalid())?;
                let (file, metadata, mut raw) = read_file(&directory, name)?;
                bytes = metadata.len();
                match serde_json::from_slice::<Value>(&raw) {
                    Ok(value) if value.is_object() => {
                        let found = validate(&value, &expected, record)?;
                        issues.extend(found.iter().cloned());
                        if materialize
                            && !found.is_empty()
                            && issues.iter().all(|v| {
                                [
                                    "contract_payload_sha256_mismatch",
                                    "external_lifecycle_readiness_report_mismatch",
                                ]
                                .contains(&v.as_str())
                            })
                        {
                            let replacement = encode_payload(&expected)?;
                            if !same(
                                &metadata,
                                &fs::symlink_metadata(&path).map_err(|_| invalid())?,
                            ) || !same(&metadata, &file.metadata().map_err(|_| invalid())?)
                            {
                                return Err(error("native_runner_contract_file_changed"));
                            }
                            let mut writable = File::from(
                                openat(
                                    directory.held.as_fd(),
                                    name,
                                    OFlag::O_WRONLY
                                        | OFlag::O_NOFOLLOW
                                        | OFlag::O_NONBLOCK
                                        | OFlag::O_CLOEXEC,
                                    Mode::empty(),
                                )
                                .map_err(|_| error("native_runner_contract_file_unsafe"))?,
                            );
                            if !same(&metadata, &writable.metadata().map_err(|_| invalid())?) {
                                return Err(error("native_runner_contract_file_changed"));
                            }
                            writable.rewind().map_err(|_| invalid())?;
                            writable.write_all(&replacement).map_err(|_| invalid())?;
                            writable
                                .set_len(replacement.len() as u64)
                                .map_err(|_| invalid())?;
                            writable.sync_all().map_err(|_| invalid())?;
                            let current = file.metadata().map_err(|_| invalid())?;
                            if current.dev() != metadata.dev()
                                || current.ino() != metadata.ino()
                                || current.mode() != metadata.mode()
                                || current.uid() != metadata.uid()
                                || current.gid() != metadata.gid()
                                || current.nlink() != 1
                                || !current.is_file()
                                || !same(&current, &writable.metadata().map_err(|_| invalid())?)
                            {
                                return Err(error("native_runner_contract_file_changed"));
                            }
                            assert_retained_file(&directory, name, &file, &current, &replacement)?;
                            raw = replacement;
                            bytes = raw.len() as u64;
                            issues.clear();
                            materialized = true;
                        }
                    }
                    Ok(_) => issues.push("contract_json_not_object".into()),
                    Err(_) => {
                        issues.push("contract_json_unreadable".into());
                        issues.extend(validate(&json!({}), &expected, record)?);
                    }
                }
                if issues.is_empty() {
                    sha = super::digest(&raw).trim_start_matches("sha256:").into();
                }
                directory.assert_current().map_err(|_| invalid())?;
            }
        }
    }
    root.assert_current().map_err(|_| invalid())?;
    issues.sort();
    issues.dedup();
    let valid = present && issues.is_empty();
    Ok(
        json!({"route_id":text(&record["route_id"]),"command":text(&record["command"]),"contract_kind":text(&record["contract_kind"]),"contract_id":text(&record["expected_contract_id"]),"contract_path":selected,"external_lifecycle_stage":text(&record["external_lifecycle_stage"]),"authoring_surface_ready":truthy(&record["authoring_surface_ready"]),"materialized_by_command":materialized,"contract_artifact_present":present,"contract_artifact_valid":valid,"contract_artifact_sha256":sha,"byte_count":bytes,"identity_ready":present&&!symlink&&safe,"validation_issues":issues,"expected_contract_payload_sha256":expected["contract_payload_sha256"],"artifact_record_hash":stable_hash("runner_execution_contract_artifact_record",&json!({"route_id":text(&record["route_id"]),"contract_id":text(&record["expected_contract_id"]),"path":selected,"valid":valid}))?}),
    )
}
pub(super) fn materialize(
    root: &Directory,
    target: &Value,
    authoring: &Value,
    upstream: &Value,
    label: &str,
    write: bool,
    created_at: &str,
) -> Result<Value, String> {
    for input in [target, authoring, upstream] {
        input_bounds(input, 0, &mut 0)?;
    }
    if !target.is_null() && !target.is_object()
        || !authoring.is_null() && !authoring.is_object()
        || !upstream.is_null() && !upstream.is_object()
        || label.len() > 4096
        || created_at.is_empty()
        || created_at.len() > 128
    {
        return Err(invalid());
    }
    let target_status = default_text(&target["status"], "MISSING");
    let target_state = text(&target["target_scope_state"]);
    let target_count = count(&target["summary"]["target_paper_count"]);
    let target_hash = text(&target["summary"]["target_slug_set_hash"]);
    let target_ready = target_status == "PASS"
        && target_state == "TARGET_SCOPE_RESOLVED"
        && target_count > 0
        && target_hash.chars().count() == 64;
    let authoring_status = default_text(&authoring["status"], "MISSING");
    let authoring_state = text(&authoring["runner_execution_contract_authoring_surface_state"]);
    let authoring_ready = truthy(&authoring["summary"]["authoring_surface_ready"]);
    let label = if label.is_empty() {
        text(&authoring["label"])
    } else {
        label.into()
    };
    let mut records = Vec::new();
    for row in authoring
        .get("authoring_surface_matrix")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        if row.is_object() && truthy(&row["authoring_surface_ready"]) {
            for key in ["required_contract_fields", "validation_sequence"] {
                if let Some(value) = row.get(key).filter(|v| truthy(v))
                    && value
                        .as_array()
                        .is_none_or(|v| v.iter().any(|v| !v.is_string()))
                {
                    return Err(invalid());
                }
            }
            records.push(artifact(
                root,
                row,
                &label,
                &target_hash,
                write && target_ready && authoring_ready,
            )?);
        }
    }
    let present = records
        .iter()
        .filter(|v| v["contract_artifact_present"] == true)
        .count();
    let valid = records
        .iter()
        .filter(|v| v["contract_artifact_valid"] == true)
        .count();
    let written = records
        .iter()
        .filter(|v| v["materialized_by_command"] == true)
        .count();
    let missing: Vec<_> = records
        .iter()
        .filter(|v| v["contract_artifact_present"] != true)
        .collect();
    let invalid_records: Vec<_> = records
        .iter()
        .filter(|v| v["contract_artifact_present"] == true && v["contract_artifact_valid"] != true)
        .collect();
    let forbidden = records
        .iter()
        .filter(|v| {
            v["external_action_authorized"] == true || v["external_action_performed"] == true
        })
        .count();
    let ready = target_ready
        && authoring_status == "PASS"
        && authoring_ready
        && !records.is_empty()
        && valid == records.len()
        && forbidden == 0;
    let mut checks = Vec::new();
    for (name, ok, detail) in [
        (
            "target_scope_resolved",
            target_ready,
            format!(
                "status={target_status} state={} papers={target_count}",
                if target_state.is_empty() {
                    "-"
                } else {
                    &target_state
                }
            ),
        ),
        (
            "authoring_surface_ready",
            authoring_status == "PASS" && authoring_ready,
            format!(
                "status={authoring_status} state={} ready={}",
                if authoring_state.is_empty() {
                    "-"
                } else {
                    &authoring_state
                },
                if authoring_ready { "True" } else { "False" }
            ),
        ),
        (
            "contract_artifacts_present",
            !records.is_empty() && missing.is_empty(),
            format!("present={present}/{}", records.len()),
        ),
        (
            "contract_artifacts_valid",
            !records.is_empty() && invalid_records.is_empty() && valid == records.len(),
            format!(
                "valid={valid}/{} invalid={}",
                records.len(),
                invalid_records.len()
            ),
        ),
        (
            "no_external_action_or_dispatch_leak",
            forbidden == 0,
            format!("forbidden={forbidden}"),
        ),
    ] {
        checks.push(
            json!({"name":name,"status":if ok{"PASS"}else{"FAIL"},"detail":detail,"blocking":true}),
        );
    }
    let failed: Vec<_> = checks
        .iter()
        .filter(|v| v["status"] != "PASS")
        .cloned()
        .collect();
    let state = if forbidden > 0 {
        "BLOCKED_RUNNER_EXECUTION_CONTRACT_ARTIFACT_ACTION_LEAK"
    } else if !target_ready {
        "BLOCKED_RUNNER_EXECUTION_CONTRACT_ARTIFACT_TARGET_SCOPE"
    } else if authoring_status != "PASS" || !authoring_ready || records.is_empty() {
        "BLOCKED_RUNNER_EXECUTION_CONTRACT_ARTIFACT_AUTHORING_SURFACE"
    } else if !missing.is_empty() {
        "BLOCKED_RUNNER_EXECUTION_CONTRACT_ARTIFACT_FILES_MISSING"
    } else if !invalid_records.is_empty() {
        "BLOCKED_RUNNER_EXECUTION_CONTRACT_ARTIFACT_FILES_INVALID"
    } else {
        "RUNNER_EXECUTION_CONTRACT_ARTIFACT_QUEUE_READY"
    };
    let queue=Value::Array(records.iter().map(|v|json!({"route_id":v["route_id"],"contract_id":v["contract_id"],"valid":v["contract_artifact_valid"],"sha":v["contract_artifact_sha256"]})).collect());
    Ok(
        json!({"schema_id":REPORT_SCHEMA,"command":"paper-production-runner-execution-contract-artifact-queue","status":if ready&&failed.is_empty(){"PASS"}else{"FAIL"},"label":label,"created_at":created_at,"runner_execution_contract_artifact_queue_state":state,"external_action_authorized":false,"external_action_performed":false,"summary":{"target_scope_status":target_status,"target_scope_state":target_state,"target_paper_count":target_count,"target_slug_set_hash":target_hash,"authoring_surface_status":authoring_status,"authoring_surface_state":authoring_state,"authoring_surface_ready":authoring_ready,"expected_contract_count":records.len(),"materialized_contract_count":written,"contract_artifact_present_count":present,"contract_artifact_valid_count":valid,"missing_contract_artifact_count":missing.len(),"invalid_contract_artifact_count":invalid_records.len(),"first_missing_contract_path":missing.first().map(|v|text(&v["contract_path"])).unwrap_or_default(),"first_invalid_contract_path":invalid_records.first().map(|v|text(&v["contract_path"])).unwrap_or_default(),"runner_execution_contract_artifact_queue_ready":ready,"dry_run_handoff_only":true,"local_contract_writer_only":true,"runner_ready_claim_allowed":false,"external_lifecycle_required":true,"forbidden_action_count":forbidden,"failed_check_count":failed.len(),"contract_artifact_queue_hash":stable_hash("runner_execution_contract_artifact_queue",&queue)?},"contract_artifact_queue":records,"upstream_refs":if upstream.is_null(){json!({})}else{upstream.clone()},"checks":checks,"failed_checks":failed,"manual_boundary":MANUAL_BOUNDARY}),
    )
}

#[cfg(test)]
mod tests;
