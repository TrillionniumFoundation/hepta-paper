use hepta_paper_service::runtime_source_cas::acquire_runtime_source_cas_from_seed_v1;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

fn unique_root(label: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "hepta-r-source-cas-seed-{label}-{}-{nonce}",
        std::process::id()
    ))
}

fn fixture(label: &str, package: &str, version: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let root = unique_root(label);
    let context = root.join("runtime-images/r-scientific");
    let seed = root.join("seed");
    let package_root = seed.join(package);
    fs::create_dir_all(&context).expect("context");
    fs::create_dir_all(&package_root).expect("package root");
    fs::write(
        context.join("renv.lock"),
        format!(
            "{{\"Packages\":{{\"{package}\":{{\"Package\":\"{package}\",\"Version\":\"{version}\",\"Source\":\"Repository\",\"Repository\":\"CRAN\"}}}}}}"
        ),
    )
    .expect("lock");
    fs::write(
        package_root.join("DESCRIPTION"),
        format!("Package: {package}\nVersion: {version}\nDescription: fixture\n"),
    )
    .expect("description");
    let archive = seed.join(format!("{package}_{version}.tar.gz"));
    let status = Command::new("tar")
        .args([
            "-czf",
            archive.to_str().expect("archive path"),
            "-C",
            seed.to_str().expect("seed path"),
            package,
        ])
        .status()
        .expect("tar");
    assert!(status.success(), "tar status: {status}");
    (root, seed)
}

fn remove(root: &Path) {
    let _ = fs::remove_dir_all(root);
}

fn oracle(requests: Value) -> Value {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(repository.join("rust/oracle/runtime-r-source-cas-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("oracle");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(requests.to_string().as_bytes())
        .expect("request");
    let output = child.wait_with_output().expect("oracle output");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("oracle JSON");
    assert_eq!(value["profile"]["node"], "v22.23.1");
    value
}

#[test]
fn seed_acquisition_checks_description_and_publishes_exactly_once() {
    let (root, seed) = fixture("valid", "demo", "1.0.0");
    let node_root = unique_root("node");
    fs::create_dir_all(node_root.join("runtime-images/r-scientific")).expect("node context");
    fs::copy(
        root.join("runtime-images/r-scientific/renv.lock"),
        node_root.join("runtime-images/r-scientific/renv.lock"),
    )
    .expect("node lock");
    let node =
        oracle(json!([{"action":"acquire","repositoryRoot":node_root,"seedSourceDirectory":seed}]));
    assert_eq!(node["results"][0]["ok"], true);
    let first = acquire_runtime_source_cas_from_seed_v1(&root, &seed).expect("acquire");
    assert_eq!(first, node["results"][0]["value"]);
    assert_eq!(first["ready"], true);
    assert_eq!(first["acquired"], true);
    assert_eq!(first["packageCount"], 1);
    let second = acquire_runtime_source_cas_from_seed_v1(&root, &seed).expect("reinspect");
    assert_eq!(second["ready"], true);
    assert_eq!(second["acquired"], false);
    assert!(
        root.join("runtime-images/r-scientific/source-cas/manifest.json")
            .is_file()
    );
    remove(&root);
    remove(&node_root);
}

#[test]
fn seed_acquisition_rejects_description_identity_and_cleans_staging() {
    let (root, seed) = fixture("mismatch", "demo", "1.0.0");
    fs::write(
        seed.join("demo/DESCRIPTION"),
        "Package: other\nVersion: 1.0.0\n",
    )
    .expect("tamper description");
    let status = Command::new("tar")
        .arg("-czf")
        .arg(seed.join("demo_1.0.0.tar.gz"))
        .arg("-C")
        .arg(&seed)
        .arg("demo")
        .status()
        .expect("rewrite archive");
    assert!(status.success());
    let error = acquire_runtime_source_cas_from_seed_v1(&root, &seed).expect_err("mismatch");
    assert_eq!(error, "description_identity_mismatch");
    let context = root.join("runtime-images/r-scientific");
    assert!(!context.join("source-cas").exists());
    assert_eq!(
        fs::read_dir(&context)
            .expect("context entries")
            .filter_map(Result::ok)
            .count(),
        1,
        "renv.lock only; owned staging must be removed"
    );
    remove(&root);
}

#[test]
fn seed_acquisition_refuses_existing_destination_without_clobbering() {
    let (root, seed) = fixture("existing", "demo", "1.0.0");
    let destination = root.join("runtime-images/r-scientific/source-cas");
    fs::create_dir_all(&destination).expect("destination");
    fs::write(destination.join("sentinel"), b"keep").expect("sentinel");
    let error = acquire_runtime_source_cas_from_seed_v1(&root, &seed).expect_err("existing");
    assert_eq!(error, "r_runtime_source_cas_existing_invalid");
    assert_eq!(
        fs::read(destination.join("sentinel")).expect("sentinel"),
        b"keep"
    );
    remove(&root);
}

#[cfg(unix)]
#[test]
fn seed_acquisition_rejects_symlinked_seed_entries_before_publication() {
    use std::os::unix::fs::symlink;
    let (root, seed) = fixture("symlink", "demo", "1.0.0");
    let outside = root.join("outside.tar.gz");
    fs::write(&outside, b"outside").expect("outside");
    let linked = seed.join("linked.tar.gz");
    symlink(&outside, &linked).expect("symlink");
    let error = acquire_runtime_source_cas_from_seed_v1(&root, &seed).expect_err("symlink");
    assert_eq!(error, "r_runtime_source_cas_seed_symlink_invalid");
    assert!(!root.join("runtime-images/r-scientific/source-cas").exists());
    remove(&root);
}

#[test]
fn seed_acquisition_cli_accepts_seed_and_rejects_duplicate_flags() {
    let (root, seed) = fixture("cli", "demo", "1.0.0");
    let binary = env!("CARGO_BIN_EXE_hepta-paper-rust");
    let acquired = Command::new(binary)
        .args([
            "runtime-r-source-cas",
            root.to_str().expect("repository root"),
            "--action",
            "acquire",
            "--seed",
            seed.to_str().expect("seed root"),
        ])
        .output()
        .expect("Rust CLI");
    assert!(
        acquired.status.success(),
        "{}",
        String::from_utf8_lossy(&acquired.stderr)
    );
    let report: Value = serde_json::from_slice(&acquired.stdout).expect("CLI report");
    assert_eq!(report["ready"], true);
    assert_eq!(report["acquired"], true);

    let duplicate = Command::new(binary)
        .args([
            "runtime-r-source-cas",
            root.to_str().expect("repository root"),
            "--action",
            "status",
            "--action",
            "acquire",
            "--seed",
            seed.to_str().expect("seed root"),
        ])
        .output()
        .expect("Rust CLI");
    assert!(!duplicate.status.success());
    assert!(String::from_utf8_lossy(&duplicate.stderr).contains("accepts ROOT"));
    remove(&root);
}
