//! Historical Node control is signed public input, not a maintenance capability.
//! The privileged reader may observe a service-owned directory; it never changes
//! its ownership, opens SQLite, creates a control file or invokes an authority.
pub(crate) mod legacy_v021;
mod lineage;
use super::*;
use nix::{
    fcntl::{OFlag, openat},
    sys::stat::Mode,
};
use std::{
    fs::{File, Metadata},
    io::Read,
    os::{fd::AsFd, unix::fs::MetadataExt},
};
const MAX_GENERATIONS: usize = 64;
const MAX_HISTORY_BYTES: u64 = 128 * 1024 * 1024;
fn invalid() -> String {
    format!("{PREFIX}previous_node_history_invalid")
}
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
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
struct DirectoryObservation {
    path: PathBuf,
    held: File,
    metadata: Metadata,
    parents: Vec<(PathBuf, File)>,
}
impl DirectoryObservation {
    fn open(path: &Path) -> Result<Self, String> {
        if !path.is_absolute()
            || path
                .components()
                .any(|c| !matches!(c, Component::RootDir | Component::Normal(_)))
        {
            return Err(invalid());
        }
        let mut held = File::open("/").map_err(|_| invalid())?;
        let mut cursor = PathBuf::from("/");
        let mut parents = Vec::new();
        for component in path.components() {
            let Component::Normal(name) = component else {
                continue;
            };
            let child = File::from(
                openat(
                    held.as_fd(),
                    Path::new(name),
                    OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| invalid())?,
            );
            parents.push((cursor.clone(), held));
            cursor.push(name);
            held = child;
        }
        let metadata = held.metadata().map_err(|_| invalid())?;
        if metadata.mode() & 0o022 != 0
            || (nix::unistd::geteuid().as_raw() != 0
                && ![0, nix::unistd::getuid().as_raw()].contains(&metadata.uid()))
        {
            return Err(invalid());
        }
        let result = Self {
            path: cursor,
            held,
            metadata,
            parents,
        };
        result.assert_current()?;
        Ok(result)
    }
    fn assert_current(&self) -> Result<(), String> {
        for (path, file) in self
            .parents
            .iter()
            .map(|(path, file)| (path, file))
            .chain(std::iter::once((&self.path, &self.held)))
        {
            let named = fs::symlink_metadata(path).map_err(|_| invalid())?;
            let held = file.metadata().map_err(|_| invalid())?;
            if !named.is_dir()
                || named.is_symlink()
                || (
                    named.dev(),
                    named.ino(),
                    named.uid(),
                    named.gid(),
                    named.mode(),
                ) != (held.dev(), held.ino(), held.uid(), held.gid(), held.mode())
            {
                return Err(invalid());
            }
        }
        let current = self.held.metadata().map_err(|_| invalid())?;
        if (
            current.dev(),
            current.ino(),
            current.uid(),
            current.gid(),
            current.mode(),
        ) != (
            self.metadata.dev(),
            self.metadata.ino(),
            self.metadata.uid(),
            self.metadata.gid(),
            self.metadata.mode(),
        ) {
            return Err(invalid());
        }
        Ok(())
    }
    fn entries(&self) -> Result<Vec<String>, String> {
        self.assert_current()?;
        let entries = control_entries(&self.path)?;
        self.assert_current()?;
        Ok(entries)
    }
    fn file(&self, name: &str, maximum: u64) -> Result<FileObservation, String> {
        self.assert_current()?;
        let mut file = File::from(
            openat(
                self.held.as_fd(),
                Path::new(name),
                OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK,
                Mode::empty(),
            )
            .map_err(|_| invalid())?,
        );
        let metadata = file.metadata().map_err(|_| invalid())?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.mode() & 0o022 != 0
            || metadata.uid() != self.metadata.uid()
            || metadata.len() == 0
            || metadata.len() > maximum
        {
            return Err(invalid());
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(maximum + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid())?;
        if bytes.len() as u64 != metadata.len() {
            return Err(invalid());
        }
        let value = FileObservation {
            path: self.path.join(name),
            file,
            metadata,
            bytes,
        };
        value.assert_current()?;
        self.assert_current()?;
        Ok(value)
    }
}
struct FileObservation {
    path: PathBuf,
    file: File,
    metadata: Metadata,
    bytes: Vec<u8>,
}
impl FileObservation {
    fn assert_current(&self) -> Result<(), String> {
        let named = fs::symlink_metadata(&self.path).map_err(|_| invalid())?;
        if named.is_symlink()
            || !same_file(&self.metadata, &named)
            || !same_file(
                &self.metadata,
                &self.file.metadata().map_err(|_| invalid())?,
            )
        {
            return Err(invalid());
        }
        Ok(())
    }
    fn value(&self) -> Result<Value, String> {
        parse(&self.bytes, &invalid()).map_err(|e| e.code)
    }
    fn pin(&self) -> String {
        hash_bytes(&self.bytes)
    }
}
struct Generation {
    directory: DirectoryObservation,
    entries: Vec<String>,
    files: Vec<FileObservation>,
}
impl Generation {
    fn assert_current(&self) -> Result<(), String> {
        self.directory.assert_current()?;
        if self.directory.entries() != Ok(self.entries.clone()) {
            return Err(invalid());
        }
        for file in &self.files {
            file.assert_current()?;
        }
        Ok(())
    }
}
pub(in crate::online_schema_execution) struct ObservedNodeControlV1 {
    current: Generation,
    history: Option<(DirectoryObservation, Vec<String>)>,
    generations: Vec<Generation>,
    final_pin: String,
}
impl ObservedNodeControlV1 {
    pub(in crate::online_schema_execution) fn control_path(&self) -> &Path {
        &self.current.directory.path
    }
    pub(super) fn final_receipt_file_sha256(&self) -> &str {
        &self.final_pin
    }
    pub(super) fn assert_current(&self) -> Result<(), String> {
        self.current.assert_current()?;
        if let Some((directory, names)) = &self.history {
            directory.assert_current()?;
            if directory.entries() != Ok(names.clone()) {
                return Err(invalid());
            }
        }
        for generation in &self.generations {
            generation.assert_current()?;
        }
        Ok(())
    }
}
fn validate_node_active(active: &Value, final_value: &Value) -> Result<(), String> {
    let keys = active
        .as_object()
        .ok_or_else(|| format!("{PREFIX}previous_active_state_invalid"))?
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let expected_keys = [
        "finalReceiptHash",
        "installations",
        "kind",
        "phase",
        "plan",
        "reservation",
        "reserveRequest",
        "version",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    validate_schema_transition_plan_identity_v1(&active["plan"])
        .map_err(|_| format!("{PREFIX}previous_active_state_invalid"))?;
    if keys != expected_keys
        || active["version"] != 1
        || active["kind"] != "AutonomousResearchOnlineSchemaTransitionState"
        || active["phase"] != "finalized"
        || active["finalReceiptHash"] != final_value["schemaTransitionReceiptHash"]
        || active["reserveRequest"] != final_value["reserveRequest"]
        || active["reservation"] != final_value["reservation"]
        || active["installations"] != final_value["installations"]
        || !same_fields(
            &active["plan"],
            final_value,
            &[
                "version",
                "protocol",
                "transitionId",
                "planHash",
                "databaseScopeHash",
                "writerManifestHash",
                "transitionInventoryHash",
                "schemaBundleHash",
            ],
        )
    {
        return Err(format!("{PREFIX}previous_finalized_control_invalid"));
    }
    Ok(())
}
fn verify_generation<T: MutationAuthorityTransportV1>(
    active: &FileObservation,
    receipt: &FileObservation,
    authority: &PinnedMutationAuthorityV1<T>,
) -> Result<Value, String> {
    let active_value = active.value()?;
    let value = receipt.value()?;
    if legacy_v021::is_legacy(&value) {
        legacy_v021::verify(&active_value, &value, &receipt.bytes, authority)?;
    } else {
        validate_node_active(&active_value, &value)?;
        crate::online_schema_transition::audit::verify_historical_public_audit_v1(
            &value,
            &receipt.bytes,
            authority,
        )
        .map_err(|_| invalid())?;
    }
    Ok(value)
}
pub(super) fn observe_node_control_v1<T: MutationAuthorityTransportV1>(
    control: &Path,
    expected: &str,
    authority: &PinnedMutationAuthorityV1<T>,
    historical: Option<&PinnedMutationAuthorityV1<T>>,
) -> Result<ObservedNodeControlV1, String> {
    let verifier = historical.unwrap_or(authority);
    if historical.is_some()
        && !same_fields(
            verifier.trust(),
            authority.trust(),
            &["authorityId", "keyId", "scopeId", "databaseScopeHash"],
        )
    {
        return Err(invalid());
    }
    let directory = DirectoryObservation::open(control)?;
    let entries = directory.entries()?;
    if entries != ["ACTIVE.json", "FINAL.json"]
        && entries != ["ACTIVE.json", "FINAL.json", "history"]
    {
        return Err(invalid());
    }
    let active = directory.file("ACTIVE.json", MAX_CONTROL_BYTES)?;
    let final_file = directory.file("FINAL.json", MAX_CONTROL_BYTES)?;
    if final_file.pin() != expected {
        return Err(format!("{PREFIX}previous_final_receipt_invalid"));
    }
    let current_value = verify_generation(&active, &final_file, verifier)?;
    if current_value["writerManifestHash"] != authority.trust()["writerManifestHash"]
        && current_value["writerManifestHash"] != verifier.trust()["writerManifestHash"]
    {
        return Err(invalid());
    }
    let current = Generation {
        directory,
        entries,
        files: vec![active, final_file],
    };
    let mut history = None;
    let mut generations = Vec::new();
    let mut archive_values = Vec::new();
    let mut total = current
        .files
        .iter()
        .map(|f| f.bytes.len() as u64)
        .sum::<u64>();
    let history_path = control.join("history");
    if current.entries.iter().any(|name| name == "history") {
        let held = DirectoryObservation::open(&history_path)?;
        if held.metadata.uid() != current.directory.metadata.uid() {
            return Err(invalid());
        }
        let names = held.entries()?;
        if names.len() > MAX_GENERATIONS {
            return Err(invalid());
        }
        let mut seen = BTreeSet::new();
        for name in &names {
            let generation_directory = DirectoryObservation::open(&history_path.join(name))?;
            let generation_entries = generation_directory.entries()?;
            if generation_directory.metadata.uid() != held.metadata.uid()
                || generation_entries != ["ACTIVE.json", "FINAL.json", "MANIFEST.sha256"]
            {
                return Err(invalid());
            }
            let generation_active = generation_directory.file("ACTIVE.json", MAX_CONTROL_BYTES)?;
            let generation_final = generation_directory.file("FINAL.json", MAX_CONTROL_BYTES)?;
            let manifest = generation_directory.file("MANIFEST.sha256", 1024)?;
            total = total
                .checked_add(
                    generation_active.bytes.len() as u64
                        + generation_final.bytes.len() as u64
                        + manifest.bytes.len() as u64,
                )
                .filter(|v| *v <= MAX_HISTORY_BYTES)
                .ok_or_else(invalid)?;
            let generation_value =
                verify_generation(&generation_active, &generation_final, verifier)?;
            let transition = text(&generation_value, "transitionId")
                .map_err(|e| e.code)?
                .strip_prefix("sha256:")
                .ok_or_else(invalid)?;
            let writer = text(&generation_value, "writerManifestHash")
                .map_err(|e| e.code)?
                .strip_prefix("sha256:")
                .filter(|v| exact_lower_hex(v, 64))
                .ok_or_else(invalid)?;
            if !exact_lower_hex(transition, 64)
                || name != &format!("{transition}-writer-{}", &writer[..8])
                || !seen.insert(transition.to_owned())
            {
                return Err(invalid());
            }
            let manifest_expected = format!(
                "{}  ACTIVE.json\n{}  FINAL.json\n",
                generation_active.pin().trim_start_matches("sha256:"),
                generation_final.pin().trim_start_matches("sha256:")
            );
            if manifest.bytes != manifest_expected.as_bytes() {
                return Err(invalid());
            }
            // A current-generation mirror must preserve original wire bytes.
            // Other generations are admitted only through signed lineage below.
            if generation_value["transitionId"] == current_value["transitionId"]
                && (generation_value != current_value
                    || generation_active.bytes != current.files[0].bytes
                    || generation_final.bytes != current.files[1].bytes)
            {
                return Err(format!("{PREFIX}previous_node_history_lineage_unproven"));
            }
            archive_values.push(generation_value);
            generations.push(Generation {
                directory: generation_directory,
                entries: generation_entries,
                files: vec![generation_active, generation_final, manifest],
            });
        }
        history = Some((held, names));
    }
    lineage::verify(&current_value, &archive_values)?;
    current.assert_current()?;
    let result = ObservedNodeControlV1 {
        current,
        history,
        generations,
        final_pin: expected.to_owned(),
    };
    result.assert_current()?;
    Ok(result)
}

#[cfg(test)]
pub(in crate::online_schema_execution) mod tests;
