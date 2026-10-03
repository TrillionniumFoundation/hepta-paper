//! Fixed normal-status inputs composed from the existing held FD observer.
//! Parent names retain identity; namespaces are retained only for actual
//! missing-edge or directory observations, never as a lease on all of /tmp.
use super::*;
use crate::runtime_source_cas::observation::SharedInventoryReadBudgetV1;
use std::fs;

pub(super) struct InputMetadata {
    pub directory: bool,
    pub mode: u32,
    pub size: u64,
    pub link_count: u64,
}

pub(super) struct StatusInputs<'a> {
    scopes: BTreeMap<PathBuf, SourceObservation<'a>>,
    c: &'a AtomicBool,
    d: Instant,
    budget: SharedInventoryReadBudgetV1,
}
impl<'a> StatusInputs<'a> {
    #[cfg(test)]
    pub(super) fn with_prior_reservation(
        c: &'a AtomicBool,
        d: Instant,
        bytes: u64,
    ) -> Result<Self, String> {
        let mut value = Self::new(c, d)?;
        value.budget = SharedInventoryReadBudgetV1::with_prior_reservations(bytes);
        Ok(value)
    }
    pub(super) fn new(c: &'a AtomicBool, d: Instant) -> Result<Self, String> {
        check(c, d)?;
        Ok(Self {
            scopes: BTreeMap::new(),
            c,
            d,
            budget: SharedInventoryReadBudgetV1::new(),
        })
    }
    fn scope(&mut self, root: &Path) -> Result<&mut SourceObservation<'a>, String> {
        check(self.c, self.d)?;
        if !root.is_absolute() || root.as_os_str().len() > 4096 {
            return Err("advanced_numerical_plugin_path_limit_exceeded".into());
        }
        if !self.scopes.contains_key(root) {
            // The closed status graph has at most six documents, two local
            // roots, one entrypoint and 256 PATH candidates per fixed tool.
            if self.scopes.len() >= 1024 {
                return Err("advanced_numerical_plugin_input_scope_limit_exceeded".into());
            }
            let mut owner = SourceObservation::new_with_deadline(root, self.c, self.d)?;
            // The existing observer retains the resolved root and rechecks
            // the selected alias against it. Child traversal remains no-follow.
            self.budget.attach(&mut owner)?;
            self.scopes.insert(root.to_owned(), owner);
        }
        self.scopes
            .get_mut(root)
            .ok_or_else(|| "advanced_numerical_plugin_input_scope_invalid".into())
    }
    fn file_parts(path: &Path) -> Result<(&Path, &Path), String> {
        let parent = path
            .parent()
            .ok_or("advanced_numerical_plugin_input_path_invalid")?;
        let name = path
            .file_name()
            .ok_or("advanced_numerical_plugin_input_path_invalid")?;
        Ok((parent, Path::new(name)))
    }
    pub(super) fn probe(&mut self, path: &Path) -> Result<Option<InputMetadata>, String> {
        let (parent, name) = Self::file_parts(path)?;
        // Preserve the original first-missing-edge observer when a parent is
        // genuinely absent. No ENOTDIR, alias or permission error is absence.
        let metadata = match fs::symlink_metadata(parent) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let relative = path
                    .strip_prefix("/")
                    .map_err(|_| "advanced_numerical_plugin_input_path_invalid")?;
                self.scope(Path::new("/"))?.inventory_probe(relative)
            }
            _ => self.scope(parent)?.inventory_probe(name),
        }?;
        Ok(metadata.map(|meta| InputMetadata {
            directory: meta.directory,
            mode: meta.mode,
            size: meta.size,
            link_count: meta.link_count,
        }))
    }
    pub(super) fn document(&mut self, path: &Path, limit: u64) -> Result<Vec<u8>, String> {
        let (parent, name) = Self::file_parts(path)?;
        self.scope(parent)?.inventory_document(name, limit)
    }
    pub(super) fn archive(&mut self, path: &Path, limit: u64) -> Result<(String, u64), String> {
        let (parent, name) = Self::file_parts(path)?;
        self.scope(parent)?.archive(name, limit)
    }
    pub(super) fn directory(&mut self, path: &Path) -> Result<bool, String> {
        Ok(self
            .scope(path)?
            .inventory_probe(Path::new(""))?
            .is_some_and(|meta| meta.directory))
    }
    pub(super) fn assert_current(&self) -> Result<(), String> {
        check(self.c, self.d)?;
        for owner in self.scopes.values() {
            owner.require_control_context_v1(self.c, self.d)?;
            owner.assert_current()?;
        }
        check(self.c, self.d)
    }
    pub(super) fn require_control(&self, c: &AtomicBool, d: Instant) -> Result<(), String> {
        if !std::ptr::eq(self.c, c) || self.d != d {
            return Err("advanced_numerical_plugin_control_context_mismatch".into());
        }
        self.assert_current()
    }
}
