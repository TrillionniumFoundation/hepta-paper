//! A thin producer/consumer over the original durable workflow kernel.
use super::producer::PreparedNativeResearchCasAssessmentV1;
use super::*;
use crate::{
    native_research_source_plan::NativeResearchSourceDataRuntimeV1,
    native_research_workflow::NativeResearchDataWorkflowBindingV1,
    workflow::{
        LocalWorkflowV1, WorkflowActionV1, WorkflowProgressV1, WorkflowStepV1,
        initialize_local_workflow_v1, operate_local_workflow_with_service_runner_v1,
    },
};
use std::{collections::BTreeSet, path::PathBuf, sync::Arc};
fn state(runtime: &NativeResearchSourceDataRuntimeV1<'_>) -> PathBuf {
    runtime
        .workflow_directory()
        .with_file_name("native-assessment-workflow.v1")
}
fn validate_runtime(
    prepared: &PreparedNativeResearchCasAssessmentV1<'_, '_>,
    runtime: &NativeResearchSourceDataRuntimeV1<'_>,
) -> Result<(), String> {
    prepared.verify_unchanged()?;
    let observation = &prepared.observation;
    let row = observation.inventory.scan()["rows"]
        .as_array()
        .ok_or_else(refused)?
        .iter()
        .find(|r| r["task"]["paperId"] == observation.assessment()["paperId"])
        .ok_or_else(refused)?;
    runtime.require_observed_task_v1(
        Path::new(
            observation.inventory.scan()["root"]
                .as_str()
                .ok_or_else(refused)?,
        ),
        &row["task"],
        Path::new(row["sourceDir"].as_str().ok_or_else(refused)?),
        observation.cancelled,
        observation.deadline,
    )
}
fn require_target_inputs(
    prepared: &PreparedNativeResearchCasAssessmentV1<'_, '_>,
    runtime: &NativeResearchSourceDataRuntimeV1<'_>,
) -> Result<(), String> {
    let c = prepared.observation.cancelled;
    let deadline = prepared.observation.deadline;
    check(c, deadline)?;
    let access = Arc::new(
        crate::state_access::StateAccessGuardV1::exclusive(&state(runtime))
            .map_err(|_| refused())?,
    );
    let target =
        ObjectStoreV1::readonly_under_guard(&state(runtime), access).map_err(|_| refused())?;
    let manifest = execution::read_manifest(&target, prepared.request())?;
    let mut remaining = MAX_RAW;
    for file in manifest.files {
        check(c, deadline)?;
        if file.bytes > remaining {
            return Err(refused());
        }
        let bytes = target
            .read_with_maximum_v1(&file.object, file.bytes.max(1))
            .map_err(|_| refused())?;
        if bytes.len() as u64 != file.bytes || sha(&bytes) != file.object {
            return Err(refused());
        }
        remaining -= file.bytes;
    }
    check(c, deadline)
}
/// The fixed native runtime location and immutable captured manifest are the
/// initial subject. No caller path override or unknown previous state is adopted.
pub fn initialize_native_research_cas_assessment_workflow_v1(
    prepared: &PreparedNativeResearchCasAssessmentV1<'_, '_>,
    runtime: &NativeResearchSourceDataRuntimeV1<'_>,
    binding: NativeResearchDataWorkflowBindingV1,
) -> Result<Sha256Digest, String> {
    validate_runtime(prepared, runtime)?;
    let c = prepared.observation.cancelled;
    let deadline = prepared.observation.deadline;
    if binding.template.state_directory != state(runtime) {
        return Err(refused());
    }
    let source = runtime.objects();
    let manifest = execution::read_manifest(source, prepared.request())?;
    let manifest_bytes = source
        .read_with_maximum_v1(&prepared.request().manifest_object, MAX_MANIFEST)
        .map_err(|_| refused())?;
    let mut input_bytes = Vec::new();
    let mut seen = BTreeSet::new();
    let mut remaining = MAX_RAW;
    for file in &manifest.files {
        check(c, deadline)?;
        if file.bytes > remaining {
            return Err(refused());
        }
        remaining -= file.bytes;
        if seen.insert(file.object.clone()) {
            let bytes = source
                .read_with_maximum_v1(&file.object, file.bytes.max(1))
                .map_err(|_| refused())?;
            if sha(&bytes) != file.object || bytes.len() as u64 != file.bytes {
                return Err(refused());
            }
            input_bytes.push((file.object.clone(), bytes));
        }
    }
    let mut template = binding.template;
    template.initial_state_hash = prepared.request().manifest_object.clone();
    template.snapshot.state_hash = template.initial_state_hash.clone();
    template.frontier.snapshot_hash = template.snapshot.snapshot_hash().map_err(|_| refused())?;
    let definition = LocalWorkflowV1 {
        version: 1,
        provider_call_budget: None,
        research_profile: binding.research_profile,
        template,
        steps: vec![WorkflowStepV1 {
            id: "research.source-assessment".into(),
            module_id: binding.module_id,
            capability_id: "CAP-EVD-VERIFY".into(),
            resources: binding.resources,
            cost_microusd: binding.cost_microusd,
            job_template: serde_json::to_value(prepared.job()).map_err(|_| refused())?,
            bindings: Vec::new(),
            gate: None,
        }],
    };
    definition.validate().map_err(|_| refused())?;
    validate_runtime(prepared, runtime)?;
    let definition_hash = initialize_local_workflow_v1(definition).map_err(|_| refused())?;
    #[cfg(test)]
    super::initialization_tests::after_definition_created(&definition_hash);
    check(c, deadline)?;
    let destination = ObjectStoreV1::open(&state(runtime)).map_err(|_| refused())?;
    if destination.put(&manifest_bytes).map_err(|_| refused())?
        != prepared.request().manifest_object
    {
        return Err(refused());
    }
    for (hash, bytes) in input_bytes {
        check(c, deadline)?;
        if destination.put(&bytes).map_err(|_| refused())? != hash {
            return Err(refused());
        }
    }
    validate_runtime(prepared, runtime)?;
    check(c, deadline)?;
    Ok(definition_hash)
}
/// Execute only with the same opaque source controls used for capture. Each
/// service clock observation, including the existing SQL result transaction,
/// rechecks held source/task witnesses; requests never serialize these controls.
pub fn operate_native_research_cas_assessment_workflow_v1(
    prepared: &PreparedNativeResearchCasAssessmentV1<'_, '_>,
    runtime: &NativeResearchSourceDataRuntimeV1<'_>,
    expected_definition: &Sha256Digest,
    action: WorkflowActionV1,
    observe: &mut dyn FnMut() -> Result<u64, hepta_control_plane::ControlPlaneError>,
    cancelled: Arc<AtomicBool>,
) -> Result<WorkflowProgressV1, String> {
    validate_runtime(prepared, runtime)?;
    if !std::ptr::eq(cancelled.as_ref(), prepared.observation.cancelled) {
        return Err(refused());
    }
    // A known incomplete initializer is not an unknown worker dispatch. Retain
    // it and refuse before the original kernel records any execution intent.
    require_target_inputs(prepared, runtime)?;
    let deadline = prepared.observation.deadline;
    let mut checked_clock = || {
        prepared
            .verify_unchanged()
            .map_err(|_| hepta_control_plane::ControlPlaneError::PersistenceInvalid)?;
        let now = observe()?;
        prepared
            .verify_unchanged()
            .map_err(|_| hepta_control_plane::ControlPlaneError::PersistenceInvalid)?;
        Ok(now)
    };
    let result=operate_local_workflow_with_service_runner_v1(&state(runtime),expected_definition,action,&mut checked_clock,Arc::clone(&cancelled),None,|config,clock,shared|{
        validate_runtime(prepared,runtime).map_err(|_|crate::ServiceError::Configuration)?;
        if !std::ptr::eq(shared.as_ref(),prepared.observation.cancelled)||config.initial_state_hash!=prepared.request().manifest_object{return Err(crate::ServiceError::Configuration);}
        let objects=ObjectStoreV1::open(&config.state_directory)?;
        for candidate in &config.frontier.candidates{
            let bytes=objects.read_with_maximum_v1(&candidate.payload_hash,MAX_MANIFEST)?;
            let job:crate::NativeJobV1=serde_json::from_slice(&bytes).map_err(|_|crate::ServiceError::Configuration)?;
            let crate::NativeJobV1::Business{job:crate::native_business::NativeBusinessJobV1::ResearchObservedAssessmentFromCasV1{request}}=job else{return Err(crate::ServiceError::Configuration);};
            if request.version!=1||request.manifest_object!=prepared.request().manifest_object{return Err(crate::ServiceError::Configuration);}
        }
        crate::run_service_with_observed_native_deadline_v1(config,clock,shared,Some(deadline)).map(|_|())
    }).map_err(|_|refused())?;
    validate_runtime(prepared, runtime)?;
    check(&cancelled, deadline)?;
    Ok(result)
}
