//! Owned source fixtures and real publication syscalls; no installed runtime.
use super::*;
use std::process::Command;

struct Fixture {
    root: PathBuf,
    seed: PathBuf,
    context: PathBuf,
    lock: Vec<u8>,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("hepta-cas-publication-{}", random_nonce().unwrap()));
        let seed = root.join("seed");
        let context = root.join("runtime-images/r-scientific");
        fs::create_dir_all(seed.join("demo")).unwrap();
        fs::create_dir_all(&context).unwrap();
        let lock = br#"{"Packages":{"demo":{"Package":"demo","Version":"1.0.0","Source":"Repository","Repository":"CRAN"}}}"#.to_vec();
        fs::write(context.join("renv.lock"), &lock).unwrap();
        fs::write(
            seed.join("demo/DESCRIPTION"),
            b"Package: demo\nVersion: 1.0.0\nDescription: bounded fixture\n",
        )
        .unwrap();
        assert!(
            Command::new("tar")
                .arg("-czf")
                .arg(seed.join("demo_1.0.0.tar.gz"))
                .arg("-C")
                .arg(&seed)
                .arg("demo")
                .status()
                .unwrap()
                .success()
        );
        Self {
            root,
            seed,
            context,
            lock,
        }
    }
    fn destination(&self) -> PathBuf {
        self.context.join("source-cas")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn snapshot(root: &Path) -> BTreeMap<String, (u64, u64, String)> {
    let cancelled = AtomicBool::new(false);
    let mut observed = SourceObservation::new(root, &cancelled).unwrap();
    let files = observed.files(Path::new("")).unwrap();
    files
        .into_iter()
        .map(|name| {
            let path = root.join(&name);
            let identity = fs::symlink_metadata(&path).unwrap();
            (
                name,
                (
                    identity.dev(),
                    identity.ino(),
                    digest(&fs::read(path).unwrap()),
                ),
            )
        })
        .collect()
}

#[test]
fn post_publish_observation_failure_preserves_complete_archive_set() {
    let f = Fixture::new();
    let mut published = None;
    let error = acquire_with_observation(&f.root, &f.seed, &mut |stage, _| {
        if stage == PublicationBoundary::AfterRename {
            published = Some(snapshot(&f.destination()));
            // Valid changed lock bytes invalidate the post-publication report.
            let mut changed = f.lock.clone();
            changed.push(b'\n');
            fs::write(f.context.join("renv.lock"), changed).unwrap();
        }
        Ok(())
    })
    .unwrap_err();
    assert!(
        error.starts_with("r_runtime_source_cas_post_publish_invalid:"),
        "{error}"
    );
    assert!(
        f.destination().is_dir(),
        "an observation failure must never erase published bytes"
    );
    assert_eq!(snapshot(&f.destination()), published.unwrap());
    fs::write(f.context.join("renv.lock"), &f.lock).unwrap();
    let before = snapshot(&f.destination());
    fs::remove_dir_all(&f.seed).unwrap();
    let replay = acquire_runtime_source_cas_from_seed_v1(&f.root, &f.seed).unwrap();
    assert_eq!(replay["acquired"], false);
    assert_eq!(snapshot(&f.destination()), before);
}

#[test]
fn prepublish_lock_drift_refuses_before_publication() {
    let f = Fixture::new();
    let error = acquire_with_observation(&f.root, &f.seed, &mut |stage, _| {
        if stage == PublicationBoundary::BeforePublish {
            let mut changed = f.lock.clone();
            changed.push(b'\n');
            fs::write(f.context.join("renv.lock"), changed).unwrap();
        }
        Ok(())
    })
    .unwrap_err();
    assert_eq!(error, "r_runtime_source_cas_lock_changed");
    assert!(!f.destination().exists());
}

#[test]
fn rebound_stage_name_is_not_cleaned_or_published() {
    for fail_observer in [false, true] {
        let f = Fixture::new();
        let mut selected = None;
        let retained = f.context.join("retained-original-stage");
        let error = acquire_with_observation(&f.root, &f.seed, &mut |stage, path| {
            if stage == PublicationBoundary::BeforePublish {
                selected = Some(path.to_owned());
                fs::rename(path, &retained).unwrap();
                fs::create_dir(path).unwrap();
                fs::write(path.join("foreign-sentinel"), b"do not remove").unwrap();
                if fail_observer {
                    return Err("injected_prepublication_failure".into());
                }
            }
            Ok(())
        })
        .unwrap_err();
        assert!(!error.is_empty());
        assert_eq!(
            fs::read(selected.unwrap().join("foreign-sentinel")).unwrap(),
            b"do not remove"
        );
        assert!(retained.join("manifest.json").is_file());
        assert!(!f.destination().exists());
    }
}

#[test]
fn concurrent_acquisition_is_excluded_by_one_parent_directory_lock() {
    let f = Fixture::new();
    let first = acquire_with_observation(&f.root, &f.seed, &mut |stage, _| {
        if stage == PublicationBoundary::BeforePublish {
            let result = std::thread::scope(|scope| {
                scope
                    .spawn(|| acquire_runtime_source_cas_from_seed_v1(&f.root, &f.seed))
                    .join()
                    .unwrap()
            });
            assert_eq!(result.unwrap_err(), "r_runtime_source_cas_owner_busy");
        }
        Ok(())
    })
    .unwrap();
    assert_eq!(first["acquired"], true);
    let before = snapshot(&f.destination());
    assert_eq!(
        acquire_runtime_source_cas_from_seed_v1(&f.root, &f.seed).unwrap()["acquired"],
        false
    );
    assert_eq!(snapshot(&f.destination()), before);
}

#[test]
fn postrename_error_preserves_bytes_and_replays_without_seed() {
    let f = Fixture::new();
    let mut published = None;
    let error = acquire_with_observation(&f.root, &f.seed, &mut |stage, _| {
        if stage == PublicationBoundary::AfterRename {
            published = Some(snapshot(&f.destination()));
            return Err("injected_directory_sync_boundary_failure".into());
        }
        Ok(())
    })
    .unwrap_err();
    assert_eq!(error, "injected_directory_sync_boundary_failure");
    assert_eq!(snapshot(&f.destination()), published.unwrap());
    let before = snapshot(&f.destination());
    fs::remove_dir_all(&f.seed).unwrap();
    assert_eq!(
        acquire_runtime_source_cas_from_seed_v1(&f.root, &f.seed).unwrap()["acquired"],
        false
    );
    assert_eq!(snapshot(&f.destination()), before);
}

#[test]
#[ignore = "owned child invoked by real_process_crash_preserves_published_and_unpublished_bytes"]
fn publication_crash_child() {
    let root = PathBuf::from(std::env::var_os("HEPTA_CAS_OWNED_FAULT_ROOT").expect("child root"));
    let boundary = std::env::var("HEPTA_CAS_OWNED_FAULT_BOUNDARY").unwrap();
    acquire_with_observation(&root, &root.join("seed"), &mut |stage, staging| {
        if format!("{stage:?}") == boundary {
            fs::write(
                root.join("crash-boundary.json"),
                serde_json::to_vec(&json!({
                    "boundary": boundary, "staging": staging
                }))
                .unwrap(),
            )
            .unwrap();
            nix::sys::signal::kill(nix::unistd::getpid(), nix::sys::signal::Signal::SIGKILL)
                .unwrap();
            panic!("SIGKILL must terminate the child before returning");
        }
        Ok(())
    })
    .unwrap();
    panic!("requested crash boundary was not reached");
}

#[test]
fn real_process_crash_preserves_published_and_unpublished_bytes() {
    use std::os::unix::process::ExitStatusExt;
    for boundary in ["BeforePublish", "AfterRename", "AfterDirectorySync"] {
        let f = Fixture::new();
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "runtime_source_cas::tests::publication_crash_child",
                "--exact",
                "--ignored",
                "--nocapture",
            ])
            .env("HEPTA_CAS_OWNED_FAULT_ROOT", &f.root)
            .env("HEPTA_CAS_OWNED_FAULT_BOUNDARY", boundary)
            .output()
            .unwrap();
        assert_eq!(
            child.status.signal(),
            Some(9),
            "{boundary}: {}",
            String::from_utf8_lossy(&child.stderr)
        );
        let reached: Value =
            serde_json::from_slice(&fs::read(f.root.join("crash-boundary.json")).unwrap()).unwrap();
        assert_eq!(reached["boundary"], boundary);
        let stage = PathBuf::from(reached["staging"].as_str().unwrap());
        if boundary == "BeforePublish" {
            assert!(!f.destination().exists());
            let retained = snapshot(&stage);
            // Rebuild in a new private stage; never adopt or delete orphan bytes.
            assert_eq!(
                acquire_runtime_source_cas_from_seed_v1(&f.root, &f.seed).unwrap()["acquired"],
                true
            );
            assert_eq!(snapshot(&stage), retained);
        } else {
            assert!(!stage.exists());
            let retained = snapshot(&f.destination());
            fs::remove_dir_all(&f.seed).unwrap();
            assert_eq!(
                acquire_runtime_source_cas_from_seed_v1(&f.root, &f.seed).unwrap()["acquired"],
                false
            );
            assert_eq!(snapshot(&f.destination()), retained);
        }
        assert_eq!(inspect_runtime_source_cas_v1(&f.root)["ready"], true);
    }
}

#[test]
fn symlinked_published_root_is_not_accepted_as_acquisition_success() {
    let f = Fixture::new();
    acquire_runtime_source_cas_from_seed_v1(&f.root, &f.seed).unwrap();
    let retained = f.context.join("retained-cas");
    fs::rename(f.destination(), &retained).unwrap();
    let before = snapshot(&retained);
    std::os::unix::fs::symlink(&retained, f.destination()).unwrap();
    assert!(acquire_runtime_source_cas_from_seed_v1(&f.root, &f.seed).is_err());
    assert_eq!(snapshot(&retained), before);
}

#[test]
fn published_bytes_are_retained_even_if_the_directory_moves_back_to_staging() {
    let f = Fixture::new();
    let mut moved_back = None;
    let mut published = None;
    let error = acquire_with_observation(&f.root, &f.seed, &mut |boundary, stage| {
        if boundary == PublicationBoundary::AfterRename {
            published = Some(snapshot(&f.destination()));
            fs::rename(f.destination(), stage).unwrap();
            moved_back = Some(stage.to_owned());
            return Err("injected_post_publish_rebinding".into());
        }
        Ok(())
    })
    .unwrap_err();
    assert_eq!(error, "injected_post_publish_rebinding");
    let retained = moved_back.unwrap();
    assert!(
        retained.is_dir(),
        "publication phase cannot be inferred from the current name"
    );
    assert_eq!(snapshot(&retained), published.unwrap());
}

#[test]
fn cancellation_observes_publication_boundary_without_erasing_committed_bytes() {
    use std::sync::atomic::Ordering;
    for boundary in [
        PublicationBoundary::BeforePublish,
        PublicationBoundary::AfterRename,
        PublicationBoundary::AfterDirectorySync,
    ] {
        let f = Fixture::new();
        let cancelled = AtomicBool::new(false);
        let mut published = None;
        let result = acquire_with_controls(&f.root, &f.seed, &cancelled, &mut |stage, _| {
            if stage == boundary {
                if stage != PublicationBoundary::BeforePublish {
                    published = Some(snapshot(&f.destination()));
                }
                cancelled.store(true, Ordering::Release);
            }
            Ok(())
        });
        assert_eq!(result.unwrap_err(), "r_runtime_source_cas_cancelled");
        assert_eq!(fs::read(f.context.join("renv.lock")).unwrap(), f.lock);
        if let Some(published) = published {
            assert_eq!(snapshot(&f.destination()), published);
            fs::remove_dir_all(&f.seed).unwrap();
            let replay = acquire_runtime_source_cas_from_seed_v1(&f.root, &f.seed).unwrap();
            assert_eq!(replay["acquired"], false);
            assert_eq!(snapshot(&f.destination()), published);
        } else {
            assert!(!f.destination().exists());
            let retry = acquire_runtime_source_cas_from_seed_v1(&f.root, &f.seed).unwrap();
            assert_eq!(retry["acquired"], true);
        }
    }
}

#[test]
fn precancelled_acquisition_has_no_stage_or_publication() {
    let f = Fixture::new();
    let before = snapshot(&f.root);
    assert_eq!(
        acquire_runtime_source_cas_from_seed_with_cancellation_v1(
            &f.root,
            &f.seed,
            &AtomicBool::new(true)
        )
        .unwrap_err(),
        "r_runtime_source_cas_cancelled"
    );
    assert_eq!(snapshot(&f.root), before);
}

#[test]
fn seed_scan_cancellation_stops_collection_and_never_returns_partial_inventory() {
    // Interrupt the real directory walk's existing cooperative active check,
    // rather than sleeping until an assumed scheduling/IO window.
    let root = std::env::temp_dir().join(format!(
        "hepta-seed-cancel-{}-{}",
        std::process::id(),
        super::random_nonce().unwrap()
    ));
    std::fs::create_dir(&root).unwrap();
    for index in 0..8 {
        std::fs::write(root.join(format!("entry-{index}.tar.gz")), b"unused").unwrap();
    }
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let mut checks = 0;
    let mut output = std::collections::BTreeMap::new();
    let mut remaining = super::MAX_SEED_ENTRIES;
    let error = super::collect_seed_archives(
        &root,
        &mut output,
        &mut || {
            checks += 1;
            if checks == 5 {
                cancelled.store(true, std::sync::atomic::Ordering::Release);
            }
            super::require_active(&cancelled)
        },
        &mut remaining,
        0,
    )
    .unwrap_err();
    assert_eq!(error, "r_runtime_source_cas_cancelled");
    assert_eq!(checks, 5);
    assert_eq!(remaining, super::MAX_SEED_ENTRIES - 3);
    assert!(output.is_empty());
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 8);
    // Already cancelled public discovery must not touch a missing path.
    assert_eq!(
        super::seed_archives(&root.join("absent"), &cancelled).unwrap_err(),
        error
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn status_rechecks_actual_files_after_hashing_and_preserves_changed_bytes() {
    for relative in [
        "renv.lock",
        "source-cas/manifest.json",
        "source-cas/SHA256SUMS",
        "source-cas/PACKAGES.tsv",
        "source-cas/src/contrib/demo_1.0.0.tar.gz",
    ] {
        let f = Fixture::new();
        acquire_runtime_source_cas_from_seed_v1(&f.root, &f.seed).unwrap();
        let path = f.context.join(relative);
        let mut changed = fs::read(&path).unwrap();
        changed.push(b' ');
        let report = inspect_with_checkpoint(&f.root, &AtomicBool::new(false), &mut || {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            fs::write(&path, &changed).unwrap();
        });
        assert_eq!(report["ready"], false, "{relative}: {report}");
        assert_eq!(report["blockers"][0], "r_runtime_source_cas_input_changed");
        assert_eq!(
            fs::read(path).unwrap(),
            changed,
            "inspection cannot repair input"
        );
    }
}

#[test]
fn status_rejects_byte_identical_inode_and_directory_replacements() {
    for replace_directory in [false, true] {
        let f = Fixture::new();
        acquire_runtime_source_cas_from_seed_v1(&f.root, &f.seed).unwrap();
        let original = snapshot(&f.destination());
        let retained = f.context.join("original-cas");
        let report = inspect_with_checkpoint(&f.root, &AtomicBool::new(false), &mut || {
            if replace_directory {
                fs::rename(f.destination(), &retained).unwrap();
                fs::create_dir(f.destination()).unwrap();
                fs::write(f.destination().join("foreign"), b"preserve replacement").unwrap();
            } else {
                let input = f.destination().join("manifest.json");
                let bytes = fs::read(&input).unwrap();
                fs::rename(&input, f.context.join("original-manifest.json")).unwrap();
                fs::write(&input, bytes).unwrap();
                fs::set_permissions(&input, fs::Permissions::from_mode(0o444)).unwrap();
            }
        });
        assert_eq!(report["ready"], false, "{report}");
        assert_eq!(report["blockers"][0], "r_runtime_source_cas_input_changed");
        if replace_directory {
            assert_eq!(snapshot(&retained), original);
            assert_eq!(
                fs::read(f.destination().join("foreign")).unwrap(),
                b"preserve replacement"
            );
        }
    }
}

#[test]
fn status_cancellation_precedes_input_and_invalidates_late_readiness_without_writes() {
    use std::sync::atomic::Ordering;
    let cancelled = AtomicBool::new(true);
    let missing = Path::new("/unavailable-input-not-consumed");
    let report = inspect_runtime_source_cas_with_cancellation_v1(missing, &cancelled);
    assert_eq!(report["blockers"][0], "r_runtime_source_cas_cancelled");
    let f = Fixture::new();
    acquire_runtime_source_cas_from_seed_v1(&f.root, &f.seed).unwrap();
    let before = snapshot(&f.destination());
    cancelled.store(false, Ordering::Release);
    let report = inspect_with_checkpoint(&f.root, &cancelled, &mut || {
        cancelled.store(true, Ordering::Release)
    });
    assert_eq!(report["ready"], false);
    assert_eq!(report["blockers"][0], "r_runtime_source_cas_cancelled");
    assert_eq!(
        acquire_runtime_source_cas_from_seed_with_cancellation_v1(&f.root, &f.seed, &cancelled)
            .unwrap_err(),
        "r_runtime_source_cas_cancelled"
    );
    assert_eq!(snapshot(&f.destination()), before);
    cancelled.store(false, Ordering::Release);
    fs::remove_dir_all(&f.seed).unwrap();
    assert_eq!(
        acquire_runtime_source_cas_from_seed_with_cancellation_v1(&f.root, &f.seed, &cancelled)
            .unwrap()["acquired"],
        false
    );
    assert_eq!(snapshot(&f.destination()), before);
}

#[test]
fn prepublish_staged_namespace_and_bytes_remain_bound_to_verified_inputs() {
    for case in 0..3 {
        let f = Fixture::new();
        let original = snapshot(&f.seed);
        let error = acquire_with_observation(&f.root, &f.seed, &mut |boundary, staging| {
            if boundary == PublicationBoundary::BeforePublish {
                if case == 0 {
                    let archive = staging.join("src/contrib/demo_1.0.0.tar.gz");
                    let replacement = staging.join("replacement");
                    fs::write(&replacement, fs::read(&archive).unwrap()).unwrap();
                    fs::set_permissions(&replacement, fs::Permissions::from_mode(0o444)).unwrap();
                    fs::rename(replacement, archive).unwrap();
                } else if case == 1 {
                    let index = staging.join("SHA256SUMS");
                    fs::set_permissions(&index, fs::Permissions::from_mode(0o644)).unwrap();
                    fs::write(index, b"changed after validation").unwrap();
                } else {
                    fs::write(staging.join("unexpected"), b"not in the manifest").unwrap();
                }
            }
            Ok(())
        })
        .unwrap_err();
        assert_eq!(error, "r_runtime_source_cas_input_changed", "case {case}");
        assert!(!f.destination().exists());
        assert_eq!(snapshot(&f.seed), original);
        assert_eq!(fs::read_dir(&f.context).unwrap().count(), 1);
    }
}
