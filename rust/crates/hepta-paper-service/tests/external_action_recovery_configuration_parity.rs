//! Original recovery diagnostics over owned nonsecret V3 inputs. Real ephemeral
//! signatures prove only a local contract fixture, never independent authority.
#[allow(dead_code)]
mod machine_intake_support;
use hepta_paper_service::external_action_recovery_configuration::inspect_autonomous_research_supervisor_external_action_recovery_configuration_v1 as inspect;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
const NOW: i64 = 1_790_035_200_000;
const ENV: &str = "HEPTA_AUTONOMOUS_RESEARCH_EXTERNAL_ACTION_RECOVERY_CONFIG";
const EVIDENCE: &str =
    "synthetic_local_signature_contract_fixture_no_recovery_execution_or_independent_authority";
const HASH: &str = "autonomousResearchSupervisorExternalActionRecoveryCapabilityReceiptHash";
const INVALID: &str =
    "autonomous_research_supervisor_external_action_recovery_configuration_invalid";
const BLOCKED: &str =
    "autonomous_research_supervisor_external_action_recovery_capability_not_verified";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    config: Value,
    environment: BTreeMap<String, String>,
    setup: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-recovery-configuration-parity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            root.join(".owned-recovery-configuration-fixture"),
            "owned synthetic recovery configuration fixture\n",
        )
        .unwrap();
        let setup = oracle(&json!({"action":"setup","root":root}), &root);
        assert_eq!(setup["evidenceScope"], EVIDENCE);
        assert_eq!(setup["standaloneCapabilityValid"], true);
        assert_eq!(setup["nowMillis"], NOW);
        Self {
            root,
            config: setup["config"].clone(),
            environment: serde_json::from_value(setup["environment"].clone()).unwrap(),
            setup,
        }
    }
    fn path(&self) -> PathBuf {
        self.root.join("recovery.json")
    }
    fn write(&self, value: &Value) {
        fs::write(self.path(), serde_json::to_vec(value).unwrap()).unwrap();
    }
    fn compare(&self, label: &str) -> Value {
        self.compare_at(Some(&self.path()), &self.environment, NOW, label)
    }
    fn compare_at(
        &self,
        path: Option<&Path>,
        environment: &BTreeMap<String, String>,
        now: i64,
        label: &str,
    ) -> Value {
        let expected = oracle(
            &json!({"action":"inspect","root":self.root,"configPath":path,"environment":environment,"nowMillis":now}),
            &self.root,
        );
        assert_eq!(expected["evidenceScope"], EVIDENCE);
        // Compare source metadata/content around native inspection alone. The actual
        // original observation is finished before recording this baseline.
        let before = snapshot(&self.root);
        let actual = inspect(path, environment, &self.root, now);
        assert_eq!(
            actual, expected["inspection"],
            "complete inspection: {label}"
        );
        assert_eq!(snapshot(&self.root), before, "source changed: {label}");
        assert!(
            !self.root.join("executed-marker").exists(),
            "no qualifier/verifier execution"
        );
        actual
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn oracle(input: &Value, root: &Path) -> Value {
    let encoded = serde_json::to_string(input).unwrap();
    assert!(encoded.len() < 64 * 1024);
    let mut command = Command::new("node");
    command
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../oracle/external-action-recovery-configuration-v1.mjs"),
        )
        .arg(encoded)
        .current_dir(root)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").expect("qualified Node"))
        .env("LANG", "en_US.UTF-8");
    let output = machine_intake_support::run(&mut command);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let output: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&output["profile"]).unwrap();
    output["value"].clone()
}
fn snapshot(root: &Path) -> Vec<Value> {
    fn visit(path: &Path, entries: &mut Vec<Value>) {
        let m = fs::symlink_metadata(path).unwrap();
        let content = if m.file_type().is_symlink() {
            json!(fs::read_link(path).unwrap())
        } else if m.is_file() {
            json!(hex::encode(Sha256::digest(fs::read(path).unwrap())))
        } else {
            Value::Null
        };
        entries.push(json!({"path":path,"dev":m.dev(),"ino":m.ino(),"uid":m.uid(),"gid":m.gid(),"nlink":m.nlink(),"mode":m.mode(),"size":m.size(),"mtime":m.mtime(),"mtimeNsec":m.mtime_nsec(),"ctime":m.ctime(),"ctimeNsec":m.ctime_nsec(),"content":content}));
        if m.is_dir() {
            let mut children = fs::read_dir(path)
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect::<Vec<_>>();
            children.sort();
            for child in children {
                visit(&child, entries);
            }
        }
    }
    let mut entries = Vec::new();
    visit(root, &mut entries);
    entries
}
fn blocked(value: &Value, code: &str, null_fields: bool) {
    assert_eq!(value["ready"], false);
    assert_eq!(value["signedCapabilityVerified"], false);
    assert_eq!(value["externalActionPerformed"], false);
    assert_eq!(value["blocker"], code);
    if null_fields {
        for field in [
            "configurationIdentityHash",
            "processIdentityHash",
            "trustIdentityHash",
            "capabilityReceiptHash",
            "actionConfigurationIdentityHashes",
        ] {
            assert!(value[field].is_null(), "{field}");
        }
    } else {
        assert!(
            value["configurationIdentityHash"]
                .as_str()
                .unwrap()
                .starts_with("sha256:")
        );
    }
}
#[test]
fn genuine_original_v3_identity_preserves_actual_recovery_trust_conflict() {
    let fixture = Fixture::new();
    let observed = fixture.compare("real V3 + ephemeral properly signed recovery capability");
    assert_eq!(observed, fixture.setup["inspection"]);
    blocked(&observed, BLOCKED, false);
    assert_eq!(
        observed["capabilityReceiptHash"],
        fixture.config["capabilityReceipt"][HASH]
    );
    assert_eq!(
        observed["actionConfigurationIdentityHashes"],
        fixture.config["actionConfigurationIdentityHashes"]
    );
}
#[test]
fn selection_precedence_missing_empty_relative_and_whitespace_paths_match() {
    let fixture = Fixture::new();
    let empty = BTreeMap::new();
    let required = fixture.compare_at(None, &empty, NOW, "absent configuration");
    blocked(
        &required,
        "autonomous_research_supervisor_external_action_recovery_configuration_required",
        true,
    );
    let mut environment = fixture.environment.clone();
    environment.insert(ENV.into(), fixture.path().to_str().unwrap().into());
    let expected = fixture.compare_at(None, &environment, NOW, "environment path");
    assert_eq!(
        fixture.compare_at(
            Some(Path::new("")),
            &environment,
            NOW,
            "empty explicit falls back"
        ),
        expected
    );
    environment.insert(
        ENV.into(),
        fixture.root.join("missing.json").to_str().unwrap().into(),
    );
    assert_eq!(
        fixture.compare_at(
            Some(Path::new("./recovery.json")),
            &environment,
            NOW,
            "explicit relative wins"
        ),
        expected
    );
    let mut config = fixture.config.clone();
    config["processConfigurationPath"] = json!("./configuration.json");
    fixture.write(&config);
    assert_eq!(fixture.compare("relative nested path"), expected);
    fs::rename(fixture.path(), fixture.root.join("  ")).unwrap();
    assert_eq!(
        fixture.compare_at(
            Some(Path::new("  ")),
            &fixture.environment,
            NOW,
            "whitespace filename is not trimmed"
        ),
        expected
    );
}
#[test]
fn exact_outer_configuration_shape_and_hash_matrix_matches() {
    let fixture = Fixture::new();
    for (field, value) in [
        ("version", json!("1")),
        ("version", json!(2)),
        ("kind", json!("wrong")),
        ("processCommandRole", json!("verifier")),
        ("processConfigurationIdentityHash", json!("SHA256:bad")),
        ("actionConfigurationIdentityHashes", json!({})),
        ("actionConfigurationIdentityHashes", json!([])),
        ("capabilityReceipt", json!(null)),
        ("capabilityReceipt", json!(false)),
        ("capabilityReceipt", json!("receipt")),
    ] {
        let mut c = fixture.config.clone();
        c[field] = value;
        fixture.write(&c);
        blocked(&fixture.compare(field), INVALID, true);
    }
    let mut extra = fixture.config.clone();
    extra["extra"] = json!(true);
    fixture.write(&extra);
    blocked(&fixture.compare("extra key"), INVALID, true);
    let mut missing = fixture.config.clone();
    missing.as_object_mut().unwrap().remove("version");
    fixture.write(&missing);
    blocked(&fixture.compare("missing key"), INVALID, true);
    let mut numeric = fixture.config.clone();
    numeric["version"] = json!(1.0);
    fixture.write(&numeric);
    blocked(
        &fixture.compare("numeric version normalization"),
        BLOCKED,
        false,
    );
}
#[test]
fn loaded_unverified_receipts_preserve_truthy_recorded_hash_without_invented_rehash() {
    let fixture = Fixture::new();
    for receipt in [json!({}), json!([])] {
        let mut c = fixture.config.clone();
        c["capabilityReceipt"] = receipt;
        fixture.write(&c);
        let v = fixture.compare("empty object or array is loaded");
        blocked(&v, BLOCKED, false);
        assert!(v["capabilityReceiptHash"].is_null());
    }
    for claimed in [
        json!(null),
        json!(false),
        json!(0),
        json!(""),
        json!(1),
        json!({"recorded":"claim"}),
        json!(["claim"]),
    ] {
        let mut c = fixture.config.clone();
        c["capabilityReceipt"][HASH] = claimed.clone();
        fixture.write(&c);
        let v = fixture.compare("recorded claim uses original truthiness");
        blocked(&v, BLOCKED, false);
        if matches!(claimed, Value::Null | Value::Bool(false))
            || claimed == json!(0)
            || claimed == json!("")
        {
            assert!(v["capabilityReceiptHash"].is_null());
        } else {
            assert_eq!(v["capabilityReceiptHash"], claimed);
        }
    }
    let before = fixture.compare("last claim");
    let mut c: Value = serde_json::from_slice(&fs::read(fixture.path()).unwrap()).unwrap();
    c["capabilityReceipt"]["signature"] = json!("tampered");
    c["capabilityReceipt"]["status"] = json!("tampered");
    fixture.write(&c);
    assert_eq!(
        fixture.compare("changing body retains recorded claim and blocks"),
        before
    );
}
#[test]
fn action_hash_coercion_is_preserved_but_process_hash_binding_stays_strict() {
    let fixture = Fixture::new();
    for nested in [false, true] {
        let mut c = fixture.config.clone();
        let hash = c["actionConfigurationIdentityHashes"]["provider-canary"].clone();
        c["actionConfigurationIdentityHashes"]["provider-canary"] = if nested {
            json!([[hash]])
        } else {
            json!([hash])
        };
        fixture.write(&c);
        let v = fixture.compare("array action hash coercion without normalization");
        blocked(&v, BLOCKED, false);
        assert_eq!(
            v["actionConfigurationIdentityHashes"],
            c["actionConfigurationIdentityHashes"]
        );
    }
    let mut c = fixture.config.clone();
    c["processConfigurationIdentityHash"] = json!([c["processConfigurationIdentityHash"]]);
    fixture.write(&c);
    blocked(
        &fixture.compare("array process hash fails strict identity"),
        "autonomous_research_supervisor_external_action_recovery_process_identity_changed",
        true,
    );
    let mut c = fixture.config.clone();
    c["actionConfigurationIdentityHashes"]["provider-canary"] = json!(["bad"]);
    fixture.write(&c);
    blocked(&fixture.compare("bad action hash"), INVALID, true);
}
#[test]
fn referenced_v3_actual_credential_environment_and_command_drift_invalidate_binding() {
    let fixture = Fixture::new();
    let mut environment = fixture.environment.clone();
    environment.insert("FIXTURE_ALLOWED".into(), "changed".into());
    blocked(
        &fixture.compare_at(
            Some(&fixture.path()),
            &environment,
            NOW,
            "allowed environment drift",
        ),
        "autonomous_research_supervisor_external_action_recovery_process_identity_changed",
        true,
    );
    environment = fixture.environment.clone();
    environment.insert("FIXTURE_IGNORED".into(), "changed".into());
    assert_eq!(
        fixture.compare_at(
            Some(&fixture.path()),
            &environment,
            NOW,
            "excluded environment"
        ),
        fixture.setup["inspection"]
    );
    let file = fixture.root.join("qualifier-credentials/z.txt");
    let before = fs::read(&file).unwrap();
    fs::write(&file, "changed owned nonsecret credential").unwrap();
    blocked(
        &fixture.compare("credential content drift"),
        "autonomous_research_supervisor_external_action_recovery_process_identity_changed",
        true,
    );
    fs::write(&file, before).unwrap();
    let file = fixture.root.join("resource.txt");
    fs::write(&file, "changed owned resource").unwrap();
    blocked(
        &fixture.compare("actual command argument file drift"),
        "autonomous_research_supervisor_external_action_recovery_process_identity_changed",
        true,
    );
}
#[test]
fn source_mode_hardlink_symlink_fifo_and_ancestor_alias_refuse_without_execution() {
    let fixture = Fixture::new();
    fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o644)).unwrap();
    blocked(&fixture.compare("group/other mode"), INVALID, true);
    fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o600)).unwrap();
    let link = fixture.root.join("hardlink.json");
    fs::hard_link(fixture.path(), &link).unwrap();
    blocked(&fixture.compare("hardlink"), INVALID, true);
    fs::remove_file(link).unwrap();
    let original = fixture.root.join("original.json");
    fs::rename(fixture.path(), &original).unwrap();
    symlink(&original, fixture.path()).unwrap();
    blocked(&fixture.compare("symlink"), INVALID, true);
    fs::remove_file(fixture.path()).unwrap();
    fs::rename(original, fixture.path()).unwrap();
    let alias = fixture.root.join("alias");
    symlink(&fixture.root, &alias).unwrap();
    blocked(
        &fixture.compare_at(
            Some(&alias.join("recovery.json")),
            &fixture.environment,
            NOW,
            "ancestor alias",
        ),
        INVALID,
        true,
    );
    fs::remove_file(alias).unwrap();
    fs::remove_file(fixture.path()).unwrap();
    nix::unistd::mkfifo(
        &fixture.path(),
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    blocked(&fixture.compare("FIFO refused before read"), INVALID, true);
}
#[test]
fn exact_file_size_and_parse_boundaries_are_bounded_and_match() {
    let fixture = Fixture::new();
    let mut bytes = serde_json::to_vec(&fixture.config).unwrap();
    bytes.resize(256 * 1024, b' ');
    fs::write(fixture.path(), &bytes).unwrap();
    blocked(&fixture.compare("maximum byte length"), BLOCKED, false);
    bytes.push(b' ');
    fs::write(fixture.path(), &bytes).unwrap();
    blocked(&fixture.compare("over byte limit"), INVALID, true);
    for bytes in [b"x".as_slice(), b"{}", b"{invalid json}"] {
        fs::write(fixture.path(), bytes).unwrap();
        blocked(&fixture.compare("too short or malformed"), INVALID, true);
    }
}
#[test]
fn clock_boundaries_and_original_short_circuit_order_match() {
    let fixture = Fixture::new();
    for time in [NOW - 1, NOW, NOW + 3_599_999, NOW + 3_600_000] {
        blocked(
            &fixture.compare_at(
                Some(&fixture.path()),
                &fixture.environment,
                time,
                "time boundary",
            ),
            BLOCKED,
            false,
        );
    }
    let invalid = 8_640_000_000_000_001;
    blocked(
        &fixture.compare_at(
            Some(&fixture.path()),
            &fixture.environment,
            invalid,
            "invalid JS clock after structural predicates",
        ),
        "Invalid time value",
        true,
    );
    let mut c = fixture.config.clone();
    c["capabilityReceipt"] = json!({});
    fixture.write(&c);
    blocked(
        &fixture.compare_at(
            Some(&fixture.path()),
            &fixture.environment,
            invalid,
            "earlier structure returns false before clock",
        ),
        BLOCKED,
        false,
    );
}
#[test]
fn native_bounded_error_profiles_remain_explicit_and_fail_closed() {
    let fixture = Fixture::new();
    let missing = fixture.root.join("missing.json");
    let node = oracle(
        &json!({"action":"inspect","root":fixture.root,"configPath":missing,"environment":fixture.environment}),
        &fixture.root,
    );
    assert!(
        node["inspection"]["blocker"]
            .as_str()
            .unwrap()
            .contains("ENOENT")
    );
    let before = snapshot(&fixture.root);
    blocked(
        &inspect(Some(&missing), &fixture.environment, &fixture.root, NOW),
        "autonomous_research_supervisor_external_action_recovery_configuration_file_unavailable",
        true,
    );
    assert_eq!(snapshot(&fixture.root), before);
    let mut c = fixture.config.clone();
    c["processConfigurationPath"] = json!(7);
    fixture.write(&c);
    let node = oracle(
        &json!({"action":"inspect","root":fixture.root,"configPath":fixture.path(),"environment":fixture.environment}),
        &fixture.root,
    );
    assert!(
        node["inspection"]["blocker"]
            .as_str()
            .unwrap()
            .contains("must be of type string")
    );
    let after_write = snapshot(&fixture.root);
    blocked(
        &inspect(
            Some(&fixture.path()),
            &fixture.environment,
            &fixture.root,
            NOW,
        ),
        "autonomous_research_supervisor_external_action_recovery_path_profile_unsupported",
        true,
    );
    assert_eq!(snapshot(&fixture.root), after_write);
    let mut raw = serde_json::to_string(&fixture.config).unwrap();
    raw = raw.replacen("\"qualifier\"", "\"\\ud800\"", 1);
    fs::write(fixture.path(), raw).unwrap();
    let before = snapshot(&fixture.root);
    blocked(
        &inspect(
            Some(&fixture.path()),
            &fixture.environment,
            &fixture.root,
            NOW,
        ),
        "autonomous_research_supervisor_external_action_recovery_json_profile_unsupported",
        true,
    );
    assert_eq!(snapshot(&fixture.root), before);
    assert!(!fixture.root.join("executed-marker").exists());
}
