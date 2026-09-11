use hepta_orchestration_kernel::{
    CandidateRouterPolicyV1, CandidateV1, CanonicalWorkloadV1, EventCodeV1, ModuleClassV1,
    ObservationInputV1, OutcomeClassV1, PerformanceObservationV1, PerformanceSubjectV1,
    PlanningComponentObservationV1, PlanningSnapshotRequestV1, ResourceLedgerV1, ResourceScopeV1,
    ResourceVectorV1, SeverityV1, TelemetryAggregatorV1, build_planning_snapshot_v1,
    qualify_performance_v1, route_candidate_v1,
};
use std::collections::BTreeMap;

fn digest(marker: char) -> String {
    format!("sha256:{}", marker.to_string().repeat(64))
}

fn snapshot_request(order: &[&str]) -> PlanningSnapshotRequestV1 {
    PlanningSnapshotRequestV1 {
        version: 1,
        campaign_id: "campaign:source-closure".into(),
        expected_revision: 7,
        barrier_id: "barrier:7".into(),
        observed_at_unix_ms: 1_000,
        expires_at_unix_ms: 2_000,
        components: order
            .iter()
            .map(|component_id| PlanningComponentObservationV1 {
                component_id: (*component_id).into(),
                source_revision: 7,
                barrier_id: "barrier:7".into(),
                observed_at_unix_ms: 900,
                payload_hash: digest(component_id.chars().next().unwrap_or('0')),
                payload_bytes: 64,
            })
            .collect(),
    }
}

fn router_policy() -> CandidateRouterPolicyV1 {
    CandidateRouterPolicyV1 {
        version: 1,
        policy_id: "policy:source-closure".into(),
        minimum_evidence_ppm: 800_000,
        maximum_risk_microunits: 100,
        maximum_cost_microusd: 100,
        maximum_latency_ms: 1_000,
        utility_weight: 10,
        evidence_weight: 1,
        risk_weight: 1,
        cost_weight: 1,
        latency_weight: 1,
    }
}

fn candidate(id: &str, utility: i64, risk: u64) -> CandidateV1 {
    CandidateV1 {
        candidate_id: id.into(),
        capability_id: "capability:source-closure".into(),
        expected_utility_microunits: utility,
        evidence_score_ppm: 900_000,
        risk_microunits: risk,
        cost_microusd: 10,
        latency_ms: 10,
        feasible: true,
        disqualifiers: Vec::new(),
    }
}

fn resource(value: u64) -> ResourceVectorV1 {
    ResourceVectorV1 {
        cpu_millis: value,
        memory_mib_millis: value,
        gpu_millis: value,
        storage_byte_millis: value,
        cost_microusd: value,
    }
}

#[test]
fn source_closure_snapshot_router_and_resources_are_deterministic() {
    let left = build_planning_snapshot_v1(snapshot_request(&["alpha", "beta"]))
        .expect("left planning snapshot");
    let right = build_planning_snapshot_v1(snapshot_request(&["beta", "alpha"]))
        .expect("right planning snapshot");
    assert_eq!(left.snapshot_hash, right.snapshot_hash);

    let left_route = route_candidate_v1(
        router_policy(),
        vec![
            candidate("candidate:b", 20, 20),
            candidate("candidate:a", 20, 20),
        ],
    )
    .expect("left route");
    let right_route = route_candidate_v1(
        router_policy(),
        vec![
            candidate("candidate:a", 20, 20),
            candidate("candidate:b", 20, 20),
        ],
    )
    .expect("right route");
    assert_eq!(left_route.route_hash, right_route.route_hash);
    assert_eq!(left_route.selected_candidate_id, "candidate:a");

    let mut ledger = ResourceLedgerV1::new(vec![
        ResourceScopeV1 {
            scope_id: "tenant:one".into(),
            parent_scope_id: None,
            generation: 1,
            limit: resource(100),
        },
        ResourceScopeV1 {
            scope_id: "campaign:one".into(),
            parent_scope_id: Some("tenant:one".into()),
            generation: 1,
            limit: resource(80),
        },
    ])
    .expect("resource ledger");
    ledger
        .prepare(
            "reservation:one".into(),
            "campaign:one".into(),
            1,
            resource(30),
            10,
            20,
        )
        .expect("prepare reservation");
    assert_eq!(ledger.reserved("tenant:one"), Some(resource(30)));
    ledger
        .commit("reservation:one", 15)
        .expect("commit reservation");
    ledger
        .finalize("reservation:one", resource(20))
        .expect("finalize reservation");
    assert_eq!(
        ledger.reserved("tenant:one"),
        Some(ResourceVectorV1::default())
    );
    assert_eq!(ledger.consumed("tenant:one"), Some(resource(20)));
}

#[test]
fn source_closure_telemetry_and_performance_fail_closed_without_external_authority() {
    let mut telemetry = TelemetryAggregatorV1::default();
    telemetry
        .record(ObservationInputV1 {
            event_code: EventCodeV1::CandidateRoute,
            module_class: ModuleClassV1::ControlPlane,
            outcome_class: OutcomeClassV1::Accepted,
            severity: SeverityV1::Info,
            latency_ms: 8,
            observed_at_unix_ms: 100,
            labels: BTreeMap::new(),
        })
        .expect("telemetry record");
    let snapshot = telemetry.snapshot().expect("telemetry snapshot");
    assert_eq!(snapshot.observation_count, 1);
    assert!(snapshot.snapshot_hash.starts_with("sha256:"));

    let subject = PerformanceSubjectV1 {
        repository: "TrillionniumFoundation/hepta-paper".into(),
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        binary_hash: digest('c'),
        configuration_hash: digest('d'),
        host_profile_hash: digest('e'),
    };
    let workload = CanonicalWorkloadV1 {
        workload_id: "workload:source-closure".into(),
        workload_hash: digest('f'),
        operations_per_sample: 100,
        baseline_median_duration_ns: 1_000,
        maximum_regression_ppm: 100_000,
        minimum_throughput_per_second: 50_000_000,
        maximum_p95_duration_ns: 1_500,
    };
    let receipt = qualify_performance_v1(
        subject.clone(),
        vec![workload.clone()],
        vec![PerformanceObservationV1 {
            workload_id: workload.workload_id.clone(),
            sample_durations_ns: vec![900, 950, 980, 1_000, 1_010, 1_020, 1_050],
        }],
    )
    .expect("source performance qualification");
    assert!(receipt.all_workloads_accepted);
    assert!(!receipt.production_authority_granted);
    assert!(qualify_performance_v1(subject, vec![workload], Vec::new()).is_err());
}
