//! Actual-source completed topic status diagnostics. No lease, provider action,
//! authority grant, schema repair or machine-intake V2 activation is performed.
mod sqlite;
mod status;

use crate::topic_producer_profile::{
    TopicProducerProfileReadOptionsV1, read_autonomous_research_topic_producer_profile_v1,
};
use serde_json::{Value, json};
use std::{
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
};

const RELATIVE: &str = "autonomous-research/topic-producer/topic-producer.sqlite";
const INVALID: &str = "autonomous_research_topic_producer_state_invalid";
const SCHEMA: &str = "autonomous_research_topic_producer_state_schema_unsupported";
const STORAGE: &str = "autonomous_research_topic_producer_state_storage_profile_unsupported";
const TIME: &str = "autonomous_research_topic_producer_date_parse_profile_unsupported";
const LIMIT: &str = "autonomous_research_topic_producer_status_bound_exceeded";

/// Paths and expected comparison identity only. The expected configuration hash
/// is not an owning observation of a current machine-intake V2 configuration.
pub struct TopicProducerStatusOptionsV1<'a> {
    pub runtime_root: &'a Path,
    pub profile: TopicProducerProfileReadOptionsV1<'a>,
    pub expected_machine_intake_configuration_hash: &'a str,
    /// Canonical ECMAScript ISO timestamp, including canonical expanded years.
    pub now: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{code}")]
pub struct TopicProducerStatusError {
    code: String,
}
impl TopicProducerStatusError {
    fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }
    pub fn code(&self) -> &str {
        &self.code
    }
}
pub type Result<T> = std::result::Result<T, TopicProducerStatusError>;

struct Context {
    profile: Value,
    implementation: String,
    configuration: String,
    now: i64,
    now_iso: String,
    epoch: String,
}

fn empty(code: impl Into<String>) -> Value {
    json!({"ready":false,"live":false,"currentlyProducible":false,"latestCapabilityFresh":false,"blocker":code.into()})
}

fn runtime_path(path: &Path, cwd: &Path) -> Result<PathBuf> {
    if path.as_os_str().is_empty() || !cwd.is_absolute() {
        return Err(TopicProducerStatusError::new(
            "autonomous_research_topic_producer_status_dependencies_invalid",
        ));
    }
    // Bound the supplied spelling before joining, normalization or filesystem
    // IO; a long sequence of `../` must not evade a normalized-path bound.
    for supplied in [path, cwd] {
        let text = supplied.to_str().ok_or_else(|| {
            TopicProducerStatusError::new(
                "autonomous_research_topic_producer_path_profile_unsupported",
            )
        })?;
        if text.len() > 4096 || text.contains('\0') || supplied.components().count() > 128 {
            return Err(TopicProducerStatusError::new(
                "autonomous_research_topic_producer_path_profile_unsupported",
            ));
        }
    }
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        cwd.join(path)
    };
    if absolute.as_os_str().len() > 4096 || absolute.components().count() > 128 {
        return Err(TopicProducerStatusError::new(
            "autonomous_research_topic_producer_path_profile_unsupported",
        ));
    }
    let mut normalized = PathBuf::from("/");
    for part in absolute.components() {
        match part {
            Component::RootDir | Component::CurDir => (),
            Component::Normal(value) => normalized.push(value),
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(_) => {
                return Err(TopicProducerStatusError::new(
                    "autonomous_research_topic_producer_path_profile_unsupported",
                ));
            }
        }
    }
    if normalized.to_str().is_none() {
        return Err(TopicProducerStatusError::new(
            "autonomous_research_topic_producer_path_profile_unsupported",
        ));
    }
    Ok(normalized)
}

/// Read actual profile/dataset/implementation inputs and effective committed
/// SQLite state. All source regular-file owners are dropped before the private
/// SQLite snapshot phase begins. Invoke this before caller-owned business SQL.
/// The observations are sequential, not an atomic cross-file/database snapshot.
pub fn inspect_autonomous_research_topic_producer_status_v1(
    options: &TopicProducerStatusOptionsV1<'_>,
) -> Result<Value> {
    let runtime = runtime_path(options.runtime_root, options.profile.working_directory)?;
    if options.expected_machine_intake_configuration_hash.len() > 4096 {
        return Err(TopicProducerStatusError::new(LIMIT));
    }
    let context = {
        let observed = read_autonomous_research_topic_producer_profile_v1(&options.profile)
            .map_err(|error| TopicProducerStatusError::new(error.code()))?;
        let now =
            crate::journal_connector_coverage::qualification::canonical_instant_millis(options.now)
                .ok_or_else(|| TopicProducerStatusError::new(TIME))?;
        let identity = observed.identity();
        let profile = identity["producerProfile"].clone();
        let implementation = identity["implementationIdentity"]["implementationSha256"]
            .as_str()
            .ok_or_else(|| {
                TopicProducerStatusError::new(
                    "autonomous_research_topic_producer_status_dependencies_invalid",
                )
            })?
            .to_owned();
        let (date, _) = options
            .now
            .split_once('T')
            .ok_or_else(|| TopicProducerStatusError::new(TIME))?;
        let context = Context {
            profile,
            implementation,
            configuration: options
                .expected_machine_intake_configuration_hash
                .to_owned(),
            now,
            now_iso: options.now.to_owned(),
            epoch: format!("{date}T00:00:00.000Z"),
        };
        observed
            .assert_current()
            .map_err(|error| TopicProducerStatusError::new(error.code()))?;
        // A dataset/implementation argument may alias a caller's business DB.
        // No ordinary FD from this owner is allowed into the SQLite phase.
        drop(observed);
        context
    };
    let source = runtime.join(RELATIVE);
    let stat = match std::fs::symlink_metadata(&source) {
        Ok(stat) => stat,
        Err(_) => return Ok(empty("autonomous_research_topic_producer_state_missing")),
    };
    if !stat.is_file() || stat.file_type().is_symlink() || stat.mode() & 0o022 != 0 {
        return Ok(empty(INVALID));
    }
    let result = crate::state_database_inventory::with_database_effective_snapshot_path_v1(
        &runtime,
        Path::new(RELATIVE),
        "topic-producer",
        |path| status::inspect(path, &context),
    );
    // Callback failures and source observation failures both remain diagnostics,
    // never a successful report accompanied by discarded source-recheck errors.
    Ok(match result {
        Ok(value) => value,
        Err(error) => empty(error.code),
    })
}
