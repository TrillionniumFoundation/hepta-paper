use super::{accounting_v1 as accounting, prepared_v1 as prepared};
use hepta_module_platform::ResourceVectorV1;

fn vector(cpu: u64) -> ResourceVectorV1 {
    ResourceVectorV1 {
        cpu_millis: cpu,
        ..ResourceVectorV1::default()
    }
}

fn prepared_allocator() -> prepared::HierarchicalResourceAllocatorV1 {
    prepared::HierarchicalResourceAllocatorV1::new(
        vec![prepared::ResourceScopeV1 {
            scope_id: "root".into(),
            parent_scope_id: None,
            hard_limit: vector(100),
            guaranteed_share: vector(80),
            burst_allowance: vector(20),
            weight: 1,
            maximum_reservation_horizon_ms: 1000,
        }],
        1,
        1,
        1,
    )
    .expect("legacy allocator")
}

fn request(id: &str) -> prepared::HierarchicalReservationRequestV1 {
    prepared::HierarchicalReservationRequestV1 {
        reservation_id: id.into(),
        attempt_id: format!("attempt:{id}"),
        owner_principal: "worker:owner".into(),
        worker_identity: "worker:1".into(),
        leaf_scope_id: "root".into(),
        plan_hash: format!("sha256:{}", "a".repeat(64)).parse().expect("hash"),
        action_hash: format!("sha256:{}", "b".repeat(64)).parse().expect("hash"),
        resources: vector(10),
        capacity_generation: 1,
        accounting_generation: 1,
        requested_at_unix_ms: 10,
        expires_at_unix_ms: 100,
    }
}

#[test]
fn distinct_legacy_empty_report_domains_match_source_byte_goldens() {
    // Literal struct-ordered JSON bytes from the historical bodies, independently
    // SHA256 hashed. This guards current dependency/hash codec changes too.
    let prepared = prepared_allocator().report().expect("report");
    assert_eq!(
        prepared.report_hash.as_str(),
        "sha256:c1606046de0102466766c780450cf91965436f57d748f7ba0c2d51afef896227"
    );
    let accounting = accounting::HierarchicalResourceAllocatorV1::new(
        vec![accounting::HierarchicalResourceScopeV1 {
            scope_id: "root".into(),
            parent_scope_id: None,
            weight: 1,
            limit: vector(100),
        }],
        1,
    )
    .expect("accounting")
    .report()
    .expect("report");
    assert_eq!(
        accounting.report_hash.as_str(),
        "sha256:a78347160382fae092a9611854b8d6158a747cdd354fb731bb3204c9e0632509"
    );
    assert_ne!(prepared.report_hash, accounting.report_hash);
}

#[test]
fn finalized_work_stays_charged_after_expiry_and_generation_change() {
    let mut owner = prepared_allocator();
    let first = owner.prepare(request("sent"), 10).expect("prepare");
    owner
        .finalize("sent", &first.prepared_hash, 11)
        .expect("finalize");
    owner
        .prepare(request("not-sent"), 11)
        .expect("prepare pending");
    owner.advance_generations(2, 2).expect("fence old work");
    assert_eq!(
        owner
            .reap_stale_prepared(200)
            .expect("reap only unfinalized"),
        ["not-sent"]
    );
    let report = owner.report().expect("retained");
    assert_eq!(report.prepared_count, 0);
    assert_eq!(report.finalized_count, 1);
    assert_eq!(report.scope_reserved["root"].cpu_millis, 10);
    assert_eq!(
        owner.renew("sent", "worker:owner", 1, 200, 300),
        Err(prepared::HierarchicalResourceError::FenceRejected)
    );
    assert_eq!(owner.report().expect("still charged"), report);
}

#[test]
fn prepared_finalization_wrong_hash_does_not_mint_or_release() {
    let mut owner = prepared_allocator();
    let value = owner.prepare(request("one"), 10).expect("prepare");
    let before = owner.report().expect("before");
    let wrong = format!("sha256:{}", "f".repeat(64)).parse().expect("hash");
    assert_eq!(
        owner.finalize("one", &wrong, 10),
        Err(prepared::HierarchicalResourceError::FenceRejected)
    );
    assert_eq!(owner.report().expect("after"), before);
    let lease = owner
        .finalize("one", &value.prepared_hash, 11)
        .expect("exact hash");
    assert_eq!(lease.fence_generation, value.fence_generation);
}
