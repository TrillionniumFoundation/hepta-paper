/// One immutable artifact descriptor carried by the native submission package.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmissionArtifactV1 {
    /// Stable package-local name. It is an identity, not an arbitrary filesystem path.
    pub name: String,
    /// Bounded media type.
    pub media_type: String,
    /// Canonical `sha256:<64 lowercase/uppercase hex>` content identity.
    pub sha256: String,
    /// Exact artifact byte length.
    pub byte_length: u64,
}

/// One bounded metadata field for a prepared submission package.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmissionMetadataV1 {
    /// Stable metadata key.
    pub key: String,
    /// Exact bounded value. Secrets and credentials are forbidden by caller policy.
    pub value: String,
}

