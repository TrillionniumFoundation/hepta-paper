use super::*;
use std::{os::unix::fs::PermissionsExt, process::Command};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let root =
            std::env::temp_dir().join(format!("hepta-provision-publish-{}", hex::encode(random)));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn target(&self) -> Target {
        Target::open(&self.0.join("runtime")).unwrap()
    }
    fn stages(&self) -> Vec<PathBuf> {
        fs::read_dir(&self.0)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".runtime.provisioning-")
            })
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
// This layer tests publication with bounded bytes; SQL semantics are tested by
// autonomous_state_provision_execution against actual Node constructors.
fn images() -> Vec<Image> {
    (0..10)
        .map(|i| Image {
            role: format!("test-role-{i}"),
            relative: format!("data/{i}.sqlite"),
            bytes: format!("owned-test-bytes-{i}").into_bytes(),
            schema_hash: "test-layer-only".into(),
        })
        .collect()
}
fn prepared() -> Value {
    let mut value = json!({"testOnly":true,"ready":false,
        "freshRuntimeInstalled":false,"publicationState":"prepared"});
    value["provisioningReceiptHash"] = json!(
        input_hash(
            "AutonomousResearchStateBusinessSchemaProvisioningReceipt",
            &value
        )
        .unwrap()
    );
    value
}
#[test]
fn published_receipt_is_issued_only_after_observed_installation() {
    let fixture = Fixture::new();
    let target = fixture.target();
    let original = prepared();
    let terminal = publish(&target, &images(), &original, &|| Ok(())).unwrap();
    let stored: Value = serde_json::from_slice(
        &fs::read(target.path.join("native-provisioning-publication.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(terminal, stored);
    assert_eq!(terminal["publicationState"], "published");
    assert_eq!(terminal["freshRuntimeInstalled"], true);
    assert_eq!(
        terminal["preparedReceiptHash"],
        original["provisioningReceiptHash"]
    );
    let retained: Value = serde_json::from_slice(
        &fs::read(target.path.join("native-provisioning-receipt.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(retained, original);
    assert_eq!(retained["freshRuntimeInstalled"], false);
}
#[test]
fn failure_before_terminal_receipt_preserves_published_not_success_claim() {
    let fixture = Fixture::new();
    let target = fixture.target();
    let error = publish_with_hook(&target, &images(), &prepared(), &|| Ok(()), &mut |cut| {
        if cut == "before_terminal_receipt" {
            Err(error("terminal_write_injected"))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert!(error.0.contains("publicationState=published"));
    assert!(
        !target
            .path
            .join("native-provisioning-publication.json")
            .exists()
    );
    let retained: Value = serde_json::from_slice(
        &fs::read(target.path.join("native-provisioning-receipt.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(retained["freshRuntimeInstalled"], false);
    assert_eq!(retained["publicationState"], "prepared");
    assert_eq!(
        fs::read(target.path.join("data/9.sqlite")).unwrap(),
        b"owned-test-bytes-9"
    );
}
#[test]
fn final_revalidation_failure_retains_private_stage_without_runtime() {
    let fixture = Fixture::new();
    let target = fixture.target();
    let failure = publish(&target, &images(), &prepared(), &|| {
        Err(error("source_revoked"))
    })
    .unwrap_err();
    assert!(failure.0.contains("publicationState=not_published"));
    assert!(!target.path.exists());
    assert_eq!(fixture.stages().len(), 1);
    assert!(
        Target::open(&target.path)
            .err()
            .unwrap()
            .0
            .contains("retained_staging_requires_inspection")
    );
}
#[test]
fn target_appearing_at_rename_is_never_clobbered() {
    let fixture = Fixture::new();
    let target = fixture.target();
    let failure = publish_with_hook(&target, &images(), &prepared(), &|| Ok(()), &mut |cut| {
        if cut == "before_publish" {
            fs::create_dir(&target.path)?;
            fs::write(target.path.join("keep"), b"newer committed state")?;
        }
        Ok(())
    })
    .unwrap_err();
    assert!(failure.0.contains("target_appeared"));
    assert_eq!(
        fs::read(target.path.join("keep")).unwrap(),
        b"newer committed state"
    );
    assert_eq!(fixture.stages().len(), 1);
}
#[test]
fn after_rename_failure_reports_published_and_preserves_all_bytes() {
    let fixture = Fixture::new();
    let target = fixture.target();
    let failure = publish_with_hook(&target, &images(), &prepared(), &|| Ok(()), &mut |cut| {
        if cut == "after_publish" {
            Err(error("injected_directory_sync_failure"))
        } else {
            Ok(())
        }
    })
    .unwrap_err();
    assert!(failure.0.contains("publicationState=published"));
    assert!(target.path.is_dir());
    assert!(fixture.stages().is_empty());
    assert_eq!(
        fs::read(target.path.join("data/9.sqlite")).unwrap(),
        b"owned-test-bytes-9"
    );
    assert!(Target::open(&target.path).is_err());
}
#[test]
fn unexpected_staged_content_is_rejected_before_rename() {
    let fixture = Fixture::new();
    let target = fixture.target();
    let failure = publish_with_hook(&target, &images(), &prepared(), &|| Ok(()), &mut |cut| {
        if cut == "before_publish" {
            fs::write(fixture.stages()[0].join("unregistered"), b"unexpected")?;
        }
        Ok(())
    })
    .unwrap_err();
    assert!(failure.0.contains("unexpected_staged_path"));
    assert!(!target.path.exists());
}
#[test]
fn publication_crash_child() {
    let Ok(root) = std::env::var("HEPTA_PROVISION_TEST_CRASH_ROOT") else {
        return;
    };
    let cut = std::env::var("HEPTA_PROVISION_TEST_CUT").unwrap();
    let root = PathBuf::from(root);
    assert!(root.starts_with(std::env::temp_dir()));
    let target = Target::open(&root.join("runtime")).unwrap();
    let _ = publish_with_hook(&target, &images(), &prepared(), &|| Ok(()), &mut |point| {
        if point == cut {
            nix::sys::signal::raise(nix::sys::signal::Signal::SIGKILL).unwrap();
        }
        Ok(())
    });
    panic!("expected process death");
}
#[test]
fn process_death_on_either_side_of_rename_preserves_recoverable_evidence() {
    for cut in ["before_publish", "after_publish", "before_terminal_receipt"] {
        let fixture = Fixture::new();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "autonomous_state_provision::publication::tests::publication_crash_child",
            ])
            .env("HEPTA_PROVISION_TEST_CRASH_ROOT", &fixture.0)
            .env("HEPTA_PROVISION_TEST_CUT", cut)
            .output()
            .unwrap();
        assert!(!output.status.success());
        let path = if cut == "before_publish" {
            assert!(!fixture.0.join("runtime").exists());
            fixture.stages().pop().unwrap()
        } else {
            assert!(fixture.stages().is_empty());
            fixture.0.join("runtime")
        };
        assert!(path.join("native-provisioning-receipt.json").is_file());
        assert_eq!(
            fs::read(path.join("data/9.sqlite")).unwrap(),
            b"owned-test-bytes-9"
        );
        assert!(Target::open(&fixture.0.join("runtime")).is_err());
    }
}
