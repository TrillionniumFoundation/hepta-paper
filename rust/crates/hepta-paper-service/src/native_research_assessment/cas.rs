//! Actual source capture and immutable CAS execution, never filesystem authority.
mod execution;
mod producer;
mod workflow;
pub use workflow::{
    initialize_native_research_cas_assessment_workflow_v1,
    operate_native_research_cas_assessment_workflow_v1,
};
#[cfg(test)]
mod initialization_tests;
#[cfg(test)]
mod tests;
use crate::{
    ObjectStoreV1,
    native_business::local_submission_preflight::local_submission_projected_values_budget_v1 as reserve,
};
pub(crate) use execution::execute;
use hepta_codex_protocol::Sha256Digest;
pub use producer::{
    PreparedNativeResearchCasAssessmentV1,
    prepare_native_research_cas_assessment_for_inventory_row_v1,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::{Component, Path},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
const MAX_MANIFEST: u64 = 256 * 1024;
const MAX_RAW: u64 = 4 * 1024 * 1024;
const MAX_FILES: usize = 128;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResearchCasAssessmentRequestV1 {
    pub version: u16,
    pub manifest_object: Sha256Digest,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceFile {
    relative: String,
    object: Sha256Digest,
    bytes: u64,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapturedManifest {
    version: u16,
    kind: String,
    row: Value,
    task_binding: Sha256Digest,
    implementation_hash: String,
    // These are original display/member keys only. The consumer never opens them.
    display_inventory_root: String,
    display_source_root: String,
    source_snapshot: Value,
    files: Vec<SourceFile>,
    records: Vec<Value>,
}
fn refused() -> String {
    "native_research_cas_assessment_v1_refused".into()
}
fn check(c: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if c.load(Ordering::SeqCst) {
        Err("native_research_cas_assessment_cancelled".into())
    } else if Instant::now() >= deadline {
        Err("native_research_cas_assessment_expired".into())
    } else {
        Ok(())
    }
}
fn sha(bytes: &[u8]) -> Sha256Digest {
    Sha256Digest::from_digest_bytes(Sha256::digest(bytes).into())
}
fn relative(name: &str) -> Result<&Path, String> {
    let p = Path::new(name);
    if name.is_empty()
        || name.len() > 4096
        || name.contains(['\\', '\0'])
        || p.components().count() > 64
        || p.components().any(|p| !matches!(p, Component::Normal(_)))
        || name
            .split('/')
            .any(|s| s.is_empty() || matches!(s, "." | ".."))
    {
        Err(refused())
    } else {
        Ok(p)
    }
}
fn display_root(name: &str) -> Result<&Path, String> {
    let p = Path::new(name);
    if name.len() > 4096
        || name.contains(['\\', '\0'])
        || !p.is_absolute()
        || p.components().count() > 64
        || p.components()
            .any(|p| !matches!(p, Component::RootDir | Component::Normal(_)))
    {
        Err(refused())
    } else {
        Ok(p)
    }
}
/// This private owner is constructed only after all actual raw objects were
/// read and hashed. It is distinct from every held-FS verification observation.
pub(crate) struct NativeCasArtifactObservationV1<'a> {
    objects: &'a ObjectStoreV1,
    files: Vec<(Sha256Digest, u64)>,
    receipts: Vec<Value>,
    cancelled: &'a AtomicBool,
    deadline: Instant,
}
impl NativeCasArtifactObservationV1<'_> {
    pub(crate) fn receipts(&self) -> &[Value] {
        &self.receipts
    }
    pub(crate) fn verify_unchanged(&self) -> Result<(), String> {
        let mut remaining = MAX_RAW;
        for (hash, size) in &self.files {
            check(self.cancelled, self.deadline)?;
            if *size > remaining {
                return Err(refused());
            }
            let bytes = self
                .objects
                .read_with_maximum_v1(hash, remaining.max(1))
                .map_err(|_| refused())?;
            if bytes.len() as u64 != *size || sha(&bytes) != *hash {
                return Err(refused());
            }
            remaining -= *size;
        }
        check(self.cancelled, self.deadline)
    }
}
