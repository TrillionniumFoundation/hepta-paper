//! Only public synthetic trust documents and signed test receipts are persisted.
use hepta_paper_service::journal_connector_coverage::qualification::canonical_instant_millis;
use hepta_paper_service::sqlite_mutation_coordinator::{
    Result,
    authority::{MutationAuthorityTransportV1, PinnedMutationAuthorityV1},
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-online-activation-authority-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn oracle(requests: &[Value]) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/online-mutation-activation-authority-v1.mjs"))
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
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&value["profile"]).unwrap();
    value
}
fn fixture(root: &Temp) -> Value {
    let out = oracle(&[json!({"operation":"fixture","root":root.0})]);
    assert_eq!(out["results"][0]["ok"], true, "{out}");
    out["results"][0]["value"].clone()
}
#[derive(Clone)]
struct Raw {
    value: Value,
    calls: Arc<AtomicUsize>,
    tamper: Option<PathBuf>,
}
impl Raw {
    fn new(value: Value) -> Self {
        Self {
            value,
            calls: Arc::new(AtomicUsize::new(0)),
            tamper: None,
        }
    }
}
impl MutationAuthorityTransportV1 for Raw {
    fn invoke(&mut self, _: &Value) -> Result<Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(path) = self.tamper.take() {
            fs::write(path, b"{}").unwrap();
        }
        Ok(self.value.clone())
    }
}
fn load(fixture: &Value, raw: Raw) -> Result<PinnedMutationAuthorityV1<Raw>> {
    PinnedMutationAuthorityV1::load(
        Path::new(fixture["configurationPath"].as_str().unwrap()),
        fixture["configurationFileHash"].as_str().unwrap(),
        raw,
    )
}
fn native(fixture: &Value, case: &Value) -> Result<Value> {
    let mut client = load(fixture, Raw::new(case["receipt"].clone()))?;
    let request = &case["request"];
    let now = canonical_instant_millis(case["now"].as_str().unwrap()).unwrap();
    let result = match case["operation"].as_str().unwrap() {
        "head" => client.verify_current_head_receipt(
            &case["receipt"],
            request,
            Some(&case["expectedInstances"]),
            now,
        )?,
        "challenge" => {
            client.challenge_active_authority(request, Some(&case["expectedInstances"]), now)?
        }
        "scope" => client.observe_scope(request, now)?,
        "list" => client.list_unresolved_mutations(request, now)?,
        other => panic!("unknown test operation {other}"),
    };
    Ok(result.value().clone())
}
#[test]
fn active_challenge_scope_and_unresolved_lists_match_node_real_signatures() {
    let root = Temp::new();
    let fixture = fixture(&root);
    let cases = fixture["cases"].as_array().unwrap();
    let expected=oracle(&cases.iter().map(|case|json!({"operation":"verify","configurationPath":fixture["configurationPath"],"case":case})).collect::<Vec<_>>());
    assert!(cases.len() > 50);
    for (i, case) in cases.iter().enumerate() {
        let actual = native(&fixture, case);
        let node = &expected["results"][i];
        assert_eq!(
            actual.is_ok(),
            node["ok"] == true && node["accepted"] == true,
            "{}: native={:?}; Node={node}",
            case["label"],
            actual.err().map(|e| e.code)
        );
    }
}
#[test]
fn active_authority_process_modes_match_node_and_preserve_opaque_verification() {
    let root = Temp::new();
    let fixture = fixture(&root);
    let cases = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| {
            ["head-valid", "challenge-valid", "scope-valid", "list-valid"]
                .contains(&c["label"].as_str().unwrap())
        })
        .collect::<Vec<_>>();
    let expected=oracle(&cases.iter().map(|case|json!({"operation":"process","processConfigurationPath":fixture["processConfigurationPath"],"case":case})).collect::<Vec<_>>());
    for (i, case) in cases.into_iter().enumerate() {
        let mut client = PinnedMutationAuthorityV1::load_process(
            Path::new(fixture["processConfigurationPath"].as_str().unwrap()),
            fixture["processConfigurationFileHash"].as_str().unwrap(),
        )
        .unwrap();
        let now = canonical_instant_millis(case["now"].as_str().unwrap()).unwrap();
        let request = &case["request"];
        let receipt = match case["operation"].as_str().unwrap() {
            "head" => client.observe_current_head(request, Some(&case["expectedInstances"]), now),
            "challenge" => {
                client.challenge_active_authority(request, Some(&case["expectedInstances"]), now)
            }
            "scope" => client.observe_scope(request, now),
            "list" => client.list_unresolved_mutations(request, now),
            _ => unreachable!(),
        }
        .unwrap();
        assert_eq!(
            json!({"ok":true,"value":receipt.value()}),
            expected["results"][i],
            "{}",
            case["operation"]
        );
    }
}
#[test]
fn activation_authority_rejects_invalid_requests_before_transport_and_rechecks_pins() {
    for action in ["challenge", "scope", "list"] {
        let root = Temp::new();
        let fixture = fixture(&root);
        let case = &fixture["base"][action];
        let raw = Raw::new(case["receipt"].clone());
        let calls = raw.calls.clone();
        let mut client = load(&fixture, raw).unwrap();
        let mut request = case["request"].clone();
        request["extra"] = json!(true);
        let now = canonical_instant_millis(fixture["now"].as_str().unwrap()).unwrap();
        let invoke = |client: &mut PinnedMutationAuthorityV1<Raw>, request: &Value| match action {
            "challenge" => {
                client.challenge_active_authority(request, Some(&fixture["expectedInstances"]), now)
            }
            "scope" => client.observe_scope(request, now),
            _ => client.list_unresolved_mutations(request, now),
        };
        assert!(invoke(&mut client, &request).is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let mut raw = Raw::new(case["receipt"].clone());
        raw.tamper = Some(PathBuf::from(fixture["publicKeyPath"].as_str().unwrap()));
        let mut client = load(&fixture, raw).unwrap();
        assert!(invoke(&mut client, &case["request"]).is_err(), "{action}");
    }
}
