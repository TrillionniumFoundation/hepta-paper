//! Transient observation around an incumbent API that reopens a named file.
//! This witness does not change Directory admission or grant an exclusion.
use super::*;

pub(crate) struct DirectoryReopenEpochV1<'a> {
    directory: &'a Directory,
    metadata: Vec<fs::Metadata>,
}
fn exact(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.is_dir()
        && b.is_dir()
        && a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.mode() == b.mode()
        && a.nlink() == b.nlink()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
impl Directory {
    pub(crate) fn observe_reopen_epoch_v1(&self) -> Result<DirectoryReopenEpochV1<'_>> {
        self.assert_current()?;
        ensure(
            self.parents.len() <= 4096,
            "autonomous_research_state_backup_publication_path_invalid",
        )?;
        let mut metadata = Vec::with_capacity(self.parents.len() + 1);
        for (path, held) in self
            .parents
            .iter()
            .map(|(p, f)| (p, f))
            .chain(std::iter::once((&self.path, &self.held)))
        {
            let captured = held.metadata().map_err(|_| failure())?;
            let named = fs::symlink_metadata(path).map_err(|_| failure())?;
            ensure(
                exact(&captured, &named),
                "autonomous_research_state_backup_publication_path_changed_or_unsafe",
            )?;
            metadata.push(captured);
        }
        let witness = DirectoryReopenEpochV1 {
            directory: self,
            metadata,
        };
        witness.assert_current()?;
        Ok(witness)
    }
}
impl DirectoryReopenEpochV1<'_> {
    pub(crate) fn assert_current(&self) -> Result<()> {
        self.directory.assert_current()?;
        for ((path, held), captured) in self
            .directory
            .parents
            .iter()
            .map(|(p, f)| (p, f))
            .chain(std::iter::once((
                &self.directory.path,
                &self.directory.held,
            )))
            .zip(&self.metadata)
        {
            let current = held.metadata().map_err(|_| failure())?;
            let named = fs::symlink_metadata(path).map_err(|_| failure())?;
            ensure(
                exact(captured, &current) && exact(&current, &named),
                "autonomous_research_state_backup_publication_path_changed_or_unsafe",
            )?;
        }
        Ok(())
    }
}
