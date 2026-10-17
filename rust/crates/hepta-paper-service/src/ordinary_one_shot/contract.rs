//! Generated immutable facts retain their actual incumbent source identities.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
static CONTRACT: OnceLock<Result<Value, String>> = OnceLock::new();
const SOURCES: &[(&str, &[u8])] = &[
    (
        "paper-domain/automation/autonomous-research-one-shot-campaign-attempt-keys.data.mjs",
        include_bytes!(
            "../../../../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt-keys.data.mjs"
        ),
    ),
    (
        "paper-domain/automation/autonomous-research-one-shot-historical-attempt-anchors.data.mjs",
        include_bytes!(
            "../../../../../paper-domain/automation/autonomous-research-one-shot-historical-attempt-anchors.data.mjs"
        ),
    ),
    (
        "paper-domain/automation/autonomous-research-one-shot-target-campaign.mjs",
        include_bytes!(
            "../../../../../paper-domain/automation/autonomous-research-one-shot-target-campaign.mjs"
        ),
    ),
    (
        "paper-domain/automation/autonomous-research-one-shot-campaign-execution-binding.mjs",
        include_bytes!(
            "../../../../../paper-domain/automation/autonomous-research-one-shot-campaign-execution-binding.mjs"
        ),
    ),
    (
        "paper-domain/automation/autonomous-research-one-shot-provider-runtime-binding.mjs",
        include_bytes!(
            "../../../../../paper-domain/automation/autonomous-research-one-shot-provider-runtime-binding.mjs"
        ),
    ),
    (
        "paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs",
        include_bytes!(
            "../../../../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs"
        ),
    ),
    (
        "paper-domain/automation/autonomous-research-one-shot-canonical-json.mjs",
        include_bytes!(
            "../../../../../paper-domain/automation/autonomous-research-one-shot-canonical-json.mjs"
        ),
    ),
    (
        "paper-composition/automation/autonomous-research-one-shot-campaign-attempt-composition.mjs",
        include_bytes!(
            "../../../../../paper-composition/automation/autonomous-research-one-shot-campaign-attempt-composition.mjs"
        ),
    ),
    (
        "paper-adapters/automation/campaign-one-shot-attempt-journal-schema.mjs",
        include_bytes!(
            "../../../../../paper-adapters/automation/campaign-one-shot-attempt-journal-schema.mjs"
        ),
    ),
    (
        "paper-adapters/automation/campaign-one-shot-attempt-journal-support.mjs",
        include_bytes!(
            "../../../../../paper-adapters/automation/campaign-one-shot-attempt-journal-support.mjs"
        ),
    ),
    (
        "paper-adapters/automation/campaign-one-shot-attempt-journal-inspection.mjs",
        include_bytes!(
            "../../../../../paper-adapters/automation/campaign-one-shot-attempt-journal-inspection.mjs"
        ),
    ),
    (
        "paper-core/bin/autonomous-research-one-shot-campaign-attempt.mjs",
        include_bytes!(
            "../../../../../paper-core/bin/autonomous-research-one-shot-campaign-attempt.mjs"
        ),
    ),
    (
        "workflow-kernel/record-hash.mjs",
        include_bytes!("../../../../../workflow-kernel/record-hash.mjs"),
    ),
];
pub(super) fn contract() -> Result<&'static Value, String> {
    CONTRACT
        .get_or_init(|| {
            let value: Value = serde_json::from_slice(include_bytes!("contract.v1.json"))
                .map_err(|_| "one_shot_status_contract_invalid".to_owned())?;
            if value["version"] != 1
                || value["kind"] != "NativeOneShotHistoricalStatusContract"
                || value["sourceHashes"].as_object().map_or(0, |v| v.len()) != SOURCES.len()
            {
                return Err("one_shot_status_contract_invalid".into());
            }
            for (name, bytes) in SOURCES {
                if value["sourceHashes"][*name].as_str()
                    != Some(hex::encode(Sha256::digest(bytes)).as_str())
                {
                    return Err("one_shot_status_contract_source_changed".into());
                }
            }
            Ok(value)
        })
        .as_ref()
        .map_err(Clone::clone)
}
