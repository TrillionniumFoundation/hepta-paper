//! Complete original Node reports for passive synthetic V3 authority fixtures.
use hepta_paper_service::external_authority_intake::inspect_external_authority_intake_with_environment_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    frontend: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-passive-kms-v3-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let workspace = root.join("deployment");
        for p in [
            "deployment/bin",
            "deployment/paper-core/bin",
            "deployment/paper-core/config",
            "caller",
        ] {
            fs::create_dir_all(root.join(p)).unwrap();
        }
        fs::write(
            workspace.join("package.json"),
            br#"{"name":"hepta-paper-workspace"}"#,
        )
        .unwrap();
        let frontend = workspace.join("bin/hepta-paper-rust");
        fs::copy(env!("CARGO_BIN_EXE_hepta-paper-rust"), &frontend).unwrap();
        fs::set_permissions(&frontend, fs::Permissions::from_mode(0o555)).unwrap();
        Self {
            root,
            workspace,
            frontend,
        }
    }
    fn ordinary(&self) -> Command {
        let mut c = Command::new(&self.frontend);
        c.current_dir(self.root.join("caller"))
            .env_clear()
            .env("PATH", "/nonexistent")
            .env("TMPDIR", &self.root);
        c.args(["operator", "external-authority-intake", "--"]);
        c
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn oracle(v: &Value) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let node = std::env::var_os("HEPTA_TEST_NODE").unwrap_or_else(|| "node".into());
    let mut p = Command::new(node)
        .arg(root.join("rust/oracle/release-attestor-intake-v3.mjs"))
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    p.stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(v).unwrap())
        .unwrap();
    let out = p.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let out: Value = serde_json::from_slice(&out.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&out["profile"]).unwrap();
    out
}
fn snapshot(root: &Path) -> BTreeMap<String, Value> {
    fn walk(root: &Path, p: &Path, out: &mut BTreeMap<String, Value>) {
        let m = fs::symlink_metadata(p).unwrap();
        let kind = if m.is_file() {
            "file"
        } else if m.is_dir() {
            "directory"
        } else {
            "symlink"
        };
        let mut v = json!({"kind":kind,"dev":m.dev(),"ino":m.ino(),"mode":m.mode(),"uid":m.uid(),"gid":m.gid(),"nlink":m.nlink(),
            "bytes":m.len(),"mtime":m.mtime(),"mtimeNs":m.mtime_nsec(),"ctime":m.ctime(),"ctimeNs":m.ctime_nsec()});
        if m.is_file() {
            let mut f = fs::File::open(p).unwrap();
            let mut digest = Sha256::new();
            let mut b = [0; 64 * 1024];
            loop {
                let n = f.read(&mut b).unwrap();
                if n == 0 {
                    break;
                }
                digest.update(&b[..n]);
            }
            v["sha256"] = json!(hex::encode(digest.finalize()));
        }
        if m.file_type().is_symlink() {
            v["target"] = json!(fs::read_link(p).unwrap().to_str().unwrap());
        }
        out.insert(
            p.strip_prefix(root).unwrap().to_string_lossy().into_owned(),
            v,
        );
        if m.is_dir() {
            for p in fs::read_dir(p).unwrap() {
                walk(root, &p.unwrap().path(), out);
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}
fn environment(v: &Value) -> BTreeMap<String, String> {
    v.as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
        .collect()
}
fn inspect(
    case: &Value,
    now: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Value, hepta_paper_service::external_authority_intake::ExternalAuthorityIntakeError> {
    inspect_external_authority_intake_with_environment_v1(
        case["authorPath"].as_str().map(Path::new),
        case["authorHash"].as_str(),
        case["releasePath"].as_str().map(Path::new),
        case["releaseHash"].as_str(),
        now,
        &environment(&case["environment"]),
        (cancelled, deadline),
    )
}
#[test]
fn passive_v3_configuration_signatures_windows_independence_and_namespace_match_complete_node_reports()
 {
    let f = Fixture::new();
    let now = "2026-07-15T12:00:00.000Z";
    let modes = [
        "valid-pinned",
        "no-pin",
        "pin-mismatch",
        "uppercase-pin",
        "joint-ready",
        "bad-signature",
        "binding-mismatch",
        "expired-hardware",
        "future-hardware",
        "non-independent-authority",
        "authority-key-expired",
        "authority-key-not-effective",
        "authority-key-revoked",
        "key-expired",
        "key-not-effective",
        "active-revoked",
        "probe-revoked",
        "probe-same-subject",
        "probe-same-organization",
        "probe-same-key",
        "same-credential-root",
        "same-executable",
        "credential-public",
        "executable-writable",
        "executable-hardlink",
        "invalid-public-key",
        "public-key-private",
        "invalid-timeout",
        "invalid-protocol",
        "command-args",
        "command-environment",
        "extra-config-field",
        "private-key-disclosure",
        "wrong-backend",
        "trust-pin-mismatch",
        "challenge-pin-mismatch",
        "signer-pin-mismatch",
        "reordered-bundle",
        "reordered-subject",
        "reordered-trust",
        "missing-bundle",
        "symlink-bundle",
        "config-public",
        "config-symlink",
    ];
    let oracle = oracle(&json!({"root":f.root,"modes":modes.as_slice(),"now":now}));
    let cases = oracle["results"].as_array().unwrap();
    assert_eq!(cases.len(), modes.len());
    let before = snapshot(&f.root);
    let c = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(120);
    for case in cases {
        let native = inspect(case, now, &c, deadline).unwrap();
        assert_eq!(native, case["report"], "{}", case["mode"]);
        assert_eq!(native["externalActionPerformed"], false);
        assert_eq!(native["serviceStateChanged"], false);
        assert_eq!(native["fullProductionReady"], false);
    }
    assert_eq!(snapshot(&f.root), before);
    let ready = cases.iter().find(|v| v["mode"] == "joint-ready").unwrap();
    assert_eq!(ready["report"]["ready"], true);
    assert_eq!(
        ready["report"]["releaseAttestor"]["liveProbeRequired"],
        true
    );
}
#[test]
fn ordinary_v3_joint_readiness_uses_deployment_paths_original_environment_and_no_process() {
    let f = Fixture::new();
    let out = f.ordinary().output().unwrap();
    assert!(out.status.success());
    let empty: Value = serde_json::from_slice(&out.stdout).unwrap();
    let prepared =
        oracle(&json!({"root":f.root,"modes":["joint-ready"],"now":empty["observedAt"]}));
    let case = &prepared["results"][0];
    let before = snapshot(&f.root);
    let out = f
        .ordinary()
        .args([
            "--require-ready",
            "--author-config",
            case["authorPath"].as_str().unwrap(),
            "--author-config-hash",
            case["authorHash"].as_str().unwrap(),
            "--release-attestor-config",
            case["releasePath"].as_str().unwrap(),
            "--release-attestor-config-hash",
            case["releaseHash"].as_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.stderr.is_empty());
    let native: Value = serde_json::from_slice(&out.stdout).unwrap();
    let expected = oracle(
        &json!({"operation":"inspect","root":f.root,"modes":[],"now":native["observedAt"],"case":case}),
    );
    assert_eq!(native, expected["report"]);
    assert_eq!(native["readyForLiveVerification"], true);
    assert_eq!(native["fullProductionReady"], false);
    assert_eq!(snapshot(&f.root), before);
    assert_eq!(fs::read_dir(f.root.join("caller")).unwrap().count(), 0);
    assert!(f.workspace.join("bin/hepta-paper-rust").is_file());
}
#[test]
fn v3_original_cancellation_expiry_and_fresh_passive_retry_never_change_inputs() {
    let f = Fixture::new();
    let now = "2026-07-15T12:00:00.000Z";
    let prepared = oracle(&json!({"root":f.root,"modes":["joint-ready"],"now":now}));
    let case = &prepared["results"][0];
    let before = snapshot(&f.root);
    let c = AtomicBool::new(true);
    assert_eq!(
        inspect(case, now, &c, Instant::now() + Duration::from_secs(120))
            .unwrap_err()
            .to_string(),
        "external_authority_intake_cancelled"
    );
    c.store(false, Ordering::Release);
    assert_eq!(
        inspect(case, now, &c, Instant::now() - Duration::from_millis(1))
            .unwrap_err()
            .to_string(),
        "external_authority_intake_expired"
    );
    assert_eq!(snapshot(&f.root), before);
    assert_eq!(
        inspect(case, now, &c, Instant::now() + Duration::from_secs(120)).unwrap(),
        case["report"]
    );
    assert_eq!(snapshot(&f.root), before);
}
