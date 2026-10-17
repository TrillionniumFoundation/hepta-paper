use serde_json::Value;
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub fn oracle(input: &Value, cwd: &Path) -> Value {
    let script =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../oracle/machine-intake-v1.mjs");
    let encoded = serde_json::to_string(input).expect("fixture input");
    assert!(encoded.len() < 64 * 1024, "bounded oracle argument");
    let mut command = Command::new("node");
    command
        .arg(script)
        .arg(encoded)
        .current_dir(cwd)
        .env_clear()
        .env(
            "PATH",
            std::env::var_os("PATH").expect("qualified Node search path"),
        )
        .env("LANG", "en_US.UTF-8");
    let output = run(&mut command);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let output: Value = serde_json::from_slice(&output.stdout).expect("oracle JSON");
    hepta_legacy_compatibility::qualify_production_node_profile_v1(&output["profile"])
        .expect("qualified executable and actual record-hash source");
    output["value"].clone()
}

/// Bounded and owned test process, also used for the real native and Node CLIs.
pub fn run(command: &mut Command) -> std::process::Output {
    let mut child = OwnedChild(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("actual test process"),
    );
    let stdout = child.0.stdout.take().expect("oracle stdout");
    let stderr = child.0.stderr.take().expect("oracle stderr");
    let reader = |pipe: Box<dyn Read + Send>| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            pipe.take(2 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .expect("bounded oracle output");
            bytes
        })
    };
    let stdout = reader(Box::new(stdout));
    let stderr = reader(Box::new(stderr));
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.0.try_wait().expect("oracle status") {
            break status;
        }
        assert!(
            start.elapsed() < Duration::from_secs(60),
            "oracle exceeded owned deadline"
        );
        thread::sleep(Duration::from_millis(10));
    };
    let stdout = stdout.join().expect("stdout reader");
    let stderr = stderr.join().expect("stderr reader");
    assert!(stdout.len() <= 2 * 1024 * 1024 && stderr.len() <= 2 * 1024 * 1024);
    std::process::Output {
        status,
        stdout,
        stderr,
    }
}
