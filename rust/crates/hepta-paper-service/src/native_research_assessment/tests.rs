use super::*;
use crate::native_inventory::{NativeInventoryRequestV1, discover_native_inventory_v1};
use crate::native_research_quality::tests::actual_node;
use sha2::Digest;
use std::{fs, sync::Arc, time::Duration};
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-native-assessment-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn setup(root: &std::path::Path, requires_evidence: bool) -> NativeInventoryRequestV1 {
    fs::create_dir(root.join("registry")).unwrap();
    fs::create_dir_all(root.join("drafts/actual-paper")).unwrap();
    fs::write(root.join("registry/papers.yaml"),"papers:\n  - slug: actual-paper\n    title: Actual observed paper\n    status: draft\n    canonical_dir: drafts/actual-paper\n").unwrap();
    fs::write(
        root.join("drafts/actual-paper/main.tex"),
        "Observed manuscript\n",
    )
    .unwrap();
    let source = root.join("drafts/actual-paper");
    let bytes = b"actual raw local artifact\n";
    fs::write(source.join("raw.dat"), bytes).unwrap();
    let hash =
        hepta_codex_protocol::Sha256Digest::from_digest_bytes(sha2::Sha256::digest(bytes).into());
    let data = json!({"claims":[{"id":"claim:actual","text":"Actual local claim","sourceLocator":"main.tex:1","verificationPlan":{"kind":"evidence","requiresEvidence":requires_evidence}}],"evidence":[{"id":"actual-evidence","path":source.join("raw.dat"),"source_locator":source.join("raw.dat"),"sha256":hash,"claim_ids":["claim:actual"],"result_class":"verified"}]});
    fs::write(
        source.join("claims.json"),
        serde_json::to_vec(&data).unwrap(),
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
        paper_ids: vec![],
        limit: None,
        observed_at: Some("2026-10-02T00:00:00.000Z".into()),
    }
}
#[test]
fn actual_inventory_row_source_intake_context_quality_gap_matches_original_complete_values() {
    let temp = Temp::new();
    for require in [false, true] {
        let root = temp.0.join(if require {
            "artifact-required"
        } else {
            "source-policy"
        });
        fs::create_dir(&root).unwrap();
        let request = setup(&root, require);
        let c = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + Duration::from_secs(30);
        let inventory = discover_native_inventory_v1(&request, &c, deadline).unwrap();
        assert_eq!(inventory.scan()["rows"].as_array().unwrap().len(), 1);
        let id = inventory.scan()["rows"][0]["task"]["paperId"]
            .as_str()
            .unwrap();
        let observation =
            inspect_native_research_assessment_for_inventory_row_v1(&inventory, id, &c, deadline)
                .unwrap();
        let node_input = json!({"inventory":request,"createdAts":observation.inputs.observed()["evidenceVerificationReceipts"].as_array().unwrap().iter().map(|v|v["createdAt"].clone()).collect::<Vec<_>>()});
        let script = r#"import path from'node:path';import{discoverInventory}from'./paper-adapters/inventory/index.mjs';import{defaultPaperRuntimeRoot}from'./paper-adapters/runtime/workspace-layout.mjs';import{readResearchEvidenceSources}from'./paper-adapters/research-verify/research-evidence-reader.mjs';import{buildResearchContractContext}from'./paper-adapters/research-verify/research-report-builder.mjs';import{buildEvidenceVerificationCandidates,buildResearchEvidenceIntake}from'./paper-adapters/research-verify/research-evidence-candidates.mjs';import{verifyEvidenceBatch}from'./paper-adapters/research-verify/evidence-verifier.mjs';import{buildEvidenceQualityGate}from'./paper-domain/research/evidence-quality-gate.mjs';import{buildResearchGapPlan}from'./paper-domain/research/gap-planner.mjs';let raw='';for await(const c of process.stdin){raw+=c;if(Buffer.byteLength(raw)>1048576)throw Error('budget');}const q=JSON.parse(raw);const scan=await discoverInventory(q.inventory);const row=scan.rows[0];const sourceRoot=row.sourceDir;const evidence=await readResearchEvidenceSources({root:q.inventory.root,sourceRoot,paperTask:row.task,logRoot:path.join(q.inventory.root,'logs/paperctl',row.task.paperId),empiricalRoot:path.join(defaultPaperRuntimeRoot(),'empirical-analysis',row.task.paperId)});const candidates=buildEvidenceVerificationCandidates({root:q.inventory.root,sourceRoot,structured:evidence.structured});let clockIndex=0;const verification=await verifyEvidenceBatch({sourceRoot,evidenceItems:candidates,clock:{nowIso:()=>q.createdAts[clockIndex++]}});if(clockIndex!==q.createdAts.length)throw Error('actual_clock_count');const evidenceIntake=buildResearchEvidenceIntake({paperTask:row.task,structured:evidence.structured,academicEvidenceAttestation:{academicEvidenceEligible:false},evidenceVerificationReceipts:verification,now:new Date(q.createdAts[0])});const contractContext=buildResearchContractContext({row,sourceRoot,evidenceRecords:evidence.evidenceRecords,proposalSeedEvidence:evidence.proposalSeedEvidence,structured:evidence.structured,nativeResearchWorkerExecution:null,requireNativeWorkers:false});const evidenceQualityGate=buildEvidenceQualityGate({paperTask:row.task,claimRegistry:contractContext.claimRegistry,evidenceIntake});const researchGapPlan=buildResearchGapPlan({paperTask:row.task,claimRegistry:contractContext.claimRegistry,evidenceQualityGate});const assessment={version:1,kind:'NativeObservedResearchAssessment',profile:'nonattested_actual_artifact_preview_v1',paperId:row.task.paperId,taskKey:row.task.taskKey,contractContext,evidenceIntake,evidenceQualityGate,researchGapPlan,scientificAcceptanceGranted:false,academicAuthorityGranted:false,trustedExecutionBranchesAccepted:false};process.stdout.write(JSON.stringify({profile:{node:process.version,icu:process.versions.icu,cldr:process.versions.cldr},scan,assessment}));"#;
        let (node, receipt) = actual_node(script, &node_input);
        assert_eq!(
            inventory.scan(),
            &node["scan"],
            "actual normal inventory whole row"
        );
        assert_eq!(
            observation.assessment(),
            &node["assessment"],
            "whole original context/intake/quality/gap"
        );
        println!(
            "actual_observed_assessment_intake={}",
            observation.assessment()["evidenceIntake"]
        );
        assert_eq!(
            observation.assessment()["evidenceIntake"]["status"],
            "evidence_intake_ready"
        );
        assert_eq!(
            observation.assessment()["evidenceQualityGate"]["status"],
            "evidence_quality_ready"
        );
        assert_eq!(
            observation.assessment()["researchGapPlan"]["jobs"],
            json!([])
        );
        observation.verify_unchanged().unwrap();
        println!(
            "actual_observed_research_assessment={}",
            json!({"requireEvidence":require,"process":receipt,"actualArtifactConsumed":true,"wholeOriginalAssessmentEqual":true,"academicAuthorityGranted":false})
        );
    }
}
#[test]
fn actual_observed_research_assessment_refuses_drift_cancel_expiration_missing_row_and_retries() {
    let temp = Temp::new();
    let request = setup(&temp.0, true);
    let c = Arc::new(AtomicBool::new(false));
    let deadline = Instant::now() + Duration::from_secs(30);
    let inventory = discover_native_inventory_v1(&request, &c, deadline).unwrap();
    let id = inventory.scan()["rows"][0]["task"]["paperId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        inspect_native_research_assessment_for_inventory_row_v1(
            &inventory,
            "caller-fake",
            &c,
            deadline
        )
        .is_err()
    );
    assert!(
        inspect_native_research_assessment_for_inventory_row_v1(
            &inventory,
            &id,
            &c,
            Instant::now()
        )
        .is_err()
    );
    let observed =
        inspect_native_research_assessment_for_inventory_row_v1(&inventory, &id, &c, deadline)
            .unwrap();
    fs::write(
        temp.0.join("drafts/actual-paper/raw.dat"),
        b"changed artifact",
    )
    .unwrap();
    assert!(observed.verify_unchanged().is_err());
    drop(observed);
    drop(inventory);
    let retry_deadline = Instant::now() + Duration::from_secs(30);
    let retry_inventory = discover_native_inventory_v1(&request, &c, retry_deadline).unwrap();
    let retry = inspect_native_research_assessment_for_inventory_row_v1(
        &retry_inventory,
        &id,
        &c,
        retry_deadline,
    )
    .unwrap();
    assert_eq!(
        retry.assessment()["evidenceQualityGate"]["status"],
        "evidence_quality_blocked"
    );
    c.store(true, Ordering::SeqCst);
    assert!(retry.verify_unchanged().is_err());
}
