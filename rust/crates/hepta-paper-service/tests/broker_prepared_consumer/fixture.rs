//! Local protocol peer fixture: not a live model or broker journal qualification.
use base64ct::{Base64UrlUnpadded, Encoding};
use ed25519_dalek::{Signer, SigningKey};
use hepta_campaign_writer::WriterLeaseV1;
use hepta_codex_broker::{
    BrokerPreparedResultReceiptV1, BrokerResponseV1, ProviderCostSettlementV1,
    provider_cost_settlement_signing_bytes, write_response_frame,
};
use hepta_codex_protocol::*;
use hepta_control_plane::*;
use hepta_module_platform::*;
use hepta_paper_service::broker_prepared::*;
use hepta_paper_service::{NativeJobV1, ObjectStoreV1, ServiceRunV1, WorkerBindingV1};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        net::UnixListener,
    },
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    thread,
};
static NEXT: AtomicU64 = AtomicU64::new(1);
pub struct Fixture {
    pub root: PathBuf,
    pub config: ServiceRunV1,
    pub request: CodexExecutionRequestV1,
    pub request_path: PathBuf,
    pub socket_path: PathBuf,
    pub settlement_directory: Option<PathBuf>,
}
pub fn hash(bytes: &[u8]) -> Sha256Digest {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
        .parse()
        .unwrap()
}
pub fn private(path: &Path) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    pub fn new() -> Self {
        Self::with_execution(false, false)
    }
    pub fn new_execution() -> Self {
        Self::with_execution(true, false)
    }
    pub fn new_settled_execution() -> Self {
        Self::with_execution(true, true)
    }
    fn with_execution(execution: bool, settled: bool) -> Self {
        let now = if execution {
            u64::try_from(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis(),
            )
            .unwrap()
        } else {
            1_000
        };
        let root = std::env::temp_dir().join(format!(
            "hbp-consumer-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        private(&root);
        let requests = root.join("requests");
        private(&requests);
        let state = root.join("state");
        private(&state);
        let settlement_directory = settled.then(|| {
            let directory = root.join("cost-settlements");
            private(&directory);
            directory
        });
        let owner = fs::metadata(&root).unwrap();
        let billing_key = SigningKey::from_bytes(&[73; 32]);
        let source = BrokerPreparedSourceV1 {
            socket_path: root.join("broker.sock"),
            broker_uid: owner.uid(),
            broker_gid: owner.gid(),
            request_directory: requests,
            request_owner_uid: owner.uid(),
            request_owner_gid: owner.gid(),
            role: AgentRole::Author,
            runtime_identity_hash: hash(b"test runtime"),
            timeout_ms: 30_000,
            cost_settlement: settlement_directory.as_ref().map(|directory| {
                BrokerCostSettlementSourceV1 {
                    directory: directory.clone(),
                    authority_domain_id: "fixture-billing-domain".into(),
                    authority_uid: owner.uid(),
                    authority_gid: owner.gid(),
                    trust_store_generation: 1,
                    maximum_age_ms: 60_000,
                    keys: vec![BrokerCostSettlementKeyV1 {
                        key_id: "fixture-billing-key".into(),
                        public_key_base64: Base64UrlUnpadded::encode_string(
                            billing_key.verifying_key().as_bytes(),
                        ),
                    }],
                }
            }),
        };
        let input: BrokerPreparedInputV1 = serde_json::from_slice(include_bytes!(
            "../../../../../docs/modules/examples/broker-prepared-input.v1.json"
        ))
        .unwrap();
        let objects = ObjectStoreV1::open(&state).unwrap();
        let initial = objects.put(b"consumer initial").unwrap();
        let payload = objects
            .put(
                &serde_json::to_vec(&if execution {
                    NativeJobV1::BrokerExecute {
                        input: input.clone(),
                    }
                } else {
                    NativeJobV1::BrokerPrepared {
                        input: input.clone(),
                    }
                })
                .unwrap(),
            )
            .unwrap();
        let module = "module.broker-author".to_owned();
        let capabilities = BTreeSet::from(["CAP-AUTHOR".to_owned()]);
        let mut registry = ModuleRegistryV1::new(RegistryPolicyV1 {
            version: 1,
            protocol_version: 1,
            central_writer_module_id: "module.commit-sequencer".into(),
            grants: BTreeMap::from([(
                module.clone(),
                ModuleGrantV1 {
                    module_version: "1.0.0".into(),
                    authority: AuthorityClassV1::PreparedResultOnly,
                    minimum_qualification: QualificationTierV1::Source,
                    activation: ActivationStateV1::Shadow,
                    capability_ids: capabilities.clone(),
                },
            )]),
        })
        .unwrap();
        registry
            .register(ModuleManifestV1 {
                version: 1,
                module_id: module.clone(),
                module_version: "1.0.0".into(),
                protocol_min: 1,
                protocol_max: 1,
                module_kind: ModuleKindV1::TrustedInProcess,
                requested_authority: AuthorityClassV1::PreparedResultOnly,
                qualification: QualificationTierV1::Source,
                requested_activation: ActivationStateV1::Shadow,
                capability_ids: capabilities.iter().cloned().collect(),
                dependencies: vec![],
                primary_owner: "TEAM-RUNTIME".into(),
                secondary_owner: "TEAM-STATE".into(),
                independent_reviewer: "TEAM-EVIDENCE".into(),
                rollback_version: "0.9.0".into(),
                execution: ModuleExecutionV1::InProcess {
                    implementation_hash: if execution {
                        broker_execution_implementation_hash_v1(&source)
                    } else {
                        broker_prepared_implementation_hash_v1(&source)
                    }
                    .unwrap(),
                },
            })
            .unwrap();
        let registry = registry.finish().unwrap();
        let hard_policy = HardPolicyV1 {
            version: 1,
            policy_id: "consumer-fixture".into(),
            registry_policy_hash: registry.policy_hash().clone(),
            forbidden_module_ids: BTreeSet::new(),
            minimum_evidence_by_capability: BTreeMap::new(),
            external_actions_authorized: false,
            maximum_central_writer_turns: 0,
            maximum_candidates_per_decision_group: 1,
        };
        let resources = ResourceVectorV1 {
            cpu_millis: 100,
            memory_bytes: 1_048_576,
            storage_bytes: 1_048_576,
            tokens: 100,
            provider_calls: u64::from(execution),
            ..Default::default()
        };
        let snapshot = ControlPlaneSnapshotV1 {
            version: 1,
            campaign_id: "campaign-consumer".into(),
            campaign_revision: 1,
            state_hash: initial.clone(),
            registry_hash: registry.registry_hash().clone(),
            registry_policy_hash: registry.policy_hash().clone(),
            objective_version: "consumer-v1".into(),
            constraint_set_hash: hard_policy.policy_hash().unwrap(),
            resource_limit: resources,
            budget_microusd: 100,
            required_capability_ids: capabilities,
            random_seed: None,
        };
        let candidate = ActionCandidateV1 {
            version: 1,
            candidate_id: "draft-1".into(),
            decision_group: "draft-1".into(),
            module_id: module.clone(),
            module_version: "1.0.0".into(),
            capability_id: "CAP-AUTHOR".into(),
            snapshot_hash: snapshot.snapshot_hash().unwrap(),
            dependency_candidate_ids: vec![],
            resources,
            utility_micros: 1,
            cost_microusd: 10,
            uncertainty_ppm: 0,
            evidence_tier: QualificationTierV1::Source,
            payload_hash: payload,
        };
        let config = ServiceRunV1 {
            version: 1,
            production_activation: false,
            state_directory: state,
            registry_json: serde_json::to_string(&registry).unwrap(),
            hard_policy,
            planner_policy: PlannerPolicyV1 {
                version: 1,
                maximum_exact_candidates: 1,
                cost_weight_ppm: 0,
                uncertainty_weight_micros_per_ppm: 0,
                maximum_selected_candidates: 1,
            },
            frontier: PlanningFrontierV1 {
                version: 1,
                snapshot_hash: snapshot.snapshot_hash().unwrap(),
                candidates: vec![candidate],
            },
            snapshot,
            verifier_hash: initial.clone(),
            initial_state_hash: initial,
            writer_lease: WriterLeaseV1 {
                generation: 1,
                token: "consumer-fixture-writer-001".into(),
                expires_at_unix_ms: now + 99_000,
            },
            observed_at_unix_ms: now,
            workers: BTreeMap::from([(
                module,
                if execution {
                    WorkerBindingV1::BrokerExecute {
                        source: source.clone(),
                    }
                } else {
                    WorkerBindingV1::BrokerPrepared {
                        source: source.clone(),
                    }
                },
            )]),
        };
        let plan = select_plan_v1(
            &config.snapshot,
            &config.frontier,
            &config.hard_policy,
            &config.planner_policy,
        )
        .unwrap();
        let attempt = format!("{}:attempt:1", plan.plan_hash.as_str());
        let request = CodexExecutionRequestV1 {
            version: 1,
            operation_id: attempt.clone(),
            attempt_id: attempt,
            idempotency_key: plan.plan_hash,
            campaign_id: config.snapshot.campaign_id.clone(),
            node_id: "draft-1".into(),
            lease_generation: 1,
            campaign_revision: 1,
            role: AgentRole::Author,
            task_kind: TaskKind::Draft,
            codex_runtime_identity_hash: source.runtime_identity_hash.clone(),
            model_selector: "local-test-model".into(),
            transport: Transport::ExecJsonlV1,
            session_policy: SessionPolicy::EphemeralNewThread,
            prompt_envelope_hash: input.prompt_envelope_hash,
            input_manifest_hash: hash(&serde_json::to_vec(&input.input_manifest).unwrap()),
            workspace_identity_hash: input.workspace_identity_hash,
            output_schema_hash: input.output_schema_hash,
            mutation_policy_hash: input.mutation_policy_hash,
            sandbox_policy: SandboxPolicy::WorkspaceWrite,
            network_policy: NetworkPolicy::None,
            approval_policy: ApprovalPolicy::Never,
            absolute_deadline_unix_ms: now + 99_000,
            maximum_output_bytes: 4096,
            maximum_event_count: 100,
            maximum_cost_microusd: 10,
            remaining_token_hint: Some(100),
            request_capability: RequestCapabilityV1 {
                nonce: "consumer-fixture-nonce".into(),
                issued_at_unix_ms: now,
                expires_at_unix_ms: now + 98_000,
                signer_key_id: "local-fixture-key".into(),
                peer_uid: owner.uid(),
                peer_gid: owner.gid(),
                signature_base64: "A".repeat(86),
            },
        };
        request.validate().unwrap();
        let request_path = source
            .request_directory
            .join(broker_prepared_request_filename_v1(&request.attempt_id).unwrap());
        let fixture = Self {
            root,
            config,
            request,
            request_path,
            socket_path: source.socket_path,
            settlement_directory,
        };
        fixture.publish(&fixture.request);
        fixture
    }
    pub fn publish(&self, request: &CodexExecutionRequestV1) {
        if self.request_path.exists() {
            fs::set_permissions(&self.request_path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        fs::write(&self.request_path, serde_json::to_vec(request).unwrap()).unwrap();
        fs::set_permissions(&self.request_path, fs::Permissions::from_mode(0o400)).unwrap();
    }
    pub fn cost_settlement_path(&self) -> PathBuf {
        self.settlement_directory
            .as_ref()
            .unwrap()
            .join(broker_cost_settlement_filename_v1(&self.request.attempt_id).unwrap())
    }

    pub fn publish_cost_settlement(&self, output: &[u8], actual_cost_microusd: u64) {
        let receipt = prepared_receipt(&self.request, output);
        let now = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap();
        let key = SigningKey::from_bytes(&[73; 32]);
        let mut settlement = ProviderCostSettlementV1 {
            version: 1,
            operation_id: self.request.operation_id.clone(),
            request_hash: receipt.request_hash.clone(),
            prepared_receipt_hash: receipt.prepared_receipt_hash.clone(),
            campaign_id: self.request.campaign_id.clone(),
            node_id: self.request.node_id.clone(),
            attempt_id: self.request.attempt_id.clone(),
            lease_generation: self.request.lease_generation,
            campaign_revision: self.request.campaign_revision,
            settlement_id: "fixture-settlement-1".into(),
            authority_domain_id: "fixture-billing-domain".into(),
            trust_store_generation: 1,
            token_usage: receipt.token_usage,
            actual_cost_microusd,
            issued_at_unix_ms: now,
            signer_key_id: "fixture-billing-key".into(),
            signature_base64: "AA".into(),
        };
        settlement.signature_base64 = Base64UrlUnpadded::encode_string(
            &key.sign(&provider_cost_settlement_signing_bytes(&settlement).unwrap())
                .to_bytes(),
        );
        let path = self.cost_settlement_path();
        if path.exists() {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        fs::write(&path, serde_json::to_vec(&settlement).unwrap()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o400)).unwrap();
    }

    pub fn listener(&self) -> UnixListener {
        let listener = UnixListener::bind(&self.socket_path).unwrap();
        fs::set_permissions(&self.socket_path, fs::Permissions::from_mode(0o600)).unwrap();
        listener
    }
    // Explicit protocol fixture: this method asserts one execution frame and
    // a separate query frame. It does not impersonate a real provider canary.
    pub fn serve_execution(
        &self,
        listener: UnixListener,
        output: &[u8],
        response_mode: u8,
    ) -> thread::JoinHandle<()> {
        self.serve_execution_sequence(listener, vec![self.request.clone()], output, response_mode)
    }

    pub fn serve_execution_sequence(
        &self,
        listener: UnixListener,
        requests: Vec<CodexExecutionRequestV1>,
        output: &[u8],
        response_mode: u8,
    ) -> thread::JoinHandle<()> {
        let output = output.to_vec();
        thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let accept = || {
                let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
                loop {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            stream
                                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                                .unwrap();
                            return stream;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < until,
                                "expected broker connection"
                            );
                            thread::sleep(std::time::Duration::from_millis(2));
                        }
                        Err(error) => panic!("broker accept: {error}"),
                    }
                }
            };
            for request in requests {
                let mut stream = accept();
                let mut expected = Vec::new();
                hepta_codex_broker::write_request_frame(
                    &mut expected,
                    &request,
                    Default::default(),
                )
                .unwrap();
                let mut actual = vec![0; expected.len()];
                stream.read_exact(&mut actual).unwrap();
                assert_eq!(
                    actual, expected,
                    "first call must send the bound execution request"
                );
                if response_mode == 1 {
                    return;
                } // lost response after possible effect
                let response = prepared_response(&request, &output, false);
                let mut response_cursor = std::io::Cursor::new(&response);
                let (mut initial, _) = hepta_codex_broker::read_response_frame(
                    &mut response_cursor,
                    Default::default(),
                )
                .unwrap();
                if response_mode == 2 {
                    initial.request_hash = Some(hash(b"wrong request"));
                }
                if response_mode == 3 {
                    // Use the parsed journal state from a valid reservation fixture.
                    initial.kind = hepta_codex_broker::BrokerResponseKindV1::Existing;
                    initial.prepared_receipt_hash = None;
                    initial.current_state = Some(serde_json::from_str("\"reserved\"").unwrap());
                }
                write_response_frame(&mut stream, &initial, Default::default()).unwrap();
                drop(stream);
                if response_mode != 0 {
                    return;
                }
                let mut stream = accept();
                let mut expected = Vec::new();
                hepta_codex_broker::write_result_query_frame(
                    &mut expected,
                    &request,
                    Default::default(),
                )
                .unwrap();
                let mut actual = vec![0; expected.len()];
                stream.read_exact(&mut actual).unwrap();
                assert_eq!(
                    actual, expected,
                    "output retrieval must never issue another execution"
                );
                stream.write_all(&response).unwrap();
            }
        })
    }

    pub fn serve(
        &self,
        listener: UnixListener,
        output: &[u8],
        reject: bool,
        corrupt: bool,
    ) -> thread::JoinHandle<()> {
        let expected = serde_json::to_vec(&self.request).unwrap();
        let response = prepared_response(&self.request, output, corrupt);
        thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "expected result query did not arrive"
                        );
                        thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(error) => panic!("result listener: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(30)))
                .unwrap();
            let mut header = [0u8; 16];
            stream.read_exact(&mut header).unwrap();
            assert_eq!(
                &header[..8],
                b"HEPTAQX1",
                "consumer must not send an execution frame"
            );
            let size = u64::from_be_bytes(header[8..].try_into().unwrap());
            assert!(size <= 1024 * 1024);
            let mut received = vec![0u8; size as usize];
            stream.read_exact(&mut received).unwrap();
            assert_eq!(received, expected);
            if reject {
                write_response_frame(&mut stream, &BrokerResponseV1::busy(1), Default::default())
                    .unwrap();
            } else {
                stream.write_all(&response).unwrap();
            }
        })
    }
}
fn prepared_receipt(
    request: &CodexExecutionRequestV1,
    output: &[u8],
) -> BrokerPreparedResultReceiptV1 {
    let h = hash(b"local protocol fixture only");
    let mut receipt = BrokerPreparedResultReceiptV1 {
        version: 1,
        operation_id: request.operation_id.clone(),
        request_hash: hash(&serde_json::to_vec(request).unwrap()),
        campaign_id: request.campaign_id.clone(),
        node_id: request.node_id.clone(),
        attempt_id: request.attempt_id.clone(),
        lease_generation: request.lease_generation,
        campaign_revision: request.campaign_revision,
        role: request.role,
        runtime_identity_hash: request.codex_runtime_identity_hash.clone(),
        output_schema_hash: request.output_schema_hash.clone(),
        workspace_identity_hash: request.workspace_identity_hash.clone(),
        mutation_policy_hash: request.mutation_policy_hash.clone(),
        authority_evidence_hash: h.clone(),
        output_hash: hash(output),
        schema_validation_hash: h.clone(),
        event_stream_hash: h.clone(),
        token_usage: Some(TokenUsage {
            input_tokens: 10,
            output_tokens: 5,
            ..Default::default()
        }),
        workspace_result: serde_json::from_value(
            json!({"version":1,"attemptId":request.attempt_id,
            "workspaceIdentityHash":request.workspace_identity_hash,"beforeInventoryHash":h,
            "afterInventoryHash":h,"mutationManifestHash":h,"preparedResultHash":h}),
        )
        .unwrap(),
        mutation_validation_hash: h.clone(),
        execution_evidence_hash: h.clone(),
        prepared_receipt_hash: h,
    };
    let encoded = serde_json::to_string(&receipt).unwrap();
    let body = format!(
        "{}{}",
        encoded.split(",\"preparedReceiptHash\":").next().unwrap(),
        "}"
    );
    let raw: Box<serde_json::value::RawValue> = serde_json::from_str(&body).unwrap();
    receipt.prepared_receipt_hash =
        hash(&serde_json::to_vec(&("HeptaBrokerPreparedResultV1", raw)).unwrap());
    receipt.verify_hash().unwrap();
    receipt
}

fn prepared_response(request: &CodexExecutionRequestV1, output: &[u8], corrupt: bool) -> Vec<u8> {
    let receipt = prepared_receipt(request, output);
    let receipt_bytes = serde_json::to_vec(&receipt).unwrap();
    let mut response = Vec::new();
    write_response_frame(
        &mut response,
        &BrokerResponseV1::prepared(
            request.operation_id.clone(),
            receipt.request_hash.clone(),
            receipt.prepared_receipt_hash,
        ),
        Default::default(),
    )
    .unwrap();
    response.extend_from_slice(b"HEPTAPX1");
    response.extend_from_slice(&(receipt_bytes.len() as u64).to_be_bytes());
    response.extend_from_slice(&(output.len() as u64).to_be_bytes());
    response.extend_from_slice(&receipt_bytes);
    response.extend_from_slice(output);
    if corrupt {
        *response.last_mut().unwrap() ^= 1;
    }
    response
}
