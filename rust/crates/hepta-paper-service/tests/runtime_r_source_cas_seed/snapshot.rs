//! Ordinary CLI transport-boundary fixtures, not live HTTPS qualification.
//! The selected curl fixture emits real archive bytes; tar, CAS and publication
//! are the existing owners. A separate live probe is not a hermetic CI test.
use super::*;
use std::{os::unix::fs::PermissionsExt, path::PathBuf};

fn transport(root: &Path, seed: &Path, mode: &str) -> PathBuf {
    let tools = root.join("snapshot-tools");
    fs::create_dir_all(&tools).unwrap();
    let archive = seed.join("demo_1.0.0.tar.gz");
    let script = format!(
        r##"#!/usr/bin/python3
import json, os, pathlib, sys, time
root = pathlib.Path({root:?})
args = sys.argv[1:]
assert args[0] == '--disable'
assert args[args.index('--proto') + 1] == '=https'
assert args[args.index('--proxy') + 1] == ''
assert args[args.index('--noproxy') + 1] == '*'
assert args[args.index('--request') + 1] == 'GET'
assert '--location' not in args and '--insecure' not in args
assert not any(key in os.environ for key in ['CURL_HOME', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'TOKEN'])
url = args[args.index('--url') + 1]
assert url == 'https://packagemanager.posit.co/cran/2024-11-01/src/contrib/demo_1.0.0.tar.gz'
with (root / 'snapshot-calls.jsonl').open('a') as out:
    out.write(json.dumps(args) + '\n')
mode = {mode:?}
if mode == 'unknown':
    child = os.fork()
    if child == 0:
        os.setsid()
        time.sleep(30)
        os._exit(0)
    (root / 'escaped.pid').write_text(str(child))
    raise SystemExit(0)
if mode == 'wait':
    os.close(1)
    os.close(2)
    (root / 'curl.pid').write_text(str(os.getpid()))
    time.sleep(30)
    raise SystemExit(0)
body = pathlib.Path({archive:?}).read_bytes()
if mode == 'truncated':
    sys.stdout.buffer.write(body)
    raise SystemExit(0)
status = '302' if mode == 'redirect' else '404' if mode == 'missing' else '200'
if mode == 'wrong-url':
    url = 'https://example.invalid/outside.tar.gz'
if mode == 'bad-archive':
    body = b'not an archive'
sys.stdout.buffer.write(body + ('\nHEPTA_R_SOURCE_HTTP_V1\n' + status + '\n' + url + '\n').encode())
"##,
        root = root.to_str().unwrap(),
        archive = archive.to_str().unwrap(),
    );
    let tool = tools.join("curl");
    fs::write(&tool, script).unwrap();
    fs::set_permissions(&tool, fs::Permissions::from_mode(0o700)).unwrap();
    tools
}

fn command(root: &Path, tools: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"));
    command
        .arg("runtime-r-source-cas")
        .arg(root)
        .args(["--action", "acquire", "--snapshot"])
        .env("PATH", format!("{}:/usr/bin:/bin", tools.display()))
        .env("CURL_HOME", root.join("must-not-read"))
        .env("CURL_CA_BUNDLE", "/must-not-read-ca")
        .env("SSL_CERT_FILE", "/must-not-read-ssl")
        .env("HTTPS_PROXY", "http://must-not-contact.invalid")
        .env("TOKEN", "nonsecret-injection-marker");
    command
}

#[test]
fn ordinary_snapshot_acquisition_uses_existing_publisher_and_replays_offline() {
    let (root, seed) = fixture("snapshot", "demo", "1.0.0");
    let tools = transport(&root, &seed, "success");
    let output = command(&root, &tools).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["ready"], true);
    assert_eq!(report["acquired"], true);
    let cas = root.join("runtime-images/r-scientific/source-cas");
    assert_eq!(
        fs::read(cas.join("src/contrib/demo_1.0.0.tar.gz")).unwrap(),
        fs::read(seed.join("demo_1.0.0.tar.gz")).unwrap()
    );
    let mut node = oracle(json!([{"action":"status","repositoryRoot":root}]));
    node["results"][0]["value"]["acquired"] = json!(true);
    assert_eq!(report, node["results"][0]["value"]);
    let manifest = fs::read(cas.join("manifest.json")).unwrap();
    let calls = fs::read(root.join("snapshot-calls.jsonl")).unwrap();
    let replay = command(&root, &root.join("no-tools"))
        .env("PATH", "/no-tools")
        .output()
        .unwrap();
    assert!(
        replay.status.success(),
        "{}",
        String::from_utf8_lossy(&replay.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&replay.stdout).unwrap()["acquired"],
        false
    );
    assert_eq!(fs::read(root.join("snapshot-calls.jsonl")).unwrap(), calls);
    assert_eq!(fs::read(cas.join("manifest.json")).unwrap(), manifest);
    remove(&root);
}

#[test]
fn ordinary_snapshot_refuses_http_and_wire_failures_without_publication() {
    for (mode, expected) in [
        ("missing", "snapshot_http_404"),
        ("redirect", "snapshot_http_302"),
        ("wrong-url", "snapshot_response_invalid"),
        ("truncated", "snapshot_response_invalid"),
        ("bad-archive", "archive_too_small"),
    ] {
        let (root, seed) = fixture(mode, "demo", "1.0.0");
        let lock = fs::read(root.join("runtime-images/r-scientific/renv.lock")).unwrap();
        let tools = transport(&root, &seed, mode);
        for _ in 0..2 {
            let output = command(&root, &tools).output().unwrap();
            assert!(!output.status.success(), "{mode}");
            assert!(
                String::from_utf8_lossy(&output.stderr).contains(expected),
                "{mode}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let context = root.join("runtime-images/r-scientific");
            assert!(!context.join("source-cas").exists());
            assert_eq!(fs::read(context.join("renv.lock")).unwrap(), lock);
            assert_eq!(fs::read_dir(&context).unwrap().count(), 1);
        }
        transport(&root, &seed, "success");
        assert!(command(&root, &tools).output().unwrap().status.success());
        remove(&root);
    }
}

#[test]
fn ordinary_snapshot_requires_explicit_exclusive_mode_before_any_transport() {
    let (root, seed) = fixture("snapshot-parser", "demo", "1.0.0");
    let tools = transport(&root, &seed, "success");
    for extra in [vec!["--snapshot"], vec!["--seed", "/absent"]] {
        let output = command(&root, &tools).args(extra).output().unwrap();
        assert!(!output.status.success());
        assert!(!root.join("snapshot-calls.jsonl").exists());
    }
    let status = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("runtime-r-source-cas")
        .arg(&root)
        .args(["--action", "status", "--snapshot"])
        .env("PATH", tools)
        .output()
        .unwrap();
    assert!(!status.status.success());
    assert!(!root.join("snapshot-calls.jsonl").exists());
    remove(&root);
}

#[test]
fn ordinary_snapshot_signals_stop_transport_after_eof_and_preserve_retry() {
    use nix::{
        sys::signal::{Signal, kill, killpg},
        unistd::Pid,
    };
    use std::{
        os::unix::process::CommandExt,
        thread,
        time::{Duration, Instant},
    };
    for signal in [Signal::SIGINT, Signal::SIGTERM] {
        let (root, seed) = fixture("snapshot-signal", "demo", "1.0.0");
        let tools = transport(&root, &seed, "wait");
        let mut child = command(&root, &tools)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let marker = root.join("curl.pid");
        let until = Instant::now() + Duration::from_secs(15);
        while fs::read_to_string(&marker)
            .ok()
            .and_then(|s| s.parse::<i32>().ok())
            .filter(|p| *p > 1)
            .is_none()
            && Instant::now() < until
        {
            thread::sleep(Duration::from_millis(5));
        }
        let transport_pid = fs::read_to_string(&marker)
            .ok()
            .and_then(|s| s.parse::<i32>().ok());
        let cli_pid = Pid::from_raw(child.id().try_into().unwrap());
        let _ = kill(cli_pid, signal);
        let until = Instant::now() + Duration::from_secs(4);
        while child.try_wait().unwrap().is_none() && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        let exited = child.try_wait().unwrap().is_some();
        let survived = transport_pid.is_some_and(|pid| kill(Pid::from_raw(pid), None).is_ok());
        let _ = killpg(cli_pid, Signal::SIGKILL);
        if let Some(pid) = transport_pid {
            let _ = killpg(Pid::from_raw(pid), Signal::SIGKILL);
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            transport_pid.is_some(),
            "transport not reached: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            exited && !survived,
            "existing process-group owner must stop curl"
        );
        assert_eq!(output.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&output.stderr).contains("r_runtime_source_cas_cancelled"));
        let context = root.join("runtime-images/r-scientific");
        assert_eq!(fs::read_dir(&context).unwrap().count(), 1);
        transport(&root, &seed, "success");
        assert!(command(&root, &tools).output().unwrap().status.success());
        remove(&root);
    }
}

#[test]
fn ordinary_snapshot_process_death_preserves_unpublished_archive_and_restarts_once() {
    use nix::{
        sys::signal::{Signal, kill, killpg},
        unistd::Pid,
    };
    use std::{
        os::unix::process::CommandExt,
        thread,
        time::{Duration, Instant},
    };
    let (root, seed) = fixture("snapshot-crash", "demo", "1.0.0");
    let tools = transport(&root, &seed, "success");
    let marker = root.join("verification.pid");
    let tar = tools.join("tar");
    fs::write(&tar, format!("#!/usr/bin/python3\nimport os,pathlib,time\npathlib.Path({:?}).write_text(str(os.getpid()))\nos.close(1)\nos.close(2)\ntime.sleep(30)\n", marker.to_str().unwrap())).unwrap();
    fs::set_permissions(&tar, fs::Permissions::from_mode(0o700)).unwrap();
    let child = command(&root, &tools)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(15);
    while fs::read_to_string(&marker)
        .ok()
        .and_then(|s| s.parse::<i32>().ok())
        .filter(|p| *p > 1)
        .is_none()
        && Instant::now() < until
    {
        thread::sleep(Duration::from_millis(5));
    }
    let verifier = fs::read_to_string(&marker)
        .ok()
        .and_then(|s| s.parse::<i32>().ok());
    let cli_pid = Pid::from_raw(child.id().try_into().unwrap());
    let _ = kill(cli_pid, Signal::SIGKILL);
    if let Some(pid) = verifier {
        let _ = killpg(Pid::from_raw(pid), Signal::SIGKILL);
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        verifier.is_some(),
        "archive verifier not reached: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!output.status.success());
    let context = root.join("runtime-images/r-scientific");
    assert!(!context.join("source-cas").exists());
    let orphans: Vec<_> = fs::read_dir(&context)
        .unwrap()
        .map(|r| r.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".source-cas.staging-")
        })
        .collect();
    assert_eq!(orphans.len(), 1);
    let orphan_archive = orphans[0].join("src/contrib/demo_1.0.0.tar.gz");
    let retained = fs::read(&orphan_archive).unwrap();
    assert_eq!(retained, fs::read(seed.join("demo_1.0.0.tar.gz")).unwrap());
    fs::remove_file(&tar).unwrap();
    let retry = command(&root, &tools).output().unwrap();
    assert!(
        retry.status.success(),
        "{}",
        String::from_utf8_lossy(&retry.stderr)
    );
    assert_eq!(
        fs::read(&orphan_archive).unwrap(),
        retained,
        "orphan never adopted or removed"
    );
    let published = context.join("source-cas/src/contrib/demo_1.0.0.tar.gz");
    assert_eq!(fs::read(&published).unwrap(), retained);
    let replay = command(&root, &tools)
        .env("PATH", "/no-tools")
        .output()
        .unwrap();
    assert!(replay.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&replay.stdout).unwrap()["acquired"],
        false
    );
    remove(&root);
}

#[test]
fn ordinary_snapshot_unknown_transport_cleanup_retains_original_stage() {
    use nix::{
        sys::signal::{Signal, kill},
        unistd::Pid,
    };
    let (root, seed) = fixture("snapshot-unknown", "demo", "1.0.0");
    let tools = transport(&root, &seed, "unknown");
    let output = command(&root, &tools).output().unwrap();
    let escaped = fs::read_to_string(root.join("escaped.pid"))
        .ok()
        .and_then(|s| s.parse::<i32>().ok())
        .filter(|p| *p > 1);
    if let Some(pid) = escaped {
        let _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
    }
    assert!(escaped.is_some());
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("snapshot_cleanup_unverified"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let context = root.join("runtime-images/r-scientific");
    assert!(!context.join("source-cas").exists());
    let stages: Vec<_> = fs::read_dir(&context)
        .unwrap()
        .map(|r| r.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".source-cas.staging-")
        })
        .collect();
    assert_eq!(
        stages.len(),
        1,
        "unknown cleanup cannot delete the process workspace"
    );
    assert!(stages[0].join("src/contrib").is_dir());
    remove(&root);
}
