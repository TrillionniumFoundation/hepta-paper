//! Private fallback receipt publication for the Node --check --write branch.

use nix::{
    fcntl::{OFlag, RenameFlags, open, openat, renameat2},
    sys::stat::{Mode, fchmod, mkdirat},
    unistd::{UnlinkatFlags, geteuid, unlinkat},
};
use std::{
    fs::{self, File},
    io::{self, Write},
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::{Component, Path},
};

fn blocked() -> io::Error {
    io::Error::other("personal_gpu_receipt_publication_blocked")
}

fn private_parent(path: &Path) -> io::Result<File> {
    if !path.is_absolute() || path == Path::new("/") {
        return Err(blocked());
    }
    let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let mut directory = open(Path::new("/"), flags, Mode::empty())?;
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                let name = Path::new(name);
                directory = match openat(&directory, name, flags, Mode::empty()) {
                    Ok(opened) => opened,
                    Err(nix::errno::Errno::ENOENT) => {
                        match mkdirat(&directory, name, Mode::from_bits_truncate(0o700)) {
                            Ok(()) | Err(nix::errno::Errno::EEXIST) => {}
                            Err(error) => return Err(error.into()),
                        }
                        let created = openat(&directory, name, flags, Mode::empty())?;
                        fchmod(&created, Mode::from_bits_truncate(0o700))?;
                        created
                    }
                    Err(error) => return Err(error.into()),
                };
            }
            _ => return Err(blocked()),
        }
    }
    let directory = File::from(directory);
    verify_parent(path, &directory)?;
    Ok(directory)
}

fn verify_parent(path: &Path, held: &File) -> io::Result<()> {
    let opened = held.metadata()?;
    let named = fs::symlink_metadata(path)?;
    if !named.is_dir()
        || named.file_type().is_symlink()
        || named.dev() != opened.dev()
        || named.ino() != opened.ino()
        || named.mode() != opened.mode()
        || opened.uid() != geteuid().as_raw()
        || opened.mode() & 0o077 != 0
        || fs::canonicalize(path)? != path
    {
        return Err(blocked());
    }
    Ok(())
}

fn write_with_hook(path: &Path, json: &str, before_rename: impl FnOnce()) -> io::Result<()> {
    let parent = path.parent().ok_or_else(blocked)?;
    let basename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(blocked)?;
    let directory = private_parent(parent)?;
    let temporary = format!(".{basename}.{}.tmp", std::process::id());
    let temporary = Path::new(&temporary);
    let mut file = File::from(openat(
        directory.as_fd(),
        temporary,
        OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_WRONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::from_bits_truncate(0o400),
    )?);
    let result = (|| {
        file.write_all(json.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fchmod(&file, Mode::from_bits_truncate(0o400))?;
        before_rename();
        verify_parent(parent, &directory)?;
        renameat2(
            directory.as_fd(),
            temporary,
            directory.as_fd(),
            Path::new(basename),
            RenameFlags::empty(),
        )?;
        directory.sync_all()?;
        verify_parent(parent, &directory)
    })();
    // Only remove the temporary file created by this invocation. An existing
    // temp collision returned before entering this scope and is never touched.
    if result.is_err() {
        let _ = unlinkat(directory.as_fd(), temporary, UnlinkatFlags::NoRemoveDir);
    }
    result
}

/// Atomically publish JSON in an owner-only directory with a read-only leaf.
/// CLI callers invoke this only after a failed --check with explicit --write.
pub fn write_personal_gpu_receipt_v1(path: &Path, json: &str) -> io::Result<()> {
    write_with_hook(path, json, || {})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    #[test]
    fn publication_rejects_parent_rebind_and_cleans_own_temporary() {
        let root =
            std::env::temp_dir().join(format!("hepta-gpu-publish-rebind-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let parent = root.join("parent");
        let moved = root.join("moved");
        let path = parent.join("receipt.json");
        let result = write_with_hook(&path, "{}", || {
            fs::rename(&parent, &moved).unwrap();
            symlink(&moved, &parent).unwrap();
        });
        assert!(result.is_err());
        assert_eq!(fs::read_dir(&moved).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
}
