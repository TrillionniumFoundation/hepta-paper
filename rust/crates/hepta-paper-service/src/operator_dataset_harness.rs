//! Host-owned dataset envelopes observed through the existing CAS descriptors.
//! A public receipt is diagnostic data. The private observation cannot be
//! reconstructed from JSON and carries no release or submission authority.
mod analysis;
mod authority;
mod contract;
mod inference;
mod inputs;
mod json;
mod receipt;
mod statistics;
#[cfg(test)]
mod tests;
use contract::DatasetContract;
use hepta_legacy_compatibility::{ProductionJsonEncodingLimitsV1, ProductionJsonValue as Json};
use inputs::DatasetInputs;
use json::*;
use serde_json::Value;
use std::{path::Path, sync::atomic::AtomicBool, time::Instant};

fn control_check(cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
    crate::runtime_image_reproducibility::control::OperationControl::new(cancelled, deadline)
        .check()
        .map_err(|error| error.to_string())
}
/// Retained private inputs and current signed scope, not a serializable permit.
struct VerifiedPluginContext {
    authority: crate::runtime_image_reproducibility::PluginAuthority,
    descriptors: Value,
    window: (i64, i64),
}
pub struct OperatorDatasetHarnessObservation<'a> {
    inputs: DatasetInputs<'a>,
    contract: Option<DatasetContract>,
    report: Json,
    window: Option<(i64, i64)>,
    plugin: VerifiedPluginContext,
    verified: bool,
}
impl OperatorDatasetHarnessObservation<'_> {
    /// Diagnostic receipt. It neither exposes the hidden oracle nor grants use.
    pub fn receipt(&self) -> &Json {
        &self.report
    }
    /// Check the original cancellation/deadline, current file identities and
    /// actual wall-clock validity again, including after a caller's await.
    pub fn assert_current(&self, cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
        self.inputs.assert_current(cancelled, deadline)?;
        let now = authority::actual_millis()?;
        ensure(
            self.plugin.window.0 <= now && now < self.plugin.window.1,
            "operator_dataset_plugin_authority_time_window_changed",
        )?;
        if self.verified {
            let (signed, expires) = self
                .window
                .ok_or("operator_dataset_authority_time_window_invalid")?;
            ensure(
                signed <= now && now < expires,
                "operator_dataset_authority_time_window_changed",
            )?;
        }
        self.inputs.assert_current(cancelled, deadline)
    }
    /// Borrow hidden evaluation data within the trusted host. Consumers keep
    /// this observation and recheck it before each actual worker admission.
    /// This method does not mount or publish the hidden oracle.
    pub fn private_definition_for_host(
        &self,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<(&Json, &Json), String> {
        self.assert_current(cancelled, deadline)?;
        ensure(self.verified, "operator_dataset_harness_authority_blocked")?;
        let contract = self
            .contract
            .as_ref()
            .ok_or("operator_dataset_harness_authority_blocked")?;
        Ok((&contract.definition, &contract.splits))
    }
    /// Borrow the complete actual verified startup context, retaining its
    /// signed package, registry, scope, descriptor inputs and observed files.
    /// A consumer must recheck this owner before and after worker admission.
    pub fn verified_plugin_context_for_host(
        &self,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<
        (
            &crate::runtime_image_reproducibility::PluginAuthority,
            &Value,
        ),
        String,
    > {
        self.assert_current(cancelled, deadline)?;
        ensure(self.verified, "operator_dataset_harness_authority_blocked")?;
        Ok((&self.plugin.authority, &self.plugin.descriptors))
    }
}
fn plugin_context(
    inputs: &mut DatasetInputs<'_>,
    repository_root: &Path,
    environment: &Value,
    now: &str,
) -> Result<VerifiedPluginContext, String> {
    inputs.require_directory(repository_root)?;
    let raw=inputs.document(&repository_root.join("rust/crates/hepta-paper-service/src/runtime_image_reproducibility/plugin-inputs.v1.json"),4*1024*1024,false)?.ok_or("operator_dataset_builtin_plugin_source_missing")?;
    ensure(
        raw == include_bytes!("runtime_image_reproducibility/plugin-inputs.v1.json"),
        "operator_dataset_builtin_plugin_source_drift",
    )?;
    let source: Value = serde_json::from_slice(&raw).map_err(|error| error.to_string())?;
    for (relative, expected) in source["sourceHashes"]
        .as_object()
        .ok_or("operator_dataset_builtin_plugin_source_invalid")?
    {
        let path = repository_root.join(relative);
        ensure(
            path.starts_with(repository_root)
                && !Path::new(relative)
                    .components()
                    .any(|component| !matches!(component, std::path::Component::Normal(_))),
            "operator_dataset_builtin_plugin_source_invalid",
        )?;
        let bytes = inputs
            .document(&path, 4 * 1024 * 1024, false)?
            .ok_or("operator_dataset_builtin_plugin_source_missing")?;
        use sha2::{Digest, Sha256};
        ensure(
            expected.as_str() == Some(&format!("sha256:{}", hex::encode(Sha256::digest(bytes)))),
            "operator_dataset_builtin_plugin_source_drift",
        )?;
    }
    let mut configuration = Vec::new();
    for (name, limit) in [
        ("HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE", 4 * 1024 * 1024),
        ("HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE", 1024 * 1024),
    ] {
        if let Some(path) = environment[name]
            .as_str()
            .filter(|value| !value.trim().is_empty())
        {
            let path = Path::new(path.trim());
            ensure(
                path.is_absolute(),
                "operator_dataset_plugin_configuration_path_domain_refused",
            )?;
            let bytes = inputs
                .document(path, limit, false)?
                .ok_or("operator_dataset_plugin_configuration_missing")?;
            configuration.push(Some(bytes));
        } else {
            configuration.push(None);
        }
    }
    let authority =
        crate::runtime_image_reproducibility::resolve_runtime_image_plugin_authority_from_observed_v1(
            configuration[0].as_deref(),configuration[1].as_deref(),now,
            inputs.cancelled(),inputs.deadline(),
        )
        .map_err(|error| error.to_string())?;
    let signed = crate::journal_connector_coverage::qualification::canonical_instant_millis(
        authority.startup_inspection["signedAt"]
            .as_str()
            .ok_or("operator_dataset_plugin_authority_time_invalid")?,
    )
    .ok_or("operator_dataset_plugin_authority_time_invalid")?;
    let expires = crate::journal_connector_coverage::qualification::canonical_instant_millis(
        authority.startup_inspection["expiresAt"]
            .as_str()
            .ok_or("operator_dataset_plugin_authority_time_invalid")?,
    )
    .ok_or("operator_dataset_plugin_authority_time_invalid")?;
    control_check(inputs.cancelled(), inputs.deadline())?;
    Ok(VerifiedPluginContext {
        authority,
        descriptors: source["descriptors"].clone(),
        window: (signed, expires),
    })
}
/// Resolve the normal mount from current private host files and the actual
/// verified startup registry. No caller-provided trust receipt or past clock
/// can construct the returned observation.
pub fn inspect_operator_dataset_harness_v1<'a>(
    mount: &Json,
    runtime_root: &Path,
    repository_root: &Path,
    cancelled: &'a AtomicBool,
    deadline: Instant,
    plugin_environment: &Value,
) -> Result<OperatorDatasetHarnessObservation<'a>, String> {
    control_check(cancelled, deadline)?;
    hepta_legacy_compatibility::production_json_resources_v1(
        mount,
        ProductionJsonEncodingLimitsV1::default(),
        cancelled,
    )
    .map_err(|error| error.to_string())?;
    crate::native_business::local_submission_preflight::local_submission_values_budget_v1([
        plugin_environment,
    ])?;
    let mut inputs = DatasetInputs::new(cancelled, deadline)?;
    inputs.require_directory(runtime_root)?;
    let now = authority::actual_millis()?;
    let now_iso = crate::nested_runtime_cli::nested_runtime_utc_millis_v1(
        u64::try_from(now).map_err(|_| "operator_dataset_actual_clock_invalid")?,
    )?;
    let plugin = plugin_context(&mut inputs, repository_root, plugin_environment, &now_iso)?;
    let source = or_string(get(mount, "source"))?;
    let source = Path::new(&source);
    ensure(
        source.is_absolute(),
        "operator_dataset_source_path_domain_refused",
    )?;
    let mut blockers = Vec::new();
    let handle = or_string(get(mount, "operatorDatasetHarnessHandle"))?.to_lowercase();
    ensure(
        sha(&text(&handle))?,
        "operator_dataset_harness_handle_invalid",
    )?;
    let envelope_path = runtime_root
        .join("private/dataset-harness-envelopes")
        .join(format!("{}.json", &handle[7..]));
    if envelope_path.starts_with(source) {
        blockers.push("operator_dataset_harness_must_be_host_only_outside_dataset".into());
    }
    let raw = inputs.document(&envelope_path, 8 * 1024 * 1024, true)?;
    let envelope_hash = raw.as_ref().map(|bytes| {
        use sha2::{Digest, Sha256};
        format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
    });
    if raw.is_none() {
        blockers.push("operator_dataset_harness_envelope_unreadable".into());
    }
    let mut normalized = None;
    let parsed = match raw {
        Some(bytes) => hepta_legacy_compatibility::parse_production_json_v1(&bytes)
            .map_err(|error| error.to_string()),
        None => Ok(Json::Null),
    };
    match parsed {
        Ok(parsed) => {
            hepta_legacy_compatibility::production_json_resources_v1(
                &parsed,
                ProductionJsonEncodingLimitsV1::default(),
                cancelled,
            )
            .map_err(|error| error.to_string())?;
            match contract::validate(
                &parsed,
                &or_string(get(mount, "name"))?,
                &or_string(get(mount, "manifestHash"))?,
                &plugin.authority.registry,
                &plugin.descriptors,
                cancelled,
                deadline,
            ) {
                Ok(contract) => normalized = Some(contract),
                Err(code) => {
                    control_check(cancelled, deadline)?;
                    blockers.push(code);
                }
            }
        }
        Err(code) => blockers.push(code),
    }
    let (manifest, files) = inputs.dataset_manifest(source)?;
    receipt::mount_bindings(
        mount,
        normalized.as_ref(),
        runtime_root,
        &manifest,
        &files,
        &mut blockers,
    )?;
    let trust_raw = inputs.document(
        &runtime_root.join("trust/AUTHORITY_TRUST_STORE.json"),
        1024 * 1024,
        false,
    )?;
    let trust = match trust_raw {
        Some(bytes) => serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        None => Value::Null,
    };
    let (authority, local) = normalized
        .as_ref()
        .map_or((&Json::Null, false), |contract| {
            (&contract.authority, contract.local)
        });
    let authority::Verification {
        report: verification,
        blockers: authority_blockers,
        window,
    } = authority::verify(authority, local, &trust, now, cancelled, deadline)?;
    blockers.extend(authority_blockers);
    receipt::plan_bindings(
        mount,
        normalized.as_ref(),
        envelope_hash.as_deref(),
        &mut blockers,
    )?;
    let report = receipt::build(
        mount,
        normalized.as_ref(),
        envelope_hash.as_deref(),
        verification,
        &blockers,
        cancelled,
        deadline,
    )?;
    inputs.assert_current(cancelled, deadline)?;
    let observation = OperatorDatasetHarnessObservation {
        inputs,
        contract: normalized,
        report,
        window,
        plugin,
        verified: blockers.is_empty(),
    };
    observation.assert_current(cancelled, deadline)?;
    Ok(observation)
}
