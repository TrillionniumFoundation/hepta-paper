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

// The runtime crate supports Unix only; every supported build must execute this test.
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

#[test]
fn ordinary_cli_replay_needs_no_seed_or_tar_and_preserves_published_files() {
    use std::{collections::BTreeMap, os::unix::fs::MetadataExt};
    let (root, seed) = fixture("offline-replay", "demo", "1.0.0");
    let binary = env!("CARGO_BIN_EXE_hepta-paper-rust");
    let first = Command::new(binary)
        .arg("runtime-r-source-cas")
        .arg(&root)
        .args(["--action", "acquire", "--seed"])
        .arg(&seed)
        .output()
        .unwrap();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let first: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(first["acquired"], true);
    let context = root.join("runtime-images/r-scientific");
    let capture = || {
        first["definitionPaths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| {
                let name = name.as_str().unwrap();
                let path = context.join(name);
                let metadata = fs::symlink_metadata(&path).unwrap();
                (
                    name.to_owned(),
                    (metadata.dev(), metadata.ino(), fs::read(path).unwrap()),
                )
            })
            .collect::<BTreeMap<_, _>>()
    };
    let before = capture();
    fs::remove_dir_all(&seed).unwrap();
    let retry = Command::new(binary)
        .env_clear()
        .env("PATH", root.join("no-executables"))
        .arg("runtime-r-source-cas")
        .arg(&root)
        .args(["--action", "acquire", "--seed"])
        .arg(&seed)
        .output()
        .unwrap();
    assert!(
        retry.status.success(),
        "{}",
        String::from_utf8_lossy(&retry.stderr)
    );
    let mut retry: Value = serde_json::from_slice(&retry.stdout).unwrap();
    assert_eq!(retry["acquired"], false);
    retry["acquired"] = Value::Bool(true);
    assert_eq!(retry, first);
    assert_eq!(capture(), before);
    remove(&root);
}

#[test]
fn ordinary_cli_signal_terminates_tar_after_stdout_closes_without_publishing() {
    use nix::{
        sys::signal::{Signal, kill, killpg},
        unistd::Pid,
    };
    use std::{
        os::unix::{fs::PermissionsExt, process::CommandExt},
        thread,
        time::{Duration, Instant},
    };
    for signal in [Signal::SIGINT, Signal::SIGTERM] {
        let (root, seed) = fixture("tar-signal", "demo", "1.0.0");
        let tools = root.join("tools");
        fs::create_dir(&tools).unwrap();
        let pid_path = root.join("tar.pid");
        let tool = tools.join("tar");
        fs::write(&tool, format!("#!/bin/sh\nprintf '%s' \"$$\" > '{}'\nexec 1>&- 2>&-\ntrap '' TERM INT\nsleep 30\n", pid_path.display())).unwrap();
        fs::set_permissions(&tool, fs::Permissions::from_mode(0o700)).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
            .arg("runtime-r-source-cas")
            .arg(&root)
            .args(["--action", "acquire", "--seed"])
            .arg(&seed)
            .env("PATH", format!("{}:/usr/bin:/bin", tools.display()))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let until = Instant::now() + Duration::from_secs(10);
        while !pid_path.exists() && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        let reached = pid_path.exists();
        let tar_pid = reached.then(|| {
            fs::read_to_string(&pid_path)
                .unwrap()
                .parse::<i32>()
                .unwrap()
        });
        let cli_pid = Pid::from_raw(child.id().try_into().unwrap());
        let began = Instant::now();
        let _ = kill(cli_pid, signal);
        while child.try_wait().unwrap().is_none() && began.elapsed() < Duration::from_secs(4) {
            thread::sleep(Duration::from_millis(5));
        }
        let exited = child.try_wait().unwrap().is_some();
        let tar_survived = tar_pid.is_some_and(|pid| kill(Pid::from_raw(pid), None).is_ok());
        // Always clean only these fixture-owned groups before asserting a red case.
        let _ = killpg(cli_pid, Signal::SIGKILL);
        if let Some(pid) = tar_pid {
            let _ = killpg(Pid::from_raw(pid), Signal::SIGKILL);
            let _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            reached,
            "tar fixture was not reached: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(exited, "CLI cancellation deadline");
        assert!(!tar_survived, "tar survived its ordinary CLI cancellation");
        assert_eq!(output.status.code(), Some(1));
        assert!(!root.join("runtime-images/r-scientific/source-cas").exists());
        assert!(seed.join("demo_1.0.0.tar.gz").exists());
        remove(&root);
    }
}

#[test]
fn ordinary_cli_tar_ignores_inherited_option_injection() {
    let (root, seed) = fixture("tar-env", "demo", "1.0.0");
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("runtime-r-source-cas")
        .arg(&root)
        .args(["--action", "acquire", "--seed"])
        .arg(&seed)
        .env("TAR_OPTIONS", "--hepta-invalid-inherited-option")
        .env("GZIP", "--hepta-invalid-inherited-option")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["acquired"], true);
    remove(&root);
}

#[test]
fn ordinary_cli_unknown_tar_cleanup_retains_original_unpublished_stage() {
    use nix::{
        sys::signal::{Signal, killpg},
        unistd::Pid,
    };
    use std::{os::unix::fs::PermissionsExt, thread, time::Duration};
    let (root, seed) = fixture("tar-unknown", "demo", "1.0.0");
    let tools = root.join("tools");
    fs::create_dir(&tools).unwrap();
    let pid_path = root.join("escaped.pid");
    let tool = tools.join("tar");
    fs::write(&tool, format!("#!/bin/sh\n/usr/bin/setsid /bin/sh -c 'echo $$ > \"{}\"; sleep 30' &\nwhile [ ! -s '{}' ]; do sleep 0.01; done\nexit 0\n", pid_path.display(), pid_path.display())).unwrap();
    fs::set_permissions(&tool, fs::Permissions::from_mode(0o700)).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("runtime-r-source-cas")
        .arg(&root)
        .args(["--action", "acquire", "--seed"])
        .arg(&seed)
        .env("PATH", format!("{}:/usr/bin:/bin", tools.display()))
        .output()
        .unwrap();
    let escaped = fs::read_to_string(&pid_path)
        .unwrap()
        .trim()
        .parse::<i32>()
        .unwrap();
    let _ = killpg(Pid::from_raw(escaped), Signal::SIGKILL);
    thread::sleep(Duration::from_millis(30));
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("r_runtime_source_cas_archive_cleanup_unverified")
    );
    let context = root.join("runtime-images/r-scientific");
    assert!(!context.join("source-cas").exists());
    let stages = fs::read_dir(&context)
        .unwrap()
        .map(|x| x.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".source-cas.staging-")
        })
        .collect::<Vec<_>>();
    assert_eq!(stages.len(), 1, "unconfirmed cleanup must retain the stage");
    assert_eq!(
        fs::read(stages[0].join("src/contrib/demo_1.0.0.tar.gz")).unwrap(),
        fs::read(seed.join("demo_1.0.0.tar.gz")).unwrap()
    );
    remove(&root);
}
