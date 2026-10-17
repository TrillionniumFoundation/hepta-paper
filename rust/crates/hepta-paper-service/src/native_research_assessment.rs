//! Preview research assessment built from a held ordinary inventory row.
//! Actual artifact verification and consumption are retained; scientific and
//! academic execution authority is never accepted as caller JSON.
use crate::{
    native_business::local_submission_preflight::{
        local_submission_projected_values_budget_v1 as reserve,
        local_submission_values_budget_v1 as budget,
    },
    native_inventory::NativeInventoryObservationV1,
    native_research_contract_context::{
        NativeResearchContractContextRequestV1, build_native_research_contract_context_v1,
    },
    native_research_evidence::{
        NativeResearchObservedInputsObservationV1, NativeResearchObservedInputsRequestV1,
        inspect_native_research_observed_inputs_v1,
    },
    native_research_gap_plan::build_native_research_gap_plan_v1,
    native_research_quality::build_native_nonattested_evidence_quality_gate_v1,
};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
fn refused() -> String {
    "native_research_assessment_data_domain_v1_refused".into()
}
fn check(c: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if c.load(Ordering::SeqCst) {
        Err("native_research_assessment_cancelled".into())
    } else if Instant::now() >= deadline {
        Err("native_research_assessment_deadline_exceeded".into())
    } else {
        Ok(())
    }
}
fn array(v: &Value) -> Result<&[Value], String> {
    v.as_array().map(Vec::as_slice).ok_or_else(refused)
}
/// Non-deserializable handle retains the inventory/store and all actual research
/// input witnesses through consumption. The returned JSON alone is no receipt.
pub struct NativeResearchAssessmentObservationV1<'a, 'b> {
    inventory: &'b NativeInventoryObservationV1<'a>,
    inputs: NativeResearchObservedInputsObservationV1<'a>,
    assessment: Value,
    cancelled: &'a AtomicBool,
    deadline: Instant,
}
impl NativeResearchAssessmentObservationV1<'_, '_> {
    pub fn assessment(&self) -> &Value {
        &self.assessment
    }
    pub fn verify_unchanged(&self) -> Result<(), String> {
        check(self.cancelled, self.deadline)?;
        self.inventory.verify_unchanged()?;
        self.inputs.verify_unchanged()?;
        check(self.cancelled, self.deadline)
    }
}
/// Select one normal observed row by its actual paper ID. No task, source path,
/// quality flag or fabricated trusted receipt can be supplied by the caller.
pub fn inspect_native_research_assessment_for_inventory_row_v1<'a, 'b>(
    inventory: &'b NativeInventoryObservationV1<'a>,
    paper_id: &str,
    c: &'a AtomicBool,
    deadline: Instant,
) -> Result<NativeResearchAssessmentObservationV1<'a, 'b>, String> {
    check(c, deadline)?;
    inventory.require_control_context_v1(c, deadline)?;
    if paper_id.is_empty() || paper_id.len() > 256 || paper_id.contains('\0') {
        return Err(refused());
    }
    let root = inventory.scan()["root"]
        .as_str()
        .map(PathBuf::from)
        .ok_or_else(refused)?;
    let rows = array(&inventory.scan()["rows"])?;
    let mut selected = rows
        .iter()
        .filter(|row| row["task"]["paperId"].as_str() == Some(paper_id));
    let row = selected.next().ok_or_else(refused)?;
    if selected.next().is_some() {
        return Err(refused());
    }
    budget([row])?;
    let source_root = match &row["sourceDir"] {
        Value::Null => None,
        Value::String(s) => Some(PathBuf::from(s)),
        _ => return Err(refused()),
    };
    let inputs = inspect_native_research_observed_inputs_v1(
        NativeResearchObservedInputsRequestV1 {
            version: 1,
            root,
            source_root: source_root.clone(),
            paper_task: row["task"].clone(),
        },
        c,
        deadline,
    )?;
    let evidence = &inputs.observed()["evidence"];
    let records = array(&evidence["evidenceRecords"])?;
    let seed = array(&evidence["proposalSeedEvidence"])?;
    let structured = &evidence["structured"];
    reserve(
        [row, structured].into_iter().chain(records).chain(seed),
        32,
        2048,
    )?;
    let context = build_native_research_contract_context_v1(
        NativeResearchContractContextRequestV1 {
            version: 1,
            row: row.clone(),
            source_root,
            evidence_records: records.to_vec(),
            proposal_seed_evidence: seed.to_vec(),
            structured: structured.clone(),
            native_research_worker_execution: Value::Null,
            require_native_workers: false,
        },
        c,
        deadline,
    )?;
    inventory.verify_unchanged()?;
    inputs.verify_unchanged()?;
    check(c, deadline)?;
    let quality = build_native_nonattested_evidence_quality_gate_v1(
        &row["task"],
        &context["claimRegistry"],
        &inputs,
        c,
        deadline,
    )?;
    reserve([row, &context, &quality, inputs.observed()], 16, 512)?;
    let gap = build_native_research_gap_plan_v1(
        &json!({"paperTask":row["task"],"claimRegistry":context["claimRegistry"],"evidenceQualityGate":quality}),
        c,
        deadline,
    )?;
    // Reserve all returned projected occurrences before copying into the complete
    // observation. A source-integrity gate does not qualify a scientific result.
    reserve([row, &context, &quality, &gap, inputs.observed()], 64, 2048)?;
    let assessment = json!({"version":1,"kind":"NativeObservedResearchAssessment","profile":"nonattested_actual_artifact_preview_v1","paperId":row["task"]["paperId"],"taskKey":row["task"]["taskKey"],"contractContext":context,"evidenceIntake":inputs.observed()["evidenceIntake"],"evidenceQualityGate":quality,"researchGapPlan":gap,"scientificAcceptanceGranted":false,"academicAuthorityGranted":false,"trustedExecutionBranchesAccepted":false});
    let result = NativeResearchAssessmentObservationV1 {
        inventory,
        inputs,
        assessment,
        cancelled: c,
        deadline,
    };
    result.verify_unchanged()?;
    Ok(result)
}
#[cfg(test)]
mod tests;

pub(crate) mod cas;
pub use cas::{
    NativeResearchCasAssessmentRequestV1, PreparedNativeResearchCasAssessmentV1,
    initialize_native_research_cas_assessment_workflow_v1,
    operate_native_research_cas_assessment_workflow_v1,
    prepare_native_research_cas_assessment_for_inventory_row_v1,
};
