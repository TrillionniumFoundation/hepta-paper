//! Ordinary release trust composes observed implementation and imported proof
//! owners. It does not create evidence, signatures, release or submission grants.
use super::{Result, bounded, conformance, error, files, provenance, record_hash};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    path::{Component, Path},
    sync::atomic::AtomicBool,
    time::Instant,
};

fn provenance_matches(left: &Value, right: &Value) -> bool {
    conformance::provenance_valid(left)
        && conformance::provenance_valid(right)
        && record_hash("CapabilityVerificationCodeProvenance", left)
            .ok()
            .zip(record_hash("CapabilityVerificationCodeProvenance", right).ok())
            .is_some_and(|(a, b)| a == b)
}

fn payload_hash_matches(value: &Value, kind: &str, field: &str, extra: &[&str]) -> bool {
    let mut fields = Vec::with_capacity(extra.len() + 1);
    fields.push(field);
    fields.extend_from_slice(extra);
    record_hash(kind, &super::stripped(value, &fields)).is_ok_and(|actual| value[field] == actual)
}

fn source_hash_matches(
    root: &Path,
    entry: &Value,
    observation: &mut bounded::Observation<'_>,
) -> Result<bool> {
    let Some(relative) = entry["path"].as_str() else {
        return Err(error("release_trust_implementation_source_path_rejected"));
    };
    let path = Path::new(relative);
    // JSON receipts do not authorize reads outside the selected source root.
    // The normal finite profile rejects the incumbent's exotic path domain.
    if relative.is_empty()
        || relative.len() > 4096
        || relative.contains('\\')
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || path.as_os_str().is_empty()
    {
        return Err(error("release_trust_implementation_source_path_rejected"));
    }
    let selected = root.join(path);
    if !selected.exists() {
        return Ok(false);
    }
    match files::read_source_hash_with_observation(root, &selected, observation) {
        Ok(hash) => Ok(entry["sha256"] == hash),
        Err(failure) if failure.0.starts_with("code_provenance_") => Err(failure),
        Err(_) => Ok(false),
    }
}

fn implementation_count(
    root: &Path,
    runtime: &Path,
    current: &Value,
    observation: &mut bounded::Observation<'_>,
) -> Result<u64> {
    let manifest = match files::read_with_observation(
        runtime,
        &runtime.join("audits/capability-verification/CAPABILITY_VERIFICATION_MANIFEST.json"),
        observation,
    ) {
        Ok(value) => value,
        Err(failure) if failure.0.starts_with("code_provenance_") => return Err(failure),
        Err(_) => return Ok(0),
    };
    let value = &manifest.document;
    if value["kind"] != "CapabilityVerificationManifest"
        || value["version"] != 2
        || !provenance_matches(current, &value["codeProvenance"])
        || !record_hash(
            "CapabilityVerificationCodeProvenance",
            &value["codeProvenance"],
        )
        .is_ok_and(|hash| value["codeProvenanceHash"] == hash)
        || !payload_hash_matches(
            value,
            "CapabilityVerificationManifest",
            "capabilityVerificationManifestHash",
            &[],
        )
    {
        return Ok(0);
    }
    let receipts = match value.get("receipts") {
        None | Some(Value::String(_)) => return Ok(0),
        Some(v)
            if !crate::native_business::local_submission_preflight::local_submission_truthy(v) =>
        {
            return Ok(0);
        }
        Some(Value::Array(values)) => values,
        _ => {
            return Err(error(
                "release_trust_implementation_receipts_array_required",
            ));
        }
    };
    if receipts.len() > 4096 {
        return Err(error(
            "release_trust_implementation_receipt_budget_exceeded",
        ));
    }
    let mut accepted = BTreeSet::new();
    for receipt in receipts {
        observation.checkpoint()?;
        if receipt["version"] != 2
            || receipt["kind"] != "CapabilityVerificationReceipt"
            || !payload_hash_matches(
                receipt,
                "CapabilityVerificationReceipt",
                "capabilityVerificationReceiptHash",
                &["ledgerReceiptId"],
            )
            || !provenance_matches(&receipt["codeProvenance"], &value["codeProvenance"])
            || !record_hash(
                "CapabilityVerificationCodeProvenance",
                &receipt["codeProvenance"],
            )
            .is_ok_and(|hash| receipt["codeProvenanceHash"] == hash)
            || !source_hash_matches(root, &receipt["test"], observation)?
        {
            continue;
        }
        let targets = match receipt.get("targets") {
            None => continue,
            Some(v)
                if !crate::native_business::local_submission_preflight::local_submission_truthy(
                    v,
                ) =>
            {
                continue;
            }
            Some(Value::Array(values)) => values,
            _ => return Err(error("release_trust_implementation_targets_array_required")),
        };
        if targets.len() > 4096 {
            return Err(error("release_trust_implementation_target_budget_exceeded"));
        }
        let mut valid = !targets.is_empty();
        for target in targets {
            observation.checkpoint()?;
            if !source_hash_matches(root, target, observation)? {
                valid = false;
                break;
            }
        }
        if !valid
            || receipt["status"] != "capability_implementation_verified"
            || receipt["test"]["result"] != "passed"
        {
            continue;
        }
        let Some(id) = receipt["capabilityId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256)
        else {
            return Err(error("release_trust_implementation_capability_id_rejected"));
        };
        accepted.insert(id);
    }
    manifest.assert_current()?;
    Ok(accepted.len() as u64)
}

/// Compute the incumbent nullary gate from actual current source and imported
/// proof files. This compatibility API completes the observation before returning.
pub fn inspect_ordinary_release_trust_gate_with_control_v1(
    workspace_root: &Path,
    runtime_root: &Path,
    asset_root: &Path,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Value> {
    observe_ordinary_release_trust_gate_with_control_v1(
        workspace_root,
        runtime_root,
        asset_root,
        cancelled,
        deadline,
    )?
    .finish()
}

/// Opaque current source and proof observation. Only this owner can complete it;
/// the normal frontend borrows its report while encoding the original stdout.
pub(crate) struct ObservedReleaseTrustGateV1<'a> {
    workspace_root: &'a Path,
    observation: bounded::Observation<'a>,
    current: Value,
    report: Value,
}
impl ObservedReleaseTrustGateV1<'_> {
    pub(crate) fn report(&self) -> &Value {
        &self.report
    }
    pub(crate) fn finish(mut self) -> Result<Value> {
        if provenance::current_operational_with_observation(
            self.workspace_root,
            &mut self.observation,
        )? != self.current
        {
            return Err(error("release_trust_source_changed_after_observation"));
        }
        self.observation.assert_imported_current()?;
        Ok(self.report)
    }
}

pub(crate) fn observe_ordinary_release_trust_gate_with_control_v1<'a>(
    workspace_root: &'a Path,
    runtime_root: &Path,
    asset_root: &Path,
    cancelled: &'a AtomicBool,
    deadline: Instant,
) -> Result<ObservedReleaseTrustGateV1<'a>> {
    let mut observation = bounded::Observation::with_deadline(cancelled, deadline)?;
    let current =
        provenance::current_operational_with_observation(workspace_root, &mut observation)?;
    let implementation =
        implementation_count(workspace_root, runtime_root, &current, &mut observation)?;
    let proofs = super::capability_proof_status_from_observation_v1(
        workspace_root,
        runtime_root,
        asset_root,
        &current,
        &mut observation,
    )?;
    let count = |name| {
        proofs[name]
            .as_u64()
            .ok_or_else(|| error("release_trust_observed_count_invalid"))
    };
    let result = crate::release_trust_gate::build_release_trust_layer_gate_v1(
        current["commit"]
            .as_str()
            .ok_or_else(|| error("code_provenance_commit_required"))?,
        super::OPERATIONAL_CAPABILITIES_V1.len() as u64,
        implementation,
        count("conformanceVerified")?,
        count("operationallyProven")?,
    )
    .map_err(|failure| error(&failure.to_string()))?;
    Ok(ObservedReleaseTrustGateV1 {
        workspace_root,
        observation,
        current,
        report: result,
    })
}

#[cfg(test)]
fn inspect_with_final_check(
    workspace_root: &Path,
    runtime_root: &Path,
    asset_root: &Path,
    cancelled: &AtomicBool,
    deadline: Instant,
    before_recheck: impl FnOnce(),
) -> Result<Value> {
    let observed = observe_ordinary_release_trust_gate_with_control_v1(
        workspace_root,
        runtime_root,
        asset_root,
        cancelled,
        deadline,
    )?;
    before_recheck();
    observed.finish()
}

#[cfg(test)]
mod tests;
