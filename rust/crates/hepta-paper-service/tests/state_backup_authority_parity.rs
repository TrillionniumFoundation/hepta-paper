//! Isolated synthetic authorities; no production backup or authority is used.
use hepta_paper_service::journal_connector_coverage::qualification::canonical_instant_millis;
use hepta_paper_service::sqlite_mutation_coordinator::Result;
use hepta_paper_service::state_backup_authority::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-sqlite-authority-rust-backup-{}-{}",
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
        .arg(root.join("rust/oracle/state-backup-authority-v1.mjs"))
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
fn fixture(root: &Temp, version: u8) -> Value {
    let result = oracle(&[json!({"operation":"fixture","root":root.0,"version":version})]);
    assert_eq!(result["results"][0]["ok"], true, "{result}");
    result["results"][0]["value"].clone()
}
struct Raw(Value);
impl StateBackupAuthorityTransportV1 for Raw {
    fn invoke(&mut self, _: &Value) -> Result<Value> {
        Ok(self.0.clone())
    }
}
fn load(f: &Value) -> PinnedStateBackupAuthorityV1<Raw> {
    PinnedStateBackupAuthorityV1::load(
        Path::new(f["configurationPath"].as_str().unwrap()),
        f["configurationFileHash"].as_str().unwrap(),
        Raw(Value::Null),
    )
    .unwrap()
}
fn now(f: &Value) -> i64 {
    canonical_instant_millis(f["now"].as_str().unwrap()).unwrap()
}
fn verify(
    v: &PinnedStateBackupAuthorityV1<Raw>,
    f: &Value,
    c: &Value,
) -> Result<VerifiedBackupAuthorityReceiptV1> {
    match c["action"].as_str().unwrap() {
        "reserve" => v.verify_reservation(&c["receipt"], &c["request"], now(c)),
        "head" => v.verify_current_head(&c["receipt"], &c["request"], now(c)),
        "journal" => v.verify_journal_range(&c["receipt"], &c["request"], now(c)),
        _ => {
            let r = v.verify_reservation(
                &f["base"]["reserve"]["receipt"],
                &f["base"]["reserve"]["request"],
                now(f),
            )?;
            v.verify_finalization(&c["receipt"], &c["request"], &r, now(c))
        }
    }
}
#[test]
fn real_signed_snapshot_authority_receipts_match_node_all_four_contracts() {
    let root = Temp::new();
    let f = fixture(&root, 2);
    let v = load(&f);
    let cases = f["cases"].as_array().unwrap();
    let expected=oracle(&cases.iter().map(|case|json!({"operation":"verify","configurationPath":f["configurationPath"],"case":case})).collect::<Vec<_>>());
    for (index, case) in cases.iter().enumerate() {
        let actual = verify(&v, &f, case);
        assert_eq!(
            actual.is_ok(),
            expected["results"][index]["ok"] == true
                && expected["results"][index]["accepted"] == true,
            "{} native error {:?} Node {}",
            case["label"],
            actual.err().map(|e| e.to_string()),
            expected["results"][index]
        );
    }
}
#[test]
fn version_one_and_two_actual_processes_match_original_node_responses() {
    for version in [1, 2] {
        let root = Temp::new();
        let f = fixture(&root, version);
        let cases = f["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["label"].as_str().unwrap().ends_with("-valid"))
            .collect::<Vec<_>>();
        let expected=oracle(&cases.iter().map(|case|json!({"operation":"process","configurationPath":f["configurationPath"],"case":case})).collect::<Vec<_>>());
        for (index, c) in cases.into_iter().enumerate() {
            let mut v = PinnedStateBackupAuthorityV1::load_process(
                Path::new(f["configurationPath"].as_str().unwrap()),
                f["configurationFileHash"].as_str().unwrap(),
            )
            .unwrap();
            let result = match c["action"].as_str().unwrap() {
                "reserve" => v.reserve_snapshot(&c["request"], now(c)),
                "head" => v.observe_current_head(&c["request"], now(c)),
                "journal" => v.read_finalized_mutation_journal(&c["request"], now(c)),
                _ => {
                    let r = v
                        .verify_reservation(
                            &f["base"]["reserve"]["receipt"],
                            &f["base"]["reserve"]["request"],
                            now(&f),
                        )
                        .unwrap();
                    v.finalize_snapshot(&c["request"], &r, now(c))
                }
            };
            assert_eq!(
                result.unwrap().value(),
                &expected["results"][index]["value"]
            );
        }
    }
}
#[test]
fn signed_journal_envelope_cannot_replace_nested_crypto_subjects_or_causal_continuity() {
    for version in [1, 2] {
        let root = Temp::new();
        let f = fixture(&root, version);
        let v = load(&f);
        for case in f["causal"].as_array().unwrap() {
            let range = v
                .verify_journal_range(&case["receipt"], &case["request"], now(&f))
                .unwrap();
            let result = v.verify_finalized_journal_chain(&range);
            assert_eq!(
                result.is_ok(),
                version == 2 && case["label"] == "valid",
                "{}",
                case["label"]
            );
        }
    }
}
fn pin(path: &Path) -> String {
    format!(
        "sha256:{}",
        hex::encode(Sha256::digest(fs::read(path).unwrap()))
    )
}
#[test]
fn public_pins_aliases_private_material_and_changed_commands_fail_closed() {
    for mode in [
        "wrong-pin",
        "duplicate",
        "public-symlink",
        "public-hardlink",
        "writable",
        "private",
        "invalid-pem",
        "online-drift",
        "command-drift",
    ] {
        let root = Temp::new();
        let f = fixture(&root, 2);
        let path = Path::new(f["configurationPath"].as_str().unwrap());
        let public = Path::new(f["publicPath"].as_str().unwrap());
        let mut hash = f["configurationFileHash"].as_str().unwrap().to_owned();
        match mode {
            "wrong-pin" => hash = format!("sha256:{}", "0".repeat(64)),
            "duplicate" => {
                let text = fs::read_to_string(path).unwrap();
                fs::write(path, text.replacen('{', "{\"version\":2,", 1)).unwrap();
                hash = pin(path);
            }
            "public-symlink" => {
                let held = public.with_extension("held");
                fs::rename(public, &held).unwrap();
                symlink(held, public).unwrap();
            }
            "public-hardlink" => fs::hard_link(public, public.with_extension("held")).unwrap(),
            "writable" => fs::set_permissions(public, fs::Permissions::from_mode(0o620)).unwrap(),
            "private" | "invalid-pem" => {
                let mut doc: Value = serde_json::from_slice(&fs::read(public).unwrap()).unwrap();
                if mode == "private" {
                    doc["privateKeyPem"] = json!("forbidden synthetic marker");
                } else {
                    doc["publicKeyPem"] = json!(
                        doc["publicKeyPem"]
                            .as_str()
                            .unwrap()
                            .replacen("MCow", "MC!ow", 1)
                    );
                }
                fs::write(public, doc.to_string()).unwrap();
                let mut config: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
                config["publicKeySha256"] = json!(pin(public));
                fs::write(path, config.to_string()).unwrap();
                hash = pin(path);
            }
            _ => {
                let mut v = PinnedStateBackupAuthorityV1::load_process(path, &hash).unwrap();
                let target = if mode == "online-drift" {
                    root.0.join("authority.json")
                } else {
                    PathBuf::from(f["commandPath"].as_str().unwrap())
                };
                fs::write(target, b"{}").unwrap();
                assert!(
                    v.observe_current_head(&f["base"]["head"]["request"], now(&f))
                        .is_err()
                );
                continue;
            }
        }
        assert!(
            PinnedStateBackupAuthorityV1::load(path, &hash, Raw(Value::Null)).is_err(),
            "{mode}"
        );
    }
}
#[test]
fn backup_process_descendant_pipes_and_timeout_are_bounded() {
    for mode in ["escape", "timeout", "duplicate"] {
        let root = Temp::new();
        let f = fixture(&root, 1);
        let path = Path::new(f["configurationPath"].as_str().unwrap());
        let command = Path::new(f["commandPath"].as_str().unwrap());
        let body = match mode {
            "escape" => "if os.fork()==0:\n os.setsid()\n time.sleep(5)\n os._exit(0)\nprint('{}')",
            "timeout" => "time.sleep(30)",
            _ => "print('{\"value\":1,\"value\":2}')",
        };
        fs::write(
            command,
            format!("#!/usr/bin/python3\nimport os,time\n{body}\n"),
        )
        .unwrap();
        let mut config: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        config["commandSha256"] = json!(pin(command));
        fs::write(path, config.to_string()).unwrap();
        let mut p = ProcessStateBackupAuthorityTransportV1::load(path, &pin(path)).unwrap();
        let started = Instant::now();
        assert!(p.invoke(&json!({})).is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
