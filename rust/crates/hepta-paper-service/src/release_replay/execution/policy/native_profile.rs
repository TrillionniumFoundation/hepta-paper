//! Additional native AST observations preserve every V8 authority and archive limit.
use super::{ReleaseAttestationMeasuredPolicyReplayRequestV8, error, measured_profile};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseAttestationNativeAstPolicyReplayRequestV9 {
    pub version: u16,
    pub kind: String,
    pub native_profile: String,
    pub policy: ReleaseAttestationMeasuredPolicyReplayRequestV8,
}
pub(super) fn validate(
    request: &ReleaseAttestationNativeAstPolicyReplayRequestV9,
) -> Result<(), String> {
    if request.version != 9
        || request.kind != "ReleaseAttestationNativeAstPolicyReplayRequest"
        || request.native_profile != "immutable_245_python_ast_observation_v1"
    {
        return Err(error("native_ast_profile_identity_invalid"));
    }
    measured_profile::validate(&request.policy)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseAttestationNativeRetirementPolicyReplayRequestV10 {
    pub version: u16,
    pub kind: String,
    pub native_profile: String,
    pub policy: ReleaseAttestationNativeAstPolicyReplayRequestV9,
}
pub(super) fn validate_retirement(
    request: &ReleaseAttestationNativeRetirementPolicyReplayRequestV10,
) -> Result<(), String> {
    if request.version != 10
        || request.kind != "ReleaseAttestationNativeRetirementPolicyReplayRequest"
        || request.native_profile != "immutable_referee_venue_retirement_policy_v1"
    {
        return Err(error("native_retirement_profile_identity_invalid"));
    }
    validate(&request.policy)
}
