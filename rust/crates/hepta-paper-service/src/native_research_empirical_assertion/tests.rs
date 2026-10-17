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
    time::Duration,
};
static NEXT: AtomicU64 = AtomicU64::new(1);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "hepta-assertion-universe-{}-{}",
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
fn request(root: &Path) -> NativeEmpiricalAssertionUniverseRequestV1 {
    NativeEmpiricalAssertionUniverseRequestV1 {
        version: 1,
        source_root: root.into(),
        manuscript_path: "main.tex".into(),
        maximum_files: 128,
        derive_claim_universe: false,
    }
}
fn assertion(id: &str) -> Value {
    json!({"version":1,"assertionId":id,"authorityEntryHash":format!("sha256:{}","a".repeat(64))})
}
fn surface(id: &str) -> Value {
    json!({"version":1,"surfaceId":id,"surfaceKind":"confirmatory_result_table","surfaceAuthorityEntryHash":format!("sha256:{}","b".repeat(64)),"artifactPath":null,"artifactHash":null})
}
fn marker(kind: &str, declaration: &Value, text: &str, end: &str) -> String {
    format!(
        "% HEPTA_EMPIRICAL_{kind}_BEGIN {}\n{text}\n% HEPTA_EMPIRICAL_{kind}_END {end}\n",
        serde_json::to_string(declaration).unwrap()
    )
}
#[test]
fn actual_assertion_presentation_artifact_prose_and_include_universes_match_original_node_complete_values()
 {
    let temp = Temp::new();
    let modes = [
        "valid",
        "safe-prose",
        "table",
        "figure",
        "wrong-figure-hash",
        "missing-figure",
        "include-order",
        "include-repeat",
        "cycle",
        "invalid-json",
        "invalid-fields",
        "malformed",
        "nested",
        "unpaired",
        "mismatch",
        "unterminated",
        "empty-body",
        "invalid-utf8",
        "duplicate-assertion",
        "duplicate-surface",
        "untyped",
        "unsupported",
        "environment",
        "untrusted-section",
        "legacy",
        "macro",
        "support-markers",
        "evidence-markers",
        "forbidden-sty",
        "render-symlink",
        "missing-main",
        "max-zero",
        "crlf",
        "latin1-space",
        "trusted-claim",
        "blocked-trusted-claim",
    ];
    let mut requests = Vec::new();
    for mode in modes {
        let root = temp.0.join(mode);
        fs::create_dir(&root).unwrap();
        let mut input = request(&root);
        let base = marker(
            "ASSERTION",
            &assertion("assertion:a"),
            "A declared result.",
            "assertion:a",
        );
        let text=match mode{
            "safe-prose"=>format!("\\documentclass[11pt]{{article}}\n\\usepackage{{amsmath,amssymb,amsthm}}\n\\title{{Autonomous bounded research report}}\n\\author{{}}\n\\begin{{document}}\n\\section{{Results}}\nThis report is limited to the registered typed assertions and kernel-verified formal theorem.\n{base}\\end{{document}}\n"),
            "table"=>format!("{base}{}",marker("PRESENTATION",&surface("surface:a"),"\\begin{table}\nDeclared table.\n\\end{table}","surface:a")),
            "figure"|"wrong-figure-hash"|"missing-figure"=>{fs::create_dir(root.join("figures")).unwrap();let bytes=b"%PDF-1.7\nfixture artifact\n";if mode!="missing-figure"{fs::write(root.join("figures/result.pdf"),bytes).unwrap()};let mut d=surface("surface:a");d["surfaceKind"]=json!("confirmatory_result_figure");d["artifactPath"]=json!("figures/result.pdf");d["artifactHash"]=json!(if mode=="wrong-figure-hash"{format!("sha256:{}","0".repeat(64))}else{bytes_hash(bytes)});format!("{base}{}",marker("PRESENTATION",&d,"\\begin{figure}\n\\includegraphics{figures/result.pdf}\n\\end{figure}","surface:a"))},
            "include-order"=>{fs::write(root.join("child.tex"),marker("ASSERTION",&assertion("assertion:z"),"Child result.","assertion:z")).unwrap();format!("\\input{{child}}\n{base}")},
            "include-repeat"=>{fs::write(root.join("child.tex"),"% comments only\n").unwrap();format!("\\input{{child}}\n\\input{{child}}\n{base}")},
            "cycle"=>{fs::write(root.join("child.tex"),"\\input{main}\n").unwrap();format!("\\input{{child}}\n{base}")},
            "invalid-json"=>"% HEPTA_EMPIRICAL_ASSERTION_BEGIN {bad}\nIgnored raw prose\n% HEPTA_EMPIRICAL_ASSERTION_END assertion:a\n".into(),
            "invalid-fields"=>{let mut d=assertion("assertion:a");d["extra"]=json!(1);marker("ASSERTION",&d,"Text","assertion:a")},
            "malformed"=>format!("% HEPTA_EMPIRICAL_ASSERTION_BEGIN wrong\n{base}"),
            "nested"=>format!("% HEPTA_EMPIRICAL_ASSERTION_BEGIN {}\n{base}",assertion("assertion:a")),
            "unpaired"=>format!("% HEPTA_EMPIRICAL_ASSERTION_END assertion:a\n{base}"),
            "mismatch"=>marker("ASSERTION",&assertion("assertion:a"),"Body","assertion:b"),
            "unterminated"=>format!("% HEPTA_EMPIRICAL_ASSERTION_BEGIN {}\nBody\n",assertion("assertion:a")),
            "empty-body"=>marker("ASSERTION",&assertion("assertion:a")," \t ","assertion:a"),
            "invalid-utf8"=>base.clone(),
            "duplicate-assertion"=>format!("{base}{base}"),
            "duplicate-surface"=>format!("{base}{}{}",marker("PRESENTATION",&surface("surface:a"),"Table","surface:a"),marker("PRESENTATION",&surface("surface:a"),"Other table","surface:a")),
            "untyped"=>format!("{base}Unregistered quantitative prose.\n"),
            "unsupported"=>format!("\\subsection{{Values}}\n{base}"),
            "environment"=>format!("\\begin{{theorem}}\n{base}\\end{{theorem}}\n"),
            "untrusted-section"=>format!("\\section{{New external claim}}\n{base}"),
            "legacy"=>format!("% HEPTA_RESULT value\n{base}"),
            "macro"=>format!("\\newcommand{{\\bad}}{{\\input{{other}}}}\n{base}"),
            "support-markers"=>format!("% HEPTA_FORMAL_SUPPORT_BEGIN {{}}\nSupposed support.\n% HEPTA_FORMAL_SUPPORT_END support:a\n{base}"),
            "evidence-markers"=>format!("% HEPTA_EVIDENCE_BOUND_PROSE_BEGIN {{}}\nSupposed bound prose.\n% HEPTA_EVIDENCE_BOUND_PROSE_END block:a\n{base}"),
            "forbidden-sty"=>{fs::write(root.join("custom.sty"),b"% custom").unwrap();base.clone()},
            "render-symlink"=>{symlink("missing",root.join("link")).unwrap();base.clone()},
            "missing-main"=>base.clone(),
            "max-zero"=>{input.maximum_files=0;base.clone()},
            "crlf"=>base.replace('\n',"\r\n"),
            "latin1-space"=>base.clone(),
            "trusted-claim"|"blocked-trusted-claim"=>{input.derive_claim_universe=true;let d=json!({"claimId":"claim:a","metric":"accuracy","comparator":"baseline","alternative":"greater","minimumEffect":0.01,"acceptanceRequired":true,"proposalClaimRecordHash":null});let mut s=format!("{base}{}",marker("CLAIM",&d,"A preregistered empirical claim.","claim:a"));if mode=="blocked-trusted-claim"{s.push_str("% HEPTA_EMPIRICAL_CLAIM_BEGIN malformed\n")};s},
            _=>base.clone(),
        };
        if mode == "invalid-utf8" {
            let mut bytes = format!(
                "% HEPTA_EMPIRICAL_ASSERTION_BEGIN {}\n",
                assertion("assertion:a")
            )
            .into_bytes();
            bytes.push(255);
            bytes.extend_from_slice(b"\n% HEPTA_EMPIRICAL_ASSERTION_END assertion:a\n");
            fs::write(root.join("main.tex"), bytes).unwrap()
        } else if mode == "latin1-space" {
            let bytes = text
                .as_bytes()
                .iter()
                .flat_map(|b| {
                    if *b == b'%' {
                        vec![160, b'%']
                    } else {
                        vec![*b]
                    }
                })
                .collect::<Vec<_>>();
            fs::write(root.join("main.tex"), bytes).unwrap()
        } else if mode != "missing-main" {
            fs::write(root.join("main.tex"), text).unwrap()
        }
        requests.push(input);
    }
    let script = r#"import{readEmpiricalAssertionUniverse}from'./paper-adapters/research-verify/empirical-assertion-universe-reader.mjs';import{readEmpiricalClaimUniverse}from'./paper-adapters/research-verify/empirical-claim-universe-reader.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>65536)throw Error('input');}const values=JSON.parse(raw).map(input=>{const{deriveClaimUniverse,...args}=input;const trustedEmpiricalClaimUniverse=deriveClaimUniverse?readEmpiricalClaimUniverse(args):null;return readEmpiricalAssertionUniverse({...args,trustedEmpiricalClaimUniverse})});process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},values}));"#;
    let env = EnvironmentPolicyV1::new(
        "actual-empirical-assertion",
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
                .expect("qualified Node"),
            arguments: vec!["--input-type=module".into(), "--eval".into(), script.into()],
            working_directory: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()
                .unwrap(),
            environment: env,
            stdin: Some(serde_json::to_vec(&requests).unwrap()),
        },
        ProcessLimitsV1 {
            timeout_ms: 60000,
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
    for (index, r) in requests.into_iter().enumerate() {
        let c = AtomicBool::new(false);
        let observed = inspect_native_empirical_assertion_universe_v1(
            r,
            &c,
            Instant::now() + Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(
            *observed.observed(),
            actual["values"][index],
            "whole original {}",
            modes[index]
        );
        observed.verify_unchanged().unwrap()
    }
    println!(
        "actual_empirical_assertion_universe={}",
        json!({"actualWholeCases":modes.len(),"nodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"externalAuthorityGranted":false,"fullResearchAdapterAccepted":false})
    );
}
#[test]
fn actual_assertion_observation_refuses_changed_artifact_cancel_expiry_derived_overflow_and_preserves_fresh_retry()
 {
    let temp = Temp::new();
    let c = AtomicBool::new(false);
    let deadline = || Instant::now() + Duration::from_secs(60);
    let content = marker(
        "ASSERTION",
        &assertion("assertion:a"),
        "Body",
        "assertion:a",
    );
    fs::write(temp.0.join("main.tex"), &content).unwrap();
    let observed =
        inspect_native_empirical_assertion_universe_v1(request(&temp.0), &c, deadline()).unwrap();
    assert_eq!(
        observed.observed()["status"],
        "empirical_assertion_universe_verified"
    );
    fs::write(temp.0.join("main.tex"), b"changed").unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    assert!(
        inspect_native_empirical_assertion_universe_v1(
            request(&temp.0),
            &AtomicBool::new(true),
            deadline()
        )
        .is_err()
    );
    assert!(
        inspect_native_empirical_assertion_universe_v1(request(&temp.0), &c, Instant::now())
            .is_err()
    );
    fs::write(
        temp.0.join("main.tex"),
        marker(
            "ASSERTION",
            &assertion("assertion:a"),
            &"a".repeat(65537),
            "assertion:a",
        ),
    )
    .unwrap();
    assert!(
        inspect_native_empirical_assertion_universe_v1(request(&temp.0), &c, deadline()).is_err()
    );
    fs::write(temp.0.join("main.tex"), &content).unwrap();
    let fresh =
        inspect_native_empirical_assertion_universe_v1(request(&temp.0), &c, deadline()).unwrap();
    assert_eq!(
        fresh.observed()["status"],
        "empirical_assertion_universe_verified"
    );
    fresh.verify_unchanged().unwrap();
    drop(fresh);
    let artifact_bytes = b"%PDF-1.7\nactual bounded fixture\n";
    fs::create_dir(temp.0.join("figures")).unwrap();
    fs::write(temp.0.join("figures/result.pdf"), artifact_bytes).unwrap();
    let mut figure = surface("figure:a");
    figure["surfaceKind"] = json!("confirmatory_result_figure");
    figure["artifactPath"] = json!("figures/result.pdf");
    figure["artifactHash"] = json!(bytes_hash(artifact_bytes));
    fs::write(
        temp.0.join("main.tex"),
        format!(
            "{content}{}",
            marker("PRESENTATION", &figure, "Figure body", "figure:a")
        ),
    )
    .unwrap();
    let observed =
        inspect_native_empirical_assertion_universe_v1(request(&temp.0), &c, deadline()).unwrap();
    assert_eq!(
        observed.observed()["presentationArtifacts"][0]["status"],
        "empirical_presentation_artifact_verified"
    );
    fs::write(temp.0.join("figures/result.pdf"), b"mutated bytes").unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    fs::write(temp.0.join("figures/result.pdf"), artifact_bytes).unwrap();
    inspect_native_empirical_assertion_universe_v1(request(&temp.0), &c, deadline())
        .unwrap()
        .verify_unchanged()
        .unwrap();
    let root = temp.0.join("aggregate");
    fs::create_dir(&root).unwrap();
    for i in 0..5 {
        let includes = if i < 4 {
            format!("\\input{{f{}}}\n", i + 1)
        } else {
            String::new()
        };
        fs::write(
            root.join(format!("f{i}.tex")),
            format!("{includes}%{}\n{}", "x".repeat(900 * 1024), content),
        )
        .unwrap()
    }
    let mut req = request(&root);
    req.manuscript_path = "f0.tex".into();
    let mut ctx = NativeResearchReadContextV1::new(&c, deadline());
    assert!(inspect_native_empirical_assertion_universe_with_context_v1(req, &mut ctx).is_err());
    assert!(ctx.require_active().is_err());
    assert!(ctx.charged_bytes() <= 4 * 1024 * 1024);
    assert!(serde_json::from_value::<NativeEmpiricalAssertionUniverseRequestV1>(json!({"version":1,"sourceRoot":temp.0,"manuscriptPath":"main.tex","maximumFiles":128,"deriveClaimUniverse":false,"trustedEmpiricalClaimUniverseHash":"caller"})).is_err());
}
