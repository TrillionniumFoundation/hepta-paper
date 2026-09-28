//! Owned post-file-boundary fixtures. The synthetic consumer UID is not an
//! installed independent principal or a bypass of the public effective-UID gate.
use super::*;
use crate::qualification_closure::{MAXIMUM_TRUST_STORE_BYTES, read_observed_authority_file};
use rusqlite::{Connection, OpenFlags};
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    process::Command,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Fixture {
    root: PathBuf,
    path: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        // Production authority ancestors reject /tmp's world-writable boundary.
        // Keep owned test data in the actual home, never loosen that policy.
        let home = fs::canonicalize(std::env::var_os("HOME").expect("test home")).unwrap();
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = home.join(format!(
            ".hepta-trust-source-test-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("trust.json");
        fs::write(&path, b"owned trust source fixture").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o440)).unwrap();
        Self { root, path }
    }
    fn source(&self) -> RetainedResearchTrustSourceV3 {
        let authority = fs::metadata(&self.path).unwrap().uid();
        let consumer = authority.wrapping_add(1);
        let observed = read_observed_authority_file(
            &self.path,
            authority,
            consumer,
            MAXIMUM_TRUST_STORE_BYTES,
            None,
        )
        .unwrap();
        RetainedResearchTrustSourceV3::retain(&self.path, consumer, observed, 500, 5_000, 1_000)
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn retained_trust_reads_original_descriptors_and_returns_post_io_time() {
    let f = Fixture::new();
    let source = f.source();
    let before = fs::metadata(&f.path).unwrap();
    let bytes = fs::read(&f.path).unwrap();
    assert_eq!(source.observe_current(1_000, || Ok(1_500)).unwrap(), 1_500);
    assert_eq!(source.observe_current(1_500, || Ok(1_501)).unwrap(), 1_501);
    assert!(same_file(&before, &fs::metadata(&f.path).unwrap()));
    assert_eq!(bytes, fs::read(&f.path).unwrap());
}

#[test]
fn replaced_removed_aliased_or_changed_trust_invalidates_every_request_clone() {
    for case in 0..6 {
        let f = Fixture::new();
        let source = Arc::new(f.source());
        let other = Arc::clone(&source);
        let original = f.root.join("original.json");
        match case {
            0 => {
                fs::set_permissions(&f.path, fs::Permissions::from_mode(0o600)).unwrap();
                fs::write(&f.path, b"revoked authority contents").unwrap();
                fs::set_permissions(&f.path, fs::Permissions::from_mode(0o440)).unwrap();
            }
            1 => {
                fs::remove_file(&f.path).unwrap();
            }
            2 => {
                fs::rename(&f.path, &original).unwrap();
                symlink(&original, &f.path).unwrap();
            }
            3 => {
                fs::rename(&f.path, &original).unwrap();
                fs::copy(&original, &f.path).unwrap();
            }
            4 => {
                fs::hard_link(&f.path, &original).unwrap();
            }
            _ => {
                fs::set_permissions(&f.path, fs::Permissions::from_mode(0o400)).unwrap();
            }
        }
        assert!(
            source.observe_current(1_000, || Ok(1_100)).is_err(),
            "case {case}"
        );
        assert!(matches!(
            other.observe_current(1_000, || Ok(1_200)),
            Err(ClosureError::ResearchAuthorityNotCurrent)
        ));
    }
}

#[test]
fn parent_rebinding_and_clock_recovery_cannot_reactivate_a_retained_request() {
    let f = Fixture::new();
    let source = f.source();
    let moved = f.root.with_extension("moved");
    fs::rename(&f.root, &moved).unwrap();
    fs::create_dir(&f.root).unwrap();
    fs::rename(moved.join("trust.json"), &f.path).unwrap();
    assert!(source.observe_current(1_000, || Ok(1_100)).is_err());
    fs::rename(&f.path, moved.join("trust.json")).unwrap();
    fs::remove_dir(&f.root).unwrap();
    fs::rename(&moved, &f.root).unwrap();
    assert!(matches!(
        source.observe_current(1_000, || Ok(1_200)),
        Err(ClosureError::ResearchAuthorityNotCurrent)
    ));

    for failure in 0..4 {
        let f = Fixture::new();
        let source = f.source();
        assert_eq!(source.observe_current(1_000, || Ok(2_000)).unwrap(), 2_000);
        let result = source.observe_current(1_000, || match failure {
            0 => Ok(1_999),
            1 => Ok(5_000),
            2 => Err(ClosureError::ClockInvalid),
            _ => Err(crate::QualificationClosureError::ClosureExpired.into()),
        });
        assert!(result.is_err());
        assert!(matches!(
            source.observe_current(2_000, || Ok(2_100)),
            Err(ClosureError::ResearchAuthorityNotCurrent)
        ));
    }
}

#[test]
fn sqlite_lock_probe_child() {
    let Some(path) = std::env::var_os("HEPTA_TRUST_SOURCE_LOCK_PROBE") else {
        return;
    };
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .unwrap();
    db.busy_timeout(Duration::ZERO).unwrap();
    let error = db
        .execute_batch("BEGIN IMMEDIATE")
        .expect_err("retained writer lock must remain held");
    assert_eq!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy)
    );
}

#[test]
fn rebound_trust_name_never_opens_or_releases_live_sqlite_writer_locks() {
    for mode in ["DELETE", "WAL"] {
        let f = Fixture::new();
        let source = f.source();
        let path = f.root.join("campaign.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(&format!("PRAGMA journal_mode={mode}; CREATE TABLE example (value INTEGER); BEGIN IMMEDIATE; INSERT INTO example VALUES (1);")).unwrap();
        fs::rename(&f.path, f.root.join("original.json")).unwrap();
        fs::hard_link(&path, &f.path).unwrap();
        assert!(source.observe_current(1_000, || Ok(1_100)).is_err());
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "qualification_closure::trust_source::tests::sqlite_lock_probe_child",
                "--nocapture",
            ])
            .env("HEPTA_TRUST_SOURCE_LOCK_PROBE", &path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{mode}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!db.is_autocommit());
        assert_eq!(
            db.query_row("SELECT count(*) FROM example", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        db.execute_batch("ROLLBACK").unwrap();
    }
}

#[cfg(target_os = "linux")]
#[test]
fn authority_ancestor_needs_search_permission_not_directory_read_permission() {
    let f = Fixture::new();
    let authority = fs::metadata(&f.path).unwrap().uid();
    let consumer = authority.wrapping_add(1);
    // Trusted ancestors need traversal, not enumeration. A readable authority
    // document remains valid in a search-only directory.
    fs::set_permissions(&f.root, fs::Permissions::from_mode(0o111)).unwrap();
    let result = read_observed_authority_file(
        &f.path,
        authority,
        consumer,
        MAXIMUM_TRUST_STORE_BYTES,
        None,
    )
    .and_then(|observed| {
        RetainedResearchTrustSourceV3::retain(&f.path, consumer, observed, 500, 5_000, 1_000)
    })
    .and_then(|source| source.observe_current(1_000, || Ok(1_100)));
    fs::set_permissions(&f.root, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(result.unwrap(), 1_100);
}
