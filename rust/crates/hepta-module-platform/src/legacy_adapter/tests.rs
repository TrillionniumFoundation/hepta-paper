#[cfg(test)]
mod tests {
    use std::{collections::BTreeSet, str::FromStr};

    use super::*;
    use crate::{
        ActivationStateV1, AuthorityClassV1, ModuleGrantV1, ModuleRegistryV1, RegistryPolicyV1,
        node_legacy_adapter_manifest_v1,
    };

    fn digest(marker: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", marker.to_string().repeat(64)))
            .expect("test digest")
    }

    fn binding() -> LegacyCapabilityBindingV1 {
        LegacyCapabilityBindingV1 {
            version: 1,
            capability_id: "CAP-CMP-LEGACY".to_owned(),
            decision_group: "legacy-compatibility".to_owned(),
            singleton_reason: "incumbent-node-shadow".to_owned(),
            node_entrypoint: "core/legacy-entrypoint.mjs".to_owned(),
            node_entrypoint_hash: digest('1'),
            node_contract_hash: digest('2'),
            translation_policy_hash: digest('3'),
            parity_class: LegacyParityClassV1::Exact,
            resources: ResourceVectorV1 {
                cpu_millis: 10,
                memory_bytes: 1_024,
                storage_bytes: 2_048,
                provider_calls: 1,
                ..ResourceVectorV1::default()
            },
            utility_micros: 100,
            cost_microusd: 50,
            uncertainty_ppm: 1_000,
            evidence_tier: QualificationTierV1::Source,
        }
    }

    fn planning_request() -> PlanningRequestV1 {
        PlanningRequestV1 {
            envelope: ProtocolEnvelopeV1 {
                version: 1,
                kind: ProtocolObjectKindV1::PlanningRequest,
                request_id: "planning-request-1".to_owned(),
                created_at_unix_ms: 10,
                expires_at_unix_ms: 1_000,
                module_id: NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
                module_version: "1.0.0".to_owned(),
                protocol_version: 1,
                trace_id: "trace-1".to_owned(),
                payload_hash: digest('4'),
            },
            planning_request_id: "planning-1".to_owned(),
            state_snapshot_hash: digest('5'),
            capability_id: "CAP-CMP-LEGACY".to_owned(),
            hard_constraint_set_hash: digest('6'),
            objective_version: "objective-1".to_owned(),
            resource_price_snapshot_hash: digest('7'),
            candidate_limit: 1,
            deadline_unix_ms: 900,
            allowed_side_effect_classes: BTreeSet::from([
                SideEffectClassV1::NoSideEffect,
                SideEffectClassV1::WorkspaceLocal,
                SideEffectClassV1::PreparedResult,
            ]),
            input_artifact_hashes: vec![digest('8')],
        }
    }

    fn command(candidate: &ActionCandidateV1) -> ExecutionCommandV1 {
        ExecutionCommandV1 {
            envelope: ProtocolEnvelopeV1 {
                version: 1,
                kind: ProtocolObjectKindV1::ExecutionCommand,
                request_id: "execution-command-1".to_owned(),
                created_at_unix_ms: 20,
                expires_at_unix_ms: 1_000,
                module_id: NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
                module_version: "1.0.0".to_owned(),
                protocol_version: 1,
                trace_id: "trace-1".to_owned(),
                payload_hash: candidate.candidate_hash().expect("candidate hash"),
            },
            execution_id: "execution-1".to_owned(),
            plan_hash: digest('9'),
            selected_candidate_hash: candidate.candidate_hash().expect("candidate hash"),
            state_snapshot_hash: candidate.snapshot_hash.clone(),
            campaign_id: "campaign-1".to_owned(),
            node_id: "node-1".to_owned(),
            attempt_id: "attempt-1".to_owned(),
            lease_generation: 1,
            writer_generation: 1,
            resource_reservation_id: "reservation-1".to_owned(),
            resource_reservation_hash: digest('a'),
            resource_envelope: candidate.resources,
            deadline_unix_ms: 900,
            cancellation_id: "cancel-1".to_owned(),
            authority_audience: candidate.capability_id.clone(),
            idempotency_key: "idempotency-1".to_owned(),
            input_artifact_hashes: vec![digest('8')],
        }
    }

    fn registry(binding: &LegacyCapabilityBindingV1) -> crate::ModuleRegistryArtifactV1 {
        let manifest = node_legacy_adapter_manifest_v1(
            "1.0.0",
            "0.9.0",
            binding.binding_hash().expect("binding hash"),
            binding.node_contract_hash.clone(),
        );
        let policy = RegistryPolicyV1 {
            version: 1,
            protocol_version: 1,
            central_writer_module_id: "module.commit-sequencer".to_owned(),
            grants: BTreeMap::from([(
                NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
                ModuleGrantV1 {
                    module_version: "1.0.0".to_owned(),
                    authority: AuthorityClassV1::PreparedResultOnly,
                    minimum_qualification: QualificationTierV1::Source,
                    activation: ActivationStateV1::Shadow,
                    capability_ids: BTreeSet::from([
                        "CAP-CMP-LEGACY".to_owned(),
                        "CAP-MOD-CANDIDATES".to_owned(),
                        "CAP-MOD-EXECUTION".to_owned(),
                    ]),
                },
            )]),
        };
        let mut registry = ModuleRegistryV1::new(policy).expect("policy");
        registry.register(manifest).expect("manifest");
        registry.finish().expect("registry")
    }

    fn observation(invocation: &LegacyNodeInvocationV1) -> LegacyNodeObservationV1 {
        LegacyNodeObservationV1 {
            version: 1,
            invocation_hash: invocation.invocation_hash.clone(),
            execution_id: invocation.execution_id.clone(),
            attempt_id: invocation.attempt_id.clone(),
            idempotency_key: invocation.idempotency_key.clone(),
            status: PreparedResultStatusV1::Prepared,
            artifact_hashes: vec![digest('b')],
            actual_resources: ResourceVectorV1 {
                cpu_millis: 8,
                memory_bytes: 900,
                storage_bytes: 1_500,
                provider_calls: 1,
                ..ResourceVectorV1::default()
            },
            actual_cost_microusd: 40,
            output_projection_hash: digest('c'),
            translation_evidence_hash: digest('d'),
            observed_at_unix_ms: 100,
            irreversible_external_action_may_have_started: false,
            central_state_write_observed: false,
        }
    }

    fn reserved_invocation(
        adapter: &mut NodeLegacyAdapterV1,
        candidate: &ActionCandidateV1,
        command: &ExecutionCommandV1,
    ) -> LegacyNodeInvocationV1 {
        match adapter
            .reserve_execution(candidate, command, &command.plan_hash, 20)
            .expect("reserve")
        {
            LegacyReservationOutcomeV1::Reserved(value) => *value,
            other => panic!("unexpected reservation: {other:?}"),
        }
    }

    #[test]
    fn plan_builds_a_registry_valid_candidate() {
        let binding = binding();
        let adapter =
            NodeLegacyAdapterV1::new("1.0.0".to_owned(), vec![binding.clone()]).expect("adapter");
        let request = planning_request();
        let (response, receipt) = adapter.plan(&request, 20).expect("plan");
        response
            .validate(&request, &registry(&binding), 20)
            .expect("response");
        assert_eq!(response.candidates.len(), 1);
        assert_eq!(response.candidates[0].resources.external_actions, 0);
        assert_eq!(response.candidates[0].resources.central_writer_turns, 0);
        assert!(!receipt.grants_authority);
    }

    #[test]
    fn execution_and_exact_replay_are_idempotent() {
        let mut adapter =
            NodeLegacyAdapterV1::new("1.0.0".to_owned(), vec![binding()]).expect("adapter");
        let (response, _) = adapter.plan(&planning_request(), 20).expect("plan");
        let candidate = response.candidates[0].clone();
        let command = command(&candidate);
        let invocation = reserved_invocation(&mut adapter, &candidate, &command);
        assert!(matches!(
            adapter
                .reserve_execution(&candidate, &command, &command.plan_hash, 20)
                .expect("duplicate reserve"),
            LegacyReservationOutcomeV1::ExistingReservation(_)
        ));
        assert!(matches!(
            adapter
                .begin_execution(&command.idempotency_key, &invocation.invocation_hash)
                .expect("begin"),
            LegacyBeginOutcomeV1::Execute(_)
        ));
        let observation = observation(&invocation);
        let first = adapter.complete_execution(&observation).expect("complete");
        let replay = adapter.complete_execution(&observation).expect("replay");
        assert_eq!(first, replay);
        assert!(!first.1.grants_authority);
        assert!(!first.1.central_state_write_observed);
    }

    #[test]
    fn conflicting_replays_fail_closed() {
        let mut adapter =
            NodeLegacyAdapterV1::new("1.0.0".to_owned(), vec![binding()]).expect("adapter");
        let (response, _) = adapter.plan(&planning_request(), 20).expect("plan");
        let candidate = response.candidates[0].clone();
        let command = command(&candidate);
        let invocation = reserved_invocation(&mut adapter, &candidate, &command);
        adapter
            .begin_execution(&command.idempotency_key, &invocation.invocation_hash)
            .expect("begin");
        let observation = observation(&invocation);
        adapter.complete_execution(&observation).expect("complete");
        let mut changed = observation;
        changed.output_projection_hash = digest('e');
        assert_eq!(
            adapter.complete_execution(&changed),
            Err(LegacyAdapterError::ObservationConflict)
        );
        let mut changed_command = command.clone();
        changed_command.resource_reservation_hash = digest('f');
        assert_eq!(
            adapter
                .reserve_execution(&candidate, &changed_command, &changed_command.plan_hash, 20,),
            Err(LegacyAdapterError::IdempotencyConflict)
        );
    }

    #[test]
    fn authority_claims_are_rejected() {
        let mut adapter =
            NodeLegacyAdapterV1::new("1.0.0".to_owned(), vec![binding()]).expect("adapter");
        let (response, _) = adapter.plan(&planning_request(), 20).expect("plan");
        let candidate = response.candidates[0].clone();
        let command = command(&candidate);
        let invocation = reserved_invocation(&mut adapter, &candidate, &command);
        adapter
            .begin_execution(&command.idempotency_key, &invocation.invocation_hash)
            .expect("begin");
        let mut observed = observation(&invocation);
        observed.central_state_write_observed = true;
        assert_eq!(
            adapter.complete_execution(&observed),
            Err(LegacyAdapterError::ObservationInvalid)
        );
        let mut request = planning_request();
        request
            .allowed_side_effect_classes
            .insert(SideEffectClassV1::CentralStateCommit);
        assert_eq!(
            adapter.plan(&request, 20),
            Err(LegacyAdapterError::AuthorityEscalation)
        );
    }

    #[test]
    fn cancellation_never_infers_terminal_success() {
        let mut adapter =
            NodeLegacyAdapterV1::new("1.0.0".to_owned(), vec![binding()]).expect("adapter");
        let (response, _) = adapter.plan(&planning_request(), 20).expect("plan");
        let candidate = response.candidates[0].clone();
        let command = command(&candidate);
        let invocation = reserved_invocation(&mut adapter, &candidate, &command);
        let cancellation = |execution_id: &str, command_hash: Sha256Digest| CancellationRequestV1 {
            envelope: ProtocolEnvelopeV1 {
                version: 1,
                kind: ProtocolObjectKindV1::CancellationRequest,
                request_id: format!("cancel-{execution_id}"),
                created_at_unix_ms: 30,
                expires_at_unix_ms: 1_000,
                module_id: NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
                module_version: "1.0.0".to_owned(),
                protocol_version: 1,
                trace_id: "trace-1".to_owned(),
                payload_hash: command_hash.clone(),
            },
            execution_id: execution_id.to_owned(),
            execution_command_hash: command_hash,
            idempotency_key: format!("cancel-key-{execution_id}"),
        };
        let unknown = cancellation("missing", digest('0'));
        assert_eq!(
            adapter.cancel(&unknown, 30).expect("unknown").disposition,
            CancellationDispositionV1::UnknownRequiresReconciliation
        );
        let reserved = cancellation(
            &command.execution_id,
            command.command_hash().expect("command hash"),
        );
        assert_eq!(
            adapter.cancel(&reserved, 30).expect("reserved").disposition,
            CancellationDispositionV1::CancelledBeforeExecution
        );
        assert!(matches!(
            adapter
                .begin_execution(&command.idempotency_key, &invocation.invocation_hash)
                .expect("cancelled begin"),
            LegacyBeginOutcomeV1::Cancelled
        ));
    }
}
