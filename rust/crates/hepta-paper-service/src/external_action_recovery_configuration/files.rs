use super::{INVALID, Result, value::ensure};
use nix::{
    fcntl::{OFlag, open, openat},
    sys::stat::Mode,
    unistd::getuid,
};
use std::{
    fs::{self, File, Metadata},
    os::{
        fd::AsFd,
        unix::fs::{FileExt, MetadataExt},
    },
    path::{Component, Path, PathBuf},
};
const MAXIMUM_BYTES: u64 = 256 * 1024;
const UNAVAILABLE: &str =
    "autonomous_research_supervisor_external_action_recovery_configuration_file_unavailable";
const CHANGED: &str =
    "autonomous_research_supervisor_external_action_recovery_configuration_changed";
const PATH_UNSUPPORTED: &str =
    "autonomous_research_supervisor_external_action_recovery_path_profile_unsupported";

pub(super) fn absolute(path: &Path, cwd: &Path) -> Result<PathBuf> {
    ensure(cwd.is_absolute(), PATH_UNSUPPORTED)?;
    let joined = if path.is_absolute() {
        path.to_owned()
    } else {
        cwd.join(path)
    };
    let text = joined.to_str().ok_or_else(|| PATH_UNSUPPORTED.to_owned())?;
    ensure(
        !text.contains('\0') && text.len() <= 4096 && joined.components().count() <= 128,
        PATH_UNSUPPORTED,
    )?;
    let mut output = PathBuf::from("/");
    for part in joined.components() {
        match part {
            Component::RootDir | Component::CurDir => (),
            Component::ParentDir => {
                output.pop();
            }
            Component::Normal(part) => output.push(part),
            _ => return Err(PATH_UNSUPPORTED.to_owned()),
        }
    }
    Ok(output)
}

pub(super) struct ObservedConfiguration {
    path: PathBuf,
    file: File,
    original: Metadata,
    bytes: Vec<u8>,
    parents: Vec<(PathBuf, File, Metadata)>,
}
impl ObservedConfiguration {
    pub fn capture(path: &Path) -> Result<Self> {
        ensure(path.is_absolute(), PATH_UNSUPPORTED)?;
        ensure(
            fs::canonicalize(path).map_err(|_| UNAVAILABLE.to_owned())? == path,
            INVALID,
        )?;
        let initial = fs::symlink_metadata(path).map_err(|_| UNAVAILABLE.to_owned())?;
        safe_file(&initial)?;
        let flags = OFlag::O_PATH | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let mut directory = File::from(
            open(Path::new("/"), flags, Mode::empty()).map_err(|_| UNAVAILABLE.to_owned())?,
        );
        let mut cursor = PathBuf::from("/");
        let mut parents = Vec::new();
        let parent_path = path.parent().ok_or_else(|| INVALID.to_owned())?;
        for part in parent_path.components() {
            let Component::Normal(part) = part else {
                continue;
            };
            let next = File::from(
                openat(directory.as_fd(), Path::new(part), flags, Mode::empty())
                    .map_err(|_| INVALID.to_owned())?,
            );
            let metadata = directory.metadata().map_err(|_| UNAVAILABLE.to_owned())?;
            parents.push((cursor.clone(), directory, metadata));
            cursor.push(part);
            directory = next;
        }
        let leaf = path.file_name().ok_or_else(|| INVALID.to_owned())?;
        let file = File::from(
            openat(
                directory.as_fd(),
                Path::new(leaf),
                OFlag::O_RDONLY | OFlag::O_NONBLOCK | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
                Mode::empty(),
            )
            .map_err(|_| INVALID.to_owned())?,
        );
        let original = file.metadata().map_err(|_| UNAVAILABLE.to_owned())?;
        safe_file(&original)?;
        ensure(same_file(&initial, &original), CHANGED)?;
        let bytes = read_bounded(&file, original.len())?;
        let metadata = directory.metadata().map_err(|_| UNAVAILABLE.to_owned())?;
        parents.push((cursor, directory, metadata));
        let result = Self {
            path: path.to_owned(),
            file,
            original,
            bytes,
            parents,
        };
        result.assert_current()?;
        Ok(result)
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn assert_current(&self) -> Result<()> {
        self.assert_namespace()?;
        ensure(
            read_bounded(&self.file, self.original.len())? == self.bytes,
            CHANGED,
        )?;
        self.assert_namespace()
    }
    fn assert_namespace(&self) -> Result<()> {
        for (path, file, original) in &self.parents {
            let named = fs::symlink_metadata(path).map_err(|_| CHANGED.to_owned())?;
            let held = file.metadata().map_err(|_| CHANGED.to_owned())?;
            ensure(
                same_directory(original, &named) && same_directory(original, &held),
                CHANGED,
            )?;
        }
        let held = self.file.metadata().map_err(|_| CHANGED.to_owned())?;
        let named = fs::symlink_metadata(&self.path).map_err(|_| CHANGED.to_owned())?;
        safe_file(&held)?;
        safe_file(&named)?;
        ensure(
            same_file(&self.original, &held) && same_file(&self.original, &named),
            CHANGED,
        )
    }
}
fn safe_file(metadata: &Metadata) -> Result<()> {
    ensure(
        metadata.is_file()
            && !metadata.is_symlink()
            && metadata.nlink() == 1
            && metadata.uid() == getuid().as_raw()
            && metadata.mode() & 0o077 == 0
            && (2..=MAXIMUM_BYTES).contains(&metadata.len()),
        INVALID,
    )
}
fn read_bounded(file: &File, expected: u64) -> Result<Vec<u8>> {
    ensure((2..=MAXIMUM_BYTES).contains(&expected), INVALID)?;
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut offset = 0u64;
    loop {
        let remaining = expected + 1 - offset;
        let limit =
            usize::try_from(remaining.min(buffer.len() as u64)).map_err(|_| CHANGED.to_owned())?;
        let count = file
            .read_at(&mut buffer[..limit], offset)
            .map_err(|_| UNAVAILABLE.to_owned())?;
        if count == 0 {
            break;
        }
        offset += count as u64;
        ensure(offset <= expected, CHANGED)?;
        bytes.extend_from_slice(&buffer[..count]);
    }
    ensure(offset == expected, CHANGED)?;
    Ok(bytes)
}
fn same_directory(before: &Metadata, now: &Metadata) -> bool {
    now.is_dir()
        && !now.is_symlink()
        && before.dev() == now.dev()
        && before.ino() == now.ino()
        && before.uid() == now.uid()
        && before.gid() == now.gid()
        && before.mode() == now.mode()
}
fn same_file(before: &Metadata, now: &Metadata) -> bool {
    now.is_file()
        && !now.is_symlink()
        && before.dev() == now.dev()
        && before.ino() == now.ino()
        && before.uid() == now.uid()
        && before.gid() == now.gid()
        && before.mode() == now.mode()
        && before.nlink() == now.nlink()
        && before.len() == now.len()
        && before.mtime() == now.mtime()
        && before.mtime_nsec() == now.mtime_nsec()
        && before.ctime() == now.ctime()
        && before.ctime_nsec() == now.ctime_nsec()
}
