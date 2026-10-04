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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseAttestationNativeBuildPackagePolicyReplayRequestV11 {
    pub version: u16,
    pub kind: String,
    pub native_profile: String,
    pub policy: ReleaseAttestationNativeRetirementPolicyReplayRequestV10,
}
pub(super) fn validate_build_package(
    request: &ReleaseAttestationNativeBuildPackagePolicyReplayRequestV11,
) -> Result<(), String> {
    if request.version != 11
        || request.kind != "ReleaseAttestationNativeBuildPackagePolicyReplayRequest"
        || request.native_profile != "immutable_build_package_retirement_policy_v1"
    {
        return Err(error("native_build_package_profile_identity_invalid"));
    }
    validate_retirement(&request.policy)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseAttestationNativeCommandDispositionPolicyReplayRequestV12 {
    pub version: u16,
    pub kind: String,
    pub native_profile: String,
    pub policy: ReleaseAttestationNativeBuildPackagePolicyReplayRequestV11,
}
pub(super) fn validate_command_disposition(
    request: &ReleaseAttestationNativeCommandDispositionPolicyReplayRequestV12,
) -> Result<(), String> {
    if request.version != 12
        || request.kind != "ReleaseAttestationNativeCommandDispositionPolicyReplayRequest"
        || request.native_profile != "immutable_760_command_disposition_policy_v1"
    {
        return Err(error("native_command_disposition_profile_identity_invalid"));
    }
    validate_build_package(&request.policy)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseAttestationNativeResearchRetirementPolicyReplayRequestV13 {
    pub version: u16,
    pub kind: String,
    pub native_profile: String,
    pub policy: ReleaseAttestationNativeCommandDispositionPolicyReplayRequestV12,
}
pub(super) fn validate_research_retirement(
    request: &ReleaseAttestationNativeResearchRetirementPolicyReplayRequestV13,
) -> Result<(), String> {
    if request.version != 13
        || request.kind != "ReleaseAttestationNativeResearchRetirementPolicyReplayRequest"
        || request.native_profile != "immutable_155_research_retirement_policy_v1"
    {
        return Err(error("native_research_retirement_profile_identity_invalid"));
    }
    validate_command_disposition(&request.policy)
}
