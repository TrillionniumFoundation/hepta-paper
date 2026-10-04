//! Exact schema declarations compiled from the incumbent's actual exports.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
const INPUTS: &[(&str, &[u8])] = &[
    (
        "paper-adapters/automation/campaign-one-shot-attempt-journal-schema.mjs",
        include_bytes!(
            "../../../../../../paper-adapters/automation/campaign-one-shot-attempt-journal-schema.mjs"
        ),
    ),
    (
        "paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs",
        include_bytes!(
            "../../../../../../paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs"
        ),
    ),
    (
        "paper-composition/automation/autonomous-research-one-shot-campaign-attempt-state-machine.mjs",
        include_bytes!(
            "../../../../../../paper-composition/automation/autonomous-research-one-shot-campaign-attempt-state-machine.mjs"
        ),
    ),
    (
        "paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs",
        include_bytes!(
            "../../../../../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs"
        ),
    ),
];
static VALUE: OnceLock<Result<Value, String>> = OnceLock::new();
pub(super) fn contract() -> Result<&'static Value, String> {
    VALUE
        .get_or_init(|| {
            let value: Value =
                serde_json::from_slice(include_bytes!("../execution-contract.v1.json"))
                    .map_err(|_| "one_shot_mutation_contract_invalid")?;
            if value["version"] != 1
                || value["kind"] != "NativeOneShotJournalMutationContract"
                || value["sourceHashes"].as_object().map_or(0, |v| v.len()) != INPUTS.len()
                || value["schemaStatements"].as_array().map_or(0, |v| v.len()) != 17
            {
                return Err("one_shot_mutation_contract_invalid".into());
            }
            for (name, bytes) in INPUTS {
                if value["sourceHashes"][*name].as_str()
                    != Some(hex::encode(Sha256::digest(bytes)).as_str())
                {
                    return Err("one_shot_mutation_contract_source_changed".into());
                }
            }
            let prior = super::super::contract::contract()?;
            if value["schemaContractId"] != prior["schemaContractId"]
                || value["schemaContractHash"] != prior["schemaContractHash"]
            {
                return Err("one_shot_mutation_contract_schema_changed".into());
            }
            Ok(value)
        })
        .as_ref()
        .map_err(Clone::clone)
}
