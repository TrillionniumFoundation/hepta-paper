//! Bounded command checks for the Rust dispatcher challenge observer.

use serde_json::Value;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

fn root() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "hepta-dispatcher-challenge-cli-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
}

fn hashes() -> [&'static str; 4] {
    [
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    ]
}

#[test]
fn help_is_the_same_usage_object_as_node() {
    let rust = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["autonomous-submission-dispatcher-challenge", "--help"])
        .output()
        .unwrap();
    let node = Command::new("node")
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .env(
            "PATH",
            format!(
                "{}:{}",
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../../toolchains/node-npm/node_modules/node-linux-x64/bin")
                    .display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .args([
            "paper-core/bin/autonomous-submission-dispatcher-challenge.mjs",
            "--help",
        ])
        .output()
        .unwrap();
    assert_eq!(rust.status.code(), Some(2));
    assert_eq!(node.status.code(), Some(2));
    assert_eq!(rust.stdout, node.stdout);
    let _: Value = serde_json::from_slice(&rust.stdout).unwrap();
}

#[test]
fn status_is_fail_closed_on_missing_exchange_and_parent_symlink() {
    let hashes = hashes();
    let root = root();
    let args = [
        "autonomous-submission-dispatcher-challenge",
        "--action",
        "status",
        "--plan-hash",
        hashes[0],
        "--idempotency-key",
        hashes[1],
        "--portal-id",
        "portal:test",
        "--portal-configuration-hash",
        hashes[2],
        "--portal-descriptor-hash",
        hashes[3],
        "--runtime-root",
    ];
    let mut with_root = args.to_vec();
    with_root.push(root.to_str().unwrap());
    let blocked = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(&with_root)
        .output()
        .unwrap();
    assert_eq!(blocked.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&blocked.stdout).unwrap();
    assert_eq!(report["ready"], false);
    assert!(
        report["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "autonomous_submission_dispatcher_challenge_missing")
    );

    let real = root.join("real");
    fs::create_dir(&real).unwrap();
    let link = root.join("link");
    symlink(&real, &link).unwrap();
    let mut rebound = args.to_vec();
    rebound.push(link.to_str().unwrap());
    let rejected = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(&rebound)
        .output()
        .unwrap();
    assert_eq!(rejected.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&rejected.stderr)
            .contains("autonomous_submission_dispatcher_exchange_directory_unsafe")
    );
    fs::remove_dir_all(root).unwrap();
}
