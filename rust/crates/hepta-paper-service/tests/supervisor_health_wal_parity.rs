//! Original repository mutations and actual Node/native base CLI reads over an
//! owned committed WAL. These are diagnostic/storage tests, not a live resident
//! installation, authority qualification, or source concurrency snapshot proof.
#[allow(dead_code)]
mod machine_intake_support;

use hepta_paper_service::journal_connector_coverage::qualification::canonical_instant_millis;
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::{self, BufRead, BufReader, Read},
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        process::ExitStatusExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
const DATABASE: &str = "autonomous-research/supervisor/resident-instance.sqlite";
const SCOPE: &str = "owned_original_repository_committed_wal_diagnostic_no_live_authority";
const MAXIMUM_OUTPUT: u64 = 64 * 1024;

struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let parent = fs::canonicalize(std::env::temp_dir()).unwrap();
        let root = parent.join(format!(
            "hepta-health-wal-parity-{}-{}-{}",
            std::process::id(),
            now_millis(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&root).unwrap();
        let fixture = Self { root };
        fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o700)).unwrap();
        let marker = fixture.root.join(".owned-health-wal-fixture");
        fs::write(&marker, "owned supervisor health WAL fixture\n").unwrap();
        fs::set_permissions(marker, fs::Permissions::from_mode(0o600)).unwrap();
        fixture
    }

    fn command(&self, program: impl AsRef<std::ffi::OsStr>) -> Command {
        let mut command = Command::new(program);
        command
            .current_dir(&self.root)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("LANG", "en_US.UTF-8");
        command
    }

    fn oracle_command(&self) -> Command {
        let mut command = self.command("node");
        command
            .arg(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../oracle/supervisor-health-wal-v1.mjs"),
            )
            .arg(json!({"action":"hold-original-release","root":self.root}).to_string());
        command
    }

    fn node_report(&self) -> Value {
        let mut command = self.command("node");
        command.arg(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../paper-core/bin/autonomous-research-supervisor-health.mjs"),
        );
        self.report(command)
    }

    fn native_report(&self) -> Value {
        self.report(self.command(env!("CARGO_BIN_EXE_hepta-autonomous-supervisor-health")))
    }

    fn report(&self, mut command: Command) -> Value {
        command.arg("--runtime-root").arg(&self.root);
        let before = now_millis();
        let output = machine_intake_support::run(&mut command);
        let after = now_millis();
        assert_eq!(output.status.code(), Some(2), "stopped base health exit");
        let mut report: Value = serde_json::from_slice(&output.stdout).unwrap();
        let inspected = canonical_instant_millis(report["inspectedAt"].as_str().unwrap())
            .expect("actual canonical CLI wallclock");
        assert!(
            before <= inspected && inspected <= after,
            "inspectedAt must be sampled inside this real CLI invocation"
        );
        assert_eq!(report["kind"], "AutonomousResearchSupervisorInstanceStatus");
        assert_eq!(report["instance"]["status"], "stopped");
        assert_eq!(report["instance"]["stopReason"], "owned-committed-wal-stop");
        assert_eq!(report["instance"]["leaseGeneration"], 1);
        assert_eq!(
            report["blockers"],
            json!(["autonomous_research_supervisor_instance_stopped"])
        );
        assert_eq!(report["healthBlockers"], report["blockers"]);
        assert_eq!(report["healthy"], false);
        assert_eq!(report["statusReadOnly"], true);
        // Only the independently validated actual wallclock differs. Every other
        // original field, including row timestamps and nulls, remains compared.
        report.as_object_mut().unwrap().remove("inspectedAt");
        report
    }

    fn sidecar(&self, suffix: &str) -> PathBuf {
        self.root.join(format!("{DATABASE}-{suffix}"))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct Keeper {
    child: Child,
    reader: Option<JoinHandle<()>>,
}
impl Keeper {
    fn start(fixture: &Fixture) -> Self {
        let mut child = fixture
            .oracle_command()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut owner = Self {
            child,
            reader: None,
        };
        let (sender, receiver) = mpsc::channel();
        owner.reader = Some(thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = BufReader::new(stdout.take(MAXIMUM_OUTPUT + 1))
                .read_until(b'\n', &mut bytes)
                .map(|_| bytes);
            let _ = sender.send(result);
        }));
        let bytes = receiver
            .recv_timeout(Duration::from_secs(20))
            .expect("owned WAL keeper startup deadline")
            .expect("owned WAL keeper stdout");
        owner.reader.take().unwrap().join().unwrap();
        assert!(bytes.len() <= MAXIMUM_OUTPUT as usize && bytes.last() == Some(&b'\n'));
        let result: Value = serde_json::from_slice(&bytes).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&result["profile"])
            .expect("actual Node executable and production source profile");
        let value = &result["value"];
        assert_eq!(value["evidenceScope"], SCOPE);
        assert_eq!(value["held"], true);
        assert_eq!(value["oldSnapshotStatus"], "running");
        assert_eq!(value["committedStatus"], "stopped");
        assert!(
            value["walFrames"].as_u64().unwrap() > value["checkpointedFrames"].as_u64().unwrap()
        );
        owner.assert_alive();
        owner
    }

    fn assert_alive(&mut self) {
        assert!(
            self.child.try_wait().unwrap().is_none(),
            "old read transaction must remain owned and alive"
        );
    }

    fn crash_and_reap(mut self) {
        self.assert_alive();
        self.child.kill().unwrap();
        assert_eq!(self.child.wait().unwrap().signal(), Some(9));
        // All original SQLite descriptors are now closed by the kernel. No raw
        // source byte/metadata snapshot is taken before this method completes.
    }
}
impl Drop for Keeper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

fn now_millis() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

#[derive(Debug, Eq, PartialEq)]
struct EntrySnapshot {
    relative: PathBuf,
    // Access times are deliberately omitted: the snapshot's own reads may
    // update them. All identity, ownership, modes, link counts, byte lengths,
    // mutation timestamps and every regular-file byte are compared.
    metadata: (u64, u64, u32, u32, u32, u64, u64, i64, i64, i64, i64),
    contents: Option<Vec<u8>>,
}

fn snapshot(root: &Path) -> Vec<EntrySnapshot> {
    fn visit(root: &Path, path: &Path, entries: &mut Vec<EntrySnapshot>) -> io::Result<()> {
        assert!(entries.len() < 64, "bounded owned fixture inventory");
        let stat = fs::symlink_metadata(path)?;
        assert!(
            stat.is_dir() || stat.is_file(),
            "fixture has no links or special nodes"
        );
        let contents = if stat.is_file() {
            let mut bytes = Vec::new();
            File::open(path)?
                .take(8 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            assert!(bytes.len() <= 8 * 1024 * 1024, "bounded owned fixture file");
            Some(bytes)
        } else {
            None
        };
        entries.push(EntrySnapshot {
            relative: path.strip_prefix(root).unwrap().to_owned(),
            metadata: (
                stat.dev(),
                stat.ino(),
                stat.mode(),
                stat.uid(),
                stat.gid(),
                stat.nlink(),
                stat.len(),
                stat.mtime(),
                stat.mtime_nsec(),
                stat.ctime(),
                stat.ctime_nsec(),
            ),
            contents,
        });
        if stat.is_dir() {
            let mut children = fs::read_dir(path)?
                .map(|entry| entry.map(|entry| entry.path()))
                .collect::<io::Result<Vec<_>>>()?;
            children.sort();
            for child in children {
                visit(root, &child, entries)?;
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    visit(root, root, &mut entries).unwrap();
    entries
}

#[test]
fn committed_original_release_in_held_wal_matches_actual_node_and_native_base_health() {
    let fixture = Fixture::new();
    let mut keeper = Keeper::start(&fixture);
    // This original reader is a separate bounded process, not the keeper. It
    // must finish before the keeper is killed or source-preservation is measured.
    let expected = fixture.node_report();
    keeper.assert_alive();
    assert_eq!(fixture.native_report(), expected);
    keeper.assert_alive();
    keeper.crash_and_reap();
    let before = snapshot(&fixture.root);
    assert_eq!(fixture.native_report(), expected);
    assert!(
        snapshot(&fixture.root) == before,
        "native read changed owned source bytes or metadata"
    );
}

#[test]
fn crashed_committed_release_wal_is_read_without_recreating_owned_source_shm() {
    let fixture = Fixture::new();
    let mut keeper = Keeper::start(&fixture);
    let expected = fixture.node_report();
    keeper.assert_alive();
    keeper.crash_and_reap();
    let shm = fixture.sidecar("shm");
    fs::remove_file(&shm).unwrap();
    assert!(fs::metadata(fixture.sidecar("wal")).unwrap().len() > 32);
    let before = snapshot(&fixture.root);
    // Never invoke original SQLite after SHM removal: doing so would itself
    // rebuild SHM. Native must replay committed frames only in its private copy.
    assert_eq!(fixture.native_report(), expected);
    assert!(!shm.exists());
    assert!(
        snapshot(&fixture.root) == before,
        "native private replay changed owned source bytes or metadata"
    );
}
