//! Ordinary owner projection retains the incumbent source prerequisites.
//! Imported acceptance is verified by the existing owner signature algorithm.
use super::{OPERATIONAL_CAPABILITIES_V1, Result, bounded, error, provenance};
use crate::owner_status::{self, reader};
use serde_json::Value;
use std::{collections::BTreeSet, path::Path, sync::atomic::AtomicBool};

fn read_optional(
    path: &Path,
    observation: &mut bounded::Observation<'_>,
) -> Result<Option<reader::Snapshot>> {
    match reader::read_with_observation(path, true, observation) {
        Ok(value) => Ok(Some(value)),
        Err(failure) if failure.0.starts_with("code_provenance_") => Err(error(&failure.0)),
        Err(_) => Ok(None),
    }
}

/// Follow ordinary Node owner source preflight before projecting imported
/// acceptance. This bounded native profile never creates acceptance or keys.
pub fn inspect_ordinary_owner_acceptance_status_with_cancellation_v1(
    workspace_root: &Path,
    runtime_root: &Path,
    cancelled: &AtomicBool,
) -> Result<Value> {
    let mut observation = bounded::Observation::new(cancelled)?;
    let matrix = reader::read_with_observation(
        &workspace_root.join("migration/legacy-semantic-migration-matrix.json"),
        false,
        &mut observation,
    )
    .map_err(|failure| error(&failure.0))?;
    // Node computes current provenance unconditionally, including when there
    // are no owner signatures. Missing Git is an error, not pending acceptance.
    provenance::current_operational_with_observation(workspace_root, &mut observation)?;
    let manifest = reader::read_with_observation(
        &workspace_root
            .join("paper-domain/governance/legacy-owner-acceptance-family-manifest.v1.json"),
        false,
        &mut observation,
    )
    .map_err(|failure| error(&failure.0))?;
    let families = owner_status::build_owner_acceptance_families_v1(&matrix.document)
        .map_err(|failure| error(&failure.0))?;
    if families != manifest.document {
        return Err(error("legacy_owner_acceptance_active_manifest_drift"));
    }
    let mut required = BTreeSet::new();
    for family in families["families"].as_array().into_iter().flatten() {
        observation.checkpoint()?;
        for capability in family["capabilityIds"].as_array().into_iter().flatten() {
            required.insert(
                capability
                    .as_str()
                    .ok_or_else(|| error("legacy_owner_acceptance_matrix_invalid"))?,
            );
        }
    }
    for capability in required {
        observation.checkpoint()?;
        let target = OPERATIONAL_CAPABILITIES_V1
            .iter()
            .find(|(id, _)| *id == capability)
            .map(|(_, target)| target)
            .ok_or_else(|| error("legacy_owner_acceptance_capability_unknown"))?;
        let target_path = workspace_root.join(target);
        if target_path.exists() {
            observation.read_file(&target_path, bounded::MAX_FILE_BYTES)?;
        }
        // The incumbent matrix always hashes these files for covered rows,
        // even when operational evidence and owner acceptance are pending.
        observation.read_file(
            &workspace_root.join(format!(
                "migration/tests/capabilities/{capability}.test.mjs"
            )),
            bounded::MAX_FILE_BYTES,
        )?;
    }
    let document = read_optional(
        &runtime_root.join("owner-acceptance/CAPABILITY_OWNER_ACCEPTANCE.json"),
        &mut observation,
    )?;
    let trust = read_optional(
        &runtime_root.join("owner-acceptance/OWNER_TRUST_STORE.json"),
        &mut observation,
    )?;
    let projection = |document: &Value, trust: &Value| {
        owner_status::owner_acceptance_status_from_values_v1(
            &matrix.document,
            &manifest.document,
            document,
            trust,
        )
        .map_err(|failure| error(&failure.0))
    };
    let result = projection(
        document
            .as_ref()
            .map_or(&Value::Null, |value| &value.document),
        trust.as_ref().map_or(&Value::Null, |value| &value.document),
    )?;
    matrix
        .assert_current()
        .map_err(|failure| error(&failure.0))?;
    manifest
        .assert_current()
        .map_err(|failure| error(&failure.0))?;
    observation.checkpoint()?;
    if document
        .as_ref()
        .is_some_and(|value| value.assert_current().is_err())
        || trust
            .as_ref()
            .is_some_and(|value| value.assert_current().is_err())
    {
        return projection(&Value::Null, &Value::Null);
    }
    Ok(result)
}
