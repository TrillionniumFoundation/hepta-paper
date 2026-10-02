use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{collections::BTreeMap, path::PathBuf};
fn req(claims: Vec<Value>) -> NativeResearchClaimRegistryRequestV1 {
    NativeResearchClaimRegistryRequestV1 {
        version: 1,
        paper_task: json!({"paperId":"paper:actual"}),
        claims,
    }
}
#[test]
fn actual_claim_graph_and_version_transitions_match_original_node_full_values() {
    let sha = format!("sha256:{}", "a".repeat(64));
    let cases = vec![
        req(vec![]),
        req(vec![json!({"id":"a","text":"Claim one"})]),
        req(vec![
            json!({"id":"b","dependencyIds":["a"],"status":"supported"}),
            json!({"id":"a","text":"Ａ\t\nＢ\u{feff}Ｃ"}),
        ]),
        req(vec![
            json!({"id":"same"}),
            json!({"id":"same"}),
            json!({"id":"same"}),
        ]),
        req(vec![
            json!({"id":"a","dependencyIds":["missing","missing","else"]}),
        ]),
        req(vec![
            json!({"id":"a","dependencyIds":["b"]}),
            json!({"id":"b","dependencyIds":["a"]}),
        ]),
        req(vec![
            json!({"id":"prefix","dependencyIds":["a"]}),
            json!({"id":"a","dependencyIds":["b"]}),
            json!({"id":"b","dependencyIds":["a"]}),
        ]),
        req(vec![json!({"id":"formal","claimKind":"formal_claim"})]),
        req(vec![
            json!({"id":"formal","claimKind":"formal_claim","manuscriptPath":"main.tex","manuscriptByteStart":0,"manuscriptByteEnd":3,"manuscriptContentHash":sha,"manuscriptFileHash":sha}),
        ]),
        req(vec![
            json!({"id":"emp","claimKind":"empirical_claim","manuscriptPath":"main.tex","manuscriptByteStart":0,"manuscriptByteEnd":3,"manuscriptContentHash":sha,"manuscriptFileHash":sha,"empiricalClaimUniverseEntryHash":sha,"empiricalClaimUniverseHash":sha,"manuscriptCorpusHash":sha,"manuscriptClaimHash":sha,"proposalClaimRecordHash":sha}),
        ]),
        req(vec![
            json!({"id":"emp","claimKind":"empirical_claim","manuscriptPath":"main.tex","manuscriptByteStart":false,"manuscriptByteEnd":"3","manuscriptContentHash":sha,"manuscriptFileHash":sha,"empiricalClaimUniverseEntryHash":"invalid","empiricalClaimUniverseHash":sha,"manuscriptCorpusHash":sha,"manuscriptClaimHash":sha}),
        ]),
        req(vec![
            json!({"claimId":1.0,"summary":[null,1,"x"],"source_locator":1.0,"version":"0x2","proof_obligations":["\u{10000}","\u{e000}",1.0],"risk_class":"risk","verification_plan":{"steps":[1.0]},"negative_result_policy":"preserve"}),
        ]),
        req(vec![
            json!({"id":"n","version":"not a number"}),
            json!({"id":"i","version":"Infinity"}),
        ]),
        req(vec![
            json!({"id":"a","version":-5}),
            json!({"id":"b","text":{"x":1},"version":[2]}),
        ]),
        req(vec![json!(false), json!(7), json!("literal")]),
        req(vec![
            json!({"id":"num","kind":true,"manuscriptByteStart":9007199254740993_u64,"manuscriptByteEnd":1.0,"sourceLocator":true,"status":true}),
        ]),
    ];
    let transitions = vec![
        NativeResearchClaimTransitionRequestV1 {
            version: 1,
            paper_task: json!({"paperId":"paper:actual"}),
            claims: vec![json!({"id":"a","text":"actual","version":1})],
            claim_id: json!("a"),
            to_status: json!("supported"),
            expected_version: Some(json!("0x1")),
        },
        NativeResearchClaimTransitionRequestV1 {
            version: 1,
            paper_task: json!({"paperId":"paper:actual"}),
            claims: vec![
                json!({"id":"a","status":"supported","version":2}),
                json!({"id":"b","dependencyIds":["a"]}),
            ],
            claim_id: json!("a"),
            to_status: json!("superseded"),
            expected_version: Some(json!(2)),
        },
        NativeResearchClaimTransitionRequestV1 {
            version: 1,
            paper_task: json!({"paperId":"paper:actual"}),
            claims: vec![json!({"id":"a"})],
            claim_id: json!("a"),
            to_status: json!("rejected"),
            expected_version: None,
        },
    ];
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let script = r#"import {buildClaimRegistry,transitionClaim} from './paper-domain/research/claim-registry.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>1048576)throw Error('input');}const q=JSON.parse(raw);process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},records:q.cases.map(q=>buildClaimRegistry({paperTask:q.paperTask,claims:q.claims})),transitions:q.transitions.map(q=>transitionClaim(buildClaimRegistry({paperTask:q.paperTask,claims:q.claims}),{claimId:q.claimId,toStatus:q.toStatus,expectedVersion:q.expectedVersion??null}))}));"#;
    let env = EnvironmentPolicyV1::new("claim-differential", ["PATH", "LANG", "LC_ALL"], ["PATH"])
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
            working_directory: root,
            environment: env,
            stdin: Some(
                serde_json::to_vec(&json!({"cases":cases,"transitions":transitions})).unwrap(),
            ),
        },
        ProcessLimitsV1 {
            timeout_ms: 60_000,
            termination_grace_ms: 100,
            cleanup_timeout_ms: 2000,
            maximum_stdin_bytes: 1048576,
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
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    for (i, r) in cases.into_iter().enumerate() {
        assert_eq!(
            build_native_research_claim_registry_v1(r, &AtomicBool::new(false)).unwrap(),
            actual["records"][i],
            "actual whole registry case {i}"
        );
    }
    for (i, r) in transitions.into_iter().enumerate() {
        assert_eq!(
            transition_native_research_claim_v1(r, &AtomicBool::new(false)).unwrap(),
            actual["transitions"][i],
            "actual whole transition case {i}"
        );
    }
    println!(
        "actual_research_claim_observation={}",
        json!({"nodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"registryCases":actual["records"].as_array().unwrap().len(),"transitionCases":actual["transitions"].as_array().unwrap().len(),"scientificAcceptanceGranted":false,"fullResearchAdapterAccepted":false})
    );
}
#[test]
fn actual_claim_graph_refuses_cancel_data_budget_custom_coercion_and_stale_transition() {
    assert!(
        build_native_research_claim_registry_v1(
            req(vec![json!({"id":"a"})]),
            &AtomicBool::new(true)
        )
        .is_err()
    );
    assert!(
        build_native_research_claim_registry_v1(
            req(vec![json!({"id":"a","text":{"toString":"uncallable"}})]),
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert!(
        build_native_research_claim_registry_v1(
            req(vec![json!({"id":"x".repeat(257)})]),
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert!(
        build_native_research_claim_registry_v1(
            req((0..257).map(|n| json!({"id":format!("c{n}")})).collect()),
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let transition = |status: &str, version: i32| NativeResearchClaimTransitionRequestV1 {
        version: 1,
        paper_task: json!({"paperId":"paper"}),
        claims: vec![json!({"id":"a","version":2,"status":"supported"})],
        claim_id: json!("a"),
        to_status: json!(status),
        expected_version: Some(json!(version)),
    };
    assert_eq!(
        transition_native_research_claim_v1(transition("superseded", 1), &AtomicBool::new(false))
            .unwrap_err(),
        "Claim version conflict"
    );
    assert_eq!(
        transition_native_research_claim_v1(transition("rejected", 2), &AtomicBool::new(false))
            .unwrap_err(),
        "Invalid claim transition: supported->rejected"
    );
    // Each historical split passes on its own. One actual transition request
    // exceeds the shared byte domain and must refuse before graph construction.
    let padding = || Value::Array((0..9).map(|_| json!("x".repeat(64 * 1024))).collect());
    let mut combined = transition("superseded", 2);
    combined.paper_task["padding"] = padding();
    combined.claim_id = padding();
    local_submission_values_budget_v1(
        std::iter::once(&combined.paper_task).chain(combined.claims.iter()),
    )
    .unwrap();
    local_submission_values_budget_v1(
        std::iter::once(&combined.claim_id)
            .chain(std::iter::once(&combined.to_status))
            .chain(combined.expected_version.iter()),
    )
    .unwrap();
    assert_eq!(
        transition_native_research_claim_v1(combined, &AtomicBool::new(false)).unwrap_err(),
        "native_local_submission_preflight_contract_refused"
    );
    let mut value = serde_json::to_value(req(vec![])).unwrap();
    value["claimRegistryHash"] = json!("caller");
    assert!(serde_json::from_value::<NativeResearchClaimRegistryRequestV1>(value).is_err());
}
