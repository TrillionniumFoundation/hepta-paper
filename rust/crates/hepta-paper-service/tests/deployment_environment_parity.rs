//! Explicit synthetic environments only: tests never inspect process.env or
//! user credential files. The live incumbent reads the same private fixtures.
use hepta_paper_service::deployment_environment::{
    load_readiness_deployment_environment_v1, parse_deployment_environment_file_v1,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
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
            "hepta-deployment-environment-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn file(&self, name: &str, bytes: impl AsRef<[u8]>) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn oracle(requests: &[Value]) -> Vec<Value> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/deployment-environment-v1.mjs"))
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
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn native(request: &Value) -> Value {
    let path = request["path"].as_str().map(Path::new);
    match load_readiness_deployment_environment_v1(&request["base"], path) {
        Ok(output) => {
            json!({"ok":{"environment":output.environment,"inspection":output.inspection}})
        }
        Err(error) => json!({"error":error.to_string()}),
    }
}
#[test]
fn actual_private_environment_files_and_inspection_hashes_match_node() {
    let fixture = Fixture::new();
    let base =
        json!({"KEEP":"synthetic-only","ELAN_HOME":"old","UNRELATED":null,"FLAG":false,"ZERO":0});
    let mut requests = vec![
        json!({"base":base,"path":null}),
        json!({"base":base,"path":""}),
    ];
    let mut texts = vec![
        "".to_owned(),
        "# comment\r\n\t\n".to_owned(),
        "ELAN_HOME=\nHEPTA_SUPERVISOR_POLL_MS=250\n".to_owned(),
        "ELAN_HOME='a # b=c'\nHEPTA_PAPER_RUNTIME_ROOT=\"say \\\"hi\\\" \\\\ literal\\n\""
            .to_owned(),
        "ELAN_HOME='$(touch NEVER_EXECUTE) ${HOME} `echo never`'".to_owned(),
        "ELAN_HOME=\u{85}".to_owned(),
    ];
    for whitespace in [
        '\t', '\u{b}', '\u{c}', '\r', ' ', '\u{a0}', '\u{1680}', '\u{2000}', '\u{200a}',
        '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
    ] {
        texts.push(format!(
            "{whitespace}ELAN_HOME{whitespace}={whitespace}'日本語🌍'{whitespace}\r\n"
        ));
        texts.push(format!("ELAN_HOME=x{whitespace}y"));
    }
    for bad in [
        "export ELAN_HOME=x",
        "UNKNOWN=x",
        "=x",
        "ELAN_HOME",
        "ELAN_HOME=a\nELAN_HOME=b",
        "ELAN_HOME='",
        "ELAN_HOME=\"x",
        "ELAN_HOME='a'b'",
        "ELAN_HOME=x # comment",
        "ELAN_HOME=a b",
        "Elan_HOME=x",
    ] {
        texts.push(bad.to_owned());
    }
    let allowed: Vec<String> = serde_json::from_str(include_str!(
        "../src/deployment_environment/allowed-keys.v1.json"
    ))
    .unwrap();
    texts.push(
        allowed
            .iter()
            .rev()
            .enumerate()
            .map(|(i, key)| format!("{key}=synthetic-{i}"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    for (i, text) in texts.iter().enumerate() {
        requests.push(json!({"base":base,"path":fixture.file(&format!("case-{i}.env"),text)}));
    }
    let expected = oracle(&requests);
    for (i, (request, expected)) in requests.iter().zip(expected).enumerate() {
        assert_eq!(native(request), expected, "case {i}");
    }
    assert!(!fixture.0.join("NEVER_EXECUTE").exists());
}
#[test]
fn unsafe_file_types_links_permissions_and_unbounded_input_fail_closed() {
    let fixture = Fixture::new();
    let valid = fixture.file("valid.env", "ELAN_HOME=synthetic");
    let broad = fixture.file("broad.env", "ELAN_HOME=synthetic");
    fs::set_permissions(&broad, fs::Permissions::from_mode(0o640)).unwrap();
    let link = fixture.0.join("link.env");
    symlink(&valid, &link).unwrap();
    let hard = fixture.0.join("hard.env");
    fs::hard_link(&valid, &hard).unwrap();
    let invalid = fixture.file("invalid.env", [0xff]);
    let huge = fixture.file("huge.env", vec![b'#'; 1024 * 1024 + 1]);
    let fifo = fixture.0.join("fifo.env");
    nix::unistd::mkfifo(
        &fifo,
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    for path in [
        &broad,
        &link,
        &hard,
        &invalid,
        &huge,
        &fifo,
        &fixture.0,
        &fixture.0.join("absent"),
    ] {
        assert!(
            load_readiness_deployment_environment_v1(&json!({}), Some(path)).is_err(),
            "{}",
            path.display()
        );
    }
    fs::remove_file(hard).unwrap();
    let alias = fixture.0.join("alias");
    symlink(&fixture.0, &alias).unwrap();
    assert!(
        load_readiness_deployment_environment_v1(&json!({}), Some(&alias.join("valid.env")))
            .is_err()
    );
    for path in [
        PathBuf::from("relative.env"),
        PathBuf::from(format!("{}/./valid.env", fixture.0.display())),
        fixture.0.join("../valid.env"),
    ] {
        assert!(load_readiness_deployment_environment_v1(&json!({}), Some(&path)).is_err());
    }
    assert!(load_readiness_deployment_environment_v1(&json!([]), None).is_err());
}
#[test]
fn inspection_exposes_names_and_hashes_without_loaded_values() {
    let fixture = Fixture::new();
    let marker = "synthetic-never-report-this-marker";
    let path = fixture.file("private.env", format!("ELAN_HOME='{marker}'"));
    let result = load_readiness_deployment_environment_v1(&json!({}), Some(&path)).unwrap();
    assert_eq!(result.environment["ELAN_HOME"], marker);
    assert!(!result.inspection.to_string().contains(marker));
    assert_eq!(result.inspection["credentialMaterialLoaded"], false);
    assert_eq!(
        parse_deployment_environment_file_v1("ELAN_HOME='${HOME}'").unwrap()["ELAN_HOME"],
        "${HOME}"
    );
}
