use hepta_paper_service::online_authority_evidence_cache::{
    CACHE_RELATIVE_PATH, contract, read_passive_authority_evidence_cache_v1 as read,
    record_passive_authority_evidence_cache_v1 as write,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-authority-cache-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn script() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../rust/oracle/online-authority-evidence-cache-v1.mjs")
}
fn oracle(requests: &[Value]) -> Value {
    let mut child = Command::new("node")
        .arg(script())
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
    let o = child.wait_with_output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    serde_json::from_slice(&o.stdout).unwrap()
}
fn digest(c: char) -> String {
    format!("sha256:{}", c.to_string().repeat(64))
}
fn input(sequence: u64, second: u8) -> Value {
    json!({"databaseScopeHash":digest('a'),"writerManifestHash":digest('b'),"expiresAt":format!("2026-09-16T00:01:{second:02}.000Z"),"activeRefreshReceipt":{"version":1,"kind":"AutonomousResearchOnlineMutationActiveRefreshReceipt","status":"autonomous_research_online_mutation_active_refresh_complete","externalActionPerformed":true,"journalRecorded":false,"journalReceipt":null,"globalSequence":sequence,"globalHash":digest('c'),"recordedAt":format!("2026-09-16T00:00:{second:02}.000Z"),"authorityEvidence":{"currentHead":{"fixture":"passive-only"},"activeChallenge":{"fixture":"passive-only"},"brokerScope":{"fixture":"passive-only"}}}})
}
fn create(v: &Value) -> Value {
    match contract::create_cache_v1(
        &v["activeRefreshReceipt"],
        v["databaseScopeHash"].as_str().unwrap(),
        v["writerManifestHash"].as_str().unwrap(),
        v["expiresAt"].as_str().unwrap(),
    ) {
        Ok(v) => json!({"ok":v}),
        Err(e) => json!({"error":e.to_string()}),
    }
}
fn write_native(root: &Path, v: &Value) -> Value {
    match write(
        root,
        &v["activeRefreshReceipt"],
        v["databaseScopeHash"].as_str().unwrap(),
        v["writerManifestHash"].as_str().unwrap(),
        v["expiresAt"].as_str().unwrap(),
    ) {
        Ok(v) => json!({"ok":v}),
        Err(e) => json!({"error":e.to_string()}),
    }
}
#[test]
fn passive_contract_full_payload_hash_and_negative_cases_match_node() {
    let mut inputs = vec![input(0, 0), input(9_007_199_254_740_991, 59)];
    for (field, values) in [
        (
            "globalSequence",
            vec![
                json!(-1),
                json!(1.5),
                json!("1"),
                json!(false),
                json!(9_007_199_254_740_992_u64),
            ],
        ),
        ("externalActionPerformed", vec![json!(false), json!(1)]),
        ("journalRecorded", vec![json!(true), json!(0)]),
        ("globalHash", vec![json!(digest('A')), json!(null)]),
        ("journalReceipt", vec![json!({}), json!(false)]),
    ] {
        for value in values {
            let mut v = input(1, 1);
            v["activeRefreshReceipt"][field] = value;
            inputs.push(v);
        }
    }
    let mut integral = input(1, 1);
    integral["activeRefreshReceipt"]["version"] = json!(1.0);
    integral["activeRefreshReceipt"]["globalSequence"] = json!(1.0);
    inputs.push(integral);
    let mut expired = input(1, 1);
    expired["expiresAt"] = expired["activeRefreshReceipt"]["recordedAt"].clone();
    inputs.push(expired);
    let expected = oracle(
        &inputs
            .iter()
            .map(|v| json!({"operation":"create","input":v}))
            .collect::<Vec<_>>(),
    );
    assert_eq!(
        expected["contractHash"],
        contract::cache_contract_hash_v1().unwrap()
    );
    for (i, v) in inputs.iter().enumerate() {
        assert_eq!(create(v), expected["results"][i], "case {i}");
    }
    let original = create(&input(3, 3))["ok"].clone();
    let mut documents = vec![original.clone()];
    for field in original.as_object().unwrap().keys() {
        let mut v = original.clone();
        v.as_object_mut().unwrap().remove(field);
        documents.push(v);
    }
    let mut extra = original.clone();
    extra["extra"] = true.into();
    documents.push(extra);
    let expected = oracle(
        &documents
            .iter()
            .map(|v| json!({"operation":"validate","document":v,"options":{}}))
            .collect::<Vec<_>>(),
    );
    for (i, v) in documents.iter().enumerate() {
        let actual = match contract::assert_cache_v1(v, None, None, None) {
            Ok(()) => json!({"ok":v}),
            Err(e) => json!({"error":e.to_string()}),
        };
        assert_eq!(actual, expected["results"][i], "document {i}");
    }
}
#[test]
fn actual_read_write_and_monotonic_replacement_interoperate_with_node() {
    let native = Fixture::new();
    let node = Fixture::new();
    let mut cases = vec![
        input(1, 1),
        input(1, 1),
        input(0, 2),
        input(2, 0),
        input(2, 1),
        input(2, 2),
    ];
    let mut conflict = input(2, 3);
    conflict["activeRefreshReceipt"]["globalHash"] = digest('d').into();
    cases.push(conflict);
    let mut expiry = input(3, 3);
    expiry["expiresAt"] = "2026-09-16T00:01:02.000Z".into();
    cases.push(expiry);
    cases.push(input(3, 4));
    for v in cases {
        let expected = oracle(&[json!({"operation":"write","root":node.0,"input":v})]);
        assert_eq!(write_native(&native.0, &v), expected["results"][0]);
    }
    let options = json!({"databaseScopeHash":digest('a'),"writerManifestHash":digest('b'),"now":"2026-09-16T00:00:05.000Z"});
    let expected = oracle(&[json!({"operation":"read","root":native.0,"options":options})]);
    let actual = read(&native.0, Some(&digest('a')), Some(&digest('b')), None).unwrap();
    assert_eq!(json!({"ok":actual}), expected["results"][0]);
    let expected = oracle(&[json!({"operation":"write","root":native.0,"input":input(4,6)})]);
    assert!(expected["results"][0].get("ok").is_some());
    assert!(read(&native.0, Some(&digest('e')), None, None).is_err());
    assert!(read(&native.0, None, None, Some(i64::MAX)).is_err());
    assert_eq!(
        fs::metadata(native.0.join(CACHE_RELATIVE_PATH))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o400
    );
}
#[test]
fn live_node_lock_blocks_native_and_dead_node_lock_is_recovered() {
    for stage in ["v4", "v5", "v6"] {
        let fixture = Fixture::new();
        let mut child = Command::new("node")
            .arg(script())
            .arg("lock")
            .arg(&fixture.0)
            .arg(stage)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line, "locked\n");
        assert!(
            write_native(&fixture.0, &input(1, 1))["error"]
                .as_str()
                .unwrap()
                .contains("locked")
        );
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(write_native(&fixture.0, &input(1, 1)).get("ok").is_some());
        let parent = fixture
            .0
            .join("automation-cache/online-authority-evidence-v1");
        assert_eq!(
            fs::read_dir(parent)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect::<Vec<_>>(),
            vec![std::ffi::OsString::from("current.json")]
        );
    }
}
#[test]
fn unsafe_cache_files_fail_without_overwriting_untrusted_bytes() {
    for mutation in [
        "mode",
        "symlink",
        "hardlink",
        "duplicate",
        "oversize",
        "fifo",
    ] {
        let fixture = Fixture::new();
        assert!(write_native(&fixture.0, &input(1, 1)).get("ok").is_some());
        let path = fixture.0.join(CACHE_RELATIVE_PATH);
        match mutation {
            "mode" => fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap(),
            "symlink" => {
                fs::remove_file(&path).unwrap();
                symlink(fixture.0.join("foreign"), &path).unwrap();
            }
            "hardlink" => fs::hard_link(&path, fixture.0.join("alias")).unwrap(),
            "duplicate" => {
                fs::remove_file(&path).unwrap();
                fs::write(&path, b"{\"version\":1,\"version\":1}").unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
            }
            "oversize" => {
                fs::remove_file(&path).unwrap();
                fs::write(&path, vec![b'x'; 4 * 1024 * 1024 + 1]).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
            }
            "fifo" => {
                fs::remove_file(&path).unwrap();
                nix::unistd::mkfifo(&path, nix::sys::stat::Mode::S_IRUSR).unwrap();
            }
            _ => unreachable!(),
        }
        let before = fs::symlink_metadata(&path).unwrap();
        assert!(read(&fixture.0, None, None, None).is_err());
        assert!(
            write_native(&fixture.0, &input(2, 2))
                .get("error")
                .is_some()
        );
        use std::os::unix::fs::MetadataExt;
        assert_eq!(before.ino(), fs::symlink_metadata(&path).unwrap().ino());
    }
}
