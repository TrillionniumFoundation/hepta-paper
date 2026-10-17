//! Dataset-reader inputs retain the incumbent CAS observer. One shared bounded
//! inventory covers the whole fixed read graph, including trust revocations.
use super::control_check;
use crate::runtime_source_cas::observation::{SharedInventoryReadBudgetV1, SourceObservation};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Instant,
};

pub(super) struct DatasetInputs<'a> {
    scopes: BTreeMap<PathBuf, SourceObservation<'a>>,
    budget: SharedInventoryReadBudgetV1,
    cancelled: &'a AtomicBool,
    deadline: Instant,
}
impl<'a> DatasetInputs<'a> {
    pub(super) fn cancelled(&self) -> &'a AtomicBool {
        self.cancelled
    }
    pub(super) fn deadline(&self) -> Instant {
        self.deadline
    }
    pub(super) fn new(cancelled: &'a AtomicBool, deadline: Instant) -> Result<Self, String> {
        control_check(cancelled, deadline)?;
        Ok(Self {
            scopes: BTreeMap::new(),
            budget: SharedInventoryReadBudgetV1::new(),
            cancelled,
            deadline,
        })
    }
    fn scope(&mut self, path: &Path) -> Result<&mut SourceObservation<'a>, String> {
        control_check(self.cancelled, self.deadline)?;
        if !path.is_absolute() || path.as_os_str().len() > 4096 {
            return Err("operator_dataset_input_path_domain_refused".into());
        }
        if !self.scopes.contains_key(path) {
            if self.scopes.len() >= 32 {
                return Err("operator_dataset_input_scope_limit_exceeded".into());
            }
            let mut owner =
                SourceObservation::new_with_deadline(path, self.cancelled, self.deadline)?;
            if owner.root() != path {
                return Err("operator_dataset_input_alias_domain_refused".into());
            }
            self.budget.attach(&mut owner)?;
            self.scopes.insert(path.to_owned(), owner);
        }
        self.scopes
            .get_mut(path)
            .ok_or_else(|| "operator_dataset_input_scope_invalid".into())
    }
    pub(super) fn require_directory(&mut self, path: &Path) -> Result<(), String> {
        if !self
            .scope(path)?
            .inventory_probe(Path::new(""))?
            .is_some_and(|metadata| metadata.directory)
        {
            return Err("operator_dataset_input_directory_required".into());
        }
        Ok(())
    }
    pub(super) fn document(
        &mut self,
        path: &Path,
        limit: u64,
        private: bool,
    ) -> Result<Option<Vec<u8>>, String> {
        control_check(self.cancelled, self.deadline)?;
        let parent = path.parent().ok_or("operator_dataset_input_path_invalid")?;
        let name = Path::new(
            path.file_name()
                .ok_or("operator_dataset_input_path_invalid")?,
        );
        let missing_parent = matches!(fs::symlink_metadata(parent),Err(error) if error.kind()==std::io::ErrorKind::NotFound);
        if missing_parent {
            let relative = path
                .strip_prefix("/")
                .map_err(|_| "operator_dataset_input_path_invalid")?;
            if self
                .scope(Path::new("/"))?
                .inventory_probe(relative)?
                .is_none()
            {
                return Ok(None);
            }
            return Err("operator_dataset_input_parent_changed".into());
        }
        let owner = self.scope(parent)?;
        if owner.inventory_probe(name)?.is_none() {
            return Ok(None);
        }
        if private {
            owner.inventory_private_document(name, limit).map(Some)
        } else {
            owner.inventory_document(name, limit).map(Some)
        }
    }
    pub(super) fn dataset_manifest(
        &mut self,
        source: &Path,
    ) -> Result<(String, Vec<(String, String)>), String> {
        self.require_directory(source)?;
        let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
            .map_err(|error| error.to_string())?;
        let mut todo = vec![PathBuf::new()];
        let mut files = Vec::new();
        let mut records = Vec::new();
        while let Some(relative) = todo.pop() {
            control_check(self.cancelled, self.deadline)?;
            if relative.components().count() > 32 {
                return Err("operator_dataset_tree_depth_limit_exceeded".into());
            }
            let mut children = self.scope(source)?.inventory_entries(&relative)?;
            children.sort_by(|left, right| collator.compare(&left.name, &right.name));
            // Schedule individual entries, rather than directories separately,
            // so files keep Node's complete locale-sorted depth-first order.
            let mut pending = Vec::new();
            for child in children {
                if child.symlink || (!child.regular && !child.directory) {
                    return Err("operator_dataset_worker_exposure_manifest_unreadable".into());
                }
                pending.push((relative.join(child.name), child.directory));
            }
            self.walk_entries(source, pending, &collator, &mut files, &mut records)?;
        }
        let bytes = records.join("\n").into_bytes();
        use sha2::{Digest, Sha256};
        self.assert_current(self.cancelled, self.deadline)?;
        Ok((
            format!("sha256:{}", hex::encode(Sha256::digest(bytes))),
            files,
        ))
    }
    fn walk_entries(
        &mut self,
        source: &Path,
        entries: Vec<(PathBuf, bool)>,
        collator: &hepta_legacy_compatibility::ProductionCollationV1,
        files: &mut Vec<(String, String)>,
        records: &mut Vec<String>,
    ) -> Result<(), String> {
        let mut todo = entries.into_iter().rev().collect::<Vec<_>>();
        while let Some((relative, directory)) = todo.pop() {
            control_check(self.cancelled, self.deadline)?;
            if relative.components().count() > 32 {
                return Err("operator_dataset_tree_depth_limit_exceeded".into());
            }
            if directory {
                let mut children = self.scope(source)?.inventory_entries(&relative)?;
                children.sort_by(|left, right| collator.compare(&left.name, &right.name));
                for child in children.into_iter().rev() {
                    if child.symlink || (!child.regular && !child.directory) {
                        return Err("operator_dataset_worker_exposure_manifest_unreadable".into());
                    }
                    todo.push((relative.join(child.name), child.directory));
                }
            } else {
                let (hash, _) = self.scope(source)?.archive(&relative, 1024 * 1024 * 1024)?;
                let name = relative
                    .to_str()
                    .ok_or("operator_dataset_input_path_invalid")?
                    .to_owned();
                records.push(format!(
                    "{name}\0{}",
                    hash.strip_prefix("sha256:")
                        .ok_or("operator_dataset_file_hash_invalid")?
                ));
                files.push((name, hash));
            }
        }
        Ok(())
    }
    pub(super) fn assert_current(
        &self,
        cancelled: &AtomicBool,
        deadline: Instant,
    ) -> Result<(), String> {
        if !std::ptr::eq(cancelled, self.cancelled) || deadline != self.deadline {
            return Err("operator_dataset_control_context_mismatch".into());
        }
        control_check(cancelled, deadline)?;
        for owner in self.scopes.values() {
            owner.require_control_context_v1(cancelled, deadline)?;
            owner.assert_current()?;
        }
        control_check(cancelled, deadline)
    }
}
