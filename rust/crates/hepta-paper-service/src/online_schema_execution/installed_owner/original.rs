//! Root-only original manager states and exact operation-file preimages. This
//! record is evidence for a narrow inverse operation, never quiescence authority.
use super::{installation::ObservedInstalledSchemaProfileV1, *};
use crate::{
    sqlite_mutation_coordinator::{authority::files::Snapshot, hash_bytes, keys},
    state_recoverability::publication::{Directory, publish_receipt},
};
use nix::{
    fcntl::{OFlag, openat},
    sys::stat::Mode,
};
use serde_json::Value;
use std::{
    fs,
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Path, PathBuf},
};
pub(super) const NAME: &str = "ORIGINAL_MANAGER.v2.json";
const MAXIMUM: u64 = 1024 * 1024;
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_installed_schema_original_manager_invalid_or_changed")
}
fn operation_files(profile: &ObservedInstalledSchemaProfileV1) -> Vec<PathBuf> {
    let mut paths = profile
        .source_units()
        .iter()
        .map(|u| {
            PathBuf::from("/etc/systemd/system")
                .join(format!("{}.d", u.unit))
                .join(super::barrier::DROP_IN_NAME)
        })
        .collect::<Vec<_>>();
    let authority = PathBuf::from("/etc/systemd/system")
        .join(format!("{}.d", super::installation::AUTHORITY_UNIT_V1));
    for name in [
        "89-hepta-paper-native-schema-authority-source.conf",
        "91-hepta-paper-native-schema-authority-target.conf",
        super::barrier::AUTHORITY_DROP_IN_NAME,
    ] {
        paths.push(authority.join(name));
    }
    paths.sort();
    paths
}
fn observe_file(path: &Path) -> Result<Value> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(json!({"path":path,"state":"absent"}))
        }
        Ok(m) => {
            if !m.is_file()
                || m.is_symlink()
                || m.uid() != 0
                || m.mode() & 0o022 != 0
                || m.nlink() != 1
                || m.len() > 64 * 1024
            {
                return Err(invalid());
            }
            let parent = super::barrier::ProtectedDirectory::open_or_create(
                path.parent().ok_or_else(invalid)?,
                false,
            )?;
            let mut held = fs::File::from(
                openat(
                    parent.held.as_fd(),
                    path.file_name().ok_or_else(invalid)?,
                    OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| invalid())?,
            );
            let h = held.metadata().map_err(|_| invalid())?;
            if h.dev() != m.dev() || h.ino() != m.ino() {
                return Err(invalid());
            }
            let mut raw = Vec::new();
            (&mut held)
                .take(65537)
                .read_to_end(&mut raw)
                .map_err(|_| invalid())?;
            if raw.len() as u64 != m.len() {
                return Err(invalid());
            }
            let snap = Snapshot::load(path, &hash_bytes(&raw), 64 * 1024, &invalid().code)?;
            parent.assert_current()?;
            if snap.file.metadata().map_err(|_| invalid())?.ino() != m.ino() {
                return Err(invalid());
            }
            snap.assert_current()?;
            Ok(
                json!({"path":path,"state":"present","device":m.dev(),"inode":m.ino(),"uid":m.uid(),"gid":m.gid(),"mode":m.mode(),"sha256":hash_bytes(&raw),"byteLength":raw.len()}),
            )
        }
        Err(_) => Err(invalid()),
    }
}
pub(super) struct OriginalManagerV2 {
    observed: Snapshot,
    value: Value,
}
impl OriginalManagerV2 {
    pub(super) fn capture(
        profile: &ObservedInstalledSchemaProfileV1,
        operation: &SchemaOperationIdentityV1,
        directory: &Directory,
        boot: &str,
        manager_owner: &str,
        frames: Value,
    ) -> Result<Self> {
        profile.assert_current()?;
        directory.assert_current()?;
        let mut preimages = Vec::new();
        for path in operation_files(profile) {
            let value = observe_file(&path)?;
            if path.file_name().and_then(|n| n.to_str()) == Some(super::barrier::DROP_IN_NAME)
                && value["state"] != "absent"
            {
                return Err(invalid());
            }
            preimages.push(value);
        }
        let value = json!({"version":2,"kind":"HeptaInstalledSchemaOriginalManagerV2","runtimeRoot":operation.runtime_root,"transitionId":operation.transition_id,"planHash":operation.plan_hash,"profileSha256":operation.profile_sha256,"bootId":boot,"managerOwner":manager_owner,"units":frames,"operationFilePreimages":preimages});
        validate(&value, profile, operation)?;
        for row in value["operationFilePreimages"]
            .as_array()
            .ok_or_else(invalid)?
        {
            if observe_file(Path::new(row["path"].as_str().ok_or_else(invalid)?))? != *row {
                return Err(invalid());
            }
        }
        publish_receipt(directory, NAME, &value, None)?;
        Self::load(
            profile,
            operation,
            directory,
            &hash_bytes(&serde_json::to_vec(&value).map_err(|_| invalid())?),
        )
    }
    pub(super) fn recover_unpinned(
        profile: &ObservedInstalledSchemaProfileV1,
        operation: &SchemaOperationIdentityV1,
        directory: &Directory,
        boot: &str,
        manager_owner: &str,
        frames: &Value,
    ) -> Result<Self> {
        // The record/intent two-write boundary is recoverable only before any fence
        // was published, with the same actual original manager frame and preimages.
        if fs::symlink_metadata(operation.barrier_root.join("BLOCKED")).is_ok() {
            return Err(invalid());
        }
        let mut file = fs::File::from(
            openat(
                directory.held.as_fd(),
                NAME,
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| invalid())?,
        );
        let m = file.metadata().map_err(|_| invalid())?;
        if !m.is_file()
            || m.len() > MAXIMUM
            || m.uid() != 0
            || m.nlink() != 1
            || m.mode() & 0o077 != 0
        {
            return Err(invalid());
        }
        let mut raw = Vec::new();
        (&mut file)
            .take(MAXIMUM + 1)
            .read_to_end(&mut raw)
            .map_err(|_| invalid())?;
        if raw.len() as u64 != m.len() {
            return Err(invalid());
        }
        let observed = Self::load(profile, operation, directory, &hash_bytes(&raw))?;
        if observed
            .observed
            .file
            .metadata()
            .map_err(|_| invalid())?
            .ino()
            != m.ino()
            || observed.value["units"] != *frames
        {
            return Err(invalid());
        }
        observed.manager_identity(boot, manager_owner)?;
        for row in observed.value["operationFilePreimages"]
            .as_array()
            .ok_or_else(invalid)?
        {
            if observe_file(Path::new(row["path"].as_str().ok_or_else(invalid)?))? != *row {
                return Err(invalid());
            }
        }
        Ok(observed)
    }
    pub(super) fn load(
        profile: &ObservedInstalledSchemaProfileV1,
        operation: &SchemaOperationIdentityV1,
        directory: &Directory,
        pin: &str,
    ) -> Result<Self> {
        let observed = Snapshot::load(&directory.path.join(NAME), pin, MAXIMUM, &invalid().code)?;
        let value = observed.json(&invalid().code)?;
        let m = observed.file.metadata().map_err(|_| invalid())?;
        if m.uid() != 0 || m.mode() & 0o077 != 0 || m.nlink() != 1 {
            return Err(invalid());
        }
        validate(&value, profile, operation)?;
        directory.assert_current()?;
        observed.assert_current()?;
        Ok(Self { observed, value })
    }
    pub(super) fn file_sha256(&self) -> Result<String> {
        self.observed.assert_current()?;
        Ok(hash_bytes(self.observed.bytes()))
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        self.observed.assert_current()?;
        Ok(())
    }
    pub(super) fn assert_reversible_units(&self) -> Result<()> {
        self.assert_current()?;
        // An original active dispatcher can be fenced for forward migration,
        // but restoring it would invoke unrelated submission authority.
        if self.frame("autonomous-submission-dispatcher.service")?["activeState"] == "active" {
            return Err(error(
                "autonomous_research_installed_schema_early_rollback_submission_restart_forbidden",
            ));
        }
        Ok(())
    }
    pub(super) fn assert_authority_untouched(&self) -> Result<()> {
        self.assert_current()?;
        for row in self.value["operationFilePreimages"]
            .as_array()
            .ok_or_else(invalid)?
        {
            let path = Path::new(row["path"].as_str().ok_or_else(invalid)?);
            if path.file_name().and_then(|n| n.to_str()) != Some(super::barrier::DROP_IN_NAME)
                && observe_file(path)? != *row
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
    pub(super) fn frame(&self, unit: &str) -> Result<&Value> {
        self.value["units"]
            .as_array()
            .ok_or_else(invalid)?
            .iter()
            .find(|v| v["unit"] == unit)
            .ok_or_else(invalid)
    }
    pub(super) fn manager_identity(&self, boot: &str, owner: &str) -> Result<()> {
        self.assert_current()?;
        if self.value["bootId"] != boot || self.value["managerOwner"] != owner {
            return Err(invalid());
        }
        Ok(())
    }
}
fn validate(
    value: &Value,
    profile: &ObservedInstalledSchemaProfileV1,
    operation: &SchemaOperationIdentityV1,
) -> Result<()> {
    if !keys(
        value,
        &[
            "version",
            "kind",
            "runtimeRoot",
            "transitionId",
            "planHash",
            "profileSha256",
            "bootId",
            "managerOwner",
            "units",
            "operationFilePreimages",
        ],
    ) || value["version"] != 2
        || value["kind"] != "HeptaInstalledSchemaOriginalManagerV2"
        || value["runtimeRoot"] != json!(operation.runtime_root)
        || value["transitionId"] != operation.transition_id
        || value["planHash"] != operation.plan_hash
        || value["profileSha256"] != operation.profile_sha256
        || value["bootId"].as_str().is_none_or(|s| s.len() != 36)
        || value["managerOwner"]
            .as_str()
            .is_none_or(|s| !s.starts_with(':') || s.len() > 256)
    {
        return Err(invalid());
    }
    let mut names = profile
        .source_units()
        .iter()
        .map(|u| u.unit.as_str())
        .chain(std::iter::once(super::installation::AUTHORITY_UNIT_V1))
        .collect::<Vec<_>>();
    names.sort();
    let units = value["units"].as_array().ok_or_else(invalid)?;
    if units.len() != names.len() {
        return Err(invalid());
    }
    for (row, name) in units.iter().zip(names) {
        if !keys(
            row,
            &[
                "unit",
                "activeState",
                "subState",
                "mainPid",
                "controlPid",
                "job",
                "cgroup",
            ],
        ) || row["unit"] != name
            || row["activeState"]
                .as_str()
                .is_none_or(|s| !matches!(s, "active" | "inactive" | "failed"))
            || row["subState"]
                .as_str()
                .is_none_or(|s| !matches!(s, "running" | "dead" | "failed" | "exited"))
            || ["mainPid", "controlPid", "job"]
                .iter()
                .any(|k| row[k].as_u64().is_none_or(|v| v > u64::from(u32::MAX)))
            || row["controlPid"] != 0
            || row["job"] != 0
            || row["cgroup"].as_str().is_none_or(|s| s.len() > 4096)
        {
            return Err(invalid());
        }
        let active = row["activeState"].as_str().ok_or_else(invalid)?;
        let sub = row["subState"].as_str().ok_or_else(invalid)?;
        let pid = row["mainPid"].as_u64().ok_or_else(invalid)?;
        let root_oneshot = profile
            .source_units()
            .iter()
            .find(|u| u.unit == name)
            .is_some_and(super::installation::fixed_root_layout_oneshot);
        if !(matches!(
            (active, sub, pid),
            ("inactive", "dead", 0) | ("failed", "failed", 0)
        ) || (active == "active" && sub == "running" && pid > 0)
            || (root_oneshot && active == "active" && sub == "exited" && pid == 0))
        {
            return Err(invalid());
        }
    }
    let paths = operation_files(profile);
    let preimages = value["operationFilePreimages"]
        .as_array()
        .ok_or_else(invalid)?;
    if preimages.len() != paths.len() {
        return Err(invalid());
    }
    for (row, path) in preimages.iter().zip(paths) {
        if row["path"] != json!(path)
            || !matches!(row["state"].as_str(), Some("absent" | "present"))
        {
            return Err(invalid());
        }
        if row["state"] == "absent" {
            if !keys(row, &["path", "state"]) {
                return Err(invalid());
            }
        } else if !keys(
            row,
            &[
                "path",
                "state",
                "device",
                "inode",
                "uid",
                "gid",
                "mode",
                "sha256",
                "byteLength",
            ],
        ) || row["uid"] != 0
            || ["device", "inode", "uid", "gid", "mode"]
                .iter()
                .any(|k| row[k].as_u64().is_none())
            || row["mode"].as_u64().is_none_or(|m| m & 0o022 != 0)
            || !sha(&row["sha256"])
            || row["byteLength"].as_u64().is_none_or(|n| n > 64 * 1024)
        {
            return Err(invalid());
        }
        if path.file_name().and_then(|n| n.to_str()) == Some(super::barrier::DROP_IN_NAME)
            && row["state"] != "absent"
        {
            return Err(invalid());
        }
    }
    Ok(())
}
