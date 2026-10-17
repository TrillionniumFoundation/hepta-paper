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

fn private_parent(
    path: &Path,
    controlled: bool,
    mut before_create: impl FnMut(&Path),
) -> io::Result<File> {
    if !path.is_absolute() || path == Path::new("/") {
        return Err(blocked());
    }
    let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let mut directory = open(Path::new("/"), flags, Mode::empty())?;
    let mut current = std::path::PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                current.push(name);
                let name = Path::new(name);
                directory = match openat(&directory, name, flags, Mode::empty()) {
                    Ok(opened) => opened,
                    Err(nix::errno::Errno::ENOENT) => {
                        before_create(&current);
                        match mkdirat(&directory, name, Mode::from_bits_truncate(0o700)) {
                            Ok(()) => {}
                            // Controlled publication never chmods or adopts a
                            // directory created by another actor in this gap.
                            Err(nix::errno::Errno::EEXIST) if !controlled => {}
                            Err(error) => return Err(error.into()),
                        }
                        let created = openat(&directory, name, flags, Mode::empty())?;
                        if controlled {
                            let metadata = File::from(created.try_clone()?).metadata()?;
                            if !metadata.is_dir()
                                || metadata.uid() != geteuid().as_raw()
                                || metadata.mode() & 0o077 != 0
                            {
                                return Err(blocked());
                            }
                        }
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

/// This only carries the original observed target. It neither grants authority
/// nor permits publication to rebase onto a newly observed foreign generation.
pub(crate) enum PersonalGpuPublicationInputV1<'a, 'control> {
    Existing(&'a super::files::RetainedPersonalGpuReceiptV1),
    Missing(&'a super::files::MissingPersonalGpuReceiptV1<'control>),
}
impl PersonalGpuPublicationInputV1<'_, '_> {
    fn path(&self) -> &Path {
        match self {
            Self::Existing(v) => v.publication_path(),
            Self::Missing(v) => v.publication_path(),
        }
    }
    fn require_control(
        &self,
        cancelled: &std::sync::atomic::AtomicBool,
        deadline: std::time::Instant,
    ) -> io::Result<()> {
        match self {
            Self::Existing(v) => v.require_publication_control(cancelled, deadline),
            Self::Missing(v) => v.require_publication_control(cancelled, deadline),
        }
        .map_err(io::Error::other)
    }
    fn before_own_namespace(&self) -> io::Result<()> {
        match self {
            Self::Existing(v) => v.assert_current(),
            Self::Missing(v) => v.assert_current(),
        }
        .map_err(io::Error::other)
    }
    fn parent_already_existed(&self) -> bool {
        match self {
            Self::Existing(_) => true,
            Self::Missing(v) => v.parent_exists(),
        }
    }
    fn original_metadata(&self) -> Option<std::fs::Metadata> {
        match self {
            Self::Existing(v) => Some(v.publication_metadata().clone()),
            Self::Missing(_) => None,
        }
    }
    fn assert_leaf(&self, path: &Path, parent: &File) -> io::Result<()> {
        match self {
            Self::Existing(v) => v.assert_publication_leaf(path, parent),
            Self::Missing(v) => v.assert_publication_leaf(path, parent),
        }
        .map_err(io::Error::other)
    }
}

fn write_with_control_hook(
    path: &Path,
    json: &str,
    check: impl Fn() -> io::Result<()>,
    before_rename: impl FnOnce(),
    controlled: bool,
    original_input: Option<PersonalGpuPublicationInputV1<'_, '_>>,
    before_parent_create: impl FnMut(&Path),
) -> io::Result<()> {
    check()?;
    let parent = path.parent().ok_or_else(blocked)?;
    let basename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(blocked)?;
    if let Some(input) = &original_input {
        input.before_own_namespace()?;
    }
    let directory = private_parent(parent, controlled, before_parent_create)?;
    check()?;
    if let Some(input) = &original_input {
        // A genuinely missing ancestor may be created by this owner. For an
        // already existing parent, its original full epoch is still required
        // immediately before our first temp namespace transition.
        if input.parent_already_existed() {
            input.before_own_namespace()?;
        }
        input.assert_leaf(path, &directory)?;
    }
    let target_before = if let Some(input) = &original_input {
        input.original_metadata()
    } else if controlled {
        match fs::symlink_metadata(path) {
            Ok(value)
                if value.is_file() && !value.file_type().is_symlink() && value.nlink() == 1 =>
            {
                Some(value)
            }
            Ok(_) => return Err(blocked()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(_) => return Err(blocked()),
        }
    } else {
        None
    };
    let temporary = format!(".{basename}.{}.tmp", std::process::id());
    let temporary = Path::new(&temporary);
    let mut file = File::from(openat(
        directory.as_fd(),
        temporary,
        OFlag::O_CREAT
            | OFlag::O_EXCL
            | if controlled {
                OFlag::O_RDWR
            } else {
                OFlag::O_WRONLY
            }
            | OFlag::O_NOFOLLOW
            | OFlag::O_CLOEXEC,
        Mode::from_bits_truncate(0o400),
    )?);
    // The one expected namespace transition has already created our temp.
    // No caller proof or timestamp restoration can rebase this generation.
    let parent_after_temp = if controlled {
        Some(directory.metadata()?)
    } else {
        None
    };
    let mut completed_temp_identity = None;
    let result = (|| {
        check()?;
        file.write_all(json.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fchmod(&file, Mode::from_bits_truncate(0o400))?;
        if controlled {
            completed_temp_identity = Some(file.metadata()?);
        }
        before_rename();
        check()?;
        verify_parent(parent, &directory)?;
        if let Some(input) = &original_input {
            input.assert_leaf(path, &directory)?;
        }
        if let Some(expected) = &completed_temp_identity {
            let named = fs::symlink_metadata(parent.join(temporary))?;
            if !super::files::same_full(expected, &file.metadata()?)
                || !super::files::same_full(expected, &named)
            {
                return Err(blocked());
            }
            use std::os::unix::fs::FileExt;
            let mut buffer = [0u8; 64 * 1024];
            let mut offset = 0usize;
            while offset < json.len() {
                check()?;
                let n = (json.len() - offset).min(buffer.len());
                file.read_exact_at(&mut buffer[..n], offset as u64)?;
                if buffer[..n] != json.as_bytes()[offset..offset + n] {
                    return Err(blocked());
                }
                offset += n;
            }
            let mut newline = [0u8];
            file.read_exact_at(&mut newline, json.len() as u64)?;
            if newline != *b"\n"
                || expected.len() != json.len() as u64 + 1
                || !super::files::same_full(expected, &file.metadata()?)
                || !super::files::same_full(
                    expected,
                    &fs::symlink_metadata(parent.join(temporary))?,
                )
            {
                return Err(blocked());
            }
        }
        if let Some(expected_parent) = &parent_after_temp {
            if !super::files::same_full(expected_parent, &directory.metadata()?)
                || !super::files::same_full(expected_parent, &fs::symlink_metadata(parent)?)
            {
                return Err(blocked());
            }
            match (&target_before, fs::symlink_metadata(path)) {
                (Some(expected), Ok(current)) if super::files::same_full(expected, &current) => (),
                (None, Err(error)) if error.kind() == io::ErrorKind::NotFound => (),
                _ => return Err(blocked()),
            }
        }
        renameat2(
            directory.as_fd(),
            temporary,
            directory.as_fd(),
            Path::new(basename),
            RenameFlags::empty(),
        )?;
        directory.sync_all()?;
        check()?;
        verify_parent(parent, &directory)
    })();
    // Only remove the temporary file created by this invocation. An existing
    // temp collision returned before entering this scope and is never touched.
    if result.is_err() {
        // Old None cleanup stays intact. Controlled publication deletes only
        // its completed, still-current own temporary generation; unknown
        // replacement/in-place mutation or incomplete writes remain observable.
        let cleanup_known = !controlled
            || completed_temp_identity.as_ref().is_some_and(|expected| {
                file.metadata()
                    .ok()
                    .zip(fs::symlink_metadata(parent.join(temporary)).ok())
                    .is_some_and(|(held, named)| {
                        super::files::same_full(expected, &held)
                            && super::files::same_full(expected, &named)
                    })
            });
        if cleanup_known {
            let _ = unlinkat(directory.as_fd(), temporary, UnlinkatFlags::NoRemoveDir);
        }
    }
    result
}

fn write_with_hook(path: &Path, json: &str, before_rename: impl FnOnce()) -> io::Result<()> {
    write_with_control_hook(path, json, || Ok(()), before_rename, false, None, |_| {})
}

#[cfg(test)]
pub(crate) fn write_personal_gpu_receipt_with_control_v1(
    path: &Path,
    json: &str,
    cancelled: &std::sync::atomic::AtomicBool,
    deadline: std::time::Instant,
) -> io::Result<()> {
    if json.len() >= 4 * 1024 * 1024 {
        return Err(blocked());
    }
    write_with_control_hook(
        path,
        json,
        || super::files::gpu_check_active_v1(cancelled, deadline).map_err(io::Error::other),
        || {},
        true,
        None,
        |_| {},
    )
}

pub(crate) fn write_personal_gpu_receipt_for_observed_input_v1(
    path: &Path,
    json: &str,
    cancelled: &std::sync::atomic::AtomicBool,
    deadline: std::time::Instant,
    input: PersonalGpuPublicationInputV1<'_, '_>,
) -> io::Result<()> {
    input.require_control(cancelled, deadline)?;
    if path != input.path() {
        return Err(blocked());
    }
    if json.len() >= 4 * 1024 * 1024 {
        return Err(blocked());
    }
    write_with_control_hook(
        path,
        json,
        || super::files::gpu_check_active_v1(cancelled, deadline).map_err(io::Error::other),
        || {},
        true,
        Some(input),
        |_| {},
    )
}

/// Atomically publish JSON in an owner-only directory with a read-only leaf.
/// CLI callers invoke this only after a failed --check with explicit --write.
pub fn write_personal_gpu_receipt_v1(path: &Path, json: &str) -> io::Result<()> {
    write_with_hook(path, json, || {})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
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
    #[test]
    fn controlled_publication_retains_foreign_leaf_and_missing_edge_epoch_then_fresh_retry() {
        let root =
            std::env::temp_dir().join(format!("hepta-gpu-publish-control-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("receipt.json");
        fs::write(&path, b"initial").unwrap();
        let result = write_with_control_hook(
            &path,
            "{}",
            || Ok(()),
            || {
                let foreign = root.join("foreign");
                fs::write(&foreign, b"foreign-unknown").unwrap();
                fs::rename(foreign, &path).unwrap();
            },
            true,
            None,
            |_| {},
        );
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"foreign-unknown");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_file(&path).unwrap();
        let result = write_with_control_hook(
            &path,
            "{}",
            || Ok(()),
            || {
                fs::write(&path, b"created-then-removed").unwrap();
                fs::remove_file(&path).unwrap();
            },
            true,
            None,
            |_| {},
        );
        assert!(result.is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        write_with_control_hook(&path, "{}", || Ok(()), || {}, true, None, |_| {}).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{}\n");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn ordinary_handoff_keeps_original_invalid_receipt_generation() {
        let root =
            std::env::temp_dir().join(format!("hepta-gpu-handoff-present-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("receipt.json");
        fs::write(&path, b"{").unwrap();
        let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        let input = super::super::files::read_retained_personal_gpu_receipt_v1(
            &path,
            std::sync::Arc::clone(&cancelled),
            deadline,
        )
        .unwrap();
        input.assert_current().unwrap();
        let foreign = root.join("foreign");
        fs::write(&foreign, b"foreign-unknown").unwrap();
        fs::rename(&foreign, &path).unwrap();
        let result = write_personal_gpu_receipt_for_observed_input_v1(
            &path,
            "{}",
            &cancelled,
            deadline,
            PersonalGpuPublicationInputV1::Existing(&input),
        );
        assert!(
            result.is_err(),
            "handoff must not rebase a replacement as writable input"
        );
        assert_eq!(fs::read(&path).unwrap(), b"foreign-unknown");
        let fresh = super::super::files::read_retained_personal_gpu_receipt_v1(
            &path,
            std::sync::Arc::clone(&cancelled),
            deadline,
        )
        .unwrap();
        write_personal_gpu_receipt_for_observed_input_v1(
            &path,
            "{}",
            &cancelled,
            deadline,
            PersonalGpuPublicationInputV1::Existing(&fresh),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{}\n");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn ordinary_handoff_keeps_original_missing_parent_epoch() {
        let root =
            std::env::temp_dir().join(format!("hepta-gpu-handoff-missing-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("receipt.json");
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        let missing = super::super::files::observe_missing_personal_gpu_receipt_v1(
            &path, &cancelled, deadline,
        )
        .unwrap();
        missing.assert_current().unwrap();
        fs::write(&path, b"created-then-removed").unwrap();
        fs::remove_file(&path).unwrap();
        let result = write_personal_gpu_receipt_for_observed_input_v1(
            &path,
            "{}",
            &cancelled,
            deadline,
            PersonalGpuPublicationInputV1::Missing(&missing),
        );
        assert!(
            result.is_err(),
            "handoff must not reset the observed missing edge epoch"
        );
        assert!(!path.exists());
        let fresh = super::super::files::observe_missing_personal_gpu_receipt_v1(
            &path, &cancelled, deadline,
        )
        .unwrap();
        write_personal_gpu_receipt_for_observed_input_v1(
            &path,
            "{}",
            &cancelled,
            deadline,
            PersonalGpuPublicationInputV1::Missing(&fresh),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{}\n");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn observed_publication_rejects_wrong_path_and_rebound_controls_before_namespace_changes() {
        let root =
            std::env::temp_dir().join(format!("hepta-gpu-input-context-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("receipt.json");
        fs::write(&path, b"{").unwrap();
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        let input = super::super::files::read_retained_personal_gpu_receipt_v1(
            &path,
            flag.clone(),
            deadline,
        )
        .unwrap();
        let wrong = root.join("wrong/new.json");
        assert!(
            write_personal_gpu_receipt_for_observed_input_v1(
                &wrong,
                "{}",
                &flag,
                deadline,
                PersonalGpuPublicationInputV1::Existing(&input)
            )
            .is_err()
        );
        assert!(!root.join("wrong").exists());
        let foreign_flag = std::sync::atomic::AtomicBool::new(false);
        assert!(
            write_personal_gpu_receipt_for_observed_input_v1(
                &path,
                "{}",
                &foreign_flag,
                deadline,
                PersonalGpuPublicationInputV1::Existing(&input)
            )
            .is_err()
        );
        assert!(
            write_personal_gpu_receipt_for_observed_input_v1(
                &path,
                "{}",
                &flag,
                deadline + std::time::Duration::from_secs(1),
                PersonalGpuPublicationInputV1::Existing(&input)
            )
            .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), b"{");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn observed_publication_rechecks_original_leaf_after_own_temp_and_retains_foreign_alias() {
        let root =
            std::env::temp_dir().join(format!("hepta-gpu-own-temp-input-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("receipt.json");
        fs::write(&path, b"{").unwrap();
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        let input = super::super::files::read_retained_personal_gpu_receipt_v1(
            &path,
            flag.clone(),
            deadline,
        )
        .unwrap();
        let foreign = root.join("foreign");
        let result = write_with_control_hook(
            &path,
            "{}",
            || super::super::files::gpu_check_active_v1(&flag, deadline).map_err(io::Error::other),
            || {
                fs::rename(&path, &foreign).unwrap();
                symlink(&foreign, &path).unwrap();
            },
            true,
            Some(PersonalGpuPublicationInputV1::Existing(&input)),
            |_| {},
        );
        assert!(result.is_err());
        assert!(
            fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read(&foreign).unwrap(), b"{");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        fs::remove_file(&path).unwrap();
        fs::rename(&foreign, &path).unwrap();
        let fresh = super::super::files::read_retained_personal_gpu_receipt_v1(
            &path,
            flag.clone(),
            deadline,
        )
        .unwrap();
        write_personal_gpu_receipt_for_observed_input_v1(
            &path,
            "{}",
            &flag,
            deadline,
            PersonalGpuPublicationInputV1::Existing(&fresh),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{}\n");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn controlled_missing_parent_creation_retains_foreign_eexist_without_chmod_then_fresh_retry() {
        for mode in [0o777, 0o700] {
            let root = std::env::temp_dir().join(format!(
                "hepta-gpu-parent-window-{}-{mode}",
                std::process::id()
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            let parent = root.join("new");
            let path = parent.join("receipt.json");
            let flag = std::sync::atomic::AtomicBool::new(false);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
            let input = super::super::files::observe_missing_personal_gpu_receipt_v1(
                &path, &flag, deadline,
            )
            .unwrap();
            let result = write_with_control_hook(
                &path,
                "{}",
                || {
                    super::super::files::gpu_check_active_v1(&flag, deadline)
                        .map_err(io::Error::other)
                },
                || {},
                true,
                Some(PersonalGpuPublicationInputV1::Missing(&input)),
                |selected| {
                    assert_eq!(selected, parent);
                    fs::create_dir(selected).unwrap();
                    fs::set_permissions(selected, fs::Permissions::from_mode(mode)).unwrap();
                    fs::write(selected.join("unknown.txt"), b"foreign-unknown").unwrap();
                },
            );
            assert!(result.is_err());
            assert_eq!(fs::metadata(&parent).unwrap().mode() & 0o777, mode);
            assert_eq!(
                fs::read(parent.join("unknown.txt")).unwrap(),
                b"foreign-unknown"
            );
            assert!(!path.exists());
            assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
            // The actor explicitly changes its own fixture permissions; the
            // product did not do so, and the old missing proof never revives.
            fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
            assert!(input.assert_current().is_err());
            let fresh = super::super::files::observe_missing_personal_gpu_receipt_v1(
                &path, &flag, deadline,
            )
            .unwrap();
            write_personal_gpu_receipt_for_observed_input_v1(
                &path,
                "{}",
                &flag,
                deadline,
                PersonalGpuPublicationInputV1::Missing(&fresh),
            )
            .unwrap();
            assert_eq!(fs::read(&path).unwrap(), b"{}\n");
            assert_eq!(
                fs::read(parent.join("unknown.txt")).unwrap(),
                b"foreign-unknown"
            );
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn original_none_parent_creation_preserves_legacy_eexist_branch_and_new_owned_missing_parents_publish()
     {
        let root =
            std::env::temp_dir().join(format!("hepta-gpu-parent-none-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let legacy = root.join("legacy");
        let opened = private_parent(&legacy, false, |selected| {
            fs::create_dir(selected).unwrap();
            fs::set_permissions(selected, fs::Permissions::from_mode(0o777)).unwrap();
        })
        .unwrap();
        assert_eq!(opened.metadata().unwrap().mode() & 0o777, 0o700);
        let path = root.join("owned/nested/receipt.json");
        let flag = std::sync::atomic::AtomicBool::new(false);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        let input =
            super::super::files::observe_missing_personal_gpu_receipt_v1(&path, &flag, deadline)
                .unwrap();
        write_personal_gpu_receipt_for_observed_input_v1(
            &path,
            "{}",
            &flag,
            deadline,
            PersonalGpuPublicationInputV1::Missing(&input),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{}\n");
        assert_eq!(
            fs::metadata(root.join("owned/nested")).unwrap().mode() & 0o777,
            0o700
        );
        fs::remove_dir_all(root).unwrap();
    }
}
