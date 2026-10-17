use super::*;
use crate::{
    native_research_evidence::{
        NativeResearchObservedInputsRequestV1, inspect_native_research_observed_inputs_v1,
    },
    native_research_manuscript::NativeResearchReadContextV1,
    native_research_source::{
        NativeResearchSourceSnapshotRequestV1, inspect_native_research_source_snapshot_v1,
        inspect_native_research_source_snapshot_with_context_v1,
    },
};
use serde_json::json;
use std::{fs, os::unix::fs::PermissionsExt, sync::atomic::AtomicU64, time::Duration};
static NEXT: AtomicU64 = AtomicU64::new(1);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-observed-plan-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn inputs(
    root: &Path,
    plan_path: &str,
    expected: Option<String>,
) -> NativeResearchSourcePlanRequestV1 {
    fs::create_dir(root.join("source")).unwrap();
    fs::write(root.join("source/values.csv"), b"x\n1\n3\n").unwrap();
    let hash = expected.unwrap_or_else(|| digest(b"x\n1\n3\n").to_string());
    let paper_id = root.file_name().unwrap().to_str().unwrap();
    let plan = json!({"version":1,"kind":"NativeResearchWorkerPlan","paperId":paper_id,"taskKey":"paper:observed","workers":[{"id":"actual","type":"artifact_integrity","evidenceClass":"research_evidence","syntheticInput":false,"outcomesPreprogrammed":false,"claimIds":["claim:a"],"inputs":[{"path":plan_path,"sha256":hash}],"parameters":{}}]});
    fs::write(
        root.join("source/RESEARCH_WORKER_PLAN.json"),
        serde_json::to_vec(&plan).unwrap(),
    )
    .unwrap();
    NativeResearchSourcePlanRequestV1 {
        version: 1,
        root: root.into(),
        paper_task: json!({"paperId":paper_id,"taskKey":"paper:observed","sourceWorkspace":"source","paperQualityProfile":"theoretical_or_formal"}),
    }
}
fn observe<'a>(
    r: &NativeResearchSourcePlanRequestV1,
    c: &'a AtomicBool,
    deadline: Instant,
) -> NativeResearchObservedInputsObservationV1<'a> {
    inspect_native_research_observed_inputs_v1(
        NativeResearchObservedInputsRequestV1 {
            version: 1,
            root: r.root.clone(),
            source_root: Some(r.root.join("source")),
            paper_task: r.paper_task.clone(),
        },
        c,
        deadline,
    )
    .unwrap()
}
#[test]
fn actual_listed_member_accessor_requires_internal_charge_and_bounds_failed_reuse() {
    let temp = Temp::new();
    fs::write(temp.0.join("actual.txt"), b"actual listed bytes").unwrap();
    fs::create_dir(temp.0.join("runtime")).unwrap();
    fs::write(temp.0.join("runtime/hidden.txt"), b"excluded").unwrap();
    let c = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(30);
    let req = || NativeResearchSourceSnapshotRequestV1 {
        version: 1,
        source_root: temp.0.clone(),
    };
    let mut uncharged = inspect_native_research_source_snapshot_v1(req(), &c, deadline).unwrap();
    assert!(
        uncharged
            .listed_member_bytes_v1(Path::new("actual.txt"), 1024)
            .is_err()
    );
    let mut ctx = NativeResearchReadContextV1::new(&c, deadline);
    let mut source =
        inspect_native_research_source_snapshot_with_context_v1(req(), &mut ctx).unwrap();
    for _ in 0..129 {
        assert_eq!(
            source
                .listed_member_bytes_v1(Path::new("actual.txt"), 1024)
                .unwrap(),
            b"actual listed bytes"
        );
    }
    assert!(
        source
            .listed_member_bytes_v1(Path::new("actual.txt"), 1024)
            .is_err()
    );
    let mut source =
        inspect_native_research_source_snapshot_with_context_v1(req(), &mut ctx).unwrap();
    assert!(
        source
            .listed_member_bytes_v1(Path::new("runtime/hidden.txt"), 1024)
            .is_err()
    );
    assert!(
        source
            .listed_member_bytes_v1(Path::new("actual.txt"), 1024)
            .is_err(),
        "failed membership attempt cannot revive the opaque owner"
    );
    let mut source =
        inspect_native_research_source_snapshot_with_context_v1(req(), &mut ctx).unwrap();
    assert_eq!(
        source
            .listed_member_bytes_v1(Path::new("actual.txt"), 1024)
            .unwrap(),
        b"actual listed bytes"
    );
    fs::rename(temp.0.join("actual.txt"), temp.0.join("retained.txt")).unwrap();
    fs::write(temp.0.join("actual.txt"), b"same named replacement").unwrap();
    assert!(
        source
            .listed_member_bytes_v1(Path::new("actual.txt"), 1024)
            .is_err()
    );
}
struct RuntimeCleanup(PathBuf);
impl Drop for RuntimeCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn actual_normal_source_plan_refuses_before_cas_insert_and_requires_fresh_controls() {
    for mode in [
        "wrong_hash",
        "outside",
        "wrong_task",
        "same_id_task_drift",
        "wrong_workspace",
        "plan_limit",
        "cancel",
        "expired",
        "replaced",
    ] {
        let temp = Temp::new();
        let expected = (mode == "wrong_hash").then(|| digest(b"wrong actual input").to_string());
        let mut req = inputs(
            &temp.0,
            if mode == "outside" {
                "../values.csv"
            } else {
                "values.csv"
            },
            expected,
        );
        if mode == "plan_limit" {
            let p = temp.0.join("source/RESEARCH_WORKER_PLAN.json");
            let mut b = fs::read(&p).unwrap();
            b.resize(MAX_PLAN_BYTES as usize + 1, b' ');
            fs::write(p, b).unwrap();
        }
        let c = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(if mode == "expired" { 3 } else { 30 });
        let runtime = open_native_research_source_data_runtime_v1(&req, &c, deadline).unwrap();
        let _cleanup = RuntimeCleanup(runtime.workflow_directory().parent().unwrap().to_owned());
        let mut observed = observe(&req, &c, deadline);
        if mode == "wrong_task" {
            req.paper_task["paperId"] = json!("different");
        }
        if mode == "same_id_task_drift" {
            req.paper_task["title"] = json!("changed after opaque observation");
        }
        if mode == "wrong_workspace" {
            req.paper_task["sourceWorkspace"] = json!("different");
        }
        if mode == "cancel" {
            c.store(true, Ordering::SeqCst);
        }
        if mode == "replaced" {
            fs::rename(
                temp.0.join("source/values.csv"),
                temp.0.join("source/held.csv"),
            )
            .unwrap();
            fs::write(temp.0.join("source/values.csv"), b"x\n1\n3\n").unwrap();
        }
        let before = fs::read_dir(runtime.objects().root()).unwrap().count();
        if mode == "expired" {
            std::thread::sleep(Duration::from_millis(3100));
        }
        assert!(
            prepare_native_research_data_plan_from_observed_workspace_v1(
                &req,
                &mut observed,
                &runtime
            )
            .is_err(),
            "{mode}"
        );
        assert_eq!(
            before,
            fs::read_dir(runtime.objects().root()).unwrap().count(),
            "{mode} must refuse before object insertion"
        );
        assert!(!runtime.workflow_directory().exists());
    }
    let temp = Temp::new();
    let req = inputs(&temp.0, "values.csv", None);
    let c = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(30);
    let runtime = open_native_research_source_data_runtime_v1(&req, &c, deadline).unwrap();
    let _cleanup = RuntimeCleanup(runtime.workflow_directory().parent().unwrap().to_owned());
    let mut stale = observe(&req, &c, deadline);
    c.store(true, Ordering::SeqCst);
    assert!(
        prepare_native_research_data_plan_from_observed_workspace_v1(&req, &mut stale, &runtime)
            .is_err()
    );
    let fresh_c = AtomicBool::new(false);
    let fresh_deadline = Instant::now() + Duration::from_secs(30);
    let fresh_runtime =
        open_native_research_source_data_runtime_v1(&req, &fresh_c, fresh_deadline).unwrap();
    let mut fresh = observe(&req, &fresh_c, fresh_deadline);
    assert!(
        prepare_native_research_data_plan_from_observed_workspace_v1(&req, &mut fresh, &runtime)
            .is_err(),
        "the prior cancelled control cannot be swapped out"
    );
    let prepared = prepare_native_research_data_plan_from_observed_workspace_v1(
        &req,
        &mut fresh,
        &fresh_runtime,
    )
    .unwrap();
    assert_eq!(prepared.selected_source_members(), 2);
    assert_eq!(prepared.plan().jobs.len(), 1);
    let before = fs::read_dir(fresh_runtime.objects().root())
        .unwrap()
        .count();
    prepare_native_research_data_plan_from_observed_workspace_v1(&req, &mut fresh, &fresh_runtime)
        .unwrap();
    assert_eq!(
        before,
        fs::read_dir(fresh_runtime.objects().root())
            .unwrap()
            .count()
    );
    fresh.verify_unchanged().unwrap();
}
#[test]
fn actual_normal_source_runtime_refuses_id_aliases_and_control_before_creation() {
    let temp = Temp::new();
    let req = inputs(&temp.0, "values.csv", None);
    for id in [
        ".",
        "..",
        "../escape",
        "a/b",
        "a\\b",
        " leading",
        "double  space",
    ] {
        let mut changed = NativeResearchSourcePlanRequestV1 {
            version: 1,
            root: req.root.clone(),
            paper_task: req.paper_task.clone(),
        };
        changed.paper_task["paperId"] = json!(id);
        assert!(
            open_native_research_source_data_runtime_v1(
                &changed,
                &AtomicBool::new(false),
                Instant::now() + Duration::from_secs(30)
            )
            .is_err(),
            "{id}"
        );
    }
    assert!(
        open_native_research_source_data_runtime_v1(
            &req,
            &AtomicBool::new(true),
            Instant::now() + Duration::from_secs(30)
        )
        .is_err()
    );
    assert!(
        open_native_research_source_data_runtime_v1(&req, &AtomicBool::new(false), Instant::now())
            .is_err()
    );
    let path = crate::native_workspace::current_native_command_runtime_root_v1()
        .unwrap()
        .join("research-workers")
        .join(req.paper_task["paperId"].as_str().unwrap());
    assert!(!path.exists());
}
