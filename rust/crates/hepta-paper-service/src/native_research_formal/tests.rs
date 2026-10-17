use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::AtomicU64,
};
static NEXT: AtomicU64 = AtomicU64::new(1);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "hepta-formal-universe-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn request(p: &Path) -> NativeFormalClaimUniverseRequestV1 {
    NativeFormalClaimUniverseRequestV1 {
        version: 1,
        source_root: p.into(),
        manuscript_path: "main.tex".into(),
        maximum_files: 128,
    }
}
#[test]
fn actual_formal_include_graph_declarations_theorems_and_proofs_match_original_node_whole_values() {
    let temp = Temp::new();
    let mut inputs = Vec::new();
    for n in 0..12 {
        let p = temp.0.join(format!("case{n}"));
        fs::create_dir(&p).unwrap();
        inputs.push(request(&p));
    }
    let write = |n: usize, name: &str, bytes: &[u8]| {
        fs::write(inputs[n].source_root.join(name), bytes).unwrap()
    };
    write(1,"main.tex",br"\begin{theorem}Every actual integer has a successor.\end{theorem}\begin{proof}Construct n+1.\end{proof}");
    write(2,"main.tex",br"\newtheorem{result}{Result}\begin{theorem}Root first.\end{theorem}\begin{proof}First proof.\end{proof}\input{child}\begin{result}[Title]Root final.\end{result}\begin{proof}Last proof.\end{proof}");
    write(
        2,
        "child.tex",
        br"\begin{lemma}Included statement.\end{lemma}\begin{proof}Included proof.\end{proof}",
    );
    write(3,"main.tex",br"\newtheorem*{unnumbered}{Unnumbered}\newtheorem{alias}[unnumbered]{Alias}\newtheorem{bad}[unknown]{Bad}\newtheorem{proof}{Proof}\newtheorem{alias}{Duplicate}\begin{alias}actual\end{alias}\begin{proof}q\end{proof}");
    write(4,"main.tex",b"% \\input{hidden}\n\\input{missing}\n\\input macro\n\\include{../bad}\n\\newcommand{\\fake}{\\begin{theorem}Fake\\end{theorem}}\n\\input{broken{path}\n");
    write(5,"main.tex",br"\begin{theorem}Outer \begin{lemma}Nested\end{lemma}\begin{proof}P\end{proof}\end{theorem}\begin{theorem}No adjacent proof\end{theorem}ordinary text\begin{proof}Unpaired\end{proof}\begin{proposition}Never ends");
    write(6,"main.tex","é🦀 prefix\n\\begin{theorem}[Unicode]  α + β = γ.  \\end{theorem}\n%masked\n\\begin{proof}  Construct Ω. \\end{proof}\n".as_bytes());
    write(7,"main.tex",br"\input{child}\begin{theorem}Root statement\end{theorem}\begin{proof}Root proof\end{proof}");
    write(
        7,
        "child.tex",
        br"\input{main}\begin{lemma}Child statement\end{lemma}\begin{proof}Child proof\end{proof}",
    );
    write(
        8,
        "main.tex",
        br"\input{child}\begin{theorem}Still known\end{theorem}\begin{proof}p\end{proof}",
    );
    write(
        8,
        "child.tex",
        br"\begin{lemma}Unvisited\end{lemma}\begin{proof}p\end{proof}",
    );
    write(9, "main.tex", br"\input{file0}");
    for n in 0..34 {
        write(
            9,
            &format!("file{n}.tex"),
            format!("\\input{{file{}}}", n + 1).as_bytes(),
        );
    }
    write(10,"main.tex",br"\newtheorem{zeta}[alpha]{Zeta}\newtheorem{alpha}[zeta]{Alpha}\begin{zeta}Real body\end{zeta}\begin{proof}q\end{proof}");
    write(
        11,
        "main.tex",
        b"\\begin{theorem}\xff\xf0\x80\x80\x80\\end{theorem}\\begin{proof}q\\end{proof}",
    );
    inputs[8].maximum_files = 1;
    let node = std::env::var_os("HEPTA_TEST_NODE")
        .map(PathBuf::from)
        .expect("qualified Node required");
    let cwd = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let script = r#"import{readFormalClaimUniverse}from'./paper-adapters/research-verify/formal-claim-universe-reader.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>65536)throw Error('input');}process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},values:JSON.parse(raw).map(v=>readFormalClaimUniverse(v))}));"#;
    let env = EnvironmentPolicyV1::new(
        "actual-formal-universe-differential",
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
            executable: node,
            arguments: vec!["--input-type=module".into(), "--eval".into(), script.into()],
            working_directory: cwd,
            environment: env,
            stdin: Some(serde_json::to_vec(&inputs).unwrap()),
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
    assert_eq!(node.process.stderr_bytes, 0);
    assert!(node.process.process_group_cleanup_verified);
    let actual: Value = serde_json::from_slice(&node.stdout).unwrap();
    assert_eq!(
        actual["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    for (n, request) in inputs.into_iter().enumerate() {
        let c = AtomicBool::new(false);
        let observed = inspect_native_formal_claim_universe_v1(
            request,
            &c,
            Instant::now() + std::time::Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(
            *observed.observed(),
            actual["values"][n],
            "complete original formal universe case{n}"
        );
        observed.verify_unchanged().unwrap();
    }
    println!(
        "actual_native_formal_universe_observation={}",
        json!({"nodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"actualWholeCases":12,"fullResearchAdapterAccepted":false})
    );
}
#[test]
fn actual_formal_universe_refuses_cancel_deadline_byte_budget_alias_and_rechecks_namespace() {
    let temp = Temp::new();
    let c = AtomicBool::new(false);
    let deadline = || Instant::now() + std::time::Duration::from_secs(60);
    fs::write(
        temp.0.join("main.tex"),
        br"\begin{theorem}Real theorem\end{theorem}\begin{proof}q\end{proof}",
    )
    .unwrap();
    let observed =
        inspect_native_formal_claim_universe_v1(request(&temp.0), &c, deadline()).unwrap();
    fs::write(temp.0.join("main.tex"), b"changed").unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    assert!(
        inspect_native_formal_claim_universe_v1(
            request(&temp.0),
            &AtomicBool::new(true),
            deadline()
        )
        .is_err()
    );
    assert!(inspect_native_formal_claim_universe_v1(request(&temp.0), &c, Instant::now()).is_err());
    fs::write(temp.0.join("main.tex"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
    assert!(inspect_native_formal_claim_universe_v1(request(&temp.0), &c, deadline()).is_err());
    fs::write(temp.0.join("main.tex"), br"\input{child}").unwrap();
    symlink(temp.0.join("main.tex"), temp.0.join("child.tex")).unwrap();
    assert!(inspect_native_formal_claim_universe_v1(request(&temp.0), &c, deadline()).is_err());
    fs::remove_file(temp.0.join("child.tex")).unwrap();
    let observed =
        inspect_native_formal_claim_universe_v1(request(&temp.0), &c, deadline()).unwrap();
    fs::write(temp.0.join("child.tex"), b"new").unwrap();
    assert!(observed.verify_unchanged().is_err());
    let mut projected = serde_json::to_value(request(&temp.0)).unwrap();
    projected["theorems"] = json!([]);
    assert!(serde_json::from_value::<NativeFormalClaimUniverseRequestV1>(projected).is_err());
}
