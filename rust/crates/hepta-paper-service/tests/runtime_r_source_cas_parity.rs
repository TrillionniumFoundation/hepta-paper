//! Differential checks for the R source archive CAS verifier.

use hepta_legacy_compatibility::production_hash_record_v1;
use hepta_paper_service::runtime_source_cas::inspect_runtime_source_cas_v1;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
};

fn fixture(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let root =
        std::env::temp_dir().join(format!("hepta-r-source-cas-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let context = root.join("runtime-images/r-scientific");
    let cas = context.join("source-cas/src/contrib");
    fs::create_dir_all(&cas).expect("cas");
    fs::write(
        context.join("renv.lock"),
        r#"{"Packages":{"demo":{"Package":"demo","Version":"1.0.0","Source":"Repository","Repository":"CRAN"}}}"#,
    ).expect("lock");
    let bytes = vec![b'x'; 128];
    let archive = cas.join("demo_1.0.0.tar.gz");
    fs::write(&archive, &bytes).expect("archive");
    let lock_hash = format!(
        "sha256:{:x}",
        Sha256::digest(fs::read(context.join("renv.lock")).unwrap())
    );
    let sha = format!("sha256:{:x}", Sha256::digest(&bytes));
    let package = serde_json::json!({
        "package":"demo","version":"1.0.0","file":"demo_1.0.0.tar.gz",
        "url":"https://packagemanager.posit.co/cran/2024-11-01/src/contrib/demo_1.0.0.tar.gz",
        "bytes":128,"sha256":sha
    });
    let payload = serde_json::json!({
        "version":1,"kind":"RRuntimeSourceCasManifest","status":"r_runtime_source_cas_complete",
        "snapshot":"https://packagemanager.posit.co/cran/2024-11-01","lockfileHash":lock_hash,
        "packageCount":1,"packages":[package],"exactLockClosure":true,
        "allSourceArchivesContentHashed":true,"offlineRestoreRequired":true
    });
    let hash =
        production_hash_record_v1("RRuntimeSourceCasManifest", &payload).expect("manifest hash");
    let mut manifest = payload.as_object().unwrap().clone();
    manifest.insert(
        "rRuntimeSourceCasManifestHash".to_owned(),
        Value::String(hash.as_str().to_owned()),
    );
    fs::write(
        context.join("source-cas/manifest.json"),
        serde_json::to_vec(&Value::Object(manifest)).unwrap(),
    )
    .expect("manifest");
    fs::write(
        context.join("source-cas/SHA256SUMS"),
        format!(
            "{}  src/contrib/demo_1.0.0.tar.gz\n",
            sha.trim_start_matches("sha256:")
        )
        .as_bytes(),
    )
    .expect("sums");
    fs::write(context.join("source-cas/PACKAGES.tsv"), format!("Package\tVersion\tFile\tURL\tSHA256\ndemo\t1.0.0\tdemo_1.0.0.tar.gz\thttps://packagemanager.posit.co/cran/2024-11-01/src/contrib/demo_1.0.0.tar.gz\t{sha}\n").as_bytes()).expect("index");
    (root, archive)
}

fn oracle(requests: &Value) -> Value {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let script = root.join("rust/oracle/runtime-r-source-cas-v1.mjs");
    let mut child = Command::new("node")
        .arg(script)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("Node oracle");
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
fn source_cas_verifier_matches_node_for_verified_and_tampered_archives() {
    let (valid_root, _valid_archive) = fixture("valid");
    let (tampered_root, tampered_archive) = fixture("tampered");
    let (extra_root, _extra_archive) = fixture("extra-field");
    fs::write(&tampered_archive, vec![b'y'; 128]).expect("tamper");
    let manifest_path = extra_root.join("runtime-images/r-scientific/source-cas/manifest.json");
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(&manifest_path).expect("manifest read"))
            .expect("manifest JSON");
    manifest["packages"][0]["unexpected"] = Value::Bool(true);
    fs::write(
        &manifest_path,
        serde_json::to_vec(&manifest).expect("manifest write"),
    )
    .expect("manifest update");
    let requests = serde_json::json!([
        {"repositoryRoot": valid_root},
        {"repositoryRoot": tampered_root},
        {"repositoryRoot": extra_root}
    ]);
    let expected = oracle(&requests);
    let valid =
        inspect_runtime_source_cas_v1(requests[0]["repositoryRoot"].as_str().unwrap().as_ref());
    let tampered =
        inspect_runtime_source_cas_v1(requests[1]["repositoryRoot"].as_str().unwrap().as_ref());
    let extra =
        inspect_runtime_source_cas_v1(requests[2]["repositoryRoot"].as_str().unwrap().as_ref());
    assert_eq!(valid, expected["results"][0]["value"]);
    assert_eq!(tampered, expected["results"][1]["value"]);
    assert_eq!(extra, expected["results"][2]["value"]);
    let _ = fs::remove_dir_all(valid_root);
    let _ = fs::remove_dir_all(tampered_root);
    let _ = fs::remove_dir_all(extra_root);
}
