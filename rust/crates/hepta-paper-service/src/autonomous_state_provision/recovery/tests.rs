use super::*;
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    process::Command,
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).unwrap();
        let root =
            std::env::temp_dir().join(format!("hepta-provision-recovery-{}", hex::encode(nonce)));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let value = Self(root);
        fs::create_dir(value.stage()).unwrap();
        fs::set_permissions(value.stage(), fs::Permissions::from_mode(0o700)).unwrap();
        value.write(
            "hepta-paper.sqlite",
            b"partial constructor bytes; not an accepted database",
        );
        value
    }
    fn stage(&self) -> PathBuf {
        self.0
            .join(".runtime.provisioning-0123456789abcdef0123456789abcdef")
    }
    fn quarantine(&self) -> PathBuf {
        self.0
            .join(".runtime.quarantined-provisioning-0123456789abcdef0123456789abcdef")
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        fs::write(self.stage().join(name), bytes).unwrap();
        fs::set_permissions(self.stage().join(name), fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn inspect(&self) -> Request {
        Request {
            version: 1,
            kind: "NativeStateProvisioningRecoveryRequestV1".into(),
            action: "inspect".into(),
            runtime_root: self.0.join("runtime"),
            staging_root: self.stage(),
            execute: false,
            expected_plan_hash: None,
        }
    }
    fn selected(&self) -> Request {
        let mut request = self.inspect();
        let plan = run(&request).unwrap();
        request.action = "quarantine".into();
        request.execute = true;
        request.expected_plan_hash =
            Some(plan["plan"]["recoveryPlanHash"].as_str().unwrap().into());
        request
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn run(request: &Request) -> Result<Value> {
    recover(request, &|| Ok(()), &mut |_| Ok(()))
}
#[test]
fn inspection_is_read_only_and_quarantine_preserves_bytes_with_exact_replay() {
    let fixture = Fixture::new();
    let before = fs::read(fixture.stage().join("hepta-paper.sqlite")).unwrap();
    let inspected = run(&fixture.inspect()).unwrap();
    assert_eq!(inspected["mutationPerformed"], false);
    assert!(!fixture.quarantine().exists());
    assert!(!fixture.0.join("runtime").exists());
    let request = fixture.selected();
    let result = run(&request).unwrap();
    assert_eq!(result["state"], "quarantined");
    assert_eq!(result["freshRuntimeInstalled"], false);
    assert_eq!(result["deletionPerformed"], false);
    assert_eq!(
        fs::read(fixture.quarantine().join("hepta-paper.sqlite")).unwrap(),
        before
    );
    assert!(!fixture.stage().exists());
    assert_eq!(run(&request).unwrap(), result);
    assert!(Target::open(&fixture.0.join("runtime")).is_ok());
}
#[test]
fn changed_bytes_and_byte_identical_inode_replacement_invalidate_the_selected_plan() {
    for replacement in [false, true] {
        let fixture = Fixture::new();
        let request = fixture.selected();
        let file = fixture.stage().join("hepta-paper.sqlite");
        let bytes = fs::read(&file).unwrap();
        if replacement {
            fs::rename(&file, fixture.0.join("old-snapshot")).unwrap();
            fixture.write("hepta-paper.sqlite", &bytes);
        } else {
            fixture.write("hepta-paper.sqlite", b"changed");
        }
        assert!(run(&request).unwrap_err().0.contains("plan_mismatch"));
        assert!(fixture.stage().exists());
        assert!(!fixture.quarantine().exists());
    }
}
#[test]
fn recovery_refuses_existing_runtime_even_if_it_looks_pristine() {
    let fixture = Fixture::new();
    let request = fixture.selected();
    fs::create_dir(&request.runtime_root).unwrap();
    fs::write(request.runtime_root.join("newer-state"), b"preserve").unwrap();
    assert!(run(&request).is_err());
    assert!(fixture.stage().exists());
    assert_eq!(
        fs::read(request.runtime_root.join("newer-state")).unwrap(),
        b"preserve"
    );
}
#[test]
fn unexpected_names_symlinks_hardlinks_and_publication_receipts_are_never_adopted() {
    for kind in 0..4 {
        let fixture = Fixture::new();
        let file = fixture.stage().join("hepta-paper.sqlite");
        match kind {
            0 => fixture.write("unregistered", b"preserve"),
            1 => {
                fs::remove_file(&file).unwrap();
                symlink("/dev/null", file).unwrap();
            }
            2 => fs::hard_link(&file, fixture.0.join("linked-original")).unwrap(),
            _ => fixture.write("native-provisioning-publication.json", b"{}"),
        }
        assert!(run(&fixture.inspect()).is_err());
        assert!(fixture.stage().exists());
        assert!(!fixture.quarantine().exists());
    }
}
#[test]
fn recovery_and_publication_use_the_same_nonblocking_parent_owner() {
    let fixture = Fixture::new();
    let target = Target::open_parent(&fixture.0.join("runtime")).unwrap();
    let lock = target.lock().unwrap();
    assert!(
        run(&fixture.inspect())
            .unwrap_err()
            .0
            .contains("owner_busy")
    );
    drop(lock);
    assert!(run(&fixture.inspect()).is_ok());
}
#[test]
fn quarantine_collision_and_source_change_before_rename_preserve_originals() {
    for collision in [false, true] {
        let fixture = Fixture::new();
        let request = fixture.selected();
        let failure = recover(&request, &|| Ok(()), &mut |cut| {
            if cut == "before_quarantine" {
                if collision {
                    fs::create_dir(fixture.quarantine())?;
                    fs::write(fixture.quarantine().join("keep"), b"other owner")?;
                } else {
                    fixture.write("hepta-paper.sqlite", b"race");
                }
            }
            Ok(())
        })
        .unwrap_err();
        assert!(failure.0.contains("quarantineState=not_quarantined"));
        assert!(fixture.stage().exists());
        if collision {
            assert_eq!(
                fs::read(fixture.quarantine().join("keep")).unwrap(),
                b"other owner"
            );
        }
    }
}
#[test]
fn post_rename_failure_keeps_quarantine_and_is_reconciled_by_exact_plan() {
    let fixture = Fixture::new();
    let request = fixture.selected();
    let failure = recover(&request, &|| Ok(()), &mut |cut| {
        if cut == "after_quarantine" {
            Err(error("injected_sync_failure"))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert!(failure.0.contains("quarantineState=quarantined"));
    assert!(fixture.quarantine().exists());
    assert!(!fixture.stage().exists());
    assert_eq!(run(&request).unwrap()["state"], "quarantined");
}
#[test]
fn recovery_requires_exact_action_confirmation_and_canonical_same_parent_stage() {
    for case in 0..6 {
        let fixture = Fixture::new();
        let mut request = fixture.selected();
        match case {
            0 => request.execute = false,
            1 => request.expected_plan_hash = None,
            2 => request.action = "delete".into(),
            3 => request.staging_root = fixture.0.join("runtime"),
            4 => request.staging_root = fixture.stage().join(".."),
            _ => request.version = 2,
        }
        assert!(run(&request).is_err());
        assert!(fixture.stage().exists());
    }
}
#[test]
fn empty_and_partial_stages_are_supported_but_oversized_files_are_not_read() {
    let fixture = Fixture::new();
    let path = fixture.stage().join("hepta-paper.sqlite");
    fs::remove_file(&path).unwrap();
    assert!(run(&fixture.inspect()).is_ok());
    fixture.write("hepta-paper.sqlite", b"partial");
    let file = fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_len(32 * 1024 * 1024 + 1).unwrap();
    assert!(run(&fixture.inspect()).is_err());
    assert!(!fixture.quarantine().exists());
}
#[test]
fn recovery_crash_child() {
    let Ok(root) = std::env::var("HEPTA_RECOVERY_TEST_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    assert!(root.starts_with(std::env::temp_dir()));
    let fixture = Fixture(root);
    let request = fixture.selected();
    let cut = std::env::var("HEPTA_RECOVERY_TEST_CUT").unwrap();
    let _ = recover(&request, &|| Ok(()), &mut |point| {
        if point == cut {
            nix::sys::signal::raise(nix::sys::signal::Signal::SIGKILL).unwrap();
        }
        Ok(())
    });
    panic!("crash cut did not execute");
}
#[test]
fn real_process_crash_on_every_quarantine_boundary_recovers_without_losing_bytes() {
    for cut in [
        "before_quarantine",
        "after_quarantine",
        "after_quarantine_sync",
    ] {
        let fixture = Fixture::new();
        let request = fixture.selected();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "autonomous_state_provision::recovery::tests::recovery_crash_child",
            ])
            .env("HEPTA_RECOVERY_TEST_ROOT", &fixture.0)
            .env("HEPTA_RECOVERY_TEST_CUT", cut)
            .output()
            .unwrap();
        assert!(!output.status.success());
        let result = run(&request).unwrap();
        assert_eq!(result["state"], "quarantined");
        assert_eq!(
            fs::read(fixture.quarantine().join("hepta-paper.sqlite")).unwrap(),
            b"partial constructor bytes; not an accepted database"
        );
        assert!(!request.runtime_root.exists());
        assert_eq!(run(&request).unwrap(), result);
    }
}
