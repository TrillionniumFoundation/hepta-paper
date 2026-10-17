use super::*;
use std::{
    os::unix::fs::PermissionsExt,
    time::{Duration, SystemTime},
};

#[test]
fn concurrent_bytes_reserve_precedes_allocation_and_keeps_committed_capacity() {
    let budget = BytesBudget {
        occupied: AtomicU64::new(0),
    };
    let first = budget.reserve(TOTAL_BYTES - 1).unwrap();
    assert!(budget.reserve(2).is_err());
    assert_eq!(budget.occupied.load(Ordering::Acquire), TOTAL_BYTES - 1);
    drop(first);
    assert_eq!(budget.occupied.load(Ordering::Acquire), 0);
    budget.reserve(100).unwrap().commit(70).unwrap();
    assert_eq!(budget.occupied.load(Ordering::Acquire), 70);
    assert!(budget.reserve(TOTAL_BYTES - 69).is_err());
    assert_eq!(budget.occupied.load(Ordering::Acquire), 70);
}
fn fixture(label: &str) -> (PathBuf, PathBuf) {
    let id = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root =
        std::env::temp_dir().join(format!("hepta-mixed-{label}-{}-{id}", std::process::id()));
    let context = root.join("runtime-images/r-scientific");
    let seed = root.join("seed");
    fs::create_dir_all(&context).unwrap();
    fs::create_dir(&seed).unwrap();
    fs::write(context.join("renv.lock"),br#"{"Packages":{"demo":{"Package":"demo","Version":"1.0","Source":"Repository","Repository":"CRAN"}}}"#).unwrap();
    fs::create_dir(seed.join("demo")).unwrap();
    fs::write(
        seed.join("demo/DESCRIPTION"),
        "Package: demo\nVersion: 1.0\nDescription: local fixture\n",
    )
    .unwrap();
    let tar = std::process::Command::new("/usr/bin/tar")
        .args(["-czf"])
        .arg(seed.join("demo_1.0.tar.gz"))
        .arg("-C")
        .arg(&seed)
        .arg("demo")
        .status()
        .unwrap();
    assert!(tar.success());
    (root, seed)
}
#[test]
fn original_control_and_concurrency_refuse_before_namespace_and_fresh_seed_retry() {
    let (root, seed) = fixture("controls");
    let context = root.join("runtime-images/r-scientific");
    let flag = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(120);
    for n in [0, 17] {
        assert_eq!(
            super::super::acquire_runtime_source_cas_mixed_with_control_v1(
                &root,
                Some(&seed),
                n,
                &flag,
                deadline
            )
            .unwrap_err(),
            "r_runtime_source_cas_concurrency_invalid"
        );
    }
    flag.store(true, Ordering::Release);
    assert_eq!(
        super::super::acquire_runtime_source_cas_mixed_with_control_v1(
            &root,
            Some(&seed),
            6,
            &flag,
            deadline
        )
        .unwrap_err(),
        "r_runtime_source_cas_cancelled"
    );
    flag.store(false, Ordering::Release);
    assert_eq!(
        super::super::acquire_runtime_source_cas_mixed_with_control_v1(
            &root,
            Some(&seed),
            6,
            &flag,
            Instant::now() - Duration::from_secs(1)
        )
        .unwrap_err(),
        "r_runtime_source_cas_deadline_exceeded"
    );
    assert_eq!(fs::read_dir(&context).unwrap().count(), 1);
    let value = super::super::acquire_runtime_source_cas_mixed_with_control_v1(
        &root,
        Some(&seed),
        6,
        &flag,
        deadline,
    )
    .unwrap();
    assert_eq!(value["acquired"], true);
    assert_eq!(value["ready"], true);
    fs::set_permissions(
        seed.join("demo_1.0.tar.gz"),
        fs::Permissions::from_mode(0o000),
    )
    .unwrap();
    let report = super::super::acquire_runtime_source_cas_mixed_with_control_v1(
        &root,
        Some(&root.join("missing")),
        16,
        &flag,
        deadline,
    )
    .unwrap();
    assert_eq!(report["acquired"], false);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn mixed_original_publication_boundary_keeps_unknown_commit_and_replays_in_place() {
    let (root, seed) = fixture("afterrename");
    let flag = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(120);
    let result = super::super::acquire_from_source_with_controls(
        &root,
        super::super::AcquisitionSource::MixedSnapshot {
            seed: Some(&seed),
            concurrency: 2,
            deadline,
        },
        &flag,
        &mut |phase, _| {
            if phase == super::super::PublicationBoundary::AfterRename {
                Err("actual_postrename_refusal".into())
            } else {
                Ok(())
            }
        },
    );
    assert_eq!(result.unwrap_err(), "actual_postrename_refusal");
    let archive = root.join("runtime-images/r-scientific/source-cas/src/contrib/demo_1.0.tar.gz");
    let before = fs::read(&archive).unwrap();
    let value = super::super::acquire_runtime_source_cas_mixed_with_control_v1(
        &root, None, 6, &flag, deadline,
    )
    .unwrap();
    assert_eq!(value["acquired"], false);
    assert_eq!(fs::read(archive).unwrap(), before);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn mixed_source_drift_retains_foreign_stage_bytes_and_allows_independent_fresh_retry() {
    for mode in ["replacement", "alias", "foreign-directory"] {
        let (root, seed) = fixture(mode);
        let flag = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut captured = None;
        let result = super::super::acquire_from_source_with_controls(
            &root,
            super::super::AcquisitionSource::MixedSnapshot {
                seed: Some(&seed),
                concurrency: 2,
                deadline,
            },
            &flag,
            &mut |phase, stage| {
                if phase == super::super::PublicationBoundary::BeforePublish {
                    captured = Some(stage.to_owned());
                    let archive = stage.join("src/contrib/demo_1.0.tar.gz");
                    if mode == "foreign-directory" {
                        fs::create_dir(stage.join("foreign-unknown")).unwrap();
                    } else {
                        fs::rename(&archive, stage.join("held-original.tar.gz")).unwrap();
                        if mode == "replacement" {
                            fs::write(&archive, b"foreign-result-that-the-owner-did-not-create")
                                .unwrap();
                        } else {
                            std::os::unix::fs::symlink("../../held-original.tar.gz", &archive)
                                .unwrap();
                        }
                    }
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        let stage = captured.unwrap();
        assert!(
            stage.exists(),
            "unknown currentness must not authorize deleting foreign stage bytes: {mode}"
        );
        let later = super::super::acquire_runtime_source_cas_mixed_with_control_v1(
            &root,
            Some(&seed),
            2,
            &flag,
            deadline,
        )
        .unwrap();
        assert_eq!(later["acquired"], true);
        assert!(
            stage.exists(),
            "fresh retry cannot adopt/delete old unknown stage"
        );
        if mode == "replacement" {
            assert_eq!(
                fs::read(stage.join("src/contrib/demo_1.0.tar.gz")).unwrap(),
                b"foreign-result-that-the-owner-did-not-create"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
}
