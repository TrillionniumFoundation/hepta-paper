//! CLI parity for the Node logical-integrity command's implicit database path.
//!
//! The Node entrypoint accepts no positional argument and resolves
//! `HEPTA_PAPER_RUNTIME_ROOT/hepta-paper.sqlite`.  The native command must
//! preserve that default while retaining its explicit-path form.

use rusqlite::Connection;
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

struct Fixture {
    root: PathBuf,
    runtime: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-store-integrity-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("fixture root");
        let workspace = root.join("workspace");
        let assets = root.join("assets");
        let runtime = root.join("runtime");
        let legacy = root.join("legacy");
        for path in [&workspace, &assets, &runtime, &legacy] {
            fs::create_dir_all(path).expect("fixture directory");
        }
        let migration = Command::new("node")
            .current_dir(repository_root())
            .arg("paper-core/bin/hepta-store.mjs")
            .arg("migrate")
            .env("HEPTA_PAPER_WORKSPACE_ROOT", &workspace)
            .env("HEPTA_PAPER_ASSET_ROOT", &assets)
            .env("HEPTA_PAPER_RUNTIME_ROOT", &runtime)
            .env("PAPER_FACTORY_LEGACY_ROOT", &legacy)
            .env("NODE_NO_WARNINGS", "1")
            .output()
            .expect("Node migration");
        assert!(
            migration.status.success(),
            "Node migration failed: {}",
            String::from_utf8_lossy(&migration.stderr)
        );
        // The migration writer leaves a WAL beside the database under Node's
        // sqlite runtime.  Checkpoint it before handing the immutable file to
        // either logical-integrity command so both routes inspect the same
        // durable bytes and the read-only Rust opener can enforce its
        // sidecar-free contract.
        let database = runtime.join("hepta-paper.sqlite");
        Connection::open(&database)
            .expect("checkpoint connection")
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .expect("checkpoint migration WAL");
        for suffix in ["-wal", "-shm", "-journal"] {
            let _ = fs::remove_file(format!("{}{suffix}", database.display()));
        }
        Self { root, runtime }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn env_for(fixture: &Fixture) -> [(&'static str, &std::path::Path); 1] {
    [("HEPTA_PAPER_RUNTIME_ROOT", fixture.runtime.as_path())]
}

#[test]
fn implicit_runtime_database_matches_node_entrypoint() -> Result<(), Box<dyn std::error::Error>> {
    let fixture = Fixture::new();
    let node = Command::new("node")
        .current_dir(repository_root())
        .arg("paper-core/bin/hepta-store-logical-integrity.mjs")
        .env("NODE_NO_WARNINGS", "1")
        .envs(env_for(&fixture))
        .output()?;
    // Node's read-only sqlite opener may leave zero-length WAL/SHM markers
    // after closing.  They do not carry logical data here, but the native
    // immutable opener intentionally rejects any active sidecar, so clear
    // those markers before running the second implementation.
    let database = fixture.runtime.join("hepta-paper.sqlite");
    for suffix in ["-wal", "-shm", "-journal"] {
        let _ = fs::remove_file(format!("{}{suffix}", database.display()));
    }
    let native = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .current_dir(repository_root())
        .arg("store-integrity")
        .envs(env_for(&fixture))
        .output()?;
    assert_eq!(
        native.status.code(),
        node.status.code(),
        "native stderr={} node stderr={} native stdout={} node stdout={}",
        String::from_utf8_lossy(&native.stderr),
        String::from_utf8_lossy(&node.stderr),
        String::from_utf8_lossy(&native.stdout),
        String::from_utf8_lossy(&node.stdout)
    );
    assert_eq!(native.stderr, node.stderr);
    let node_json: Value = serde_json::from_slice(&node.stdout)?;
    let native_json: Value = serde_json::from_slice(&native.stdout)?;
    assert_eq!(native_json, node_json);
    assert_eq!(
        native_json["dbPath"],
        fixture
            .runtime
            .join("hepta-paper.sqlite")
            .display()
            .to_string()
    );

    let explicit = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .current_dir(repository_root())
        .args([
            "store-integrity",
            fixture
                .runtime
                .join("hepta-paper.sqlite")
                .to_str()
                .expect("UTF-8 fixture path"),
        ])
        .output()?;
    assert_eq!(explicit.status.code(), node.status.code());
    assert_eq!(
        serde_json::from_slice::<Value>(&explicit.stdout)?,
        node_json
    );
    Ok(())
}
