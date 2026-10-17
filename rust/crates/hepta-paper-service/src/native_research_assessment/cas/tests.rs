use super::*;
use crate::{
    native_business::{
        NativeBusinessJobV1, execute_native_business_with_objects_for_capability_v1,
    },
    native_inventory::{NativeInventoryRequestV1, discover_native_inventory_v1},
    native_research_source_plan::{
        NativeResearchSourcePlanRequestV1, open_native_research_source_data_runtime_v1,
    },
};
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, atomic::AtomicU64},
    time::Duration,
};
static NEXT: AtomicU64 = AtomicU64::new(1);
pub(super) struct Temp(pub(super) PathBuf);
impl Temp {
    pub(super) fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "hepta-cas-assessment-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub(super) struct RuntimeCleanup(pub(super) PathBuf);
impl Drop for RuntimeCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub(super) fn setup(root: &Path) -> NativeInventoryRequestV1 {
    fs::create_dir(root.join("registry")).unwrap();
    fs::create_dir(root.join("source")).unwrap();
    let id = root.file_name().unwrap().to_str().unwrap();
    fs::write(root.join("registry/papers.yaml"),format!("papers:\n  - slug: {id}\n    title: Actual CAS source assessment\n    status: draft\n    canonical_dir: source\n")).unwrap();
    fs::write(root.join("source/main.tex"), "Actual source paper\n").unwrap();
    let raw = b"actual independently verified CAS artifact\n";
    fs::write(root.join("source/raw.dat"), raw).unwrap();
    let record = json!({"claims":[{"id":"claim:actual","text":"Actual CAS claim","sourceLocator":"main.tex:1","verificationPlan":{"kind":"evidence","requiresEvidence":true}}],"evidence":[{"id":"actual-evidence","path":root.join("source/raw.dat"),"source_locator":root.join("source/raw.dat"),"sha256":sha(raw),"claim_ids":["claim:actual"],"result_class":"verified","verificationStatus":"evidence_artifact_verified","verifiedHash":sha(raw),"provenanceReceiptHash":"sha256:caller-fake","consumptionPolicy":{"status":"evidence_consumption_ready"}}]});
    fs::write(
        root.join("source/claims.json"),
        serde_json::to_vec(&record).unwrap(),
    )
    .unwrap();
    NativeInventoryRequestV1 {
        version: 1,
        root: root.into(),
        database: None,
        inventory_source: "yaml".into(),
        include_loose_drafts: false,
        include_retired: false,
        include_quarantined: false,
        include_proposal_staging: false,
        proposal_staging_root: None,
        paper_ids: Vec::new(),
        limit: None,
        observed_at: Some("2026-10-02T00:00:00.000Z".into()),
    }
}
#[test]
fn actual_inventory_source_cas_consumer_rehashes_bytes_and_never_reads_display_paths() {
    let temp = Temp::new();
    let request = setup(&temp.0);
    let c = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + Duration::from_secs(30);
    let initial = discover_native_inventory_v1(&request, &c, deadline).unwrap();
    let task = initial.scan()["rows"][0]["task"].clone();
    drop(initial);
    let runtime = open_native_research_source_data_runtime_v1(
        &NativeResearchSourcePlanRequestV1 {
            version: 1,
            root: temp.0.clone(),
            paper_task: task.clone(),
        },
        &c,
        deadline,
    )
    .unwrap();
    let _cleanup = RuntimeCleanup(runtime.workflow_directory().parent().unwrap().to_owned());
    let inventory = discover_native_inventory_v1(&request, &c, deadline).unwrap();
    let (node, receipt) = crate::native_research_quality::tests::actual_node(
        "import{discoverInventory}from'./paper-adapters/inventory/index.mjs';let raw='';for await(const c of process.stdin)raw+=c;const scan=await discoverInventory(JSON.parse(raw));process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},scan}));",
        &serde_json::to_value(&request).unwrap(),
    );
    assert_eq!(&node["scan"], inventory.scan());
    let id = task["paperId"].as_str().unwrap();
    let prepared = prepare_native_research_cas_assessment_for_inventory_row_v1(
        &inventory, id, &runtime, &c, deadline,
    )
    .unwrap();
    let stable = prepared.request().manifest_object.clone();
    let repeat = prepare_native_research_cas_assessment_for_inventory_row_v1(
        &inventory, id, &runtime, &c, deadline,
    )
    .unwrap();
    assert_eq!(repeat.request().manifest_object, stable);
    drop(repeat);
    prepared.verify_unchanged().unwrap();
    let job = prepared.job();
    drop(prepared);
    drop(inventory);
    // The job is entirely immutable captured data. Removing the display/source
    // namespace cannot make this consumer open a caller path or claim it current.
    fs::remove_dir_all(temp.0.join("source")).unwrap();
    let crate::NativeJobV1::Business { job } = job else {
        panic!("business producer");
    };
    let output = crate::native_business::execute_native_business_with_objects_and_deadline_for_capability_v1(
        job,
        "CAP-EVD-VERIFY",
        runtime.objects(),
        &c,
        Some(deadline),
    )
    .unwrap();
    let value: Value = serde_json::from_slice(&output.artifacts[0]).unwrap();
    assert_eq!(value["kind"], "NativeCasResearchAssessment");
    assert_eq!(value["currentFilesystemVerified"], false);
    assert_eq!(value["academicAuthorityGranted"], false);
    assert_eq!(
        value["integrityReceipts"][0]["kind"],
        "NativeCasArtifactIntegrityReceipt"
    );
    assert_eq!(
        value["integrityReceipts"][0]["status"],
        "cas_artifact_integrity_verified"
    );
    assert!(
        value["integrityReceipts"][0]
            .get("scopedFileReadReceiptHash")
            .is_none()
    );
    assert_ne!(
        value["integrityReceipts"][0]["provenanceReceiptHash"],
        "sha256:caller-fake"
    );
    assert_eq!(value["evidenceIntake"]["status"], "evidence_intake_ready");
    assert_eq!(
        value["evidenceQualityGate"]["status"],
        "evidence_quality_ready"
    );
    assert_eq!(value["researchGapPlan"]["jobs"], json!([]));
    eprintln!(
        "actual_cas_assessment_producer={}",
        json!({"normalNodeInventoryWholeEqual":true,"node":receipt,"sourceManifestObject":stable,"rawRehashed":true,"removedDisplaySourceNotOpened":true,"capturedDataOnly":true,"academicAuthorityGranted":false})
    );
}
#[test]
fn actual_source_cas_assessment_refuses_forged_binding_missing_object_cancel_and_expiration() {
    let temp = Temp::new();
    let request = setup(&temp.0);
    let c = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + Duration::from_secs(30);
    let initial = discover_native_inventory_v1(&request, &c, deadline).unwrap();
    let task = initial.scan()["rows"][0]["task"].clone();
    drop(initial);
    let runtime = open_native_research_source_data_runtime_v1(
        &NativeResearchSourcePlanRequestV1 {
            version: 1,
            root: temp.0.clone(),
            paper_task: task.clone(),
        },
        &c,
        deadline,
    )
    .unwrap();
    let _cleanup = RuntimeCleanup(runtime.workflow_directory().parent().unwrap().to_owned());
    let inventory = discover_native_inventory_v1(&request, &c, deadline).unwrap();
    let wrong_flag = AtomicBool::new(false);
    assert!(
        super::super::inspect_native_research_assessment_for_inventory_row_v1(
            &inventory,
            task["paperId"].as_str().unwrap(),
            &wrong_flag,
            deadline
        )
        .is_err(),
        "an inventory cannot be re-bound to another active cancellation owner"
    );
    assert!(
        super::super::inspect_native_research_assessment_for_inventory_row_v1(
            &inventory,
            task["paperId"].as_str().unwrap(),
            &c,
            deadline + Duration::from_millis(1)
        )
        .is_err(),
        "an inventory cannot be re-bound to a shifted absolute deadline"
    );
    let prepared = prepare_native_research_cas_assessment_for_inventory_row_v1(
        &inventory,
        task["paperId"].as_str().unwrap(),
        &runtime,
        &c,
        deadline,
    )
    .unwrap();
    let q = prepared.request().clone();
    assert!(
        execution::execute(
            runtime.objects(),
            q.clone(),
            &AtomicBool::new(true),
            deadline
        )
        .is_err()
    );
    assert!(execution::execute(runtime.objects(), q.clone(), &c, Instant::now()).is_err());
    assert!(
        execution::execute(
            runtime.objects(),
            NativeResearchCasAssessmentRequestV1 {
                version: 1,
                manifest_object: sha(b"never inserted manifest")
            },
            &c,
            deadline
        )
        .is_err()
    );
    assert!(
        execute_native_business_with_objects_for_capability_v1(
            NativeBusinessJobV1::ResearchObservedAssessmentFromCasV1 { request: q.clone() },
            "CAP-EVD-VERIFY",
            runtime.objects(),
            &c
        )
        .is_err(),
        "new source job has no automatic deadline"
    );
    let manifest_bytes = runtime.objects().read(&q.manifest_object).unwrap();
    let mut forged: CapturedManifest = serde_json::from_slice(&manifest_bytes).unwrap();
    forged.row["task"]["title"] = json!("same paper ID forged task");
    let hash = runtime
        .objects()
        .put(&serde_json::to_vec(&forged).unwrap())
        .unwrap();
    assert!(
        execution::execute(
            runtime.objects(),
            NativeResearchCasAssessmentRequestV1 {
                version: 1,
                manifest_object: hash
            },
            &c,
            deadline
        )
        .is_err()
    );
    let mut forged: CapturedManifest = serde_json::from_slice(&manifest_bytes).unwrap();
    forged.files[0].relative = "../unscoped".into();
    let hash = runtime
        .objects()
        .put(&serde_json::to_vec(&forged).unwrap())
        .unwrap();
    assert!(
        execution::execute(
            runtime.objects(),
            NativeResearchCasAssessmentRequestV1 {
                version: 1,
                manifest_object: hash
            },
            &c,
            deadline
        )
        .is_err()
    );
    assert!(
        execute_native_business_with_objects_for_capability_v1(
            NativeBusinessJobV1::ResearchObservedAssessmentFromCasV1 { request: q.clone() },
            "CAP-SUBMIT",
            runtime.objects(),
            &c
        )
        .is_err()
    );
    let fresh = execution::execute(runtime.objects(), q, &c, deadline).unwrap();
    assert_eq!(fresh.evidence["scientificAcceptance"], false);
    fs::write(
        temp.0.join("source/raw.dat"),
        "changed source after capture",
    )
    .unwrap();
    assert!(prepared.verify_unchanged().is_err());
}
