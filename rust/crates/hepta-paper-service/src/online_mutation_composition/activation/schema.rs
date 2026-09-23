//! Explicit initial versus historical evidence selection. Missing or invalid
//! checkpoint evidence is never replaced by an initial-readiness fallback.
use super::*;
use crate::online_schema_transition::{
    VerifiedSchemaTransitionReadinessV1,
    history::{
        checkpoint::{VerifiedSchemaTransitionCheckpointV1, load_schema_transition_checkpoint_v1},
        current::{
            SchemaHistoryInputsV1, VerifiedSchemaTransitionHistoryV1,
            verify_schema_transition_history_v1,
        },
    },
    inspect_online_schema_transition_readiness_v1,
};
use crate::{
    online_writer_static::RetainedWriterStaticInputsV1,
    state_database_inventory::NativeStoreTransactionInventoryGuardV1,
};

pub(super) enum PreparedSchemaInputV1 {
    Initial(Box<VerifiedSchemaTransitionReadinessV1>),
    Historical(Box<VerifiedSchemaTransitionCheckpointV1>),
}
pub(super) enum RetainedSchemaEvidenceV1 {
    Initial(Box<VerifiedSchemaTransitionReadinessV1>),
    Historical {
        checkpoint: Box<VerifiedSchemaTransitionCheckpointV1>,
        history: Box<VerifiedSchemaTransitionHistoryV1>,
    },
}
impl PreparedSchemaInputV1 {
    pub(super) fn load(
        request: &InitialOnlineMutationCompositionRequestV1,
        inventory: &ObservedStateDatabaseInventoryV1,
        manifest: &Value,
        authority: &mut Online,
        clock: &mut dyn MutationClockV1,
    ) -> Result<Self> {
        match &request.schema_checkpoint_root {
            Some(root) => Ok(Self::Historical(Box::new(
                load_schema_transition_checkpoint_v1(root, inventory, manifest, authority)?,
            ))),
            None => Ok(Self::Initial(Box::new(
                inspect_online_schema_transition_readiness_v1(
                    &request.runtime_root,
                    inventory,
                    manifest,
                    authority,
                    clock,
                )?,
            ))),
        }
    }
    pub(super) fn assert_post_startup(
        &self,
        initial: &ObservedStateDatabaseInventoryV1,
        current: &ObservedStateDatabaseInventoryV1,
        authority: &Online,
        clock: &mut dyn MutationClockV1,
    ) -> Result<()> {
        match self {
            Self::Initial(proof) => {
                if initial.value() != current.value() {
                    return Err(fail("schema_history_bridge_required"));
                }
                proof.assert_current(current, authority, clock)
            }
            Self::Historical(checkpoint) => checkpoint.assert_current(current, authority),
        }
    }
    pub(super) fn finish(
        self,
        current: &ObservedStateDatabaseInventoryV1,
        source: &VerifiedWriterStaticCoverageV1,
        active: &VerifiedActiveAuthorityEvidenceV1,
        finalized: &VerifiedFinalizedInventoryV1,
        authority: &mut Online,
        clock: &mut dyn MutationClockV1,
    ) -> Result<RetainedSchemaEvidenceV1> {
        match self {
            Self::Initial(proof) => Ok(RetainedSchemaEvidenceV1::Initial(proof)),
            Self::Historical(checkpoint) => {
                let history = verify_schema_transition_history_v1(
                    &SchemaHistoryInputsV1 {
                        checkpoint: &checkpoint,
                        current,
                        source,
                        active,
                        finalized,
                    },
                    authority,
                    clock,
                )?;
                Ok(RetainedSchemaEvidenceV1::Historical {
                    checkpoint,
                    history: Box::new(history),
                })
            }
        }
    }
}
impl RetainedSchemaEvidenceV1 {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn assert_retained_for_native_store_transaction(
        &self,
        current: &ObservedStateDatabaseInventoryV1,
        source: &VerifiedWriterStaticCoverageV1,
        active: &VerifiedActiveAuthorityEvidenceV1,
        finalized: &VerifiedFinalizedInventoryV1,
        authority: &Online,
        retained_source: &RetainedWriterStaticInputsV1<'_>,
        guard: &NativeStoreTransactionInventoryGuardV1<'_>,
        clock: &mut dyn MutationClockV1,
    ) -> Result<()> {
        match self {
            Self::Initial(proof) => {
                proof.assert_retained_for_native_store_transaction(current, authority, guard, clock)
            }
            Self::Historical {
                checkpoint,
                history,
            } => history.assert_retained_for_native_store_transaction(
                &SchemaHistoryInputsV1 {
                    checkpoint,
                    current,
                    source,
                    active,
                    finalized,
                },
                authority,
                retained_source,
                guard,
                clock,
            ),
        }
    }

    pub(super) fn value(&self) -> &Value {
        match self {
            Self::Initial(proof) => proof.value(),
            Self::Historical { history, .. } => history.value(),
        }
    }
    pub(super) fn mode(&self) -> &'static str {
        match self {
            Self::Initial(_) => "initial-final",
            Self::Historical { .. } => "historical-checkpoint-replay",
        }
    }
    pub(super) fn assert_current(
        &self,
        current: &ObservedStateDatabaseInventoryV1,
        source: &VerifiedWriterStaticCoverageV1,
        active: &VerifiedActiveAuthorityEvidenceV1,
        finalized: &VerifiedFinalizedInventoryV1,
        authority: &Online,
        clock: &mut dyn MutationClockV1,
    ) -> Result<()> {
        match self {
            Self::Initial(proof) => proof.assert_current(current, authority, clock),
            Self::Historical {
                checkpoint,
                history,
            } => history.assert_current(
                &SchemaHistoryInputsV1 {
                    checkpoint,
                    current,
                    source,
                    active,
                    finalized,
                },
                authority,
                clock,
            ),
        }
    }
}
