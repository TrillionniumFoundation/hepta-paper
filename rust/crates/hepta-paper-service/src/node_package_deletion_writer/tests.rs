use super::*;
use serde_json::json;
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::fs::{PermissionsExt, symlink},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
const OP: &str = "store:automation-reconcile-entrypoint";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-node-deletion-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&path).unwrap();
        Self(fs::canonicalize(path).unwrap())
    }
    fn record_path(&self) -> PathBuf {
        fs::read_dir(self.0.join(ROOT))
            .unwrap()
            .map(|p| p.unwrap().path())
            .find(|p| p.extension().is_some_and(|s| s == "json"))
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
const NODE: &str = r#"
import fs from 'node:fs';
import path from 'node:path';
import {createRuntimeRetentionPackageDeletionFenceRepository as create} from './paper-adapters/automation/runtime-retention-package-deletion-fence-repository.mjs';
import {hashRecord} from './workflow-kernel/record-hash.mjs';
const root=process.argv[1], action=process.argv[2], operationId=process.argv[3];
const repo=create({runtimeRoot:root});
const h=label=>hashRecord('PackageDeletionRustParity',{label});
try {
  if(action==='inspect') {
    repo.withWriterGuard({operationId},()=>{});
  } else if(action==='hold') {
    repo.withWriterGuard({operationId},()=>{
      process.stdout.write('ready\n');
      fs.readSync(0,Buffer.alloc(1),0,1,null);
    });
  } else {
    let value=repo.prepare({runtimeRoot:root,packageLifecycleReceiptHash:h('lifecycle'),
      packagePath:path.join(root,'packages','example'),packageContentHash:h('content'),
      deletionIntentHash:h('intent'),recoveryBindingHash:h('recovery'),authoritySnapshotHash:h('authority'),
      operationId,generation:1,transitionId:h('prepared'),preparedAt:'2026-08-20T08:00:00.000Z',
      fenceToken:'rust-node-package-fence-token-00000000000000000001'});
    for(const status of action==='deleted'?['deleting','deleted']:action==='prepared'?[]:[action]) {
      value=repo.transition(value.handle,{expectedRecordHash:value.record.runtimeRetentionPackageDeletionFenceHash,
        status,transitionedAt:status==='deleted'?'2026-08-20T08:02:00.000Z':'2026-08-20T08:01:00.000Z',
        transitionId:h(status),...(status==='aborted'?{abortReasonHash:h('reason')}:{})});
    }
  }
  process.stdout.write('ok\n');
} catch(e) { process.stdout.write(e.message+'\n'); process.exitCode=1; }
"#;
fn node_command(f: &Fixture, action: &str) -> Command {
    let mut command = Command::new("node");
    command
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .args(["--input-type=module", "-e", NODE])
        .arg(&f.0)
        .args([action, OP]);
    command
}
fn node(f: &Fixture, action: &str, success: bool) -> String {
    let output = node_command(f, action).output().unwrap();
    assert_eq!(
        output.status.success(),
        success,
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
fn error(f: &Fixture) -> String {
    match PackageDeletionWriterGuard::acquire(&f.0, OP) {
        Ok(_) => panic!("expected guard rejection"),
        Err(e) => e.to_string(),
    }
}
#[test]
fn node_package_guard_shares_actual_flock_both_directions() {
    let f = Fixture::new();
    let guard = PackageDeletionWriterGuard::acquire(&f.0, OP).unwrap();
    assert!(node(&f, "inspect", false).contains("lock_unavailable"));
    guard.assert_current().unwrap();
    drop(guard);
    node(&f, "inspect", true);
    let mut child = node_command(&f, "hold")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    assert_eq!(line, "ready\n");
    assert!(error(&f).contains("lock_unavailable"));
    child.stdin.take().unwrap().write_all(b"x").unwrap();
    assert!(child.wait().unwrap().success());
    PackageDeletionWriterGuard::acquire(&f.0, OP)
        .unwrap()
        .assert_current()
        .unwrap();
}
#[test]
fn node_package_guard_matches_prepared_deleting_deleted_aborted() {
    for status in ["prepared", "deleting", "deleted", "aborted"] {
        let f = Fixture::new();
        node(&f, status, true);
        if status == "aborted" {
            PackageDeletionWriterGuard::acquire(&f.0, OP).unwrap();
            node(&f, "inspect", true);
        } else {
            let code = if status == "deleted" {
                "package_deleted"
            } else {
                "reachability_mutation_blocked"
            };
            assert!(error(&f).contains(code));
            assert!(node(&f, "inspect", false).contains(code));
        }
        // Active fences block every writer, not only a matching operation.
        let other = PackageDeletionWriterGuard::acquire(&f.0, "unrelated-writer");
        assert_eq!(other.is_ok(), matches!(status, "aborted" | "deleted"));
    }
}
#[test]
fn node_package_guard_rejects_replaced_lock_repository_and_runtime() {
    for target in ["lock", "repository", "runtime"] {
        let f = Fixture::new();
        let guard = PackageDeletionWriterGuard::acquire(&f.0, OP).unwrap();
        let path = match target {
            "lock" => f.0.join(ROOT).join(LOCK),
            "repository" => f.0.join(ROOT),
            _ => f.0.clone(),
        };
        let moved = path.with_extension("displaced");
        fs::rename(&path, &moved).unwrap();
        if target == "lock" {
            File::create(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        } else {
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert!(guard.assert_current().is_err());
        drop(guard);
        if target == "lock" {
            fs::remove_file(path).unwrap();
            fs::remove_file(moved).unwrap();
        } else {
            fs::remove_dir_all(path).unwrap();
            fs::remove_dir_all(moved).unwrap();
        }
    }
}
#[test]
fn node_package_guard_rejects_inventory_modes_symlinks_hardlinks_and_changed_hash() {
    for kind in [
        "unknown",
        "directory",
        "symlink",
        "hardlink",
        "mode",
        "hash",
        "oversize",
    ] {
        let f = Fixture::new();
        node(&f, "aborted", true);
        let path = f.record_path();
        match kind {
            "unknown" => {
                File::create(f.0.join(ROOT).join("unexpected")).unwrap();
            }
            "directory" => {
                fs::remove_file(&path).unwrap();
                fs::create_dir(&path).unwrap();
            }
            "symlink" => {
                let moved = f.0.join("record");
                fs::rename(&path, &moved).unwrap();
                symlink(moved, &path).unwrap();
            }
            "hardlink" => {
                fs::hard_link(&path, f.0.join("record")).unwrap();
            }
            "mode" => fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap(),
            "hash" => {
                let mut v: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                v["operationId"] = json!("changed");
                fs::write(&path, serde_json::to_vec(&v).unwrap()).unwrap();
            }
            _ => {
                OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .unwrap()
                    .set_len(MAX_RECORD + 1)
                    .unwrap();
            }
        }
        assert!(
            error(&f).contains(if kind == "unknown" {
                "inventory_invalid"
            } else {
                "record_invalid"
            }),
            "{kind}"
        );
    }
}
#[test]
fn node_package_guard_cleans_only_safe_temporary_inodes_and_releases_on_unwind() {
    let f = Fixture::new();
    drop(PackageDeletionWriterGuard::acquire(&f.0, OP).unwrap());
    let path = f.0.join(ROOT).join(".fence-tmp-123-test");
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    drop(PackageDeletionWriterGuard::acquire(&f.0, OP).unwrap());
    assert!(!path.exists());
    symlink(f.0.join("not-removed"), &path).unwrap();
    assert!(error(&f).contains("temporary_invalid"));
    fs::remove_file(&path).unwrap();
    let _ = std::panic::catch_unwind(|| {
        let _guard = PackageDeletionWriterGuard::acquire(&f.0, OP).unwrap();
        panic!("exercise release");
    });
    node(&f, "inspect", true);
}
#[test]
fn node_package_guard_validates_exact_record_contract_after_resealing() {
    let f = Fixture::new();
    node(&f, "aborted", true);
    let path = f.record_path();
    let original: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for (key, bad) in [
        ("extra", json!(true)),
        ("preparedAt", json!("2026-02-30T00:00:00.000Z")),
        ("generation", json!(0)),
        ("revision", json!(1.5)),
        ("abortReasonHash", Value::Null),
        ("runtimeRoot", json!("/other")),
        (
            "packagePath",
            json!(format!("{}/packages/./example", f.0.display())),
        ),
        ("deletedAt", json!("2026-08-20T08:02:00.000Z")),
        ("updatedAt", json!("2026-08-20T07:00:00.000Z")),
    ] {
        let mut value = original.clone();
        value[key] = bad;
        value
            .as_object_mut()
            .unwrap()
            .remove("runtimeRetentionPackageDeletionFenceHash");
        let hash =
            production_hash_record_v1("RuntimeRetentionPackageDeletionFence", &value).unwrap();
        value["runtimeRetentionPackageDeletionFenceHash"] = json!(hash.as_str());
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(error(&f).contains("record_invalid"), "{key}");
        assert!(
            node(&f, "inspect", false).contains("record_invalid"),
            "{key}"
        );
    }
}

#[test]
fn node_package_guard_preserves_incumbent_operation_coercion_and_extended_dates() {
    let f = Fixture::new();
    node(&f, "aborted", true);
    let path = f.record_path();
    let original: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for operation in [json!(42), json!(true), json!(["operation"])] {
        let mut value = original.clone();
        value["operationId"] = operation;
        value["preparedAt"] = json!("+010000-01-01T00:00:00.000Z");
        value["abortedAt"] = json!("+010000-01-01T00:01:00.000Z");
        value["updatedAt"] = value["abortedAt"].clone();
        value
            .as_object_mut()
            .unwrap()
            .remove("runtimeRetentionPackageDeletionFenceHash");
        let hash =
            production_hash_record_v1("RuntimeRetentionPackageDeletionFence", &value).unwrap();
        value["runtimeRetentionPackageDeletionFenceHash"] = json!(hash.as_str());
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        drop(PackageDeletionWriterGuard::acquire(&f.0, OP).unwrap());
        node(&f, "inspect", true);
    }
}

#[test]
fn node_package_guard_rejects_unsafe_roots_and_lock_files_before_callback() {
    for kind in [
        "repository-mode",
        "lock-mode",
        "lock-content",
        "lock-hardlink",
        "lock-symlink",
    ] {
        let f = Fixture::new();
        drop(PackageDeletionWriterGuard::acquire(&f.0, OP).unwrap());
        let lock = f.0.join(ROOT).join(LOCK);
        match kind {
            "repository-mode" => {
                fs::set_permissions(f.0.join(ROOT), fs::Permissions::from_mode(0o755)).unwrap()
            }
            "lock-mode" => fs::set_permissions(&lock, fs::Permissions::from_mode(0o644)).unwrap(),
            "lock-content" => fs::write(&lock, b"not empty").unwrap(),
            "lock-hardlink" => fs::hard_link(&lock, f.0.join("lock-alias")).unwrap(),
            _ => {
                fs::remove_file(&lock).unwrap();
                symlink(f.0.join("lock-target"), &lock).unwrap();
            }
        }
        assert!(
            error(&f).contains(if kind == "repository-mode" {
                "root_invalid"
            } else {
                "lock_invalid"
            }),
            "{kind}"
        );
        assert!(
            node(&f, "inspect", false).contains(if kind == "repository-mode" {
                "root_invalid"
            } else {
                "lock_invalid"
            }),
            "{kind}"
        );
    }
    let f = Fixture::new();
    let alias = f.0.join("runtime-alias");
    symlink(&f.0, &alias).unwrap();
    assert!(PackageDeletionWriterGuard::acquire(&alias, OP).is_err());
    assert!(!f.0.join(ROOT).exists());
}
