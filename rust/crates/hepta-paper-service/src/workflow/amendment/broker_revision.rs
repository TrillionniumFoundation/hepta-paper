//! A bounded broker manuscript revision in the existing amendment owner.
//! This binds role requests and CAS inputs; it does not certify scientific
//! independence, sign capabilities, settle provider cost or activate a writer.
use super::*;
use crate::broker_prepared::{BrokerPreparedInputV1, BrokerPreparedSourceV1};
use hepta_codex_protocol::{AgentRole, TaskKind};

fn broker_input<'a>(
    definition: &'a LocalWorkflowV1,
    step: &WorkflowStepV1,
) -> Result<(&'a BrokerPreparedSourceV1, BrokerPreparedInputV1), WorkflowError> {
    let job: NativeJobV1 =
        serde_json::from_value(step.job_template.clone()).map_err(|_| WorkflowError::Definition)?;
    match (definition.template.workers.get(&step.module_id), job) {
        (Some(WorkerBindingV1::BrokerExecute { source }), NativeJobV1::BrokerExecute { input })
        | (
            Some(WorkerBindingV1::BrokerPrepared { source }),
            NativeJobV1::BrokerPrepared { input },
        ) if input.version == 1 => Ok((source, input)),
        _ => Err(WorkflowError::Definition),
    }
}

fn binding(step: &WorkflowStepV1, from: &str, field: &str, encoding: ArtifactEncodingV1) -> bool {
    let pointer = format!("/input/inputManifest/{field}");
    step.bindings.iter().any(|item| {
        item.from_step == from
            && item.artifact_index == 0
            && item.artifact_name.is_none()
            && item.target_pointer == pointer
            && matches!(
                (item.encoding, encoding),
                (ArtifactEncodingV1::Utf8, ArtifactEncodingV1::Utf8)
                    | (ArtifactEncodingV1::Digest, ArtifactEncodingV1::Digest)
            )
    })
}

fn manifest_shape(input: &BrokerPreparedInputV1, kind: &str, fields: &[&str]) -> bool {
    let Some(manifest) = input.input_manifest.as_object() else {
        return false;
    };
    manifest.len() == fields.len() + 2
        && manifest.get("version") == Some(&Value::from(1))
        && manifest.get("kind") == Some(&Value::from(kind))
        && fields.iter().all(|name| manifest.contains_key(*name))
}

/// Only explicit V1 manuscript manifests are admitted as repair contracts.
/// The ordinary broker still verifies each separately supplied signed request.
pub(super) fn validate(
    old: &LocalWorkflowV1,
    next: &LocalWorkflowV1,
    committed: usize,
) -> Result<(), WorkflowError> {
    let rejected = &old.steps[committed - 1];
    let author = &next.steps[committed];
    let reviewer = &next.steps[committed + 1];
    let original_gate = rejected.gate.as_ref().ok_or(WorkflowError::Definition)?;
    let review_gate = reviewer.gate.as_ref().ok_or(WorkflowError::Definition)?;
    let original_author = old.steps[..committed - 1]
        .iter()
        .find(|step| step.id == original_gate.subject_step)
        .ok_or(WorkflowError::Definition)?;
    let (old_author_source, old_author_input) = broker_input(old, original_author)?;
    let (author_source, author_input) = broker_input(next, author)?;
    let (review_source, review_input) = broker_input(old, rejected)?;
    let (_, next_review_input) = broker_input(next, reviewer)?;
    if original_author.capability_id != "CAP-AUTHOR"
        || rejected.capability_id != "CAP-REVIEW"
        || author.capability_id != "CAP-AUTHOR"
        || reviewer.capability_id != "CAP-REVIEW"
        || old_author_source.role != AgentRole::Author
        || author_source.role != AgentRole::Author
        || review_source.role != AgentRole::Reviewer
        || !matches!(
            old_author_input.task_kind,
            TaskKind::Draft | TaskKind::Revise
        )
        || author_input.task_kind != TaskKind::Revise
        || review_input.task_kind != TaskKind::Review
        || next_review_input.task_kind != TaskKind::Review
        || author.module_id != original_author.module_id
        || reviewer.module_id != rejected.module_id
        || author_source.socket_path == review_source.socket_path
        || author.gate.is_some()
        || author_input.output_schema_hash != old_author_input.output_schema_hash
        || author_input.workspace_identity_hash != old_author_input.workspace_identity_hash
        || author_input.mutation_policy_hash != old_author_input.mutation_policy_hash
        || reviewer.job_template != rejected.job_template
        || bytes(&reviewer.resources)? != bytes(&rejected.resources)?
        || reviewer.cost_microusd != rejected.cost_microusd
        || original_gate.accepted_pointer != "/accepted"
        || original_gate.subject_hash_pointer != "/manuscriptHash"
        || original_gate.subject_artifact_index != 0
        || review_gate.accepted_pointer != original_gate.accepted_pointer
        || review_gate.subject_hash_pointer != original_gate.subject_hash_pointer
        || review_gate.subject_step != author.id
        || review_gate.subject_artifact_index != 0
        || !manifest_shape(
            &review_input,
            "ManuscriptReviewInputV1",
            &["manuscript", "manuscriptHash", "policy"],
        )
        || !manifest_shape(
            &author_input,
            "ManuscriptRevisionInputV1",
            &[
                "previousManuscript",
                "previousManuscriptHash",
                "review",
                "reviewHash",
                "instructions",
            ],
        )
        || !author_input.input_manifest["instructions"].is_string()
        || rejected.bindings.len() != 2
        || reviewer.bindings.len() != 2
        || author.bindings.len() != 4
        || !binding(
            rejected,
            &original_author.id,
            "manuscript",
            ArtifactEncodingV1::Utf8,
        )
        || !binding(
            rejected,
            &original_author.id,
            "manuscriptHash",
            ArtifactEncodingV1::Digest,
        )
        || !binding(reviewer, &author.id, "manuscript", ArtifactEncodingV1::Utf8)
        || !binding(
            reviewer,
            &author.id,
            "manuscriptHash",
            ArtifactEncodingV1::Digest,
        )
        || !binding(
            author,
            &original_author.id,
            "previousManuscript",
            ArtifactEncodingV1::Utf8,
        )
        || !binding(
            author,
            &original_author.id,
            "previousManuscriptHash",
            ArtifactEncodingV1::Digest,
        )
        || !binding(author, &rejected.id, "review", ArtifactEncodingV1::Utf8)
        || !binding(
            author,
            &rejected.id,
            "reviewHash",
            ArtifactEncodingV1::Digest,
        )
    {
        return Err(WorkflowError::Definition);
    }
    Ok(())
}
