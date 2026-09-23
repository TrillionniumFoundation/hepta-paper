use super::*;
use hepta_legacy_compatibility::production_hash_record_v1;
use std::{
    io::Write,
    os::unix::fs::{PermissionsExt, symlink},
};

const OBSERVED_AT: &str = "2026-09-20T00:00:00.000Z";
struct Fixture {
    root: PathBuf,
    path: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    fn new(body: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-package-recovery-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("helper");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o555)).unwrap();
        let public = root.join("capabilities-public");
        fs::create_dir(&public).unwrap();
        fs::set_permissions(&public, fs::Permissions::from_mode(0o700)).unwrap();
        for name in ["OWNER_TRUST_STORE.json", "CAPABILITY_OWNER_ACCEPTANCE.json"] {
            fs::write(public.join(name), "{}").unwrap();
            fs::set_permissions(public.join(name), fs::Permissions::from_mode(0o600)).unwrap();
        }
        let config = root.join("paper-core/config");
        fs::create_dir_all(&config).unwrap();
        fs::write(
            config.join("offhost-worm-contract.v1.json"),
            r#"{"version":1,"kind":"OffhostWormSnapshotContract","contractId":"test"}"#,
        )
        .unwrap();
        Self { root, path }
    }
    fn pin(&self) -> Result<PinnedCommand, String> {
        open_pinned_command(
            &self.path,
            &digest(&fs::read(&self.path).unwrap()),
            fs::metadata(&self.root).unwrap().uid(),
            &self.root,
        )
    }
    fn query(&self, environment: &Value, timeout: Duration) -> Result<Value, String> {
        query_pinned_command(
            &self.pin()?,
            &self.root,
            &self.root,
            &self.root,
            environment,
            timeout,
            || Ok(OBSERVED_AT.to_owned()),
        )
    }
    fn oracle(&self, environment: &Value, timeout: Duration) -> Value {
        oracle(
            json!({"root":self.root, "command":self.path, "commandHash":digest(&fs::read(&self.path).unwrap()), "ownerHash":digest(b"{}"), "timeoutMs":timeout.as_millis(), "environment":environment, "observedAt":OBSERVED_AT}),
        )
    }
}
fn oracle(request: Value) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/full-production-package-recovery-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(request.to_string().as_bytes())
        .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let result: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(result["profile"]["node"], "v22.23.1");
    result
}
fn readiness(ready: bool) -> Value {
    let mut value = json!({
        "version":2, "kind":"PackageRetentionRecoveryReadiness",
        "status":if ready {"package_retention_recovery_authority_ready"} else {"package_retention_recovery_authority_unavailable"},
        "recoveryAuthorityConfigured": ready,
        "recoveryAuthorityReadinessVerifierConfigured": ready,
        "recoveryAuthorityReadinessVerifierOperational": ready,
        "recoveryAuthorityAuthenticated": ready,
        "deletionLeasePortConfigured": ready, "deletionLeasePortOperational": ready,
        "lifecycleLockConfigured": ready, "lifecycleLockOperational": ready,
        "deletionFailClosedWhenUnavailable": true,
        "blockers": if ready {json!([])} else {json!(["authority_unavailable"])},
        "inspectedAt":"2026-09-19T23:59:59.000Z", "finalizedAt":"2026-09-19T23:59:59.500Z",
        "recoveryAuthoritySnapshotHash": if ready {json!(format!("sha256:{}", "a".repeat(64)))} else {Value::Null},
        "recoveryAuthorityInspectionHash": if ready {json!(format!("sha256:{}", "b".repeat(64)))} else {Value::Null},
        "recoveryAuthorityValidUntil": if ready {json!("2026-09-20T00:01:00.000Z")} else {Value::Null},
    });
    value["packageRetentionRecoveryReadinessHash"] = json!(
        production_hash_record_v1("PackageRetentionRecoveryReadiness", &value)
            .unwrap()
            .as_str()
    );
    json!({"status":"paper_campaign_retention-recovery-readiness", "result":value})
}
fn body(response: &Value) -> String {
    format!("printf '%s\\n' '{}'", response)
}

#[test]
fn pinned_child_ready_and_unavailable_inspections_match_node() {
    for ready in [true, false] {
        let fixture = Fixture::new(&body(&readiness(ready)));
        let rust = fixture.query(&json!({}), Duration::from_secs(1)).unwrap();
        let node = fixture.oracle(&json!({}), Duration::from_secs(1));
        assert_eq!(rust["inspection"], node["result"], "{node}");
        assert_eq!(rust["inspection"]["ready"], ready);
    }
}

#[test]
fn infrastructure_and_protocol_failures_match_node() {
    let mut bad_protocol = readiness(true);
    bad_protocol["result"]["packageRetentionRecoveryReadinessHash"] =
        json!(format!("sha256:{}", "c".repeat(64)));
    for script in [
        "exit 9".to_owned(),
        "printf invalid".to_owned(),
        "printf '[]'".to_owned(),
        body(&bad_protocol),
        "head -c 5000000 /dev/zero".to_owned(),
        "head -c 5000000 /dev/zero >&2".to_owned(),
    ] {
        let fixture = Fixture::new(&script);
        let rust = fixture
            .query(&json!({}), Duration::from_secs(1))
            .unwrap_err();
        let node = fixture.oracle(&json!({}), Duration::from_secs(1));
        assert_eq!(json!(rust), node["error"], "{script} {node}");
    }
}

#[test]
fn protected_command_rejects_mutable_alias_and_identity_drift() {
    let fixture = Fixture::new(&body(&readiness(true)));
    let pin = fixture.pin().unwrap();
    assert_command_current(&pin).unwrap();
    // Descriptor execution uses the pinned original even after pathname replacement;
    // postflight must reject that otherwise successful result.
    let original = fixture.root.join("original");
    fs::rename(&fixture.path, &original).unwrap();
    fs::write(&fixture.path, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o555)).unwrap();
    assert_eq!(assert_command_current(&pin).unwrap_err(), drift());
    fs::remove_file(&fixture.path).unwrap();
    symlink(&original, &fixture.path).unwrap();
    assert_eq!(fixture.pin().unwrap_err(), invalid());
    fs::remove_file(&fixture.path).unwrap();
    fs::hard_link(&original, &fixture.path).unwrap();
    assert_eq!(fixture.pin().unwrap_err(), invalid());
    fs::remove_file(&fixture.path).unwrap();
    fs::rename(&original, &fixture.path).unwrap();
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(fixture.pin().unwrap_err(), invalid());
    fs::set_permissions(&fixture.path, fs::Permissions::from_mode(0o555)).unwrap();
    fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o777)).unwrap();
    assert_eq!(fixture.pin().unwrap_err(), invalid());
}

#[test]
fn timeout_and_descendant_held_pipes_are_bounded() {
    let fixture = Fixture::new("sleep 10");
    let started = Instant::now();
    assert_eq!(
        fixture
            .query(&json!({}), Duration::from_millis(50))
            .unwrap_err(),
        "full_production_package_readiness_child_infrastructure_failed"
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    let fixture = Fixture::new("sleep 10 &\nprintf '{}'\nexit 0");
    let started = Instant::now();
    let _ = fixture.query(&json!({}), Duration::from_millis(50));
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn exact_arguments_environment_and_production_uid_boundary() {
    let response = readiness(true);
    let fixture = Fixture::new(&format!(
        "test \"$1\" = --action && test \"$2\" = retention-recovery-readiness && test \"$3\" = --root && test \"$4\" = \"$PWD\" && test \"$5\" = --runtime-root && test \"$6\" = \"$PWD\" && test \"$LANG\" = C && test -z \"$HEPTA_PRIVATE_SECRET\" || exit 23\n{}",
        body(&response)
    ));
    let environment = json!({"LANG":"C", "SSL_CERT_DIR":"/certs", "NODE_EXTRA_CA_CERTS":"/ca", "HEPTA_PRIVATE_SECRET":"excluded", "NODE_OPTIONS":"excluded", "LD_PRELOAD":"excluded"});
    let rust = fixture.query(&environment, Duration::from_secs(1)).unwrap();
    assert_eq!(rust["inspection"]["ready"], true);
    let node = oracle(json!({"action":"environment", "environment":environment}));
    assert_eq!(json!(restricted_environment(&environment)), node["result"]);
    if fs::metadata(&fixture.root).unwrap().uid() != 0 {
        assert_eq!(
            query_package_retention_recovery_readiness_v1(
                &fixture.path,
                &digest(&fs::read(&fixture.path).unwrap()),
                &fixture.root,
                &fixture.root,
                &fixture.root,
                &environment
            )
            .unwrap_err(),
            invalid()
        );
    }
}
