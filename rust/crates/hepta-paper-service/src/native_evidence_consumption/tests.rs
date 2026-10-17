use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};
fn ready() -> Value {
    json!({"reference":{"kind":"experiment","status":"verified","hash":"observed-hash","inputHash":"input","sourceRevision":"revision","lineageId":"lineage","environment":"isolated","releaseCommit":"commit","createdAt":"2026-10-02T00:00:00.000Z","claimIds":["claim:1"],"sourceLocator":"main.tex"},"nowMs":1790899200000_i64,"expected":{"kind":"experiment","acceptedStatuses":["verified"],"hash":"observed-hash","inputHash":"input","sourceRevision":"revision","lineageId":"lineage","environment":"isolated","releaseCommit":"commit"},"requiredOutputs":["events"],"availableOutputs":["events"],"claimId":"claim:1","sourceLocator":"main.tex","resultClass":"verified"})
}
fn evaluate(v: &Value) -> Result<Value, String> {
    evaluate_native_evidence_consumption_v1(
        v,
        &AtomicBool::new(false),
        Instant::now() + Duration::from_secs(30),
    )
}
fn derived_cycle() -> Value {
    let mut input = ready();
    let ids = (0..5)
        .map(|i| format!("{}{i}", "x".repeat(12000)))
        .collect::<Vec<_>>();
    input["dependencyNodes"] = json!(
        (0..5)
            .map(|i| json!({"id":ids[i],"outputHash":"present","dependsOn":[ids[(i+1)%5]]}))
            .collect::<Vec<_>>()
    );
    input
}
#[test]
fn actual_reference_dependency_consumption_whole_values_match_original_node() {
    let mut cases = vec![
        ready(),
        json!({}),
        json!({"reference":null}),
        json!({"reference":[]}),
    ];
    for key in [
        "kind",
        "hash",
        "inputHash",
        "sourceRevision",
        "lineageId",
        "environment",
        "releaseCommit",
        "acceptedStatuses",
    ] {
        let mut v = ready();
        v["expected"][key] = if key == "acceptedStatuses" {
            json!(["wrong"])
        } else {
            json!("wrong")
        };
        cases.push(v);
    }
    for hashkey in ["receiptHash", "receipt_sha256", "provenanceReceiptHash"] {
        let mut v = ready();
        v["reference"].as_object_mut().unwrap().remove("hash");
        v["reference"][hashkey] = json!("observed-hash");
        cases.push(v);
    }
    for (a, b) in [
        ("createdAt", "created_at"),
        ("claimIds", "claim_ids"),
        ("sourceLocator", "source_locator"),
        ("sourceLocator", "path"),
        ("inputHash", "input_hash"),
        ("sourceRevision", "source_revision"),
        ("lineageId", "lineage_id"),
        ("releaseCommit", "release_commit"),
    ] {
        let mut v = ready();
        let value = v["reference"].as_object_mut().unwrap().remove(a).unwrap();
        v["reference"][b] = value;
        cases.push(v);
    }
    for time in [
        Value::Null,
        json!(""),
        json!("invalid"),
        json!(false),
        json!(true),
        json!("1790899200000"),
        json!([1790899200000_i64]),
        json!({}),
        json!(1790898899999_i64),
        json!(1790898900000_i64),
        json!(1790899200001_i64),
    ] {
        let mut v = ready();
        v["nowMs"] = time;
        cases.push(v);
    }
    for age in [
        Value::Null,
        json!(0),
        json!(-1),
        json!("invalid"),
        json!("0x10"),
        json!([]),
        json!([1]),
        json!({}),
        json!(true),
    ] {
        let mut v = ready();
        v["nowMs"] = json!(1790899200001_i64);
        v["maximumAgeMs"] = age;
        cases.push(v);
    }
    for value in [
        json!(["events", "events", "missing"]),
        json!(["😀", "\u{e000}", 0, false, null, {}, ["a", null, "b"]]),
        json!("events"),
        Value::Null,
    ] {
        let mut v = ready();
        v["requiredOutputs"] = value.clone();
        v["availableOutputs"] = value;
        cases.push(v);
    }
    for key in [
        "claimId",
        "sourceLocator",
        "resultClass",
        "requireCreatedAt",
    ] {
        for value in [
            Value::Null,
            json!(false),
            json!("wrong"),
            json!(["claim:1"]),
            json!({}),
            json!(9007199254740993_u64),
        ] {
            let mut v = ready();
            v[key] = value;
            cases.push(v);
        }
    }
    for value in [Value::Null, json!(""), json!(false), json!(0)] {
        let mut v = ready();
        v["reference"]["createdAt"] = value;
        cases.push(v);
    }
    for status in [json!({}), json!([]), json!(false), json!(1)] {
        let mut v = ready();
        v["reference"]["status"] = status.clone();
        v["expected"]["acceptedStatuses"] = json!([status]);
        cases.push(v);
    }
    let fresh = json!([{"id":"a","outputHash":"A"},{"id":"b","outputHash":"B","dependsOn":["a"],"dependencyOutputHashes":{"a":"A"}}]);
    let graphs = vec![
        fresh.clone(),
        json!([{"id":"a"}]),
        json!([{"id":"b","dependsOn":["a","a"]}]),
        json!([{"id":"a","outputHash":"A","dependsOn":["a"],"dependencyOutputHashes":{"a":"A"}}]),
        json!([{"id":"a","dependsOn":["b"],"outputHash":"A","dependencyOutputHashes":{"b":"B"}},{"id":"b","dependsOn":["a"],"outputHash":"B","dependencyOutputHashes":{"a":"A"}}]),
        json!([{"id":"a","outputHash":"old"},{"id":"b","dependsOn":["a"],"outputHash":"B","dependencyOutputHashes":{"a":"new"}},{"id":"a","outputHash":"new"}]),
        json!([{"id":null,"outputHash":"N"},{"id":"b","dependsOn":[null],"outputHash":"B","dependencyOutputHashes":{"null":"N"}}]),
        json!([{"outputHash":"U"},{"id":"b","dependsOn":["undefined"],"outputHash":"B","dependencyOutputHashes":{"undefined":"U"}}]),
        json!([{"id":"a","outputHash":{}},{"id":"b","dependsOn":["a"],"outputHash":"B","dependencyOutputHashes":{"a":{}}}]),
    ];
    for nodes in graphs {
        let mut v = ready();
        v["dependencyNodes"] = nodes;
        cases.push(v);
    }
    let mut stale = fresh;
    stale[1]["dependencyOutputHashes"]["a"] = json!("wrong");
    let mut v = ready();
    v["dependencyNodes"] = stale;
    cases.push(v);
    let mut v = ready();
    v["requiredOutputs"] = json!(["missing", "missing"]);
    v["forbiddenSideEffects"] = json!(["send", "send", "write"]);
    v["observedSideEffects"] = json!(["send", "write", "send"]);
    cases.push(v);
    let script = r#"import{evaluateEvidenceConsumption}from'./paper-domain/evidence/evidence-consumption-policy.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>262144)throw Error('input');}const cases=JSON.parse(raw);const ids=Array.from({length:5},(_,i)=>'x'.repeat(12000)+i);const derivedCycle={...cases[0],dependencyNodes:ids.map((id,i)=>({id,outputHash:'present',dependsOn:[ids[(i+1)%5]]}))};process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},values:cases.map(evaluateEvidenceConsumption),unsupportedCanonicalDateDomain:evaluateEvidenceConsumption({...cases[0],reference:{...cases[0].reference,createdAt:'2026-10-02'}}),unsupportedIterableDomain:evaluateEvidenceConsumption({...cases[0],dependencyNodes:[{id:'a',outputHash:'A',dependsOn:'a',dependencyOutputHashes:{a:'A'}}]}),derivedCycle:evaluateEvidenceConsumption(derivedCycle)}));"#;
    let environment = EnvironmentPolicyV1::new(
        "actual-evidence-consumption",
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
            executable: PathBuf::from(std::env::var_os("HEPTA_TEST_NODE").expect("qualified Node")),
            arguments: vec!["--input-type=module".into(), "--eval".into(), script.into()],
            working_directory: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()
                .unwrap(),
            environment,
            stdin: Some(serde_json::to_vec(&cases).unwrap()),
        },
        ProcessLimitsV1 {
            timeout_ms: 60000,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2000,
            maximum_stdin_bytes: 262144,
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
    assert_eq!(
        actual["unsupportedCanonicalDateDomain"]["status"],
        "evidence_consumption_ready"
    );
    assert_eq!(
        actual["unsupportedIterableDomain"]["status"],
        "evidence_consumption_blocked"
    );
    assert_eq!(
        actual["derivedCycle"]["status"],
        "evidence_consumption_blocked"
    );
    assert!(
        actual["derivedCycle"]["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str().unwrap().len() > 65536)
    );
    let cycle = derived_cycle();
    projected([&cycle, &cycle], 0, 0).unwrap();
    assert!(evaluate(&cycle).unwrap_err().contains("data_domain"));
    // These actual original outputs remain outside this versioned port domain.
    for (i, input) in cases.iter().enumerate() {
        assert_eq!(
            evaluate(input).unwrap(),
            actual["values"][i],
            "whole case {i}: {input}"
        );
    }
    assert_eq!(
        evaluate(&ready()).unwrap()["status"],
        "evidence_consumption_ready"
    );
    println!(
        "actual_evidence_consumption={}",
        json!({"actualWholeCases":cases.len(),"nodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"authorityGranted":false})
    );
}
#[test]
fn observed_policy_refuses_cancel_expiry_overflow_unsupported_date_and_preserves_fresh_retry() {
    let input = ready();
    let c = AtomicBool::new(true);
    assert_eq!(
        evaluate_native_evidence_consumption_v1(
            &input,
            &c,
            Instant::now() + Duration::from_secs(30)
        )
        .unwrap_err(),
        "native_evidence_consumption_cancelled"
    );
    c.store(false, Ordering::SeqCst);
    assert_eq!(
        evaluate_native_evidence_consumption_v1(&input, &c, Instant::now()).unwrap_err(),
        "native_evidence_consumption_deadline_exceeded"
    );
    let mut unsupported = input.clone();
    unsupported["reference"]["createdAt"] = json!("2026-10-02");
    assert!(evaluate(&unsupported).unwrap_err().contains("data_domain"));
    unsupported = input.clone();
    unsupported["dependencyNodes"] = json!([{"id":"a","dependsOn":"a"}]);
    assert!(evaluate(&unsupported).unwrap_err().contains("data_domain"));
    unsupported = input.clone();
    unsupported["requiredOutputs"] = json!([{"toString":"not callable"}]);
    assert!(evaluate(&unsupported).unwrap_err().contains("data_domain"));
    let mut overflow = input.clone();
    overflow["requiredOutputs"] = json!(vec!["a".repeat(65536); 20]);
    assert!(evaluate(&overflow).is_err());
    overflow = input.clone();
    overflow["dependencyNodes"] = json!(
        (0..129)
            .map(|i| json!({"id":i,"outputHash":"present"}))
            .collect::<Vec<_>>()
    );
    assert!(evaluate(&overflow).unwrap_err().contains("data_domain"));
    let mut derived = input.clone();
    derived["requiredOutputs"] = json!(vec!["x".repeat(16000); 32]);
    projected([&derived, &derived], 0, 0).unwrap();
    assert!(evaluate(&derived).unwrap_err().contains("data_domain"));
    let cycle = derived_cycle();
    projected([&cycle, &cycle], 0, 0).unwrap();
    assert!(evaluate(&cycle).unwrap_err().contains("data_domain"));
    assert_eq!(
        evaluate(&input).unwrap()["status"],
        "evidence_consumption_ready"
    );
}
