//! Actual-source topic profile and mounted-dataset observation. The original
//! JavaScript implementation digest is an incumbent source identity only: this
//! observer neither executes a producer nor grants intake/provider authority.
mod contract;
mod dataset;
mod files;

use hepta_legacy_compatibility::{production_hash_record_v1, production_stable_json_v1};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

type Result<T> = std::result::Result<T, TopicProducerProfileError>;
const PREFIX: &str = "autonomous_research_topic_producer_";
const IMPLEMENTATION_ID: &str = "hepta-registered-bounded-topic-producer-v1";
const IMPLEMENTATION_RELATIVE: &str =
    "paper-adapters/automation/autonomous-research-topic-producer-implementation.mjs";

#[derive(Debug, thiserror::Error)]
#[error("{code}")]
pub struct TopicProducerProfileError {
    code: String,
}
impl TopicProducerProfileError {
    fn new(suffix: &str) -> Self {
        Self {
            code: format!("{PREFIX}{suffix}"),
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }
}
fn ensure(condition: bool, suffix: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(TopicProducerProfileError::new(suffix))
    }
}
fn hash(domain: &str, value: &Value) -> Result<String> {
    production_hash_record_v1(domain, value)
        .map(|hash| hash.as_str().to_owned())
        .map_err(|_| TopicProducerProfileError::new("json_profile_unsupported"))
}

/// Paths and expected data identities only. No caller-supplied readiness,
/// implementation bytes, dataset manifest, authority or trust object is accepted.
pub struct TopicProducerProfileReadOptionsV1<'a> {
    pub profile_path: Option<&'a Path>,
    pub dataset_root: Option<&'a Path>,
    pub repository_root: &'a Path,
    pub working_directory: &'a Path,
    pub environment: &'a BTreeMap<String, String>,
    pub expected_profile_hash: Option<&'a str>,
    pub expected_provider_configuration_hash: Option<&'a str>,
}

/// Retains the actual source descriptors used by this completed diagnostic.
/// `assert_current` reobserves those objects and their names; it is not an atomic
/// snapshot or a live authority check. Drop this owner BEFORE opening any
/// caller-owned business SQLite connection: arbitrary mounted/configured files
/// could alias a database whose process-scoped locks are affected by FD close.
pub struct ObservedTopicProducerProfileV1 {
    identity: Value,
    observations: files::Observations,
}
impl ObservedTopicProducerProfileV1 {
    pub fn identity(&self) -> &Value {
        &self.identity
    }

    pub fn assert_current(&self) -> Result<()> {
        self.observations.assert_current()
    }
}

/// Load and verify a real serialized builtin profile, actual mounted dataset
/// bytes and the fixed original implementation source. Never executes Node,
/// provider/canary code, a child process, RPC, or any SQLite operation.
pub fn read_autonomous_research_topic_producer_profile_v1(
    options: &TopicProducerProfileReadOptionsV1<'_>,
) -> Result<ObservedTopicProducerProfileV1> {
    let requested = options
        .profile_path
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| {
            options
                .environment
                .get("HEPTA_AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_PROFILE")
                .filter(|path| !path.is_empty())
                .map(Path::new)
        })
        .ok_or_else(|| TopicProducerProfileError::new("profile_required"))?;
    for key in [
        "HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE",
        "HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE",
    ] {
        ensure(
            !options
                .environment
                .get(key)
                .is_some_and(|value| !value.is_empty()),
            "plugin_registry_unsupported",
        )?;
    }
    let profile_path = files::absolute(requested, options.working_directory)?;
    let mut observations = files::Observations::default();
    let loaded = observations
        .file(&profile_path, files::FileKind::Profile)
        .map_err(|error| error.original_or("profile_file_invalid"))?;
    let text = std::str::from_utf8(&loaded.bytes)
        .map_err(|_| TopicProducerProfileError::new("profile_encoding_unsupported"))?;
    let profile: Value = serde_json::from_str(text)
        .map_err(|_| TopicProducerProfileError::new("profile_json_invalid"))?;
    contract::verify(&profile)?;
    for (expected, key) in [
        (options.expected_profile_hash, "producerProfileHash"),
        (
            options.expected_provider_configuration_hash,
            "providerConfigurationHash",
        ),
    ] {
        if let Some(expected) = expected.filter(|hash| !hash.is_empty()) {
            ensure(
                profile[key].as_str() == Some(expected),
                "profile_invalid_or_mismatched",
            )?;
        }
    }
    let dataset_root = options
        .dataset_root
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| {
            options
                .environment
                .get("HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT")
                .filter(|path| !path.is_empty())
                .map(Path::new)
        })
        .ok_or_else(|| TopicProducerProfileError::new("dataset_root_required"))?;
    ensure(dataset_root.is_absolute(), "dataset_root_required")?;
    let dataset_root = files::absolute(dataset_root, options.working_directory)?;
    let dataset = dataset::inspect(&profile, &dataset_root, &mut observations)?;
    let repository = files::absolute(options.repository_root, options.working_directory)?;
    let implementation_path = repository.join(IMPLEMENTATION_RELATIVE);
    let implementation_hash = observations
        .file(&implementation_path, files::FileKind::Implementation)
        .map_err(|error| error.original_or("implementation_identity_file_invalid"))?
        .hash
        .clone();
    ensure(
        profile["implementationSha256"].as_str() == Some(implementation_hash.as_str()),
        "implementation_identity_mismatch",
    )?;
    let identity = json!({
        "profilePath":profile_path,"producerProfile":profile,
        "implementationIdentity":{
            "ready":true,"implementationId":IMPLEMENTATION_ID,
            "implementationPath":implementation_path,"implementationSha256":implementation_hash,
            "expectedImplementationSha256":profile["implementationSha256"],"blocker":null,
        },
        "datasetSnapshot":dataset,
    });
    // The original JSON boundary emits ECMAScript Number spelling (1.0 -> 1).
    let identity = production_stable_json_v1(&identity)
        .map_err(|_| TopicProducerProfileError::new("json_profile_unsupported"))
        .and_then(|bytes| {
            serde_json::from_slice(&bytes)
                .map_err(|_| TopicProducerProfileError::new("json_profile_unsupported"))
        })?;
    observations.assert_current()?;
    Ok(ObservedTopicProducerProfileV1 {
        identity,
        observations,
    })
}

impl TopicProducerProfileError {
    fn original_or(self, suffix: &str) -> Self {
        if self.code.ends_with("_unsupported") || self.code.ends_with("_bound_exceeded") {
            self
        } else {
            Self::new(suffix)
        }
    }
}
