use super::*;
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-ledger-persistence-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("isolated fixture");
        Self(path)
    }
    fn path(&self) -> PathBuf {
        self.0.join("ledger.jsonl")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn digest() -> Sha256Digest {
    format!("sha256:{}", "a".repeat(64))
        .parse()
        .expect("digest")
}
fn request(id: &str) -> DurableResourcePrepareV1 {
    DurableResourcePrepareV1 {
        reservation_id: id.into(),
        owner_id: "owner".into(),
        domain_id: "domain".into(),
        fence_generation: 1,
        fence_token_hash: digest(),
        policy_hash: digest(),
        plan_hash: digest(),
        action_hash: digest(),
        resources: ResourceVectorV1 {
            cpu_millis: 10,
            ..ResourceVectorV1::default()
        },
        issued_at_unix_ms: 10,
        expires_at_unix_ms: 20,
    }
}
fn assert_stopped(ledger: &mut DurableResourceLeaseLedgerV1) {
    let expected = ControlPlaneError::ResourcePersistenceRequiresInspection;
    assert!(ledger.inspection_required());
    assert_eq!(
        ledger.prepare(request("known")),
        Err(expected),
        "idempotent paths also refuse"
    );
    assert_eq!(ledger.prepare(request("fresh")), Err(expected));
    assert_eq!(ledger.finalize("known", 1, &digest(), 11), Err(expected));
    assert_eq!(ledger.renew("known", 1, &digest(), 11, 30), Err(expected));
    assert_eq!(ledger.mark_uncertain("known", 1, &digest()), Err(expected));
    assert_eq!(
        ledger.reconcile_and_release("known", 1, &digest(), digest()),
        Err(expected)
    );
    assert_eq!(ledger.recover_expired(21), Err(expected));
    assert_eq!(ledger.load("known"), Err(expected));
    assert_eq!(ledger.active_charges(), Err(expected));
    assert_eq!(ledger.validate_integrity(), Err(expected));
}

#[test]
fn corrupt_complete_prefix_is_not_truncated_when_a_torn_tail_follows() {
    let fixture = Fixture::new();
    let path = fixture.path();
    let bytes = b"{\"version\":1,\"corrupt\":true}\n{torn";
    fs::write(&path, bytes).expect("actual corrupt journal");
    assert!(DurableResourceLeaseLedgerV1::open(&path).is_err());
    assert_eq!(fs::read(&path).expect("preserved evidence"), bytes);
    fs::write(&path, b"{first-record-torn").expect("no validated prefix");
    assert!(DurableResourceLeaseLedgerV1::open(&path).is_err());
    assert_eq!(
        fs::read(&path).expect("preserved first record"),
        b"{first-record-torn"
    );
}

#[test]
fn validated_prefix_recovery_removes_only_incomplete_suffix_and_continues_chain() {
    let fixture = Fixture::new();
    let path = fixture.path();
    let mut ledger = DurableResourceLeaseLedgerV1::open(&path).expect("open");
    let known = ledger.prepare(request("known")).expect("durable prepare");
    drop(ledger);
    let prefix = fs::read(&path).expect("complete prefix");
    OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("torn writer")
        .write_all(b"{torn")
        .expect("actual suffix");
    let mut reopened = DurableResourceLeaseLedgerV1::open(&path).expect("validated recovery");
    assert_eq!(fs::read(&path).expect("retained prefix"), prefix);
    assert_eq!(reopened.load("known").expect("usable"), Some(known));
    reopened.prepare(request("second")).expect("next sequence");
    drop(reopened);
    assert_eq!(
        DurableResourceLeaseLedgerV1::open(&path)
            .expect("replay complete chain")
            .active_charges()
            .expect("usable")
            .len(),
        2
    );
}

#[test]
fn actual_partial_or_complete_append_error_stops_owner_until_reopen_and_replay() {
    for complete in [false, true] {
        let fixture = Fixture::new();
        let path = fixture.path();
        let mut ledger = DurableResourceLeaseLedgerV1::open(&path).expect("open");
        ledger.prepare(request("known")).expect("first prepare");
        let prefix = fs::read(&path).expect("prefix");
        let candidate = lease_from_prepare(request("uncertain")).expect("next prepare");
        let result = ledger.append_with_persistence(
            ResourceLedgerActionV1::Prepare,
            candidate,
            |file, encoded| {
                if complete {
                    persist_event(file, encoded)?;
                } else {
                    file.write_all(&encoded[..encoded.len() / 2])?;
                    file.sync_all()?;
                }
                Err(std::io::Error::other(
                    "injected failure after actual persistence",
                ))
            },
        );
        assert_eq!(
            result,
            Err(ControlPlaneError::ResourcePersistenceRequiresInspection)
        );
        let after_failure = fs::read(&path).expect("real changed bytes");
        assert!(after_failure.len() > prefix.len());
        assert_stopped(&mut ledger);
        assert_eq!(
            fs::read(&path).expect("no automatic retry or compensation"),
            after_failure
        );
        assert!(
            DurableResourceLeaseLedgerV1::open(&path).is_err(),
            "failed owner keeps its lock"
        );
        drop(ledger);
        let reopened = DurableResourceLeaseLedgerV1::open(&path).expect("actual disk replay");
        assert!(!reopened.inspection_required());
        assert_eq!(
            reopened.active_charges().expect("usable charges").len(),
            if complete { 2 } else { 1 }
        );
        assert_eq!(
            reopened
                .load("uncertain")
                .expect("known disposition")
                .is_some(),
            complete
        );
        if !complete {
            assert_eq!(fs::read(&path).expect("only valid prefix"), prefix);
        }
    }
}

#[test]
fn real_write_error_stops_owner_and_prewrite_overflow_keeps_it_usable() {
    let fixture = Fixture::new();
    let path = fixture.path();
    let mut ledger = DurableResourceLeaseLedgerV1::open(&path).expect("open");
    ledger.prepare(request("known")).expect("prepare");
    let original = fs::read(&path).expect("original bytes");
    ledger.next_sequence = u64::MAX;
    assert_eq!(
        ledger.prepare(request("overflow")),
        Err(ControlPlaneError::ResourcePersistenceInvalid)
    );
    assert!(!ledger.inspection_required());
    assert_eq!(fs::read(&path).expect("no write"), original);
    ledger.next_sequence = 2;
    // Preserve the locked original handle while exercising a genuine EBADF write.
    let _locked = std::mem::replace(
        &mut ledger.file,
        File::open(&path).expect("actual read-only descriptor"),
    );
    assert_eq!(
        ledger.prepare(request("write-error")),
        Err(ControlPlaneError::ResourcePersistenceRequiresInspection)
    );
    assert_stopped(&mut ledger);
    assert_eq!(fs::read(&path).expect("write refused"), original);
}

#[test]
fn actual_read_budget_and_wrong_file_types_are_refused_without_following_links() {
    let fixture = Fixture::new();
    let path = fixture.path();
    fs::write(&path, b"1234").expect("exact bytes");
    assert_eq!(
        read_ledger_bytes(&mut File::open(&path).expect("reader"), 4).expect("exact budget"),
        b"1234"
    );
    fs::write(&path, b"12345").expect("one detection byte");
    assert_eq!(
        read_ledger_bytes(&mut File::open(&path).expect("reader"), 4),
        Err(ControlPlaneError::ResourcePersistenceInvalid)
    );
    let alias = fixture.0.join("alias");
    std::os::unix::fs::symlink(&path, &alias).expect("actual symlink");
    assert!(DurableResourceLeaseLedgerV1::open(&alias).is_err());
    let fifo = fixture.0.join("fifo");
    nix::unistd::mkfifo(
        &fifo,
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .expect("actual FIFO");
    assert!(
        DurableResourceLeaseLedgerV1::open(&fifo).is_err(),
        "nonblocking open must reject special inode"
    );
    assert!(DurableResourceLeaseLedgerV1::open(&fixture.0).is_err());
    assert_eq!(fs::read(&path).expect("target unchanged"), b"12345");
}

#[test]
fn completed_finalization_with_failed_acknowledgement_replays_as_charged() {
    let fixture = Fixture::new();
    let path = fixture.path();
    let mut ledger = DurableResourceLeaseLedgerV1::open(&path).expect("open");
    let prepared = ledger.prepare(request("known")).expect("durable prepare");
    let finalized = transitioned(
        &prepared,
        DurableResourceLeaseStateV1::Finalized,
        prepared.expires_at_unix_ms,
        None,
    )
    .expect("finalization");
    assert_eq!(
        ledger.append_with_persistence(
            ResourceLedgerActionV1::Finalize,
            finalized,
            |file, encoded| {
                persist_event(file, encoded)?;
                Err(std::io::Error::other(
                    "injected lost acknowledgement after actual sync",
                ))
            }
        ),
        Err(ControlPlaneError::ResourcePersistenceRequiresInspection)
    );
    assert_stopped(&mut ledger);
    drop(ledger);
    let mut reopened = DurableResourceLeaseLedgerV1::open(&path).expect("actual replay");
    assert_eq!(
        reopened.active_charges().expect("charged")[0].state,
        DurableResourceLeaseStateV1::Finalized
    );
    reopened.recover_expired(21).expect("conservative expiry");
    assert_eq!(
        reopened.active_charges().expect("still charged")[0].state,
        DurableResourceLeaseStateV1::Uncertain
    );
    // A concurrent fork can inherit this open file description until exec closes
    // its CLOEXEC descriptor. Keep a duplicate alive to reproduce that window
    // deterministically: dropping the journal owner must release its own lock.
    let inherited_description = reopened.file.try_clone().expect("inherited description");
    assert!(
        DurableResourceLeaseLedgerV1::open(&path).is_err(),
        "the live owner still excludes other owners"
    );
    drop(reopened);
    let replacement = DurableResourceLeaseLedgerV1::open(&path).expect("second replay");
    assert_eq!(
        replacement.active_charges().expect("still charged")[0].state,
        DurableResourceLeaseStateV1::Uncertain
    );
    drop(inherited_description);
    assert!(
        DurableResourceLeaseLedgerV1::open(&path).is_err(),
        "closing a stale description must not release the replacement's lock"
    );
}
