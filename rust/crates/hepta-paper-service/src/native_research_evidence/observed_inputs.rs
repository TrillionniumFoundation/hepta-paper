//! Source/evidence/candidate/integrity composition. This prepares observed data
//! for the existing research pipeline; it grants no scientific authority.
use super::*;
use crate::native_research_source::{
    NativeResearchSourceSnapshotObservationV1, NativeResearchSourceSnapshotRequestV1,
    inspect_native_research_source_snapshot_with_context_v1,
};
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResearchObservedInputsRequestV1 {
    pub version: u16,
    pub root: PathBuf,
    pub source_root: Option<PathBuf>,
    pub paper_task: Value,
}
pub struct NativeResearchObservedInputsObservationV1<'a> {
    snapshot: Option<NativeResearchSourceSnapshotObservationV1<'a>>,
    evidence: NativeResearchEvidenceObservationV1<'a>,
    verification: NativeEvidenceArtifactVerificationObservationV1<'a>,
    observed: Value,
    paper_task_binding: hepta_codex_protocol::Sha256Digest,
}
impl<'a> NativeResearchObservedInputsObservationV1<'a> {
    pub fn observed(&self) -> &Value {
        &self.observed
    }
    pub(crate) fn derive_paper_task_binding_v1(
        paper_task: &Value,
    ) -> Result<hepta_codex_protocol::Sha256Digest, String> {
        // The existing borrowed budget precedes the existing Node-compatible
        // record hash. The subject is derived internally, never caller supplied.
        values_budget(std::iter::once(paper_task))?;
        hepta_legacy_compatibility::production_hash_record_v1(
            "NativeResearchObservedPaperTaskSubjectV1",
            paper_task,
        )
        .map_err(|_| refused())?
        .as_str()
        .parse()
        .map_err(|_| refused())
    }
    pub(crate) fn paper_task_binding_v1(&self) -> &hepta_codex_protocol::Sha256Digest {
        &self.paper_task_binding
    }
    pub(crate) fn source_snapshot_mut_v1(
        &mut self,
    ) -> Result<&mut NativeResearchSourceSnapshotObservationV1<'a>, String> {
        self.snapshot.as_mut().ok_or_else(refused)
    }
    pub fn verify_unchanged(&self) -> Result<(), String> {
        if let Some(snapshot) = &self.snapshot {
            snapshot.verify_unchanged()?;
        }
        self.evidence.verify_unchanged()?;
        self.verification.verify_unchanged()
    }
}
pub fn inspect_native_research_observed_inputs_v1<'a>(
    request: NativeResearchObservedInputsRequestV1,
    c: &'a AtomicBool,
    deadline: Instant,
) -> Result<NativeResearchObservedInputsObservationV1<'a>, String> {
    let mut context = NativeResearchReadContextV1::new(c, deadline);
    let now_millis = crate::sqlite_mutation_coordinator::clock::MutationClockV1::now_millis(
        &mut crate::sqlite_mutation_coordinator::clock::SystemMutationClockV1,
    )
    .map_err(|_| refused())?;
    inspect_with_context(&request, &mut context, now_millis, &mut || {
        let millis = crate::sqlite_mutation_coordinator::clock::MutationClockV1::now_millis(
            &mut crate::sqlite_mutation_coordinator::clock::SystemMutationClockV1,
        )
        .map_err(|_| refused())?;
        crate::sqlite_mutation_coordinator::clock::iso(millis).map_err(|_| refused())
    })
}
pub(super) fn inspect_with_context<'a>(
    request: &NativeResearchObservedInputsRequestV1,
    context: &mut NativeResearchReadContextV1<'a>,
    now_millis: i64,
    clock: &mut impl FnMut() -> Result<String, String>,
) -> Result<NativeResearchObservedInputsObservationV1<'a>, String> {
    context.require_active()?;
    let result = (|| {
        if request.version != 1
            || !request.root.is_absolute()
            || request.root.as_os_str().len() > 4096
            || request
                .source_root
                .as_ref()
                .is_some_and(|p| !p.is_absolute() || p.as_os_str().len() > 4096)
        {
            return Err(refused());
        }
        let paper_task_binding =
            NativeResearchObservedInputsObservationV1::derive_paper_task_binding_v1(
                &request.paper_task,
            )?;
        // Every phase shares the same aggregate, parser control, cancellation
        // and absolute deadline. Duplicate actual members are charged once.
        let snapshot = if let Some(root) = &request.source_root {
            Some(inspect_native_research_source_snapshot_with_context_v1(
                NativeResearchSourceSnapshotRequestV1 {
                    version: 1,
                    source_root: root.clone(),
                },
                context,
            )?)
        } else {
            None
        };
        let evidence = runtime::inspect_with_context(
            NativeResearchEvidenceRuntimeRequestV2 {
                version: 2,
                root: request.root.clone(),
                source_root: request.source_root.clone(),
                paper_task: request.paper_task.clone(),
            },
            context,
        )?;
        let candidates = build_native_evidence_verification_candidates_v1(
            &request.root,
            request.source_root.as_deref(),
            &evidence.observed()["structured"],
            context.cancelled(),
            context.deadline(),
        )?;
        let verification = verification::verify_with_context(
            &NativeEvidenceArtifactVerificationRequestV1 {
                version: 1,
                source_root: request.source_root.clone(),
                evidence_items: candidates.clone(),
                expected_source_snapshot_hash: None,
            },
            context,
            clock,
        )?;
        let intake = build_native_research_evidence_intake_v1(
            &request.paper_task,
            &evidence.observed()["structured"],
            &verification,
            now_millis,
            context.cancelled(),
            context.deadline(),
        )?;
        let empty = Value::Null;
        let snapshot_value = snapshot.as_ref().map(|v| v.snapshot()).unwrap_or(&empty);
        projected_budget(
            std::iter::once(snapshot_value)
                .chain(std::iter::once(evidence.observed()))
                .chain(candidates.iter())
                .chain(verification.receipts().iter())
                .chain([&intake]),
            16,
            1024,
        )?;
        let observed = json!({"sourceSnapshot":snapshot_value,"evidence":evidence.observed(),"verificationCandidates":candidates,"evidenceVerificationReceipts":verification.receipts(),"evidenceIntake":intake});
        let output = NativeResearchObservedInputsObservationV1 {
            snapshot,
            evidence,
            verification,
            observed,
            paper_task_binding,
        };
        output.verify_unchanged()?;
        context.require_active()?;
        Ok(output)
    })();
    context.finish(result)
}
