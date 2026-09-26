//! Restricted-research composition over the existing service/CAS/sequencer.
//!
//! This module consumes the opaque V3 qualification type. It cannot construct,
//! deserialize or promote that value into the full production closure. Research
//! state may be established, but release, submission, cutover and irreversible
//! external effects remain structurally unavailable.

use std::{
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::{ControlPlaneError, ControlPlaneRunReceiptV1, canonical_hash_v1};
use hepta_module_platform::{
    ActivationStateV1, AuthorityClassV1, ModuleKindV1, ModuleRegistryArtifactV1,
    QualificationTierV1,
};
use hepta_qualification_ingest::{
    ExternalQualificationClosureSubjectV1, ExternalQualificationRuntimeFactsV1,
    QualificationClosureError, VerifiedResearchQualificationV3,
};
use serde::Serialize;

use crate::{
    ServiceError, ServiceRunV1, WorkerBindingV1, run_service_with_clock_and_cancellation_v1,
    service_configuration_hash_v1,
};

const FORBIDDEN_RESEARCH_CAPABILITIES: [&str; 3] =
    ["CAP-REL-VERIFY", "CAP-SUBMIT", "CAP-MIG-CUTOVER"];

/// Activation is authoritative only inside the private research-state owner.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchActivationStageV1 {
    /// Bounded research canary.
    Canary,
    /// Current research-state implementation, never a production/release grant.
    Established,
}

impl ResearchActivationStageV1 {
    const fn module_activation(self) -> ActivationStateV1 {
        match self {
            Self::Canary => ActivationStateV1::Canary,
            Self::Established => ActivationStateV1::Authoritative,
        }
    }
}

/// Non-serializable research run. The opaque qualification is supplied separately.
#[derive(Clone, Debug)]
pub struct ResearchServiceRunV1 {
    /// Contract version, exactly one.
    pub version: u16,
    /// Canary or established private research state.
    pub stage: ResearchActivationStageV1,
    /// Exact source subject expected from the independently verified closure.
    pub subject: ExternalQualificationClosureSubjectV1,
    /// Existing durable service plan; its production flag must remain false.
    pub service: ServiceRunV1,
}

/// Canonical receipt for one research-qualified run.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchServiceReceiptV1 {
    pub version: u16,
    pub stage: ResearchActivationStageV1,
    pub repository: String,
    pub commit: String,
    pub tree: String,
    pub qualification_receipt_hash: Sha256Digest,
    pub qualification_trust_store_generation: u64,
    pub qualification_expires_at_unix_ms: u64,
    pub qualified_codex_runtime_identity_hash: Sha256Digest,
    pub service_configuration_hash: Sha256Digest,
    pub control_plane_receipt: ControlPlaneRunReceiptV1,
    pub research_activation: bool,
    pub research_state_authoritative: bool,
    pub automatic_activation: bool,
    pub production_activation: bool,
    pub release_authority: bool,
    pub submission_authority: bool,
    pub receipt_hash: Sha256Digest,
}

trait ResearchQualificationAuthorityV1 {
    fn subject(&self) -> &ExternalQualificationClosureSubjectV1;
    fn receipt_hash(&self) -> &str;
    fn trust_store_generation(&self) -> u64;
    fn expires_at_unix_ms(&self) -> u64;
    fn runtime_facts(&self) -> &ExternalQualificationRuntimeFactsV1;
    fn assert_current(&self, now_unix_ms: u64) -> Result<(), QualificationClosureError>;
}

impl ResearchQualificationAuthorityV1 for VerifiedResearchQualificationV3 {
    fn subject(&self) -> &ExternalQualificationClosureSubjectV1 {
        self.subject()
    }
    fn receipt_hash(&self) -> &str {
        self.receipt_hash()
    }
    fn trust_store_generation(&self) -> u64 {
        self.trust_store_generation()
    }
    fn expires_at_unix_ms(&self) -> u64 {
        self.expires_at_unix_ms()
    }
    fn runtime_facts(&self) -> &ExternalQualificationRuntimeFactsV1 {
        self.runtime_facts()
    }
    fn assert_current(&self, now_unix_ms: u64) -> Result<(), QualificationClosureError> {
        self.assert_current(now_unix_ms)
    }
}

/// Pure structural check. This function grants no writer or provider authority.
pub fn validate_research_service_policy_v1(
    config: &ResearchServiceRunV1,
    qualified_runtime_identity: &Sha256Digest,
) -> Result<(), ServiceError> {
    if config.version != 1
        || config.service.version != 1
        || config.service.production_activation
        || config.service.hard_policy.external_actions_authorized
        || config.service.hard_policy.maximum_central_writer_turns != 0
        || config.service.workers.is_empty()
        || config.service.snapshot.resource_limit.external_actions != 0
        || !valid_subject(&config.subject)
    {
        return Err(ServiceError::Configuration);
    }
    let registry = ModuleRegistryArtifactV1::decode_json(
        config.service.registry_json.as_bytes(),
        &config.service.hard_policy.registry_policy_hash,
    )
    .map_err(|_| ServiceError::Configuration)?;
    for registered in registry.modules().values() {
        let manifest = &registered.manifest;
        if manifest.module_kind == ModuleKindV1::LegacyNodeAdapter
            || manifest.requested_authority > AuthorityClassV1::PreparedResultOnly
            || manifest
                .capability_ids
                .iter()
                .any(|capability| forbidden_capability(capability))
        {
            return Err(ServiceError::Configuration);
        }
    }
    let expected_activation = config.stage.module_activation();
    for (module_id, worker) in &config.service.workers {
        let manifest = &registry
            .module(module_id)
            .map_err(|_| ServiceError::Configuration)?
            .manifest;
        if manifest.requested_activation != expected_activation
            || manifest.qualification != QualificationTierV1::TargetHost
            || manifest.requested_authority > AuthorityClassV1::PreparedResultOnly
        {
            return Err(ServiceError::Configuration);
        }
        match worker {
            WorkerBindingV1::Native => {}
            WorkerBindingV1::BrokerExecute { source }
            | WorkerBindingV1::BrokerPrepared { source } => {
                source.validate()?;
                if &source.runtime_identity_hash != qualified_runtime_identity
                    || source.cost_settlement.is_none()
                {
                    return Err(ServiceError::Configuration);
                }
            }
            _ => return Err(ServiceError::Configuration),
        }
    }
    if config
        .service
        .snapshot
        .required_capability_ids
        .iter()
        .any(|capability| forbidden_capability(capability))
        || config
            .service
            .hard_policy
            .minimum_evidence_by_capability
            .keys()
            .any(|capability| forbidden_capability(capability))
        || config.service.frontier.candidates.iter().any(|candidate| {
            forbidden_capability(&candidate.capability_id)
                || candidate.resources.external_actions != 0
                || candidate.evidence_tier != QualificationTierV1::TargetHost
                || !config.service.workers.contains_key(&candidate.module_id)
        })
    {
        return Err(ServiceError::Configuration);
    }
    Ok(())
}

/// Execute one current restricted-research plan through the existing owners.
pub fn run_research_service_v1(
    config: ResearchServiceRunV1,
    qualification: &VerifiedResearchQualificationV3,
) -> Result<ResearchServiceReceiptV1, ServiceError> {
    run_research_service_with_cancellation_v1(
        config,
        qualification,
        Arc::new(AtomicBool::new(false)),
    )
}

/// Execute with the same sticky cooperative cancellation used by the service.
pub fn run_research_service_with_cancellation_v1(
    config: ResearchServiceRunV1,
    qualification: &VerifiedResearchQualificationV3,
    cancelled: Arc<AtomicBool>,
) -> Result<ResearchServiceReceiptV1, ServiceError> {
    let mut observe = || {
        let duration = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ControlPlaneError::PersistenceInvalid)?;
        u64::try_from(duration.as_millis()).map_err(|_| ControlPlaneError::PersistenceInvalid)
    };
    run_research_service_with_authority_clock_and_cancellation_v1(
        config,
        qualification,
        &mut observe,
        cancelled,
    )
}

fn run_research_service_with_authority_clock_and_cancellation_v1<
    A: ResearchQualificationAuthorityV1,
>(
    config: ResearchServiceRunV1,
    qualification: &A,
    observe: &mut dyn FnMut() -> Result<u64, ControlPlaneError>,
    cancelled: Arc<AtomicBool>,
) -> Result<ResearchServiceReceiptV1, ServiceError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(ServiceError::Execution);
    }
    if config.subject != *qualification.subject() {
        return Err(ServiceError::Configuration);
    }
    let qualification_receipt_hash =
        parse_digest(qualification.receipt_hash()).map_err(|_| ServiceError::Configuration)?;
    let runtime_identity_hash =
        parse_digest(&qualification.runtime_facts().codex_runtime_identity_hash)
            .map_err(|_| ServiceError::Configuration)?;
    validate_research_service_policy_v1(&config, &runtime_identity_hash)?;
    let configuration_hash = service_configuration_hash_v1(&config.service)?;
    let preflight_now = observe().map_err(|_| ServiceError::Persistence)?;
    qualification
        .assert_current(preflight_now)
        .map_err(|_| ServiceError::Configuration)?;
    let stage = config.stage;
    let subject = config.subject.clone();
    let mut first = Some(preflight_now);
    let mut qualified_clock = || {
        let now = match first.take() {
            Some(now) => now,
            None => observe()?,
        };
        qualification
            .assert_current(now)
            .map_err(|_| ControlPlaneError::PersistenceInvalid)?;
        Ok(now)
    };
    let control_plane_receipt = run_service_with_clock_and_cancellation_v1(
        config.service,
        &mut qualified_clock,
        cancelled,
    )?;
    if control_plane_receipt.automatic_activation
        || control_plane_receipt.production_activation
        || control_plane_receipt
            .commit_receipts
            .iter()
            .any(|receipt| receipt.production_activation)
    {
        return Err(ServiceError::Control);
    }
    build_receipt(
        stage,
        subject,
        qualification_receipt_hash,
        qualification.trust_store_generation(),
        qualification.expires_at_unix_ms(),
        runtime_identity_hash,
        configuration_hash,
        control_plane_receipt,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_receipt(
    stage: ResearchActivationStageV1,
    subject: ExternalQualificationClosureSubjectV1,
    qualification_receipt_hash: Sha256Digest,
    qualification_trust_store_generation: u64,
    qualification_expires_at_unix_ms: u64,
    qualified_codex_runtime_identity_hash: Sha256Digest,
    service_configuration_hash: Sha256Digest,
    control_plane_receipt: ControlPlaneRunReceiptV1,
) -> Result<ResearchServiceReceiptV1, ServiceError> {
    let body = ResearchReceiptBodyV1 {
        version: 1,
        stage,
        subject: &subject,
        qualification_receipt_hash: &qualification_receipt_hash,
        qualification_trust_store_generation,
        qualification_expires_at_unix_ms,
        qualified_codex_runtime_identity_hash: &qualified_codex_runtime_identity_hash,
        service_configuration_hash: &service_configuration_hash,
        control_plane_receipt: &control_plane_receipt,
        research_activation: true,
        research_state_authoritative: stage == ResearchActivationStageV1::Established,
        automatic_activation: false,
        production_activation: false,
        release_authority: false,
        submission_authority: false,
    };
    let receipt_hash = canonical_hash_v1(&body).map_err(|_| ServiceError::Configuration)?;
    Ok(ResearchServiceReceiptV1 {
        version: 1,
        stage,
        repository: subject.repository,
        commit: subject.commit,
        tree: subject.tree,
        qualification_receipt_hash,
        qualification_trust_store_generation,
        qualification_expires_at_unix_ms,
        qualified_codex_runtime_identity_hash,
        service_configuration_hash,
        control_plane_receipt,
        research_activation: true,
        research_state_authoritative: stage == ResearchActivationStageV1::Established,
        automatic_activation: false,
        production_activation: false,
        release_authority: false,
        submission_authority: false,
        receipt_hash,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResearchReceiptBodyV1<'a> {
    version: u16,
    stage: ResearchActivationStageV1,
    subject: &'a ExternalQualificationClosureSubjectV1,
    qualification_receipt_hash: &'a Sha256Digest,
    qualification_trust_store_generation: u64,
    qualification_expires_at_unix_ms: u64,
    qualified_codex_runtime_identity_hash: &'a Sha256Digest,
    service_configuration_hash: &'a Sha256Digest,
    control_plane_receipt: &'a ControlPlaneRunReceiptV1,
    research_activation: bool,
    research_state_authoritative: bool,
    automatic_activation: bool,
    production_activation: bool,
    release_authority: bool,
    submission_authority: bool,
}

fn forbidden_capability(capability: &str) -> bool {
    FORBIDDEN_RESEARCH_CAPABILITIES.contains(&capability)
}

fn valid_subject(subject: &ExternalQualificationClosureSubjectV1) -> bool {
    subject.repository == "TrillionniumFoundation/hepta-paper"
        && valid_git_hash(&subject.commit)
        && valid_git_hash(&subject.tree)
}

fn valid_git_hash(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_digest(value: &str) -> Result<Sha256Digest, ()> {
    Sha256Digest::from_str(value).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NativeJobV1, ObjectStoreV1, native_implementation_hash_v1};
    use hepta_campaign_writer::WriterLeaseV1;
    use hepta_control_plane::{
        ControlPlaneSnapshotV1, HardPolicyV1, PlannerPolicyV1, PlanningFrontierV1,
    };
    use hepta_module_platform::{
        ActionCandidateV1, ModuleExecutionV1, ModuleGrantV1, ModuleManifestV1, ModuleRegistryV1,
        RegistryPolicyV1, ResourceVectorV1,
    };
    use std::{
        cell::Cell,
        collections::{BTreeMap, BTreeSet},
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT: AtomicU64 = AtomicU64::new(1);

    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "hepta-research-service-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn digest(marker: u8) -> Sha256Digest {
        format!("sha256:{marker:064x}").parse().unwrap()
    }

    fn subject() -> ExternalQualificationClosureSubjectV1 {
        ExternalQualificationClosureSubjectV1 {
            repository: "TrillionniumFoundation/hepta-paper".into(),
            commit: "a".repeat(40),
            tree: "b".repeat(40),
        }
    }

    struct TestQualification {
        subject: ExternalQualificationClosureSubjectV1,
        facts: ExternalQualificationRuntimeFactsV1,
        receipt_hash: String,
        generation: u64,
        expires_at: u64,
        reject_check: Option<u64>,
        checks: Cell<u64>,
    }

    impl TestQualification {
        fn valid() -> Self {
            Self {
                subject: subject(),
                facts: ExternalQualificationRuntimeFactsV1 {
                    host_identity_hash: digest(1).to_string(),
                    database_identity_hash: digest(2).to_string(),
                    service_identity_hash: digest(3).to_string(),
                    codex_runtime_identity_hash: digest(4).to_string(),
                    writer_transfer_receipt_hash: digest(5).to_string(),
                },
                receipt_hash: digest(6).to_string(),
                generation: 7,
                expires_at: 90_000,
                reject_check: None,
                checks: Cell::new(0),
            }
        }
    }

    impl ResearchQualificationAuthorityV1 for TestQualification {
        fn subject(&self) -> &ExternalQualificationClosureSubjectV1 {
            &self.subject
        }
        fn receipt_hash(&self) -> &str {
            &self.receipt_hash
        }
        fn trust_store_generation(&self) -> u64 {
            self.generation
        }
        fn expires_at_unix_ms(&self) -> u64 {
            self.expires_at
        }
        fn runtime_facts(&self) -> &ExternalQualificationRuntimeFactsV1 {
            &self.facts
        }
        fn assert_current(&self, now_unix_ms: u64) -> Result<(), QualificationClosureError> {
            let check = self.checks.get().checked_add(1).unwrap();
            self.checks.set(check);
            if now_unix_ms >= self.expires_at
                || self.reject_check.is_some_and(|reject| check >= reject)
            {
                return Err(QualificationClosureError::ClosureExpired);
            }
            Ok(())
        }
    }

    fn configuration(temp: &Temp) -> ResearchServiceRunV1 {
        let objects = ObjectStoreV1::open(&temp.0).unwrap();
        let initial = objects.put(b"research service initial state").unwrap();
        let artifact = objects.put(b"research service input artifact").unwrap();
        let payload = objects
            .put(
                &serde_json::to_vec(&NativeJobV1::ArtifactInventory {
                    artifacts: vec![artifact],
                })
                .unwrap(),
            )
            .unwrap();
        let module_id = "module.restricted-research".to_owned();
        let capability = "CAP-BUILD".to_owned();
        let capabilities = BTreeSet::from([capability.clone()]);
        let mut registry = ModuleRegistryV1::new(RegistryPolicyV1 {
            version: 1,
            protocol_version: 1,
            central_writer_module_id: "module.commit-sequencer".into(),
            grants: BTreeMap::from([(
                module_id.clone(),
                ModuleGrantV1 {
                    module_version: "1.0.0".into(),
                    authority: AuthorityClassV1::PreparedResultOnly,
                    minimum_qualification: QualificationTierV1::TargetHost,
                    activation: ActivationStateV1::Canary,
                    capability_ids: capabilities.clone(),
                },
            )]),
        })
        .unwrap();
        registry
            .register(ModuleManifestV1 {
                version: 1,
                module_id: module_id.clone(),
                module_version: "1.0.0".into(),
                protocol_min: 1,
                protocol_max: 1,
                module_kind: ModuleKindV1::TrustedInProcess,
                requested_authority: AuthorityClassV1::PreparedResultOnly,
                qualification: QualificationTierV1::TargetHost,
                requested_activation: ActivationStateV1::Canary,
                capability_ids: capabilities.iter().cloned().collect(),
                dependencies: vec![],
                primary_owner: "TEAM-RESEARCH".into(),
                secondary_owner: "TEAM-RUNTIME".into(),
                independent_reviewer: "TEAM-EVIDENCE".into(),
                rollback_version: "0.9.0".into(),
                execution: ModuleExecutionV1::InProcess {
                    implementation_hash: native_implementation_hash_v1().unwrap(),
                },
            })
            .unwrap();
        let registry = registry.finish().unwrap();
        let hard_policy = HardPolicyV1 {
            version: 1,
            policy_id: "restricted-research-v1".into(),
            registry_policy_hash: registry.policy_hash().clone(),
            forbidden_module_ids: BTreeSet::new(),
            minimum_evidence_by_capability: BTreeMap::from([(
                capability.clone(),
                QualificationTierV1::TargetHost,
            )]),
            external_actions_authorized: false,
            maximum_central_writer_turns: 0,
            maximum_candidates_per_decision_group: 1,
        };
        let capacity = ResourceVectorV1 {
            cpu_millis: 100,
            memory_bytes: 1_048_576,
            storage_bytes: 1_048_576,
            tokens: 100,
            ..ResourceVectorV1::default()
        };
        let snapshot = ControlPlaneSnapshotV1 {
            version: 1,
            campaign_id: "campaign-restricted-research".into(),
            campaign_revision: 1,
            state_hash: initial.clone(),
            registry_hash: registry.registry_hash().clone(),
            registry_policy_hash: registry.policy_hash().clone(),
            objective_version: "restricted-research-v1".into(),
            constraint_set_hash: hard_policy.policy_hash().unwrap(),
            resource_limit: capacity,
            budget_microusd: 100,
            required_capability_ids: capabilities,
            random_seed: None,
        };
        let frontier = PlanningFrontierV1 {
            version: 1,
            snapshot_hash: snapshot.snapshot_hash().unwrap(),
            candidates: vec![ActionCandidateV1 {
                version: 1,
                candidate_id: "research-action-1".into(),
                decision_group: "research-action".into(),
                module_id: module_id.clone(),
                module_version: "1.0.0".into(),
                capability_id: capability,
                snapshot_hash: snapshot.snapshot_hash().unwrap(),
                dependency_candidate_ids: vec![],
                resources: ResourceVectorV1 {
                    cpu_millis: 1,
                    memory_bytes: 4096,
                    ..ResourceVectorV1::default()
                },
                utility_micros: 1,
                cost_microusd: 1,
                uncertainty_ppm: 0,
                evidence_tier: QualificationTierV1::TargetHost,
                payload_hash: payload,
            }],
        };
        ResearchServiceRunV1 {
            version: 1,
            stage: ResearchActivationStageV1::Canary,
            subject: subject(),
            service: ServiceRunV1 {
                version: 1,
                production_activation: false,
                state_directory: temp.0.clone(),
                registry_json: serde_json::to_string(&registry).unwrap(),
                hard_policy,
                planner_policy: PlannerPolicyV1 {
                    version: 1,
                    maximum_exact_candidates: 1,
                    cost_weight_ppm: 0,
                    uncertainty_weight_micros_per_ppm: 0,
                    maximum_selected_candidates: 1,
                },
                frontier,
                snapshot,
                verifier_hash: initial.clone(),
                initial_state_hash: initial,
                writer_lease: WriterLeaseV1 {
                    generation: 1,
                    token: "restricted-research-writer-001".into(),
                    expires_at_unix_ms: 100_000,
                },
                observed_at_unix_ms: 1_000,
                workers: BTreeMap::from([(module_id, WorkerBindingV1::Native)]),
            },
        }
    }

    fn run_with_clock<A: ResearchQualificationAuthorityV1>(
        config: ResearchServiceRunV1,
        qualification: &A,
        observe: &mut dyn FnMut() -> Result<u64, ControlPlaneError>,
    ) -> Result<ResearchServiceReceiptV1, ServiceError> {
        run_research_service_with_authority_clock_and_cancellation_v1(
            config,
            qualification,
            observe,
            Arc::new(AtomicBool::new(false)),
        )
    }

    #[test]
    fn qualified_research_run_commits_and_replays_without_release_authority() {
        let temp = Temp::new();
        let config = configuration(&temp);
        let qualification = TestQualification::valid();
        let mut clock = || Ok(1_000);
        let first = run_with_clock(config.clone(), &qualification, &mut clock).unwrap();
        assert!(first.research_activation);
        assert!(!first.research_state_authoritative);
        assert!(!first.production_activation);
        assert!(!first.release_authority);
        assert!(!first.submission_authority);
        assert!(first.control_plane_receipt.commit_receipts[0].newly_committed);

        let replay = run_with_clock(config, &qualification, &mut clock).unwrap();
        assert!(!replay.control_plane_receipt.commit_receipts[0].newly_committed);
        assert_eq!(
            first.control_plane_receipt.commit_receipts[0].result_hash,
            replay.control_plane_receipt.commit_receipts[0].result_hash
        );
        // The durable result is identical, but a run receipt preserves whether
        // this invocation committed or replayed it instead of erasing that fact.
        assert_ne!(first.receipt_hash, replay.receipt_hash);
        assert!(qualification.checks.get() > 2);
    }

    #[test]
    fn expired_or_foreign_qualification_fails_before_campaign_database() {
        for foreign in [false, true] {
            let temp = Temp::new();
            let mut config = configuration(&temp);
            let mut qualification = TestQualification::valid();
            if foreign {
                qualification.subject.commit = "c".repeat(40);
            } else {
                qualification.expires_at = 1_000;
            }
            let mut clock = || Ok(1_000);
            assert!(run_with_clock(config.clone(), &qualification, &mut clock,).is_err());
            assert!(
                !config
                    .service
                    .state_directory
                    .join("campaign.sqlite")
                    .exists()
            );
            config.subject.repository.push_str("-other");
            assert!(validate_research_service_policy_v1(&config, &digest(4)).is_err());
        }
    }

    #[test]
    fn qualification_currentness_is_rechecked_across_service_boundaries() {
        let temp = Temp::new();
        let config = configuration(&temp);
        let mut expiring = TestQualification::valid();
        expiring.reject_check = Some(3);
        let mut clock = || Ok(1_000);
        assert!(run_with_clock(config.clone(), &expiring, &mut clock,).is_err());
        assert!(expiring.checks.get() >= 3);

        let valid = TestQualification::valid();
        let recovered = run_with_clock(config, &valid, &mut clock).unwrap();
        assert!(recovered.control_plane_receipt.commit_receipts[0].newly_committed);
        assert!(!recovered.production_activation);
        assert!(!recovered.release_authority);
        assert!(!recovered.submission_authority);
    }

    #[test]
    fn pre_cancelled_research_run_creates_no_campaign_database() {
        let temp = Temp::new();
        let config = configuration(&temp);
        let qualification = TestQualification::valid();
        let mut clock = || Ok(1_000);
        assert!(
            run_research_service_with_authority_clock_and_cancellation_v1(
                config.clone(),
                &qualification,
                &mut clock,
                Arc::new(AtomicBool::new(true)),
            )
            .is_err()
        );
        assert!(
            !config
                .service
                .state_directory
                .join("campaign.sqlite")
                .exists()
        );
    }
}
