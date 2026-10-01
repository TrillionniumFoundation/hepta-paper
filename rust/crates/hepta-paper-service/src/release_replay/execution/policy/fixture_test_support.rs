//! Test data selects the 36 actual immutable-archive P1 sources. Every extracted
//! byte is checked against the existing canonical matrix, not a new count ledger.
//! Fixture provenance: immutable original archive SHA256
//! e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d;
//! original matrix SHA256 59446f5e96cc5f086b27266f0fb0604d4f7f0e5bf1f62cb1a90933208a0f162a.
//! The binary carries only the build_package_v1 36-source subset (2,069,252 raw
//! bytes). Recipe: sourcePath order, GNU tar regular files mode 0400, uid/gid 0,
//! empty owner names, mtime 0; Python gzip.compress(..., mtime=0). Selected source
//! hashes, rather than gzip implementation identity, are the semantic truth.
//! Both materializer and whole-suite tests use this one fixture; it is not a
//! full 245-source archive, installed state, or authority/signing fixture.
use super::{
    Owner, PrivateTree, ReleaseAttestationReplayRequestV3, archive::PinnedArchive, environment,
    facts::Matrix, measured_profile::SourceLimits,
};
use crate::release_attest::ReleaseAttestationSourceRequestV2;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
pub(super) const FIXTURE_HASH: &str =
    "sha256:ada0ec432d84023155c38815f5576af7c1fc24dfbf3d685d78aa6214ec5022d6";
pub(super) struct FixtureOwner {
    request: ReleaseAttestationReplayRequestV3,
    cancelled: AtomicBool,
}
impl FixtureOwner {
    pub(super) fn new() -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        Self {
            request: ReleaseAttestationReplayRequestV3 {
                version: 3,
                kind: "ReleaseAttestationReplayRequest".into(),
                source: ReleaseAttestationSourceRequestV2 {
                    version: 2,
                    kind: "ReleaseAttestationSourceRequest".into(),
                    workspace_root: root,
                    git_executable: "/usr/bin/git".into(),
                    git_executable_sha256: format!("sha256:{}", "0".repeat(64)),
                    expected_commit: "0".repeat(40),
                    expected_tree: "0".repeat(40),
                    expected_release_state_snapshot_hash: format!("sha256:{}", "0".repeat(64)),
                    timeout_ms: 120000,
                },
                node_executable: "/nonexistent/node".into(),
                node_executable_sha256: format!("sha256:{}", "0".repeat(64)),
                timeout_ms: 120000,
            },
            cancelled: AtomicBool::new(false),
        }
    }
    pub(super) fn owner(&self) -> Owner<'_> {
        Owner {
            request: &self.request,
            cancelled: &self.cancelled,
            started: Instant::now(),
            environment: environment(BTreeMap::new()).unwrap(),
            read_bytes: 0,
        }
    }
    pub(super) fn root(&self) -> &Path {
        &self.request.source.workspace_root
    }
    pub(super) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
}
pub(super) fn sources(owner: &mut Owner<'_>, tree: &mut PrivateTree) -> Matrix {
    let root = owner.request.source.workspace_root.clone();
    let mut matrix: Matrix = serde_json::from_slice(
        &std::fs::read(root.join("migration/legacy-semantic-migration-matrix.json")).unwrap(),
    )
    .unwrap();
    matrix.entries.retain(|row| {
        row.behavior_tests.len() == 1
            && row.behavior_tests[0].path == "migration/tests/p1-build-package-retirements.mjs"
    });
    assert_eq!(matrix.entries.len(), 36);
    if !tree
        .sources()
        .join(super::runner_contract::LOCAL_WRITER)
        .exists()
    {
        let fixture = root.join("rust/oracle/build-package-retired-sources.v1.tar.gz");
        let mut archive =
            PinnedArchive::capture(owner, &fixture, FIXTURE_HASH, 512 * 1024).unwrap();
        let tar = owner.tool(Path::new("/usr/bin/tar"), None).unwrap();
        let receipt = archive
            .materialize(owner, &tar, &matrix, tree, SourceLimits::OriginalV4)
            .unwrap();
        assert_eq!(receipt["memberCount"], 36);
        assert_eq!(receipt["fullArchiveRestored"], false);
        archive.assert_current(owner).unwrap();
    }
    tree.assert_sources(&matrix, owner).unwrap();
    matrix
}
pub(super) fn ast(owner: &mut Owner<'_>, tree: &PrivateTree, matrix: &Matrix) -> (Value, Value) {
    let mut cases = Vec::new();
    let mut bindings = Vec::new();
    for row in &matrix.entries {
        let bytes = tree.read_source(&row.source.path, owner).unwrap();
        assert_eq!(
            super::digest(&bytes),
            format!("sha256:{}", row.source.sha256)
        );
        cases.push(json!({"version":1,"kind":"NativePythonRetirementAstRequest","profile":"build_package_v1","source":std::str::from_utf8(&bytes).unwrap(),"sourcePath":tree.sources().join(&row.source.path)}));
        bindings.push(json!({"matrixId":row.id,"sourcePath":row.source.path,"sourceSha256":super::digest(&bytes),"profile":"build_package_v1"}));
    }
    let input = serde_json::to_vec(
        &json!({"version":1,"kind":"NativePythonRetirementAstBatchRequest","cases":cases}),
    )
    .unwrap();
    let output =
        crate::release_replay::python_ast::inspect_python_ast_worker_bytes_v1(&input).unwrap();
    let native: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(native["caseCount"], 36);
    assert_eq!(native["sourceExecuted"], false);
    (json!({"native":native}), json!({"bindings":bindings}))
}
pub(super) fn node() -> PathBuf {
    let selected = std::env::var_os("HEPTA_TEST_NODE").unwrap_or_else(|| "node".into());
    let path = PathBuf::from(selected);
    if path.components().count() == 1 {
        std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|p| p.join(&path))
            .find(|p| p.is_file())
            .unwrap()
            .canonicalize()
            .unwrap()
    } else {
        path.canonicalize().unwrap()
    }
}
