//! Shared strict public configuration syntax; this module never reads a private key.
use super::*;
use std::path::{Component, Path};

const CONFIGURATION_KEYS: &[&str] = &[
    "version",
    "kind",
    "authorityId",
    "keyId",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "privateKeyPath",
    "stateDatabasePath",
    "socketPath",
    "maximumReservationLeaseMs",
    "maximumObservationAgeMs",
];
fn valid_path(value: &Value) -> bool {
    value.as_str().is_some_and(|v| {
        !v.contains('\0')
            && !v.split('/').any(|part| part == "." || part == "..")
            && Path::new(v).is_absolute()
            && Path::new(v)
                .components()
                .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
            && !v.contains("//")
            && !v.ends_with('/')
    })
}
pub(crate) fn validate_configuration(value: &Value) -> Result<()> {
    if !keys(value, CONFIGURATION_KEYS)
        || value["version"] != 1
        || value["kind"] != "HeptaLocalAutonomousResearchStateAuthorityConfiguration"
        || !["authorityId", "keyId", "scopeId"]
            .iter()
            .all(|k| safe(&value[k]))
        || !["databaseScopeHash", "writerManifestHash"]
            .iter()
            .all(|k| sha(&value[k]))
        || !["privateKeyPath", "stateDatabasePath", "socketPath"]
            .iter()
            .all(|k| valid_path(&value[k]))
        || !["maximumReservationLeaseMs", "maximumObservationAgeMs"]
            .iter()
            .all(|k| {
                value[k]
                    .as_i64()
                    .is_some_and(|n| (1000..=900000).contains(&n))
            })
    {
        return Err(error("local_state_authority_configuration_invalid"));
    }
    Ok(())
}
