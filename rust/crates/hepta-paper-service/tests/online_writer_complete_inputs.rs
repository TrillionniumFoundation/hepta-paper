use hepta_paper_service::online_writer_static::{
    inspect_online_writer_static_coverage_v1, verify_online_writer_static_coverage_v1,
};
use serde_json::Value;
use std::{
    fs,
    io::Write,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    manifest: Value,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-complete-static-inputs-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let config: Value =
            serde_json::from_str(include_str!("../src/online_writer_static/config.json")).unwrap();
        for relative in config["PROVENANCE_ONLY_SOURCES"].as_array().unwrap() {
            let path = root.join(relative.as_str().unwrap());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "// fixture provenance\n").unwrap();
        }
        let mut child = Command::new("node")
            .arg(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../oracle/online-runtime-activation-v1.mjs"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(br#"{"mode":"fixture"}"#)
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let fixture: Value = serde_json::from_slice(&output.stdout).unwrap();
        let manifest = fixture["manifest"].clone();
        for operation in manifest["operations"].as_array().unwrap() {
            let path = root.join(operation["sourceFile"].as_str().unwrap());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path,format!("export function {}(db) {{return db.executeMutation({{databaseRole:{},operationId:{},mutate:(tx)=>tx.run('statement:one')}});}}",operation["entrypoint"].as_str().unwrap(),operation["databaseRole"],operation["operationId"])).unwrap();
        }
        for (relative, bytes) in [
            (
                "paper-adapters/passive/nothing.mjs",
                "export const passive = 1;\n",
            ),
            (
                "paper-adapters/passive/README.md",
                "inert source-neighbor\n",
            ),
            (
                "paper-adapters/migration/rust-cutover-fence.mjs",
                "export const passive = 2;\n",
            ),
            ("store/migrations/001_select.sql", "SELECT 1;\n"),
        ] {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        Self { root, manifest }
    }
    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn complete_private_input_proof_rejects_changed_inert_excluded_and_sql_bytes() {
    for relative in [
        "paper-adapters/passive/nothing.mjs",
        "paper-adapters/passive/README.md",
        "paper-adapters/migration/rust-cutover-fence.mjs",
        "store/migrations/001_select.sql",
        "paper-domain/automation/autonomous-research-online-writer-manifest.mjs",
    ] {
        let fixture = Fixture::new();
        // Not every provenance path is configured in all protocol revisions.
        let path = fixture.path(relative);
        if !path.exists() {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "// declared provenance\n").unwrap();
        }
        let proof =
            verify_online_writer_static_coverage_v1(&fixture.root, &fixture.manifest).unwrap();
        let original = fs::read(&path).unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let mut bytes = original;
        bytes[0] ^= 1;
        fs::write(&path, bytes).unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert!(proof.assert_current().is_err(), "{relative}");
    }
}
#[test]
fn complete_private_input_proof_rejects_namespace_changes_and_absent_roots() {
    for mutation in 0..6 {
        let fixture = Fixture::new();
        let proof =
            verify_online_writer_static_coverage_v1(&fixture.root, &fixture.manifest).unwrap();
        match mutation {
            0 => fs::write(
                fixture.path("paper-adapters/passive/new-non-writer.mjs"),
                "export const a=1;",
            )
            .unwrap(),
            1 => fs::remove_file(fixture.path("paper-adapters/passive/README.md")).unwrap(),
            2 => fs::rename(
                fixture.path("paper-adapters/passive/README.md"),
                fixture.path("paper-adapters/passive/renamed.txt"),
            )
            .unwrap(),
            3 => fs::create_dir(fixture.path("paper-adapters/new-empty-directory")).unwrap(),
            4 => fs::write(
                fixture.path("store/migrations/new-not-sql.txt"),
                "unchanged sql scan, changed namespace",
            )
            .unwrap(),
            _ => {
                fs::create_dir_all(fixture.path("paper-application/new-root")).unwrap();
                fs::write(
                    fixture.path("paper-application/new-root/inert.mjs"),
                    "export const a=1;",
                )
                .unwrap();
            }
        }
        assert!(proof.assert_current().is_err(), "mutation {mutation}");
    }
}
#[test]
fn complete_private_input_proof_rejects_aliases_inodes_permissions_and_ancestor_replacement() {
    for mutation in 0..5 {
        let fixture = Fixture::new();
        let proof =
            verify_online_writer_static_coverage_v1(&fixture.root, &fixture.manifest).unwrap();
        let file = fixture.path("paper-adapters/passive/nothing.mjs");
        match mutation {
            0 => {
                let held = fixture.path("paper-adapters/passive/held.mjs");
                fs::rename(&file, &held).unwrap();
                symlink(&held, &file).unwrap();
            }
            1 => {
                let bytes = fs::read(&file).unwrap();
                let replacement = file.with_extension("replacement");
                fs::write(&replacement, bytes).unwrap();
                fs::rename(replacement, &file).unwrap();
            }
            2 => fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap(),
            3 => fs::set_permissions(
                fixture.path("paper-adapters/passive"),
                fs::Permissions::from_mode(0o700),
            )
            .unwrap(),
            _ => {
                let moved = fixture.root.with_extension("moved");
                fs::rename(&fixture.root, &moved).unwrap();
                symlink(&moved, &fixture.root).unwrap();
                assert!(proof.assert_current().is_err());
                fs::remove_file(&fixture.root).unwrap();
                fs::rename(moved, &fixture.root).unwrap();
                continue;
            }
        }
        assert!(proof.assert_current().is_err(), "mutation {mutation}");
    }
    let fixture = Fixture::new();
    let path = fixture.path("paper-adapters/passive");
    let moved = fixture.path("outside-scan");
    fs::rename(&path, &moved).unwrap();
    symlink(&moved, &path).unwrap();
    assert!(verify_online_writer_static_coverage_v1(&fixture.root, &fixture.manifest).is_err());
}
#[test]
fn repeated_currentness_preserves_report_and_tolerates_unrelated_sibling_directory_activity() {
    let fixture = Fixture::new();
    let report =
        inspect_online_writer_static_coverage_v1(&fixture.root, &fixture.manifest).unwrap();
    let proof = verify_online_writer_static_coverage_v1(&fixture.root, &fixture.manifest).unwrap();
    assert_eq!(proof.value(), &report);
    let neighbor = fixture.root.with_extension("unrelated");
    fs::create_dir(&neighbor).unwrap();
    for _ in 0..5 {
        proof.assert_current().unwrap();
    }
    fs::remove_dir(neighbor).unwrap();
    proof.assert_current().unwrap();
    assert_eq!(proof.value(), &report);
}
#[test]
fn source_proof_uses_bounded_directory_descriptors_and_fails_closed_on_descriptor_exhaustion() {
    const CHILD: &str = "HEPTA_COMPLETE_STATIC_INPUTS_RESOURCE_CHILD";
    if let Ok(mode) = std::env::var(CHILD) {
        let fixture = Fixture::new();
        if mode == "many-files" {
            for i in 0..1200 {
                fs::write(
                    fixture.path(&format!("paper-adapters/passive/inert-{i}.txt")),
                    "inert",
                )
                .unwrap();
            }
        } else {
            for i in 0..96 {
                fs::create_dir(fixture.path(&format!("paper-adapters/passive/directory-{i}")))
                    .unwrap();
            }
        }
        let result = verify_online_writer_static_coverage_v1(&fixture.root, &fixture.manifest);
        if mode == "many-files" {
            result.unwrap().assert_current().unwrap();
        } else {
            assert!(result.is_err());
        }
        return;
    }
    for mode in ["many-files", "too-many-directories"] {
        let output=Command::new("prlimit")
            .args(["--nofile=64:64", "--"])
            .arg(std::env::current_exe().unwrap()).args(["--exact","source_proof_uses_bounded_directory_descriptors_and_fails_closed_on_descriptor_exhaustion","--nocapture"])
            .env(CHILD,mode).output().unwrap();
        assert!(
            output.status.success(),
            "child {mode}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn complete_repository_proof_revalidates_all_input_bytes_without_reparsing_ast() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/online-writer-static-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"[{"mode":"manifest"}]"#)
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let manifests: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    let started = std::time::Instant::now();
    let proof = verify_online_writer_static_coverage_v1(&root, &manifests[0]).unwrap();
    eprintln!(
        "complete repository initial Oxc proof: {:?}",
        started.elapsed()
    );
    for iteration in 0..5 {
        let started = std::time::Instant::now();
        proof.assert_current().unwrap();
        eprintln!(
            "complete repository actual bytes/identity/namespace revalidation {iteration}: {:?}",
            started.elapsed()
        );
    }
}
