use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, sync::atomic::AtomicU64};
static NEXT: AtomicU64 = AtomicU64::new(1);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "hepta-empirical-claim-{}-{}",
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
fn request(root: &Path) -> NativeEmpiricalClaimUniverseRequestV1 {
    NativeEmpiricalClaimUniverseRequestV1 {
        version: 1,
        source_root: root.into(),
        manuscript_path: "main.tex".into(),
        maximum_files: 128,
    }
}
fn declaration(id: &str) -> Value {
    json!({"claimId":id,"metric":"accuracy","comparator":"baseline","alternative":"greater","minimumEffect":0.01,"acceptanceRequired":true,"proposalClaimRecordHash":null})
}
fn claim(d: &Value, body: &str, end: &str) -> String {
    format!(
        "% HEPTA_EMPIRICAL_CLAIM_BEGIN {}\n{body}\n% HEPTA_EMPIRICAL_CLAIM_END {end}\n",
        serde_json::to_string(d).unwrap()
    )
}
#[test]
fn actual_empirical_marker_include_identity_and_canonical_claims_match_original_node_whole_values()
{
    let temp = Temp::new();
    let modes = [
        "valid",
        "include-order",
        "duplicate-id",
        "negative",
        "hex-large",
        "null-effect",
        "bool-effect",
        "array-effect",
        "metric-array",
        "invalid-fields",
        "invalid-comparator",
        "infinity-string",
        "false-id",
        "invalid-json",
        "malformed",
        "nested",
        "end-unpaired",
        "id-mismatch",
        "unterminated",
        "empty-body",
        "invalid-utf8",
        "macro",
        "missing-main",
        "include-cycle",
        "max-zero",
        "unsafe-path",
        "negative-zero",
        "crlf",
        "unicode-body",
    ];
    let mut requests = Vec::new();
    for (n, mode) in modes.iter().enumerate() {
        let root = temp.0.join(format!("case{n}"));
        fs::create_dir(&root).unwrap();
        let mut r = request(&root);
        let mut d = declaration("claim:a");
        match *mode {
            "negative" => d["minimumEffect"] = json!(-1),
            "hex-large" => d["minimumEffect"] = json!("0x100000000000000000000"),
            "null-effect" => d["minimumEffect"] = Value::Null,
            "bool-effect" => d["minimumEffect"] = json!(false),
            "array-effect" => d["minimumEffect"] = json!(["2"]),
            "metric-array" => d["metric"] = json!(["accuracy"]),
            "invalid-fields" => d["extra"] = json!(true),
            "invalid-comparator" => d["comparator"] = json!("unregistered"),
            "infinity-string" => d["minimumEffect"] = json!("Infinity"),
            "false-id" => d["claimId"] = json!(false),
            "negative-zero" => d["minimumEffect"] = json!(-0.0),
            _ => (),
        }
        let body = if *mode == "unicode-body" {
            "Actual Ω measured proposition 🐱"
        } else {
            "Actual registered empirical proposition"
        };
        let mut text = claim(&d, body, "claim:a");
        match *mode{
 "include-order"=>{text=claim(&d,"First source-bound proposition","claim:a")+"\\input{child}\n"+&claim(&declaration("claim:c"),"Third source-bound proposition","claim:c");fs::write(root.join("child.tex"),claim(&declaration("claim:b"),"Second included proposition","claim:b")).unwrap();},
 "duplicate-id"=>text+=&claim(&d,"Second duplicate id","claim:a"),"invalid-json"=>text="% HEPTA_EMPIRICAL_CLAIM_BEGIN {not json}\nbody\n% HEPTA_EMPIRICAL_CLAIM_END claim:a\n".into(),"malformed"=>text="HEPTA_EMPIRICAL_CLAIM_BEGIN malformed\n".into(),"nested"=>text=format!("% HEPTA_EMPIRICAL_CLAIM_BEGIN {}\n",serde_json::to_string(&d).unwrap())+&claim(&d,"Nested marker body","claim:a"),"end-unpaired"=>text="% HEPTA_EMPIRICAL_CLAIM_END claim:a\n".into(),"id-mismatch"=>text=claim(&d,body,"claim:other"),"unterminated"=>text=format!("% HEPTA_EMPIRICAL_CLAIM_BEGIN {}\n{body}\n",serde_json::to_string(&d).unwrap()),"empty-body"=>text=claim(&d," \t","claim:a"),"macro"=>text="\\newcommand{\\dynamic}{\\input{hidden}}\n".to_owned()+&text,"include-cycle"=>{text="\\input{child}\n".to_owned()+&text;fs::write(root.join("child.tex"),"\\input{main}\n").unwrap();},"max-zero"=>r.maximum_files=0,"unsafe-path"=>r.manuscript_path="../outside.tex".into(),"crlf"=>text=text.replace('\n',"\r\n"),_=>()}
        if *mode != "missing-main" {
            if *mode == "invalid-utf8" {
                let mut bytes = format!(
                    "% HEPTA_EMPIRICAL_CLAIM_BEGIN {}\n",
                    serde_json::to_string(&d).unwrap()
                )
                .into_bytes();
                bytes.push(255);
                bytes.extend_from_slice(b"\n% HEPTA_EMPIRICAL_CLAIM_END claim:a\n");
                fs::write(root.join("main.tex"), bytes).unwrap();
            } else {
                fs::write(root.join("main.tex"), text).unwrap();
            }
        }
        requests.push(r);
    }
    let script = r#"import{readEmpiricalClaimUniverse,canonicalEmpiricalClaimsFromUniverse}from'./paper-adapters/research-verify/empirical-claim-universe-reader.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>65536)throw Error('input');}const values=JSON.parse(raw).map(input=>{const universe=readEmpiricalClaimUniverse(input);return{universe,canonical:canonicalEmpiricalClaimsFromUniverse(universe)}});process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},values}));"#;
    let env = EnvironmentPolicyV1::new(
        "actual-empirical-claim-universe",
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
    for (n, r) in requests.into_iter().enumerate() {
        let c = AtomicBool::new(false);
        let observed = inspect_native_empirical_claim_universe_v1(
            r,
            &c,
            Instant::now() + std::time::Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(
            *observed.observed(),
            actual["values"][n]["universe"],
            "whole original universe case{} {}",
            n,
            modes[n]
        );
        assert_eq!(
            *observed.canonical_claims(),
            actual["values"][n]["canonical"],
            "whole original canonical claims case{} {}",
            n,
            modes[n]
        );
        observed.verify_unchanged().unwrap();
    }
    println!(
        "actual_empirical_claim_universe={}",
        json!({"nodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"actualWholeCases":modes.len(),"canonicalClaimValuesCompared":true,"experimentVerificationGranted":false,"fullResearchAdapterAccepted":false})
    );
}
#[test]
fn actual_empirical_reader_rechecks_content_namespace_cancel_deadline_preallocation_and_shared_limit()
 {
    let temp = Temp::new();
    let c = AtomicBool::new(false);
    let deadline = || Instant::now() + std::time::Duration::from_secs(60);
    fs::write(
        temp.0.join("main.tex"),
        claim(&declaration("claim:a"), "Actual body", "claim:a"),
    )
    .unwrap();
    let observed =
        inspect_native_empirical_claim_universe_v1(request(&temp.0), &c, deadline()).unwrap();
    fs::write(temp.0.join("main.tex"), b"changed").unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    assert!(
        inspect_native_empirical_claim_universe_v1(
            request(&temp.0),
            &AtomicBool::new(true),
            deadline()
        )
        .is_err()
    );
    assert!(
        inspect_native_empirical_claim_universe_v1(request(&temp.0), &c, Instant::now()).is_err()
    );
    fs::write(
        temp.0.join("main.tex"),
        claim(&declaration("claim:a"), &"x".repeat(65537), "claim:a"),
    )
    .unwrap();
    assert!(inspect_native_empirical_claim_universe_v1(request(&temp.0), &c, deadline()).is_err());
    fs::write(
        temp.0.join("main.tex"),
        b"\\input{large0}\n\\input{large1}\n\\input{large2}\n\\input{large3}\n\\input{large4}\n",
    )
    .unwrap();
    for n in 0..5 {
        fs::write(temp.0.join(format!("large{n}.tex")), vec![b'x'; 900 * 1024]).unwrap();
    }
    let mut context = NativeResearchReadContextV1::new(&c, deadline());
    assert_eq!(
        inspect_native_empirical_claim_universe_with_context_v1(request(&temp.0), &mut context)
            .err()
            .unwrap(),
        "native_research_composed_read_budget_v1_refused"
    );
    assert!(context.require_active().is_err());
    fs::write(
        temp.0.join("main.tex"),
        claim(&declaration("claim:a"), "Fresh retry body", "claim:a"),
    )
    .unwrap();
    assert!(
        inspect_native_empirical_claim_universe_with_context_v1(request(&temp.0), &mut context)
            .is_err()
    );
    let retry =
        inspect_native_empirical_claim_universe_v1(request(&temp.0), &c, deadline()).unwrap();
    assert_eq!(
        retry.observed()["status"],
        "empirical_claim_universe_verified"
    );
    retry.verify_unchanged().unwrap();
    let mut unknown = serde_json::to_value(request(&temp.0)).unwrap();
    unknown["sourceCorpusHash"] = json!("sha256:caller");
    assert!(serde_json::from_value::<NativeEmpiricalClaimUniverseRequestV1>(unknown).is_err());
}
