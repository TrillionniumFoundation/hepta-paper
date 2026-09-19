use hepta_paper_service::workspace_status::{
    WorkspaceLayoutOptionsV1, inspect_workspace_status_v1, resolve_workspace_layout_v1,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::symlink,
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);

fn oracle(options: &Value) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .arg(root.join("rust/oracle/workspace-layout-v1.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(json!({"options": options}).to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-workspace-status-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn options(root: &Temp) -> Value {
    json!({"assetRoot": root.path("asset"), "runtimeRoot": root.path("runtime"), "legacyRoot": root.path("legacy")})
}
fn rust_layout(_root: &Temp, value: &Value) -> Value {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let env = BTreeMap::new();
    let opts = WorkspaceLayoutOptionsV1 {
        asset_root: value["assetRoot"].as_str(),
        runtime_root: value["runtimeRoot"].as_str(),
        legacy_root: value["legacyRoot"].as_str(),
    };
    serde_json::to_value(resolve_workspace_layout_v1(&repo, &repo, &env, &opts).unwrap()).unwrap()
}

#[test]
fn layout_roots_defaults_and_decoupling_match_node_oracle() {
    let root = Temp::new();
    let input = options(&root);
    let native = rust_layout(&root, &input);
    let node = oracle(&input);
    assert_eq!(node["ok"], true, "{node}");
    assert_eq!(native["workspaceRoot"], node["value"]["workspaceRoot"]);
    assert_eq!(native["assetRoot"], node["value"]["assetRoot"]);
    assert_eq!(native["runtimeRoot"], node["value"]["runtimeRoot"]);
    assert_eq!(native["legacyRoot"], node["value"]["legacyRoot"]);
    assert_eq!(native["realPaths"], node["value"]["realPaths"]);
    assert_eq!(
        native["physicallyDecoupled"],
        node["value"]["physicallyDecoupled"]
    );
    assert_eq!(
        native["decouplingBlockers"],
        node["value"]["decouplingBlockers"]
    );
}

#[test]
fn symlink_missing_suffix_hop_limit_and_overlap_fail_closed() {
    let root = Temp::new();
    fs::create_dir(root.path("target")).unwrap();
    symlink("target", root.path("link")).unwrap();
    let options = json!({"assetRoot": root.path("link/missing/../asset"), "runtimeRoot": root.path("runtime"), "legacyRoot": root.path("legacy")});
    let native = rust_layout(&root, &options);
    let node = oracle(&options);
    assert_eq!(node["ok"], true, "{node}");
    assert_eq!(native["realPaths"], node["value"]["realPaths"]);
    assert_eq!(
        native["decouplingBlockers"],
        node["value"]["decouplingBlockers"]
    );
    let mut loop_path = root.path("hop0");
    for index in 0..42 {
        let next = root.path(&format!("hop{}", index + 1));
        symlink(&next, &loop_path).unwrap();
        loop_path = next;
    }
    let hop0 = root.path("hop0");
    let runtime = root.path("runtime");
    let legacy = root.path("legacy");
    let options = WorkspaceLayoutOptionsV1 {
        asset_root: Some(hop0.to_str().unwrap()),
        runtime_root: Some(runtime.to_str().unwrap()),
        legacy_root: Some(legacy.to_str().unwrap()),
    };
    let mut env = BTreeMap::new();
    env.insert(
        "HEPTA_PAPER_ASSET_ROOT".into(),
        root.path("asset").to_str().unwrap().into(),
    );
    env.insert(
        "HEPTA_PAPER_RUNTIME_ROOT".into(),
        root.path("runtime").to_str().unwrap().into(),
    );
    env.insert(
        "PAPER_FACTORY_LEGACY_ROOT".into(),
        root.path("legacy").to_str().unwrap().into(),
    );
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let result = resolve_workspace_layout_v1(&repo, &repo, &env, &options).unwrap();
    assert!(!result.physically_decoupled);
    assert!(
        result
            .decoupling_blockers
            .iter()
            .any(|v| v.contains("assetRoot"))
    );
    let overlap = WorkspaceLayoutOptionsV1 {
        asset_root: Some(runtime.to_str().unwrap()),
        runtime_root: Some(runtime.to_str().unwrap()),
        legacy_root: Some(legacy.to_str().unwrap()),
    };
    let result = resolve_workspace_layout_v1(&repo, &repo, &env, &overlap).unwrap();
    assert!(!result.physically_decoupled);
    assert!(
        result
            .decoupling_blockers
            .iter()
            .any(|v| v == "workspace_layout_paths_overlap:assetRoot:runtimeRoot")
    );
}

#[test]
fn status_report_is_read_only_and_cli_root_is_relocatable() {
    let root = Temp::new();
    for name in ["asset", "runtime", "legacy"] {
        fs::create_dir(root.path(name)).unwrap();
    }
    fs::write(root.path("runtime/hepta-paper.sqlite"), b"not sqlite").unwrap();
    let mut env = BTreeMap::new();
    env.insert(
        "HEPTA_PAPER_ASSET_ROOT".into(),
        root.path("asset").to_str().unwrap().into(),
    );
    env.insert(
        "HEPTA_PAPER_RUNTIME_ROOT".into(),
        root.path("runtime").to_str().unwrap().into(),
    );
    env.insert(
        "PAPER_FACTORY_LEGACY_ROOT".into(),
        root.path("legacy").to_str().unwrap().into(),
    );
    let status = inspect_workspace_status_v1(&root.path("workspace"), &root.0, &env).unwrap();
    assert_eq!(status.status, "hepta_workspace_physically_decoupled");
    assert!(status.native_store_present);
    assert!(!root.path("workspace").exists());
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_hepta-workspace-status"))
        .current_dir(&root.0)
        .env("HEPTA_PAPER_ASSET_ROOT", root.path("asset"))
        .env("HEPTA_PAPER_RUNTIME_ROOT", root.path("runtime"))
        .env("PAPER_FACTORY_LEGACY_ROOT", root.path("legacy"))
        .arg("--workspace-root=workspace")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cli: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        cli["workspaceRoot"],
        root.path("workspace").to_str().unwrap()
    );
    assert_eq!(cli["status"], "hepta_workspace_physically_decoupled");
}
