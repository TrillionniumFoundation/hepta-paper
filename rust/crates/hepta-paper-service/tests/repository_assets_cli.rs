//! CLI coverage for repository-asset strict flags.
//!
//! The incumbent command accepts `--require-externalized` in addition to
//! `--handoff`; the native route must preserve that fail-closed contract while
//! still emitting the inspection JSON.

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

fn manifest_path() -> PathBuf {
    repository_root().join("paper-core/config/repository-asset-externalization.v1.json")
}

fn rust_command(root: &PathBuf, manifest: &PathBuf, flags: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["repository-assets"])
        .arg(root)
        .arg(manifest)
        .args(flags)
        .output()
        .expect("repository-assets native command")
}

fn node_command(flags: &[&str]) -> std::process::Output {
    Command::new("node")
        .current_dir(repository_root())
        .arg("paper-core/bin/repository-asset-status.mjs")
        .args(flags)
        .output()
        .expect("repository-assets Node command")
}

#[test]
fn require_externalized_matches_node_for_ready_manifest() -> Result<(), Box<dyn std::error::Error>>
{
    let root = repository_root();
    let node = node_command(&["--require-externalized"]);
    assert!(
        node.status.success(),
        "{}",
        String::from_utf8_lossy(&node.stderr)
    );
    let native = rust_command(&root, &manifest_path(), &["--require-externalized"]);
    assert!(
        native.status.success(),
        "{}",
        String::from_utf8_lossy(&native.stderr)
    );
    let node_json: Value = serde_json::from_slice(&node.stdout)?;
    let native_json: Value = serde_json::from_slice(&native.stdout)?;
    assert_eq!(native_json, node_json);
    assert_eq!(native_json["fullyExternalized"], true);
    Ok(())
}

#[test]
fn require_externalized_emits_blocked_report_and_preserves_strict_parser()
-> Result<(), Box<dyn std::error::Error>> {
    let root = repository_root();
    let mut manifest: Value = serde_json::from_slice(&fs::read(manifest_path())?)?;
    manifest["assets"][1]["migrationStatus"] =
        Value::String("pending-external-registry-reference".to_owned());
    let path = std::env::temp_dir().join(format!(
        "hepta-repository-assets-cli-{}-{}.json",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&path, serde_json::to_vec(&manifest)?)?;

    let blocked = rust_command(&root, &path, &["--require-externalized"]);
    assert_eq!(blocked.status.code(), Some(1));
    let report: Value = serde_json::from_slice(&blocked.stdout)?;
    assert_eq!(report["repositoryBoundaryReady"], false);
    assert_eq!(report["fullyExternalized"], false);
    assert!(
        report["integrityBlockers"]
            .as_array()
            .is_some_and(|blockers| !blockers.is_empty())
    );
    assert!(
        String::from_utf8_lossy(&blocked.stderr)
            .contains("repository asset externalization required")
    );

    for (flags, expected) in [
        (
            &["--require-externalized", "--require-externalized"][..],
            "duplicate_cli_option:--require-externalized",
        ),
        (&["--unknown"][..], "unknown_cli_option:--unknown"),
        (
            &["--require-externalized=true"][..],
            "boolean_cli_option_does_not_take_value:--require-externalized",
        ),
    ] {
        let output = rust_command(&root, &manifest_path(), flags);
        let node = node_command(flags);
        assert_eq!(output.status.code(), Some(1), "flags: {flags:?}");
        assert_eq!(node.status.code(), Some(1), "Node flags: {flags:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(expected),
            "flags: {flags:?}"
        );
        assert!(
            String::from_utf8_lossy(&node.stderr).contains(expected),
            "Node flags: {flags:?}"
        );
    }
    fs::remove_file(path)?;
    Ok(())
}
