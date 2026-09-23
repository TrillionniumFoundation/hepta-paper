use super::{Error, ResidentPrerequisiteInspectionOptions, Result, value::*};
use crate::{
    external_action_recovery_configuration::inspect_autonomous_research_supervisor_external_action_recovery_configuration_v1,
    external_qualification_configuration::{
        inspect_external_research_qualification_process_configuration_v1,
        read_external_research_qualification_process_configuration_v3,
    },
    operational_status::current_operational_code_provenance_v1,
    qualification_stored_evidence::{
        read_autonomous_external_qualification_state_v1,
        read_full_research_qualification_receipt_pointer_v1,
    },
    runtime_image_reproducibility::runtime_image_reproducibility_report_v2,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

/// Private completed public material cloned only from an actual V3 owner.
/// No file descriptor or constructor from caller JSON leaves this collector.
pub(super) struct ConfigurationObservation {
    pub identity: Value,
    pub public_key_pem: String,
}
pub(super) struct Observation {
    pub configuration_inspection: Value,
    pub configuration: Option<ConfigurationObservation>,
    pub pointer: Option<Value>,
    pub state: Option<Value>,
    pub runtime: Option<Value>,
    pub code: Option<Value>,
    pub recovery: Value,
    pub infrastructure_input_blockers: Vec<String>,
    pub global_input_blockers: Vec<String>,
    pub inspected_at: String,
}

pub(super) fn observe(options: &ResidentPrerequisiteInspectionOptions<'_>) -> Result<Observation> {
    if options.runtime_root.as_os_str().is_empty() {
        return Err(Error::new(
            "autonomous_research_resident_prerequisite_runtime_root_required",
        ));
    }
    let runtime_root = absolute(options.runtime_root, options.working_directory)?;
    let repository_root = absolute(options.repository_root, options.working_directory)?;
    let inspected_at = crate::sqlite_mutation_coordinator::clock::iso(options.now_millis)
        .map_err(|_| Error::new("autonomous_research_resident_clock_profile_unsupported"))?;
    provenance_environment(options.environment)?;
    let mut infrastructure_input_blockers = Vec::new();
    let mut global_input_blockers = Vec::new();

    // Preserve the original inspection-then-reader order. The first public
    // diagnostic already drops its owner. The second actual owner is explicitly
    // rechecked and dropped before any of the following SQLite readers run.
    let configuration_inspection = inspect_external_research_qualification_process_configuration_v1(
        options.external_qualification_config,
        options.environment,
        options.working_directory,
    );
    let configuration = match read_external_research_qualification_process_configuration_v3(
        options.external_qualification_config,
        options.environment,
        options.working_directory,
    ) {
        Ok(owner) => {
            let completed = ConfigurationObservation {
                identity: owner.identity().clone(),
                public_key_pem: owner.trusted_signer_public_key_pem().to_owned(),
            };
            let current = owner.assert_current();
            drop(owner);
            match current {
                Ok(()) => Some(completed),
                Err(error) => {
                    infrastructure_input_blockers.push(error.code().to_owned());
                    None
                }
            }
        }
        Err(error) => {
            infrastructure_input_blockers.push(error.code().to_owned());
            None
        }
    };
    // The pointer producer validates original raw order, actual plugin context,
    // own hash and SQLite/mirror bytes. Only this actual producer creates Some.
    let pointer = match read_full_research_qualification_receipt_pointer_v1(
        &runtime_root,
        &repository_root,
        options.environment,
        options.now_millis,
    ) {
        Ok(value) => value,
        Err(error) => {
            global_input_blockers.push(error.code().to_owned());
            None
        }
    };
    let paper_id = pointer
        .as_ref()
        .map(|pointer| &pointer["receipt"]["paperId"]);
    let state = match paper_id.filter(|paper_id| truthy(paper_id)) {
        Some(paper_id) => match paper_id.as_str() {
            Some(paper_id) => {
                match read_autonomous_external_qualification_state_v1(&runtime_root, paper_id) {
                    Ok(value) => value,
                    Err(error) => {
                        global_input_blockers.push(error.code().to_owned());
                        None
                    }
                }
            }
            None => {
                // Original path.join later throws a raw TypeError for such
                // truthy JSON values. Do not coerce it into a valid DB scope.
                global_input_blockers
                    .push("autonomous_research_resident_paper_id_profile_unsupported".to_owned());
                None
            }
        },
        None => None,
    };
    let runtime_options = runtime_options(&runtime_root, &repository_root, options, &inspected_at)?;
    let runtime = match runtime_image_reproducibility_report_v2(&runtime_options) {
        Ok(value) => Some(value),
        Err(error) => {
            infrastructure_input_blockers.push(error.to_string());
            None
        }
    };
    let code = match current_operational_code_provenance_v1(&repository_root) {
        Ok(value) => Some(value),
        Err(_) => {
            infrastructure_input_blockers
                .push("autonomous_research_current_code_identity_unavailable".to_owned());
            None
        }
    };
    // Earlier actual snapshot callbacks and code reads have fully completed.
    // The recovery inspector itself drops every regular V3/config owner.
    let recovery = inspect_autonomous_research_supervisor_external_action_recovery_configuration_v1(
        options.external_action_recovery_config,
        options.environment,
        options.working_directory,
        options.now_millis,
    );
    provenance_environment(options.environment)?;
    Ok(Observation {
        configuration_inspection,
        configuration,
        pointer,
        state,
        runtime,
        code,
        recovery,
        infrastructure_input_blockers,
        global_input_blockers,
        inspected_at,
    })
}

fn runtime_options(
    runtime_root: &Path,
    repository_root: &Path,
    options: &ResidentPrerequisiteInspectionOptions<'_>,
    now: &str,
) -> Result<Value> {
    let mut value = json!({"action":"status","runtimeRoot":runtime_root,"repositoryRoot":repository_root,
        "environment":options.environment,"now":now});
    // The existing runtime composition resolves relative paths against process
    // cwd. Resolve just the selected paths here; never mutate ambient cwd/env or
    // the environment whose actual command identities the readers will hash.
    for (key, field) in [
        ("HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG", "configPath"),
        ("HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT", "receiptPath"),
    ] {
        if let Some(path) = options.environment.get(key).filter(|path| !path.is_empty()) {
            value[field] = json!(absolute(Path::new(path), options.working_directory)?);
        }
    }
    Ok(value)
}

fn provenance_environment(environment: &BTreeMap<String, String>) -> Result<()> {
    const KEYS: &[&str] = &[
        "HEPTA_RELEASE_COMMIT",
        "HEPTA_RELEASE_ENV_LAUNCHER",
        "HEPTA_EVIDENCE_ENVIRONMENT",
        "HEPTA_EVIDENCE_CLASS",
    ];
    for key in KEYS {
        let actual = std::env::var_os(key)
            .map(|value| {
                value.into_string().map_err(|_| {
                    Error::new(
                        "autonomous_research_resident_provenance_environment_profile_unsupported",
                    )
                })
            })
            .transpose()?
            .filter(|value| !value.is_empty());
        let supplied = environment.get(*key).filter(|value| !value.is_empty());
        if *key == "HEPTA_RELEASE_COMMIT" && (actual.is_some() || supplied.is_some()) {
            return Err(Error::new(
                "autonomous_research_resident_release_commit_profile_unsupported",
            ));
        }
        if actual.as_ref() != supplied {
            return Err(Error::new(
                "autonomous_research_resident_provenance_environment_profile_unsupported",
            ));
        }
    }
    Ok(())
}
