use super::*;
use nix::{
    fcntl::{open, openat},
    sys::stat::Mode,
};
use std::{
    fs::{self, File, Metadata},
    os::unix::fs::MetadataExt,
    path::Component,
};

/// Pins the command inode, not only its pathname. These are bounded snapshots;
/// they do not make a same-user writable filesystem immutable after checking.
#[derive(Debug)]
pub(super) struct PinnedExecutable {
    path: PathBuf,
    file: File,
    metadata: Metadata,
}
fn same(a: &Metadata, b: &Metadata) -> bool {
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
impl PinnedExecutable {
    pub(super) fn open(path: &Path, expected: &Value) -> Result<Self> {
        ensure(
            path.is_absolute()
                && path
                    .components()
                    .all(|c| matches!(c, Component::RootDir | Component::Normal(_))),
            "runtime_reproducibility_path_not_canonical",
        )?;
        let unavailable = || Error("runtime_reproducibility_file_unavailable".into());
        let flags = OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC;
        let mut dir = open(Path::new("/"), flags | OFlag::O_DIRECTORY, Mode::empty())
            .map_err(|_| unavailable())?;
        let mut parts = path
            .components()
            .filter_map(|c| {
                if let Component::Normal(v) = c {
                    Some(v)
                } else {
                    None
                }
            })
            .peekable();
        let mut selected = None;
        while let Some(part) = parts.next() {
            let directory = parts.peek().is_some();
            let fd = openat(
                &dir,
                Path::new(part),
                flags
                    | if directory {
                        OFlag::O_DIRECTORY
                    } else {
                        OFlag::empty()
                    },
                Mode::empty(),
            )
            .map_err(|_| unavailable())?;
            if directory {
                dir = fd;
            } else {
                selected = Some(fd);
            }
        }
        let mut file = File::from(selected.ok_or_else(unavailable)?);
        let metadata = file.metadata()?;
        ensure(
            metadata.is_file()
                && metadata.nlink() == 1
                && metadata.mode() & 0o022 == 0
                && metadata.mode() & 0o111 != 0
                && metadata.len() > 0
                && metadata.len() <= 256 * 1024 * 1024,
            "runtime_reproducibility_integrity_file_invalid",
        )?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(256 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure(
            same(&metadata, &file.metadata()?)
                && bytes.len() as u64 == metadata.len()
                && expected["executableContentHash"] == digest(&bytes)
                && expected["executableDevice"]
                    .as_str()
                    .and_then(|v| v.parse::<u64>().ok())
                    == Some(metadata.dev())
                && expected["executableInode"]
                    .as_str()
                    .and_then(|v| v.parse::<u64>().ok())
                    == Some(metadata.ino())
                && expected["executableUid"] == metadata.uid(),
            "runtime_reproducibility_configuration_drift",
        )?;
        let pinned = Self {
            path: path.to_owned(),
            file,
            metadata,
        };
        pinned.assert_current()?;
        Ok(pinned)
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        ensure(
            same(&self.metadata, &self.file.metadata()?)
                && same(&self.metadata, &fs::symlink_metadata(&self.path)?)
                && fs::canonicalize(&self.path)? == self.path,
            "runtime_reproducibility_configuration_drift",
        )
    }
    pub(super) fn execution_handle(&self) -> Result<File> {
        self.assert_current()?;
        let file = self.file.try_clone()?;
        fcntl(&file, FcntlArg::F_SETFD(FdFlag::empty()))
            .map_err(|_| Error("runtime_reproducibility_file_unavailable".into()))?;
        Ok(file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, os::unix::fs::PermissionsExt, sync::atomic::AtomicU64};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new(body: &str) -> (Self, VerifierProcess) {
            let root = std::env::temp_dir().join(format!(
                "hepta-image-process-pin-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            let path = root.join("verifier.py");
            fs::write(&path, format!("#!/usr/bin/python3\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            let metadata = fs::metadata(&path).unwrap();
            let command = json!({"executable":path,"executableContentHash":digest(&fs::read(&path).unwrap()),"executableDevice":metadata.dev().to_string(),"executableInode":metadata.ino().to_string(),"executableUid":metadata.uid(),"args":[],"timeoutMs":1000});
            let executable = PinnedExecutable::open(&path, &command).unwrap();
            (
                Self(root),
                VerifierProcess {
                    command,
                    executable,
                    environment: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
                },
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn execution_descriptor_keeps_the_pinned_inode_when_path_is_replaced() {
        let (fixture, process) = Fixture::new("print('pinned')");
        let file = process.executable.execution_handle().unwrap();
        let path = fixture.0.join("verifier.py");
        fs::rename(&path, fixture.0.join("original.py")).unwrap();
        fs::write(&path, "#!/usr/bin/python3\nprint('replacement')\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(process.executable.assert_current().is_err());
        let output = Command::new(format!("/proc/self/fd/{}", file.as_raw_fd()))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"pinned\n");
    }
    #[test]
    fn stopped_io_rejects_escaped_descendant_holding_an_unread_large_stdin() {
        let (fixture, process) = Fixture::new(
            "import os,time\nif os.fork()==0:\n os.setsid()\n time.sleep(5)\n os._exit(0)\nprint('{}')",
        );
        let started = Instant::now();
        assert!(
            invoke(
                &process,
                &json!({"large":"x".repeat(2*1024*1024)}),
                &fixture.0
            )
            .is_err()
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn mutated_pinned_inode_is_rejected_before_execution() {
        let (fixture, process) = Fixture::new("print('{}')");
        let path = fixture.0.join("verifier.py");
        let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
        writeln!(file, "# changed").unwrap();
        assert!(invoke(&process, &json!({}), &fixture.0).is_err());
    }
}
