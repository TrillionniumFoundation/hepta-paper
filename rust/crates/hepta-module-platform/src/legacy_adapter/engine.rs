impl NodeLegacyAdapterV1 {
    /// Builds an adapter from a closed, capability-unique binding set.
    pub fn new(
        module_version: String,
        bindings: Vec<LegacyCapabilityBindingV1>,
    ) -> Result<Self, LegacyAdapterError> {
        if !valid_semver(&module_version)
            || bindings.is_empty()
            || bindings.len() > MAXIMUM_LEGACY_CAPABILITY_BINDINGS_V1
        {
            return Err(LegacyAdapterError::BindingInvalid);
        }
        let mut by_capability = BTreeMap::new();
        for binding in bindings {
            binding.validate()?;
            if by_capability
                .insert(binding.capability_id.clone(), binding)
                .is_some()
            {
                return Err(LegacyAdapterError::DuplicateCapability);
            }
        }
        Ok(Self {
            module_version,
            bindings: by_capability,
            executions: BTreeMap::new(),
            execution_index: BTreeMap::new(),
        })
    }

    /// Produces one deterministic, prepared-result-only legacy candidate.
    pub fn plan(
        &self,
        request: &PlanningRequestV1,
        now_unix_ms: u64,
    ) -> Result<(PlanningResponseV1, LegacyPlanningReceiptV1), LegacyAdapterError> {
        request.validate(now_unix_ms)?;
        self.validate_request_module(request)?;
        if request.allowed_side_effect_classes.iter().any(|class| {
            matches!(
                class,
                SideEffectClassV1::ExternalReversible
                    | SideEffectClassV1::ExternalIrreversible
                    | SideEffectClassV1::CentralStateCommit
            )
        }) || !request
            .allowed_side_effect_classes
            .contains(&SideEffectClassV1::PreparedResult)
        {
            return Err(LegacyAdapterError::AuthorityEscalation);
        }
        let binding = self
            .bindings
            .get(&request.capability_id)
            .ok_or(LegacyAdapterError::CapabilityMissing)?;
        let binding_hash = binding.binding_hash()?;
        let planning_request_hash = request.request_hash()?;
        let candidate =
            candidate_for_request(&self.module_version, request, binding, binding_hash.clone())?;
        let candidate_hash = candidate.candidate_hash()?;
        let response = PlanningResponseV1 {
            envelope: ProtocolEnvelopeV1 {
                version: 1,
                kind: ProtocolObjectKindV1::PlanningResponse,
                request_id: derived_identifier("legacy-plan", &planning_request_hash),
                created_at_unix_ms: now_unix_ms,
                expires_at_unix_ms: request.envelope.expires_at_unix_ms,
                module_id: NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
                module_version: self.module_version.clone(),
                protocol_version: 1,
                trace_id: request.envelope.trace_id.clone(),
                payload_hash: candidate_hash.clone(),
            },
            planning_request_hash: planning_request_hash.clone(),
            candidates: vec![candidate],
            singleton_reason: Some(binding.singleton_reason.clone()),
        };
        let response_hash = response.response_hash()?;
        let body = LegacyPlanningReceiptBodyV1 {
            version: 1,
            planning_request_hash: planning_request_hash.clone(),
            binding_hash: binding_hash.clone(),
            candidate_hash: candidate_hash.clone(),
            response_hash: response_hash.clone(),
            grants_authority: false,
        };
        Ok((
            response,
            LegacyPlanningReceiptV1 {
                version: body.version,
                planning_request_hash,
                binding_hash,
                candidate_hash,
                response_hash,
                grants_authority: false,
                receipt_hash: canonical_hash(&body)?,
            },
        ))
    }

    /// Reserves one exact execution without permitting the Node call yet.
    pub fn reserve_execution(
        &mut self,
        candidate: &ActionCandidateV1,
        command: &ExecutionCommandV1,
        expected_plan_hash: &Sha256Digest,
        now_unix_ms: u64,
    ) -> Result<LegacyReservationOutcomeV1, LegacyAdapterError> {
        command.validate(candidate, expected_plan_hash, now_unix_ms)?;
        self.validate_candidate(candidate)?;
        let binding = self
            .bindings
            .get(&candidate.capability_id)
            .ok_or(LegacyAdapterError::CapabilityMissing)?
            .clone();
        validate_candidate_against_binding(candidate, &self.module_version, &binding)?;
        let command_hash = command.command_hash()?;
        if let Some(existing) = self.executions.get(&command.idempotency_key) {
            if existing.command.command_hash()? != command_hash
                || existing.candidate.candidate_hash()? != candidate.candidate_hash()?
            {
                return Err(LegacyAdapterError::IdempotencyConflict);
            }
            return Ok(reservation_outcome(existing));
        }
        if self.executions.len() >= MAXIMUM_LEGACY_EXECUTIONS_V1 {
            return Err(LegacyAdapterError::ExecutionLimit);
        }
        if self.execution_index.contains_key(&command.execution_id) {
            return Err(LegacyAdapterError::ExecutionConflict);
        }
        let invocation = build_invocation(
            &self.module_version,
            &binding,
            candidate,
            command,
            command_hash,
        )?;
        self.execution_index.insert(
            command.execution_id.clone(),
            command.idempotency_key.clone(),
        );
        self.executions.insert(
            command.idempotency_key.clone(),
            LegacyExecutionRecordV1 {
                binding,
                candidate: candidate.clone(),
                command: command.clone(),
                invocation: invocation.clone(),
                state: LegacyExecutionStateV1::Reserved,
            },
        );
        Ok(LegacyReservationOutcomeV1::Reserved(Box::new(invocation)))
    }

    /// Atomically marks one reserved invocation as handed to Node.
    pub fn begin_execution(
        &mut self,
        idempotency_key: &str,
        expected_invocation_hash: &Sha256Digest,
    ) -> Result<LegacyBeginOutcomeV1, LegacyAdapterError> {
        let record = self
            .executions
            .get_mut(idempotency_key)
            .ok_or(LegacyAdapterError::ExecutionMissing)?;
        if &record.invocation.invocation_hash != expected_invocation_hash {
            return Err(LegacyAdapterError::ExecutionConflict);
        }
        match record.state.clone() {
            LegacyExecutionStateV1::Reserved => {
                record.state = LegacyExecutionStateV1::Running;
                Ok(LegacyBeginOutcomeV1::Execute(Box::new(
                    record.invocation.clone(),
                )))
            }
            LegacyExecutionStateV1::Running => {
                Ok(LegacyBeginOutcomeV1::RunningRequiresReconciliation(
                    Box::new(record.invocation.clone()),
                ))
            }
            LegacyExecutionStateV1::Prepared {
                result, receipt, ..
            } => Ok(LegacyBeginOutcomeV1::Prepared { result, receipt }),
            LegacyExecutionStateV1::Cancelled => Ok(LegacyBeginOutcomeV1::Cancelled),
        }
    }

    /// Translates one bounded Node observation into a common prepared result.
    pub fn complete_execution(
        &mut self,
        observation: &LegacyNodeObservationV1,
    ) -> Result<(PreparedResultV1, LegacyTranslationReceiptV1), LegacyAdapterError> {
        let module_version = self.module_version.clone();
        let record = self
            .executions
            .get_mut(&observation.idempotency_key)
            .ok_or(LegacyAdapterError::ExecutionMissing)?;
        let observation_hash = canonical_hash(observation)?;
        if let LegacyExecutionStateV1::Prepared {
            observation_hash: existing_hash,
            result,
            receipt,
        } = &record.state
        {
            if existing_hash == &observation_hash {
                return Ok(((**result).clone(), (**receipt).clone()));
            }
            return Err(LegacyAdapterError::ObservationConflict);
        }
        if !matches!(record.state, LegacyExecutionStateV1::Running) {
            return Err(LegacyAdapterError::StateTransition);
        }
        validate_observation(record, observation)?;
        let binding_hash = record.binding.binding_hash()?;
        let command_hash = record.command.command_hash()?;
        let candidate_hash = record.candidate.candidate_hash()?;
        let evidence_body = LegacyEvidenceBodyV1 {
            version: 1,
            parity_class: record.binding.parity_class,
            binding_hash: binding_hash.clone(),
            command_hash: command_hash.clone(),
            invocation_hash: record.invocation.invocation_hash.clone(),
            observation_hash: observation_hash.clone(),
            output_projection_hash: observation.output_projection_hash.clone(),
            translation_evidence_hash: observation.translation_evidence_hash.clone(),
            grants_authority: false,
        };
        let evidence_hash = canonical_hash(&evidence_body)?;
        let result = PreparedResultV1 {
            version: 1,
            attempt_id: record.command.attempt_id.clone(),
            snapshot_hash: record.command.state_snapshot_hash.clone(),
            plan_hash: record.command.plan_hash.clone(),
            candidate_hash,
            module_id: NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
            module_version,
            status: observation.status,
            artifact_hashes: observation.artifact_hashes.clone(),
            actual_resources: observation.actual_resources,
            actual_cost_microusd: observation.actual_cost_microusd,
            evidence_hash: evidence_hash.clone(),
            external_action_may_have_started: false,
        };
        result.validate(&record.candidate, &record.command.plan_hash)?;
        let prepared_result_hash = result.result_hash()?;
        let receipt_body = LegacyTranslationReceiptBodyV1 {
            version: 1,
            parity_class: record.binding.parity_class,
            binding_hash: binding_hash.clone(),
            command_hash: command_hash.clone(),
            invocation_hash: record.invocation.invocation_hash.clone(),
            observation_hash: observation_hash.clone(),
            output_projection_hash: observation.output_projection_hash.clone(),
            prepared_result_hash: prepared_result_hash.clone(),
            evidence_hash: evidence_hash.clone(),
            central_state_write_observed: false,
            grants_authority: false,
        };
        let receipt = LegacyTranslationReceiptV1 {
            version: receipt_body.version,
            parity_class: receipt_body.parity_class,
            binding_hash,
            command_hash,
            invocation_hash: record.invocation.invocation_hash.clone(),
            observation_hash: observation_hash.clone(),
            output_projection_hash: observation.output_projection_hash.clone(),
            prepared_result_hash,
            evidence_hash,
            central_state_write_observed: false,
            grants_authority: false,
            receipt_hash: canonical_hash(&receipt_body)?,
        };
        record.state = LegacyExecutionStateV1::Prepared {
            observation_hash,
            result: Box::new(result.clone()),
            receipt: Box::new(receipt.clone()),
        };
        Ok((result, receipt))
    }

    /// Applies conservative cancellation without inferring success from absence.
    pub fn cancel(
        &mut self,
        request: &CancellationRequestV1,
        now_unix_ms: u64,
    ) -> Result<CancellationAcknowledgementV1, LegacyAdapterError> {
        request.validate(now_unix_ms)?;
        if request.envelope.module_id != NODE_LEGACY_ADAPTER_MODULE_ID_V1
            || request.envelope.module_version != self.module_version
        {
            return Err(LegacyAdapterError::BindingInvalid);
        }
        let request_hash = request.request_hash()?;
        let idempotency_key = self.execution_index.get(&request.execution_id).cloned();
        let (disposition, prepared_result) = match idempotency_key {
            None => (
                CancellationDispositionV1::UnknownRequiresReconciliation,
                None,
            ),
            Some(idempotency_key) => {
                let record = self
                    .executions
                    .get_mut(&idempotency_key)
                    .ok_or(LegacyAdapterError::ExecutionMissing)?;
                if record.command.command_hash()? != request.execution_command_hash {
                    return Err(LegacyAdapterError::ExecutionConflict);
                }
                match record.state.clone() {
                    LegacyExecutionStateV1::Reserved => {
                        record.state = LegacyExecutionStateV1::Cancelled;
                        (CancellationDispositionV1::CancelledBeforeExecution, None)
                    }
                    LegacyExecutionStateV1::Running => (
                        CancellationDispositionV1::UnknownRequiresReconciliation,
                        None,
                    ),
                    LegacyExecutionStateV1::Prepared { result, .. } => (
                        CancellationDispositionV1::PreparedResultAlreadyExists,
                        Some(*result),
                    ),
                    LegacyExecutionStateV1::Cancelled => {
                        (CancellationDispositionV1::CancelledBeforeExecution, None)
                    }
                }
            }
        };
        let acknowledgement = CancellationAcknowledgementV1 {
            envelope: ProtocolEnvelopeV1 {
                version: 1,
                kind: ProtocolObjectKindV1::CancellationAcknowledgement,
                request_id: derived_identifier("legacy-cancel", &request_hash),
                created_at_unix_ms: now_unix_ms,
                expires_at_unix_ms: request.envelope.expires_at_unix_ms,
                module_id: NODE_LEGACY_ADAPTER_MODULE_ID_V1.to_owned(),
                module_version: self.module_version.clone(),
                protocol_version: 1,
                trace_id: request.envelope.trace_id.clone(),
                payload_hash: request_hash.clone(),
            },
            cancellation_request_hash: request_hash,
            execution_id: request.execution_id.clone(),
            disposition,
            prepared_result,
        };
        acknowledgement.validate(request, now_unix_ms)?;
        Ok(acknowledgement)
    }

    fn validate_request_module(
        &self,
        request: &PlanningRequestV1,
    ) -> Result<(), LegacyAdapterError> {
        if request.envelope.module_id != NODE_LEGACY_ADAPTER_MODULE_ID_V1
            || request.envelope.module_version != self.module_version
        {
            return Err(LegacyAdapterError::BindingInvalid);
        }
        Ok(())
    }

    fn validate_candidate(&self, candidate: &ActionCandidateV1) -> Result<(), LegacyAdapterError> {
        if candidate.module_id != NODE_LEGACY_ADAPTER_MODULE_ID_V1
            || candidate.module_version != self.module_version
        {
            return Err(LegacyAdapterError::BindingInvalid);
        }
        Ok(())
    }
}
