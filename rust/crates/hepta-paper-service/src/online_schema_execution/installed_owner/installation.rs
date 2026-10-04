//! Read-only profile provenance. These descriptors select fixed installed files
//! and principals; only a subsequent actual system-manager observation may
//! establish writer quiescence. All public projections remain non-authoritative.
use crate::sqlite_mutation_coordinator::{
    Result, authority::files::Snapshot, error, hash, keys, sha,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs::{self, File, Metadata},
    os::unix::fs::MetadataExt,
    path::{Component, Path, PathBuf},
};

pub const SOURCE_WRITER_UNITS_V1: [&str; 4] = [
    "autonomous-research-state-backup-renew.service",
    "autonomous-research-supervisor.service",
    "autonomous-submission-dispatcher.service",
    "autonomous-submission-handoff-layout-provision.service",
];
pub const AUTHORITY_UNIT_V1: &str = "hepta-paper-state-authority.service";

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PinnedInstalledFileV1 {
    pub path: PathBuf,
    pub sha256: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceUnitV1 {
    pub unit: String,
    pub fragment: PinnedInstalledFileV1,
    pub drop_ins: Vec<PinnedInstalledFileV1>,
    pub executable: PinnedInstalledFileV1,
    pub argv: Vec<String>,
    pub working_directory: PathBuf,
    pub uid: u32,
    pub gid: u32,
    pub supplementary_gids: Vec<u32>,
    pub service_type: String,
    pub kill_mode: String,
    pub input_files: Vec<PinnedInstalledFileV1>,
}
/// Exact authority configuration handoff. Private daemon and public verifier
/// configurations remain distinct hash domains and retain separate file pins.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityRestartProfileV1 {
    pub source_unit: SourceUnitV1,
    pub target_unit: SourceUnitV1,
    pub source_daemon_configuration: PinnedInstalledFileV1,
    pub target_daemon_configuration: PinnedInstalledFileV1,
    pub source_process_configuration: PinnedInstalledFileV1,
    pub target_process_configuration: PinnedInstalledFileV1,
    pub target_unit_drop_in: PinnedInstalledFileV1,
    pub target_authority_configuration_hash: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Profile {
    version: u16,
    kind: String,
    profile_id: String,
    runtime_root: PathBuf,
    authority_scope: String,
    source_units: Vec<SourceUnitV1>,
    authority_restart: AuthorityRestartProfileV1,
}
struct Directory {
    path: PathBuf,
    file: File,
    metadata: Metadata,
}
impl Directory {
    fn observe(path: &Path) -> Result<Self> {
        absolute(path)?;
        let named = fs::symlink_metadata(path).map_err(|_| invalid())?;
        if !named.is_dir() || named.is_symlink() {
            return Err(invalid());
        }
        let file = File::open(path).map_err(|_| invalid())?;
        let value = Self {
            path: path.to_owned(),
            file,
            metadata: named,
        };
        value.assert_current()?;
        Ok(value)
    }
    fn assert_current(&self) -> Result<()> {
        let named = fs::symlink_metadata(&self.path).map_err(|_| invalid())?;
        let held = self.file.metadata().map_err(|_| invalid())?;
        let projection = |v: &Metadata| (v.dev(), v.ino(), v.uid(), v.gid(), v.mode());
        if !named.is_dir()
            || named.is_symlink()
            || projection(&named) != projection(&self.metadata)
            || projection(&held) != projection(&self.metadata)
        {
            return Err(invalid());
        }
        Ok(())
    }
}

/// No Deserialize/Clone or caller-data constructor. A profile can be read only
/// by the real privileged installed owner with an independently selected pin.
pub struct ObservedInstalledSchemaProfileV1 {
    profile: Profile,
    profile_sha256: String,
    files: Vec<Snapshot>,
    directories: Vec<Directory>,
}
impl ObservedInstalledSchemaProfileV1 {
    pub fn source_units(&self) -> &[SourceUnitV1] {
        &self.profile.source_units
    }
    pub fn authority_restart(&self) -> &AuthorityRestartProfileV1 {
        &self.profile.authority_restart
    }
    pub fn runtime_root(&self) -> &Path {
        &self.profile.runtime_root
    }
    pub fn profile_sha256(&self) -> &str {
        &self.profile_sha256
    }
    pub fn assert_current(&self) -> Result<()> {
        privileged()?;
        for file in &self.files {
            file.assert_current()?;
            protected_ancestors(&file.path)?;
        }
        for directory in &self.directories {
            directory.assert_current()?;
        }
        Ok(())
    }
    pub fn report(&self) -> Value {
        json!({"version":1,"kind":"InstalledSchemaMaintenanceProfileObservationV1",
            "profileId":self.profile.profile_id,"profileSha256":self.profile_sha256,
            "runtimeRoot":self.profile.runtime_root,"sourceUnits":self.profile.source_units.iter().map(|u| &u.unit).collect::<Vec<_>>(),
            "authorityScope":"schema_maintenance_only","writerQuiescenceObserved":false,
            "researchQualification":false,"releaseAuthority":false,"submissionAuthority":false})
    }
}
fn invalid() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("autonomous_research_installed_schema_profile_invalid_or_changed")
}
fn privileged() -> Result<()> {
    if nix::unistd::getuid().as_raw() != 0 || nix::unistd::geteuid().as_raw() != 0 {
        return Err(error(
            "autonomous_research_installed_schema_owner_requires_root",
        ));
    }
    Ok(())
}
fn absolute(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
        || fs::canonicalize(path).ok().as_deref() != Some(path)
    {
        return Err(invalid());
    }
    Ok(())
}
fn snapshot(value: &PinnedInstalledFileV1, maximum: u64) -> Result<Snapshot> {
    absolute(&value.path)?;
    protected_ancestors(&value.path)?;
    let result = Snapshot::load(&value.path, &value.sha256, maximum, &invalid().code)?;
    if result.file.metadata().map_err(|_| invalid())?.uid() != 0 {
        return Err(invalid());
    }
    Ok(result)
}
fn protected_ancestors(file_path: &Path) -> Result<()> {
    for path in file_path.ancestors().skip(1) {
        let metadata = fs::symlink_metadata(path).map_err(|_| invalid())?;
        let protected_sticky = metadata.mode() & 0o1000 != 0
            && [Path::new("/tmp"), Path::new("/var/tmp")].contains(&path);
        if !metadata.is_dir()
            || metadata.is_symlink()
            || metadata.uid() != 0
            || (metadata.mode() & 0o022 != 0 && !protected_sticky)
        {
            return Err(invalid());
        }
    }
    Ok(())
}
/// Only the installed layout provisioner has an existing root oneshot contract.
/// This is a shape restriction, never a readiness or activation capability;
/// the manager independently binds every command/input/principal and cgroup.
pub(super) fn fixed_root_layout_oneshot(unit: &SourceUnitV1) -> bool {
    unit.unit == "autonomous-submission-handoff-layout-provision.service"
        && unit.uid == 0
        && unit.gid != 0
        && unit.service_type == "oneshot"
        && unit.kill_mode == "control-group"
        && unit.supplementary_gids == [0]
        && unit.executable.path == Path::new("/usr/bin/env")
        && unit.argv.len() == 8
        && unit.argv[0] == "/usr/bin/env"
        && unit.argv[1] == "-i"
        && unit.argv[2] == "PATH=/usr/sbin:/usr/bin"
        && unit.argv[3] == "/usr/libexec/hepta-paper/autonomous-submission-handoff-layout-provision"
        && unit.argv[4] == "--runtime-root"
        && Path::new(&unit.argv[5]).is_absolute()
        && Path::new(&unit.argv[5])
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
        && unit.argv[6] == "--receipt-path"
        && unit.argv[7]
            == "/run/hepta-paper-handoff-layout/autonomous-submission-handoff-layout.receipt.json"
        && unit.working_directory.as_os_str().is_empty()
        && unit
            .input_files
            .iter()
            .any(|p| p.path == Path::new(&unit.argv[3]))
}
fn unit_observations(
    unit: &SourceUnitV1,
    files: &mut Vec<Snapshot>,
    directories: &mut Vec<Directory>,
) -> Result<()> {
    if unit.argv.is_empty()
        || unit.argv.len() > 64
        || unit.argv[0] != unit.executable.path.to_str().ok_or_else(invalid)?
        || unit
            .argv
            .iter()
            .any(|v| v.is_empty() || v.len() > 16384 || v.contains('\0'))
        || unit.drop_ins.len() > 64
        || unit.input_files.len() > 512
        || (unit.uid == 0 && !fixed_root_layout_oneshot(unit))
        || unit.gid == 0
        || unit.supplementary_gids.len() > 64
        || (unit.supplementary_gids.contains(&0) && !fixed_root_layout_oneshot(unit))
        || !unit.supplementary_gids.windows(2).all(|w| w[0] < w[1])
        || !matches!(
            unit.service_type.as_str(),
            "simple" | "exec" | "notify" | "oneshot"
        )
        || unit.kill_mode != "control-group"
        || !unit.fragment.path.starts_with("/etc/systemd/system")
        || unit.fragment.path.file_name().and_then(|v| v.to_str()) != Some(unit.unit.as_str())
    {
        return Err(invalid());
    }
    files.push(snapshot(&unit.fragment, 1024 * 1024)?);
    let mut executable = snapshot(&unit.executable, 512 * 1024 * 1024)?;
    if !executable.executable() {
        return Err(invalid());
    }
    executable.clear_secret_bytes();
    files.push(executable);
    let mut names = BTreeSet::new();
    for input in unit.drop_ins.iter().chain(&unit.input_files) {
        if !names.insert(&input.path) {
            return Err(invalid());
        }
        let mut observed = snapshot(input, 16 * 1024 * 1024)?;
        observed.clear_secret_bytes();
        files.push(observed);
    }
    if fixed_root_layout_oneshot(unit) {
        // systemd's empty WorkingDirectory is this fixed oneshot's actual
        // contract; the command uses only the independently pinned runtime.
        directories.push(Directory::observe(Path::new("/"))?);
    } else {
        directories.push(Directory::observe(&unit.working_directory)?);
    }
    Ok(())
}
pub fn observe_installed_schema_profile_v1(
    path: &Path,
    pin: &str,
    expected_runtime_root: &Path,
) -> Result<ObservedInstalledSchemaProfileV1> {
    privileged()?;
    let observed = snapshot(
        &PinnedInstalledFileV1 {
            path: path.to_owned(),
            sha256: pin.to_owned(),
        },
        4 * 1024 * 1024,
    )?;
    let value = observed.json(&invalid().code)?;
    if !keys(
        &value,
        &[
            "version",
            "kind",
            "profileId",
            "runtimeRoot",
            "authorityScope",
            "sourceUnits",
            "authorityRestart",
        ],
    ) {
        return Err(invalid());
    }
    let profile: Profile = serde_json::from_value(value).map_err(|_| invalid())?;
    if profile.version != 1
        || profile.kind != "HeptaInstalledSchemaMaintenanceProfileV1"
        || profile.profile_id != "hepta-paper-installed-schema-maintenance-v1"
        || profile.authority_scope != "schema-maintenance-only"
        || profile.runtime_root != expected_runtime_root
        || profile
            .source_units
            .iter()
            .map(|v| v.unit.as_str())
            .ne(SOURCE_WRITER_UNITS_V1)
        || profile.authority_restart.source_unit.unit != AUTHORITY_UNIT_V1
        || profile.authority_restart.target_unit.unit != AUTHORITY_UNIT_V1
        || !sha(&json!(
            profile
                .authority_restart
                .target_authority_configuration_hash
        ))
    {
        return Err(invalid());
    }
    absolute(expected_runtime_root)?;
    let mut files = vec![observed];
    let mut directories = vec![Directory::observe(expected_runtime_root)?];
    for unit in profile
        .source_units
        .iter()
        .chain(std::iter::once(&profile.authority_restart.source_unit))
    {
        if fixed_root_layout_oneshot(unit) && Path::new(&unit.argv[5]) != profile.runtime_root {
            return Err(invalid());
        }
        unit_observations(unit, &mut files, &mut directories)?;
    }
    let restart = &profile.authority_restart;
    let source_daemon =
        snapshot(&restart.source_daemon_configuration, 4 * 1024 * 1024)?.json(&invalid().code)?;
    let target_daemon =
        snapshot(&restart.target_daemon_configuration, 4 * 1024 * 1024)?.json(&invalid().code)?;
    crate::local_state_authority::configuration::validate_configuration(&source_daemon)?;
    crate::local_state_authority::configuration::validate_configuration(&target_daemon)?;
    if [
        "version",
        "kind",
        "authorityId",
        "keyId",
        "scopeId",
        "databaseScopeHash",
        "privateKeyPath",
        "stateDatabasePath",
        "socketPath",
        "maximumReservationLeaseMs",
        "maximumObservationAgeMs",
    ]
    .iter()
    .any(|key| source_daemon[key] != target_daemon[key])
        || restart.target_authority_configuration_hash
            != hash(
                "HeptaLocalAutonomousResearchStateAuthorityConfiguration",
                &target_daemon,
            )?
    {
        return Err(invalid());
    }
    let source = &restart.source_unit;
    let target = &restart.target_unit;
    if restart
        .source_daemon_configuration
        .path
        .to_str()
        .is_none_or(|arg| {
            !arg.bytes()
                .all(|v| v.is_ascii_alphanumeric() || b"/_-.".contains(&v))
        })
        || target.fragment != source.fragment
        || target.drop_ins != source.drop_ins
        || target.uid != source.uid
        || target.gid != source.gid
        || target.supplementary_gids != source.supplementary_gids
        || target.service_type != source.service_type
        || target.kill_mode != source.kill_mode
        || target.working_directory != source.working_directory
        || target.executable.path.file_name().and_then(|v| v.to_str())
            != Some("hepta-paper-state-authority-daemon")
        || target.argv
            != vec![
                target
                    .executable
                    .path
                    .to_str()
                    .ok_or_else(invalid)?
                    .to_owned(),
                "--configuration".to_owned(),
                restart
                    .target_daemon_configuration
                    .path
                    .to_str()
                    .ok_or_else(invalid)?
                    .to_owned(),
            ]
        || !target.argv.iter().all(|arg| {
            arg.bytes()
                .all(|v| v.is_ascii_alphanumeric() || b"/_-.".contains(&v))
        })
    {
        return Err(invalid());
    }
    unit_observations(target, &mut files, &mut directories)?;
    let mut target_binary = snapshot(&target.executable, 512 * 1024 * 1024)?;
    if !target_binary.bytes().starts_with(b"\x7fELF") {
        return Err(invalid());
    }
    target_binary.clear_secret_bytes();
    let dropin = snapshot(&restart.target_unit_drop_in, 1024 * 1024)?;
    let expected_dropin = format!(
        "[Service]\nExecStart=\nExecStart={} --configuration {}\n",
        target.argv[0], target.argv[2]
    );
    if dropin.bytes() != expected_dropin.as_bytes() {
        return Err(invalid());
    }
    files.push(target_binary);
    files.push(dropin);
    for input in [
        &restart.source_daemon_configuration,
        &restart.target_daemon_configuration,
        &restart.source_process_configuration,
        &restart.target_process_configuration,
        &restart.target_unit_drop_in,
    ] {
        let mut observed = snapshot(input, 4 * 1024 * 1024)?;
        if std::ptr::eq(input, &restart.source_daemon_configuration)
            || std::ptr::eq(input, &restart.target_daemon_configuration)
        {
            observed.clear_secret_bytes();
        }
        files.push(observed);
    }
    let result = ObservedInstalledSchemaProfileV1 {
        profile,
        profile_sha256: pin.to_owned(),
        files,
        directories,
    };
    result.assert_current()?;
    Ok(result)
}
