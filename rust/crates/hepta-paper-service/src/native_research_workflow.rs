//! Compose a held research-data plan through the existing workflow kernel.
//!
//! This is a data-worker subworkflow. It grants no paper scientific acceptance,
//! external effect, authenticated review, or complete ordinary batch execution.

use std::sync::atomic::{AtomicBool, Ordering};

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::ResourceVectorV1;
use serde::Serialize;

use crate::{
    ObjectStoreV1, ResearchWorkflowProfileV1, ServiceRunV1,
    native_research_plan::{
        NativeResearchPlanRequestV1, PreparedNativeResearchPlanV1,
        prepare_native_research_data_plan_from_request_v1,
    },
    workflow::{LocalWorkflowV1, WorkflowStepV1, initialize_local_workflow_v1},
};

/// Existing trusted runtime bindings; the workflow's original validator remains
/// responsible for registry, capability, aggregate cost and resource admission.
pub struct NativeResearchDataWorkflowBindingV1 {
    pub template: ServiceRunV1,
    pub research_profile: Option<ResearchWorkflowProfileV1>,
    pub module_id: String,
    pub resources: ResourceVectorV1,
    pub cost_microusd: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedNativeResearchDataWorkflowV1 {
    pub plan: PreparedNativeResearchPlanV1,
    pub definition: LocalWorkflowV1,
}

fn check(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        Err("native_research_data_workflow_cancelled".into())
    } else {
        Ok(())
    }
}

/// Produce the existing typed workflow from real plan-derived jobs. The actual
/// original plan is its initial CAS state, binding paper, claims and worker data.
pub fn prepare_native_research_data_workflow_v1(
    objects: &ObjectStoreV1,
    request: NativeResearchPlanRequestV1,
    binding: NativeResearchDataWorkflowBindingV1,
    cancelled: &AtomicBool,
) -> Result<PreparedNativeResearchDataWorkflowV1, String> {
    prepare_native_research_data_workflow_from_request_v1(objects, &request, binding, cancelled)
}

fn prepare_native_research_data_workflow_from_request_v1(
    objects: &ObjectStoreV1,
    request: &NativeResearchPlanRequestV1,
    binding: NativeResearchDataWorkflowBindingV1,
    cancelled: &AtomicBool,
) -> Result<PreparedNativeResearchDataWorkflowV1, String> {
    check(cancelled)?;
    let plan = prepare_native_research_data_plan_from_request_v1(objects, request, cancelled)?;
    let mut template = binding.template;
    // A new local workflow starts at revision one with an empty frontier. Other
    // authority and runtime declarations are retained and validated unchanged.
    template.initial_state_hash = plan.plan_hash.clone();
    template.snapshot.state_hash = plan.plan_hash.clone();
    template.frontier.snapshot_hash = template
        .snapshot
        .snapshot_hash()
        .map_err(|_| "native_research_data_workflow_snapshot_refused")?;
    let steps = plan
        .jobs
        .iter()
        .map(|prepared| {
            check(cancelled)?;
            Ok(WorkflowStepV1 {
                id: format!("research.{}", prepared.worker_id),
                module_id: binding.module_id.clone(),
                capability_id: "CAP-EVD-VERIFY".into(),
                resources: binding.resources,
                cost_microusd: binding.cost_microusd,
                job_template: serde_json::to_value(&prepared.job)
                    .map_err(|_| "native_research_data_workflow_encoding_refused")?,
                bindings: Vec::new(),
                gate: None,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let definition = LocalWorkflowV1 {
        version: 1,
        provider_call_budget: None,
        research_profile: binding.research_profile,
        template,
        steps,
    };
    definition
        .validate()
        .map_err(|_| "native_research_data_workflow_original_admission_refused")?;
    check(cancelled)?;
    Ok(PreparedNativeResearchDataWorkflowV1 { plan, definition })
}

/// Initialize using the existing no-clobber kernel, then populate that same CAS.
/// A failure after kernel creation deliberately retains the incomplete runtime;
/// this entry never deletes, adopts, or silently retries an unknown creation.
pub fn initialize_native_research_data_workflow_v1(
    source: &ObjectStoreV1,
    request: NativeResearchPlanRequestV1,
    binding: NativeResearchDataWorkflowBindingV1,
    cancelled: &AtomicBool,
) -> Result<Sha256Digest, String> {
    let prepared = prepare_native_research_data_workflow_from_request_v1(
        source, &request, binding, cancelled,
    )?;
    check(cancelled)?;
    // All immutable bytes are verified and bounded before any destination write.
    let plan_bytes = source
        .read_with_maximum_v1(&request.plan_object, 256 * 1024)
        .map_err(|_| "native_research_data_workflow_plan_refused")?;
    let mut bytes = Vec::new();
    let mut remaining = 4 * 1024 * 1024_u64;
    for digest in request.source_objects.values() {
        check(cancelled)?;
        let observed = source
            .read_with_maximum_v1(digest, remaining.max(1))
            .map_err(|_| "native_research_data_workflow_input_refused")?;
        remaining = remaining
            .checked_sub(observed.len() as u64)
            .ok_or("native_research_data_workflow_input_budget_refused")?;
        bytes.push((digest, observed));
    }
    let destination = prepared.definition.template.state_directory.clone();
    check(cancelled)?;
    let hash = initialize_local_workflow_v1(prepared.definition)
        .map_err(|_| "native_research_data_workflow_kernel_creation_refused")?;
    let target = ObjectStoreV1::open(&destination)
        .map_err(|_| "native_research_data_workflow_created_runtime_requires_recovery")?;
    check(cancelled)?;
    if target
        .put(&plan_bytes)
        .map_err(|_| "native_research_data_workflow_created_runtime_requires_recovery")?
        != request.plan_object
    {
        return Err("native_research_data_workflow_created_runtime_requires_recovery".into());
    }
    for (digest, original) in &bytes {
        check(cancelled)?;
        if target
            .put(original)
            .map_err(|_| "native_research_data_workflow_created_runtime_requires_recovery")?
            != **digest
        {
            return Err("native_research_data_workflow_created_runtime_requires_recovery".into());
        }
        if source
            .read_with_maximum_v1(digest, original.len().max(1) as u64)
            .map_err(|_| "native_research_data_workflow_created_runtime_requires_recovery")?
            != *original
        {
            return Err("native_research_data_workflow_created_runtime_requires_recovery".into());
        }
    }
    if source
        .read_with_maximum_v1(&request.plan_object, 256 * 1024)
        .map_err(|_| "native_research_data_workflow_created_runtime_requires_recovery")?
        != plan_bytes
    {
        return Err("native_research_data_workflow_created_runtime_requires_recovery".into());
    }
    check(cancelled)?;
    Ok(hash)
}
