use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{
    collections::BTreeMap,
    fs,
    sync::{Mutex, MutexGuard, atomic::Ordering},
    time::Duration,
};

static FIXTURE_LIFECYCLE: Mutex<()> = Mutex::new(());
struct Fixture {
    path: PathBuf,
    _lifecycle: MutexGuard<'static, ()>,
}
impl Fixture {
    fn new() -> Self {
        let lifecycle = FIXTURE_LIFECYCLE.lock().unwrap_or_else(|e| e.into_inner());
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = PathBuf::from(format!(
            "/dev/shm/hepta-native-inventory-{}-{suffix}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self {
            path,
            _lifecycle: lifecycle,
        }
    }
    fn input(&self, name: &str) -> NativeInventoryRequestV1 {
        NativeInventoryRequestV1 {
            version: 1,
            root: self.path.join("assets"),
            database: Some(self.path.join("runtime/hepta-paper.sqlite")),
            inventory_source: if name == "yaml" {
                "yaml"
            } else if name.ends_with("-auto") || name == "empty-auto" {
                "auto"
            } else {
                "hepta"
            }
            .to_owned(),
            include_loose_drafts: true,
            include_retired: false,
            include_quarantined: false,
            include_proposal_staging: true,
            proposal_staging_root: name
                .starts_with("external-")
                .then(|| self.path.join("runtime/proposal-staging")),
            paper_ids: Vec::new(),
            limit: None,
            observed_at: Some("2026-10-02T00:00:00.000Z".to_owned()),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.path).unwrap();
    }
}
fn oracle(input: &Value) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let selected =
        PathBuf::from(std::env::var_os("HEPTA_TEST_NODE").unwrap_or_else(|| "node".into()));
    let node = if selected.components().count() == 1 {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|directory| directory.join(&selected))
            .find(|path| path.is_file())
            .expect("actual qualified Node required")
    } else {
        selected
    }
    .canonicalize()
    .unwrap();
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/native_inventory/oracle.mjs");
    let request = BoundedProcessRequestV1 {
        executable: node,
        arguments: vec![script.into_os_string()],
        working_directory: root,
        environment: EnvironmentPolicyV1::new(
            "native-inventory-node-oracle-v1",
            ["PATH"],
            ["PATH"],
        )
        .unwrap()
        .build(std::env::vars_os(), &BTreeMap::new())
        .unwrap(),
        stdin: Some(serde_json::to_vec(input).unwrap()),
    };
    let result = run_bounded_process_capturing_stdout_with_cancellation(
        &request,
        ProcessLimitsV1 {
            timeout_ms: 30_000,
            maximum_stdin_bytes: 1024 * 1024,
            maximum_stdout_bytes: 16 * 1024 * 1024,
            maximum_stderr_bytes: 1024 * 1024,
            maximum_tail_bytes: 64 * 1024,
            ..ProcessLimitsV1::default()
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(
        result.process.termination_reason == ProcessTerminationReason::Exited
            && result.process.exit_code == Some(0)
            && result.process.signal.is_none()
            && result.process.process_group_cleanup_verified,
        "reason={:?}, exit={:?}, signal={:?}, cleanup={}: {}",
        result.process.termination_reason,
        result.process.exit_code,
        result.process.signal,
        result.process.process_group_cleanup_verified,
        String::from_utf8_lossy(&result.process.stderr_tail)
    );
    serde_json::from_slice(&result.stdout).unwrap()
}
fn prepare(fixture: &Fixture, name: &str) -> NativeInventoryRequestV1 {
    let request = fixture.input(name);
    let mut input = serde_json::to_value(&request).unwrap();
    input["action"] = json!("prepare");
    input["name"] = json!(name);
    assert_eq!(oracle(&input)["registered"], true);
    request
}
fn compare(request: &NativeInventoryRequestV1, label: &str) {
    let expected = oracle(&serde_json::to_value(request).unwrap());
    let cancelled = Arc::new(AtomicBool::new(false));
    let actual = discover_native_inventory_v1(
        request,
        &cancelled,
        Instant::now() + Duration::from_secs(30),
    );
    if expected["ok"] == true {
        let actual = actual.unwrap_or_else(|e| panic!("{label}: {e}"));
        assert_eq!(
            actual.scan(),
            &expected["result"],
            "complete actual incumbent inventory mismatch: {label}"
        );
        actual.verify_unchanged().unwrap();
    } else {
        assert!(
            actual.is_err(),
            "actual incumbent refused {label}: {expected}"
        );
    }
    eprintln!(
        "actual incumbent/native inventory comparison: {label}; incumbentOk={}",
        expected["ok"]
    );
}

#[test]
fn actual_node_inventory_whole_values_cover_registered_files_sql_yaml_fallback_and_state_hashes() {
    for name in [
        "registered",
        "missing-db",
        "empty-venues",
        "empty-auto",
        "yaml",
        "missing-papers",
        "missing-papers-auto",
        "missing-column",
        "malformed-json",
        "malformed-json-auto",
        "numeric-fields",
        "missing-source",
        "no-main",
        "tex-order",
        "loose",
        "quality-formal",
        "quality-malformed",
        "retired",
        "quarantined",
        "null-metadata",
        "proposal",
        "blob-fields",
        "blob-venue",
        "external-empty",
        "external-proposal",
    ] {
        let fixture = Fixture::new();
        let request = prepare(&fixture, name);
        compare(&request, name);
    }
}
#[test]
fn actual_held_inventory_refuses_content_replacement_absence_creation_and_cancellation() {
    let fixture = Fixture::new();
    let request = prepare(&fixture, "registered");
    let cancelled = Arc::new(AtomicBool::new(false));
    let observed = discover_native_inventory_v1(
        &request,
        &cancelled,
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    let target = request.root.join("drafts/local-paper/main.tex");
    let old = fs::read(&target).unwrap();
    fs::rename(&target, target.with_extension("old")).unwrap();
    fs::write(&target, &old).unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    let observed = discover_native_inventory_v1(
        &request,
        &cancelled,
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    fs::create_dir_all(request.root.join("workspaces/local-paper")).unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    let observed = discover_native_inventory_v1(
        &request,
        &cancelled,
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    cancelled.store(true, Ordering::Release);
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    assert!(
        discover_native_inventory_v1(
            &request,
            &cancelled,
            Instant::now() + Duration::from_secs(30)
        )
        .is_err()
    );
    cancelled.store(false, Ordering::Release);
    let retry = discover_native_inventory_v1(
        &request,
        &cancelled,
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    retry.verify_unchanged().unwrap();
}
#[test]
fn actual_inventory_native_alias_hardlink_size_and_proposal_refusals_remain_explicit() {
    let fixture = Fixture::new();
    let request = prepare(&fixture, "registered");
    let cancelled = Arc::new(AtomicBool::new(false));
    let read = |request: &NativeInventoryRequestV1| {
        discover_native_inventory_v1(
            request,
            &cancelled,
            Instant::now() + Duration::from_secs(30),
        )
    };
    let path = request.root.join("drafts/local-paper/main.tex");
    let link = request.root.join("linked.tex");
    fs::hard_link(&path, &link).unwrap();
    assert!(read(&request).is_err());
    fs::remove_file(&link).unwrap();
    let original = fs::read(&path).unwrap();
    fs::rename(&path, path.with_extension("old")).unwrap();
    std::os::unix::fs::symlink(path.with_extension("old"), &path).unwrap();
    // Original Dirent walking leaves this alias unselected. It reports no
    // main TeX, while explicitly selected aliased inputs remain refused.
    compare(&request, "unwalked-main-alias");
    fs::remove_file(&path).unwrap();
    fs::write(&path, &original).unwrap();
    let selected = request.root.join("drafts/local-paper/paper.pdf");
    fs::rename(&selected, selected.with_extension("saved")).unwrap();
    std::os::unix::fs::symlink(selected.with_extension("saved"), &selected).unwrap();
    assert!(read(&request).is_err());
    fs::remove_file(&selected).unwrap();
    fs::rename(selected.with_extension("saved"), &selected).unwrap();
    let registry = request.root.join("registry/venues.yaml");
    let original = fs::read(&registry).unwrap();
    fs::write(&registry, vec![b' '; 256 * 1024 + 1]).unwrap();
    assert_eq!(
        oracle(&serde_json::to_value(&request).unwrap())["ok"],
        true,
        "the original inventory accepts this registry beyond the native v1 cap"
    );
    assert!(read(&request).is_err());
    fs::write(&registry, &original).unwrap();
    let metadata = request.root.join("drafts/local-paper/paper.json");
    let original = fs::read(&metadata).unwrap();
    fs::write(&metadata, br#"{"paper_production":{"profile":"\ud800"}}"#).unwrap();
    assert_eq!(
        oracle(&serde_json::to_value(&request).unwrap())["ok"],
        true,
        "the original inventory accepts an unpaired UTF-16 string"
    );
    assert!(read(&request).is_err());
    fs::write(&metadata, &original).unwrap();
    let mut outside = request.clone();
    outside.proposal_staging_root = Some(fixture.path.join("outside-root"));
    assert!(read(&outside).is_err());
    read(&request).unwrap().verify_unchanged().unwrap();
}

#[test]
fn actual_inventory_empty_yaml_and_retained_observation_refuse_expired_deadlines() {
    let fixture = Fixture::new();
    let mut request = prepare(&fixture, "registered");
    request.inventory_source = "yaml".to_owned();
    request.database = None;
    request.include_loose_drafts = false;
    request.include_proposal_staging = false;
    request.paper_ids = vec!["not-in-inventory".to_owned()];
    let cancelled = Arc::new(AtomicBool::new(false));
    assert!(discover_native_inventory_v1(&request, &cancelled, Instant::now()).is_err());
    let deadline = Instant::now() + Duration::from_secs(3);
    let observation = discover_native_inventory_v1(&request, &cancelled, deadline).unwrap();
    assert_eq!(observation.scan()["rows"], json!([]));
    observation.verify_unchanged().unwrap();
    std::thread::sleep(
        deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(1),
    );
    assert!(observation.verify_unchanged().is_err());
    drop(observation);
    let retry = discover_native_inventory_v1(
        &request,
        &cancelled,
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    retry.verify_unchanged().unwrap();
}

#[test]
fn actual_bound_runtime_inventory_retains_missing_edges_files_alias_refusal_and_fresh_retry() {
    let fixture = Fixture::new();
    let request = prepare(&fixture, "external-empty");
    let cancelled = Arc::new(AtomicBool::new(false));
    let observe = |request: &NativeInventoryRequestV1| {
        discover_native_inventory_v1(
            request,
            &cancelled,
            Instant::now() + Duration::from_secs(30),
        )
    };
    let held = observe(&request).unwrap();
    let staging = request.proposal_staging_root.as_ref().unwrap();
    fs::create_dir(staging).unwrap();
    assert!(held.verify_unchanged().is_err());
    drop(held);
    observe(&request).unwrap().verify_unchanged().unwrap();
    let mut unknown = request.clone();
    unknown.proposal_staging_root = Some(fixture.path.join("unknown/proposal-staging"));
    assert!(observe(&unknown).is_err());
    fs::remove_dir(staging).unwrap();
    let runtime = fixture.path.join("runtime");
    fs::rename(&runtime, fixture.path.join("runtime-saved")).unwrap();
    std::os::unix::fs::symlink(fixture.path.join("runtime-saved"), &runtime).unwrap();
    assert!(observe(&request).is_err());
    fs::remove_file(&runtime).unwrap();
    fs::rename(fixture.path.join("runtime-saved"), &runtime).unwrap();
    observe(&request).unwrap().verify_unchanged().unwrap();
    drop(fixture);
    let fixture = Fixture::new();
    let request = prepare(&fixture, "external-proposal");
    let held = observe(&request).unwrap();
    let path = fixture.path.join("runtime/proposals/p/main.tex");
    let bytes = fs::read(&path).unwrap();
    fs::rename(&path, path.with_extension("saved")).unwrap();
    fs::write(&path, bytes).unwrap();
    assert!(held.verify_unchanged().is_err());
    drop(held);
    compare(&request, "external-proposal-replaced-fresh-retry");
}

#[test]
fn actual_asset_and_runtime_reads_reserve_one_shared_budget_before_read_and_fresh_retry() {
    let fixture = Fixture::new();
    let asset = fixture.path.join("assets");
    let runtime = fixture.path.join("runtime");
    fs::create_dir(&asset).unwrap();
    fs::create_dir(&runtime).unwrap();
    fs::write(asset.join("a.json"), b"abc").unwrap();
    fs::write(runtime.join("b.json"), b"def").unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    // Fixed v1 cap, with already-reserved capacity as a fixture seam. This is
    // an actual reader/admission test, not a claim to stream a 1 GiB corpus.
    let shared = SharedInventoryReadBudgetV1::with_prior_reservations(1024 * 1024 * 1024 - 5);
    let mut left = SourceObservation::new_with_deadline(
        &asset,
        &cancelled,
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    let mut right = SourceObservation::new_with_deadline(
        &runtime,
        &cancelled,
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    shared.attach(&mut left).unwrap();
    shared.attach(&mut right).unwrap();
    assert_eq!(
        left.document(std::path::Path::new("a.json")).unwrap(),
        b"abc"
    );
    assert_eq!(
        right.document(std::path::Path::new("b.json")).unwrap_err(),
        "r_runtime_source_cas_observation_limit_exceeded"
    );
    assert_eq!(right.inventory_read_bytes().unwrap(), 0);
    assert!(shared.attach(&mut right).is_err());
    drop(left);
    drop(right);
    let shared = SharedInventoryReadBudgetV1::new();
    let mut retry = SourceObservation::new_with_deadline(
        &runtime,
        &cancelled,
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    shared.attach(&mut retry).unwrap();
    assert_eq!(
        retry.document(std::path::Path::new("b.json")).unwrap(),
        b"def"
    );
    retry.assert_current().unwrap();
    drop(retry);
    let shared = SharedInventoryReadBudgetV1::with_prior_entries(16_384 - 1);
    let mut left = SourceObservation::new_with_deadline(
        &asset,
        &cancelled,
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    let mut right = SourceObservation::new_with_deadline(
        &runtime,
        &cancelled,
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    shared.attach(&mut left).unwrap();
    shared.attach(&mut right).unwrap();
    assert_eq!(
        left.inventory_entries(std::path::Path::new(""))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        right
            .inventory_entries(std::path::Path::new(""))
            .unwrap_err(),
        "r_runtime_source_cas_observation_limit_exceeded"
    );
    let mut original = SourceObservation::new(&asset, &cancelled).unwrap();
    assert_eq!(
        original.document(std::path::Path::new("a.json")).unwrap(),
        b"abc"
    );
    original.assert_current().unwrap();
}

#[test]
fn actual_immutable_batch_inventory_preserves_namespace_and_holds_missing_sidecars() {
    for name in [
        "registered",
        "registered-yaml",
        "malformed-json-yaml",
        "known-marker",
        "partial-marker",
        "unknown-schema",
        "changed-schema",
    ] {
        let fixture = Fixture::new();
        let mut request = prepare(&fixture, name);
        if name.ends_with("-yaml") {
            request.inventory_source = "yaml".to_owned();
        }
        let database = request.database.as_ref().unwrap();
        let before = fs::read(database).unwrap();
        let parent = database.parent().unwrap();
        let names = || {
            let mut names = fs::read_dir(parent)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>();
            names.sort();
            names
        };
        let names_before = names();
        let cancelled = Arc::new(AtomicBool::new(false));
        let observed = discover_native_immutable_batch_inventory_v1(
            &request,
            &cancelled,
            Instant::now() + Duration::from_secs(30),
        );
        if matches!(
            name,
            "registered" | "registered-yaml" | "malformed-json-yaml" | "known-marker"
        ) {
            let observed = observed.unwrap_or_else(|error| panic!("{name}: {error}"));
            let expected = oracle(&serde_json::to_value(&request).unwrap());
            assert_eq!(expected["ok"], true);
            assert_eq!(observed.scan(), &expected["result"]);
            observed.verify_unchanged().unwrap();
            assert_eq!(names(), names_before);
            assert_eq!(fs::read(database).unwrap(), before);
            cancelled.store(true, Ordering::Release);
            assert!(observed.verify_unchanged().is_err());
            cancelled.store(false, Ordering::Release);
            let mut sidecar = database.as_os_str().to_owned();
            sidecar.push("-wal");
            let sidecar = PathBuf::from(sidecar);
            fs::write(&sidecar, []).unwrap();
            assert!(observed.verify_unchanged().is_err());
            assert!(
                discover_native_immutable_batch_inventory_v1(
                    &request,
                    &cancelled,
                    Instant::now() + Duration::from_secs(30)
                )
                .is_err()
            );
            assert!(sidecar.exists(), "refusal cannot clean unknown sidecars");
            assert_eq!(fs::read(database).unwrap(), before);
        } else {
            assert!(
                observed.is_err(),
                "strict complete known schema must refuse {name}"
            );
            assert_eq!(names(), names_before);
            assert_eq!(fs::read(database).unwrap(), before);
        }
    }
    let fixture = Fixture::new();
    let request = prepare(&fixture, "registered");
    let cancelled = Arc::new(AtomicBool::new(false));
    let retained_deadline = Instant::now() + Duration::from_secs(3);
    let observed =
        discover_native_immutable_batch_inventory_v1(&request, &cancelled, retained_deadline)
            .unwrap();
    // Observe expiry after successful admission, rather than assuming schema
    // replay finishes inside an arbitrarily short admission deadline.
    std::thread::sleep(
        retained_deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(1),
    );
    assert!(observed.verify_unchanged().is_err());
    assert!(
        discover_native_immutable_batch_inventory_v1(
            &request,
            &cancelled,
            Instant::now() - Duration::from_millis(1)
        )
        .is_err()
    );
}
