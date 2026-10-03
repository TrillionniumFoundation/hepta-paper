use std::{
    ffi::OsString,
    io::{Seek, Write},
    os::unix::{
        ffi::OsStringExt,
        fs::{MetadataExt, PermissionsExt, symlink},
        net::{UnixListener, UnixStream},
    },
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

use super::*;

static NEXT_TEST: AtomicU64 = AtomicU64::new(0);

struct TempTree {
    root: PathBuf,
    attempts: PathBuf,
    uid: u32,
}

impl TempTree {
    fn new() -> Self {
        let sequence = NEXT_TEST.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "hepta-workspace-test-{}-{sequence}",
            std::process::id()
        ));
        let source = root.join("source");
        let attempts = root.join("attempts");
        fs::create_dir_all(source.join("src")).expect("source");
        fs::create_dir(&attempts).expect("attempts");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).expect("root mode");
        fs::set_permissions(&source, fs::Permissions::from_mode(0o700)).expect("source mode");
        fs::set_permissions(&attempts, fs::Permissions::from_mode(0o700)).expect("attempt mode");
        fs::write(source.join("paper.tex"), b"draft").expect("paper");
        fs::write(source.join("src/model.rs"), b"fn model() {}\n").expect("model");
        let uid = fs::metadata(&source).expect("metadata").uid();
        Self {
            root,
            attempts,
            uid,
        }
    }

    fn source(&self) -> PathBuf {
        self.root.join("source")
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct LockChild {
    child: Child,
    gate: Option<UnixStream>,
}

impl LockChild {
    fn start(tree: &TempTree, mode: &str) -> Self {
        let socket = tree.root.join("lock-child.sock");
        let listener = UnixListener::bind(&socket).expect("child control listener");
        listener.set_nonblocking(true).expect("nonblocking accept");
        let child = Command::new("/proc/self/exe")
            .args([
                "--exact",
                "tests::attempt_lock_child",
                "--ignored",
                "--nocapture",
            ])
            .env("HEPTA_WORKSPACE_LOCK_CHILD_ROOT", &tree.root)
            .env("HEPTA_WORKSPACE_LOCK_CHILD_MODE", mode)
            .stdout(Stdio::null())
            .spawn()
            .expect("independent Rust test process");
        let mut owner = Self { child, gate: None };
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match listener.accept() {
                Ok((mut gate, _)) => {
                    gate.set_read_timeout(Some(Duration::from_secs(5)))
                        .expect("ready timeout");
                    let mut ready = [0];
                    gate.read_exact(&mut ready)
                        .expect("child holds real operation lock");
                    assert_eq!(ready, [1]);
                    owner.gate = Some(gate);
                    return owner;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => panic!("control accept: {error}"),
            }
            assert!(owner.child.try_wait().expect("child status").is_none());
            assert!(Instant::now() < deadline, "bounded child startup");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn kill_and_wait(&mut self) {
        self.child
            .kill()
            .expect("terminate independent lock holder");
        self.child.wait().expect("reap lock holder");
        self.gate.take();
    }

    fn release_and_wait(&mut self) {
        self.gate
            .as_mut()
            .expect("held gate")
            .write_all(&[1])
            .expect("release child");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.try_wait().expect("child status") {
                assert!(
                    status.success(),
                    "real child operation must finish successfully"
                );
                self.gate.take();
                return;
            }
            assert!(Instant::now() < deadline, "bounded child completion");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for LockChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "child fixture invoked explicitly by independent-process locking tests"]
fn attempt_lock_child() {
    let root =
        PathBuf::from(std::env::var_os("HEPTA_WORKSPACE_LOCK_CHILD_ROOT").expect("child root"));
    let mode = std::env::var("HEPTA_WORKSPACE_LOCK_CHILD_MODE").expect("child mode");
    let parent = root.join("attempts");
    let uid = fs::metadata(&parent).expect("parent metadata").uid();
    let wait_at_gate = || {
        let mut gate = UnixStream::connect(root.join("lock-child.sock")).expect("control");
        gate.set_read_timeout(Some(Duration::from_secs(15)))
            .expect("gate timeout");
        gate.write_all(&[1]).expect("ready");
        let mut release = [0];
        gate.read_exact(&mut release).expect("release");
        Ok(())
    };
    match mode.as_str() {
        "materialize" => {
            let source = WorkspaceRootV1::open(root.join("source"), uid).expect("source");
            materialize_attempt_with_checks(
                &source,
                &parent,
                "child",
                uid,
                WorkspaceLimits::PRODUCTION,
                |phase, _| {
                    if matches!(phase, MaterializationPhase::StagingCreated) {
                        wait_at_gate()?;
                    }
                    Ok(())
                },
            )
            .expect("child materialization");
        }
        "recover" => {
            recover_incomplete_attempts_with_check(&parent, uid, |_| wait_at_gate())
                .expect("child recovery");
        }
        _ => panic!("unknown child mode"),
    }
}

fn published_sentinel(parent: &Path) -> PathBuf {
    let sentinel = parent.join("attempt-published-sentinel");
    fs::create_dir(&sentinel).expect("published sentinel");
    fs::write(sentinel.join("proof"), b"published evidence").expect("sentinel bytes");
    sentinel
}

fn rebind_attempt_parent(tree: &TempTree) -> PathBuf {
    let displaced = tree.root.join("displaced-attempts");
    fs::rename(&tree.attempts, &displaced).expect("rebind actual parent pathname");
    fs::create_dir(&tree.attempts).expect("replacement parent");
    fs::set_permissions(&tree.attempts, fs::Permissions::from_mode(0o700))
        .expect("replacement mode");
    displaced
}

#[test]
fn shared_materializers_block_recovery_and_process_death_releases_the_lock() {
    for kill in [false, true] {
        let tree = TempTree::new();
        let sentinel = published_sentinel(&tree.attempts);
        let mut child = LockChild::start(&tree, "materialize");
        let source = WorkspaceRootV1::open(tree.source(), tree.uid).expect("source");
        let sibling = materialize_attempt(&source, &tree.attempts, "sibling", tree.uid)
            .expect("another actual producer may hold a shared lock");
        let started = Instant::now();
        assert_eq!(
            recover_incomplete_attempts(&tree.attempts, tree.uid),
            Err(WorkspaceError::AttemptParentBusy)
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "recovery must not wait"
        );
        assert_eq!(fs::read_dir(&tree.attempts).expect("parent").count(), 3);
        if kill {
            child.kill_and_wait();
        } else {
            // Its initial parent observation predates sibling creation.
            // Resumed validation must tolerate the changed link count.
            child.release_and_wait();
            assert_eq!(
                fs::read(tree.attempts.join("attempt-child/paper.tex"))
                    .expect("resumed child publication"),
                b"draft"
            );
        }
        assert_eq!(
            recover_incomplete_attempts(&tree.attempts, tree.uid),
            Ok(u64::from(kill))
        );
        assert_eq!(
            fs::read(sentinel.join("proof")).expect("published retained"),
            b"published evidence"
        );
        assert_eq!(
            fs::read(sibling.canonical_path.join("paper.tex")).expect("sibling retained"),
            b"draft"
        );
    }
}

#[test]
fn exclusive_recovery_blocks_independent_materialization_until_process_death() {
    let tree = TempTree::new();
    let staging = tree.attempts.join(".attempt-abandoned-1-1.creating");
    fs::create_dir(&staging).expect("abandoned staging");
    fs::write(staging.join("partial"), b"partial evidence").expect("staging bytes");
    let sentinel = published_sentinel(&tree.attempts);
    let mut child = LockChild::start(&tree, "recover");
    let source = WorkspaceRootV1::open(tree.source(), tree.uid).expect("source");
    let started = Instant::now();
    assert_eq!(
        materialize_attempt(&source, &tree.attempts, "blocked", tree.uid)
            .expect_err("exclusive recovery blocks a producer"),
        WorkspaceError::AttemptParentBusy
    );
    assert_eq!(
        recover_incomplete_attempts(&tree.attempts, tree.uid),
        Err(WorkspaceError::AttemptParentBusy)
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "lock acquisition must not wait"
    );
    assert_eq!(fs::read_dir(&tree.attempts).expect("parent").count(), 2);
    assert_eq!(
        fs::read(staging.join("partial")).expect("busy preserves staging"),
        b"partial evidence"
    );
    child.kill_and_wait();
    assert_eq!(recover_incomplete_attempts(&tree.attempts, tree.uid), Ok(1));
    materialize_attempt(&source, &tree.attempts, "after-recovery", tree.uid)
        .expect("dead recovery releases its exclusive lock");
    assert_eq!(
        fs::read(sentinel.join("proof")).expect("published retained"),
        b"published evidence"
    );
}

#[test]
fn recovery_after_parent_rebind_deletes_only_from_the_retained_directory() {
    let tree = TempTree::new();
    let name = ".attempt-abandoned-1-1.creating";
    fs::create_dir(tree.attempts.join(name)).expect("original staging");
    published_sentinel(&tree.attempts);
    let mut displaced = None;
    let failure = recover_incomplete_attempts_with_check(&tree.attempts, tree.uid, |_| {
        let old = rebind_attempt_parent(&tree);
        fs::create_dir(tree.attempts.join(name)).expect("replacement staging");
        fs::write(
            tree.attempts.join(name).join("proof"),
            b"replacement evidence",
        )
        .expect("replacement sentinel");
        published_sentinel(&tree.attempts);
        displaced = Some(old);
        Ok(())
    })
    .expect_err("report the observed parent rebind");
    assert_eq!(failure, WorkspaceError::AttemptParentChanged);
    let old = displaced.expect("real namespace change");
    assert!(
        !old.join(name).exists(),
        "only original anchored staging was removed"
    );
    assert_eq!(
        fs::read(tree.attempts.join(name).join("proof")).expect("replacement untouched"),
        b"replacement evidence"
    );
    for parent in [&old, &tree.attempts] {
        assert_eq!(
            fs::read(parent.join("attempt-published-sentinel/proof"))
                .expect("published evidence untouched"),
            b"published evidence"
        );
    }
}

#[test]
fn parent_rebind_before_publication_cleans_only_the_original_staging() {
    let tree = TempTree::new();
    let source = WorkspaceRootV1::open(tree.source(), tree.uid).expect("source");
    let mut displaced = None;
    let mut staged_name = None;
    let failure = materialize_attempt_with_checks(
        &source,
        &tree.attempts,
        "rebind-before",
        tree.uid,
        WorkspaceLimits::PRODUCTION,
        |phase, staging| {
            if matches!(phase, MaterializationPhase::BeforePublication) {
                displaced = Some(rebind_attempt_parent(&tree));
                let name = staging.file_name().expect("staging leaf").to_owned();
                fs::create_dir(tree.attempts.join(&name)).expect("replacement staging");
                fs::write(tree.attempts.join(&name).join("proof"), b"replacement")
                    .expect("replacement bytes");
                staged_name = Some(name);
            }
            Ok(())
        },
    )
    .expect_err("rebind must prevent publication");
    assert_eq!(failure, WorkspaceError::AttemptParentChanged);
    let old = displaced.expect("old parent");
    let name = staged_name.expect("actual staging name");
    assert!(!old.join(&name).exists(), "own anchored staging cleaned");
    assert!(!old.join("attempt-rebind-before").exists());
    assert!(!tree.attempts.join("attempt-rebind-before").exists());
    assert_eq!(
        fs::read(tree.attempts.join(name).join("proof")).expect("replacement not cleaned"),
        b"replacement"
    );
}

#[test]
fn parent_rebind_after_publication_is_classified_without_redirecting_final_io() {
    let tree = TempTree::new();
    let source = WorkspaceRootV1::open(tree.source(), tree.uid).expect("source");
    let final_path = tree.attempts.join("attempt-rebind-after");
    let mut displaced = None;
    let failure = materialize_attempt_with_publication_check(
        &source,
        &tree.attempts,
        "rebind-after",
        tree.uid,
        WorkspaceLimits::PRODUCTION,
        |phase, _| {
            if phase == AttemptPublicationPhaseV1::ParentDirectorySync {
                displaced = Some(rebind_attempt_parent(&tree));
                fs::create_dir(&final_path).expect("replacement final");
                fs::write(final_path.join("paper.tex"), b"replacement").expect("replacement bytes");
            }
            Ok(())
        },
    )
    .expect_err("already published rebind needs inspection");
    assert_eq!(
        failure,
        WorkspaceError::PublishedAttemptRequiresInspection {
            final_path: final_path.clone(),
            phase: AttemptPublicationPhaseV1::PublishedRootOpen,
            parent_sync_completed: true,
            cause: Box::new(WorkspaceError::AttemptParentChanged),
        }
    );
    assert_eq!(
        fs::read(
            displaced
                .expect("old parent")
                .join("attempt-rebind-after/paper.tex")
        )
        .expect("actual publication retained"),
        b"draft"
    );
    assert_eq!(
        fs::read(final_path.join("paper.tex")).expect("replacement not touched"),
        b"replacement"
    );
}

#[test]
fn materializes_isolated_attempt_and_validates_mutation_policy() {
    let tree = TempTree::new();
    let source = WorkspaceRootV1::open(tree.source(), tree.uid).expect("source root");
    let source_before = fs::read(tree.source().join("paper.tex")).expect("source bytes");
    let attempt =
        materialize_attempt(&source, &tree.attempts, "attempt-1", tree.uid).expect("attempt");
    fs::write(attempt.canonical_path.join("paper.tex"), b"revised").expect("edit attempt");
    assert_eq!(
        fs::read(tree.source().join("paper.tex")).expect("source after"),
        source_before
    );
    let attempt_root = attempt.open_root(tree.uid).expect("attempt root");
    let after = attempt_root.inventory().expect("after inventory");
    let mutation =
        MutationManifestV1::between(&attempt.initial_inventory, &after).expect("mutation manifest");
    let policy = MutationPolicyV1 {
        version: 1,
        read_only: false,
        allowed_path_prefixes: vec!["paper.tex".to_owned()],
        allowed_extensions: ["tex".to_owned()].into_iter().collect(),
        maximum_changed_entries: 4,
        maximum_changed_file_bytes: 1024,
    };
    let prepared =
        PreparedWorkspaceResultV1::new(&attempt, &attempt_root, &after, &mutation, &policy)
            .expect("prepared result");
    assert_eq!(prepared.attempt_id, "attempt-1");
    assert_eq!(mutation.records.len(), 1);
    assert_eq!(
        prepared.workspace_identity_hash,
        workspace_identity_hash_v1(&attempt_root).expect("workspace identity hash")
    );
    let policy_hash = mutation_policy_hash_v1(&policy).expect("policy hash");
    let decoded: MutationPolicyV1 =
        serde_json::from_slice(&serde_json::to_vec(&policy).expect("policy bytes"))
            .expect("closed policy");
    assert_eq!(
        mutation_policy_hash_v1(&decoded).expect("decoded policy hash"),
        policy_hash
    );
    validate_prepared_workspace_result_v1(
        &prepared,
        &attempt,
        &attempt_root,
        &after,
        &mutation,
        &policy,
    )
    .expect("prepared result recomputes");
}

#[test]
fn production_entry_budget_accepts_exactly_the_fixed_ceiling() {
    let mut budget = TreeEntryBudget::new(WorkspaceLimits::PRODUCTION.tree_entries);
    for _ in 0..MAXIMUM_TREE_ENTRIES {
        budget.reserve().expect("entry within production ceiling");
    }
    for _ in 0..2 {
        assert_eq!(
            budget.reserve(),
            Err(WorkspaceError::TreeEntryLimitExceeded)
        );
        assert_eq!(budget.remaining, 0);
    }
}

#[test]
fn exact_tree_budget_counts_files_and_directories_but_not_the_root() {
    let tree = TempTree::new();
    let source = WorkspaceRootV1::open(tree.source(), tree.uid).expect("source root");
    let limits = WorkspaceLimits {
        tree_entries: 3,
        file_bytes: 64,
    };
    let before = source
        .inventory_with_limits(limits)
        .expect("exact source inventory");
    assert_eq!(
        before
            .entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect::<Vec<_>>(),
        ["paper.tex", "src", "src/model.rs"]
    );
    // This is the same private producer called by the public API, with a
    // small private budget. Public callers cannot override the fixed limit.
    let attempt =
        materialize_attempt_with_limits(&source, &tree.attempts, "exact-budget", tree.uid, limits)
            .expect("exact tree publishes");
    assert_eq!(attempt.initial_inventory, before);
    assert_eq!(fs::read_dir(&tree.attempts).expect("attempts").count(), 1);
    assert_eq!(
        fs::read(attempt.canonical_path.join("paper.tex")).expect("copy"),
        b"draft"
    );
}

#[test]
fn tree_budget_rejection_during_enumeration_or_recursion_never_publishes() {
    // One rejects the second root entry before copying. Two admits both
    // root entries, then rejects the nested file using the SAME budget.
    for limit in [1, 2] {
        let tree = TempTree::new();
        let source = WorkspaceRootV1::open(tree.source(), tree.uid).expect("source root");
        let before = source.inventory().expect("source inventory");
        let limits = WorkspaceLimits {
            tree_entries: limit,
            file_bytes: 64,
        };
        assert_eq!(
            source.inventory_with_limits(limits),
            Err(WorkspaceError::TreeEntryLimitExceeded)
        );
        let failure = materialize_attempt_with_limits(
            &source,
            &tree.attempts,
            "oversize-tree",
            tree.uid,
            limits,
        )
        .expect_err("copy must reject before publication");
        assert_eq!(failure, WorkspaceError::TreeEntryLimitExceeded);
        assert_eq!(
            fs::symlink_metadata(tree.attempts.join("attempt-oversize-tree"))
                .expect_err("final name must never exist")
                .kind(),
            std::io::ErrorKind::NotFound
        );
        assert_eq!(
            fs::read_dir(&tree.attempts)
                .expect("clean attempts")
                .count(),
            0
        );
        assert_eq!(source.inventory().expect("unchanged source"), before);
    }
}

#[test]
fn file_budget_rejection_cleans_staging_before_publication() {
    let tree = TempTree::new();
    let source = WorkspaceRootV1::open(tree.source(), tree.uid).expect("source root");
    let before = source.inventory().expect("source inventory");
    let failure = materialize_attempt_with_limits(
        &source,
        &tree.attempts,
        "oversize-file",
        tree.uid,
        WorkspaceLimits {
            tree_entries: 3,
            file_bytes: 4,
        },
    )
    .expect_err("five-byte paper exceeds the private four-byte test budget");
    assert!(matches!(failure, WorkspaceError::FileByteLimitExceeded(_)));
    assert_eq!(
        fs::read_dir(&tree.attempts)
            .expect("clean attempts")
            .count(),
        0
    );
    assert_eq!(source.inventory().expect("unchanged source"), before);
}

#[test]
fn non_utf8_inventory_rejection_cleans_staging_without_publishing() {
    let tree = TempTree::new();
    let path = tree
        .source()
        .join(OsString::from_vec(b"non-utf8-\xff".to_vec()));
    fs::write(&path, b"source remains").expect("non-UTF-8 source file");
    let source = WorkspaceRootV1::open(tree.source(), tree.uid).expect("source root");
    let failure = materialize_attempt(&source, &tree.attempts, "non-utf8", tree.uid)
        .expect_err("inventory must reject before rename");
    assert_eq!(failure, WorkspaceError::NonUtf8Path);
    assert_eq!(
        fs::symlink_metadata(tree.attempts.join("attempt-non-utf8"))
            .expect_err("never published")
            .kind(),
        std::io::ErrorKind::NotFound
    );
    assert_eq!(fs::read_dir(&tree.attempts).expect("attempts").count(), 0);
    assert_eq!(fs::read(path).expect("source retained"), b"source remains");
}

#[test]
fn errors_after_real_publication_keep_phase_cause_and_final_bytes() {
    for (phase, expected_sync, cause) in [
        (
            AttemptPublicationPhaseV1::ParentDirectorySync,
            false,
            WorkspaceError::Filesystem("injected_parent_sync", std::io::ErrorKind::Other),
        ),
        (
            AttemptPublicationPhaseV1::PublishedRootOpen,
            true,
            WorkspaceError::RootInvalid,
        ),
        (
            AttemptPublicationPhaseV1::PublishedRootValidation,
            true,
            WorkspaceError::RootChanged,
        ),
    ] {
        let tree = TempTree::new();
        let source = WorkspaceRootV1::open(tree.source(), tree.uid).expect("source root");
        let before = source.inventory().expect("source inventory");
        let destination = tree.attempts.join("attempt-published-error");
        let mut reached = false;
        let failure = materialize_attempt_with_publication_check(
            &source,
            &tree.attempts,
            "published-error",
            tree.uid,
            WorkspaceLimits::PRODUCTION,
            |current, published| {
                if current != phase {
                    return Ok(());
                }
                reached = true;
                assert_eq!(published, destination);
                assert_eq!(
                    fs::read(published.join("paper.tex")).expect("real published bytes"),
                    b"draft"
                );
                assert_eq!(
                    fs::read_dir(&tree.attempts)
                        .expect("published namespace")
                        .count(),
                    1,
                    "the real rename already consumed the staging name"
                );
                if phase == AttemptPublicationPhaseV1::PublishedRootValidation {
                    // Exercise the actual revalidation after a real mode
                    // change; this branch does not inject an error value.
                    fs::set_permissions(published, fs::Permissions::from_mode(0o755))
                        .expect("change observed root mode");
                    Ok(())
                } else {
                    Err(cause.clone())
                }
            },
        )
        .expect_err("publication must retain a classified error");
        assert!(reached);
        assert_eq!(
            failure,
            WorkspaceError::PublishedAttemptRequiresInspection {
                final_path: destination.clone(),
                phase,
                parent_sync_completed: expected_sync,
                cause: Box::new(cause),
            }
        );
        let published = fs::symlink_metadata(&destination).expect("final retained");
        assert_eq!(
            fs::read(destination.join("paper.tex")).expect("retained bytes"),
            b"draft"
        );
        assert_eq!(
            materialize_attempt(&source, &tree.attempts, "published-error", tree.uid)
                .expect_err("caller retry cannot overwrite the final name"),
            WorkspaceError::AttemptAlreadyExists
        );
        assert!(same_object(
            &published,
            &fs::symlink_metadata(&destination).expect("same final")
        ));
        assert_eq!(
            fs::read(destination.join("paper.tex")).expect("bytes after retry"),
            b"draft"
        );
        assert_eq!(
            source.inventory().expect("source remains unchanged"),
            before
        );
    }
}

#[test]
fn published_root_must_be_the_actual_preinventoried_staging_object() {
    let tree = TempTree::new();
    let source = WorkspaceRootV1::open(tree.source(), tree.uid).expect("source root");
    let destination = tree.attempts.join("attempt-rebound");
    let displaced = tree.attempts.join("displaced-published-attempt");
    let failure = materialize_attempt_with_publication_check(
        &source,
        &tree.attempts,
        "rebound",
        tree.uid,
        WorkspaceLimits::PRODUCTION,
        |phase, published| {
            if phase == AttemptPublicationPhaseV1::PublishedRootOpen {
                fs::rename(published, &displaced).expect("move actually published directory");
                fs::create_dir(published).expect("replacement final directory");
                fs::set_permissions(published, fs::Permissions::from_mode(0o700))
                    .expect("replacement mode");
                fs::write(published.join("paper.tex"), b"replacement").expect("replacement bytes");
            }
            Ok(())
        },
    )
    .expect_err("the same final path cannot replace the original inode");
    assert_eq!(
        failure,
        WorkspaceError::PublishedAttemptRequiresInspection {
            final_path: destination.clone(),
            phase: AttemptPublicationPhaseV1::PublishedRootValidation,
            parent_sync_completed: true,
            cause: Box::new(WorkspaceError::RootChanged),
        }
    );
    assert_eq!(
        fs::read(displaced.join("paper.tex")).expect("original preserved"),
        b"draft"
    );
    assert_eq!(
        fs::read(destination.join("paper.tex")).expect("replacement not reclaimed"),
        b"replacement"
    );
}

#[test]
fn published_inventory_rejects_changed_bytes_and_non_utf8_names() {
    for non_utf8 in [false, true] {
        let tree = TempTree::new();
        let source = WorkspaceRootV1::open(tree.source(), tree.uid).expect("source root");
        let before = source.inventory().expect("source inventory");
        let destination = tree.attempts.join("attempt-inventory-change");
        let unexpected_name = OsString::from_vec(b"new-non-utf8-\xff".to_vec());
        let mut reached = false;
        let failure = materialize_attempt_with_publication_check(
            &source,
            &tree.attempts,
            "inventory-change",
            tree.uid,
            WorkspaceLimits::PRODUCTION,
            |phase, published| {
                if phase == AttemptPublicationPhaseV1::PublishedInventoryValidation {
                    reached = true;
                    assert_eq!(published, destination);
                    assert_eq!(
                        fs::read_dir(&tree.attempts)
                            .expect("published namespace")
                            .count(),
                        1,
                        "the real rename consumed staging before the mutation"
                    );
                    let previous_root = fs::metadata(published).expect("published root");
                    if non_utf8 {
                        fs::write(published.join(&unexpected_name), b"additional")
                            .expect("add a real non-UTF-8 regular file");
                    } else {
                        // The byte count stays equal: content hashing must
                        // detect a change that directory identity cannot.
                        fs::write(published.join("paper.tex"), b"other")
                            .expect("change real published file bytes");
                    }
                    assert!(same_object(
                        &previous_root,
                        &fs::metadata(published).expect("same root after mutation")
                    ));
                }
                Ok(())
            },
        )
        .expect_err("the published observation must be validated");
        assert!(reached);
        assert_eq!(
            failure,
            WorkspaceError::PublishedAttemptRequiresInspection {
                final_path: destination.clone(),
                phase: AttemptPublicationPhaseV1::PublishedInventoryValidation,
                parent_sync_completed: true,
                cause: Box::new(if non_utf8 {
                    WorkspaceError::NonUtf8Path
                } else {
                    WorkspaceError::InventoryChanged
                }),
            }
        );
        let published = fs::metadata(&destination).expect("final retained");
        assert_eq!(
            materialize_attempt(&source, &tree.attempts, "inventory-change", tree.uid)
                .expect_err("retry must not overwrite the published tree"),
            WorkspaceError::AttemptAlreadyExists
        );
        assert!(same_object(
            &published,
            &fs::metadata(&destination).expect("same final after retry")
        ));
        assert_eq!(
            fs::read(destination.join("paper.tex")).expect("retained final bytes"),
            if non_utf8 { b"draft" } else { b"other" }
        );
        if non_utf8 {
            assert_eq!(
                fs::read(destination.join(&unexpected_name)).expect("new file retained"),
                b"additional"
            );
        }
        assert_eq!(source.inventory().expect("source unchanged"), before);
    }
}

#[test]
fn growing_file_copy_and_hash_read_only_the_limit_plus_one_byte() {
    let tree = TempTree::new();
    let path = tree.root.join("growing-file");
    let destination = tree.root.join("bounded-copy");
    for grow in [false, true] {
        fs::write(&path, b"abcd").expect("initial file at exact byte boundary");
        let mut copy_source = File::open(&path).expect("retained copy source");
        let mut hash_source = File::open(&path).expect("retained hash source");
        assert_eq!(copy_source.metadata().expect("pre-copy stat").len(), 4);
        assert_eq!(hash_source.metadata().expect("pre-hash stat").len(), 4);
        if grow {
            OpenOptions::new()
                .append(true)
                .open(&path)
                .expect("concurrent writer")
                .write_all(b"efghijkl")
                .expect("grow after metadata check");
        }
        let mut output = File::create(&destination).expect("copy destination");
        let copy = copy_file_bytes(&mut copy_source, &mut output, &path, 4);
        let hash = hash_file_bytes(&mut hash_source, &path, 4);
        if grow {
            let expected = WorkspaceError::FileByteLimitExceeded(path_text(&path).expect("path"));
            assert_eq!(copy, Err(expected.clone()));
            assert_eq!(hash, Err(expected));
            assert_eq!(copy_source.stream_position().expect("copy offset"), 5);
            assert_eq!(hash_source.stream_position().expect("hash offset"), 5);
            assert_eq!(output.metadata().expect("bounded output").len(), 5);
            assert_eq!(fs::metadata(&path).expect("larger actual source").len(), 12);
        } else {
            copy.expect("exact byte limit copies");
            assert_eq!(
                hash.expect("exact byte limit hashes").as_str(),
                format!("sha256:{}", hex::encode(Sha256::digest(b"abcd")))
            );
            assert_eq!(copy_source.stream_position().expect("copy offset"), 4);
            assert_eq!(hash_source.stream_position().expect("hash offset"), 4);
            assert_eq!(fs::read(&destination).expect("exact output"), b"abcd");
        }
    }
}

#[test]
fn read_only_reviewer_and_symlink_escape_fail_closed() {
    let tree = TempTree::new();
    let source = WorkspaceRootV1::open(tree.source(), tree.uid).expect("source root");
    let before = source.inventory().expect("before");
    let after = source.inventory().expect("after");
    let empty = MutationManifestV1::between(&before, &after).expect("empty manifest");
    MutationPolicyV1::reviewer_read_only()
        .validate_manifest(&empty)
        .expect("read-only no-op");

    symlink("/etc/passwd", tree.source().join("escape")).expect("escape link");
    assert!(matches!(
        source.inventory(),
        Err(WorkspaceError::SymlinkForbidden(_))
    ));
}

#[test]
fn publication_cannot_replace_an_object_created_after_the_initial_check() {
    for existing in ["empty-directory", "file", "dangling-symlink"] {
        let tree = TempTree::new();
        let staging = tree.attempts.join(".attempt-race-1-1.creating");
        let destination = tree.attempts.join("attempt-race");
        fs::create_dir(&staging).expect("private staging");
        fs::write(staging.join("copied.txt"), b"new attempt").expect("staged bytes");
        assert!(!destination.exists(), "initial destination check");
        // A concurrent publisher or same-owner actor creates the final
        // name while this attempt is still copying. An empty directory
        // would be silently replaced by ordinary fs::rename.
        match existing {
            "empty-directory" => fs::create_dir(&destination).expect("existing directory"),
            "file" => fs::write(&destination, b"prior attempt").expect("existing file"),
            _ => symlink("missing-target", &destination).expect("existing link"),
        }
        let before = fs::symlink_metadata(&destination).expect("existing identity");
        assert_eq!(
            publish_attempt_no_replace(&staging, &destination),
            Err(WorkspaceError::AttemptAlreadyExists)
        );
        let after = fs::symlink_metadata(&destination).expect("preserved identity");
        assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
        assert_eq!(
            fs::read(staging.join("copied.txt")).expect("unpublished bytes retained"),
            b"new attempt"
        );
        match existing {
            "empty-directory" => {
                assert_eq!(fs::read_dir(&destination).expect("directory").count(), 0)
            }
            "file" => assert_eq!(fs::read(&destination).expect("file"), b"prior attempt"),
            _ => assert_eq!(
                fs::read_link(&destination).expect("link"),
                Path::new("missing-target")
            ),
        }
    }
}

#[test]
fn recovery_removes_only_incomplete_staging() {
    let tree = TempTree::new();
    let staging = tree.attempts.join(".attempt-x-1-1.creating");
    fs::create_dir(&staging).expect("staging");
    fs::set_permissions(&staging, fs::Permissions::from_mode(0o700)).expect("mode");
    assert_eq!(
        recover_incomplete_attempts(&tree.attempts, tree.uid).expect("recover"),
        1
    );
    assert!(!staging.exists());
}
