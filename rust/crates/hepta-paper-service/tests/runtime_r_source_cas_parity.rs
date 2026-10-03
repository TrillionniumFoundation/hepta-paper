//! Differential checks for the R source archive CAS verifier.

use hepta_legacy_compatibility::production_hash_record_v1;
use hepta_paper_service::runtime_source_cas::inspect_runtime_source_cas_v1;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    os::unix::fs::FileTypeExt,
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
    let (uppercase_root, _uppercase_archive) = fixture("uppercase-hash");
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
    let uppercase_manifest_path =
        uppercase_root.join("runtime-images/r-scientific/source-cas/manifest.json");
    let mut uppercase_manifest: Value =
        serde_json::from_slice(&fs::read(&uppercase_manifest_path).expect("manifest read"))
            .expect("manifest JSON");
    let original_hash = uppercase_manifest["packages"][0]["sha256"]
        .as_str()
        .expect("archive hash");
    uppercase_manifest["packages"][0]["sha256"] = Value::String(format!(
        "sha256:{}",
        original_hash.trim_start_matches("sha256:").to_uppercase()
    ));
    uppercase_manifest
        .as_object_mut()
        .expect("manifest object")
        .remove("rRuntimeSourceCasManifestHash");
    let rebound_hash = production_hash_record_v1("RRuntimeSourceCasManifest", &uppercase_manifest)
        .expect("rebound manifest hash");
    uppercase_manifest["rRuntimeSourceCasManifestHash"] =
        Value::String(rebound_hash.as_str().to_owned());
    fs::write(
        &uppercase_manifest_path,
        serde_json::to_vec(&uppercase_manifest).expect("manifest write"),
    )
    .expect("uppercase manifest update");
    let requests = serde_json::json!([
        {"repositoryRoot": valid_root},
        {"repositoryRoot": tampered_root},
        {"repositoryRoot": extra_root},
        {"repositoryRoot": uppercase_root}
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
    let uppercase =
        inspect_runtime_source_cas_v1(requests[3]["repositoryRoot"].as_str().unwrap().as_ref());
    assert_eq!(uppercase, expected["results"][3]["value"]);
    assert_eq!(
        uppercase["blockers"][0],
        "r_runtime_source_cas_manifest_drift"
    );
    let _ = fs::remove_dir_all(valid_root);
    let _ = fs::remove_dir_all(tampered_root);
    let _ = fs::remove_dir_all(extra_root);
    let _ = fs::remove_dir_all(uppercase_root);
}

fn bounded_native_status(root: &std::path::Path) -> (std::process::Output, bool) {
    bounded_native_cas(root, &["--action", "status"])
}
fn bounded_native_cas(root: &std::path::Path, args: &[&str]) -> (std::process::Output, bool) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("runtime-r-source-cas")
        .arg(root)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = std::time::Instant::now();
    let mut timed_out = false;
    while child.try_wait().unwrap().is_none() {
        if started.elapsed() > std::time::Duration::from_secs(3) {
            child.kill().unwrap();
            timed_out = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    (child.wait_with_output().unwrap(), timed_out)
}

#[test]
fn native_status_refuses_fifo_inputs_without_waiting_for_a_writer() {
    let mut timeouts = Vec::new();
    for (name, relative) in [
        ("fifo-lock", "renv.lock"),
        ("fifo-manifest", "source-cas/manifest.json"),
    ] {
        let (root, _) = fixture(name);
        let input = root.join("runtime-images/r-scientific").join(relative);
        fs::remove_file(&input).unwrap();
        nix::unistd::mkfifo(
            &input,
            nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
        )
        .unwrap();
        let (output, timed_out) = bounded_native_status(&root);
        if timed_out {
            timeouts.push(relative);
        } else {
            assert!(!output.status.success());
            let report: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(report["ready"], false);
            assert!(fs::symlink_metadata(&input).unwrap().file_type().is_fifo());
        }
        fs::remove_dir_all(&root).unwrap();
    }
    assert!(
        timeouts.is_empty(),
        "ordinary status waited for FIFO writers: {timeouts:?}"
    );
}

#[test]
fn native_status_refuses_manifest_symlink_instead_of_following_it() {
    let (root, _) = fixture("manifest-link");
    let manifest = root.join("runtime-images/r-scientific/source-cas/manifest.json");
    let target = root.join("external-manifest.json");
    fs::rename(&manifest, &target).unwrap();
    let before = fs::read(&target).unwrap();
    std::os::unix::fs::symlink(&target, &manifest).unwrap();
    let (output, timed_out) = bounded_native_status(&root);
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(!timed_out);
    assert_eq!(report["ready"], false);
    assert_eq!(fs::read(&target).unwrap(), before);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_status_bounds_documents_and_archives_before_reading_sparse_inputs() {
    for (name, relative, length) in [
        ("large-lock", "renv.lock", 16 * 1024 * 1024 + 1),
        (
            "large-manifest",
            "source-cas/manifest.json",
            16 * 1024 * 1024 + 1,
        ),
        ("large-sums", "source-cas/SHA256SUMS", 16 * 1024 * 1024 + 1),
        (
            "large-index",
            "source-cas/PACKAGES.tsv",
            16 * 1024 * 1024 + 1,
        ),
        (
            "large-archive",
            "source-cas/src/contrib/demo_1.0.0.tar.gz",
            256 * 1024 * 1024 + 1,
        ),
    ] {
        let (root, _) = fixture(name);
        let input = root.join("runtime-images/r-scientific").join(relative);
        let file = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&input)
            .unwrap();
        file.set_len(length).unwrap();
        drop(file);
        let before = fs::metadata(&input).unwrap();
        let (output, timed_out) = bounded_native_status(&root);
        assert!(!timed_out, "{relative} was not bounded before reading");
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["ready"], false);
        assert_eq!(
            report["blockers"][0], "r_runtime_source_cas_observation_limit_exceeded",
            "{relative}: {report}"
        );
        assert_eq!(fs::metadata(&input).unwrap().len(), before.len());
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn native_status_refuses_deep_empty_directory_closure_and_linked_fifo() {
    let (root, archive) = fixture("deep-empty");
    let original = fs::read(&archive).unwrap();
    let mut directory = root.join("runtime-images/r-scientific/source-cas");
    for _ in 0..65 {
        directory = directory.join("nested");
        fs::create_dir(&directory).unwrap();
    }
    let (output, timed_out) = bounded_native_status(&root);
    assert!(!timed_out);
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["blockers"][0],
        "r_runtime_source_cas_observation_depth_exceeded"
    );
    assert_eq!(fs::read(&archive).unwrap(), original);
    assert!(directory.is_dir());
    fs::remove_dir_all(root).unwrap();
    let (root, _) = fixture("linked-fifo");
    let target = root.join("fifo");
    nix::unistd::mkfifo(
        &target,
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    let manifest = root.join("runtime-images/r-scientific/source-cas/manifest.json");
    fs::remove_file(&manifest).unwrap();
    std::os::unix::fs::symlink(&target, &manifest).unwrap();
    let (output, timed_out) = bounded_native_status(&root);
    assert!(!timed_out, "status followed a link to an unreadable FIFO");
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ready"], false);
    assert!(fs::symlink_metadata(target).unwrap().file_type().is_fifo());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn ordinary_acquisition_rejects_fifo_replay_and_initial_lock_without_publication() {
    for (name, initial, relative) in [
        ("replay-fifo-lock", false, "renv.lock"),
        ("replay-fifo-manifest", false, "source-cas/manifest.json"),
        ("initial-fifo-lock", true, "renv.lock"),
    ] {
        let (root, archive) = fixture(name);
        let context = root.join("runtime-images/r-scientific");
        let before = fs::read(&archive).unwrap();
        if initial {
            fs::remove_dir_all(context.join("source-cas")).unwrap();
        }
        let input = context.join(relative);
        fs::remove_file(&input).unwrap();
        nix::unistd::mkfifo(
            &input,
            nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
        )
        .unwrap();
        let (output, timed_out) = bounded_native_cas(
            &root,
            &["--action", "acquire", "--seed", "/unconsumed-missing-seed"],
        );
        assert!(
            !timed_out,
            "{relative}: acquire entered the blocking status/lock read"
        );
        assert!(!output.status.success());
        assert!(fs::read_dir(&context).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".source-cas.staging-")
        }));
        assert!(fs::symlink_metadata(&input).unwrap().file_type().is_fifo());
        if initial {
            assert!(!context.join("source-cas").exists());
        } else {
            assert_eq!(fs::read(&archive).unwrap(), before);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
