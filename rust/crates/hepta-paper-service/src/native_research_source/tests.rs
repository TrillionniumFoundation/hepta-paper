use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};
static NEXT_SOURCE_FIXTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-research-source-{}-{}",
            std::process::id(),
            NEXT_SOURCE_FIXTURE.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn actual_complete_source_snapshot_and_merkle_match_original_node_values() {
    let root = Temp::new();
    let mut cases = Vec::new();
    for n in 0..4 {
        let p = root.path().join(format!("case{n}"));
        fs::create_dir(&p).unwrap();
        cases.push(p);
    }
    fs::create_dir(cases[1].join("src")).unwrap();
    fs::write(cases[1].join("main.tex"), b"Actual manuscript\n").unwrap();
    fs::write(
        cases[1].join("src/evidence.json"),
        b"{\"claims\":[{\"id\":\"a\",\"text\":\"actual\"}]}",
    )
    .unwrap();
    fs::set_permissions(cases[1].join("src"), fs::Permissions::from_mode(0o750)).unwrap();
    fs::set_permissions(cases[1].join("main.tex"), fs::Permissions::from_mode(0o640)).unwrap();
    for name in [".git", "runtime", "src", ".venv-test", "venv"] {
        fs::create_dir(cases[2].join(name)).unwrap();
        fs::write(cases[2].join(name).join("data.txt"), name.as_bytes()).unwrap();
    }
    fs::create_dir(cases[2].join("src/runtime")).unwrap();
    fs::write(
        cases[2].join("src/runtime/native.txt"),
        b"Nested executable source is included",
    )
    .unwrap();
    fs::create_dir(cases[2].join("src/.venv-test")).unwrap();
    fs::write(
        cases[2].join("src/.venv-test/ignored.txt"),
        b"Excluded by the actual root name set",
    )
    .unwrap();
    for (n, name) in [
        "A.txt",
        "a.txt",
        "\u{00e9}.txt",
        "e\u{0301}.txt",
        "\u{10000}.txt",
        "\u{e000}.txt",
        "Ａ.txt",
        "中文.txt",
    ]
    .iter()
    .enumerate()
    {
        fs::write(cases[3].join(name), format!("{n}\n")).unwrap();
    }
    let code = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let script = r#"import{inspectWorkspaceExecutionSnapshot,directoryMerkleHash,sourceTreeExcludedNames}from'./paper-adapters/runtime/execution-snapshot.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>65536)throw Error('input');}const roots=JSON.parse(raw);process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr,locale:new Intl.Collator().resolvedOptions().locale},records:roots.map(root=>{const excludeNames=sourceTreeExcludedNames(root);return{workspaceSnapshot:inspectWorkspaceExecutionSnapshot(root,{excludeNames}),sourceMerkle:directoryMerkleHash(root,{excludeNames})};})}));"#;
    let env = EnvironmentPolicyV1::new(
        "source-snapshot-differential",
        ["PATH", "LANG", "LC_ALL"],
        ["PATH"],
    )
    .unwrap()
    .build(
        std::iter::empty::<(std::ffi::OsString, std::ffi::OsString)>(),
        &BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("LANG".into(), "C.UTF-8".into()),
            ("LC_ALL".into(), "C.UTF-8".into()),
        ]),
    )
    .unwrap();
    let node = run_bounded_process_capturing_stdout_with_cancellation(
        &BoundedProcessRequestV1 {
            executable: std::env::var_os("HEPTA_TEST_NODE")
                .map(PathBuf::from)
                .expect("qualified Node required"),
            arguments: vec!["--input-type=module".into(), "--eval".into(), script.into()],
            working_directory: code,
            environment: env,
            stdin: Some(serde_json::to_vec(&cases).unwrap()),
        },
        ProcessLimitsV1 {
            timeout_ms: 60_000,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2000,
            maximum_stdin_bytes: 65536,
            maximum_stdout_bytes: 4 * 1024 * 1024,
            maximum_stderr_bytes: 65536,
            maximum_tail_bytes: 32768,
            ..ProcessLimitsV1::default()
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(
        node.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert_eq!(node.process.exit_code, Some(0));
    assert!(node.process.process_group_cleanup_verified);
    assert_eq!(node.process.stderr_bytes, 0);
    let actual: Value = serde_json::from_slice(&node.stdout).unwrap();
    assert_eq!(
        actual["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0","locale":"en-US"})
    );
    for (n, source_root) in cases.into_iter().enumerate() {
        let cancelled = AtomicBool::new(false);
        let observed = inspect_native_research_source_snapshot_v1(
            NativeResearchSourceSnapshotRequestV1 {
                version: 1,
                source_root,
            },
            &cancelled,
            Instant::now() + std::time::Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(
            *observed.snapshot(),
            actual["records"][n],
            "actual original complete source snapshot and merkle case {n}"
        );
        observed.verify_unchanged().unwrap();
    }
    println!(
        "actual_research_source_snapshot_observation={}",
        json!({"nodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"actualCases":4,"completeSourceNamespaceObserved":true,"sourceMutation":false,"fullResearchAdapterAccepted":false})
    );
}
#[test]
fn actual_source_snapshot_refuses_changed_namespace_content_cancel_bounds_and_unsafe_inputs() {
    let r = Temp::new();
    fs::write(r.path().join("data.txt"), b"Actual bytes").unwrap();
    let cancelled = AtomicBool::new(false);
    let request = || NativeResearchSourceSnapshotRequestV1 {
        version: 1,
        source_root: r.path().to_owned(),
    };
    let deadline = || Instant::now() + std::time::Duration::from_secs(60);
    let observed =
        inspect_native_research_source_snapshot_v1(request(), &cancelled, deadline()).unwrap();
    fs::write(r.path().join("data.txt"), b"changed bytes").unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    let observed =
        inspect_native_research_source_snapshot_v1(request(), &cancelled, deadline()).unwrap();
    fs::write(r.path().join("new.txt"), b"new name").unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    assert!(
        inspect_native_research_source_snapshot_v1(request(), &AtomicBool::new(true), deadline())
            .is_err()
    );
    assert!(
        inspect_native_research_source_snapshot_v1(request(), &cancelled, Instant::now()).is_err()
    );
    let large = Temp::new();
    fs::write(
        large.path().join("too-large.txt"),
        vec![b'x'; MAX_BYTES as usize + 1],
    )
    .unwrap();
    assert!(
        inspect_native_research_source_snapshot_v1(
            NativeResearchSourceSnapshotRequestV1 {
                version: 1,
                source_root: large.path().into()
            },
            &cancelled,
            deadline()
        )
        .is_err()
    );
    let links = Temp::new();
    symlink(r.path().join("data.txt"), links.path().join("link.txt")).unwrap();
    assert!(
        inspect_native_research_source_snapshot_v1(
            NativeResearchSourceSnapshotRequestV1 {
                version: 1,
                source_root: links.path().into()
            },
            &cancelled,
            deadline()
        )
        .is_err()
    );
    let hard = Temp::new();
    fs::hard_link(r.path().join("data.txt"), hard.path().join("hard.txt")).unwrap();
    assert!(
        inspect_native_research_source_snapshot_v1(
            NativeResearchSourceSnapshotRequestV1 {
                version: 1,
                source_root: hard.path().into()
            },
            &cancelled,
            deadline()
        )
        .is_err()
    );
    let mut invalid = serde_json::to_value(request()).unwrap();
    invalid["sourceMerkle"] = json!("caller");
    assert!(serde_json::from_value::<NativeResearchSourceSnapshotRequestV1>(invalid).is_err());
}
