//! Bounded read-only inputs for the existing CAS verifier and publication owner.
//! Pins are observations, never leases, publisher provenance or write authority.
use super::{MAX_SEED_DEPTH, MAX_SEED_ENTRIES, require_active};
use nix::{
    dir::Dir,
    fcntl::{OFlag, openat},
    sys::stat::Mode,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, Metadata},
    os::{
        fd::AsFd,
        unix::fs::{FileExt, MetadataExt},
    },
    path::{Component, Path, PathBuf},
    sync::atomic::AtomicBool,
};

pub(super) const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const INVALID: &str = "r_runtime_source_cas_input_invalid";
const CHANGED: &str = "r_runtime_source_cas_input_changed";
const BOUND: &str = "r_runtime_source_cas_observation_limit_exceeded";

/// One byte policy for fresh publication and subsequent status/replay.
#[derive(Default)]
pub(super) struct ObservationBudget {
    bytes: u64,
}
impl ObservationBudget {
    pub(super) fn account(&mut self, bytes: u64, maximum: u64) -> Result<(), String> {
        if bytes > maximum {
            return Err(BOUND.to_owned());
        }
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .filter(|n| *n <= MAX_TOTAL_BYTES)
            .ok_or_else(|| BOUND.to_owned())?;
        Ok(())
    }
}

fn identity(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
}
fn content_identity(a: &Metadata, b: &Metadata) -> bool {
    identity(a, b)
        && a.nlink() == b.nlink()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
struct Pin {
    held: File,
    before: Metadata,
    enumerated: bool,
}
impl Pin {
    fn assert_current(&self, path: &Path) -> Result<(), String> {
        let held = self.held.metadata().map_err(|_| CHANGED.to_owned())?;
        let named = fs::symlink_metadata(path).map_err(|_| CHANGED.to_owned())?;
        let stable = if self.before.is_file() || self.enumerated {
            content_identity(&self.before, &held) && content_identity(&held, &named)
        } else {
            identity(&self.before, &held) && identity(&held, &named)
        };
        if stable && !named.file_type().is_symlink() {
            Ok(())
        } else {
            Err(CHANGED.to_owned())
        }
    }
}

pub(super) struct SourceObservation<'a> {
    selected: PathBuf,
    root: PathBuf,
    pins: BTreeMap<PathBuf, Pin>,
    budget: ObservationBudget,
    cancelled: &'a AtomicBool,
}
impl<'a> SourceObservation<'a> {
    pub(super) fn new(root: &Path, cancelled: &'a AtomicBool) -> Result<Self, String> {
        require_active(cancelled)?;
        let selected = if root.is_absolute() {
            root.to_owned()
        } else {
            std::env::current_dir()
                .map_err(|_| INVALID.to_owned())?
                .join(root)
        };
        // The caller may select a deployment-root alias. Only this root is
        // resolved; child names are subsequently opened against retained fds.
        let root = fs::canonicalize(&selected)
            .map_err(|e| format!("r_runtime_source_cas_unavailable:{e}"))?;
        let held = File::open("/").map_err(|_| INVALID.to_owned())?;
        let before = held.metadata().map_err(|_| INVALID.to_owned())?;
        let mut result = Self {
            selected,
            root: root.clone(),
            pins: BTreeMap::from([(
                PathBuf::from("/"),
                Pin {
                    held,
                    before,
                    enumerated: false,
                },
            )]),
            budget: ObservationBudget::default(),
            cancelled,
        };
        let mut parent = PathBuf::from("/");
        for part in root.components() {
            require_active(cancelled)?;
            if let Component::Normal(name) = part {
                result.child(&parent, Path::new(name), true)?;
                parent.push(name);
            }
        }
        result.assert_current()?;
        Ok(result)
    }
    fn child(&mut self, parent: &Path, name: &Path, directory: bool) -> Result<PathBuf, String> {
        require_active(self.cancelled)?;
        if name.components().count() != 1
            || !matches!(name.components().next(), Some(Component::Normal(_)))
        {
            return Err(INVALID.to_owned());
        }
        let path = parent.join(name);
        if let Some(pin) = self.pins.get(&path) {
            pin.assert_current(&path)?;
            if pin.before.is_dir() != directory {
                return Err(INVALID.to_owned());
            }
            return Ok(path);
        }
        if self.pins.len() >= MAX_SEED_ENTRIES + MAX_SEED_DEPTH + 16 {
            return Err(BOUND.to_owned());
        }
        let parent_pin = self.pins.get(parent).ok_or_else(|| INVALID.to_owned())?;
        parent_pin.assert_current(parent)?;
        let flags = OFlag::O_NOFOLLOW
            | OFlag::O_NONBLOCK
            | OFlag::O_CLOEXEC
            | if directory {
                OFlag::O_DIRECTORY | OFlag::O_PATH
            } else {
                OFlag::O_RDONLY
            };
        let held = File::from(
            openat(parent_pin.held.as_fd(), name, flags, Mode::empty())
                .map_err(|e| format!("r_runtime_source_cas_unavailable:{e}"))?,
        );
        let before = held.metadata().map_err(|_| INVALID.to_owned())?;
        if (directory && !before.is_dir())
            || (!directory && (!before.is_file() || before.nlink() != 1))
        {
            return Err(INVALID.to_owned());
        }
        let pin = Pin {
            held,
            before,
            enumerated: false,
        };
        pin.assert_current(&path)?;
        self.pins.insert(path.clone(), pin);
        Ok(path)
    }
    fn relative(&mut self, relative: &Path, directory: bool) -> Result<PathBuf, String> {
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(INVALID.to_owned());
        }
        let parts: Vec<_> = relative.components().collect();
        if parts.len() > MAX_SEED_DEPTH {
            return Err(BOUND.to_owned());
        }
        let mut current = self.root.clone();
        for (index, part) in parts.iter().enumerate() {
            let Component::Normal(name) = part else {
                return Err(INVALID.to_owned());
            };
            current = self.child(
                &current,
                Path::new(name),
                directory || index + 1 < parts.len(),
            )?;
        }
        Ok(current)
    }
    fn read(
        &mut self,
        relative: &Path,
        maximum: u64,
        retain: bool,
    ) -> Result<(Vec<u8>, String, u64), String> {
        let path = self.relative(relative, false)?;
        let pin = self.pins.get(&path).ok_or_else(|| INVALID.to_owned())?;
        let expected = pin.before.len();
        self.budget.account(expected, maximum)?;
        let mut output = Vec::new();
        let mut digest = Sha256::new();
        let mut offset = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            require_active(self.cancelled)?;
            // Read at most the captured size plus one byte: an append cannot
            // extend either memory or I/O indefinitely while being observed.
            let bound = usize::try_from(
                expected
                    .saturating_sub(offset)
                    .saturating_add(1)
                    .min(buffer.len() as u64),
            )
            .map_err(|_| BOUND.to_owned())?;
            let count = match pin.held.read_at(&mut buffer[..bound], offset) {
                Ok(count) => count,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(INVALID.to_owned()),
            };
            if count == 0 {
                break;
            }
            offset = offset
                .checked_add(count as u64)
                .filter(|n| *n <= expected)
                .ok_or_else(|| CHANGED.to_owned())?;
            digest.update(&buffer[..count]);
            if retain {
                output.extend_from_slice(&buffer[..count]);
            }
        }
        if offset != expected {
            return Err(CHANGED.to_owned());
        }
        pin.assert_current(&path)?;
        require_active(self.cancelled)?;
        Ok((output, format!("sha256:{:x}", digest.finalize()), offset))
    }
    pub(super) fn document(&mut self, relative: &Path) -> Result<Vec<u8>, String> {
        self.read(relative, MAX_DOCUMENT_BYTES, true).map(|v| v.0)
    }
    pub(super) fn archive(
        &mut self,
        relative: &Path,
        maximum: u64,
    ) -> Result<(String, u64), String> {
        self.read(relative, maximum, false).map(|v| (v.1, v.2))
    }
    fn walk(
        &mut self,
        path: &Path,
        relative: &str,
        depth: usize,
        remaining: &mut usize,
        output: &mut Vec<String>,
    ) -> Result<(), String> {
        require_active(self.cancelled)?;
        if depth > MAX_SEED_DEPTH {
            return Err("r_runtime_source_cas_observation_depth_exceeded".to_owned());
        }
        let pin = self.pins.get_mut(path).ok_or_else(|| INVALID.to_owned())?;
        pin.assert_current(path)?;
        if !pin.enumerated {
            // Earlier file reads pin parent identity, not its changing child
            // inventory. Capture the namespace baseline exactly when this
            // directory is first enumerated; never rebase a sealed inventory.
            pin.before = pin.held.metadata().map_err(|_| INVALID.to_owned())?;
            pin.enumerated = true;
            pin.assert_current(path)?;
        }
        let mut directory = Dir::openat(
            pin.held.as_fd(),
            Path::new("."),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| INVALID.to_owned())?;
        for entry in directory.iter() {
            require_active(self.cancelled)?;
            let entry = entry.map_err(|_| INVALID.to_owned())?;
            let name = entry.file_name().to_bytes();
            if name == b"." || name == b".." {
                continue;
            }
            *remaining = remaining.checked_sub(1).ok_or_else(|| BOUND.to_owned())?;
            let name = std::str::from_utf8(name).map_err(|_| INVALID.to_owned())?;
            if relative.is_empty() && matches!(name, ".git" | ".gitattributes") {
                continue;
            }
            let parent = self.pins.get(path).ok_or_else(|| INVALID.to_owned())?;
            let probe = File::from(
                openat(
                    parent.held.as_fd(),
                    Path::new(name),
                    OFlag::O_PATH | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|_| CHANGED.to_owned())?,
            );
            let metadata = probe.metadata().map_err(|_| INVALID.to_owned())?;
            if !metadata.is_dir() && !metadata.is_file() {
                return Err(INVALID.to_owned());
            }
            let child_path = self.child(path, Path::new(name), metadata.is_dir())?;
            let current = self
                .pins
                .get(&child_path)
                .ok_or_else(|| CHANGED.to_owned())?;
            if !identity(&metadata, &current.before) {
                return Err(CHANGED.to_owned());
            }
            let child = if relative.is_empty() {
                name.to_owned()
            } else {
                format!("{relative}/{name}")
            };
            if metadata.is_dir() {
                self.walk(&child_path, &child, depth + 1, remaining, output)?;
            } else {
                output.push(child);
            }
        }
        let pin = self.pins.get_mut(path).ok_or_else(|| INVALID.to_owned())?;
        pin.enumerated = true;
        pin.assert_current(path)
    }
    pub(super) fn files(&mut self, relative: &Path) -> Result<Vec<String>, String> {
        let path = self.relative(relative, true)?;
        let mut files = Vec::new();
        let mut remaining = MAX_SEED_ENTRIES;
        self.walk(&path, "", 0, &mut remaining, &mut files)?;
        Ok(files)
    }
    pub(super) fn assert_current(&self) -> Result<(), String> {
        require_active(self.cancelled)?;
        if fs::canonicalize(&self.selected).ok().as_ref() != Some(&self.root) {
            return Err(CHANGED.to_owned());
        }
        for (path, pin) in &self.pins {
            require_active(self.cancelled)?;
            pin.assert_current(path)?;
        }
        require_active(self.cancelled)
    }
}

#[cfg(test)]
mod tests;
