use super::{
    Result, TopicProducerProfileError, ensure,
    files::{self, FileKind, Observations},
    hash,
};
use hepta_legacy_compatibility::ProductionCollationV1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;

const INVALID: &str = "dataset_manifest_invalid_or_mismatched";

pub(super) fn inspect(
    profile: &Value,
    root: &Path,
    observations: &mut Observations,
) -> Result<Value> {
    observations
        .directory(root)
        .map_err(|error| error.original_or("dataset_root_invalid"))?;
    let profiles = profile["registeredResearchProfiles"]
        .as_array()
        .ok_or_else(|| TopicProducerProfileError::new("profile_invalid_or_mismatched"))?;
    let collator = ProductionCollationV1::load()
        .map_err(|_| TopicProducerProfileError::new("dataset_collation_profile_unsupported"))?;
    let mut mounts = Vec::new();
    for profile in profiles {
        let source_mounts = profile["datasetMounts"]
            .as_array()
            .ok_or_else(|| TopicProducerProfileError::new("profile_invalid_or_mismatched"))?;
        for mount in source_mounts {
            let source = mount["source"]
                .as_str()
                .ok_or_else(|| TopicProducerProfileError::new("dataset_source_invalid"))?;
            ensure(Path::new(source).is_absolute(), "dataset_source_invalid")?;
            let source = files::absolute(Path::new(source), root)?;
            ensure(
                source != root && source.starts_with(root),
                "dataset_source_invalid",
            )?;
            ensure(
                source.to_str().is_some_and(|path| !path.contains('\\')),
                "dataset_relative_name_unsupported",
            )?;
            let metadata = observations
                .kind(&source)
                .map_err(|error| error.original_or("dataset_source_invalid"))?;
            ensure(
                !metadata.is_symlink() && (metadata.is_dir() || metadata.is_file()),
                "dataset_source_invalid",
            )?;
            let (source_type, observed) = if metadata.is_file() {
                let observed = observations
                    .file(&source, FileKind::Dataset)
                    .map_err(|error| error.original_or(INVALID))?
                    .hash
                    .clone();
                ("file", observed)
            } else {
                let mut records = Vec::new();
                walk(&source, &source, observations, &collator, &mut records)
                    .map_err(|error| error.original_or(INVALID))?;
                (
                    "directory",
                    format!(
                        "sha256:{}",
                        hex::encode(Sha256::digest(records.join("\n").as_bytes()))
                    ),
                )
            };
            ensure(
                mount["manifestHash"].as_str() == Some(observed.as_str()),
                INVALID,
            )?;
            mounts.push(json!({"profileId":profile["profileId"],"name":mount["name"],"source":source,
                "sourceType":source_type,"declaredManifestHash":mount["manifestHash"],"observedManifestHash":observed}));
        }
    }
    let mut snapshot = json!({"version":1,"kind":"AutonomousResearchTopicProducerDatasetSnapshot",
        "datasetRoot":root,"mounts":mounts});
    snapshot["datasetSnapshotHash"] = json!(hash(
        "AutonomousResearchTopicProducerDatasetSnapshot",
        &snapshot
    )?);
    Ok(snapshot)
}

fn walk(
    root: &Path,
    directory: &Path,
    observations: &mut Observations,
    collator: &ProductionCollationV1,
    records: &mut Vec<String>,
) -> Result<()> {
    let mut names = observations.names(directory)?;
    names.sort_by(|left, right| collator.compare(left, right));
    for name in names {
        let path = directory.join(name);
        let metadata = observations.kind(&path)?;
        ensure(!metadata.is_symlink(), INVALID)?;
        if metadata.is_dir() {
            walk(root, &path, observations, collator, records)?;
        } else if metadata.is_file() {
            let relative = path
                .strip_prefix(root)
                .ok()
                .and_then(Path::to_str)
                .ok_or_else(|| {
                    TopicProducerProfileError::new("dataset_relative_name_unsupported")
                })?;
            // Backslash names have been explicitly refused rather than silently
            // reopening the different POSIX alias used by the original helper.
            let normalized = relative.replace('\\', "/");
            let file = observations.file(&path, FileKind::Dataset)?;
            let digest = file
                .hash
                .strip_prefix("sha256:")
                .ok_or_else(|| TopicProducerProfileError::new(INVALID))?;
            records.push(format!("{normalized}\0{digest}"));
        } else {
            return Err(TopicProducerProfileError::new(INVALID));
        }
    }
    Ok(())
}
