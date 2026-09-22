//! Explicit compatibility contracts for two historical prepared submission jobs.
//!
//! Outputs preserve original artifact bytes and evidence. They do not read files,
//! contact a portal, or verify independently granted submission authority.

mod intent;
mod manifest;

pub use intent::prepare_legacy_submission_intent_v1;
pub use manifest::prepare_legacy_submission_manifest_v1;

use super::{
    MAX_TEXT_BYTES, NativeBusinessError, NativeBusinessOutputV1, hash_bytes, hash_serialized,
    validate_identifier, validate_inline_text,
};
use serde::{Deserialize, Serialize};

/// One recorded artifact in the historical manifest contract; no file is read.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmissionArtifactV1 {
    pub name: String,
    pub media_type: String,
    pub sha256: String,
    pub byte_length: u64,
}

/// One recorded metadata field in the historical manifest contract.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmissionMetadataV1 {
    pub key: String,
    pub value: String,
}

#[cfg(test)]
mod tests;
