use super::*;
use crate::{
    native_inventory::NativeInventoryObservationV1,
    native_research_evidence::NativeResearchObservedInputsObservationV1,
    native_research_source_plan::NativeResearchSourceDataRuntimeV1,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};
/// The actual inventory and input witnesses remain owned until queue admission.
/// Serialized JSON cannot construct this prepared subject.
pub struct PreparedNativeResearchCasAssessmentV1<'a, 'b> {
    pub(super) observation:
        crate::native_research_assessment::NativeResearchAssessmentObservationV1<'a, 'b>,
    request: NativeResearchCasAssessmentRequestV1,
}
impl PreparedNativeResearchCasAssessmentV1<'_, '_> {
    pub fn request(&self) -> &NativeResearchCasAssessmentRequestV1 {
        &self.request
    }
    pub fn verify_unchanged(&self) -> Result<(), String> {
        self.observation.verify_unchanged()
    }
    pub fn job(&self) -> crate::NativeJobV1 {
        crate::NativeJobV1::Business {
            job: crate::native_business::NativeBusinessJobV1::ResearchObservedAssessmentFromCasV1 {
                request: self.request.clone(),
            },
        }
    }
}
/// Capture only source members admitted by the actual held inventory/input
/// owners. No caller row, structured record, verification flag or path is input.
pub fn prepare_native_research_cas_assessment_for_inventory_row_v1<'a, 'b>(
    inventory: &'b NativeInventoryObservationV1<'a>,
    paper_id: &str,
    runtime: &NativeResearchSourceDataRuntimeV1<'a>,
    c: &'a AtomicBool,
    deadline: Instant,
) -> Result<PreparedNativeResearchCasAssessmentV1<'a, 'b>, String> {
    check(c, deadline)?;
    let mut observation = super::super::inspect_native_research_assessment_for_inventory_row_v1(
        inventory, paper_id, c, deadline,
    )?;
    let row = inventory.scan()["rows"]
        .as_array()
        .ok_or_else(refused)?
        .iter()
        .find(|row| row["task"]["paperId"].as_str() == Some(paper_id))
        .ok_or_else(refused)?;
    let root = inventory.scan()["root"].as_str().ok_or_else(refused)?;
    let source_root = row["sourceDir"].as_str().ok_or_else(refused)?;
    runtime.require_observed_task_v1(
        Path::new(root),
        &row["task"],
        Path::new(source_root),
        c,
        deadline,
    )?;
    let task_binding =
        NativeResearchObservedInputsObservationV1::derive_paper_task_binding_v1(&row["task"])?;
    if observation.inputs.paper_task_binding_v1() != &task_binding {
        return Err(refused());
    }
    let evidence = &observation.inputs.observed()["evidence"];
    let source_records = evidence["evidenceRecords"].as_array().ok_or_else(refused)?;
    if source_records.len() > 96
        || evidence["proposalSeedEvidence"]
            .as_array()
            .is_none_or(|v| !v.is_empty())
    {
        return Err(refused());
    }
    reserve(
        [row, &evidence["structured"], &evidence["structured"]]
            .into_iter()
            .chain(source_records)
            .chain(source_records),
        0,
        0,
    )?;
    let mut records = Vec::new();
    for record in source_records {
        check(c, deadline)?;
        let object = record.as_object().ok_or_else(refused)?;
        if object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "role"
                    | "path"
                    | "filename"
                    | "sizeBytes"
                    | "mtimeMs"
                    | "hash"
                    | "scopedFileReadReceiptHash"
            )
        }) {
            return Err(refused());
        }
        let name = record["path"].as_str().ok_or_else(refused)?;
        let absolute = Path::new(root).join(relative(name)?);
        let selected = absolute
            .strip_prefix(Path::new(source_root))
            .map_err(|_| refused())?;
        relative(selected.to_str().ok_or_else(refused)?)?;
        // Original FS receipt hashes never enter the CAS integrity domain.
        let mut value = record.clone();
        value
            .as_object_mut()
            .ok_or_else(refused)?
            .remove("scopedFileReadReceiptHash");
        records.push(value);
    }
    let structured = evidence["structured"].clone();
    let source = observation.inputs.source_snapshot_mut_v1()?;
    let snapshot = source.snapshot();
    let members = snapshot["workspaceSnapshot"]["fileRecords"]
        .as_array()
        .ok_or_else(refused)?;
    if members.len() > MAX_FILES {
        return Err(refused());
    }
    reserve(
        [row, snapshot, snapshot]
            .into_iter()
            .chain(&records)
            .chain(&records)
            .chain(
                members
                    .iter()
                    .flat_map(|v| [&v["path"], &v["hash"], &v["bytes"], &v["path"]]),
            ),
        members.len() * 4,
        members.len().saturating_mul(19).saturating_add(8192),
    )?;
    let selected = members
        .iter()
        .map(|record| {
            let name = record["path"].as_str().ok_or_else(refused)?;
            relative(name)?;
            let object = record["hash"]
                .as_str()
                .ok_or_else(refused)?
                .parse()
                .map_err(|_| refused())?;
            let bytes = record["bytes"].as_u64().ok_or_else(refused)?;
            Ok(SourceFile {
                relative: name.into(),
                object,
                bytes,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let snapshot = source.snapshot().clone();
    let mut remaining = MAX_RAW;
    let mut raw = BTreeMap::new();
    let mut actual = BTreeMap::new();
    for file in &selected {
        check(c, deadline)?;
        if actual.contains_key(&file.relative) || file.bytes > remaining {
            return Err(refused());
        }
        let bytes = source.listed_member_bytes_v1(relative(&file.relative)?, remaining.max(1))?;
        if bytes.len() as u64 != file.bytes || sha(&bytes) != file.object {
            return Err(refused());
        }
        remaining -= file.bytes;
        // One immutable copy is retained; record parsing borrows it below.
        actual.insert(file.relative.clone(), bytes);
    }
    for record in &records {
        check(c, deadline)?;
        let name = record["path"].as_str().ok_or_else(refused)?;
        let absolute = Path::new(root).join(relative(name)?);
        let member = absolute
            .strip_prefix(source_root)
            .map_err(|_| refused())?
            .to_str()
            .ok_or_else(refused)?;
        let bytes = actual.get(member).ok_or_else(refused)?;
        // Parsing at most 96 original records has a separately bounded 4Mi copy.
        raw.insert(name.to_owned(), bytes.as_slice());
    }
    let extracted = crate::native_research_evidence::extract_native_research_record_bytes_v1(
        &records, &raw, c, deadline,
    )?;
    if extracted != structured {
        return Err("native_research_cas_source_only_extraction_domain_refused".into());
    }
    drop(raw);
    let manifest = CapturedManifest {
        version: 1,
        kind: "NativeCapturedResearchSourceManifest".into(),
        row: row.clone(),
        task_binding,
        implementation_hash: crate::native_business::native_business_implementation_hash_v1(),
        display_inventory_root: root.into(),
        display_source_root: source_root.into(),
        source_snapshot: snapshot,
        files: selected,
        records,
    };
    let bytes = serde_json::to_vec(&manifest).map_err(|_| refused())?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err(refused());
    }
    observation.verify_unchanged()?;
    let objects = runtime.objects();
    let mut inserted = BTreeSet::new();
    for file in &manifest.files {
        check(c, deadline)?;
        if inserted.insert(&file.object)
            && objects
                .put(actual.get(&file.relative).ok_or_else(refused)?)
                .map_err(|_| refused())?
                != file.object
        {
            return Err(refused());
        }
    }
    let manifest_object = objects.put(&bytes).map_err(|_| refused())?;
    if manifest_object != sha(&bytes) {
        return Err(refused());
    }
    observation.verify_unchanged()?;
    runtime.require_observed_task_v1(
        &PathBuf::from(root),
        &row["task"],
        Path::new(source_root),
        c,
        deadline,
    )?;
    Ok(PreparedNativeResearchCasAssessmentV1 {
        observation,
        request: NativeResearchCasAssessmentRequestV1 {
            version: 1,
            manifest_object,
        },
    })
}
