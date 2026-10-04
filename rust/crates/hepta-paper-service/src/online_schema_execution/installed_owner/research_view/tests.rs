use super::*;
use crate::online_schema_transition::history::checkpoint::tests::{Fixture, NoRpc};
use nix::unistd::chown;
use std::{os::unix::fs::PermissionsExt, process::Command};
const SELECTOR: &str = "online_schema_execution::installed_owner::research_view::tests::actual_nonroot_checkpoint_reader_gets_only_signed_readonly_graph";
fn ownership(path: &Path, uid: u32, gid: u32) {
    let metadata = fs::symlink_metadata(path).unwrap();
    assert!(!metadata.is_symlink());
    if metadata.is_dir() {
        for entry in fs::read_dir(path).unwrap() {
            ownership(&entry.unwrap().path(), uid, gid);
        }
    }
    chown(path, Some(Uid::from_raw(uid)), Some(Gid::from_raw(gid))).unwrap();
}
fn child(value: &Value, executable: &Path, descriptor: &Path, mode: &str) {
    let output = Command::new("/usr/bin/setpriv")
        .args(["--reuid=65534", "--regid=65534", "--clear-groups"])
        .arg(executable)
        .args([
            "--exact",
            SELECTOR,
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("HEPTA_READONLY_FIXTURE", descriptor)
        .env("HEPTA_READONLY_EXPECT", mode)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "mode={mode}, checkpoint={}, status={}:\n{}\n{}",
        value["checkpointRoot"],
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("test result: ok. 1 passed; 0 failed; 0 ignored;")
    );
}
fn read_child(descriptor: &Path) {
    assert_eq!(nix::unistd::getuid().as_raw(), 65534);
    assert_eq!(nix::unistd::geteuid().as_raw(), 65534);
    assert!(
        descriptor.starts_with("/tmp")
            && descriptor
                .parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("hepta-native-schema-checkpoint-")
    );
    let value: Value = serde_json::from_slice(&fs::read(descriptor).unwrap()).unwrap();
    let runtime = Path::new(value["runtimeRoot"].as_str().unwrap());
    let inventory = match crate::state_database_inventory::observe_state_database_inventory_v1(
        runtime,
        &value["stateDatabaseManifest"],
    ) {
        Ok(inventory) => inventory,
        Err(cause) => {
            assert_eq!(
                std::env::var("HEPTA_READONLY_EXPECT").unwrap(),
                "refuse",
                "nonroot inventory: {cause}"
            );
            return;
        }
    };
    let authority = PinnedMutationAuthorityV1::load(
        Path::new(value["configurationPath"].as_str().unwrap()),
        value["configurationFileHash"].as_str().unwrap(),
        NoRpc,
    )
    .unwrap();
    let checkpoint = Path::new(value["checkpointRoot"].as_str().unwrap());
    let loaded = load_schema_transition_checkpoint_v1(
        checkpoint,
        &inventory,
        &value["writerManifest"],
        &authority,
    );
    if std::env::var("HEPTA_READONLY_EXPECT").unwrap() == "pass" {
        let proof = loaded.unwrap();
        assert_eq!(proof.historical_inventory(), &value["originalInventory"]);
        proof.assert_current(&inventory, &authority).unwrap();
        assert!(
            fs::OpenOptions::new()
                .write(true)
                .open(runtime.join("autonomous-research/online-schema-transition/FINAL.json"))
                .is_err()
        );
        assert!(
            fs::OpenOptions::new()
                .write(true)
                .open(checkpoint.join("POST_INVENTORY.json"))
                .is_err()
        );
        assert!(
            fs::OpenOptions::new()
                .write(true)
                .open(checkpoint.join("databases/000.sqlite"))
                .is_err()
        );
        assert!(
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(checkpoint.join("databases/new-result.sqlite"))
                .is_err()
        );
        assert!(
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(
                    runtime.join("autonomous-research/online-schema-transition/new-kernel-result")
                )
                .is_err()
        );
    } else {
        assert!(loaded.is_err());
    }
    for name in ["privateIntent", "privateKey", "privatePreimage"] {
        assert!(fs::read(Path::new(value[name].as_str().unwrap())).is_err());
    }
}
#[test]
#[ignore = "requires sudo root, qualified Node22, and an actual isolated UID65534 reader"]
fn actual_nonroot_checkpoint_reader_gets_only_signed_readonly_graph() {
    if let Some(path) = std::env::var_os("HEPTA_READONLY_FIXTURE") {
        read_child(Path::new(&path));
        return;
    }
    if nix::unistd::getuid().as_raw() != 0 {
        let node = std::env::var_os("HEPTA_TEST_NODE").expect("qualified Node22 path required");
        let output = Command::new("sudo")
            .args(["-n", "env"])
            .arg(format!("HEPTA_TEST_NODE={}", node.to_string_lossy()))
            .arg(std::env::current_exe().unwrap())
            .args([
                "--exact",
                SELECTOR,
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .contains("test result: ok. 1 passed; 0 failed; 0 ignored;")
        );
        return;
    }
    let f = Fixture::with_uid65534_source_owner();
    let control = f
        .runtime()
        .join("autonomous-research/online-schema-transition");
    ownership(&control, 0, 0);
    mode_group(&File::open(&f.root).unwrap(), 65534, 0o750).unwrap();
    for path in [
        Path::new(f.value["configurationPath"].as_str().unwrap()),
        &f.root.join("public.json"),
    ] {
        mode_group(&File::open(path).unwrap(), 65534, 0o440).unwrap();
    }
    let executable = f.root.join("reader-test");
    fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    let operation = SchemaOperationIdentityV1 {
        runtime_root: f.runtime().to_owned(),
        transition_id: text(&f.value["audit"], "transitionId").unwrap().into(),
        plan_hash: text(&f.value["audit"], "planHash").unwrap().into(),
        profile_sha256: hash_bytes(b"isolated-readonly-view-profile"),
        barrier_root: f.root.join("private-installation"),
    };
    let private =
        Directory::open_or_create(&operation.barrier_root.join("execution"), true).unwrap();
    private
        .write_new(
            "private-key",
            b"test-only private material; never delivered",
        )
        .unwrap();
    private
        .write_new("preimage", b"private original; never delivered")
        .unwrap();
    let final_pin = hash_bytes(&fs::read(control.join("FINAL.json")).unwrap());
    let checkpoint = f
        .runtime()
        .join("online-schema-checkpoints")
        .join(operation.transition_id.strip_prefix("sha256:").unwrap());
    let mut descriptor = f.value.clone();
    descriptor["checkpointRoot"] = json!(checkpoint);
    descriptor["privateIntent"] = json!(private.path.join(INTENT));
    descriptor["privateKey"] = json!(private.path.join("private-key"));
    descriptor["privatePreimage"] = json!(private.path.join("preimage"));
    let descriptor_path = f.root.join("reader-input.json");
    fs::write(&descriptor_path, serde_json::to_vec(&descriptor).unwrap()).unwrap();
    mode_group(&File::open(&descriptor_path).unwrap(), 65534, 0o440).unwrap();
    child(&descriptor, &executable, &descriptor_path, "refuse");
    let reader = Reader {
        uid: 65534,
        gid: 65534,
        groups: vec![],
    };
    let inventory = f.inventory();
    let authority = f.authority();
    let interrupted = publish_inner(
        &operation,
        &reader,
        &inventory,
        &f.value["writerManifest"],
        &authority,
        &final_pin,
        &mut |point| {
            if point == "after_checkpoint_intent" {
                Err(error("test_readonly_delivery_crash"))
            } else {
                Ok(())
            }
        },
    );
    assert_eq!(
        interrupted.unwrap_err().code,
        "test_readonly_delivery_crash"
    );
    assert!(private.path.join(INTENT).is_file());
    let view = publish_inner(
        &operation,
        &reader,
        &inventory,
        &f.value["writerManifest"],
        &authority,
        &final_pin,
        &mut |_| Ok(()),
    )
    .unwrap();
    assert_eq!(view["checkpointRoot"], json!(checkpoint));
    assert_eq!(view["activationAuthority"], false);
    child(&descriptor, &executable, &descriptor_path, "pass");
    let original_report = fs::read(checkpoint.join("POST_INVENTORY.json")).unwrap();
    let original_main = fs::read(checkpoint.join("databases/000.sqlite")).unwrap();
    // Existing signed original images are idempotent, including after later
    // business state. Such later state still needs the separate history bridge.
    let row = inventory.value()["instances"][0].clone();
    let database = rusqlite::Connection::open(
        f.runtime()
            .join(row["sourceRelativePath"].as_str().unwrap()),
    )
    .unwrap();
    database
        .execute(
            "UPDATE fixture_anchor SET value='later-business-result' WHERE id='fixture'",
            [],
        )
        .unwrap();
    drop(database);
    let later = f.inventory();
    assert_ne!(
        later.value()["inventoryHash"],
        inventory.value()["inventoryHash"]
    );
    publish_inner(
        &operation,
        &reader,
        &later,
        &f.value["writerManifest"],
        &authority,
        &final_pin,
        &mut |_| Ok(()),
    )
    .unwrap();
    assert_eq!(
        fs::read(checkpoint.join("POST_INVENTORY.json")).unwrap(),
        original_report
    );
    assert_eq!(
        fs::read(checkpoint.join("databases/000.sqlite")).unwrap(),
        original_main
    );
    child(&descriptor, &executable, &descriptor_path, "pass");
    fs::write(
        checkpoint.join("databases/000.sqlite"),
        b"tampered historical copy",
    )
    .unwrap();
    child(&descriptor, &executable, &descriptor_path, "refuse");
    assert!(
        publish_inner(
            &operation,
            &reader,
            &later,
            &f.value["writerManifest"],
            &authority,
            &final_pin,
            &mut |_| Ok(())
        )
        .is_err()
    );
    fs::write(checkpoint.join("databases/000.sqlite"), &original_main).unwrap();
    let retained = checkpoint.with_file_name("retained-original-checkpoint");
    fs::rename(&checkpoint, &retained).unwrap();
    assert_eq!(
        publish_inner(
            &operation,
            &reader,
            &later,
            &f.value["writerManifest"],
            &authority,
            &final_pin,
            &mut |_| Ok(())
        )
        .unwrap_err()
        .code,
        "autonomous_research_installed_schema_checkpoint_original_state_advanced"
    );
    assert_eq!(
        fs::read(retained.join("POST_INVENTORY.json")).unwrap(),
        original_report
    );
    assert_eq!(
        fs::read(retained.join("databases/000.sqlite")).unwrap(),
        original_main
    );
    assert!(private.path.join(INTENT).is_file());
}

#[test]
#[ignore = "requires root solely for private root-owned intent reader fault fixtures"]
fn actual_private_intent_reader_refuses_substitution_symlink_and_unbounded_bytes() {
    const SELECTOR: &str = "online_schema_execution::installed_owner::research_view::tests::actual_private_intent_reader_refuses_substitution_symlink_and_unbounded_bytes";
    if nix::unistd::getuid().as_raw() != 0 {
        let output = Command::new("sudo")
            .arg("-n")
            .arg(std::env::current_exe().unwrap())
            .args([
                "--exact",
                SELECTOR,
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .contains("test result: ok. 1 passed; 0 failed; 0 ignored;")
        );
        return;
    }
    struct Private(PathBuf);
    impl Drop for Private {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let root = Private(std::env::temp_dir().join(format!(
        "hepta-installed-research-intent-{}-{}",
        std::process::id(),
        random_name().unwrap()
    )));
    fs::create_dir(&root.0).unwrap();
    fs::set_permissions(&root.0, fs::Permissions::from_mode(0o700)).unwrap();
    let directory = Directory::open_or_create(&root.0, false).unwrap();
    let value = json!({"version":1,"privateFixture":"bounded-intent"});
    let path = directory.path.join(INTENT);
    let create = || {
        publish_receipt(&directory, INTENT, &value, None).unwrap();
    };
    let remove = || {
        fs::remove_file(&path).unwrap();
    };
    create();
    assert_eq!(read_private_intent(&directory).unwrap(), value);
    remove();

    let other = root.0.join("other-private-file");
    fs::write(&other, b"different private fixture bytes").unwrap();
    fs::set_permissions(&other, fs::Permissions::from_mode(0o600)).unwrap();
    std::os::unix::fs::symlink(&other, &path).unwrap();
    assert!(read_private_intent(&directory).is_err());
    assert_eq!(
        fs::read(&other).unwrap(),
        b"different private fixture bytes"
    );
    remove();

    create();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(MAXIMUM + 1)
        .unwrap();
    assert!(read_private_intent(&directory).is_err());
    assert_eq!(fs::metadata(&path).unwrap().len(), MAXIMUM + 1);
    remove();

    create();
    let displaced = root.0.join("retained-original-intent");
    assert!(
        read_private_intent_inner(&directory, &mut |_| {
            fs::rename(&path, &displaced).unwrap();
            create();
            Ok(())
        })
        .is_err(),
        "same JSON at a new inode substituted the original held intent"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&displaced).unwrap()).unwrap(),
        value
    );
    remove();

    create();
    assert!(
        read_private_intent_inner(&directory, &mut |_| {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_len(MAXIMUM + 1)
                .unwrap();
            Ok(())
        })
        .is_err(),
        "growth after metadata observation exceeded the hard byte bound"
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), MAXIMUM + 1);
    remove();

    create();
    assert!(
        read_private_intent_inner(&directory, &mut |_| {
            fs::rename(&path, root.0.join("retained-before-symlink")).unwrap();
            std::os::unix::fs::symlink(&other, &path).unwrap();
            Ok(())
        })
        .is_err(),
        "post-observation symlink bypassed the held inode check"
    );
    remove();

    create();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    assert!(read_private_intent(&directory).is_err());
    remove();

    create();
    let alias = root.0.join("hardlink-alias");
    fs::hard_link(&path, &alias).unwrap();
    assert!(read_private_intent(&directory).is_err());
    remove();
    fs::remove_file(alias).unwrap();

    create();
    chown(
        &path,
        Some(Uid::from_raw(65534)),
        Some(Gid::from_raw(65534)),
    )
    .unwrap();
    assert!(read_private_intent(&directory).is_err());
    remove();

    nix::unistd::mkfifo(&path, Mode::from_bits_truncate(0o600)).unwrap();
    assert!(read_private_intent(&directory).is_err());
    remove();
    directory.assert_current().unwrap();
}
