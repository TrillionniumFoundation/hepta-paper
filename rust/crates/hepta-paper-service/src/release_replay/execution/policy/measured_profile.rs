//! Fixed resource profile measured against the immutable 263-source archive.
//! The exception binds exactly one known path, matrix id and original hash.
use super::{ReleaseAttestationPolicyReplayRequestV4, error};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseAttestationMeasuredPolicyReplayRequestV8 {
    pub version: u16,
    pub kind: String,
    pub resource_profile: String,
    pub policy: ReleaseAttestationPolicyReplayRequestV4,
}
#[derive(Clone, Copy)]
pub(super) enum SourceLimits {
    OriginalV4,
    Measured263V1,
}
impl SourceLimits {
    pub(super) fn archive(self) -> u64 {
        match self {
            Self::OriginalV4 => 128 * 1024 * 1024,
            Self::Measured263V1 => 64 * 1024 * 1024,
        }
    }
    pub(super) fn selected(self) -> u64 {
        match self {
            Self::OriginalV4 => 128 * 1024 * 1024,
            Self::Measured263V1 => 32 * 1024 * 1024,
        }
    }
    pub(super) fn file(self, id: &str, path: &str, sha: &str) -> u64 {
        if matches!(self, Self::Measured263V1)
            && id == "p0-primary-entrypoint-boundary"
            && path == "bin/paperctl"
            && sha == "ffe4dfc7de97062cb99b6398c49b1e99355aba4492acc513b7d387126d617d8a"
        {
            16 * 1024 * 1024
        } else {
            4 * 1024 * 1024
        }
    }
    pub(super) fn report(self) -> Value {
        match self {
            Self::OriginalV4 => {
                json!({"version":4,"profile":"original_policy_replay_v4","maximumArchiveBytes":self.archive(),"maximumSelectedSourceBytes":self.selected(),"maximumSelectedSourceFileBytes":4*1024*1024})
            }
            Self::Measured263V1 => {
                json!({"version":1,"profile":"immutable_263_source_inspection_v1","archiveSha256":"sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d","maximumArchiveBytes":self.archive(),"maximumSelectedSourceBytes":self.selected(),"defaultMaximumSelectedSourceFileBytes":4*1024*1024,"exception":{"matrixId":"p0-primary-entrypoint-boundary","path":"bin/paperctl","sha256":"sha256:ffe4dfc7de97062cb99b6398c49b1e99355aba4492acc513b7d387126d617d8a","maximumBytes":16*1024*1024,"measuredBytes":14848944},"measuredSelectedSourceBytes":22908239})
            }
        }
    }
}
pub(super) fn validate(
    request: &ReleaseAttestationMeasuredPolicyReplayRequestV8,
) -> Result<(), String> {
    if request.version != 8
        || request.kind != "ReleaseAttestationMeasuredPolicyReplayRequest"
        || request.resource_profile != "immutable_263_source_inspection_v1"
        || request.policy.archive_sha256
            != "sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d"
    {
        return Err(error("measured_profile_identity_invalid"));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn measured_large_source_exception_is_precise_and_legacy_cap_is_unchanged() {
        let (id, path, sha) = (
            "p0-primary-entrypoint-boundary",
            "bin/paperctl",
            "ffe4dfc7de97062cb99b6398c49b1e99355aba4492acc513b7d387126d617d8a",
        );
        assert_eq!(
            SourceLimits::OriginalV4.file(id, path, sha),
            4 * 1024 * 1024
        );
        assert_eq!(
            SourceLimits::Measured263V1.file(id, path, sha),
            16 * 1024 * 1024
        );
        for (a, b, c) in [
            ("other", path, sha),
            (id, "bin/paperctl/child", sha),
            (id, "bin/./paperctl", sha),
            (id, "bin/paperctl-copy", sha),
            (
                id,
                path,
                "0000000000000000000000000000000000000000000000000000000000000000",
            ),
        ] {
            assert_eq!(SourceLimits::Measured263V1.file(a, b, c), 4 * 1024 * 1024)
        }
        assert_eq!(SourceLimits::Measured263V1.selected(), 32 * 1024 * 1024);
        assert_eq!(SourceLimits::Measured263V1.archive(), 64 * 1024 * 1024);
    }
}
