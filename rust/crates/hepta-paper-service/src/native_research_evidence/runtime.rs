//! Fixed ordinary runtime namespace; paths never confer scientific authority.
use super::*;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeResearchEvidenceRuntimeRequestV2 {
    pub version: u16,
    pub root: PathBuf,
    pub source_root: Option<PathBuf>,
    pub paper_task: Value,
}
/// Select the runtime using the existing ordinary frontend layout owner. The
/// caller cannot supply an external evidence directory or a trusted projection.
pub fn inspect_native_research_evidence_for_current_runtime_v2<'a>(
    request: NativeResearchEvidenceRuntimeRequestV2,
    c: &'a AtomicBool,
    deadline: Instant,
) -> Result<NativeResearchEvidenceObservationV1<'a>, String> {
    let mut context = NativeResearchReadContextV1::new(c, deadline);
    inspect_with_context(request, &mut context)
}
pub(super) fn inspect_with_context<'a>(
    request: NativeResearchEvidenceRuntimeRequestV2,
    context: &mut NativeResearchReadContextV1<'a>,
) -> Result<NativeResearchEvidenceObservationV1<'a>, String> {
    context.require_active()?;
    let result = (|| {
        if request.version != 2
            || !request.root.is_absolute()
            || request.root.as_os_str().len() > 4096
        {
            return Err(refused());
        }
        values_budget(std::iter::once(&request.paper_task))?;
        let id = paper_id(&request.paper_task)?;
        let runtime_root = crate::native_workspace::current_native_command_runtime_root_v1()?;
        if !runtime_root.is_absolute() || runtime_root.as_os_str().len() > 4096 {
            return Err(refused());
        }
        let log_root = request.root.join("logs/paperctl").join(id);
        let empirical_root = runtime_root.join("empirical-analysis").join(id);
        inspect_evidence(
            NativeResearchEvidenceRequestV1 {
                version: 1,
                root: request.root,
                source_root: request.source_root,
                log_root: Some(log_root),
                empirical_root: Some(empirical_root),
                paper_task: request.paper_task,
            },
            context,
            Some(runtime_root),
        )
    })();
    context.finish(result)
}
fn paper_id(task: &Value) -> Result<&str, String> {
    let id = task["paperId"].as_str().ok_or_else(refused)?;
    if id.is_empty()
        || id.len() > 256
        || id.contains('\\')
        || id.contains('\0')
        || Path::new(id).components().count() != 1
        || !Path::new(id)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(refused());
    }
    Ok(id)
}
// Display paths may contain '..' exactly as the original Node root-relative
// wire. They are never accepted as members for reads: the retained map below
// binds each display to an actual fixed, normal, held runtime member.
pub(super) fn display_path(root: &Path, absolute: &Path) -> Result<String, String> {
    if !root.is_absolute()
        || !absolute.is_absolute()
        || root.as_os_str().len() > 4096
        || absolute.as_os_str().len() > 4096
        || root
            .components()
            .chain(absolute.components())
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
    {
        return Err(refused());
    }
    let left: Vec<_> = root.components().collect();
    let right: Vec<_> = absolute.components().collect();
    let common = left.iter().zip(&right).take_while(|(a, b)| a == b).count();
    let mut relative = PathBuf::new();
    for _ in common..left.len() {
        relative.push("..");
    }
    for part in &right[common..] {
        relative.push(part.as_os_str());
    }
    let value = relative.to_str().ok_or_else(refused)?;
    if value.len() > 4096 {
        return Err(refused());
    }
    Ok(value.to_owned())
}
pub(super) struct RuntimeEvidenceSourceV2<'a> {
    pub(super) source: SourceObservation<'a>,
    directory: PathBuf,
    members: BTreeMap<String, PathBuf>,
}
impl<'a> RuntimeEvidenceSourceV2<'a> {
    pub(super) fn new(
        root: &Path,
        runtime: &Path,
        task: &Value,
        c: &'a AtomicBool,
        deadline: Instant,
    ) -> Result<Self, String> {
        let selected = runtime.join("empirical-analysis").join(paper_id(task)?);
        // Hold the existing common ancestor instead of opening an absent
        // runtime directory. inventory_probe owns the first genuine absence,
        // its parent namespace and every actual subsequent member.
        let common = root
            .ancestors()
            .find(|p| runtime.starts_with(p))
            .ok_or_else(refused)?;
        let mut source = SourceObservation::new_with_deadline(common, c, deadline)?;
        if source.root() != common {
            return Err(refused());
        }
        let directory = scope(common, &selected)?;
        source.inventory_probe(&directory)?;
        Ok(Self {
            source,
            directory,
            members: BTreeMap::new(),
        })
    }
    pub(super) fn records(
        &mut self,
        root: &Path,
        budget: &mut NativeResearchReadContextV1<'_>,
    ) -> Result<Vec<Value>, String> {
        budget.require_active()?;
        let mut records = Vec::new();
        if let Some(metadata) = self.source.inventory_probe(&self.directory)?
            && metadata.directory
        {
            let mut selected = Vec::new();
            walk(
                &mut self.source,
                &self.directory,
                0,
                &mut selected,
                budget.cancelled(),
            )?;
            for path in selected.into_iter().take(128) {
                let value = record(
                    &mut self.source,
                    &path,
                    &self.directory,
                    "empirical",
                    root,
                    budget,
                )?;
                let display = value["path"].as_str().ok_or_else(refused)?;
                if self.members.insert(display.to_owned(), path).is_some() {
                    return Err(refused());
                }
                records.push(value);
            }
        }
        self.verify_unchanged()?;
        Ok(records)
    }
    pub(super) fn member(&self, displayed: &Path) -> Result<Option<PathBuf>, String> {
        Ok(self
            .members
            .get(displayed.to_str().ok_or_else(refused)?)
            .cloned())
    }
    pub(super) fn verify_unchanged(&self) -> Result<(), String> {
        self.source.assert_current()
    }
}
