//! Ordinary backup default/status over the retained original inventory owner.
//! Writer actions remain on their independently authorized standalone protocol.
use crate::{
    ordinary_readonly_frontend::OrdinaryReadonlyOutputV1,
    state_recoverability::cli::{
        StateBackupCliContextV1, StateBackupStatusObservationV1, StateBackupStatusReadV1,
        observe_ordinary_state_backup_status_v1, ordinary_state_backup_status_help_v1,
    },
};
use serde::{
    Serialize, Serializer,
    ser::{SerializeMap, SerializeSeq},
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::Write,
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};

const MAXIMUM_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const TOP_KEYS: &[&str] = &[
    "version",
    "kind",
    "status",
    "manifestId",
    "manifestHash",
    "databaseScopeHash",
    "instances",
    "blockers",
    "inventoryHash",
];
const INSTANCE_KEYS: &[&str] = &[
    "instanceId",
    "role",
    "paperId",
    "sourceRelativePath",
    "schemaContractId",
    "missingSchemaObjects",
    "sourceFileIdentity",
    "sourceSha256",
    "walFileIdentity",
    "walSha256",
    "quickCheck",
    "foreignKeyViolationCount",
    "schemaHash",
    "schemaObjects",
    "userVersion",
    "applicationId",
];
const IDENTITY_KEYS: &[&str] = &[
    "device",
    "inode",
    "mode",
    "links",
    "bytes",
    "modifiedNs",
    "changedNs",
];
// Borrowed constructor projection. The original report only contains strings,
// nulls, bounded counts and SQLite 32-bit pragma numbers; no arbitrary JSON is
// reinterpreted and every source value stays on the retained report.
struct OrderedReport<'a>(&'a Value);
struct OrderedInstances<'a>(&'a Value);
struct OrderedInstance<'a>(&'a Value);
struct OrderedIdentity<'a>(&'a Value);
fn member<'a, E: serde::ser::Error>(value: &'a Value, key: &str) -> Result<&'a Value, E> {
    value
        .get(key)
        .ok_or_else(|| E::custom("autonomous_research_state_backup_report_invalid"))
}
impl Serialize for OrderedReport<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(TOP_KEYS.len()))?;
        for key in TOP_KEYS {
            let value = member::<S::Error>(self.0, key)?;
            if *key == "instances" {
                map.serialize_entry(key, &OrderedInstances(value))?;
            } else {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}
impl Serialize for OrderedInstances<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let entries = self.0.as_array().ok_or_else(|| {
            <S::Error as serde::ser::Error>::custom(
                "autonomous_research_state_backup_report_invalid",
            )
        })?;
        let mut seq = serializer.serialize_seq(Some(entries.len()))?;
        for entry in entries {
            seq.serialize_element(&OrderedInstance(entry))?;
        }
        seq.end()
    }
}
impl Serialize for OrderedInstance<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(INSTANCE_KEYS.len()))?;
        for key in INSTANCE_KEYS {
            let value = member::<S::Error>(self.0, key)?;
            if ["sourceFileIdentity", "walFileIdentity"].contains(key) && !value.is_null() {
                map.serialize_entry(key, &OrderedIdentity(value))?;
            } else {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}
impl Serialize for OrderedIdentity<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(IDENTITY_KEYS.len()))?;
        for key in IDENTITY_KEYS {
            map.serialize_entry(key, member::<S::Error>(self.0, key)?)?;
        }
        map.end()
    }
}
struct Output<'a> {
    bytes: Vec<u8>,
    observed: &'a StateBackupStatusObservationV1,
}
impl Write for Output<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.observed
            .check_control()
            .map_err(std::io::Error::other)?;
        self.bytes
            .len()
            .checked_add(bytes.len())
            .filter(|n| *n < MAXIMUM_OUTPUT_BYTES)
            .ok_or_else(|| {
                std::io::Error::other("autonomous_research_state_backup_output_limit_exceeded")
            })?;
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.observed.check_control().map_err(std::io::Error::other)
    }
}
fn help(usage: &str) -> OrdinaryReadonlyOutputV1 {
    OrdinaryReadonlyOutputV1 {
        stdout: format!("{usage}\n").into_bytes(),
        stderr: Vec::new(),
        exit_code: 0,
    }
}
fn run_with_context(
    argv: &[String],
    context: &StateBackupCliContextV1,
    cancelled: &Arc<AtomicBool>,
    deadline: Instant,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    let observed =
        match observe_ordinary_state_backup_status_v1(argv, context, cancelled, deadline)? {
            StateBackupStatusReadV1::Help(usage) => return Ok(help(usage)),
            StateBackupStatusReadV1::Observed(observed) => observed,
        };
    let mut output = Output {
        bytes: Vec::new(),
        observed: &observed,
    };
    serde_json::to_writer_pretty(&mut output, &OrderedReport(observed.report()))
        .map_err(|cause| cause.to_string())?;
    output
        .observed
        .check_control()
        .map_err(|cause| cause.code)?;
    let mut stdout = output.bytes;
    // The writer reserved this byte before every append. Retained input checks
    // finish AFTER serialization, including semantic blocked inventories.
    stdout.push(b'\n');
    let report = observed.finish().map_err(|cause| cause.code)?;
    Ok(OrdinaryReadonlyOutputV1 {
        stdout,
        stderr: Vec::new(),
        exit_code: i32::from(
            report["status"] != "autonomous_research_state_database_inventory_ready",
        ) * 2,
    })
}
/// Original ordinary grammar/defaults. Help and writer refusal precede ROOT
/// discovery. Relative options and environment use the physical workspace ROOT,
/// matching the incumbent registry child's fixed cwd, never caller cwd.
pub fn run_ordinary_state_backup_status_with_control_v1(
    argv: &[String],
    cancelled: &Arc<AtomicBool>,
    deadline: Instant,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    if let Some(usage) = ordinary_state_backup_status_help_v1(argv)? {
        return Ok(help(usage));
    }
    // Require the original control before inspecting deployment markers.
    crate::state_database_inventory::StateDatabaseInventoryControlV1::new(cancelled, deadline)
        .map_err(|cause| cause.code)?;
    let root = crate::native_workspace::current_native_command_workspace_root_v1(None)?;
    let environment = std::env::vars_os()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
        .collect::<BTreeMap<_, _>>();
    run_with_context(
        argv,
        &StateBackupCliContextV1 {
            workspace_root: root.clone(),
            working_directory: root,
            environment,
        },
        cancelled,
        deadline,
    )
}

#[cfg(test)]
mod tests;
