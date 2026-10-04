//! Actual ordinary frontends, confined synthetic keys, and full refusal reports.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    frontend: PathBuf,
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
        for name in [
            "deployment/bin",
            "deployment/paper-core/bin",
            "deployment/paper-core/config",
            "runtime",
            "caller",
        ] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        fs::write(
            root.join("deployment/package.json"),
            br#"{"name":"hepta-paper-workspace"}"#,
        )
        .unwrap();
        let frontend = root.join("deployment/bin/hepta-paper-rust");
        fs::copy(env!("CARGO_BIN_EXE_hepta-paper-rust"), &frontend).unwrap();
        fs::set_permissions(&frontend, fs::Permissions::from_mode(0o555)).unwrap();
        Self { root, frontend }
    }
    fn command(&self) -> Command {
        let mut c = Command::new(&self.frontend);
        c.current_dir(self.root.join("caller"))
            .env_clear()
            .env("PATH", "/nonexistent")
            .env("HEPTA_PAPER_RUNTIME_ROOT", self.root.join("runtime"))
            .env("HEPTA_PAPER_ASSET_ROOT", self.root.join("assets"))
            .env("PAPER_FACTORY_LEGACY_ROOT", self.root.join("legacy"));
        c
    }
    fn request(&self, argv: &[&str], isolated: bool) -> Value {
        json!({"operation":"ordinary-cli", "runtimeRoot":self.root.join("runtime"),
            "assetRoot":self.root.join("assets"), "legacyRoot":self.root.join("legacy"),
            "workspaceRoot":self.root.join("deployment"), "isolated":isolated, "argv":argv})
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
        .write_all(&serde_json::to_vec(requests).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "ordinary Node fixture failed without reporting key contents"
    );
    let v: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&v["profile"]).unwrap();
    v["results"].as_array().unwrap().clone()
}
fn decoded(output: std::process::Output, help: bool) -> Value {
    let code = output.status.code().unwrap();
    if code == 1 {
        assert!(output.stdout.is_empty());
        return json!({"exitCode":1, "stdout":null, "error":String::from_utf8(output.stderr).unwrap().trim_end()});
    }
    if code == 2 && output.stdout.is_empty() {
        return json!({"exitCode":2, "stdout":null, "error":serde_json::from_slice::<Value>(&output.stderr).unwrap()});
    }
    assert!(output.stderr.is_empty());
    json!({"exitCode":code, "stdout":if help {Value::String(String::from_utf8(output.stdout).unwrap().trim_end().into())}
        else {serde_json::from_slice::<Value>(&output.stdout).unwrap()}, "error":null})
}
fn key_snapshot(path: &Path) -> Vec<Value> {
    let mut names = fs::read_dir(path)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect::<Vec<_>>();
    names.sort();
    names.iter().map(|p| {let m=fs::symlink_metadata(p).unwrap();
        json!({"name":p.file_name(), "dev":m.dev(), "ino":m.ino(), "mode":m.mode(),
            "nlink":m.nlink(), "size":m.len(), "mtime":m.mtime(),"mtimeNsec":m.mtime_nsec(),
            "ctime":m.ctime(),"ctimeNsec":m.ctime_nsec(), "hash":hex::encode(Sha256::digest(fs::read(p).unwrap()))})
    }).collect()
}
#[test]
fn copied_ordinary_key_frontend_matches_whole_node_arguments_defaults_and_isolation_refusals() {
    let fixture = Fixture::new();
    let suffixes = vec![
        vec![],
        vec!["--"],
        vec!["--", "--help"],
        vec!["--", "--action=status"],
        vec!["--", "--action", "status"],
        vec!["--", "--action=rotate"],
        vec!["--", "--execute"],
        vec!["--", "--action=provision"],
        vec!["--", "--help", "--unknown"],
        vec!["--", "--help", "--action=invalid"],
        vec!["--", "--unknown"],
        vec!["--", "--action"],
        vec!["--", "--action="],
        vec!["--", "--execute=true"],
        vec!["--", "--help=true"],
        vec!["--", "--action=status", "--action=status"],
        vec!["--", "--action=status", "--action="],
        vec!["--", "--"],
        vec!["--", "positional"],
        vec!["--help"],
        vec!["--", "--cpu-receipt", "missing"],
    ];
    let cases = suffixes
        .iter()
        .map(|s| [vec!["maintenance", "release-integrity-key"], s.clone()].concat())
        .collect::<Vec<_>>();
    let requests = cases
        .iter()
        .map(|argv| fixture.request(argv, false))
        .collect::<Vec<_>>();
    let expected = oracle(&requests);
    for (argv, expected) in cases.iter().zip(expected) {
        let actual = decoded(
            fixture.command().args(argv).output().unwrap(),
            argv.contains(&"--help"),
        );
        assert_eq!(actual, expected, "ordinary arguments {argv:?}");
        assert!(!fixture.root.join("runtime/release-signing").exists());
        assert!(
            fs::read_dir(fixture.root.join("runtime"))
                .unwrap()
                .next()
                .is_none()
        );
    }
    let argv = [
        "maintenance",
        "release-integrity-key",
        "--",
        "--action=provision",
        "--execute",
    ];
    let expected = oracle(&[fixture.request(&argv, true)]).remove(0);
    let actual = decoded(
        fixture
            .command()
            .args(argv)
            .env("HEPTA_PAPER_RUNTIME_ISOLATED", "1")
            .output()
            .unwrap(),
        false,
    );
    assert_eq!(actual, expected);
    assert!(
        fs::read_dir(fixture.root.join("runtime"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn ordinary_key_creation_is_create_once_and_unknown_pair_or_lock_is_never_repaired() {
    let fixture = Fixture::new();
    let argv = [
        "maintenance",
        "release-integrity-key",
        "--",
        "--action=provision",
        "--execute",
    ];
    let first = decoded(fixture.command().args(argv).output().unwrap(), false);
    assert_eq!(first["exitCode"], 0);
    assert_eq!(first["stdout"]["created"], true);
    assert_eq!(first["stdout"]["ready"], true);
    let key_root = fixture.root.join("runtime/release-signing");
    let retained = key_snapshot(&key_root);
    let retry = decoded(fixture.command().args(argv).output().unwrap(), false);
    assert_eq!(retry["stdout"]["created"], false);
    assert_eq!(key_snapshot(&key_root), retained);
    let status = [
        "maintenance",
        "release-integrity-key",
        "--",
        "--action=status",
    ];
    let actual = decoded(fixture.command().args(status).output().unwrap(), false);
    assert_eq!(actual, oracle(&[fixture.request(&status, false)]).remove(0));
    assert_eq!(actual["stdout"]["privateKeyRead"], true);
    assert!(!actual.to_string().contains("BEGIN PRIVATE KEY"));
    assert_eq!(key_snapshot(&key_root), retained);
    fs::write(key_root.join("unexpected"), b"retain unknown caller object").unwrap();
    let unknown = key_snapshot(&key_root);
    let refusal = decoded(fixture.command().args(argv).output().unwrap(), false);
    assert_eq!(refusal["exitCode"], 1);
    assert_eq!(refusal["error"], "release_integrity_key_pair_shape_invalid");
    assert_eq!(key_snapshot(&key_root), unknown);
}
