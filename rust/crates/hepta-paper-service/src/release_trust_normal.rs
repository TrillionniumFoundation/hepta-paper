//! Nullary ordinary release trust entrypoint, over the existing source/proof
//! owners. Imported descriptive evidence is never an execution permit.
use hepta_legacy_compatibility::{
    ProductionJsonEncodingLimitsV1, ProductionJsonValue as Json, parse_production_json_v1,
    production_json_pretty_with_limits_v1,
};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

/// Original constructor-order stdout and exit policy.
pub struct NativeReleaseTrustGateOutputV1 {
    /// Complete original gate value, including its existing record hash.
    pub report: Value,
    /// Original JSON.stringify(..., null, 2) output and final newline.
    pub stdout: Vec<u8>,
    /// Zero when the two release-blocking layers are complete, otherwise one.
    pub exit_code: i32,
}

fn object(value: &Value, keys: &[&str]) -> Result<Json, String> {
    let fields = keys
        .iter()
        .map(|key| {
            let raw = serde_json::to_vec(value.get(*key).ok_or("release_trust_gate_wire_invalid")?)
                .map_err(|_| "release_trust_gate_wire_invalid")?;
            let entry =
                parse_production_json_v1(&raw).map_err(|_| "release_trust_gate_wire_invalid")?;
            Ok((key.encode_utf16().collect(), entry))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Json::Object(fields))
}
fn wire(report: &Value, cancelled: &AtomicBool) -> Result<Vec<u8>, String> {
    let Json::Object(mut fields) = object(
        report,
        &[
            "version",
            "kind",
            "status",
            "releaseCommit",
            "capabilityCount",
            "implementation",
            "releaseBoundConformance",
            "independentProductionOperational",
            "conformanceCannotQualifyAsOperationalProof",
            "operationalProofCannotSubstituteForReleaseBoundConformance",
            "releaseTrustLayerGateHash",
        ],
    )?
    else {
        return Err("release_trust_gate_wire_invalid".into());
    };
    for (key, value) in &mut fields {
        let name = String::from_utf16(key).map_err(|_| "release_trust_gate_wire_invalid")?;
        let keys: &[&str] = match name.as_str() {
            "implementation" => &["verified", "required", "releaseBlocking"],
            "releaseBoundConformance" => &[
                "verified",
                "required",
                "releaseBlocking",
                "productionEligible",
            ],
            "independentProductionOperational" => &[
                "verified",
                "required",
                "releaseBlocking",
                "externalIndependentRequired",
            ],
            _ => continue,
        };
        *value = object(&report[&name], keys)?;
    }
    let mut bytes = production_json_pretty_with_limits_v1(
        &Json::Object(fields),
        ProductionJsonEncodingLimitsV1 {
            maximum_bytes: 4095,
            maximum_values: 256,
            maximum_utf16_units: 4096,
        },
        cancelled,
    )
    .map_err(|_| "release_trust_gate_wire_invalid")?;
    if bytes.len() >= 4096 {
        return Err("release_trust_gate_wire_budget_exceeded".into());
    }
    bytes.push(b'\n');
    Ok(bytes)
}

/// Run the ordinary nullary command. Argument refusal precedes path selection;
/// relative runtime/asset environment paths use the physical worker ROOT.
pub fn run_ordinary_release_trust_gate_with_control_v1(
    args: &[String],
    cancelled: &Arc<AtomicBool>,
    deadline: Instant,
) -> Result<NativeReleaseTrustGateOutputV1, String> {
    if !args.is_empty() {
        return Err("command_does_not_accept_arguments".into());
    }
    if cancelled.load(Ordering::Acquire) {
        return Err("code_provenance_cancelled".into());
    }
    if Instant::now() >= deadline {
        return Err("code_provenance_deadline_exceeded".into());
    }
    let root = crate::native_workspace::current_native_command_workspace_root_v1(None)?;
    let parent = root.parent().unwrap_or(&root);
    let path = |name: &str, default: PathBuf| -> Result<PathBuf, String> {
        if let Some(raw) = std::env::var_os(name).filter(|value| !value.is_empty()) {
            let selected = PathBuf::from(raw);
            crate::native_workspace::resolve_native_workspace_root_v1(
                &root,
                &selected,
                Some(&selected),
            )
        } else {
            Ok(default)
        }
    };
    let runtime = path(
        "HEPTA_PAPER_RUNTIME_ROOT",
        parent.join("hepta-paper-runtime/native-runtime"),
    )?;
    let assets = path(
        "HEPTA_PAPER_ASSET_ROOT",
        if parent
            .file_name()
            .is_some_and(|name| name == "paper_factory")
        {
            parent.to_owned()
        } else {
            parent.join("hepta-paper-assets")
        },
    )?;
    let observed = crate::operational_status::observe_ordinary_release_trust_gate_with_control_v1(
        &root, &runtime, &assets, cancelled, deadline,
    )
    .map_err(|failure| failure.to_string())?;
    let stdout = wire(observed.report(), cancelled)?;
    let report = observed.finish().map_err(|failure| failure.to_string())?;
    if cancelled.load(Ordering::Acquire) {
        return Err("code_provenance_cancelled".into());
    }
    if Instant::now() >= deadline {
        return Err("code_provenance_deadline_exceeded".into());
    }
    let exit_code = i32::from(report["status"] != "code_release_trust_layers_ready");
    Ok(NativeReleaseTrustGateOutputV1 {
        report,
        stdout,
        exit_code,
    })
}

#[cfg(test)]
pub(crate) fn serialize_observed_ordinary_release_trust_gate_for_test_v1(
    report: &Value,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, String> {
    wire(report, cancelled)
}
