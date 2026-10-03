use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use serde_json::Value;
use sha2::Digest;
use std::{
    collections::BTreeMap, ffi::OsString, fs, os::unix::fs::PermissionsExt, path::PathBuf,
    sync::atomic::AtomicU64,
};
static NEXT: AtomicU64 = AtomicU64::new(1);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-research-data-{}-{}",
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
fn request(
    objects: &ObjectStoreV1,
    worker_type: NativeResearchDataWorkerTypeV1,
    parameters: &str,
    bytes: &[&[u8]],
) -> NativeResearchDataWorkerRequestV1 {
    NativeResearchDataWorkerRequestV1 {
        version: 1,
        worker_type,
        parameters_json: parameters.into(),
        inputs: bytes
            .iter()
            .enumerate()
            .map(|(index, bytes)| {
                let hash = objects.put(bytes).unwrap();
                NativeResearchDataInputV1 {
                    role: format!("input{index}"),
                    path: format!("data/input-{index}.bin"),
                    expected_hash: hash.clone(),
                    hash,
                }
            })
            .collect(),
    }
}
#[test]
fn actual_cas_research_workers_match_original_node_full_wire() {
    let temp = Temp::new();
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let mut corpus = Vec::new();
    for text in [
        "x,y\n1,2\n3,4\n",
        "x,y\r\n0x10000000000000001,0b11\r\n0o7, 1e-7 \r\n",
        "x,y\n-0,2\n0,-3\n",
        "x,x\n1,7\n2,8\n",
        "x,y\n1,\n2,3\n",
        "x,y\n1\n2,3\n",
        "x\nInfinity\nNaN\n",
        "x\n1e308\n1e308\n",
        "\u{feff}x\u{a0},y\n1, 2\n\n3,4\n",
        "\"x\",\"y\"\n\"1\",\"2\"\n\"3\",\"4\"\n",
        "\"x,alias\",y\n1,2\n3,4\n",
        "x\n\"1\"\"2\"\n",
        "x\n",
        "",
        "x\n1\n",
    ] {
        for parameters in ["{}", r#"{"numericColumns":["x","missing","x"]}"#] {
            corpus.push((
                request(
                    &objects,
                    NativeResearchDataWorkerTypeV1::CsvDescriptiveStatistics,
                    parameters,
                    &[text.as_bytes()],
                ),
                vec![text.as_bytes().to_vec()],
            ));
        }
    }
    for (document, parameters) in [
        (
            r#"{"a":null,"z":0,"yes":true,"no":false,"arr":[1,2],"obj":{"z":1,"a":2}}"#,
            r#"{"assertions":[{"path":"$.a","op":"exists"},{"path":"missing","op":"exists"},{"path":"missing","op":"equals"},{"path":"a","op":"equals","value":null},{"path":"z","op":"truthy"},{"path":"yes","op":"truthy"},{"path":"no","op":"truthy"},{"path":"arr.length","op":"equals","value":2},{"path":"arr.1","op":"gte","value":"0x2"},{"path":"arr.01","op":"exists"},{"path":"obj","op":"equals","value":{"z":1,"a":2}},{"path":"obj","op":"equals","value":{"a":2,"z":1}}]}"#,
        ),
        (
            r#"{"n":"0x10000000000000001","empty":[],"one":[3],"many":[1,2],"nil":null}"#,
            r#"{"assertions":[{"path":"n","op":"gte","value":"0x10000000000000000"},{"path":"empty","op":"lte","value":0},{"path":"one","op":"gte","value":3},{"path":"many","op":"gte","value":0},{"path":"nil","op":"lte","value":false},{"path":"none","op":"lte","value":0}]}"#,
        ),
        (
            r#"{"v":1e400,"neg":-0,"duplicate":{"z":1,"a":2,"z":3},"surrogate":"\ud800","\ud800":5}"#,
            r#"{"assertions":[{"path":"v","op":"equals","value":null},{"path":"v","op":"gte","value":0},{"path":"neg","op":"equals","value":0},{"path":"duplicate","op":"equals","value":{"z":3,"a":2}},{"path":"surrogate","op":"equals","value":"\ud800"},{"path":"\ud800","op":"equals","value":5}]}"#,
        ),
        (
            "[1,2]",
            r#"{"assertions":[{"path":"$","op":"equals","value":[1,2]},{"path":"$.0","op":"equals","value":1},{"path":"length","op":"equals","value":2}]}"#,
        ),
        (
            "null",
            r#"{"assertions":[{"path":"","op":"exists"},{"path":"x.y","op":"equals"},{"path":0,"op":"equals","value":null},{"path":[],"op":"equals","value":null},{"path":"x","op":"unknown"}]}"#,
        ),
        (
            "{}",
            r#"{"assertions":[{},true,"value",{"path":{},"op":"exists"}]}"#,
        ),
        ("{}", "{}"),
    ] {
        corpus.push((
            request(
                &objects,
                NativeResearchDataWorkerTypeV1::JsonAssertions,
                parameters,
                &[document.as_bytes()],
            ),
            vec![document.as_bytes().to_vec()],
        ));
    }
    corpus.push((
        request(
            &objects,
            NativeResearchDataWorkerTypeV1::CsvDescriptiveStatistics,
            "{}",
            &[],
        ),
        vec![],
    ));
    corpus.push((
        request(
            &objects,
            NativeResearchDataWorkerTypeV1::JsonAssertions,
            "{}",
            &[],
        ),
        vec![],
    ));
    corpus.push((
        request(
            &objects,
            NativeResearchDataWorkerTypeV1::ArtifactIntegrity,
            "{}",
            &[],
        ),
        vec![],
    ));
    let mut integrity = request(
        &objects,
        NativeResearchDataWorkerTypeV1::ArtifactIntegrity,
        "{}",
        &[b"actual", b"other"],
    );
    integrity.inputs[1].expected_hash = integrity.inputs[0].hash.clone();
    corpus.push((integrity, vec![b"actual".to_vec(), b"other".to_vec()]));
    let cases=corpus.iter().map(|(request,bytes)|json!({"request":{"version":request.version,"workerType":request.worker_type,"inputs":request.inputs},"parametersRaw":request.parameters_json.as_str(),"bytesHex":bytes.iter().map(hex::encode).collect::<Vec<_>>()})).collect::<Vec<_>>();
    let node = run_original_node(&cases, &temp.0);
    let result: Value = serde_json::from_slice(&node.stdout).unwrap();
    assert_eq!(
        result["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    let rows = result["rows"].as_array().unwrap();
    assert_eq!(rows.len(), corpus.len());
    for (index, ((request, _), row)) in corpus.iter().zip(rows).enumerate() {
        let wire = serde_json::to_value(request).unwrap();
        let template_roundtrip: NativeResearchDataWorkerRequestV1 =
            serde_json::from_value(wire).unwrap();
        let output = execute_native_research_data_worker_v1(
            &objects,
            template_roundtrip,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(output.artifacts.len(), 1);
        assert_eq!(
            String::from_utf8(output.artifacts[0].clone()).unwrap(),
            row.as_str().unwrap(),
            "case {index}: {}",
            cases[index]
        );
        assert_eq!(output.evidence["externalEffectAuthorized"], false);
    }
    println!(
        "native_research_data_observation={}",
        json!({"actualCases":corpus.len(),"actualNodePid":node.process.process_id,"stdoutBytes":node.process.stdout_bytes,"stdoutSha256":node.process.stdout_hash,"actualCasObserved":true,"wholeOriginalWorkerWireMatched":true,"completeResearchVerifyAdapter":false,"normalBatchRouteAccepted":false,"scientificAcceptance":false})
    );
}
fn run_original_node(
    cases: &[Value],
    scratch: &std::path::Path,
) -> hepta_codex_runtime::CapturedBoundedProcessResultV1 {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let script = format!(
        "{}\n{}",
        include_str!("../../release_replay/oracle-input-guard.mjs"),
        r#"
import fs from 'node:fs/promises';import path from 'node:path';import {executeNativeResearchWorker} from './paper-adapters/research-verify/native-research-worker-execution.mjs';import {createHash} from 'node:crypto';
const input=readBoundedReplayInput('referee');const rows=[];const scratch=process.argv[1];
for (let index=0;index<input.cases.length;index++){const row=input.cases[index];if(row.name!=='native_research_data'||row.args.length!==1)throw new Error('case_shape');const c=row.args[0];const records=[];for(let n=0;n<c.bytesHex.length;n++){const bytes=Buffer.from(c.bytesHex[n],'hex');const absolutePath=path.join(scratch,'actual-'+index+'-'+n);await fs.writeFile(absolutePath,bytes,{flag:'wx',mode:0o600});const hash='sha256:'+createHash('sha256').update(bytes).digest('hex');if(hash!==c.request.inputs[n].hash)throw new Error('actual_hash');records.push({...c.request.inputs[n],absolutePath});}const output=await executeNativeResearchWorker({type:c.request.workerType,parameters:JSON.parse(c.parametersRaw)},records,{sourceRoot:scratch});rows.push(JSON.stringify(output));}
process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},rows}));
"#
    );
    let environment = EnvironmentPolicyV1::new(
        "native-research-data-differential-v1",
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
    let output=run_bounded_process_capturing_stdout_with_cancellation(&BoundedProcessRequestV1{executable:std::env::var_os("HEPTA_TEST_NODE").map(PathBuf::from).expect("qualified Node producer required"),arguments:vec!["--input-type=module".into(),"--eval".into(),script.into(),scratch.as_os_str().to_owned()],working_directory:root,environment,stdin:Some(serde_json::to_vec(&json!({"version":1,"baseCaseCount":0,"cases":cases.iter().map(|c|json!({"name":"native_research_data","args":[c]})).collect::<Vec<_>>()})).unwrap())},ProcessLimitsV1{timeout_ms:60_000,termination_grace_ms:100,cleanup_timeout_ms:2000,maximum_stdin_bytes:64*1024,maximum_stdout_bytes:4*1024*1024,maximum_stderr_bytes:64*1024,maximum_tail_bytes:4096,..ProcessLimitsV1::default()},&AtomicBool::new(false)).unwrap();
    assert_eq!(
        output.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert_eq!(output.process.exit_code, Some(0), "{output:?}");
    assert!(output.process.process_group_cleanup_verified);
    assert_eq!(output.process.stderr_bytes, 0);
    assert_eq!(output.process.stdout_bytes, output.stdout.len() as u64);
    assert_eq!(
        output.process.stdout_hash.as_str(),
        format!(
            "sha256:{}",
            hex::encode(sha2::Sha256::digest(&output.stdout))
        )
    );
    output
}
#[test]
fn actual_cas_worker_refuses_cancel_corruption_limits_and_unsafe_paths() {
    let temp = Temp::new();
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let request = request(
        &objects,
        NativeResearchDataWorkerTypeV1::JsonAssertions,
        r#"{"assertions":[{"path":"a","op":"equals","value":1}]}"#,
        &[br#"{"a":1}"#],
    );
    assert!(
        execute_native_research_data_worker_v1(&objects, request.clone(), &AtomicBool::new(true))
            .is_err()
    );
    let mut changed = request.clone();
    changed.version = 2;
    assert!(
        execute_native_research_data_worker_v1(&objects, changed, &AtomicBool::new(false)).is_err()
    );
    let mut changed = request.clone();
    changed.inputs[0].path = "../outside".into();
    assert!(
        execute_native_research_data_worker_v1(&objects, changed, &AtomicBool::new(false)).is_err()
    );
    let mut changed = request.clone();
    changed.parameters_json = format!("\"{}\"", "a".repeat(MAX_PARAMETERS_BYTES));
    assert!(
        execute_native_research_data_worker_v1(&objects, changed, &AtomicBool::new(false)).is_err()
    );
    let oversized = objects
        .put(&vec![b' '; MAX_INPUT_BYTES as usize + 1])
        .unwrap();
    let mut changed = request.clone();
    changed.inputs[0].hash = oversized;
    assert!(
        execute_native_research_data_worker_v1(&objects, changed, &AtomicBool::new(false)).is_err()
    );
    let first =
        execute_native_research_data_worker_v1(&objects, request.clone(), &AtomicBool::new(false))
            .unwrap();
    let second =
        execute_native_research_data_worker_v1(&objects, request.clone(), &AtomicBool::new(false))
            .unwrap();
    assert_eq!(first, second);
    let object = objects.root().join(
        request.inputs[0]
            .hash
            .to_string()
            .trim_start_matches("sha256:"),
    );
    fs::write(object, b"corrupt").unwrap();
    assert!(
        execute_native_research_data_worker_v1(&objects, request, &AtomicBool::new(false)).is_err()
    );
}
#[test]
fn json_worker_v1_refuses_inherited_or_coercion_method_domain_without_artifacts() {
    let temp = Temp::new();
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    for (document, parameters) in [
        (
            "{}",
            r#"{"assertions":[{"path":"toString","op":"exists"}]}"#,
        ),
        (
            r#"{"a":{"toString":null}}"#,
            r#"{"assertions":[{"path":"a","op":"gte","value":0}]}"#,
        ),
    ] {
        let request = request(
            &objects,
            NativeResearchDataWorkerTypeV1::JsonAssertions,
            parameters,
            &[document.as_bytes()],
        );
        assert!(
            execute_native_research_data_worker_v1(&objects, request, &AtomicBool::new(false))
                .is_err()
        );
    }
}

#[test]
fn actual_research_worker_running_cancellation_and_csv_cell_budget_refuse_without_report() {
    let temp = Temp::new();
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let csv = format!("a,b\n{}", "1,2\n".repeat(40_000));
    let parameters = serde_json::to_string(&json!({"numericColumns":vec!["a";256]})).unwrap();
    let request = request(
        &objects,
        NativeResearchDataWorkerTypeV1::CsvDescriptiveStatistics,
        &parameters,
        &[csv.as_bytes()],
    );
    let cancelled = std::sync::Arc::new(AtomicBool::new(false));
    let signal = cancelled.clone();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(5));
        signal.store(true, Ordering::SeqCst);
    });
    assert!(execute_native_research_data_worker_v1(&objects, request, &cancelled).is_err());
    thread.join().unwrap();
    assert!(cancelled.load(Ordering::SeqCst));
    let oversized_cells = format!("a,b\n{}", "1,2\n".repeat(50_000));
    let request = super::tests::request(
        &objects,
        NativeResearchDataWorkerTypeV1::CsvDescriptiveStatistics,
        "{}",
        &[oversized_cells.as_bytes()],
    );
    assert!(
        execute_native_research_data_worker_v1(&objects, request, &AtomicBool::new(false)).is_err()
    );
}

#[test]
fn actual_json_repeated_root_output_budget_refuses_before_subtree_clones() {
    let temp = Temp::new();
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let document = format!(
        "{{\"payload\":\"{}\"}}",
        "a".repeat(MAX_INPUT_BYTES as usize - 14)
    );
    assert_eq!(document.len(), MAX_INPUT_BYTES as usize);
    let parameters =
        serde_json::to_string(&json!({"assertions":vec![json!({"path":"$","op":"exists"});256]}))
            .unwrap();
    let request = request(
        &objects,
        NativeResearchDataWorkerTypeV1::JsonAssertions,
        &parameters,
        &[document.as_bytes()],
    );
    let before = fs::read_dir(objects.root()).unwrap().count();
    let started = std::time::Instant::now();
    assert_eq!(
        execute_native_research_data_worker_v1(&objects, request.clone(), &AtomicBool::new(false))
            .unwrap_err(),
        NativeBusinessError::OutputLimit
    );
    assert_eq!(fs::read_dir(objects.root()).unwrap().count(), before);
    println!(
        "json_repeated_root_budget_observation={}",
        json!({"actualInputBytes":document.len(),"actualParameterBytes":parameters.len(),"assertions":256,"elapsedMs":started.elapsed().as_millis(),"rawProcStatus":fs::read_to_string("/proc/self/status").unwrap().lines().filter(|s|s.starts_with("VmRSS:")||s.starts_with("VmHWM:")).collect::<Vec<_>>(),"reportEmitted":false})
    );
    let cancelled = std::sync::Arc::new(AtomicBool::new(false));
    let signal = cancelled.clone();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(5));
        signal.store(true, Ordering::SeqCst);
    });
    assert_eq!(
        execute_native_research_data_worker_v1(&objects, request, &cancelled).unwrap_err(),
        NativeBusinessError::Contract
    );
    thread.join().unwrap();
    assert_eq!(fs::read_dir(objects.root()).unwrap().count(), before);
}
#[test]
fn actual_json_repeated_value_nodes_and_aggregate_input_budget_refuse() {
    let temp = Temp::new();
    let objects = ObjectStoreV1::open(&temp.0).unwrap();
    let document = serde_json::to_vec(&vec![serde_json::Value::Null; 79_999]).unwrap();
    let parameters = r#"{"assertions":[{"path":"$","op":"exists"},{"path":"$","op":"exists"}]}"#;
    let request = request(
        &objects,
        NativeResearchDataWorkerTypeV1::JsonAssertions,
        parameters,
        &[&document],
    );
    assert_eq!(
        execute_native_research_data_worker_v1(&objects, request, &AtomicBool::new(false))
            .unwrap_err(),
        NativeBusinessError::OutputLimit
    );
    let maximum = vec![b'a'; MAX_INPUT_BYTES as usize];
    let exact = super::tests::request(
        &objects,
        NativeResearchDataWorkerTypeV1::ArtifactIntegrity,
        "{}",
        &[&maximum, b""],
    );
    assert!(
        execute_native_research_data_worker_v1(&objects, exact, &AtomicBool::new(false)).is_ok()
    );
    let excessive = super::tests::request(
        &objects,
        NativeResearchDataWorkerTypeV1::ArtifactIntegrity,
        "{}",
        &[&maximum, b"ab"],
    );
    assert!(
        execute_native_research_data_worker_v1(&objects, excessive, &AtomicBool::new(false))
            .is_err()
    );
}
