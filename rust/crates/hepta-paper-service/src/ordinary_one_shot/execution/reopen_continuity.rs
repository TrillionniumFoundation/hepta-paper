//! Kernel observation of changes to the already held named path. This witness
//! distinguishes unrelated ancestor children from a selected component change;
//! it never replaces the original directory, leaf, or SQLite reopen epoch.
use super::*;
use nix::sys::inotify::{AddWatchFlags as Flags, InitFlags, Inotify, WatchDescriptor};
use std::{collections::BTreeMap, ffi::OsString, os::fd::AsRawFd};
const REFUSAL: &str = "campaign_one_shot_attempt_journal_reopen_continuity_changed_or_unknown";
const MAX_EVENTS: usize = 1024;
const MAX_READS: usize = 64;

pub(super) struct NamedReopenContinuityV1<'a> {
    directory: &'a Directory,
    control: &'a ReconciliationReadControlV1,
    observer: Inotify,
    names: BTreeMap<WatchDescriptor, Option<OsString>>,
    rejected: std::cell::Cell<bool>,
}
impl<'a> NamedReopenContinuityV1<'a> {
    pub(super) fn observe(
        directory: &'a Directory,
        control: &'a ReconciliationReadControlV1,
    ) -> Result<Self, String> {
        control.checkpoint().map_err(|e| e.to_string())?;
        directory.assert_current().map_err(|e| e.to_string())?;
        let chain: Vec<_> = directory.held_reopen_ancestry_v1().collect();
        if chain.is_empty() || chain.len() > 4097 {
            return Err(REFUSAL.into());
        }
        let observer =
            Inotify::init(InitFlags::IN_CLOEXEC | InitFlags::IN_NONBLOCK).map_err(|_| REFUSAL)?;
        let mut names = BTreeMap::new();
        let changes = Flags::IN_ATTRIB
            | Flags::IN_MODIFY
            | Flags::IN_CREATE
            | Flags::IN_DELETE
            | Flags::IN_MOVED_FROM
            | Flags::IN_MOVED_TO
            | Flags::IN_MOVE_SELF
            | Flags::IN_DELETE_SELF
            | Flags::IN_ONLYDIR;
        for (index, (_, held)) in chain.iter().enumerate() {
            control.checkpoint().map_err(|e| e.to_string())?;
            // inotify follows this retained descriptor, never a mutable
            // filesystem ancestor name. SQLite still uses its original path.
            let anchored = format!("/proc/self/fd/{}", held.as_raw_fd());
            let descriptor = observer
                .add_watch(anchored.as_str(), changes)
                .map_err(|_| REFUSAL)?;
            let selected_name = match chain.get(index + 1) {
                Some((path, _)) => Some(path.file_name().ok_or(REFUSAL)?.to_os_string()),
                // Every change inside the private control namespace matters,
                // including an unknown temporary leaf that was later removed.
                None => None,
            };
            if names.insert(descriptor, selected_name).is_some() {
                return Err(REFUSAL.into());
            }
        }
        let result = Self {
            directory,
            control,
            observer,
            names,
            rejected: std::cell::Cell::new(false),
        };
        result.assert_current()?;
        Ok(result)
    }
    fn check_events(&self) -> Result<(), String> {
        let mut count = 0usize;
        for _ in 0..MAX_READS {
            self.control.checkpoint().map_err(|e| e.to_string())?;
            let events = match self.observer.read_events() {
                Ok(events) => events,
                Err(nix::errno::Errno::EAGAIN) => return Ok(()),
                Err(nix::errno::Errno::EINTR) => continue,
                Err(_) => return Err(REFUSAL.into()),
            };
            if events.is_empty() {
                return Err(REFUSAL.into());
            }
            for event in events {
                self.control.checkpoint().map_err(|e| e.to_string())?;
                count = count
                    .checked_add(1)
                    .filter(|n| *n <= MAX_EVENTS)
                    .ok_or(REFUSAL)?;
                if event
                    .mask
                    .intersects(Flags::IN_Q_OVERFLOW | Flags::IN_UNMOUNT | Flags::IN_IGNORED)
                {
                    return Err(REFUSAL.into());
                }
                let selected = self.names.get(&event.wd).ok_or(REFUSAL)?;
                match event.name {
                    None => return Err(REFUSAL.into()),
                    Some(name) if selected.as_ref().is_none_or(|value| value == &name) => {
                        #[cfg(test)]
                        eprintln!(
                            "one_shot_named_reopen_target_event mask={:?} selected={selected:?} observed={name:?}",
                            event.mask
                        );
                        return Err(REFUSAL.into());
                    }
                    Some(_) => {}
                }
            }
        }
        Err(REFUSAL.into())
    }
    pub(super) fn assert_current(&self) -> Result<(), String> {
        if self.rejected.get() {
            return Err(REFUSAL.into());
        }
        let result = self
            .control
            .checkpoint()
            .map_err(|e| e.to_string())
            .and_then(|()| self.directory.assert_current().map_err(|e| e.to_string()))
            .and_then(|()| self.check_events());
        if result.is_err() {
            self.rejected.set(true);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ordinary_one_shot::execution::tests::Fixture;
    use std::{
        fs,
        os::unix::fs::{MetadataExt, PermissionsExt},
        sync::{Arc, atomic::Ordering},
        time::{Duration, Instant},
    };
    fn inotify_fds() -> usize {
        fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| fs::read_link(entry.path()).ok())
            .filter(|target| target.to_string_lossy() == "anon_inode:inotify")
            .count()
    }
    #[test]
    fn actual_registered_namespace_owner_keeps_unrelated_events_but_latches_rename_and_permission_revoke()
     {
        for kind in [
            "unrelated",
            "rename",
            "permission",
            "private_unknown",
            "writable_close",
        ] {
            let fixture = Fixture::new();
            let directory =
                Directory::open_or_create(&fixture.path("selected/private"), true).unwrap();
            directory
                .write_new(super::super::super::JOURNAL_NAME, b"unchanged leaf")
                .unwrap();
            let leaf = directory.path.join(super::super::super::JOURNAL_NAME);
            let before = fs::symlink_metadata(&leaf).unwrap();
            let cancelled = Arc::new(AtomicBool::new(false));
            let control = ReconciliationReadControlV1::new(
                cancelled,
                Instant::now() + Duration::from_secs(120),
            );
            let baseline = inotify_fds();
            {
                let observed = NamedReopenContinuityV1::observe(&directory, &control).unwrap();
                assert_eq!(inotify_fds(), baseline + 1);
                match kind {
                    "unrelated" => {
                        fs::create_dir(fixture.path("unrelated")).unwrap();
                        fs::remove_dir(fixture.path("unrelated")).unwrap();
                    }
                    "rename" => {
                        fs::rename(fixture.path("selected"), fixture.path("retained-original"))
                            .unwrap();
                        fs::create_dir(fixture.path("selected")).unwrap();
                        fs::write(fixture.path("selected/foreign"), b"must remain").unwrap();
                        fs::rename(fixture.path("selected"), fixture.path("retained-foreign"))
                            .unwrap();
                        fs::rename(fixture.path("retained-original"), fixture.path("selected"))
                            .unwrap();
                    }
                    "permission" => {
                        fs::set_permissions(
                            fixture.path("selected"),
                            fs::Permissions::from_mode(0o000),
                        )
                        .unwrap();
                        fs::set_permissions(
                            fixture.path("selected"),
                            fs::Permissions::from_mode(0o700),
                        )
                        .unwrap();
                    }
                    "writable_close" => {
                        let opened = fs::OpenOptions::new()
                            .read(true)
                            .write(true)
                            .open(&leaf)
                            .unwrap();
                        drop(opened);
                    }
                    "private_unknown" => {
                        fs::write(
                            directory.path.join("unknown"),
                            b"unknown retained namespace",
                        )
                        .unwrap();
                        fs::remove_file(directory.path.join("unknown")).unwrap();
                    }
                    _ => unreachable!(),
                }
                directory.assert_current().unwrap();
                let after = fs::symlink_metadata(&leaf).unwrap();
                assert_eq!(
                    (
                        before.dev(),
                        before.ino(),
                        before.len(),
                        before.mtime(),
                        before.mtime_nsec(),
                        before.ctime(),
                        before.ctime_nsec()
                    ),
                    (
                        after.dev(),
                        after.ino(),
                        after.len(),
                        after.mtime(),
                        after.mtime_nsec(),
                        after.ctime(),
                        after.ctime_nsec()
                    )
                );
                assert_eq!(fs::read(&leaf).unwrap(), b"unchanged leaf");
                assert_eq!(
                    observed.assert_current().is_ok(),
                    matches!(kind, "unrelated" | "writable_close"),
                    "{kind}"
                );
                assert_eq!(
                    observed.assert_current().is_ok(),
                    matches!(kind, "unrelated" | "writable_close"),
                    "{kind}: cannot revive"
                );
                if kind == "rename" {
                    assert_eq!(
                        fs::read(fixture.path("retained-foreign/foreign")).unwrap(),
                        b"must remain"
                    );
                }
            }
            assert_eq!(
                inotify_fds(),
                baseline,
                "owned observer descriptor closes for {kind}"
            );
        }
    }
    #[test]
    fn actual_kernel_queue_overflow_of_unrelated_events_fails_closed_without_replacing_the_selected_path()
     {
        let fixture = Fixture::new();
        let directory = Directory::open_or_create(&fixture.path("selected/private"), true).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let control =
            ReconciliationReadControlV1::new(cancelled, Instant::now() + Duration::from_secs(120));
        let baseline = inotify_fds();
        {
            let observed = NamedReopenContinuityV1::observe(&directory, &control).unwrap();
            // An independent kernel observer confirms an actual overflow,
            // rather than setting a synthetic overflow flag in the owner.
            let shadow = Inotify::init(InitFlags::IN_CLOEXEC | InitFlags::IN_NONBLOCK).unwrap();
            shadow
                .add_watch(
                    fixture.0.as_path(),
                    Flags::IN_CREATE | Flags::IN_DELETE | Flags::IN_ONLYDIR,
                )
                .unwrap();
            let capacity: usize = fs::read_to_string("/proc/sys/fs/inotify/max_queued_events")
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            assert!(
                (1024..=65536).contains(&capacity),
                "bounded actual host queue"
            );
            for index in 0..capacity + 8 {
                control.checkpoint().unwrap();
                let file = fixture.path(&format!("unrelated-{index}"));
                fs::write(&file, []).unwrap();
                fs::remove_file(&file).unwrap();
            }
            let mut events = 0usize;
            let mut overflow = false;
            for _ in 0..1024 {
                control.checkpoint().unwrap();
                match shadow.read_events() {
                    Ok(batch) => {
                        events += batch.len();
                        assert!(events <= 65537);
                        overflow |= batch
                            .iter()
                            .any(|event| event.mask.contains(Flags::IN_Q_OVERFLOW));
                    }
                    Err(nix::errno::Errno::EAGAIN) => break,
                    Err(error) => panic!("actual kernel observation {error}"),
                }
            }
            assert!(overflow, "actual second kernel queue overflow");
            directory.assert_current().unwrap();
            assert!(observed.assert_current().is_err());
            assert!(observed.assert_current().is_err());
        }
        assert_eq!(
            inotify_fds(),
            baseline,
            "both registered observers are released"
        );
    }
    #[test]
    fn actual_original_cancel_deadline_and_observer_cleanup_never_rebase_the_owner() {
        for cancelled_case in [true, false] {
            let fixture = Fixture::new();
            let directory = Directory::open_or_create(&fixture.path("selected"), true).unwrap();
            let cancelled = Arc::new(AtomicBool::new(false));
            let control = ReconciliationReadControlV1::new(
                cancelled.clone(),
                Instant::now()
                    + if cancelled_case {
                        Duration::from_secs(120)
                    } else {
                        Duration::from_millis(100)
                    },
            );
            let baseline = inotify_fds();
            {
                let observed = NamedReopenContinuityV1::observe(&directory, &control).unwrap();
                if cancelled_case {
                    cancelled.store(true, Ordering::Release);
                } else {
                    std::thread::sleep(Duration::from_millis(110));
                }
                assert!(observed.assert_current().is_err());
                cancelled.store(false, Ordering::Release);
                assert!(
                    observed.assert_current().is_err(),
                    "original rejected owner cannot revive"
                );
            }
            assert_eq!(inotify_fds(), baseline);
        }
    }
}
