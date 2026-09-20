//! CLI coverage for repository-asset strict flags.
//!
//! The incumbent command accepts `--require-externalized` in addition to
//! `--handoff`; the native route must preserve that fail-closed contract while
//! still emitting the inspection JSON.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
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

fn rust_command(root: &Path, manifest: &Path, flags: &[&str]) -> std::process::Output {
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

    let node_handoff = node_command(&["--handoff", "--require-externalized"]);
    assert!(
        node_handoff.status.success(),
        "{}",
        String::from_utf8_lossy(&node_handoff.stderr)
    );
    let native_handoff = rust_command(
        &root,
        &manifest_path(),
        &["--handoff", "--require-externalized"],
    );
    assert!(
        native_handoff.status.success(),
        "{}",
        String::from_utf8_lossy(&native_handoff.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&native_handoff.stdout)?,
        serde_json::from_slice::<Value>(&node_handoff.stdout)?,
    );
    Ok(())
}

struct IsolatedRepository(PathBuf);
impl IsolatedRepository {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let root = std::env::temp_dir().join(format!(
            "hepta-repository-assets-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root)?;
        let fixture = Self(root);
        fs::create_dir_all(fixture.0.join("paper-core/bin"))?;
        fs::create_dir_all(fixture.0.join("paper-core/config"))?;
        fs::create_dir_all(fixture.0.join("asset"))?;
        // Execute the original Node entrypoint from a copied deployment root,
        // retaining the real composition and parser through read-only links.
        fs::copy(
            repository_root().join("paper-core/bin/repository-asset-status.mjs"),
            fixture.0.join("paper-core/bin/repository-asset-status.mjs"),
        )?;
        std::os::unix::fs::symlink(
            repository_root().join("paper-core/src").canonicalize()?,
            fixture.0.join("paper-core/src"),
        )?;
        std::os::unix::fs::symlink(
            repository_root().join("paper-composition").canonicalize()?,
            fixture.0.join("paper-composition"),
        )?;
        let identity = b"native repository asset fixture\n";
        fs::write(fixture.0.join("asset/identity.txt"), identity)?;
        let digest = format!("sha256:{}", hex::encode(Sha256::digest(identity)));
        let manifest = json!({
            "version": 1,
            "kind": "RepositoryAssetExternalizationManifest",
            "assets": [{
                "assetId": "fixture",
                "sourcePath": "asset",
                "identityFile": "asset/identity.txt",
                "expectedIdentitySha256": digest,
                "currentStorage": "repository",
                "targetStorage": "immutable-registry",
                "requiredExternalReferenceKind": "content-addressed-artifact",
                "retentionPolicy": "retain-reference",
                "migrationStatus": "pending-external-registry-reference"
            }]
        });
        fs::write(fixture.manifest_path(), serde_json::to_vec(&manifest)?)?;
        Ok(fixture)
    }
    fn manifest_path(&self) -> PathBuf {
        self.0
            .join("paper-core/config/repository-asset-externalization.v1.json")
    }
    fn compare(
        &self,
        flags: &[&str],
        expected_code: i32,
    ) -> Result<Value, Box<dyn std::error::Error>> {
        let node = Command::new("node")
            .current_dir(&self.0)
            .arg("paper-core/bin/repository-asset-status.mjs")
            .args(flags)
            .output()?;
        let native = rust_command(&self.0, &self.manifest_path(), flags);
        assert_eq!(
            node.status.code(),
            Some(expected_code),
            "Node flags {flags:?}: {}",
            String::from_utf8_lossy(&node.stderr)
        );
        assert_eq!(
            native.status.code(),
            node.status.code(),
            "native flags {flags:?}: {}",
            String::from_utf8_lossy(&native.stderr)
        );
        assert_eq!(native.stderr, node.stderr, "stderr flags {flags:?}");
        let actual: Value = serde_json::from_slice(&native.stdout)?;
        assert_eq!(
            actual,
            serde_json::from_slice::<Value>(&node.stdout)?,
            "flags {flags:?}"
        );
        Ok(actual)
    }
}
impl Drop for IsolatedRepository {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn require_externalized_emits_blocked_report_and_preserves_strict_parser()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = IsolatedRepository::new()?;
    let pending = fixture.compare(&[], 0)?;
    assert_eq!(pending["repositoryBoundaryReady"], true);
    assert_eq!(pending["fullyExternalized"], false);
    assert_eq!(fixture.compare(&["--require-externalized"], 1)?, pending);
    let handoff = fixture.compare(&["--handoff"], 0)?;
    assert_eq!(
        handoff["status"],
        "repository_asset_externalization_authority_required"
    );
    assert_eq!(
        fixture.compare(&["--handoff", "--require-externalized"], 1)?,
        handoff
    );
    assert_eq!(
        fixture.compare(&["--require-externalized", "--handoff"], 1)?,
        handoff
    );

    // Invalid local bytes block the default command too; the strict flag is
    // only an additional condition for an otherwise sound pending boundary.
    fs::write(fixture.0.join("asset/identity.txt"), b"changed identity")?;
    let blocked = fixture.compare(&[], 1)?;
    assert_eq!(blocked["repositoryBoundaryReady"], false);
    assert_eq!(fixture.compare(&["--require-externalized"], 1)?, blocked);
    for flags in [
        &["--handoff"][..],
        &["--handoff", "--require-externalized"][..],
    ] {
        let native = rust_command(&fixture.0, &fixture.manifest_path(), flags);
        let node = Command::new("node")
            .current_dir(&fixture.0)
            .arg("paper-core/bin/repository-asset-status.mjs")
            .args(flags)
            .output()?;
        assert_eq!(node.status.code(), Some(1));
        assert_eq!(native.status.code(), node.status.code());
        assert!(native.stdout.is_empty());
        assert!(node.stdout.is_empty());
        let error = "repository_asset_externalization_handoff_blocked:fixture:repository_asset_identity_hash_mismatch";
        assert!(String::from_utf8_lossy(&native.stderr).contains(error));
        assert!(String::from_utf8_lossy(&node.stderr).contains(error));
    }

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
        (&["--=x"][..], "empty_cli_option"),
        (&["--"][..], "unexpected_cli_argument_separator"),
        (&["value"][..], "unexpected_cli_positional:value"),
        (
            &["--handoff", "--require-externalized", "--handoff"][..],
            "duplicate_cli_option:--handoff",
        ),
    ] {
        let output = rust_command(&repository_root(), &manifest_path(), flags);
        let node = node_command(flags);
        assert_eq!(output.status.code(), Some(1), "flags: {flags:?}");
        assert_eq!(node.status.code(), Some(1), "Node flags: {flags:?}");
        assert!(output.stdout.is_empty());
        assert!(node.stdout.is_empty());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(expected),
            "flags: {flags:?}"
        );
        assert!(
            String::from_utf8_lossy(&node.stderr).contains(expected),
            "Node flags: {flags:?}"
        );
    }
    Ok(())
}
