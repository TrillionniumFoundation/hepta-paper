use super::*;
use crate::sqlite_mutation_coordinator::Result as MutationResult;
use std::{
    io::Write,
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
pub(in crate::online_schema_execution) struct NoTransport;
impl MutationAuthorityTransportV1 for NoTransport {
    fn invoke(&mut self, _: &Value) -> MutationResult<Value> {
        panic!("historical observer invoked authority")
    }
}
pub(in crate::online_schema_execution) struct Fixture {
    pub(in crate::online_schema_execution) root: PathBuf,
    pub(in crate::online_schema_execution) value: Value,
}
impl Fixture {
    pub(in crate::online_schema_execution) fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-node-history-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let mut child =
            Command::new(std::env::var_os("HEPTA_TEST_NODE").unwrap_or_else(|| "node".into()))
                .arg(
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../oracle/node-schema-history-v021.mjs"),
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                serde_json::to_string(&json!({"root":root}))
                    .unwrap()
                    .as_bytes(),
            )
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&value["profile"]).unwrap();
        Self { root, value }
    }
    pub(in crate::online_schema_execution) fn authority(
        &self,
    ) -> PinnedMutationAuthorityV1<NoTransport> {
        PinnedMutationAuthorityV1::load(
            Path::new(self.value["configurationPath"].as_str().unwrap()),
            self.value["configurationSha256"].as_str().unwrap(),
            NoTransport,
        )
        .unwrap()
    }
    pub(in crate::online_schema_execution) fn control(&self, case: &Value) -> (PathBuf, String) {
        let control = self.root.join("control");
        fs::create_dir(&control).unwrap();
        fs::set_permissions(&control, fs::Permissions::from_mode(0o700)).unwrap();
        for (name, value) in [
            ("ACTIVE.json", &case["active"]),
            ("FINAL.json", &case["audit"]),
        ] {
            let wire = if name == "ACTIVE.json" {
                "activeWire"
            } else {
                "auditWire"
            };
            fs::write(
                control.join(name),
                case[wire].as_str().unwrap_or("").as_bytes(),
            )
            .unwrap();
            let _ = value;
            fs::set_permissions(control.join(name), fs::Permissions::from_mode(0o600)).unwrap();
        }
        let pin = hash_bytes(&fs::read(control.join("FINAL.json")).unwrap());
        (control, pin)
    }
    pub(in crate::online_schema_execution) fn mirror(
        &self,
        control: &Path,
        case: &Value,
    ) -> PathBuf {
        let history = control.join("history");
        if !history.exists() {
            fs::create_dir(&history).unwrap();
        }
        fs::set_permissions(&history, fs::Permissions::from_mode(0o700)).unwrap();
        let transition = case["audit"]["transitionId"]
            .as_str()
            .unwrap()
            .trim_start_matches("sha256:");
        let writer = case["audit"]["writerManifestHash"]
            .as_str()
            .unwrap()
            .trim_start_matches("sha256:");
        let generation = history.join(format!("{transition}-writer-{}", &writer[..8]));
        fs::create_dir(&generation).unwrap();
        fs::set_permissions(&generation, fs::Permissions::from_mode(0o700)).unwrap();
        for name in ["ACTIVE.json", "FINAL.json"] {
            let field = if name == "ACTIVE.json" {
                "active"
            } else {
                "audit"
            };
            fs::write(
                generation.join(name),
                case[if field == "active" {
                    "activeWire"
                } else {
                    "auditWire"
                }]
                .as_str()
                .unwrap()
                .as_bytes(),
            )
            .unwrap();
            fs::set_permissions(generation.join(name), fs::Permissions::from_mode(0o600)).unwrap();
        }
        let manifest = format!(
            "{}  ACTIVE.json\n{}  FINAL.json\n",
            hash_bytes(&fs::read(generation.join("ACTIVE.json")).unwrap())
                .trim_start_matches("sha256:"),
            hash_bytes(&fs::read(generation.join("FINAL.json")).unwrap())
                .trim_start_matches("sha256:")
        );
        fs::write(generation.join("MANIFEST.sha256"), manifest).unwrap();
        fs::set_permissions(
            generation.join("MANIFEST.sha256"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        generation
    }
}
#[test]
fn actual_node_three_generation_signed_lineage_is_order_independent_and_fail_closed() {
    let fixture = Fixture::new();
    let target = PinnedMutationAuthorityV1::load(
        Path::new(fixture.value["targetConfigurationPath"].as_str().unwrap()),
        fixture.value["targetConfigurationSha256"].as_str().unwrap(),
        NoTransport,
    )
    .unwrap();
    let cases = fixture.value["lineage"].as_array().unwrap();
    let (control, pin) = fixture.control(&cases[2]);
    for case in cases.iter().rev() {
        fixture.mirror(&control, case);
    }
    let source = fixture.authority();
    observe_node_control_v1(&control, &pin, &target, Some(&source))
        .unwrap()
        .assert_current()
        .unwrap();
    // Each wrong edge remains correctly signed and individually well formed.
    // Only the cross-generation global/database history closure refuses it.
    for case in fixture.value["badLineage"].as_array().unwrap() {
        let receipt = case["auditWire"].as_str().unwrap().as_bytes();
        crate::online_schema_transition::audit::verify_historical_public_audit_v1(
            &case["audit"],
            receipt,
            &target,
        )
        .unwrap();
        assert!(
            lineage::verify(
                &case["audit"],
                &cases[..2]
                    .iter()
                    .map(|v| v["audit"].clone())
                    .collect::<Vec<_>>()
            )
            .is_err()
        );
    }
    assert!(lineage::verify(&cases[2]["audit"], &[cases[0]["audit"].clone()]).is_err());
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn actual_node_v021_signatures_and_exact_archived_mirror_are_observed() {
    let fixture = Fixture::new();
    let case = &fixture.value["cases"][0];
    let (control, pin) = fixture.control(case);
    let generation = fixture.mirror(&control, case);
    let authority = fixture.authority();
    let observed = observe_node_control_v1(&control, &pin, &authority, None).unwrap();
    assert_eq!(observed.final_receipt_file_sha256(), pin);
    observed.assert_current().unwrap();
    fs::write(generation.join("MANIFEST.sha256"), b"substituted manifest").unwrap();
    assert!(observed.assert_current().is_err());
    assert!(observe_node_control_v1(&control, &pin, &authority, None).is_err());
}
#[test]
fn actual_signed_historical_splices_times_subject_and_unfenced_receipts_are_refused() {
    let fixture = Fixture::new();
    let authority = fixture.authority();
    for case in fixture.value["cases"].as_array().unwrap() {
        let bytes = serde_json::to_vec(&case["audit"]).unwrap();
        let result = legacy_v021::verify(&case["active"], &case["audit"], &bytes, &authority);
        assert_eq!(
            result.is_ok(),
            case["variant"] == "valid",
            "{}: {:?}",
            case["variant"],
            result
        );
    }
}
#[test]
fn unowned_history_shape_wrong_pin_and_symlinks_are_refused() {
    let fixture = Fixture::new();
    let case = &fixture.value["cases"][0];
    let (control, pin) = fixture.control(case);
    let generation = fixture.mirror(&control, case);
    let authority = fixture.authority();
    assert!(
        observe_node_control_v1(
            &control,
            &format!("sha256:{}", "0".repeat(64)),
            &authority,
            None
        )
        .is_err()
    );
    fs::write(generation.join("unknown"), b"unowned").unwrap();
    assert!(observe_node_control_v1(&control, &pin, &authority, None).is_err());
    fs::remove_file(generation.join("unknown")).unwrap();
    let path = generation.join("FINAL.json");
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(control.join("FINAL.json"), path).unwrap();
    assert!(observe_node_control_v1(&control, &pin, &authority, None).is_err());
}
