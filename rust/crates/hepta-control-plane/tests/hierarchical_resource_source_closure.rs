use hepta_control_plane::{
    ControlPlaneError, HierarchicalAdmissionRequestV1, HierarchicalResourceAllocatorV1,
    HierarchicalResourceScopeV1,
};
use hepta_module_platform::ResourceVectorV1;

fn resource(cpu: u64) -> ResourceVectorV1 {
    ResourceVectorV1 {
        cpu_millis: cpu,
        memory_bytes: cpu.saturating_mul(100),
        ..ResourceVectorV1::default()
    }
}

fn scopes() -> Vec<HierarchicalResourceScopeV1> {
    vec![
        HierarchicalResourceScopeV1 {
            scope_id: "host".into(),
            parent_scope_id: None,
            weight: 1,
            limit: resource(100),
        },
        HierarchicalResourceScopeV1 {
            scope_id: "service:research".into(),
            parent_scope_id: Some("host".into()),
            weight: 1,
            limit: resource(90),
        },
        HierarchicalResourceScopeV1 {
            scope_id: "team:a".into(),
            parent_scope_id: Some("service:research".into()),
            weight: 1,
            limit: resource(80),
        },
        HierarchicalResourceScopeV1 {
            scope_id: "team:b".into(),
            parent_scope_id: Some("service:research".into()),
            weight: 2,
            limit: resource(80),
        },
        HierarchicalResourceScopeV1 {
            scope_id: "campaign:a".into(),
            parent_scope_id: Some("team:a".into()),
            weight: 1,
            limit: resource(70),
        },
        HierarchicalResourceScopeV1 {
            scope_id: "campaign:b".into(),
            parent_scope_id: Some("team:b".into()),
            weight: 1,
            limit: resource(70),
        },
    ]
}

fn request(id: &str, scope: &str, cpu: u64, queued: u64) -> HierarchicalAdmissionRequestV1 {
    HierarchicalAdmissionRequestV1 {
        reservation_id: id.into(),
        scope_id: scope.into(),
        module_id: "module.fixture".into(),
        candidate_id: format!("candidate:{id}"),
        resources: resource(cpu),
        queued_at_unix_ms: queued,
        deadline_unix_ms: None,
    }
}

#[test]
fn hierarchical_source_closure_enforces_parent_fairness_reconciliation_and_clock_fencing() {
    let mut allocator = HierarchicalResourceAllocatorV1::new(scopes(), 1_000).expect("allocator");
    let first = allocator
        .reserve(request("a", "campaign:a", 60, 0), 0)
        .expect("first reservation");
    assert_eq!(
        allocator.reserve(request("b-too-large", "campaign:b", 40, 0), 0),
        Err(ControlPlaneError::ResourceDenied)
    );

    let reconciled = allocator
        .reconcile(&first.reservation_id, resource(20))
        .expect("reconcile");
    assert_eq!(reconciled.reserved.cpu_millis, 20);
    let report = allocator.report().expect("report");
    for scope in ["host", "service:research", "team:a", "campaign:a"] {
        assert_eq!(report.reserved_by_scope[scope].cpu_millis, 20);
    }

    let fresh = request("fresh", "campaign:a", 1, 10_000);
    let old = request("old", "campaign:b", 1, 0);
    let left = allocator
        .rank_requests(&[fresh.clone(), old.clone()], 10_000)
        .expect("left ranking");
    let right = allocator
        .rank_requests(&[old.clone(), fresh], 10_000)
        .expect("right ranking");
    assert_eq!(left, right);
    assert_eq!(left.first(), Some(&old));
    assert_eq!(
        allocator.rank_requests(&[old], 9_999),
        Err(ControlPlaneError::ResourceClockRollback)
    );

    allocator.release(&first.reservation_id).expect("release");
    assert!(allocator.report().expect("released report").reserved_by_scope.is_empty());
}
