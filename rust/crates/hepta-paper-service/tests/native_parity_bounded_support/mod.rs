use hepta_legacy_compatibility::qualify_production_node_profile_v1;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
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

pub fn oracle(script: &str, requests: &Value, sources: &[(&str, &[u8])]) -> Value {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let bytes = serde_json::to_vec(requests).expect("request bytes");
    assert!(bytes.len() <= 4 * 1024 * 1024, "bounded oracle input");
    let mut child = OwnedChild(
        Command::new("node")
            .arg(root.join(script))
            .current_dir(&root)
            .env_clear()
            .env(
                "PATH",
                std::env::var_os("PATH").expect("qualified Node search path"),
            )
            .env("LANG", "en_US.UTF-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("required pinned Node oracle"),
    );
    let mut input = child.0.stdin.take().expect("stdin");
    let writer = thread::spawn(move || input.write_all(&bytes));
    let reader = |pipe: Box<dyn Read + Send>| {
        thread::spawn(move || {
            let mut bytes = Vec::new();
            pipe.take(8 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .expect("bounded oracle output");
            bytes
        })
    };
    let stdout = reader(Box::new(child.0.stdout.take().expect("stdout")));
    let stderr = reader(Box::new(child.0.stderr.take().expect("stderr")));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.0.try_wait().expect("oracle status") {
            break status;
        }
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "owned oracle deadline"
        );
        thread::sleep(Duration::from_millis(10));
    };
    writer.join().expect("input writer").expect("oracle input");
    let stdout = stdout.join().expect("stdout reader");
    let stderr = stderr.join().expect("stderr reader");
    assert!(stdout.len() <= 8 * 1024 * 1024 && stderr.len() <= 8 * 1024 * 1024);
    assert!(
        status.success(),
        "oracle failure: {}",
        String::from_utf8_lossy(&stderr)
    );
    let value: Value = serde_json::from_slice(&stdout).expect("oracle JSON");
    qualify_production_node_profile_v1(&value["profile"])
        .expect("exact Node/ICU/CLDR/source profile");
    for (path, bytes) in sources {
        assert_eq!(
            value["sources"][path],
            hex::encode(Sha256::digest(bytes)),
            "actual source binding {path}"
        );
    }
    value
}
