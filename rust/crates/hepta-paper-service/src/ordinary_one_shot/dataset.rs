//! Normal one-shot keeps the actual mount document and opaque dataset reader.
//! Public diagnostic bytes never reconstruct this host-only observation.
use super::{json::*, path_from};
use crate::{
    automation_runtime_reconciliation::ordinary::ReconciliationReadControlV1,
    operator_dataset_harness::{
        OperatorDatasetHarnessObservation, inspect_operator_dataset_harness_v1,
    },
    runtime_image_reproducibility::PluginAuthority,
    runtime_source_cas::observation::SourceObservation,
};
use hepta_legacy_compatibility::{ProductionJsonValue as Json, parse_production_json_v1};
use serde_json::Value;
use std::{
    future::Future,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

pub(super) struct MountDocument<'a> {
    mounts: Json,
    source: SourceObservation<'a>,
}
impl MountDocument<'_> {
    pub(super) fn mounts(&self) -> &Json {
        &self.mounts
    }
    /// The ordinary incumbent preflight inspects a deep canonical JSON view.
    /// Retain this exact file observation; projection never reopens its source
    /// or reconstructs an authority observation from a public receipt.
    pub(super) fn canonical_for_preflight(
        mut self,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<Self, String> {
        self.assert_current(cancelled, deadline)?;
        let bytes = canonical_bytes(&self.mounts, 64 * 1024, cancelled)?;
        self.mounts = parse_production_json_v1(&bytes).map_err(|error| error.to_string())?;
        self.assert_current(cancelled, deadline)?;
        Ok(self)
    }
    pub(super) fn assert_current(
        &self,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<(), String> {
        self.source
            .require_control_context_v1(cancelled, deadline)?;
        self.source.assert_current()
    }
}
pub(super) fn load_mount_document<'a>(
    workspace: &Path,
    candidate: Option<&str>,
    control: &'a ReconciliationReadControlV1,
) -> Result<MountDocument<'a>, String> {
    control.checkpoint().map_err(|e| e.to_string())?;
    let selected = candidate
        .filter(|v| !v.is_empty())
        .ok_or("autonomous_research_one_shot_dataset_mount_file_required")?;
    let result = (|| {
        let path = path_from(workspace, selected)?;
        let parent = path
            .parent()
            .ok_or("autonomous_research_one_shot_dataset_mount_file_invalid")?;
        let leaf = path
            .file_name()
            .ok_or("autonomous_research_one_shot_dataset_mount_file_invalid")?;
        let mut source =
            SourceObservation::new_with_deadline(parent, &control.cancelled, control.deadline)?;
        if source.root() != parent {
            return Err("autonomous_research_one_shot_dataset_mount_file_invalid".into());
        }
        let bytes = source.inventory_document(Path::new(leaf), 64 * 1024)?;
        source.require_control_context_v1(&control.cancelled, control.deadline)?;
        source.assert_current()?;
        let mounts = parse_production_json_v1(&bytes).map_err(|e| e.to_string())?;
        Ok(MountDocument { mounts, source })
    })();
    control.checkpoint().map_err(|e| e.to_string())?;
    let document =
        result.map_err(|_: String| "autonomous_research_one_shot_dataset_mount_file_invalid")?;
    if !matches!(&document.mounts, Json::Array(v) if !v.is_empty()) {
        return Err("autonomous_research_one_shot_dataset_mounts_invalid".into());
    }
    Ok(document)
}
pub(super) fn plugin_environment() -> Result<Value, String> {
    let mut values = serde_json::Map::new();
    for key in [
        "HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE",
        "HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE",
    ] {
        match std::env::var(key) {
            Ok(value) if value.len() <= 4096 => {
                values.insert(key.into(), Value::String(value));
            }
            Ok(_) | Err(std::env::VarError::NotUnicode(_)) => {
                return Err("operator_dataset_plugin_configuration_path_domain_refused".into());
            }
            Err(std::env::VarError::NotPresent) => {}
        }
    }
    Ok(Value::Object(values))
}

/// Borrowed host inputs; no serialized constructor or release/submission grant.
pub struct OneShotDatasetHostInputsV1<'a> {
    definition: &'a Json,
    splits: &'a Json,
    plugin: &'a PluginAuthority,
    descriptors: &'a Value,
    cancelled: &'a AtomicBool,
    deadline: Instant,
}
impl OneShotDatasetHostInputsV1<'_> {
    #[must_use]
    pub fn private_definition(&self) -> &Json {
        self.definition
    }
    #[must_use]
    pub fn private_splits(&self) -> &Json {
        self.splits
    }
    #[must_use]
    pub fn plugin_authority(&self) -> &PluginAuthority {
        self.plugin
    }
    #[must_use]
    pub fn plugin_descriptors(&self) -> &Value {
        self.descriptors
    }
    #[must_use]
    pub fn control_cancelled(&self) -> &AtomicBool {
        self.cancelled
    }
    #[must_use]
    pub fn control_deadline(&self) -> Instant {
        self.deadline
    }
}

/// Actual file/authority observations retained across trusted host awaits.
pub struct ObservedOneShotDatasetV1<'a, 'b> {
    mount: &'b MountDocument<'a>,
    observation: OperatorDatasetHarnessObservation<'a>,
    poisoned: AtomicBool,
}
impl<'a, 'b> ObservedOneShotDatasetV1<'a, 'b> {
    pub(super) fn inspect(
        mount: &'b MountDocument<'a>,
        runtime: &Path,
        repository: &Path,
        control: &'a ReconciliationReadControlV1,
        environment: &Value,
    ) -> Result<Self, String> {
        mount.assert_current(&control.cancelled, control.deadline)?;
        let Json::Array(mounts) = mount.mounts() else {
            return Err("autonomous_research_one_shot_dataset_mounts_invalid".into());
        };
        let [selected] = mounts.as_slice() else {
            return Err("autonomous_research_one_shot_dataset_mounts_invalid".into());
        };
        let observation = inspect_operator_dataset_harness_v1(
            selected,
            runtime,
            repository,
            &control.cancelled,
            control.deadline,
            environment,
        )?;
        let held = Self {
            mount,
            observation,
            poisoned: AtomicBool::new(false),
        };
        held.assert_current(&control.cancelled, control.deadline)?;
        Ok(held)
    }
    pub fn assert_current(&self, cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
        if self.poisoned.load(Ordering::Acquire) {
            return Err("native_one_shot_dataset_observation_invalidated".into());
        }
        let result = (|| {
            self.mount.assert_current(cancelled, deadline)?;
            self.observation.assert_current(cancelled, deadline)?;
            self.mount.assert_current(cancelled, deadline)
        })();
        if result.is_err() {
            self.poisoned.store(true, Ordering::Release);
        }
        result
    }
    /// Current diagnostic view. This is not a host admission permit.
    pub fn receipt(&self, cancelled: &AtomicBool, deadline: Instant) -> Result<&Json, String> {
        self.assert_current(cancelled, deadline)?;
        Ok(self.observation.receipt())
    }
    /// Keep the same file epochs, cancellation owner and absolute deadline
    /// before host borrow and after its future, including a failed future.
    pub async fn with_host_inputs<'c, T, F: Future<Output = Result<T, String>>>(
        &'c self,
        cancelled: &'c AtomicBool,
        deadline: Instant,
        call: impl FnOnce(OneShotDatasetHostInputsV1<'c>) -> F,
    ) -> Result<T, String> {
        self.assert_current(cancelled, deadline)?;
        let (definition, splits) = self
            .observation
            .private_definition_for_host(cancelled, deadline)?;
        let (plugin, descriptors) = self
            .observation
            .verified_plugin_context_for_host(cancelled, deadline)?;
        let result = call(OneShotDatasetHostInputsV1 {
            definition,
            splits,
            plugin,
            descriptors,
            cancelled,
            deadline,
        })
        .await;
        self.assert_current(cancelled, deadline)?;
        result
    }
}
pub(super) fn inspection_blocker(error: &str) -> &'static str {
    if error.contains("source") {
        "autonomous_research_one_shot_dataset_source_unreadable"
    } else if error.contains("manifest") {
        "autonomous_research_one_shot_dataset_manifest_invalid"
    } else if error.contains("envelope") {
        "autonomous_research_one_shot_dataset_v4_envelope_invalid"
    } else if ["authority", "signature", "trust", "time_window"]
        .iter()
        .any(|s| error.contains(s))
    {
        "autonomous_research_one_shot_dataset_trust_invalid"
    } else {
        "autonomous_research_one_shot_dataset_contract_invalid"
    }
}
fn array(value: &Json) -> &[Json] {
    match value {
        Json::Array(values) => values,
        _ => &[],
    }
}
pub(super) fn receipt_blockers(receipt: &Json, mount: &Json) -> Vec<String> {
    let mut codes = Vec::new();
    let mut push = |name: &str| codes.push(format!("autonomous_research_one_shot_dataset_{name}"));
    if !is_text(
        field(receipt, "status"),
        "operator_dataset_harness_authority_verified",
    ) {
        push("contract_invalid");
    }
    let authority = field(receipt, "authority");
    if !number(field(authority, "version"), 4.0)
        || !is_text(
            field(authority, "kind"),
            "LocalGoldenDatasetHarnessAuthority",
        )
    {
        push("v4_envelope_invalid");
    }
    let verification = field(receipt, "authorityVerification");
    if !boolean(field(verification, "cryptographicSignaturesVerified"), true)
        || !boolean(field(verification, "timeWindowValid"), true)
    {
        push("trust_invalid");
    }
    if !scalar_eq(
        field(receipt, "datasetManifestHash"),
        field(mount, "manifestHash"),
    ) {
        push("manifest_invalid");
    }
    for value in array(field(receipt, "blockers")) {
        let Some(error) = text(value) else {
            continue;
        };
        if [
            "source_unreadable",
            "source_required",
            "worker_exposure_manifest_unreadable",
        ]
        .iter()
        .any(|s| error.contains(s))
        {
            push("source_unreadable");
        } else if error.contains("manifest") {
            push("manifest_invalid");
        } else if ["envelope", "analysis_protocol_required"]
            .iter()
            .any(|s| error.contains(s))
        {
            push("v4_envelope_invalid");
        } else if [
            "authority",
            "signature",
            "trust",
            "time_window",
            "runtime_scope",
        ]
        .iter()
        .any(|s| error.contains(s))
        {
            push("trust_invalid");
        } else {
            push("contract_invalid");
        }
    }
    if !boolean(field(mount, "readOnly"), true) {
        push("contract_invalid");
    }
    codes
}
#[cfg(test)]
mod tests;
