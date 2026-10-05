//! Continuous, descriptor-anchored witness for the selected ancestor names.
//! Directory timestamps and link counts also change for unrelated siblings;
//! ignoring those fields is safe only while this witness remains complete.
use super::*;
use nix::sys::inotify::{AddWatchFlags as Flags, InitFlags, Inotify, WatchDescriptor};
use nix::sys::statfs::{
    BTRFS_SUPER_MAGIC, EXT4_SUPER_MAGIC, FsType, TMPFS_MAGIC, XFS_SUPER_MAGIC, fstatfs,
};
use std::{cell::Cell, collections::BTreeMap, ffi::OsString, os::fd::AsRawFd};

const MAX_EVENTS: usize = 4096;
const MAX_READS: usize = 64;

pub(super) struct AncestorContinuity {
    observer: Inotify,
    selected: BTreeMap<WatchDescriptor, OsString>,
    rejected: Cell<bool>,
    #[cfg(test)]
    cancel_after_read: bool,
}
impl AncestorContinuity {
    pub(super) fn new(control: &ReadControl) -> Result<Self, ReadOnlyStoreError> {
        control.check()?;
        let observer = Inotify::init(InitFlags::IN_CLOEXEC | InitFlags::IN_NONBLOCK)
            .map_err(|_| ReadOnlyStoreError::DatabaseChanged)?;
        Ok(Self {
            observer,
            selected: BTreeMap::new(),
            rejected: Cell::new(false),
            #[cfg(test)]
            cancel_after_read: false,
        })
    }
    pub(super) fn watch(
        &mut self,
        directory: &File,
        selected_name: &std::ffi::OsStr,
    ) -> Result<bool, ReadOnlyStoreError> {
        let filesystem = fstatfs(directory).map_err(|_| ReadOnlyStoreError::DatabaseChanged)?;
        if !supports_selected_events(filesystem.filesystem_type()) {
            // Remote/stacked filesystem changes need not produce local events.
            // Preserve the original full metadata check instead of trusting an
            // installed but potentially incomplete notification watch.
            return Ok(false);
        }
        let changes = Flags::IN_ATTRIB
            | Flags::IN_MODIFY
            | Flags::IN_CREATE
            | Flags::IN_DELETE
            | Flags::IN_MOVED_FROM
            | Flags::IN_MOVED_TO
            | Flags::IN_MOVE_SELF
            | Flags::IN_DELETE_SELF
            | Flags::IN_ONLYDIR;
        let anchored = format!("/proc/self/fd/{}", directory.as_raw_fd());
        let descriptor = self
            .observer
            .add_watch(anchored.as_str(), changes)
            .map_err(|_| ReadOnlyStoreError::DatabaseChanged)?;
        if self
            .selected
            .insert(descriptor, selected_name.to_os_string())
            .is_some()
        {
            return Err(ReadOnlyStoreError::DatabaseChanged);
        }
        Ok(true)
    }
    pub(super) fn verify(&self, control: &ReadControl) -> Result<(), ReadOnlyStoreError> {
        control.check()?;
        if self.rejected.get() {
            return Err(ReadOnlyStoreError::DatabaseChanged);
        }
        let result = self.check_events(control);
        if result.is_err() {
            self.rejected.set(true);
        }
        result
    }
    fn check_events(&self, control: &ReadControl) -> Result<(), ReadOnlyStoreError> {
        let mut count = 0usize;
        for _ in 0..MAX_READS {
            control.check()?;
            let events = match self.observer.read_events() {
                Ok(events) if !events.is_empty() => events,
                Err(nix::errno::Errno::EAGAIN) => return Ok(()),
                Err(nix::errno::Errno::EINTR) => continue,
                _ => return Err(ReadOnlyStoreError::DatabaseChanged),
            };
            #[cfg(test)]
            if self.cancel_after_read {
                control.cancelled.store(true, Ordering::Release);
            }
            for event in events {
                control.check()?;
                count += 1;
                if count > MAX_EVENTS {
                    return Err(ReadOnlyStoreError::OrdinaryBudgetExceeded(
                        "ancestor_events_v1",
                    ));
                }
                if event
                    .mask
                    .intersects(Flags::IN_Q_OVERFLOW | Flags::IN_UNMOUNT | Flags::IN_IGNORED)
                {
                    return Err(ReadOnlyStoreError::DatabaseChanged);
                }
                let selected = self
                    .selected
                    .get(&event.wd)
                    .ok_or(ReadOnlyStoreError::DatabaseChanged)?;
                if event.name.as_ref().is_none_or(|name| name == selected) {
                    return Err(ReadOnlyStoreError::DatabaseChanged);
                }
            }
        }
        Err(ReadOnlyStoreError::OrdinaryBudgetExceeded(
            "ancestor_event_reads_v1",
        ))
    }
}

fn supports_selected_events(filesystem: FsType) -> bool {
    matches!(
        filesystem,
        TMPFS_MAGIC | EXT4_SUPER_MAGIC | XFS_SUPER_MAGIC | BTRFS_SUPER_MAGIC
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = Path::new("/dev/shm").join(format!(
                "hepta-ordinary-witness-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(root.join("selected")).unwrap();
            Self(root)
        }
        fn observe(&self) -> (AncestorContinuity, ReadControl) {
            let control = ReadControl::new(
                Arc::new(AtomicBool::new(false)),
                Instant::now() + Duration::from_secs(30),
            );
            let mut witness = AncestorContinuity::new(&control).unwrap();
            let _held = HeldDirectory::open_observed(self.0.clone(), |file| {
                witness.watch(file, std::ffi::OsStr::new("selected"))
            })
            .unwrap();
            (witness, control)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn lost_kernel_watch_is_a_sticky_refusal() {
        let fixture = Fixture::new();
        let (witness, control) = fixture.observe();
        let descriptor = *witness.selected.keys().next().unwrap();
        witness.observer.rm_watch(descriptor).unwrap();
        for _ in 0..2 {
            assert!(matches!(
                witness.verify(&control),
                Err(ReadOnlyStoreError::DatabaseChanged)
            ));
        }
    }
    #[test]
    fn unrelated_event_flood_is_bounded_and_never_becomes_a_fresh_baseline() {
        let fixture = Fixture::new();
        let (witness, control) = fixture.observe();
        let sibling = fixture.0.join("unrelated");
        for _ in 0..=MAX_EVENTS {
            fs::write(&sibling, []).unwrap();
            fs::remove_file(&sibling).unwrap();
        }
        assert!(witness.verify(&control).is_err());
        assert!(matches!(
            witness.verify(&control),
            Err(ReadOnlyStoreError::DatabaseChanged)
        ));
    }
    #[test]
    fn remote_stacked_and_unknown_filesystems_keep_the_strict_metadata_policy() {
        use nix::sys::statfs::{FUSE_SUPER_MAGIC, NFS_SUPER_MAGIC, OVERLAYFS_SUPER_MAGIC};
        for kind in [
            NFS_SUPER_MAGIC,
            FUSE_SUPER_MAGIC,
            OVERLAYFS_SUPER_MAGIC,
            FsType(0),
        ] {
            assert!(!supports_selected_events(kind));
        }
        for kind in [
            TMPFS_MAGIC,
            EXT4_SUPER_MAGIC,
            XFS_SUPER_MAGIC,
            BTRFS_SUPER_MAGIC,
        ] {
            assert!(supports_selected_events(kind));
        }
        let fixture = Fixture::new();
        let held = HeldDirectory::open_observed(fixture.0.clone(), |_| Ok(false)).unwrap();
        fs::write(fixture.0.join("unrelated"), []).unwrap();
        assert!(matches!(
            held.verify_metadata(!held.selective_ancestry),
            Err(ReadOnlyStoreError::DatabaseChanged)
        ));
    }
    #[test]
    fn rename_restore_after_watch_before_metadata_is_refused() {
        let fixture = Fixture::new();
        let control = ReadControl::new(
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(30),
        );
        let mut witness = AncestorContinuity::new(&control).unwrap();
        let held = HeldDirectory::open_observed(fixture.0.clone(), |file| {
            let selective = witness.watch(file, std::ffi::OsStr::new("selected"))?;
            let aside = fixture.0.with_extension("moved");
            fs::rename(&fixture.0, &aside).unwrap();
            fs::rename(&aside, &fixture.0).unwrap();
            Ok(selective)
        })
        .unwrap();
        held.verify_metadata(false).unwrap();
        assert!(matches!(
            witness.verify(&control),
            Err(ReadOnlyStoreError::DatabaseChanged)
        ));
    }
    #[test]
    fn cancellation_before_read_is_retryable_but_consumed_batch_is_fail_closed() {
        let fixture = Fixture::new();
        let (mut witness, control) = fixture.observe();
        fs::write(fixture.0.join("unrelated"), []).unwrap();
        control.cancelled.store(true, Ordering::Release);
        assert!(matches!(
            witness.verify(&control),
            Err(ReadOnlyStoreError::OrdinaryCancelled)
        ));
        control.cancelled.store(false, Ordering::Release);
        witness.verify(&control).unwrap();
        fs::remove_file(fixture.0.join("unrelated")).unwrap();
        witness.cancel_after_read = true;
        assert!(matches!(
            witness.verify(&control),
            Err(ReadOnlyStoreError::OrdinaryCancelled)
        ));
        control.cancelled.store(false, Ordering::Release);
        assert!(matches!(
            witness.verify(&control),
            Err(ReadOnlyStoreError::DatabaseChanged)
        ));
    }
}
