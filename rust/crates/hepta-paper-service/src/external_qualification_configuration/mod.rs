//! Owned, read-only V3 external qualification configuration observations.
//!
//! This port preserves the original command, credential, trust and inspection
//! hash domains. It never starts the configured processes, signs a receipt or
//! grants runtime authority. See HANDOFF.md for the finite native input profile
//! and the requirement to drop all owners before opening business SQLite.

mod command;
mod files;
mod inspection;
mod trust;
mod value;

use files::{FileKind, Observations};
use hepta_legacy_compatibility::production_stable_json_v1;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use value::*;

/// Stable diagnostic code; never includes credential bytes or OS error text.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}")]
pub struct Error {
    code: String,
}
impl Error {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_owned(),
        }
    }
    /// Original inspection blocker or a documented native-profile refusal.
    #[must_use]
    pub fn code(&self) -> &str {
        &self.code
    }
}

/// Configuration-reader result; successful construction performs real I/O.
pub type Result<T> = std::result::Result<T, Error>;

/// A completed configuration observation plus its original retained files.
///
/// Neither JSON projection is an authorization capability. No caller can
/// construct this owner from a report. `assert_current` reobserves these exact
/// owners; it does not replace the baseline or exclude concurrent writers.
/// Drop this owner before opening any caller-owned SQLite connection: argument
/// resources can name arbitrary regular files, including database aliases, and
/// closing an extra regular descriptor can release process-scoped POSIX locks.
pub struct Configuration {
    identity: Value,
    inspection: Value,
    observations: Observations,
    trusted_signer_public_key_pem: String,
    verifier_public_key_pem: String,
}

impl Configuration {
    /// Original reader projection, omitting only JavaScript public KeyObjects.
    /// `trustedSignerKeys` retains each signer and public-content/SPKI hash.
    #[must_use]
    pub fn identity(&self) -> &Value {
        &self.identity
    }

    /// Completed original-format diagnostic; it is not an external attestation.
    #[must_use]
    pub fn inspection(&self) -> &Value {
        &self.inspection
    }

    /// Recheck retained objects and their originally observed names/content.
    pub fn assert_current(&self) -> Result<()> {
        self.observations.assert_current()
    }

    /// The actual active release-attestor public PEM, never a private key.
    /// Its role remains `research_execution_release_attestor`; this accessor
    /// does not qualify it for recovery-authority or other signature domains.
    #[must_use]
    pub fn trusted_signer_public_key_pem(&self) -> &str {
        &self.trusted_signer_public_key_pem
    }

    /// Actual independent-verifier public PEM, with its original role binding.
    #[must_use]
    pub fn verifier_public_key_pem(&self) -> &str {
        &self.verifier_public_key_pem
    }
}

/// Read the actual V3 configuration and referenced file identities, without
/// invoking any process or loading a signing private key. `cwd` must be absolute
/// and determines the original Node path-resolution semantics. Credential file
/// bytes are hashed (as in Node), never returned in the diagnostic projection.
pub fn read_external_research_qualification_process_configuration_v3(
    config_path: Option<&Path>,
    environment: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<Configuration> {
    let requested = selected_path(config_path, environment, cwd)?;
    let mut observations = Observations::default();
    let file = observations.file(&requested, FileKind::Configuration)?;
    let configuration_path = file.path.clone();
    // Node's readFileSync(..., 'utf8') replaces invalid byte sequences before
    // JSON.parse. Serde still refuses unpaired surrogate strings explicitly.
    let text = String::from_utf8_lossy(&file.bytes);
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| Error::new("external_qualification_configuration_json_invalid"))?;
    const INVALID: &str = "external_qualification_configuration_invalid";
    let cost = value["maximumQualificationCostUsd"].as_f64();
    ensure(
        exact(
            &value,
            &[
                "kind",
                "maximumQualificationCostUsd",
                "qualificationCostAuthority",
                "qualifier",
                "status",
                "trustedSignerTrustSet",
                "verifier",
                "verifierAttestor",
                "version",
            ],
        ) && value["version"].as_f64() == Some(3.0)
            && value["kind"] == "ExternalResearchQualificationProcessConfiguration"
            && value["status"] == "active"
            && cost.is_some_and(|cost| (0.0..=1000.0).contains(&cost))
            && ((value["qualificationCostAuthority"] == "operator_declared_worst_case_usd"
                && cost.is_some_and(|cost| cost > 0.0))
                || (value["qualificationCostAuthority"] == "externally_operated_zero_cost"
                    && cost == Some(0.0))),
        INVALID,
    )?;
    let qualifier = command::load(
        &value["qualifier"],
        "qualifier",
        &configuration_path,
        environment,
        cwd,
        &mut observations,
    )?;
    let verifier = command::load(
        &value["verifier"],
        "verifier",
        &configuration_path,
        environment,
        cwd,
        &mut observations,
    )?;
    ensure(
        command::independent(&qualifier, &verifier),
        "external_qualification_independent_verifier_required",
    )?;
    let trusted = trust::load_set(
        &value["trustedSignerTrustSet"],
        &configuration_path,
        &mut observations,
    )?;
    let verifier_attestor = trust::load_signer(
        &value["verifierAttestor"],
        true,
        &configuration_path,
        &mut observations,
    )?;
    trust::verify_independence(&trusted, &verifier_attestor)?;
    let active = trusted.keys.get(trusted.active_index).ok_or_else(|| {
        Error::new("external_qualification_exactly_one_active_trusted_signer_required")
    })?;
    let trust_hash = hash(
        "ExternalResearchQualificationTrustIdentity",
        &json!({
            "trustedSignerTrustSetVersion": 1, "trustedSignerTrustSetHash": trusted.hash,
            "trustedSigners": trusted.public_keys, "verifierAttestor": verifier_attestor.identity["signer"],
            "verifierAttestorPublicKeySpkiHash": verifier_attestor.identity["publicKeySpkiHash"],
        }),
    )?;
    let configuration_hash = hash(
        "ExternalResearchQualificationConfigurationIdentity",
        &json!({
            "qualifierCommandIdentityHash": qualifier["commandIdentityHash"], "verifierCommandIdentityHash": verifier["commandIdentityHash"],
            "maximumQualificationCostUsd": value["maximumQualificationCostUsd"], "qualificationCostAuthority": value["qualificationCostAuthority"],
            "trustIdentityHash": trust_hash,
        }),
    )?;
    let client_hash = hash(
        "ExternalResearchQualificationClientServiceIdentity",
        &json!({
            "configurationIdentityHash": configuration_hash, "commandIdentityHash": qualifier["commandIdentityHash"],
            "serviceId": qualifier["serviceId"], "principalId": qualifier["principalId"],
        }),
    )?;
    let verifier_hash = hash(
        "ExternalResearchQualificationVerifierServiceIdentity",
        &json!({
            "configurationIdentityHash": configuration_hash, "commandIdentityHash": verifier["commandIdentityHash"],
            "serviceId": verifier["serviceId"], "principalId": verifier["principalId"], "trustIdentityHash": trust_hash,
        }),
    )?;
    let identity = json!({
        "configPath": path_text(&configuration_path)?, "qualifier": qualifier, "verifier": verifier,
        "trustedSignerTrustSetVersion": 1, "trustedSignerTrustSetHash": trusted.hash,
        "trustedSignerKeys": trusted.keys.iter().map(|key| &key.identity).collect::<Vec<_>>(),
        "trustedSigners": trusted.public_keys, "trustedSigner": active.identity["signer"],
        "trustedSignerPublicKeySpkiHash": active.identity["publicKeySpkiHash"],
        "verifierAttestor": verifier_attestor.identity["signer"],
        "verifierAttestorPublicKeySpkiHash": verifier_attestor.identity["publicKeySpkiHash"],
        "maximumQualificationCostUsd": value["maximumQualificationCostUsd"], "qualificationCostAuthority": value["qualificationCostAuthority"],
        "trustIdentityHash": trust_hash, "configurationIdentityHash": configuration_hash,
        "clientServiceIdentityHash": client_hash, "verifierServiceIdentityHash": verifier_hash,
    });
    // Project JavaScript Number serialization, e.g. timeout "1000" becomes
    // integer JSON 1000, while all identity hashes already use that profile.
    let identity = production_stable_json_v1(&identity)
        .map_err(|_| Error::new("external_qualification_json_profile_unsupported"))?;
    let identity = serde_json::from_slice(&identity)
        .map_err(|_| Error::new("external_qualification_json_profile_unsupported"))?;
    let inspection = inspection::project(Some(&identity), None)?;
    let configuration = Configuration {
        identity,
        inspection,
        observations,
        trusted_signer_public_key_pem: active.pem.clone(),
        verifier_public_key_pem: verifier_attestor.pem,
    };
    configuration.assert_current()?;
    Ok(configuration)
}

/// Complete an original-format diagnostic and close all retained files before
/// returning. Call before opening business SQLite connections or descriptors.
#[must_use]
pub fn inspect_external_research_qualification_process_configuration_v1(
    config_path: Option<&Path>,
    environment: &BTreeMap<String, String>,
    cwd: &Path,
) -> Value {
    let result = read_external_research_qualification_process_configuration_v3(
        config_path,
        environment,
        cwd,
    );
    match result {
        Ok(configuration) => configuration.inspection.clone(),
        Err(error) => match inspection::project(None, Some(error.code())) {
            Ok(inspection) => inspection,
            Err(_) => json!({
                "version": 1, "kind": "ExternalResearchQualificationProcessConfigurationInspection",
                "status": "external_research_qualification_process_configuration_blocked", "ready": false,
                "privateSigningKeyLoaded": false,
                "blockers": ["external_qualification_json_profile_unsupported"],
            }),
        },
    }
}

fn selected_path(
    config_path: Option<&Path>,
    environment: &BTreeMap<String, String>,
    cwd: &Path,
) -> Result<PathBuf> {
    let selected = config_path
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| {
            environment
                .get("HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG")
                .filter(|path| !path.is_empty())
                .map(Path::new)
        })
        .ok_or_else(|| Error::new("external_qualification_configuration_path_required"))?;
    resolve(cwd, selected)
}
