//! Actual normal paper-workspace plans composed into the existing data jobs.
//!
//! The caller must retain an opaque observed-input owner. Only the fixed plan
//! and its real listed members can enter CAS; this is no scientific authority.
use crate::{
    ObjectStoreV1,
    native_business::local_submission_preflight::{
        local_submission_normalize, local_submission_values_budget_v1,
    },
    native_research_evidence::NativeResearchObservedInputsObservationV1,
    native_research_plan::{
        NativeResearchPlanRequestV1, PreparedNativeResearchPlanV1,
        native_research_plan_source_bindings_v1,
        prepare_native_research_data_plan_from_observed_v1,
    },
    native_research_workflow::{
        NativeResearchDataWorkflowBindingV1, initialize_native_research_data_workflow_v1,
    },
    native_workspace::{current_native_command_runtime_root_v1, resolve_native_workspace_root_v1},
    state_recoverability::publication::Directory,
};
use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
const MAX_PLAN_BYTES: u64 = 256 * 1024;
const MAX_BYTES: u64 = 4 * 1024 * 1024;
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResearchSourcePlanRequestV1 {
    pub version: u16,
    pub root: PathBuf,
    pub paper_task: Value,
}
/// Existing typed request and jobs, derived from actual held filesystem bytes.
/// The source owner must remain alive and be rechecked through queue admission.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedNativeResearchSourceDataPlanV1 {
    version: u16,
    source_root: PathBuf,
    source_merkle: Sha256Digest,
    paper_task_binding: Sha256Digest,
    request: NativeResearchPlanRequestV1,
    plan: PreparedNativeResearchPlanV1,
    selected_source_members: usize,
}
/// This opaque owner selects the existing normal runtime layout. No caller
/// path, environment projection or serialized runtime identity can construct it.
pub struct NativeResearchSourceDataRuntimeV1<'a> {
    objects: ObjectStoreV1,
    directory: Directory,
    workflow_directory: PathBuf,
    paper_id: String,
    task_key: String,
    paper_task_binding: Sha256Digest,
    source_root: PathBuf,
    root: PathBuf,
    cancelled: &'a AtomicBool,
    deadline: Instant,
}
impl NativeResearchSourceDataRuntimeV1<'_> {
    pub fn workflow_directory(&self) -> &Path {
        &self.workflow_directory
    }
    pub fn objects(&self) -> &ObjectStoreV1 {
        &self.objects
    }
    pub(crate) fn require_observed_task_v1(
        &self,
        root: &Path,
        task: &Value,
        source: &Path,
        c: &AtomicBool,
        deadline: Instant,
    ) -> Result<(), String> {
        active(c, deadline)?;
        self.directory.assert_current().map_err(|_| refusal())?;
        local_submission_values_budget_v1(std::iter::once(task))?;
        if !std::ptr::eq(c, self.cancelled)
            || deadline != self.deadline
            || root != self.root
            || source != self.source_root
            || task["paperId"].as_str() != Some(&self.paper_id)
            || task["taskKey"].as_str() != Some(&self.task_key)
            || NativeResearchObservedInputsObservationV1::derive_paper_task_binding_v1(task)?
                != self.paper_task_binding
        {
            return Err(refusal());
        }
        active(c, deadline)
    }
}
impl PreparedNativeResearchSourceDataPlanV1 {
    pub fn request(&self) -> &NativeResearchPlanRequestV1 {
        &self.request
    }
    pub fn plan(&self) -> &PreparedNativeResearchPlanV1 {
        &self.plan
    }
    pub fn selected_source_members(&self) -> usize {
        self.selected_source_members
    }
}
/// Open before capturing the input witnesses: intentional runtime namespace
/// creation cannot be passed off as unchanged observed inputs. The existing
/// ObjectStore owner alone creates and validates its physical private state.
pub fn open_native_research_source_data_runtime_v1<'a>(
    request: &NativeResearchSourcePlanRequestV1,
    cancelled: &'a AtomicBool,
    deadline: Instant,
) -> Result<NativeResearchSourceDataRuntimeV1<'a>, String> {
    active(cancelled, deadline)?;
    let (paper_id, task_key, source_root) = task_binding(request)?;
    let paper_task_binding =
        NativeResearchObservedInputsObservationV1::derive_paper_task_binding_v1(
            &request.paper_task,
        )?;
    active(cancelled, deadline)?;
    // A PaperTask produced by the original normalizer is already canonical.
    // Require that exact value rather than creating a second ambiguous ID.
    if local_submission_normalize(paper_id) != paper_id
        || paper_id.contains('\\')
        || !matches!(
            Path::new(paper_id)
                .components()
                .collect::<Vec<_>>()
                .as_slice(),
            [std::path::Component::Normal(_)]
        )
    {
        return Err(refusal());
    }
    let selected = current_native_command_runtime_root_v1()?;
    if selected.as_os_str().len() > 4096 || selected.components().count() > 64 {
        return Err(refusal());
    }
    let output = selected.join("research-workers").join(paper_id);
    if output.starts_with(&source_root) || source_root.starts_with(&output) {
        return Err(refusal());
    }
    let workflow_directory = output.join("native-data-workflow.v1");
    let directory = Directory::open_or_create(&output.join("native-inputs.v1"), true)
        .map_err(|_| "native_research_source_data_runtime_directory_refused")?;
    active(cancelled, deadline)?;
    let objects = ObjectStoreV1::open(&output.join("native-inputs.v1"))
        .map_err(|_| "native_research_source_data_runtime_creation_refused")?;
    directory
        .sync_with_parents()
        .map_err(|_| "native_research_source_data_runtime_directory_refused")?;
    active(cancelled, deadline)?;
    Ok(NativeResearchSourceDataRuntimeV1 {
        objects,
        directory,
        workflow_directory,
        paper_id: paper_id.to_owned(),
        task_key: task_key.to_owned(),
        paper_task_binding,
        source_root,
        root: request.root.clone(),
        cancelled,
        deadline,
    })
}
fn task_binding(
    request: &NativeResearchSourcePlanRequestV1,
) -> Result<(&str, &str, PathBuf), String> {
    if request.version != 1 || !request.root.is_absolute() || request.root.as_os_str().len() > 4096
    {
        return Err(refusal());
    }
    local_submission_values_budget_v1(std::iter::once(&request.paper_task))?;
    let paper_id = text(&request.paper_task, "paperId", 256)?;
    let task_key = text(&request.paper_task, "taskKey", 512)?;
    let workspace = text(&request.paper_task, "sourceWorkspace", 4096)?;
    let selected = resolve_native_workspace_root_v1(&request.root, Path::new(workspace), None)?;
    Ok((paper_id, task_key, selected))
}
fn refusal() -> String {
    "native_research_observed_source_plan_domain_v1_refused".into()
}
fn active(c: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if c.load(Ordering::SeqCst) {
        Err("native_research_observed_source_plan_cancelled".into())
    } else if Instant::now() >= deadline {
        Err("native_research_observed_source_plan_deadline".into())
    } else {
        Ok(())
    }
}
fn text<'a>(v: &'a Value, field: &str, maximum: usize) -> Result<&'a str, String> {
    let s = v[field].as_str().ok_or_else(refusal)?;
    if s.is_empty() || s.len() > maximum || s.chars().any(char::is_control) {
        Err(refusal())
    } else {
        Ok(s)
    }
}
fn digest(bytes: &[u8]) -> Sha256Digest {
    Sha256Digest::from_digest_bytes(Sha256::digest(bytes).into())
}
/// Prepare from the same normal paper task/workspace used by the opaque reader.
/// The single original plan producer validates these actual bytes before any
/// CAS insertion. Every insertion uses the existing idempotent object owner.
/// A cancellation/failure after insertion retains the objects for honest retry.
pub fn prepare_native_research_data_plan_from_observed_workspace_v1(
    request: &NativeResearchSourcePlanRequestV1,
    observed: &mut NativeResearchObservedInputsObservationV1<'_>,
    runtime: &NativeResearchSourceDataRuntimeV1<'_>,
) -> Result<PreparedNativeResearchSourceDataPlanV1, String> {
    observed.verify_unchanged()?;
    let (paper_id, task_key, selected) = task_binding(request)?;
    let paper_task_binding =
        NativeResearchObservedInputsObservationV1::derive_paper_task_binding_v1(
            &request.paper_task,
        )?;
    if runtime.paper_task_binding != paper_task_binding
        || observed.paper_task_binding_v1() != &paper_task_binding
        || runtime.paper_id != paper_id
        || runtime.task_key != task_key
        || runtime.source_root != selected
        || runtime.root != request.root
    {
        return Err(refusal());
    }
    runtime.directory.assert_current().map_err(|_| refusal())?;
    let objects = runtime.objects();
    let source = observed.source_snapshot_mut_v1()?;
    let (cancelled, deadline) = source.controls_v1();
    active(cancelled, deadline)?;
    if !std::ptr::eq(cancelled, runtime.cancelled) || deadline != runtime.deadline {
        return Err(refusal());
    }
    if source.source_root_v1() != selected
        || objects.root().starts_with(&selected)
        || selected.starts_with(objects.root())
    {
        return Err(refusal());
    }
    let merkle = source.snapshot()["sourceMerkle"]
        .as_str()
        .ok_or_else(refusal)?
        .parse::<Sha256Digest>()
        .map_err(|_| refusal())?;
    let plan_bytes =
        source.listed_member_bytes_v1(Path::new("RESEARCH_WORKER_PLAN.json"), MAX_PLAN_BYTES)?;
    active(cancelled, deadline)?;
    let source_objects =
        native_research_plan_source_bindings_v1(&plan_bytes, paper_id, task_key, cancelled)?;
    let mut actual = BTreeMap::new();
    let mut remaining = MAX_BYTES;
    for (path, expected) in &source_objects {
        active(cancelled, deadline)?;
        let bytes = source.listed_member_bytes_v1(Path::new(path), remaining.max(1))?;
        remaining = remaining
            .checked_sub(bytes.len() as u64)
            .ok_or_else(refusal)?;
        if digest(&bytes) != *expected {
            return Err("native_research_plan_actual_input_hash_mismatch".into());
        }
        actual.insert(path.clone(), bytes);
    }
    let cas_request = NativeResearchPlanRequestV1 {
        version: 1,
        paper_id: paper_id.to_owned(),
        task_key: task_key.to_owned(),
        plan_object: digest(&plan_bytes),
        source_objects,
    };
    let plan = prepare_native_research_data_plan_from_observed_v1(
        &cas_request,
        &plan_bytes,
        &actual,
        cancelled,
    )?;
    active(cancelled, deadline)?;
    observed.verify_unchanged()?;
    // Digest dedup happens before extra CAS calls. The real source path remains
    // bound in each job even if two paths contain identical immutable bytes.
    let mut inserted = BTreeSet::new();
    active(cancelled, deadline)?;
    if objects.put(&plan_bytes).map_err(|_| refusal())? != cas_request.plan_object {
        return Err(refusal());
    }
    inserted.insert(cas_request.plan_object.clone());
    for (path, bytes) in &actual {
        active(cancelled, deadline)?;
        let expected = cas_request.source_objects.get(path).ok_or_else(refusal)?;
        if inserted.insert(expected.clone())
            && objects.put(bytes).map_err(|_| refusal())? != *expected
        {
            return Err(refusal());
        }
    }
    observed.verify_unchanged()?;
    runtime.directory.assert_current().map_err(|_| refusal())?;
    active(cancelled, deadline)?;
    Ok(PreparedNativeResearchSourceDataPlanV1 {
        version: 1,
        source_root: selected,
        source_merkle: merkle,
        paper_task_binding,
        selected_source_members: actual.len() + 1,
        request: cas_request,
        plan,
    })
}
/// Queue the actual prepared data jobs through the original LocalWorkflow
/// kernel, at the selected normal runtime location. Arbitrary output overrides
/// refuse; a failure after creation retains the original unknown-runtime state.
pub fn initialize_native_research_source_data_workflow_v1(
    prepared: &PreparedNativeResearchSourceDataPlanV1,
    observed: &mut NativeResearchObservedInputsObservationV1<'_>,
    runtime: &NativeResearchSourceDataRuntimeV1<'_>,
    binding: NativeResearchDataWorkflowBindingV1,
) -> Result<Sha256Digest, String> {
    observed.verify_unchanged()?;
    if observed.paper_task_binding_v1() != &prepared.paper_task_binding
        || runtime.paper_task_binding != prepared.paper_task_binding
    {
        return Err(refusal());
    }
    let source = observed.source_snapshot_mut_v1()?;
    let (cancelled, deadline) = source.controls_v1();
    active(cancelled, deadline)?;
    if !std::ptr::eq(cancelled, runtime.cancelled)
        || deadline != runtime.deadline
        || prepared.request.paper_id != runtime.paper_id
        || prepared.request.task_key != runtime.task_key
        || prepared.source_root != runtime.source_root
        || source.source_root_v1() != prepared.source_root
        || source.snapshot()["sourceMerkle"].as_str() != Some(prepared.source_merkle.as_str())
        || binding.template.state_directory != runtime.workflow_directory
    {
        return Err(refusal());
    }
    runtime.directory.assert_current().map_err(|_| refusal())?;
    let result = initialize_native_research_data_workflow_v1(
        runtime.objects(),
        prepared.request.clone(),
        binding,
        cancelled,
    )?;
    observed.verify_unchanged()?;
    runtime.directory.assert_current().map_err(|_| refusal())?;
    active(cancelled, deadline)?;
    Ok(result)
}
#[cfg(test)]
mod tests;
