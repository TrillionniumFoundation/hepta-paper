//! Kernel parent-death regression; deliberately uses waitpid rather than /proc PID paths.
use nix::{
    sys::{
        prctl::set_child_subreaper,
        signal::{Signal, kill},
        wait::{WaitPidFlag, WaitStatus, waitpid},
    },
    unistd::Pid,
};
use std::{
    fs,
    process::Command,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const STAGE: &str = "HEPTA_GATE_PARENT_DEATH_TEST_STAGE";
const ROOT: &str = "HEPTA_GATE_PARENT_DEATH_TEST_ROOT";
const TEST: &str = "unlinked_stopped_gate_dies_when_its_broker_exits";

#[test]
fn unlinked_stopped_gate_dies_when_its_broker_exits() {
    let executable = std::env::current_exe().expect("test executable");
    match std::env::var(STAGE).ok().as_deref() {
        Some("parent") => {
            let root = std::path::PathBuf::from(std::env::var_os(ROOT).expect("fixture root"));
            let child = Command::new(env!("CARGO_BIN_EXE_hepta-codex-preexec-gate"))
                .arg("--envelope")
                .arg(root.join("never-released-envelope"))
                .arg("--expected-hash")
                .arg(format!("sha256:{}", "0".repeat(64)))
                .arg("--parent-pid")
                .arg(std::process::id().to_string())
                .spawn()
                .expect("spawn unlinked gate");
            let pid = Pid::from_raw(i32::try_from(child.id()).expect("pid"));
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match waitpid(pid, Some(WaitPidFlag::WUNTRACED | WaitPidFlag::WNOHANG))
                    .expect("observe stopped gate")
                {
                    WaitStatus::Stopped(_, Signal::SIGSTOP) => break,
                    WaitStatus::StillAlive if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    status => {
                        let _ = kill(pid, Signal::SIGKILL);
                        panic!("gate did not stop: {status:?}");
                    }
                }
            }
            fs::write(root.join("gate.pid"), child.id().to_string()).expect("persist test pid");
            // Deliberate broker crash before journal linkage: no Child drop cleanup.
            std::process::exit(0);
        }
        Some("supervisor") => {
            set_child_subreaper(true).expect("isolated test supervisor subreaper");
            let status = Command::new(&executable)
                .args(["--exact", TEST, "--nocapture"])
                .env(STAGE, "parent")
                .status()
                .expect("run broker helper");
            assert!(status.success());
            let root = std::path::PathBuf::from(std::env::var_os(ROOT).expect("fixture root"));
            let raw = fs::read_to_string(root.join("gate.pid"))
                .expect("test pid")
                .parse::<i32>()
                .expect("pid integer");
            let pid = Pid::from_raw(raw);
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match waitpid(pid, Some(WaitPidFlag::WNOHANG)).expect("reap adopted gate") {
                    WaitStatus::Signaled(_, Signal::SIGKILL, _) => break,
                    WaitStatus::StillAlive if Instant::now() < deadline => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    status => {
                        let _ = kill(pid, Signal::SIGKILL);
                        let _ = waitpid(pid, None);
                        panic!("orphaned gate survived parent death: {status:?}");
                    }
                }
            }
        }
        _ => {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "hepta-gate-parent-death-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir(&root).expect("fixture directory");
            let result = Command::new(&executable)
                .args(["--exact", TEST, "--nocapture"])
                .env(STAGE, "supervisor")
                .env(ROOT, &root)
                .status()
                .expect("run isolated supervisor");
            fs::remove_dir_all(root).expect("remove fixture");
            assert!(result.success());
        }
    }
}
