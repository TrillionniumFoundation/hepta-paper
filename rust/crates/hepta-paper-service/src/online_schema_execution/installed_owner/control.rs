//! No-replace handoff from verified finalized control to root-owned execution
//! control. Original Node bytes, metadata and complete history remain below the
//! persistent root-only maintenance barrier for review and recovery.
use super::*;
use crate::{
    online_schema_execution::cli::ControlGuard,
    sqlite_mutation_coordinator::{authority::files::Snapshot, hash_bytes, keys},
    state_recoverability::publication::{Directory, publish_receipt},
};
use nix::{
    fcntl::{OFlag, RenameFlags, openat, renameat2},
    sys::stat::Mode,
};
use serde_json::Value;
use std::{
    fs,
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::Path,
};
const RECORD: &str = "PREDECESSOR_CONTROL.v1.json";
const ARCHIVE: &str = "predecessor-control";
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_installed_schema_control_preimage_invalid_or_changed")
}
fn metadata(path: &Path) -> Result<Value> {
    let m = fs::symlink_metadata(path).map_err(|_| invalid())?;
    if !m.is_dir() || m.is_symlink() || m.mode() & 0o022 != 0 {
        return Err(invalid());
    }
    Ok(json!({"device":m.dev(),"inode":m.ino(),"uid":m.uid(),"gid":m.gid(),"mode":m.mode()}))
}
fn control_tree_hash(path: &Path) -> Result<String> {
    let root = fs::File::from(
        nix::fcntl::open(
            path,
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| invalid())?,
    );
    let mut rows = Vec::new();
    let mut bytes = 0u64;
    tree(&root, path, "", 0, &mut rows, &mut bytes)?;
    crate::sqlite_mutation_coordinator::hash(
        "HeptaInstalledSchemaControlPreimageTreeV1",
        &json!(rows),
    )
}
fn tree(
    directory: &fs::File,
    path: &Path,
    relative: &str,
    depth: usize,
    rows: &mut Vec<Value>,
    total: &mut u64,
) -> Result<()> {
    if depth > 8 || rows.len() > 4096 {
        return Err(invalid());
    }
    let before = directory.metadata().map_err(|_| invalid())?;
    let stable = |a: &fs::Metadata, b: &fs::Metadata| {
        a.dev() == b.dev()
            && a.ino() == b.ino()
            && a.mode() == b.mode()
            && a.uid() == b.uid()
            && a.gid() == b.gid()
            && a.nlink() == b.nlink()
            && a.len() == b.len()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec()
    };
    if !before.is_dir() || before.mode() & 0o022 != 0 {
        return Err(invalid());
    }
    rows.push(json!({"path":relative,"directory":true,"device":before.dev(),"inode":before.ino(),"uid":before.uid(),"gid":before.gid(),"mode":before.mode()}));
    let entries = fs::read_dir(path)
        .map_err(|_| invalid())?
        .take(4097)
        .map(|entry| entry.map(|e| e.file_name()).map_err(|_| invalid()))
        .collect::<Result<Vec<_>>>()?;
    if entries.len() > 4096 {
        return Err(invalid());
    }
    let mut entries = entries;
    entries.sort();
    for name in entries {
        if rows.len() >= 4096 {
            return Err(invalid());
        }
        let held = fs::File::from(
            openat(
                directory.as_fd(),
                Path::new(&name),
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| invalid())?,
        );
        let observed = held.metadata().map_err(|_| invalid())?;
        let selected = path.join(&name);
        let name = name.to_str().ok_or_else(invalid)?;
        let child = if relative.is_empty() {
            name.to_owned()
        } else {
            format!("{relative}/{name}")
        };
        if observed.is_dir() {
            tree(&held, &selected, &child, depth + 1, rows, total)?;
        } else {
            const MAXIMUM: u64 =
                crate::state_database_inventory::schema_source::MAX_SCHEMA_SOURCE_FILE_BYTES;
            *total = total
                .checked_add(observed.len())
                .filter(|value| *value <= 2 * 1024 * 1024 * 1024)
                .ok_or_else(invalid)?;
            if !observed.is_file()
                || observed.nlink() != 1
                || observed.uid() != before.uid()
                || observed.mode() & 0o022 != 0
                || observed.len() > MAXIMUM
            {
                return Err(invalid());
            }
            let mut contents = Vec::new();
            let mut read = &held;
            (&mut read)
                .take(MAXIMUM + 1)
                .read_to_end(&mut contents)
                .map_err(|_| invalid())?;
            if contents.len() as u64 != observed.len() {
                return Err(invalid());
            }
            rows.push(json!({"path":child,"directory":false,"device":observed.dev(),"inode":observed.ino(),"uid":observed.uid(),"gid":observed.gid(),"mode":observed.mode(),"byteLength":observed.len(),"sha256":hash_bytes(&contents)}));
        }
        let named = fs::symlink_metadata(&selected).map_err(|_| invalid())?;
        if !stable(&observed, &held.metadata().map_err(|_| invalid())?)
            || !stable(&observed, &named)
        {
            return Err(invalid());
        }
    }
    if !stable(&before, &directory.metadata().map_err(|_| invalid())?)
        || !stable(&before, &fs::symlink_metadata(path).map_err(|_| invalid())?)
    {
        return Err(invalid());
    }
    Ok(())
}
fn retained_archive_receipt(
    directory: &Directory,
    expected_metadata: &Value,
    pin: &str,
) -> Result<()> {
    let archive = fs::File::from(
        openat(
            directory.held.as_fd(),
            Path::new(ARCHIVE),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| invalid())?,
    );
    let observed = archive.metadata().map_err(|_| invalid())?;
    let archive_metadata = json!({"device":observed.dev(),"inode":observed.ino(),"uid":observed.uid(),"gid":observed.gid(),"mode":observed.mode()});
    if archive_metadata != *expected_metadata {
        return Err(invalid());
    }
    let mut file = fs::File::from(
        openat(
            archive.as_fd(),
            Path::new("FINAL.json"),
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| invalid())?,
    );
    let before = file.metadata().map_err(|_| invalid())?;
    const MAXIMUM: u64 = 16 * 1024 * 1024;
    if !before.is_file()
        || before.nlink() != 1
        || before.uid() != observed.uid()
        || before.mode() & 0o022 != 0
        || before.len() == 0
        || before.len() > MAXIMUM
    {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAXIMUM + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    let after = file.metadata().map_err(|_| invalid())?;
    let named = fs::symlink_metadata(directory.path.join(ARCHIVE).join("FINAL.json"))
        .map_err(|_| invalid())?;
    let same = |current: &fs::Metadata| {
        current.is_file()
            && before.dev() == current.dev()
            && before.ino() == current.ino()
            && before.mode() == current.mode()
            && before.uid() == current.uid()
            && before.gid() == current.gid()
            && before.nlink() == current.nlink()
            && before.len() == current.len()
            && before.mtime() == current.mtime()
            && before.mtime_nsec() == current.mtime_nsec()
            && before.ctime() == current.ctime()
            && before.ctime_nsec() == current.ctime_nsec()
    };
    if bytes.len() as u64 != before.len()
        || hash_bytes(&bytes) != pin
        || !same(&after)
        || !same(&named)
        || metadata(&directory.path.join(ARCHIVE))? != archive_metadata
    {
        return Err(invalid());
    }
    Ok(())
}
pub(crate) fn archive_predecessor_control_v1(
    operation: &SchemaOperationIdentityV1,
    control: &ControlGuard,
) -> Result<()> {
    archive_control_impl(operation, control, &mut |_| Ok(()))
}
fn archive_control_impl(
    operation: &SchemaOperationIdentityV1,
    control: &ControlGuard,
    checkpoint: &mut dyn FnMut(&str) -> Result<()>,
) -> Result<()> {
    checkpoint("before_memento")?;
    control.assert_current().map_err(|_| invalid())?;
    let path = operation
        .runtime_root
        .join("autonomous-research/online-schema-transition");
    if control.path() != path {
        return Err(invalid());
    }
    let directory = Directory::open_or_create(&operation.barrier_root.join("execution"), false)?;
    let observed_metadata = if control.final_receipt_file_sha256().is_some() {
        metadata(&path)?
    } else {
        Value::Null
    };
    let tree_hash = if observed_metadata.is_null() {
        Value::Null
    } else {
        json!(control_tree_hash(&path)?)
    };
    let value = json!({"version":1,"kind":"HeptaInstalledSchemaControlPreimageV1","runtimeRoot":operation.runtime_root,"transitionId":operation.transition_id,"planHash":operation.plan_hash,"profileSha256":operation.profile_sha256,"sourceControlMetadata":observed_metadata,"sourceControlTreeHash":tree_hash,"previousFinalReceiptFileSha256":control.final_receipt_file_sha256()});
    publish_receipt(&directory, RECORD, &value, None)?;
    checkpoint("after_memento_before_rename")?;
    control.assert_current().map_err(|_| invalid())?;
    if control.final_receipt_file_sha256().is_some() {
        let parent = fs::File::open(path.parent().ok_or_else(invalid)?).map_err(|_| invalid())?;
        renameat2(
            parent.as_fd(),
            "online-schema-transition",
            directory.held.as_fd(),
            ARCHIVE,
            RenameFlags::RENAME_NOREPLACE,
        )
        .map_err(|_| invalid())?;
        parent.sync_all().map_err(|_| invalid())?;
        directory.held.sync_all().map_err(|_| invalid())?;
        if metadata(&directory.path.join(ARCHIVE))? != value["sourceControlMetadata"]
            || json!(control_tree_hash(&directory.path.join(ARCHIVE))?)
                != value["sourceControlTreeHash"]
        {
            return Err(invalid());
        }
    }
    checkpoint("after_rename_before_new_control")?;
    Directory::open_or_create(&path, true)?.assert_current()?;
    checkpoint("after_new_control")?;
    Ok(())
}
/// Recovery never substitutes a newly observed predecessor for the selected
/// root-only memento. A crash after rename but before control creation is safe
/// to resume; ambiguous pre-rename state requires the original signature check.
pub(crate) fn recover_control_handoff_v1(
    operation: &SchemaOperationIdentityV1,
    previous_final_pin: Option<&str>,
    original: impl FnOnce() -> std::result::Result<ControlGuard, String>,
) -> Result<()> {
    let directory = Directory::open_or_create(&operation.barrier_root.join("execution"), false)?;
    let path = directory.path.join(RECORD);
    if matches!(fs::symlink_metadata(&path),Err(cause) if cause.kind()==std::io::ErrorKind::NotFound)
    {
        let control = original().map_err(|_| invalid())?;
        if control.final_receipt_file_sha256() != previous_final_pin {
            return Err(invalid());
        }
        return archive_predecessor_control_v1(operation, &control);
    }
    let named = fs::symlink_metadata(&path).map_err(|_| invalid())?;
    if !named.is_file()
        || named.is_symlink()
        || named.uid() != 0
        || named.nlink() != 1
        || named.mode() & 0o077 != 0
        || named.len() > 4096
    {
        return Err(invalid());
    }
    let mut file = fs::File::from(
        openat(
            directory.held.as_fd(),
            RECORD,
            OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| invalid())?,
    );
    let held = file.metadata().map_err(|_| invalid())?;
    if held.dev() != named.dev() || held.ino() != named.ino() {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() as u64 != named.len() || bytes.len() > 4096 {
        return Err(invalid());
    }
    let observed = Snapshot::load(&path, &hash_bytes(&bytes), 4096, &invalid().code)?;
    let value = observed.json(&invalid().code)?;
    if !keys(
        &value,
        &[
            "version",
            "kind",
            "runtimeRoot",
            "transitionId",
            "planHash",
            "profileSha256",
            "sourceControlMetadata",
            "sourceControlTreeHash",
            "previousFinalReceiptFileSha256",
        ],
    ) || value["version"] != 1
        || value["kind"] != "HeptaInstalledSchemaControlPreimageV1"
        || value["runtimeRoot"] != json!(operation.runtime_root)
        || value["transitionId"] != operation.transition_id
        || value["planHash"] != operation.plan_hash
        || value["profileSha256"] != operation.profile_sha256
        || value["previousFinalReceiptFileSha256"].as_str() != previous_final_pin
    {
        return Err(invalid());
    }
    let archive = directory.path.join(ARCHIVE);
    if !value["sourceControlMetadata"].is_null() {
        if !sha(&value["sourceControlTreeHash"]) {
            return Err(invalid());
        }
        if matches!(fs::symlink_metadata(&archive),Err(cause) if cause.kind()==std::io::ErrorKind::NotFound)
        {
            let control = original().map_err(|_| invalid())?;
            control.assert_current().map_err(|_| invalid())?;
            let live = operation
                .runtime_root
                .join("autonomous-research/online-schema-transition");
            if control.path() != live
                || metadata(&live)? != value["sourceControlMetadata"]
                || control.final_receipt_file_sha256()
                    != value["previousFinalReceiptFileSha256"].as_str()
                || json!(control_tree_hash(&live)?) != value["sourceControlTreeHash"]
            {
                return Err(invalid());
            }
            observed.assert_current()?;
            directory.assert_current()?;
            let parent =
                fs::File::open(live.parent().ok_or_else(invalid)?).map_err(|_| invalid())?;
            renameat2(
                parent.as_fd(),
                "online-schema-transition",
                directory.held.as_fd(),
                ARCHIVE,
                RenameFlags::RENAME_NOREPLACE,
            )
            .map_err(|_| invalid())?;
            parent.sync_all().map_err(|_| invalid())?;
            directory.held.sync_all().map_err(|_| invalid())?;
        }
        if metadata(&archive)? != value["sourceControlMetadata"] {
            return Err(invalid());
        }
        let pin = value["previousFinalReceiptFileSha256"]
            .as_str()
            .ok_or_else(invalid)?;
        // This is root-private retained evidence. The service-owned bytes do
        // not become an authority token; archive signature rechecks precede
        // execution and every kernel phase rechecks its own pinned chain.
        retained_archive_receipt(&directory, &value["sourceControlMetadata"], pin)?;
        if json!(control_tree_hash(&archive)?) != value["sourceControlTreeHash"] {
            return Err(invalid());
        }
    } else if !value["sourceControlTreeHash"].is_null()
        || !value["previousFinalReceiptFileSha256"].is_null()
        || fs::symlink_metadata(archive).is_ok()
    {
        return Err(invalid());
    }
    observed.assert_current()?;
    directory.assert_current()?;
    Directory::open_or_create(
        &operation
            .runtime_root
            .join("autonomous-research/online-schema-transition"),
        true,
    )?
    .assert_current()
}

#[cfg(test)]
mod tests;
