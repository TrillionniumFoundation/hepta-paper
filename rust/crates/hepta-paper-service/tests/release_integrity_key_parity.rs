//! All keys are synthetic and confined to private temporary roots. No private
//! material is returned by the oracle or included in assertion diagnostics.
use hepta_paper_service::release_integrity_key::{
    EventV1, ReleaseIntegrityKeyContextV1, ReleaseIntegrityKeyError,
    inspect_local_release_integrity_key_v1, inspect_local_release_integrity_key_with_hooks_v1,
    load_existing_local_release_integrity_key_v1, provision_local_release_integrity_key_v1,
    provision_local_release_integrity_key_with_hooks_v1, release_integrity_key_cli_v1,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
use zeroize::Zeroizing;
static NEXT: AtomicU64 = AtomicU64::new(0);
const PRIVATE: &str = "release-integrity-ed25519-private.pem";
const PUBLIC: &str = "release-integrity-ed25519-public.pem";
struct Fixture {
    root: PathBuf,
    context: ReleaseIntegrityKeyContextV1,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-release-key-rust-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = root.join("runtime");
        fs::create_dir(&runtime).unwrap();
        let mut context =
            ReleaseIntegrityKeyContextV1::from_environment(Some(&runtime), &BTreeMap::new())
                .unwrap();
        context.asset_root = root.join("assets");
        context.legacy_root = root.join("legacy");
        Self { root, context }
    }
    fn key_root(&self) -> PathBuf {
        self.context.runtime_root.join("release-signing")
    }
    fn request(&self, operation: &str) -> Value {
        json!({"operation":operation,"runtimeRoot":self.context.runtime_root,"assetRoot":self.context.asset_root,"legacyRoot":self.context.legacy_root})
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn oracle(requests: &[Value]) -> Vec<Value> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/release-integrity-key-v1.mjs"))
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(requests).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "Node oracle failed without exposing key material"
    );
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&response["profile"]).unwrap();
    response["results"].as_array().unwrap().clone()
}
fn node_fixture(fixture: &Fixture, mismatch: bool) {
    let mut request = fixture.request("fixture");
    request["mismatch"] = json!(mismatch);
    let output = oracle(&[request]);
    assert_eq!(output[0]["ok"], true, "test fixture generation failed");
}
fn safe_report(value: &Value) {
    let text = value.to_string();
    assert!(
        !text.contains("BEGIN PRIVATE KEY"),
        "private key material must not be reported"
    );
    assert!(
        !text.contains("privateKeyPem"),
        "private key fields must not be reported"
    );
}
fn compare_status(fixture: &Fixture) {
    let native = inspect_local_release_integrity_key_v1(&fixture.context).unwrap();
    let expected = oracle(&[fixture.request("status")]);
    safe_report(&native);
    assert_eq!(native, expected[0]["value"]);
}
fn leftovers(fixture: &Fixture) -> Vec<String> {
    let mut values = fs::read_dir(&fixture.root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|value| {
            value.contains("staging") || value.contains("lock") || value.contains("quarantine")
        })
        .collect::<Vec<_>>();
    values.sort();
    values
}
fn pair_fingerprint(fixture: &Fixture) -> Vec<(u64, u64, u64, u32, String)> {
    [PRIVATE, PUBLIC]
        .iter()
        .map(|name| {
            let path = fixture.key_root().join(name);
            let metadata = fs::symlink_metadata(&path).unwrap();
            let bytes = Zeroizing::new(fs::read(path).unwrap());
            (
                metadata.dev(),
                metadata.ino(),
                metadata.len(),
                metadata.mode() & 0o7777,
                hex::encode(Sha256::digest(&bytes)),
            )
        })
        .collect()
}

#[test]
fn status_and_cli_arguments_are_readonly_and_match_node() {
    let fixture = Fixture::new();
    compare_status(&fixture);
    assert!(!fixture.key_root().exists());
    let env = BTreeMap::from([
        (
            "HEPTA_PAPER_RUNTIME_ROOT".into(),
            fixture.context.runtime_root.to_string_lossy().into_owned(),
        ),
        (
            "HEPTA_PAPER_ASSET_ROOT".into(),
            fixture.context.asset_root.to_string_lossy().into_owned(),
        ),
        (
            "PAPER_FACTORY_LEGACY_ROOT".into(),
            fixture.context.legacy_root.to_string_lossy().into_owned(),
        ),
    ]);
    let cases = vec![
        vec![],
        vec!["--help"],
        vec!["--action=status"],
        vec!["--action=provision"],
        vec!["--action=status", "--execute"],
        vec!["--action=rotate"],
        vec!["--unknown"],
        vec!["--action"],
        vec!["--action="],
        vec!["--"],
        vec!["positional"],
        vec!["--execute=true"],
        vec!["--action=status", "--action=status"],
        vec!["--help", "--unknown"],
        vec!["--help", "--action=invalid"],
    ];
    for case in cases {
        let argv = case.iter().map(|v| v.to_string()).collect::<Vec<_>>();
        let mut request = fixture.request("cli");
        request["argv"] = json!(argv);
        let expected = oracle(&[request]);
        let result = release_integrity_key_cli_v1(&argv, &env);
        let actual = match result {
            Ok(output) => {
                json!({"ok":true,"value":output.text.map_or(output.value,Value::String),"exitCode":output.exit_code})
            }
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        };
        assert_eq!(actual, expected[0]);
    }
    assert!(!fixture.key_root().exists());
}

#[test]
fn native_provision_and_node_provision_interoperate_without_rotation() {
    let fixture = Fixture::new();
    let first = provision_local_release_integrity_key_v1(&fixture.context, true).unwrap();
    safe_report(&first);
    assert_eq!(first["created"], true);
    assert_eq!(first["ready"], true);
    compare_status(&fixture);
    assert_eq!(
        fs::metadata(fixture.key_root()).unwrap().mode() & 0o7777,
        0o700
    );
    let before = pair_fingerprint(&fixture);
    assert_eq!(before[0].3, 0o600);
    assert_eq!(before[1].3, 0o444);
    let native = provision_local_release_integrity_key_v1(&fixture.context, true).unwrap();
    let mut request = fixture.request("provision");
    request["execute"] = json!(true);
    let expected = oracle(&[request]);
    assert_eq!(native, expected[0]["value"]);
    assert_eq!(
        pair_fingerprint(&fixture),
        before,
        "replay changed existing key identities"
    );
    assert!(leftovers(&fixture).is_empty());
    let other = Fixture::new();
    let mut request = other.request("provision");
    request["execute"] = json!(true);
    assert_eq!(oracle(&[request])[0]["value"]["created"], true);
    compare_status(&other);
    assert_eq!(
        provision_local_release_integrity_key_v1(&other.context, true).unwrap()["created"],
        false
    );
}

#[test]
fn invalid_existing_pairs_and_unsafe_paths_remain_unchanged() {
    for scenario in [
        "partial",
        "mismatch",
        "extra",
        "root-mode",
        "private-mode",
        "public-mode",
        "hardlink",
        "root-symlink",
        "file-symlink",
        "empty-file",
        "oversized-file",
        "fifo",
        "runtime-symlink",
    ] {
        let fixture = Fixture::new();
        node_fixture(&fixture, scenario == "mismatch");
        let private = fixture.key_root().join(PRIVATE);
        let public = fixture.key_root().join(PUBLIC);
        match scenario {
            "partial" => fs::remove_file(&public).unwrap(),
            "extra" => fs::write(fixture.key_root().join("unexpected"), b"marker").unwrap(),
            "root-mode" => {
                fs::set_permissions(fixture.key_root(), fs::Permissions::from_mode(0o755)).unwrap()
            }
            "private-mode" => {
                fs::set_permissions(&private, fs::Permissions::from_mode(0o644)).unwrap()
            }
            "public-mode" => {
                fs::set_permissions(&public, fs::Permissions::from_mode(0o600)).unwrap()
            }
            "hardlink" => fs::hard_link(&public, fixture.root.join("alias")).unwrap(),
            "root-symlink" => {
                let held = fixture.root.join("held-keys");
                fs::rename(fixture.key_root(), &held).unwrap();
                symlink(held, fixture.key_root()).unwrap();
            }
            "empty-file" => fs::write(&private, b"").unwrap(),
            "oversized-file" => fs::write(&private, vec![b'x'; 16 * 1024 + 1]).unwrap(),
            "fifo" => {
                fs::remove_file(&private).unwrap();
                nix::unistd::mkfifo(
                    &private,
                    nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
                )
                .unwrap();
            }
            "runtime-symlink" => {
                let held = fixture.root.join("held-runtime");
                fs::rename(&fixture.context.runtime_root, &held).unwrap();
                symlink(held, &fixture.context.runtime_root).unwrap();
            }
            "file-symlink" => {
                let held = fixture.root.join("held-public");
                fs::rename(&public, &held).unwrap();
                symlink(held, &public).unwrap();
            }
            _ => {}
        }
        compare_status(&fixture);
        let before = fs::symlink_metadata(fixture.key_root()).unwrap();
        assert!(
            provision_local_release_integrity_key_v1(&fixture.context, true).is_err(),
            "invalid {scenario} was accepted"
        );
        let after = fs::symlink_metadata(fixture.key_root()).unwrap();
        assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
        assert!(leftovers(&fixture).is_empty());
    }
}

#[test]
fn isolation_decoupling_and_explicit_execution_prevent_key_access() {
    let fixture = Fixture::new();
    assert!(provision_local_release_integrity_key_v1(&fixture.context, false).is_err());
    let mut isolated = fixture.context.clone();
    isolated.isolated = true;
    assert!(inspect_local_release_integrity_key_v1(&isolated).is_err());
    assert!(provision_local_release_integrity_key_v1(&isolated, true).is_err());
    assert!(!fixture.key_root().exists());
    node_fixture(&fixture, false);
    assert!(load_existing_local_release_integrity_key_v1(&isolated, true).is_err());
    let public = load_existing_local_release_integrity_key_v1(&isolated, false).unwrap();
    assert!(public.private_key_pem().is_none());
    let mut overlapping = fixture.context.clone();
    overlapping.asset_root = fixture.root.clone();
    let err = inspect_local_release_integrity_key_v1(&overlapping).unwrap_err();
    assert!(
        err.to_string()
            .contains("workspace_layout_paths_overlap:assetRoot:runtimeRoot")
    );
    let alias = fixture.root.join("asset-alias");
    symlink(&fixture.context.runtime_root, &alias).unwrap();
    overlapping.asset_root = alias;
    assert!(inspect_local_release_integrity_key_v1(&overlapping).is_err());
}

#[test]
fn read_races_bind_directory_and_file_identities_without_deleting_concurrent_bytes() {
    for directory in [false, true] {
        let fixture = Fixture::new();
        node_fixture(&fixture, false);
        let mut injected = false;
        let mut hook = |event: EventV1, path: &Path| -> Result<(), ReleaseIntegrityKeyError> {
            if !injected
                && ((directory && event == EventV1::AfterReadDirectory)
                    || (!directory
                        && event == EventV1::AfterReadFile
                        && path.file_name().is_some_and(|v| v == PRIVATE)))
            {
                injected = true;
                if directory {
                    fs::rename(path, fixture.root.join("held-keys")).unwrap();
                    fs::create_dir(path).unwrap();
                    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
                } else {
                    fs::rename(path, fixture.root.join("held-private")).unwrap();
                    fs::write(path, b"concurrent bytes").unwrap();
                    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
                }
            }
            Ok(())
        };
        let report =
            inspect_local_release_integrity_key_with_hooks_v1(&fixture.context, &mut hook).unwrap();
        assert_eq!(report["ready"], false);
        assert!(
            fixture
                .root
                .join(if directory {
                    "held-keys"
                } else {
                    "held-private"
                })
                .exists()
        );
        safe_report(&report);
    }
}

#[test]
fn publication_failures_roll_back_only_owned_files_and_never_overwrite() {
    for scenario in [
        "staged-write",
        "root-replaced",
        "empty-rival",
        "public-rival",
        "after-public",
    ] {
        let fixture = Fixture::new();
        let mut injected = false;
        let mut hook = |event: EventV1, path: &Path| -> Result<(), ReleaseIntegrityKeyError> {
            if injected {
                return Ok(());
            }
            let trigger = match scenario {
                "staged-write" => {
                    event == EventV1::BeforeWriteFile
                        && path.file_name().is_some_and(|v| v == PUBLIC)
                }
                "root-replaced" | "empty-rival" => event == EventV1::BeforePublish,
                "public-rival" => {
                    event == EventV1::BeforeLink && path.file_name().is_some_and(|v| v == PUBLIC)
                }
                _ => event == EventV1::AfterPublicLink,
            };
            if !trigger {
                return Ok(());
            }
            injected = true;
            match scenario {
                "root-replaced" => {
                    fs::rename(
                        &fixture.context.runtime_root,
                        fixture.root.join("runtime-held"),
                    )
                    .unwrap();
                    fs::create_dir(&fixture.context.runtime_root).unwrap();
                }
                "empty-rival" => {
                    fs::create_dir(fixture.key_root()).unwrap();
                    fs::set_permissions(fixture.key_root(), fs::Permissions::from_mode(0o700))
                        .unwrap();
                }
                "public-rival" => {
                    fs::write(path, b"concurrent public marker").unwrap();
                    fs::set_permissions(path, fs::Permissions::from_mode(0o444)).unwrap();
                }
                "after-public" => {
                    return Err(ReleaseIntegrityKeyError("injected_after_public".into()));
                }
                _ => return Err(ReleaseIntegrityKeyError("injected_staged_write".into())),
            }
            Ok(())
        };
        let failure =
            provision_local_release_integrity_key_with_hooks_v1(&fixture.context, true, &mut hook)
                .unwrap_err();
        if ["staged-write", "root-replaced", "empty-rival"].contains(&scenario) {
            let node_fixture = Fixture::new();
            let mut request = node_fixture.request("fault");
            request["scenario"] = json!(scenario);
            let expected = oracle(&[request]);
            assert_eq!(expected[0]["ok"], false);
            assert_eq!(failure.to_string(), expected[0]["error"].as_str().unwrap());
        }
        assert!(!fixture.key_root().join(PRIVATE).exists());
        if scenario == "public-rival" {
            assert_eq!(
                fs::read(fixture.key_root().join(PUBLIC)).unwrap(),
                b"concurrent public marker"
            );
        } else if scenario == "empty-rival" {
            assert!(fixture.key_root().is_dir());
        } else {
            assert!(!fixture.key_root().exists());
        }
        assert!(
            leftovers(&fixture).is_empty(),
            "unowned staging leaked for {scenario}"
        );
    }
}

#[test]
fn independent_locks_serialize_same_root_and_allow_other_roots() {
    let fixture = Fixture::new();
    let other = Fixture::new();
    let mut held = false;
    let mut hook = |event: EventV1, _path: &Path| -> Result<(), ReleaseIntegrityKeyError> {
        if event == EventV1::BeforePublish && !held {
            held = true;
            assert_eq!(
                provision_local_release_integrity_key_v1(&fixture.context, true)
                    .unwrap_err()
                    .to_string(),
                "release_integrity_key_provision_locked"
            );
            assert_eq!(
                provision_local_release_integrity_key_v1(&other.context, true).unwrap()["created"],
                true
            );
        }
        Ok(())
    };
    assert_eq!(
        provision_local_release_integrity_key_with_hooks_v1(&fixture.context, true, &mut hook)
            .unwrap()["created"],
        true
    );
    assert!(leftovers(&fixture).is_empty());
    assert!(leftovers(&other).is_empty());
}

#[test]
fn crash_worker() {
    let Ok(runtime) = std::env::var("HEPTA_RELEASE_KEY_TEST_CRASH_ROOT") else {
        return;
    };
    assert!(runtime.starts_with("/tmp/hepta-release-key-rust-"));
    let event = std::env::var("HEPTA_RELEASE_KEY_TEST_CRASH_EVENT").unwrap();
    let mut context =
        ReleaseIntegrityKeyContextV1::from_environment(Some(Path::new(&runtime)), &BTreeMap::new())
            .unwrap();
    context.asset_root = Path::new(&runtime).parent().unwrap().join("assets");
    context.legacy_root = Path::new(&runtime).parent().unwrap().join("legacy");
    let mut hook = |phase: EventV1, _path: &Path| -> Result<(), ReleaseIntegrityKeyError> {
        if event == "hold" && phase == EventV1::BeforePublish {
            println!("\nheld");
            std::io::stdout().flush().unwrap();
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).unwrap();
            assert_eq!(line.trim_end(), "resume");
        }
        if (event == "public" && phase == EventV1::AfterPublicLink)
            || (event == "private" && phase == EventV1::AfterPrivateLink)
        {
            std::process::exit(73);
        }
        Ok(())
    };
    let result = provision_local_release_integrity_key_with_hooks_v1(&context, true, &mut hook);
    if event == "hold" {
        assert_eq!(result.unwrap()["ready"], true);
        return;
    }
    panic!("crash hook did not fire");
}
#[test]
fn abrupt_crash_leaves_partial_or_multilink_pair_blocked_and_lock_intact() {
    for event in ["public", "private"] {
        let fixture = Fixture::new();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "crash_worker"])
            .env(
                "HEPTA_RELEASE_KEY_TEST_CRASH_ROOT",
                &fixture.context.runtime_root,
            )
            .env("HEPTA_RELEASE_KEY_TEST_CRASH_EVENT", event)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(73));
        assert_eq!(
            inspect_local_release_integrity_key_v1(&fixture.context).unwrap()["ready"],
            false
        );
        assert_eq!(
            provision_local_release_integrity_key_v1(&fixture.context, true)
                .unwrap_err()
                .to_string(),
            "release_integrity_key_provision_locked"
        );
        assert!(fixture.key_root().join(PUBLIC).exists());
        assert_eq!(
            fixture.key_root().join(PRIVATE).exists(),
            event == "private"
        );
        compare_status(&fixture);
    }
}

#[test]
fn public_and_private_loading_and_non_ed25519_pairs_match_node() {
    for algorithm in ["ed25519", "rsa", "ec"] {
        let fixture = Fixture::new();
        let mut request = fixture.request("fixture");
        request["algorithm"] = json!(algorithm);
        assert!(oracle(&[request])[0]["ok"].as_bool().unwrap());
        compare_status(&fixture);
        for include_private in [false, true] {
            let mut request = fixture.request("load");
            request["includePrivate"] = json!(include_private);
            let expected = oracle(&[request]);
            let actual = match load_existing_local_release_integrity_key_v1(
                &fixture.context,
                include_private,
            ) {
                Ok(loaded) => {
                    json!({"ok":true,"value":{"publicPath":loaded.public_path,"publicKeyFingerprint":loaded.public_key_fingerprint,"privateRetained":loaded.private_key_pem().is_some()}})
                }
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            };
            safe_report(&actual);
            assert_eq!(
                actual, expected[0],
                "algorithm={algorithm}, private={include_private}"
            );
        }
    }
}

#[test]
fn valid_directory_substitution_is_rejected_by_status_and_public_loader() {
    for public_only in [false, true] {
        let fixture = Fixture::new();
        let replacement = Fixture::new();
        node_fixture(&fixture, false);
        node_fixture(&replacement, false);
        let mut injected = false;
        let mut hook = |event: EventV1, path: &Path| -> Result<(), ReleaseIntegrityKeyError> {
            if !injected && event == EventV1::AfterReadDirectory {
                injected = true;
                fs::rename(path, fixture.root.join("held-original")).unwrap();
                fs::rename(replacement.key_root(), path).unwrap();
            }
            Ok(())
        };
        let failure = if public_only {
            match hepta_paper_service::release_integrity_key::load_existing_local_release_integrity_key_with_hooks_v1(&fixture.context,false,&mut hook) {
                Ok(_) => panic!("substituted directory was accepted"),
                Err(error) => error.to_string(),
            }
        } else {
            let report =
                inspect_local_release_integrity_key_with_hooks_v1(&fixture.context, &mut hook)
                    .unwrap();
            assert_eq!(report["ready"], false);
            report["blockers"][0].as_str().unwrap().to_owned()
        };
        assert_eq!(failure, "release_integrity_directory_chain_changed");
        assert!(fixture.root.join("held-original").join(PRIVATE).exists());
        assert!(fixture.key_root().join(PRIVATE).exists());
    }
}

#[test]
fn staging_and_cleanup_substitutions_preserve_concurrent_objects() {
    for scenario in ["staging-open", "empty-cleanup", "file-cleanup"] {
        let fixture = Fixture::new();
        let concurrent = fixture.root.join("concurrent");
        if scenario == "file-cleanup" {
            fs::write(&concurrent, b"preserve concurrent file").unwrap();
        } else {
            fs::create_dir(&concurrent).unwrap();
            fs::set_permissions(&concurrent, fs::Permissions::from_mode(0o755)).unwrap();
        }
        if scenario == "empty-cleanup" {
            fs::write(concurrent.join("marker"), b"preserve concurrent directory").unwrap();
        }
        let mut injected = false;
        let mut substituted = None;
        let mut hook = |event: EventV1, path: &Path| -> Result<(), ReleaseIntegrityKeyError> {
            if scenario == "empty-cleanup" && event == EventV1::BeforeLink {
                return Err(ReleaseIntegrityKeyError("injected_publish_failure".into()));
            }
            if scenario == "file-cleanup" && event == EventV1::AfterWriteFile {
                return Err(ReleaseIntegrityKeyError("injected_write_failure".into()));
            }
            let selected = match scenario {
                "staging-open" => event == EventV1::BeforeStagingOpen,
                "empty-cleanup" => {
                    event == EventV1::BeforeCleanupDirectoryRename && path == fixture.key_root()
                }
                _ => {
                    event == EventV1::BeforeCleanupFileRename
                        && path.file_name().is_some_and(|v| v == PRIVATE)
                }
            };
            if !injected && selected {
                injected = true;
                fs::rename(path, fixture.root.join("held-owned")).unwrap();
                fs::rename(&concurrent, path).unwrap();
                substituted = Some(path.to_owned());
            }
            Ok(())
        };
        let error =
            provision_local_release_integrity_key_with_hooks_v1(&fixture.context, true, &mut hook)
                .unwrap_err();
        let node_fixture = Fixture::new();
        let mut request = node_fixture.request("fault");
        request["scenario"] = json!(scenario);
        let expected = oracle(&[request]);
        assert_eq!(expected[0]["ok"], false);
        assert_eq!(error.to_string(), expected[0]["error"].as_str().unwrap());
        assert!(injected, "injection did not execute for {scenario}");
        assert!(!fixture.key_root().join(PRIVATE).exists());
        assert!(fixture.root.join("held-owned").exists());
        match scenario {
            "staging-open" => {
                assert!(error.to_string().contains("staging_root_unsafe"));
                assert_eq!(
                    fs::metadata(substituted.unwrap()).unwrap().mode() & 0o7777,
                    0o755
                );
            }
            "empty-cleanup" => {
                assert!(error.to_string().contains("rollback_incomplete"));
                let quarantine = fs::read_dir(&fixture.context.runtime_root)
                    .unwrap()
                    .map(|v| v.unwrap().path())
                    .find(|v| v.to_string_lossy().ends_with(".quarantine"))
                    .unwrap();
                assert_eq!(
                    fs::read(quarantine.join("marker")).unwrap(),
                    b"preserve concurrent directory"
                );
            }
            _ => {
                assert!(error.to_string().contains("rollback_incomplete"));
                let quarantined = fs::read_dir(&fixture.root)
                    .unwrap()
                    .map(|v| v.unwrap().path())
                    .find(|v| v.is_dir() && v.to_string_lossy().ends_with(".quarantine"))
                    .unwrap();
                assert_eq!(
                    fs::read(quarantined.join(PRIVATE)).unwrap(),
                    b"preserve concurrent file"
                );
            }
        }
    }
}

#[test]
fn shipped_binary_matches_readonly_cli_and_provisions_without_node_runtime() {
    let fixture = Fixture::new();
    let binary = env!("CARGO_BIN_EXE_hepta-release-integrity-key");
    for argv in [
        vec![],
        vec!["--help"],
        vec!["--action=status"],
        vec!["--execute"],
        vec!["--action=rotate"],
        vec!["--execute=true"],
    ] {
        let output = Command::new(binary)
            .args(&argv)
            .env("PATH", "/nonexistent")
            .env("HEPTA_PAPER_RUNTIME_ROOT", &fixture.context.runtime_root)
            .env("HEPTA_PAPER_ASSET_ROOT", &fixture.context.asset_root)
            .env("PAPER_FACTORY_LEGACY_ROOT", &fixture.context.legacy_root)
            .env_remove("HEPTA_PAPER_RUNTIME_ISOLATED")
            .output()
            .unwrap();
        let mut request = fixture.request("cli");
        request["argv"] = json!(argv);
        let expected = oracle(&[request]);
        if expected[0]["ok"] == true {
            assert_eq!(
                output.status.code(),
                expected[0]["exitCode"].as_i64().map(|v| v as i32)
            );
            assert!(output.stderr.is_empty());
            if argv.contains(&"--help") {
                assert_eq!(
                    String::from_utf8(output.stdout).unwrap().trim_end(),
                    expected[0]["value"].as_str().unwrap()
                );
            } else {
                assert_eq!(
                    serde_json::from_slice::<Value>(&output.stdout).unwrap(),
                    expected[0]["value"]
                );
            }
        } else {
            assert_eq!(output.status.code(), Some(1));
            assert!(output.stdout.is_empty());
            assert_eq!(
                String::from_utf8(output.stderr).unwrap().trim_end(),
                expected[0]["error"].as_str().unwrap()
            );
        }
    }
    let output = Command::new(binary)
        .args(["--action=provision", "--execute"])
        .env("PATH", "/nonexistent")
        .env("HEPTA_PAPER_RUNTIME_ROOT", &fixture.context.runtime_root)
        .env("HEPTA_PAPER_ASSET_ROOT", &fixture.context.asset_root)
        .env("PAPER_FACTORY_LEGACY_ROOT", &fixture.context.legacy_root)
        .env_remove("HEPTA_PAPER_RUNTIME_ISOLATED")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "native provisioning CLI failed without printing private material"
    );
    assert!(output.stderr.is_empty());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    safe_report(&report);
    assert_eq!(report["created"], true);
    compare_status(&fixture);
}

#[test]
fn concurrent_processes_respect_the_same_lock_without_blocking_other_roots() {
    let fixture = Fixture::new();
    let other = Fixture::new();
    let mut worker = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "crash_worker", "--nocapture"])
        .env(
            "HEPTA_RELEASE_KEY_TEST_CRASH_ROOT",
            &fixture.context.runtime_root,
        )
        .env("HEPTA_RELEASE_KEY_TEST_CRASH_EVENT", "hold")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = worker.stdout.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    let reading = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line.unwrap().trim() == "held" {
                sender.send(()).unwrap();
            }
        }
    });
    if receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .is_err()
    {
        let _ = worker.kill();
        panic!("provision worker did not acquire its lock");
    }
    let command = |fixture: &Fixture| {
        Command::new(env!("CARGO_BIN_EXE_hepta-release-integrity-key"))
            .args(["--action=provision", "--execute"])
            .env("PATH", "/nonexistent")
            .env("HEPTA_PAPER_RUNTIME_ROOT", &fixture.context.runtime_root)
            .env("HEPTA_PAPER_ASSET_ROOT", &fixture.context.asset_root)
            .env("PAPER_FACTORY_LEGACY_ROOT", &fixture.context.legacy_root)
            .env_remove("HEPTA_PAPER_RUNTIME_ISOLATED")
            .output()
            .unwrap()
    };
    let blocked = command(&fixture);
    assert_eq!(blocked.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(blocked.stderr).unwrap().trim_end(),
        "release_integrity_key_provision_locked"
    );
    let mut request = fixture.request("provision");
    request["execute"] = json!(true);
    assert_eq!(
        oracle(&[request])[0]["error"],
        "release_integrity_key_provision_locked"
    );
    assert!(command(&other).status.success());
    worker.stdin.take().unwrap().write_all(b"resume\n").unwrap();
    assert!(worker.wait().unwrap().success());
    reading.join().unwrap();
    compare_status(&fixture);
    assert!(leftovers(&fixture).is_empty());
    assert!(leftovers(&other).is_empty());
}

#[test]
fn malformed_pem_fails_closed_with_explicit_native_encoding_diagnostics() {
    for private in [false, true] {
        let fixture = Fixture::new();
        node_fixture(&fixture, false);
        let path = fixture
            .key_root()
            .join(if private { PRIVATE } else { PUBLIC });
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(&path, b"malformed synthetic fixture").unwrap();
        fs::set_permissions(
            &path,
            fs::Permissions::from_mode(if private { 0o600 } else { 0o444 }),
        )
        .unwrap();
        let before = fs::symlink_metadata(&path).unwrap();
        let report = inspect_local_release_integrity_key_v1(&fixture.context).unwrap();
        let expected = oracle(&[fixture.request("status")]);
        assert_eq!(report["ready"], false);
        assert_eq!(expected[0]["value"]["ready"], false);
        assert_eq!(
            report["blockers"][0],
            if private {
                "release_integrity_private_key_encoding_invalid"
            } else {
                "release_integrity_public_key_encoding_invalid"
            }
        );
        assert_ne!(
            report["blockers"], expected[0]["value"]["blockers"],
            "native diagnostics must not pretend to reproduce OpenSSL error strings"
        );
        assert!(provision_local_release_integrity_key_v1(&fixture.context, true).is_err());
        let after = fs::symlink_metadata(&path).unwrap();
        assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
        assert_eq!(fs::read(path).unwrap(), b"malformed synthetic fixture");
        safe_report(&report);
    }
}

#[test]
fn final_pair_snapshot_rejects_private_mutation_while_public_is_read() {
    use hepta_paper_service::release_integrity_key::load_existing_local_release_integrity_key_with_hooks_v1;
    for operation in ["status", "private-load", "public-load"] {
        for mutation in ["replace", "permissions", "hardlink", "extra-entry"] {
            let fixture = Fixture::new();
            node_fixture(&fixture, false);
            let private = fixture.key_root().join(PRIVATE);
            let mut changed = false;
            let mut hook = |event: EventV1, path: &Path| -> Result<(), ReleaseIntegrityKeyError> {
                if !changed
                    && event == EventV1::BeforeReadFile
                    && path.file_name().is_some_and(|name| name == PUBLIC)
                {
                    changed = true;
                    match mutation {
                        "replace" => {
                            let replacement = fixture.root.join("replacement");
                            fs::write(&replacement, b"synthetic unrelated private marker").unwrap();
                            fs::set_permissions(&replacement, fs::Permissions::from_mode(0o600))
                                .unwrap();
                            fs::rename(&replacement, &private).unwrap();
                        }
                        "permissions" => {
                            fs::set_permissions(&private, fs::Permissions::from_mode(0o644))
                                .unwrap()
                        }
                        "hardlink" => {
                            fs::hard_link(&private, fixture.root.join("retained-hardlink")).unwrap()
                        }
                        _ => fs::write(fixture.key_root().join("unexpected"), b"marker").unwrap(),
                    }
                }
                Ok(())
            };
            let error = if operation == "status" {
                let report =
                    inspect_local_release_integrity_key_with_hooks_v1(&fixture.context, &mut hook)
                        .unwrap();
                assert_eq!(
                    report["ready"], false,
                    "pair mutation must not produce a ready status"
                );
                safe_report(&report);
                report["blockers"][0].as_str().unwrap().to_owned()
            } else {
                match load_existing_local_release_integrity_key_with_hooks_v1(
                    &fixture.context,
                    operation == "private-load",
                    &mut hook,
                ) {
                    Ok(_) => panic!("changed pair must not be loaded"),
                    Err(error) => error.to_string(),
                }
            };
            assert!(changed);
            // The incumbent does not recheck the first file after reading the
            // second. Preserve this observed safety difference explicitly.
            let incumbent = Fixture::new();
            node_fixture(&incumbent, false);
            let mut request = incumbent.request("pair-window");
            request["mutation"] = json!(mutation);
            request["selectedOperation"] = json!(operation);
            let expected = oracle(&[request]);
            assert_eq!(expected[0]["ok"], true);
            if operation == "status" {
                assert_eq!(expected[0]["value"]["ready"], true);
            }
            safe_report(&expected[0]);
            assert_eq!(
                error,
                if mutation == "extra-entry" {
                    "release_integrity_key_pair_shape_invalid"
                } else {
                    "release_integrity_key_file_changed_during_read"
                },
                "{operation}/{mutation}"
            );
            if mutation == "replace" {
                assert_eq!(
                    fs::read(&private).unwrap(),
                    b"synthetic unrelated private marker"
                );
            }
        }
    }
}
