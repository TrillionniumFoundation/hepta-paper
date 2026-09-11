use std::{fs, path::PathBuf};

use hepta_codex_protocol::Sha256Digest;
use hepta_control_plane::{
    DurableResourceLeaseLedgerV1, DurableResourceLeaseStateV1, DurableResourcePrepareV1,
};
use hepta_module_platform::ResourceVectorV1;

fn digest(byte: char) -> Sha256Digest {
    format!("sha256:{}", byte.to_string().repeat(64))
        .parse()
        .expect("digest")
}

fn ledger_path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "hepta-durable-resource-source-{}-{}.jsonl",
        std::process::id(),
        digest('f').as_str().trim_start_matches("sha256:")
    ))
}

#[test]
fn durable_resource_recovery_retains_ambiguous_capacity_until_reconciled() {
    let path = ledger_path();
    let _ = fs::remove_file(&path);
    let token_hash = digest('1');
    let reconciliation_receipt = digest('2');

    {
        let mut ledger = DurableResourceLeaseLedgerV1::open(&path).expect("open ledger");
        let prepared = ledger
            .prepare(DurableResourcePrepareV1 {
                reservation_id: "reservation-source-owner".to_owned(),
                owner_id: "worker-source-owner".to_owned(),
                domain_id: "campaign-source-owner".to_owned(),
                fence_generation: 7,
                fence_token_hash: token_hash.clone(),
                policy_hash: digest('3'),
                plan_hash: digest('4'),
                action_hash: digest('5'),
                resources: ResourceVectorV1 {
                    cpu_millis: 100,
                    memory_bytes: 4096,
                    ..ResourceVectorV1::default()
                },
                issued_at_unix_ms: 10,
                expires_at_unix_ms: 20,
            })
            .expect("prepare");
        assert_eq!(prepared.state, DurableResourceLeaseStateV1::Prepared);
        let finalized = ledger
            .finalize(
                "reservation-source-owner",
                7,
                &token_hash,
                11,
            )
            .expect("finalize");
        assert_eq!(finalized.state, DurableResourceLeaseStateV1::Finalized);
        let recovery = ledger.recover_expired(21).expect("recover expired");
        assert_eq!(
            recovery.finalized_marked_uncertain,
            vec!["reservation-source-owner"]
        );
        let uncertain = ledger
            .load("reservation-source-owner")
            .expect("load")
            .expect("lease");
        assert_eq!(uncertain.state, DurableResourceLeaseStateV1::Uncertain);
        assert_eq!(ledger.active_charges().len(), 1);
        let released = ledger
            .reconcile_and_release(
                "reservation-source-owner",
                7,
                &token_hash,
                reconciliation_receipt.clone(),
            )
            .expect("reconcile release");
        assert_eq!(released.state, DurableResourceLeaseStateV1::Released);
        assert!(ledger.active_charges().is_empty());
        ledger.validate_integrity().expect("integrity");
    }

    {
        let reopened = DurableResourceLeaseLedgerV1::open(&path).expect("reopen ledger");
        let released = reopened
            .load("reservation-source-owner")
            .expect("load reopened")
            .expect("lease");
        assert_eq!(released.state, DurableResourceLeaseStateV1::Released);
        assert_eq!(
            released.reconciliation_receipt_hash,
            Some(reconciliation_receipt)
        );
        assert!(reopened.active_charges().is_empty());
        reopened.validate_integrity().expect("reopened integrity");
    }

    fs::remove_file(path).expect("remove ledger");
}
