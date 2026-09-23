//! Native runtime-image reproducibility primitives.
//!
//! These functions implement the contract, context manifest, Ed25519 attestation,
//! isolated verifier transport, and offline SQLite publication layers. The caller
//! must resolve the active plugin scope and process configuration through their
//! respective authority chains before calling the contract layer. A valid receipt
//! does not itself authorize production activation or online fenced publication.
mod context;
mod contract;
pub mod online_publication;
mod plugin;
mod process;
mod publication;
mod support;
mod workflow;

use serde_json::{Value, json};
use std::path::Path;
use support::*;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct Error(String);
impl From<&str> for Error {
    fn from(s: &str) -> Self {
        Self(s.to_owned())
    }
}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self("runtime_reproducibility_io_failed".into())
    }
}
impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self("runtime_reproducibility_publication_database_invalid".into())
    }
}
pub type Result<T> = std::result::Result<T, Error>;

pub use context::{
    current_runtime_image_release_binding_v1, inspect_runtime_image_build_input_closure_v1,
};
pub use contract::{
    build_runtime_image_reproducibility_receipt_v2, build_runtime_image_reproducibility_request_v2,
    runtime_image_reproducibility_active_plugin_scope_v1,
    verify_runtime_image_reproducibility_receipt_v2,
    verify_runtime_image_reproducibility_response_v1,
};
pub use plugin::{
    PluginAuthority, resolve_runtime_image_plugin_authority_v1,
    verify_runtime_image_builtin_plugin_source_binding_v1,
};
pub use process::{
    ProcessConfiguration, VerifierProcess, invoke_runtime_image_reproducibility_verifiers_v1,
    read_runtime_image_reproducibility_process_configuration_v1,
};
pub use publication::{
    publish_runtime_image_reproducibility_offline_v2,
    read_runtime_image_reproducibility_publication_v2,
};
pub use workflow::runtime_image_reproducibility_report_v2;

/// Resolved authority inputs, supplied by the composition layer. No current
/// source identity or public key is taken from the receipt being verified.
#[derive(Debug)]
pub struct ReceiptVerificationContext<'a> {
    pub now: &'a str,
    pub current_code_provenance_hash: &'a str,
    pub current_release_identity_hash: &'a str,
    pub current_inputs: &'a Value,
    pub configuration: &'a Value,
    pub profile_policies: &'a Value,
    pub active_plugin_scope: &'a Value,
    /// SPKI PUBLIC KEY PEMs, in the same order as the two configured verifiers.
    pub public_keys: &'a [String],
}

pub const FRONTEND: &str =
    "docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e";
pub const SOURCE_DATE_EPOCH: u64 = 1_733_097_600;
const PROFILES: [&str; 3] = ["python", "pythonGpu", "r"];
const SCOPE_FIELDS: [&str; 5] = [
    "empiricalFamilyPluginPackageHash",
    "empiricalFamilyPluginRegistryHash",
    "empiricalFamilyPluginStartupInspectionHash",
    "activeProductionProfileHashes",
    "runtimeImageReproducibilityActivePluginScopeHash",
];
fn tar_policy() -> Value {
    json!({"version":1,"kind":"RuntimeImageCanonicalContextTarMetadataPolicy","archiveFormat":"posix-ustar","entryOrder":"lexicographic-path","uid":0,"gid":0,"uname":"","gname":"","mtime":SOURCE_DATE_EPOCH,"xattrsIncluded":false,"deviceEntriesIncluded":false})
}
fn exporter() -> Value {
    json!({"type":"oci","rewriteTimestamp":true,"provenance":false,"sbom":false})
}
fn profile_map(inputs: &Value, field: &str) -> Value {
    Value::Object(
        array(inputs)
            .iter()
            .map(|i| (s(&i["profile"]).to_owned(), i[field].clone()))
            .collect(),
    )
}
fn scope_fields(v: &Value) -> Value {
    Value::Object(
        SCOPE_FIELDS
            .iter()
            .map(|k| ((*k).to_owned(), v[*k].clone()))
            .collect(),
    )
}
fn scope_valid(v: &Value) -> bool {
    exact(
        v,
        &[
            "version",
            "kind",
            "empiricalFamilyPluginPackageHash",
            "empiricalFamilyPluginRegistryHash",
            "empiricalFamilyPluginStartupInspectionHash",
            "activeProductionProfileHashes",
            "requiredProfiles",
            "requiredScientificRuntimeProfiles",
            "productionGpuProfileCount",
            "runtimeImageReproducibilityActivePluginScopeHash",
        ],
    ) && v["version"] == 1
        && v["kind"] == "RuntimeImageReproducibilityActivePluginScope"
        && !array(&v["requiredProfiles"]).is_empty()
        && array(&v["requiredProfiles"]).len() <= 3
        && array(&v["requiredProfiles"])
            .iter()
            .all(|p| PROFILES.contains(&s(p)))
        && array(&v["requiredProfiles"])
            .windows(2)
            .all(|w| s(&w[0]) < s(&w[1]))
        && array(&v["requiredProfiles"]).contains(&json!("pythonGpu"))
        && v["requiredScientificRuntimeProfiles"] == json!(["pythonGpu"])
        && v["productionGpuProfileCount"] == 0
        && SCOPE_FIELDS
            .iter()
            .filter(|k| **k != "activeProductionProfileHashes")
            .all(|k| sha(&v[*k]))
        && array(&v["activeProductionProfileHashes"]).len() <= 128
        && array(&v["activeProductionProfileHashes"]).iter().all(sha)
        && rehash(
            "RuntimeImageReproducibilityActivePluginScope",
            v,
            "runtimeImageReproducibilityActivePluginScopeHash",
        )
}
/// Read a bounded request without silently accepting duplicate JSON keys.
pub fn read_runtime_image_reproducibility_json_v1(path: &Path) -> Result<Value> {
    parse(&read(path, 32 * 1024 * 1024)?)
}
