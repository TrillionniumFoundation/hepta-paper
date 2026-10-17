//! Current V1 machine-intake health derived from actual configuration/static files
//! and a private snapshot of the original SQLite state. This report is diagnostic;
//! it never admits work or grants mutation, provider or deployment authority.
pub(crate) mod configuration;
pub(crate) mod contract;
mod retry_time;
mod status;

use crate::autonomous_provider_configuration::resolve_autonomous_provider_configuration_v1;
use configuration::ObservedMachineIntakeConfigurationV1;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

/// Environment inputs read by the current-intake observer. No credential files
/// or unrelated environment values are inspected.
pub const MACHINE_INTAKE_ENVIRONMENT_KEYS_V1: [&str; 12] = [
    "HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG",
    "HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE",
    "HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE",
    "HEPTA_RESEARCH_AUTHOR_PROVIDER",
    "HEPTA_RESEARCH_AUTHOR_CODEX_BINARY",
    "HEPTA_RESEARCH_AUTHOR_CODEX_HOME",
    "HEPTA_RESEARCH_AUTHOR_MODEL",
    "HEPTA_FORMAL_REVIEW_PROVIDER",
    "HEPTA_FORMAL_REVIEW_CODEX_BINARY",
    "HEPTA_FORMAL_REVIEW_CODEX_HOME",
    "HEPTA_FORMAL_REVIEW_MODEL",
    "CODEX_HOME",
];

fn push(blockers: &mut Vec<String>, code: impl Into<String>) {
    let code = code.into();
    if !blockers.contains(&code) {
        blockers.push(code);
    }
}
fn absent_readiness(provider: Option<&Value>) -> Value {
    json!({"configurationReady":false,"configurationHash":null,
        "currentProviderConfigurationHash":provider.and_then(|value|value.get("autonomousResearchProviderConfigurationHash")).cloned().unwrap_or(Value::Null),
        "recurringGoldenReady":false,"recurringGoldenProviderConfigurationBound":false,
        "staticIntakeProviderConfigurationBound":false,"machineAppendAuthorized":false,
        "machineProducerAdmissionCapabilityReady":false,"topicProducerDatasetSnapshot":null,
        "topicProducerDatasetSnapshotHash":null,"productionIntakeReady":false,"blockers":[]})
}

/// Inspect builtin-family V1 configuration, static content and generation-one
/// database state without loading configured work. Unsupported V2/plugin/scoped
/// dataset paths remain explicitly blocked rather than being promoted by hashes.
pub fn inspect_machine_intake_status_v1(
    runtime_root: &Path,
    environment: &BTreeMap<String, String>,
    working_directory: &Path,
    now_millis: i64,
) -> Value {
    let requested = environment
        .get("HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG")
        .filter(|value| !value.is_empty());
    let configured = requested.is_some();
    let mut blockers = Vec::new();
    let plugin_override = [
        "HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE",
        "HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE",
    ]
    .into_iter()
    .any(|key| environment.get(key).is_some_and(|value| !value.is_empty()));
    let observed = if let Some(path) = requested {
        if plugin_override {
            push(
                &mut blockers,
                "autonomous_research_machine_intake_plugin_registry_unsupported",
            );
            None
        } else {
            match ObservedMachineIntakeConfigurationV1::load(Path::new(path), working_directory) {
                Ok(value) => Some(value),
                Err(error) => {
                    push(
                        &mut blockers,
                        "autonomous_research_machine_intake_configuration_invalid_or_drifted",
                    );
                    if error.ends_with("_unsupported") {
                        push(&mut blockers, error);
                    }
                    None
                }
            }
        }
    } else {
        push(
            &mut blockers,
            "autonomous_research_machine_intake_configuration_missing",
        );
        None
    };
    let provider = match resolve_autonomous_provider_configuration_v1(
        &BTreeMap::new(),
        environment,
        working_directory,
    ) {
        Ok(value) => Some(value),
        Err(_) => {
            push(
                &mut blockers,
                "autonomous_research_machine_intake_provider_configuration_invalid",
            );
            None
        }
    };
    // Derive the projected identities and close every authority file before any
    // SQLite connection opens. Cross-file/database observation is not atomic.
    let (configuration, readiness) = match observed {
        Some(observed) => match observed.assert_current() {
            Ok(()) => (
                Some(observed.configuration().clone()),
                observed.readiness(provider.as_ref()),
            ),
            Err(_) => {
                push(
                    &mut blockers,
                    "autonomous_research_machine_intake_configuration_invalid_or_drifted",
                );
                (None, absent_readiness(provider.as_ref()))
            }
        },
        None => (None, absent_readiness(provider.as_ref())),
    };
    for code in readiness["blockers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        push(&mut blockers, code);
    }
    let mut report = readiness;
    report["configured"] = json!(configured);
    report["configurationValid"] = json!(configuration.is_some());
    report["machineProducerLive"] = json!(false);
    report["machineProducerCurrentlyProducible"] = json!(false);
    report["topicProducerState"] = Value::Null;
    report["statusReadOnly"] = json!(true);
    report["configuredIntakesLoadedByStatus"] = json!(false);
    match status::inspect(runtime_root, now_millis) {
        Ok(state) => {
            let bound = configuration.as_ref().is_some_and(|configuration| {
                state["configuredSourceAuthorityHash"] == configuration["configurationHash"]
            });
            if configuration.is_some() && !bound {
                push(
                    &mut blockers,
                    if state["configuredSourceAuthorityHash"].is_null() {
                        "autonomous_research_machine_intake_repository_configuration_authority_unbound"
                    } else {
                        "autonomous_research_machine_intake_repository_configuration_authority_mismatch"
                    },
                );
            }
            report["repositoryConfigurationAuthorityBound"] = json!(bound);
            report["repositoryProducerAuthorityBound"] = json!(true);
            report["repositoryAuthorityGeneration"] =
                state["configuredAuthorityGeneration"].clone();
            report["state"] = state;
        }
        Err(error) => {
            push(
                &mut blockers,
                "autonomous_research_machine_intake_state_invalid_or_migration_required",
            );
            if error.ends_with("_unsupported") {
                push(&mut blockers, error.clone());
            }
            report["repositoryConfigurationAuthorityBound"] = json!(false);
            report["repositoryProducerAuthorityBound"] = json!(false);
            report["repositoryAuthorityGeneration"] = Value::Null;
            report["state"] = Value::Null;
            report["stateError"] = json!(error);
        }
    }
    report["coldStartAutonomyReady"] = json!(blockers.is_empty());
    report["blockers"] = json!(blockers);
    report
}
