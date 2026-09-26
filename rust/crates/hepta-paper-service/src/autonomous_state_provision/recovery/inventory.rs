//! Retained, bounded byte inventory. No SQLite handle or reconstructed ready flag.
use super::{Result, error};
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, Metadata},
    io::{Read, Seek, SeekFrom},
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::Path,
};
const INVALID: &str = "autonomous_state_provisioning_recovery_inventory_invalid";
const FILE_BOUND: u64 = 32 * 1024 * 1024;
const TOTAL_BOUND: u64 = 129 * 1024 * 1024;
const MAX_ENTRIES: usize = 64;
fn flags() -> OFlag {
    OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK
}
fn identity(m: &Metadata) -> Value {
    json!({"device":m.dev(),"inode":m.ino(),"mode":m.mode(),"uid":m.uid(),"gid":m.gid(),"links":m.nlink()})
}
fn file_identity(m: &Metadata) -> Value {
    json!({"identity":identity(m),"bytes":m.len(),"mtime":m.mtime(),"mtimeNs":m.mtime_nsec(),
        "ctime":m.ctime(),"ctimeNs":m.ctime_nsec()})
}
fn private(m: &Metadata, directory: bool, device: u64) -> Result<()> {
    if m.dev() != device
        || m.uid() != nix::unistd::geteuid().as_raw()
        || m.mode() & 0o7777 != if directory { 0o700 } else { 0o600 }
        || if directory {
            !m.is_dir()
        } else {
            !m.is_file() || m.nlink() != 1
        }
    {
        return Err(error(INVALID));
    }
    Ok(())
}
fn hash(file: &mut File, before: &Metadata) -> Result<String> {
    if before.len() > FILE_BOUND {
        return Err(error(INVALID));
    }
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 32768];
    let mut count = 0u64;
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        count = count.checked_add(n as u64).ok_or_else(|| error(INVALID))?;
        if count > before.len() {
            return Err(error(INVALID));
        }
        hasher.update(&buffer[..n]);
    }
    if count != before.len() || file_identity(&file.metadata()?) != file_identity(before) {
        return Err(error(INVALID));
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}
struct ObservedFile {
    file: File,
    metadata: Metadata,
    sha256: String,
}
pub(in crate::autonomous_state_provision) struct Snapshot {
    dirs: BTreeMap<String, (File, Metadata)>,
    files: BTreeMap<String, ObservedFile>,
}
fn allowed() -> Result<(BTreeSet<String>, BTreeSet<String>)> {
    let manifest: Value = serde_json::from_str(include_str!(
        "../../../../../../paper-core/config/autonomous-research-state-databases.v1.json"
    ))?;
    let rows = manifest["databases"]
        .as_array()
        .ok_or_else(|| error(INVALID))?;
    let mut files = BTreeSet::from(["native-provisioning-receipt.json".to_owned()]);
    let mut dirs = BTreeSet::from([String::new()]);
    for row in rows {
        let path = row["relativePath"].as_str().ok_or_else(|| error(INVALID))?;
        files.insert(path.to_owned());
        let mut ancestor = Path::new(path).parent();
        while let Some(parent) = ancestor {
            if parent.as_os_str().is_empty() {
                break;
            }
            dirs.insert(parent.to_str().ok_or_else(|| error(INVALID))?.to_owned());
            ancestor = parent.parent();
        }
    }
    Ok((dirs, files))
}
impl Snapshot {
    pub fn capture(root: &Path, device: u64) -> Result<Self> {
        Self::capture_profile(root, device, false)
    }
    pub fn capture_published(root: &Path, device: u64) -> Result<Self> {
        Self::capture_profile(root, device, true)
    }
    fn capture_profile(root: &Path, device: u64, published: bool) -> Result<Self> {
        let root_file = File::from(
            open(root, flags() | OFlag::O_DIRECTORY, Mode::empty()).map_err(|_| error(INVALID))?,
        );
        let root_meta = root_file.metadata()?;
        private(&root_meta, true, device)?;
        let (allowed_dirs, mut allowed_files) = allowed()?;
        if published {
            allowed_files.insert("native-provisioning-publication.json".to_owned());
        }
        let mut result = Self {
            dirs: BTreeMap::from([(String::new(), (root_file, root_meta))]),
            files: BTreeMap::new(),
        };
        let mut queue = BTreeSet::from([String::new()]);
        let mut total = 0u64;
        while let Some(relative) = queue.pop_first() {
            let path = root.join(&relative);
            let expected = &result.dirs[&relative].1;
            if identity(&fs::symlink_metadata(&path)?) != identity(expected) {
                return Err(error(INVALID));
            }
            for (index, entry) in fs::read_dir(path)?.enumerate() {
                if index >= MAX_ENTRIES || result.dirs.len() + result.files.len() >= MAX_ENTRIES {
                    return Err(error(INVALID));
                }
                let entry = entry?;
                let name = entry.file_name();
                let name = name.to_str().ok_or_else(|| error(INVALID))?;
                let full = if relative.is_empty() {
                    name.to_owned()
                } else {
                    format!("{relative}/{name}")
                };
                let directory = allowed_dirs.contains(&full);
                if !directory && !allowed_files.contains(&full) {
                    return Err(error(INVALID));
                }
                let parent = &result.dirs[&relative].0;
                let mut file = File::from(
                    openat(
                        parent.as_fd(),
                        name,
                        flags()
                            | if directory {
                                OFlag::O_DIRECTORY
                            } else {
                                OFlag::empty()
                            },
                        Mode::empty(),
                    )
                    .map_err(|_| error(INVALID))?,
                );
                let metadata = file.metadata()?;
                private(&metadata, directory, device)?;
                if directory {
                    result.dirs.insert(full.clone(), (file, metadata));
                    queue.insert(full);
                } else {
                    let limit = if full == "native-provisioning-receipt.json"
                        || full == "native-provisioning-publication.json"
                    {
                        1024 * 1024
                    } else {
                        FILE_BOUND
                    };
                    total = total
                        .checked_add(metadata.len())
                        .ok_or_else(|| error(INVALID))?;
                    if metadata.len() > limit || total > TOTAL_BOUND {
                        return Err(error(INVALID));
                    }
                    let sha256 = hash(&mut file, &metadata)?;
                    result.files.insert(
                        full,
                        ObservedFile {
                            file,
                            metadata,
                            sha256,
                        },
                    );
                }
            }
        }
        result.verify(root)?;
        Ok(result)
    }
    pub fn observation(&self) -> Value {
        json!({"directories":self.dirs.iter().map(|(path,(_,meta))|json!({"path":path,"identity":identity(meta)})).collect::<Vec<_>>(),
            "files":self.files.iter().map(|(path,file)|json!({"path":path,"identity":file_identity(&file.metadata),"sha256":file.sha256})).collect::<Vec<_>>()})
    }
    pub fn publication_observation(&self) -> Value {
        let mut value = self.observation();
        if let Some(files) = value["files"].as_array_mut() {
            files.retain(|file| file["path"] != "native-provisioning-publication.json");
        }
        value
    }
    pub fn read_document(&mut self, name: &str) -> Result<Option<Value>> {
        let Some(file) = self.files.get_mut(name) else {
            return Ok(None);
        };
        if file.metadata.len() > 1024 * 1024 {
            return Err(error(INVALID));
        }
        file.file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        (&mut file.file)
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 != file.metadata.len()
            || format!("sha256:{:x}", Sha256::digest(&bytes)) != file.sha256
        {
            return Err(error(INVALID));
        }
        // Validate duplicate keys and bounded JSON first, then preserve the
        // original serde number representation (1.0 must not become integer 1)
        // so the recovered terminal is byte-identical to the original publisher.
        crate::sqlite_mutation_coordinator::authority::files::parse(&bytes, INVALID)
            .map_err(|_| error(INVALID))?;
        Ok(Some(serde_json::from_slice(&bytes)?))
    }
    pub fn root_directory(&self) -> Result<&File> {
        self.dirs
            .get("")
            .map(|(file, _)| file)
            .ok_or_else(|| error(INVALID))
    }
    pub fn verify(&mut self, root: &Path) -> Result<()> {
        let expected = self
            .dirs
            .keys()
            .filter(|s| !s.is_empty())
            .chain(self.files.keys())
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut names = BTreeSet::new();
        for (relative, (file, meta)) in &self.dirs {
            let path = root.join(relative);
            if identity(&file.metadata()?) != identity(meta)
                || identity(&fs::symlink_metadata(&path)?) != identity(meta)
            {
                return Err(error(INVALID));
            }
            for (index, entry) in fs::read_dir(&path)?.enumerate() {
                if index >= MAX_ENTRIES {
                    return Err(error(INVALID));
                }
                let name = entry?.file_name();
                let name = name.to_str().ok_or_else(|| error(INVALID))?;
                names.insert(if relative.is_empty() {
                    name.to_owned()
                } else {
                    format!("{relative}/{name}")
                });
            }
        }
        if names != expected {
            return Err(error(INVALID));
        }
        for (relative, file) in &mut self.files {
            if file_identity(&fs::symlink_metadata(root.join(relative))?)
                != file_identity(&file.metadata)
                || file_identity(&file.file.metadata()?) != file_identity(&file.metadata)
                || hash(&mut file.file, &file.metadata)? != file.sha256
            {
                return Err(error(INVALID));
            }
        }
        // Names are checked again after reading; a retained fd cannot prove its
        // original name still resolves to that object without this observation.
        for (relative, (file, meta)) in &self.dirs {
            if identity(&fs::symlink_metadata(root.join(relative))?) != identity(meta)
                || identity(&file.metadata()?) != identity(meta)
            {
                return Err(error(INVALID));
            }
        }
        Ok(())
    }
    pub fn flush(&self) -> Result<()> {
        for file in self.files.values() {
            file.file.sync_all()?;
        }
        for (file, _) in self.dirs.values().rev() {
            file.sync_all()?;
        }
        Ok(())
    }
}
