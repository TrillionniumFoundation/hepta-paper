//! Actual V1 configuration/static-file observation consumed by current-intake health.
//! Keep this owner outside SQLite lifetimes: assert_current and drop it before
//! opening a database snapshot. It conveys data validity, never live authority.
use super::contract;
use serde_json::{Value, json};
use std::{collections::BTreeSet, path::Path};

#[path = "configuration_files.rs"]
mod files;
use files::ObservedJsonFile;

pub(crate) const V2_UNSUPPORTED: &str =
    "autonomous_research_machine_intake_configuration_v2_unsupported";
pub(crate) const LOCAL_GOLDEN_UNSUPPORTED: &str =
    "autonomous_research_machine_intake_local_golden_scope_unsupported";
const CONFIGURATION_KEYS: &[&str] = &[
    "configurationHash",
    "kind",
    "machineAppendEnabled",
    "recurringGoldenTemplates",
    "staticIntakeFiles",
    "version",
];
fn invalid() -> String {
    "autonomous_research_machine_intake_configuration_invalid".into()
}
fn exposure_valid(templates: &[Value]) -> bool {
    let mut totals = [0.0; 7];
    let keys = [
        "maxCostUsd",
        "maxAgentCalls",
        "maxCpuJobs",
        "maxGpuJobs",
        "maxTokenCount",
        "maxWallTimeMs",
    ];
    for template in templates {
        let Some(epoch) = contract::epoch(&template["epochDurationMs"]) else {
            return false;
        };
        let campaigns = (contract::DAY_MS / epoch) as f64;
        totals[0] += campaigns;
        for (i, key) in keys.iter().enumerate() {
            let Some(budget) = template["budgets"][*key].as_f64() else {
                return false;
            };
            totals[i + 1] += campaigns * budget;
        }
    }
    [
        24.0,
        2400.0,
        1152.0,
        65_536.0,
        65_536.0,
        7_200_000.0,
        172_800_000.0,
    ]
    .iter()
    .enumerate()
    .all(|(i, maximum)| totals[i] <= *maximum)
}
pub(crate) fn verify_configuration_v1(value: &Value) -> bool {
    if !contract::exact_keys(value, CONFIGURATION_KEYS)
        || value["version"].as_f64() != Some(1.0)
        || value["kind"] != "AutonomousResearchMachineIntakeConfiguration"
        || !value["machineAppendEnabled"].is_boolean()
    {
        return false;
    }
    let (Some(static_files), Some(templates)) = (
        value["staticIntakeFiles"].as_array(),
        value["recurringGoldenTemplates"].as_array(),
    ) else {
        return false;
    };
    if static_files.len() > 256 || templates.len() > 16 {
        return false;
    }
    let mut paths = BTreeSet::new();
    let mut hashes = BTreeSet::new();
    let mut template_ids = BTreeSet::new();
    for file in static_files {
        let Some(path) = file["path"].as_str() else {
            return false;
        };
        let Some(hash) = file["intakeHash"].as_str() else {
            return false;
        };
        if !contract::exact_keys(file, &["intakeHash", "path"])
            || !Path::new(path).is_absolute()
            || !contract::hash_valid(&file["intakeHash"])
            || !paths.insert(path)
            || !hashes.insert(hash)
        {
            return false;
        }
    }
    for template in templates {
        if !contract::verify_recurring_template(template) {
            return false;
        }
        let Some(id) = template["templateId"].as_str() else {
            return false;
        };
        if !template_ids.insert(id) {
            return false;
        }
    }
    exposure_valid(templates)
        && contract::record_hash_valid(
            value,
            "AutonomousResearchMachineIntakeConfiguration",
            "configurationHash",
        )
}
fn document(path: &Path, cwd: &Path, label: &str) -> Result<(Value, ObservedJsonFile), String> {
    let mut held = ObservedJsonFile::read(path, cwd)
        .map_err(|_| format!("autonomous_research_machine_intake_{label}_file_invalid"))?;
    let value = serde_json::from_slice(&held.bytes)
        .map_err(|_| format!("autonomous_research_machine_intake_{label}_json_invalid"))?;
    held.bytes.clear();
    Ok((value, held))
}
pub(crate) struct ObservedMachineIntakeConfigurationV1 {
    configuration: Value,
    static_intakes: Vec<Value>,
    files: Vec<ObservedJsonFile>,
}
impl ObservedMachineIntakeConfigurationV1 {
    pub(crate) fn load(path: &Path, cwd: &Path) -> Result<Self, String> {
        let (configuration, held) = document(path, cwd, "configuration")?;
        if configuration["version"].as_f64() == Some(2.0) {
            return Err(V2_UNSUPPORTED.into());
        }
        if configuration["recurringGoldenTemplates"]
            .as_array()
            .is_some_and(|values| {
                values
                    .iter()
                    .any(contract::has_unsupported_local_golden_scope)
            })
        {
            return Err(LOCAL_GOLDEN_UNSUPPORTED.into());
        }
        if !verify_configuration_v1(&configuration) {
            return Err(invalid());
        }
        let mut files = vec![held];
        let mut static_intakes = Vec::new();
        let entries = configuration["staticIntakeFiles"]
            .as_array()
            .ok_or_else(invalid)?;
        for entry in entries {
            let path = entry["path"].as_str().ok_or_else(invalid)?;
            let (intake, file) = document(Path::new(path), cwd, "static")?;
            if contract::has_unsupported_local_golden_scope(&intake) {
                return Err(LOCAL_GOLDEN_UNSUPPORTED.into());
            }
            if !contract::verify_intake(&intake) {
                return Err("autonomous_research_machine_intake_static_document_invalid".into());
            }
            if intake["launchMode"] != "production-run"
                || !intake["recurringGoldenProvenance"].is_null()
            {
                return Err(
                    "autonomous_research_machine_intake_one_shot_production_required".into(),
                );
            }
            if intake["intakeHash"] != entry["intakeHash"] {
                return Err("autonomous_research_machine_intake_static_content_drift".into());
            }
            files.push(file);
            static_intakes.push(intake);
        }
        let observation = Self {
            configuration,
            static_intakes,
            files,
        };
        observation.assert_current()?;
        Ok(observation)
    }
    pub(crate) fn configuration(&self) -> &Value {
        &self.configuration
    }
    pub(crate) fn assert_current(&self) -> Result<(), String> {
        for file in &self.files {
            file.assert_current()?;
        }
        Ok(())
    }
    /// Derived solely from loaded validated documents and the caller's resolved
    /// provider contract. The owning composition performs the final current check.
    pub(crate) fn readiness(&self, provider_configuration: Option<&Value>) -> Value {
        let provider_hash = provider_configuration
            .and_then(|value| value.get("autonomousResearchProviderConfigurationHash"))
            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            .cloned()
            .unwrap_or(Value::Null);
        let templates = self.configuration["recurringGoldenTemplates"].as_array();
        let recurring = templates.is_some_and(|values| {
            !values.is_empty()
                && values
                    .iter()
                    .all(|value| value["providerConfigurationHash"] == provider_hash)
        });
        let static_bound = !self.static_intakes.is_empty()
            && self
                .static_intakes
                .iter()
                .all(|value| value["providerConfigurationHash"] == provider_hash);
        let append = self.configuration["machineAppendEnabled"] == true;
        let mut blockers = Vec::new();
        if templates.is_none_or(Vec::is_empty) {
            blockers.push("autonomous_research_recurring_golden_template_required");
        } else if !recurring {
            blockers.push("autonomous_research_recurring_golden_provider_configuration_mismatch");
        }
        if !self.static_intakes.is_empty() && !static_bound {
            blockers.push("autonomous_research_static_intake_provider_configuration_mismatch");
        }
        if !static_bound {
            blockers.push(if append {
                "autonomous_research_machine_intake_producer_admission_capability_required"
            } else {
                "autonomous_research_production_static_intake_required"
            });
        }
        json!({
            "configurationReady":blockers.is_empty(),
            "configurationHash":self.configuration["configurationHash"],
            "currentProviderConfigurationHash":provider_hash,
            "recurringGoldenReady":recurring,
            "recurringGoldenProviderConfigurationBound":recurring,
            "staticIntakeProviderConfigurationBound":static_bound,
            "machineAppendAuthorized":append,
            "machineProducerAdmissionCapabilityReady":false,
            "machineProducerProfileHash":null,
            "machineProducerImplementationSha256":null,
            "topicProducerDatasetSnapshot":null,
            "topicProducerDatasetSnapshotHash":null,
            "productionIntakeReady":static_bound,
            "blockers":blockers
        })
    }
}
