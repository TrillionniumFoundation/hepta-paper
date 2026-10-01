use super::*;
use crate::native_business::{BuildEntryV1, NativeBusinessJobV1, execute_native_business_v1};
use std::{fs, os::unix::fs::PermissionsExt, sync::atomic::AtomicU64};
static NEXT_CAS_SUBMISSION: AtomicU64 = AtomicU64::new(1);
struct CasTemp(std::path::PathBuf);
impl CasTemp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "hepta-cas-local-submission-{}-{}",
            std::process::id(),
            NEXT_CAS_SUBMISSION.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        Self(p)
    }
}
impl Drop for CasTemp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn cas_request(
    objects: &crate::ObjectStoreV1,
    body: &str,
) -> (CasLocalSubmissionPreparationRequestV1, Vec<Vec<u8>>) {
    let bundle = execute_native_business_v1(NativeBusinessJobV1::BuildPackage {
        entries: vec![BuildEntryV1 {
            path: "main.md".into(),
            content: body.into(),
            media_type: "text/markdown".into(),
        }],
    })
    .unwrap()
    .artifacts[1]
        .clone();
    let manuscript = objects.put(body.as_bytes()).unwrap();
    let source = objects.put(&bundle).unwrap();
    let task = json!({"paperId":"actual-cas-paper","taskKey":"actual-cas-paper:submission","title":"Actual CAS manuscript","sourceWorkspace":format!("cas:{source}"),"mainTex":"main.md","venueTarget":"Fixture Venue"});
    (
        CasLocalSubmissionPreparationRequestV1 {
            version: 1,
            kind: "NativeCasLocalSubmissionPreparationRequest".into(),
            preflight: input(
                task,
                Some(json!({"name":"Fixture Venue","venue_id":"fixture-venue","kind":"journal"})),
                false,
            ),
            artifacts: vec![
                CasLocalSubmissionArtifactV1 {
                    role: CasLocalSubmissionArtifactRoleV1::Manuscript,
                    filename: "main.md".into(),
                    digest: manuscript,
                },
                CasLocalSubmissionArtifactV1 {
                    role: CasLocalSubmissionArtifactRoleV1::SourcePackage,
                    filename: "source.hepta".into(),
                    digest: source,
                },
            ],
            cover_letter: "Please consider this locally prepared manuscript.".into(),
            reference_time_millis: 1_759_276_800_000,
        },
        vec![body.as_bytes().to_vec(), bundle],
    )
}
#[test]
fn native_cas_local_ready_records_match_actual_node_from_original_bytes() {
    let temp = CasTemp::new();
    let objects = crate::ObjectStoreV1::open(&temp.0).unwrap();
    let mut cases = Vec::new();
    let mut native = Vec::new();
    for body in [
        "# Actual CAS manuscript\n\nNative preparation.\n",
        "# Variable manuscript\n\nUnicode α and 中文.\n",
        "# Changed manuscript\n\nContent identity must change.\n",
    ] {
        let (request, bytes) = cas_request(&objects, body);
        let output = prepare_local_submission_from_cas_v1(
            &objects,
            request.clone(),
            &AtomicBool::new(false),
        )
        .unwrap();
        let actual: Value = serde_json::from_slice(&output.artifacts[0]).unwrap();
        assert_eq!(
            actual["lifecycle"]["manifest"]["status"],
            "ready_for_adapter"
        );
        assert_eq!(actual["lifecycle"]["receipt"]["status"], "dry_run_recorded");
        assert_eq!(
            actual["lifecycle"]["safety"]["externalActionPerformed"],
            false
        );
        assert_eq!(
            actual["lifecycle"]["deliveryRuntime"]["dispatchAuthorization"]["status"],
            "submission_dispatch_authorization_blocked"
        );
        native.push(actual);
        cases.push(
            json!({"request":request,"bytesHex":bytes.iter().map(hex::encode).collect::<Vec<_>>()}),
        );
    }
    let program = r#"import {createHash} from 'node:crypto';
import {createPaperArtifactPackage} from './paper-domain/contracts/workflow-contracts.mjs';
import {buildSubmissionLifecycle} from './paper-adapters/submission/submission-lifecycle-orchestrator.mjs';
const input=readBoundedReplayInput('referee');const actual=input.cases.map(row=>{if(row.name!=='native_cas_local_submission'||row.args.length!==1)throw new Error('cas_input');const {request,bytesHex}=row.args[0];const task=request.preflight.paperTask;const artifacts=request.artifacts.map((descriptor,index)=>{const bytes=Buffer.from(bytesHex[index],'hex');const hash='sha256:'+createHash('sha256').update(bytes).digest('hex');if(hash!==descriptor.digest)throw new Error('cas_digest');return {id:task.paperId+':artifact:'+(index+1),role:descriptor.role,filename:descriptor.filename,path:'cas:'+hash,mimeType:descriptor.role==='manuscript'?'text/markdown':descriptor.role==='source_package'?'application/vnd.hepta.native-bundle':'application/octet-stream',sizeBytes:bytes.length,hash,source:'native_content_addressed_store'};});const artifactPackage=createPaperArtifactPackage({paperTask:task,mode:'local-package',packageStatus:'package_ready',buildStatus:'native_bundle_content_verified',artifacts,submitReady:true,provenance:{generatedByPaperCore:false,generatedByNativeCasPreparation:true,sourceMutation:false,externalActionPerformed:false},createdAt:new Date(request.referenceTimeMillis).toISOString()});const lifecycle=buildSubmissionLifecycle({row:{task,venue:request.preflight.venue,state:{blockers:[]}},artifactPackage,mode:request.preflight.mode,reviewedSubmit:request.preflight.reviewedSubmit,venueEvidenceNow:new Date(request.referenceTimeMillis)});return {artifactPackage,lifecycle};});process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},actual}));"#;
    let output = run_cas_original_node(program, &cases);
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["actual"].as_array().unwrap().len(), native.len());
    for (index, (actual, expected)) in native
        .iter()
        .zip(value["actual"].as_array().unwrap())
        .enumerate()
    {
        assert_eq!(
            actual["artifactPackage"], expected["artifactPackage"],
            "actual CAS package {index}"
        );
        assert_eq!(
            actual["lifecycle"], expected["lifecycle"],
            "actual CAS whole local lifecycle {index}"
        );
    }
    println!(
        "native_cas_submission_observation={}",
        json!({"version":1,"actualNodePid":output.process.process_id,"actualWholeLocalLifecycleCount":native.len(),"actualArtifactPackageCount":native.len(),"actualStdoutBytes":output.process.stdout_bytes,"actualStdoutSha256":output.process.stdout_hash,"actualNodeWholeValuesMatched":true,"actualCasInputBinding":true,"externalAuthorityGranted":false,"normalSubmissionRouteAccepted":false})
    );
}
fn run_cas_original_node(
    program: &str,
    cases: &[Value],
) -> hepta_codex_runtime::CapturedBoundedProcessResultV1 {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let node = std::env::var_os("HEPTA_TEST_NODE")
        .map(PathBuf::from)
        .expect("qualified Node22.23.1 required");
    let environment = EnvironmentPolicyV1::new(
        "cas-local-submission-original-node-v1",
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
    let output=run_bounded_process_capturing_stdout_with_cancellation(&BoundedProcessRequestV1{executable:node,arguments:vec!["--input-type=module".into(),"--eval".into(),format!("{}\n{}",include_str!("../../release_replay/oracle-input-guard.mjs"),program).into()],working_directory:root,environment,stdin:Some(serde_json::to_vec(&json!({"version":1,"baseCaseCount":0,"cases":cases.iter().map(|v|json!({"name":"native_cas_local_submission","args":[v]})).collect::<Vec<_>>()})).unwrap())},ProcessLimitsV1{timeout_ms:60_000,termination_grace_ms:100,cleanup_timeout_ms:2000,maximum_stdin_bytes:64*1024,maximum_stdout_bytes:1024*1024,maximum_stderr_bytes:64*1024,maximum_tail_bytes:4096,..ProcessLimitsV1::default()},&AtomicBool::new(false)).unwrap();
    assert_eq!(
        output.process.termination_reason,
        ProcessTerminationReason::Exited
    );
    assert_eq!(output.process.exit_code, Some(0), "{output:?}");
    assert!(output.process.process_group_cleanup_verified);
    assert_eq!(output.process.stdout_bytes, output.stdout.len() as u64);
    assert_eq!(
        output.process.stdout_hash.as_str(),
        format!(
            "sha256:{}",
            hex::encode(sha2::Sha256::digest(&output.stdout))
        )
    );
    assert_eq!(output.process.stderr_bytes, 0);
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        value["profile"],
        json!({"node":"v22.23.1","icu":"78.2","cldr":"48.0"})
    );
    output
}
#[test]
fn native_cas_local_preparation_rejects_changed_or_missing_objects_and_live_fields() {
    let temp = CasTemp::new();
    let objects = crate::ObjectStoreV1::open(&temp.0).unwrap();
    let (request, _) = cas_request(&objects, "# Actual content\n");
    let files_before = fs::read_dir(objects.root()).unwrap().count();
    assert!(
        prepare_local_submission_from_cas_v1(&objects, request.clone(), &AtomicBool::new(true))
            .is_err()
    );
    assert_eq!(fs::read_dir(objects.root()).unwrap().count(), files_before);
    for field in [
        "artifactPackage",
        "liveAuthorizationReceipt",
        "submissionDecisionPacket",
        "releaseAuthority",
        "executorResponse",
    ] {
        let mut value = serde_json::to_value(&request).unwrap();
        value[field] = json!({"status":"ready"});
        assert!(serde_json::from_value::<CasLocalSubmissionPreparationRequestV1>(value).is_err());
    }
    let mut reviewed = request.clone();
    reviewed.preflight.reviewed_submit = true;
    reviewed.preflight.mode = "reviewed-submit".into();
    assert!(
        prepare_local_submission_from_cas_v1(&objects, reviewed, &AtomicBool::new(false)).is_err()
    );
    let mut wrong_source = request.clone();
    wrong_source.preflight.paper_task["sourceWorkspace"] = json!("unbound-filesystem-path");
    assert!(
        prepare_local_submission_from_cas_v1(&objects, wrong_source, &AtomicBool::new(false))
            .is_err()
    );
    let mut duplicate = request.clone();
    duplicate.artifacts.push(duplicate.artifacts[0].clone());
    assert!(
        prepare_local_submission_from_cas_v1(&objects, duplicate, &AtomicBool::new(false)).is_err()
    );
    let source = objects.root().join(
        request.artifacts[1]
            .digest
            .as_str()
            .trim_start_matches("sha256:"),
    );
    let original = fs::read(&source).unwrap();
    fs::write(&source, b"corrupt source").unwrap();
    assert!(
        prepare_local_submission_from_cas_v1(&objects, request.clone(), &AtomicBool::new(false))
            .is_err()
    );
    assert_eq!(fs::read(&source).unwrap(), b"corrupt source");
    fs::write(&source, &original).unwrap();
    assert!(
        prepare_local_submission_from_cas_v1(&objects, request.clone(), &AtomicBool::new(false))
            .is_ok()
    );
    fs::remove_file(&source).unwrap();
    assert!(
        prepare_local_submission_from_cas_v1(&objects, request, &AtomicBool::new(false)).is_err()
    );
}
