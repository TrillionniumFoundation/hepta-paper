//! Owning read-only CLI adapter. Namespace observations identify the named
//! source before/after a logical SQLite snapshot; they are not a live writer,
//! stopped-service, key-custody or connection-provenance capability.
use super::Options;
use crate::{
    local_state_authority::{
        migration::{LegacyAuthorityJournalVerifierV1, OfflineNativeAuthorityImageV1},
        storage::Ancestors,
    },
    sqlite_mutation_coordinator::{Result, error},
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
    time::Duration,
};

pub(super) struct SourceResult {
    pub(super) report: Value,
    pub(super) image: Option<OfflineNativeAuthorityImageV1>,
    pub(super) protected_paths: Vec<PathBuf>,
}

struct NamedFile {
    path: PathBuf,
    before: Option<fs::Metadata>,
}
impl NamedFile {
    fn metadata(path: &Path) -> Result<Option<fs::Metadata>> {
        match fs::symlink_metadata(path) {
            Ok(value) if value.is_file() && !value.is_symlink() && value.nlink() == 1 => {
                Ok(Some(value))
            }
            Ok(_) => Err(error("local_authority_journal_source_file_invalid")),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(error("local_authority_journal_source_file_unavailable")),
        }
    }
    fn capture(path: PathBuf, required: bool) -> Result<Self> {
        let before = Self::metadata(&path)?;
        if required && before.is_none() {
            return Err(error("local_authority_journal_source_missing"));
        }
        Ok(Self { path, before })
    }
    fn current(&self) -> Result<()> {
        let after = Self::metadata(&self.path)?;
        if let Some(before) = &self.before {
            let after =
                after.ok_or_else(|| error("local_authority_journal_source_namespace_changed"))?;
            if before.dev() != after.dev()
                || before.ino() != after.ino()
                || before.uid() != after.uid()
                || before.gid() != after.gid()
                || before.mode() != after.mode()
            {
                return Err(error("local_authority_journal_source_namespace_changed"));
            }
        }
        Ok(())
    }
}

fn canonical_name(path: &Path) -> bool {
    path.is_absolute()
        && path.to_str().is_some_and(|name| {
            !name.contains('\0')
                && !name.contains("//")
                && !name.ends_with('/')
                && !name.split('/').any(|part| part == "." || part == "..")
        })
        && path
            .components()
            .all(|part| matches!(part, Component::RootDir | Component::Normal(_)))
}

pub(super) fn read_source(options: &Options, export: bool) -> Result<SourceResult> {
    for path in [&options.daemon_configuration, &options.online_configuration] {
        if !canonical_name(path) {
            return Err(error("local_authority_journal_configuration_path_invalid"));
        }
    }
    // All regular-file pin descriptors are loaded before SQLite and retained
    // until after its explicit close, including every failure path below.
    let verifier = LegacyAuthorityJournalVerifierV1::load(
        &options.daemon_configuration,
        &options.daemon_hash,
        &options.online_configuration,
        &options.online_hash,
    )?;
    let path = verifier.source_database_path()?.to_path_buf();
    if !canonical_name(&path) {
        return Err(error("local_authority_journal_source_path_invalid"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| error("local_authority_journal_source_path_invalid"))?;
    let ancestors = Ancestors::capture(parent)?;
    let main = NamedFile::capture(path.clone(), true)?;
    let sidecars = ["-wal", "-shm", "-journal"]
        .into_iter()
        .map(|suffix| {
            NamedFile::capture(PathBuf::from(format!("{}{suffix}", path.display())), false)
        })
        .collect::<Result<Vec<_>>>()?;
    ancestors.assert_current()?;
    main.current()?;
    for sidecar in &sidecars {
        sidecar.current()?;
    }
    let protected_paths = verifier.protected_input_paths()?;
    let db = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NOFOLLOW
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let observed = (|| -> Result<_> {
        db.busy_timeout(Duration::from_secs(5))?;
        db.pragma_update(None, "query_only", true)?;
        db.execute_batch("BEGIN DEFERRED")?;
        // Establish the actual main snapshot before the borrowed inspector.
        db.query_row("SELECT count(*) FROM main.sqlite_schema", [], |row| {
            row.get::<_, i64>(0)
        })?;
        ancestors.assert_current()?;
        main.current()?;
        for sidecar in &sidecars {
            sidecar.current()?;
        }
        let (history, image) = if export {
            let image = verifier.build_offline_native_image(&db)?;
            (image.report()["sourceHistory"].clone(), Some(image))
        } else {
            (verifier.inspect(&db)?, None)
        };
        verifier.current()?;
        ancestors.assert_current()?;
        main.current()?;
        for sidecar in &sidecars {
            sidecar.current()?;
        }
        Ok((history, image))
    })();
    let rollback = if db.is_autocommit() {
        Ok(())
    } else {
        db.execute_batch("ROLLBACK")
    };
    // Close is an explicit barrier before the returned image may reach the
    // filesystem publisher. Drop any failed close's returned connection before
    // the retained public-input verifier leaves this function.
    let close = db.close();
    if let Err((connection, cause)) = close {
        drop(connection);
        let mut failure = error("local_authority_journal_source_close_failed");
        failure.details = json!({"publicationCommitted":false,"sqliteError":cause.to_string()});
        return Err(failure);
    }
    rollback?;
    let (history, image) = observed?;
    verifier.current()?;
    ancestors.assert_current()?;
    main.current()?;
    let before = main
        .before
        .as_ref()
        .ok_or_else(|| error("local_authority_journal_source_missing"))?;
    let report = json!({
        "version":1,"kind":"HeptaLocalStateAuthorityNamedJournalObservationV1",
        "evidenceScope":"named_source_snapshot_no_maintenance_authority",
        "sourcePath":path,"sourceConnectionClosed":true,"sourceLogicalDataWritten":false,
        "namespaceObservation":{"device":before.dev(),"inode":before.ino(),"uid":before.uid(),"gid":before.gid(),"mode":before.mode()},
        "history":history,
    });
    Ok(SourceResult {
        report,
        image,
        protected_paths,
    })
}

#[cfg(test)]
mod tests;
