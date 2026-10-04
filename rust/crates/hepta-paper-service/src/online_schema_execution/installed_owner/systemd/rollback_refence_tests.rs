//! An opt-in real PID 1 fixture. Only a randomly named runtime service running
//! fixed /usr/bin/sleep as UID/GID 65534 is created; no product unit or authority
//! is changed, and this fixture cannot construct an installed maintenance guard.
use super::*;
use crate::sqlite_mutation_coordinator::{clock::MutationClockV1, hash_bytes};
use nix::fcntl::{Flock, FlockArg};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, PermissionsExt},
    process::Command,
};

const SELECTOR: &str = "online_schema_execution::installed_owner::systemd::rollback_refence_tests::actual_pid1_restart_errors_and_clock_or_cas_failure_stop_the_private_writer";
const PREFIX: &str = "hepta-schema-rollback-test-";

fn write_new(path: &Path, bytes: &[u8]) {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .unwrap();
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .unwrap();
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
    File::open(path.parent().unwrap())
        .unwrap()
        .sync_all()
        .unwrap();
}

struct Fixture {
    root: PathBuf,
    unit: SourceUnitV1,
    marker: PathBuf,
    drop_in: PathBuf,
    boot: manager::BootObservation,
    pidfd: OwnedFd,
    owner: String,
    _lock: Flock<File>,
    cleaned: bool,
}
impl Fixture {
    fn new() -> Self {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).unwrap();
        let name = format!("{PREFIX}{}", hex::encode(bytes));
        let root = PathBuf::from("/run").join(&name);
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let lock_path = root.join(".owner.lock");
        write_new(&lock_path, b"");
        let lock = Flock::lock(
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(lock_path)
                .unwrap(),
            FlockArg::LockExclusiveNonblock,
        )
        .unwrap();
        let name = format!("{name}.service");
        let fragment = PathBuf::from("/run/systemd/system").join(&name);
        let bytes = b"[Unit]\nDescription=Private hepta schema rollback fault fixture\n[Service]\nType=simple\nExecStart=/usr/bin/sleep 300\nUser=65534\nGroup=65534\nWorkingDirectory=/\nKillMode=control-group\nRestart=no\n";
        write_new(&fragment, bytes);
        let directory = PathBuf::from("/run/systemd/system").join(format!("{name}.d"));
        fs::create_dir(&directory).unwrap();
        let pin = |path: PathBuf, bytes: &[u8]| super::super::installation::PinnedInstalledFileV1 {
            path,
            sha256: hash_bytes(bytes),
        };
        let executable = PathBuf::from("/usr/bin/sleep");
        assert_eq!(fs::canonicalize(&executable).unwrap(), executable);
        let unit = SourceUnitV1 {
            unit: name,
            fragment: pin(fragment, bytes),
            drop_ins: vec![],
            executable: pin(executable.clone(), &fs::read(&executable).unwrap()),
            argv: vec!["/usr/bin/sleep".into(), "300".into()],
            working_directory: PathBuf::from("/"),
            uid: 65534,
            gid: 65534,
            supplementary_gids: vec![65534],
            service_type: "simple".into(),
            kill_mode: "control-group".into(),
            input_files: vec![],
        };
        let deadline = Instant::now() + Duration::from_secs(30);
        let boot = manager::BootObservation::load().unwrap();
        let pidfd = manager::installed_manager_pidfd(deadline).unwrap();
        let owner = exchange(deadline, async |connection| {
            let owner = manager::owner(connection, deadline).await?;
            manager::principal(connection, &owner, deadline).await?;
            Ok(owner)
        })
        .unwrap();
        Self {
            marker: root.join("BLOCKED"),
            drop_in: directory.join(DROP_IN_NAME),
            root,
            unit,
            boot,
            pidfd,
            owner,
            _lock: lock,
            cleaned: false,
        }
    }
    fn assert_pins(&self) {
        self.boot.assert_current().unwrap();
        manager_alive(&self.pidfd).unwrap();
        for pin in [&self.unit.fragment, &self.unit.executable] {
            assert_eq!(hash_bytes(&fs::read(&pin.path).unwrap()), pin.sha256);
            assert_eq!(fs::metadata(&pin.path).unwrap().uid(), 0);
        }
    }
    fn start(&self) -> u32 {
        self.assert_pins();
        for path in [&self.drop_in, &self.marker] {
            match fs::remove_file(path) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => panic!("remove own fixture barrier: {e}"),
            }
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        let pid = exchange(deadline, async |connection| {
            let owner = manager::owner(connection, deadline).await?;
            if owner != self.owner {
                return Err(bus_invalid());
            }
            manager::principal(connection, &owner, deadline).await?;
            reload_and_subscribe(connection, &owner, deadline).await?;
            job(connection, &owner, &self.unit.unit, "StartUnit", deadline).await?;
            let frame =
                observe_unit(connection, &owner, &self.unit, &[], None, true, deadline).await?;
            if frame.active != "active" || frame.substate != "running" || frame.main_pid == 0 {
                return Err(bus_invalid());
            }
            // Real population, not a readiness boolean or serialized witness.
            if ObservedCgroup::capture(&frame.cgroup, &self.unit.unit)
                .map_err(|_| bus_invalid())?
                .assert_empty()
                .is_ok()
            {
                return Err(bus_invalid());
            }
            Ok(frame.main_pid)
        })
        .unwrap();
        self.assert_pins();
        assert!(PathBuf::from(format!("/proc/{pid}")).exists());
        pid
    }
    fn retained_group(&self) -> ObservedCgroup {
        let deadline = Instant::now() + Duration::from_secs(30);
        exchange(deadline, async |connection| {
            let owner = manager::owner(connection, deadline).await?;
            if owner != self.owner {
                return Err(bus_invalid());
            }
            manager::principal(connection, &owner, deadline).await?;
            let frame =
                observe_unit(connection, &owner, &self.unit, &[], None, true, deadline).await?;
            ObservedCgroup::capture(&frame.cgroup, &self.unit.unit).map_err(|_| bus_invalid())
        })
        .unwrap()
    }
    fn stop_only(&self) {
        let deadline = Instant::now() + Duration::from_secs(30);
        exchange(deadline, async |connection| {
            let owner = manager::owner(connection, deadline).await?;
            if owner != self.owner {
                return Err(bus_invalid());
            }
            manager::principal(connection, &owner, deadline).await?;
            reload_and_subscribe(connection, &owner, deadline).await?;
            // No following RPC ticks a queued RemoveMatch cleanup. This exact
            // last-operation path previously leaked the bounded wire reader.
            job(connection, &owner, &self.unit.unit, "StopUnit", deadline).await
        })
        .unwrap();
    }
    fn cancelled_streams_close(&self) {
        for timeout in [false, true] {
            let deadline = Instant::now() + Duration::from_secs(if timeout { 3 } else { 30 });
            let mut armed = false;
            let result = exchange::<(), _>(deadline, async |connection| {
                let owner = manager::owner(connection, deadline).await?;
                if owner != self.owner {
                    return Err(bus_invalid());
                }
                manager::principal(connection, &owner, deadline).await?;
                let signals = job_signals(connection, &owner, &self.unit.unit, deadline).await?;
                armed = true;
                if timeout {
                    std::future::pending::<()>().await;
                }
                drop(signals);
                Err(manager::installed_manager_error())
            });
            assert!(armed, "actual JobRemoved subscription was not armed");
            assert_eq!(result.err().unwrap().code, CODE);
            // A subsequent independent actual exchange still authenticates.
            self.assert_pins();
        }
    }
    fn refence(&self, selected: &SourceUnitV1) -> Result<()> {
        // Same persistent-before-Reload-before-Stop order as the product owner.
        write_new(&self.marker, b"private rollback fixture pending\n");
        write_new(
            &self.drop_in,
            format!("[Unit]\nConditionPathExists=!{}\n", self.marker.display()).as_bytes(),
        );
        self.assert_pins();
        let deadline = Instant::now() + Duration::from_secs(30);
        let groups = exchange(deadline, async |connection| {
            let owner = manager::owner(connection, deadline).await?;
            if owner != self.owner {
                return Err(bus_invalid());
            }
            manager::principal(connection, &owner, deadline).await?;
            reload_and_subscribe(connection, &owner, deadline).await?;
            let groups = stop_source_units(
                connection,
                &owner,
                std::slice::from_ref(selected),
                &self.marker,
                deadline,
            )
            .await?;
            if manager::owner(connection, deadline).await? != owner {
                return Err(bus_invalid());
            }
            manager::principal(connection, &owner, deadline).await?;
            Ok(groups)
        })?;
        for (_, group) in groups {
            group.assert_empty()?;
        }
        self.assert_pins();
        Ok(())
    }
    fn clean(&mut self) -> Result<()> {
        if self.cleaned {
            return Ok(());
        }
        assert!(self.unit.unit.starts_with(PREFIX));
        let deadline = Instant::now() + Duration::from_secs(30);
        exchange(deadline, async |connection| {
            let owner = manager::owner(connection, deadline).await?;
            if owner != self.owner {
                return Err(bus_invalid());
            }
            manager::principal(connection, &owner, deadline).await?;
            manager::call(
                connection,
                &owner,
                MANAGER_PATH,
                MANAGER_INTERFACE,
                "Subscribe",
                &(),
                deadline,
            )
            .await?;
            job(connection, &owner, &self.unit.unit, "StopUnit", deadline).await
        })?;
        for path in [&self.drop_in, &self.marker] {
            match fs::remove_file(path) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err(invalid()),
            }
        }
        fs::remove_dir(self.drop_in.parent().ok_or_else(invalid)?).map_err(|_| invalid())?;
        fs::remove_file(&self.unit.fragment.path).map_err(|_| invalid())?;
        exchange(deadline, async |connection| {
            manager::call(
                connection,
                &self.owner,
                MANAGER_PATH,
                MANAGER_INTERFACE,
                "Reload",
                &(),
                deadline,
            )
            .await?;
            Ok(())
        })?;
        fs::remove_dir_all(&self.root).map_err(|_| invalid())?;
        self.cleaned = true;
        Ok(())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(cause) = self.clean() {
            eprintln!(
                "private runtime fixture cleanup failed: {cause}; unit={}",
                self.unit.unit
            );
        }
    }
}

#[test]
#[ignore = "requires real root PID 1 only for a private reversible runtime sleep service"]
fn actual_pid1_restart_errors_and_clock_or_cas_failure_stop_the_private_writer() {
    if nix::unistd::getuid().as_raw() != 0 {
        let child = Command::new("sudo")
            .args(["-n"])
            .arg(std::env::current_exe().unwrap())
            .args([
                "--exact",
                SELECTOR,
                "--ignored",
                "--test-threads=1",
                "--nocapture",
            ])
            .output()
            .unwrap();
        assert!(
            child.status.success(),
            "{} {}",
            String::from_utf8_lossy(&child.stdout),
            String::from_utf8_lossy(&child.stderr)
        );
        assert!(
            String::from_utf8_lossy(&child.stdout)
                .contains("test result: ok. 1 passed; 0 failed; 0 ignored;")
        );
        return;
    }
    let mut fixture = Fixture::new();
    for (index, point) in [
        "after_actual_start",
        "clock_failure",
        "completion_cas_failure",
    ]
    .iter()
    .enumerate()
    {
        let root = fixture.root.join(format!("intent-{index}"));
        let mut intent = super::super::journal::tests::intent(&root);
        intent.select_rollback(2).unwrap();
        intent.advance_rollback("writer_resume_pending", 3).unwrap();
        let before = fs::read(root.join("EXECUTION.v1.json")).unwrap();
        let result_path = fixture.root.join(format!("new-result-{index}"));
        write_new(
            &result_path,
            b"a real result written after the writer resumed\n",
        );
        let pid = fixture.start();
        let outcome = match *point {
            "after_actual_start" => Err(error("private_error_after_actual_start")),
            "clock_failure" => {
                let mut clock = || Err(error("private_completion_clock_failed"));
                clock
                    .now_millis()
                    .and_then(|now| intent.advance_rollback("completed", now))
            }
            _ => {
                // The real held Snapshot/CAS refuses the changed durable file.
                fs::write(
                    root.join("EXECUTION.v1.json"),
                    b"unknown durable completion replacement\n",
                )
                .unwrap();
                intent.advance_rollback("completed", 4)
            }
        };
        assert!(outcome.is_err());
        let expected = outcome.as_ref().err().unwrap().code.clone();
        let result = rollback_result(outcome, || fixture.refence(&fixture.unit));
        assert_eq!(result.err().unwrap().code, expected);
        assert!(fixture.marker.exists());
        assert!(fixture.drop_in.exists());
        assert!(
            !PathBuf::from(format!("/proc/{pid}")).exists(),
            "actual source PID survived {point}"
        );
        assert_eq!(intent.value()["rollbackState"], "writer_resume_pending");
        assert_eq!(
            fs::read(&result_path).unwrap(),
            b"a real result written after the writer resumed\n"
        );
        if *point != "completion_cas_failure" {
            assert_eq!(fs::read(root.join("EXECUTION.v1.json")).unwrap(), before);
        } else {
            assert_eq!(
                fs::read(root.join("EXECUTION.v1.json")).unwrap(),
                b"unknown durable completion replacement\n"
            );
        }
    }
    // Real kernfs rmdir keeps the held original fd/inode while removing its
    // named path. Accept that empty original, but reject a new group at exactly
    // the same path after a later StartUnit creates a different inode.
    let pid = fixture.start();
    let original = fixture.retained_group();
    assert!(original.assert_empty().is_err());
    fixture.stop_only();
    assert!(!PathBuf::from(format!("/proc/{pid}")).exists());
    original.assert_empty().unwrap();
    assert_eq!(original.diagnostics()["removedOriginalInode"], true);
    fixture.start();
    assert!(
        original.assert_empty().is_err(),
        "replacement named inode reused old empty witness"
    );
    fixture.stop_only();
    fixture.cancelled_streams_close();
    // A marker survives an observation failure, but proves no physical fence.
    let pid = fixture.start();
    let mut changed: SourceUnitV1 =
        serde_json::from_value(serde_json::to_value(&fixture.unit).unwrap()).unwrap();
    changed.argv[1] = "301".into();
    let failure = rollback_result::<()>(Err(error("private_restart_outcome_unknown")), || {
        fixture.refence(&changed)
    });
    assert_eq!(failure.err().unwrap().code, CODE);
    assert!(fixture.marker.exists());
    assert!(PathBuf::from(format!("/proc/{pid}")).exists());
    fs::remove_file(&fixture.marker).unwrap();
    fs::remove_file(&fixture.drop_in).unwrap();
    fixture.refence(&fixture.unit).unwrap();
    assert!(!PathBuf::from(format!("/proc/{pid}")).exists());
    fixture.clean().unwrap();
}
