//! Bounded strangler adapter for incumbent Node capabilities.
//!
//! The adapter emits immutable Node invocation descriptions and accepts bounded
//! observations. It never launches Node, receives a central writer, or grants
//! irreversible external-effect authority.

use std::collections::BTreeMap;

use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    ActionCandidateV1, CancellationAcknowledgementV1, CancellationDispositionV1,
    CancellationRequestV1, ExecutionCommandV1, MAXIMUM_PROTOCOL_ARTIFACTS_V1, ModulePlatformError,
    PlanningRequestV1, PlanningResponseV1, PreparedResultStatusV1, PreparedResultV1,
    ProtocolEnvelopeV1, ProtocolObjectKindV1, QualificationTierV1, ResourceVectorV1,
    SideEffectClassV1,
    hash::canonical_hash,
    types::{
        duplicate_digests, is_strictly_sorted, valid_capability_id, valid_identifier, valid_semver,
    },
};

/// Stable module identity used by the strangler adapter.
pub const NODE_LEGACY_ADAPTER_MODULE_ID_V1: &str = "module.node-legacy-adapter";
/// Maximum independently declared Node capability bindings.
pub const MAXIMUM_LEGACY_CAPABILITY_BINDINGS_V1: usize = 256;
/// Maximum retained execution identities before an operator checkpoint.
pub const MAXIMUM_LEGACY_EXECUTIONS_V1: usize = 4_096;

include!("legacy_adapter/model.rs");
include!("legacy_adapter/engine.rs");
include!("legacy_adapter/support.rs");

#[cfg(test)]
include!("legacy_adapter/tests.rs");
