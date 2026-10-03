use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use sha2::Digest;
use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, sync::atomic::AtomicBool};

#[test]
fn native_batch_command_and_complete_local_graph_match_actual_node_whole_values() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let mut cases = Vec::new();
    for mode in [
        "local-build",
        "local-package",
        "local-dry-run",
        "reviewed-submit",
        "research-verify",
        "referee-review",
        "referee-revise",
        "local-review-loop",
        "referee-autopilot",
    ] {
        for profile in [
            None,
            Some("survey_or_position"),
            Some("theorem_or_proof"),
            Some("formal_theorem_or_proof"),
        ] {
            if matches!(mode, "local-review-loop" | "referee-autopilot")
                && profile == Some("formal_theorem_or_proof")
            {
                continue;
            }
            cases.push(json!({"mode":mode,"qualityProfile":profile,"maxRounds":2,"venue":"Venue-A","languages":["python","latex"],"stateEvidence":false}));
        }
    }
    cases.push(json!({"mode":"local-dry-run","qualityProfile":null,"maxRounds":9007199254740991_u64,"venue":"Venue-B","languages":["latex"],"stateEvidence":true}));
    cases.push(json!({"mode":"research-verify","qualityProfile":"theorem_or_proof","maxRounds":3,"venue":"Venue-C","languages":["lean","latex"],"stateEvidence":true}));
    for profile in ["empirical_or_experiment", "unknown_profile"] {
        cases.push(json!({"mode":"local-dry-run","qualityProfile":profile,"maxRounds":1,"venue":"Venue-A","languages":["python","latex"],"stateEvidence":false}));
    }
    let script = format!(
        "{}\n{}",
        include_str!("../release_replay/oracle-input-guard.mjs"),
        r#"
import {createPaperTask} from './paper-domain/contracts/workflow-contracts.mjs';
import {buildTargetScopeReceipt} from './paper-domain/automation/target-scope-policy.mjs';
import {buildBatchCampaignCommand} from './paper-application/automation/batch-campaign-command.mjs';
import {parsePaperProductionArgs,buildPaperBatchCliOptions} from './paper-core/src/paper-production-cli-options.mjs';
const rows=readBoundedReplayInput('referee').cases.map(({name,args})=>{
 if(name!=='native_batch_command'||args.length!==1)throw new Error('batch_contract_case');
 const c=args[0]; const argv=['batch-run','--mode',c.mode,'--max-rounds',String(c.maxRounds),'--target',c.venue,'--languages',c.languages.join(',')];
 if(c.qualityProfile)argv.push('--quality-profile',c.qualityProfile);
 const options=buildPaperBatchCliOptions(parsePaperProductionArgs(argv),{defaultRoot:'/actual/root',defaultRuntimeRoot:'/actual/runtime'});
 const paperTask=createPaperTask({paperId:'ordinary-paper',title:'Actual task',status:'draft',venueTarget:'Origin-Venue',paperType:'research',canonicalDir:'drafts/ordinary-paper',sourceWorkspace:'drafts/ordinary-paper',mainTex:'drafts/ordinary-paper/main.tex',registry:{inventorySource:'hepta_sqlite'},evidenceRefs:[{path:'evidence/local.json',hash:'sha256:'+'a'.repeat(64)}],createdAt:'2026-10-02T00:00:00.000Z'});
 const paperState=c.stateEvidence?{evidenceRefs:[{ref:'evidence/b.json',path:'evidence/b.json',hash:'sha256:'+'b'.repeat(64),sizeBytes:3},{ref:'evidence/a.json',sizeBytes:null}]}:null;
 const targetScopeReceipt=buildTargetScopeReceipt({mode:c.mode,requestedPaperIds:['ordinary-paper'],selectedTasks:[paperTask],inventorySource:'hepta_sqlite',inventoryFallback:null,execute:false});
 const input={version:1,paperTask,paperState,sourceWorkspace:'/actual/root/drafts/ordinary-paper',options,targetScopeReceipt};
 let result; try{result={ok:true,value:buildBatchCampaignCommand({paperTask,paperState,sourceWorkspace:input.sourceWorkspace,mode:options.mode,maxRounds:options.maxRounds,targetScopeReceipt,venueTarget:options.targetOverride,qualityProfile:options.qualityProfile,languages:options.languages})};}catch(e){result={ok:false,error:e.message};}
 return {input,result};
});process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},rows}));
"#
    );
    let environment = EnvironmentPolicyV1::new(
        "native-batch-command-differential-v1",
        ["PATH", "LANG", "LC_ALL"],
        ["PATH"],
    )
    .unwrap()
    .build(
        std::iter::empty::<(OsString, OsString)>(),
        &BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("LANG".into(), "C.UTF-8".into()),
            ("LC_ALL".into(), "C.UTF-8".into()),
        ]),
    )
    .unwrap();
    let result=run_bounded_process_capturing_stdout_with_cancellation(&BoundedProcessRequestV1{executable:std::env::var_os("HEPTA_TEST_NODE").map(PathBuf::from).expect("qualified Node producer input"),arguments:vec!["--input-type=module".into(),"--eval".into(),script.into()],working_directory:root,environment,stdin:Some(serde_json::to_vec(&json!({"version":1,"baseCaseCount":0,"cases":cases.iter().map(|c|json!({"name":"native_batch_command","args":[c]})).collect::<Vec<_>>()})).unwrap())},ProcessLimitsV1{timeout_ms:60_000,termination_grace_ms:100,cleanup_timeout_ms:2_000,maximum_stdin_bytes:64*1024,maximum_stdout_bytes:4*1024*1024,maximum_stderr_bytes:64*1024,maximum_tail_bytes:4096,..ProcessLimitsV1::default()},&AtomicBool::new(false)).unwrap();
    assert_eq!(
        result.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert_eq!(result.process.exit_code, Some(0), "{result:?}");
    assert!(result.process.process_group_cleanup_verified);
    assert_eq!(result.process.stderr_bytes, 0);
    assert_eq!(result.process.stdout_bytes, result.stdout.len() as u64);
    assert_eq!(
        result.process.stdout_hash.as_str(),
        format!(
            "sha256:{}",
            hex::encode(sha2::Sha256::digest(&result.stdout))
        )
    );
    let output: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(
        output["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    let rows = output["rows"].as_array().unwrap();
    assert_eq!(rows.len(), cases.len());
    for (i, row) in rows.iter().enumerate() {
        let input: NativeBatchCampaignCommandInputV1 =
            serde_json::from_value(row["input"].clone()).unwrap();
        let native = match build_native_batch_campaign_command_v1(&input) {
            Ok(v) => json!({"ok":true,"value":v}),
            Err(e) => json!({"ok":false,"error":e}),
        };
        assert_eq!(native, row["result"], "input {i}: {}", cases[i]);
    }
    println!(
        "native_batch_complete_graph_observation={}",
        json!({"actualCases":cases.len(),"actualNodePid":result.process.process_id,"stdoutBytes":result.stdout.len(),"stdoutSha256":result.process.stdout_hash,"wholeOriginalCommandAndPlanMatched":true,"normalInventoryObserved":false,"queueOrWorkerExecuted":false,"routeAccepted":false})
    );
}

#[test]
fn native_batch_graph_missing_scope_or_unbounded_data_refused_before_queue_io() {
    let options = crate::batch_cli::normalize_native_batch_cli_arguments_v1(
        &["--mode=local-dry-run".into()],
        "/cwd",
        "/root",
        "/runtime",
    )
    .unwrap();
    let mut input = NativeBatchCampaignCommandInputV1 {
        version: 1,
        paper_task: json!({"paperId":"p","taskKey":"paper_factory:p","semanticIdentityHash":"sha256:claimed"}),
        paper_state: None,
        source_workspace: "/source".into(),
        options,
        target_scope_receipt: json!({"status":"target_scope_blocked","selectedPaperIds":["p"]}),
    };
    assert_eq!(
        build_native_batch_campaign_command_v1(&input).unwrap_err(),
        "batch_campaign_command_target_scope_not_verified"
    );
    input.target_scope_receipt = json!({"status":"target_scope_verified","selectedPaperIds":["p"]});
    input.paper_task["extra"] = json!("x".repeat(64 * 1024 + 1));
    assert!(build_native_batch_campaign_command_v1(&input).is_err());
    input.paper_task["extra"] = json!(null);
    input.source_workspace = "relative".into();
    assert!(build_native_batch_campaign_command_v1(&input).is_err());
}
