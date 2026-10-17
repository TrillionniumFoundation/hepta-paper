use super::*;
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::fs::symlink,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-socket-pub-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn path(&self) -> PathBuf {
        self.0.join("authority.sock")
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn no_staging(temp: &Temp) {
    no_staging_in(&temp.0);
}
fn no_staging_in(path: &Path) {
    assert!(
        !fs::read_dir(path).unwrap().any(|v| v
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".s-"))
    );
}
fn wait_refused(path: &Path) {
    // Parallel tests spawn real processes. Between fork and exec, a child can
    // briefly retain a CLOEXEC listener that this test has already dropped.
    // Production must conservatively refuse such an active socket; only wait
    // here until the deliberately abandoned fixture really is refused.
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let state = probe(path);
        if state == Probe::Refused {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "abandoned socket stayed {state:?}"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn long_parent_and_short_socket_match_actual_node_staging_path_budget() {
    let temp = Temp::new();
    // Node's .s-XXXXXX/s staging address is exactly Linux's 107-byte usable
    // pathname limit here, while the short final address is only 97 bytes.
    let component_length = 95 - temp.0.as_os_str().as_bytes().len() - 1;
    let parent = temp.0.join("p".repeat(component_length));
    fs::create_dir(&parent).unwrap();
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(parent.as_os_str().as_bytes().len(), 95);
    let path = parent.join("s");
    let oracle = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../paper-adapters/runtime/atomic-unix-socket-publication.mjs")
        .canonicalize()
        .unwrap();
    let output = Command::new("node")
        .args([
            "--input-type=module",
            "-e",
            r#"import net from 'node:net';
import { pathToFileURL } from 'node:url';
const { listenOnAtomicUnixSocket } = await import(pathToFileURL(process.argv[1]));
const published = await listenOnAtomicUnixSocket({
  server: net.createServer(), socketPath: process.argv[2], socketMode: 0o660,
});
await published.close();"#,
        ])
        .arg(oracle)
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "actual incumbent publication failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!path.exists());
    no_staging_in(&parent);
    let (listener, published) = bind(&path).unwrap();
    published.assert_current().unwrap();
    no_staging_in(&parent);
    drop(listener);
    drop(published);
    assert!(!path.exists());
}

#[test]
fn actual_refused_socket_is_reclaimed_and_live_listener_is_preserved() {
    let temp = Temp::new();
    let path = temp.path();
    let old = UnixListener::bind(&path).unwrap();
    assert_eq!(probe(&path), Probe::Active);
    drop(old);
    wait_refused(&path);
    let (listener, published) = bind(&path).unwrap();
    published.assert_current().unwrap();
    assert_eq!(published.path(), path);
    assert_eq!(fs::symlink_metadata(&path).unwrap().mode() & 0o7777, 0o660);
    no_staging(&temp);
    let before = fs::symlink_metadata(&path).unwrap();
    assert_eq!(bind(&path).err().unwrap().code, CONFLICT);
    assert_eq!(
        identity(&fs::symlink_metadata(&path).unwrap()),
        identity(&before)
    );
    published.assert_current().unwrap();
    drop(listener);
    drop(published);
    assert!(!path.exists());
}
#[test]
fn files_symlinks_and_hardlinked_sockets_are_never_reclaimed() {
    for kind in ["file", "symlink", "hardlink"] {
        let temp = Temp::new();
        let path = temp.path();
        let other = temp.0.join("other");
        match kind {
            "file" => fs::write(&path, b"sentinel").unwrap(),
            "symlink" => {
                fs::write(&other, b"sentinel").unwrap();
                symlink(&other, &path).unwrap();
            }
            _ => {
                drop(UnixListener::bind(&path).unwrap());
                fs::hard_link(&path, &other).unwrap();
            }
        }
        let before = fs::symlink_metadata(&path).unwrap();
        assert_eq!(bind(&path).err().unwrap().code, CONFLICT);
        let after = fs::symlink_metadata(&path).unwrap();
        assert_eq!(identity(&before), identity(&after));
        assert_eq!(after.nlink(), before.nlink());
        no_staging(&temp);
    }
}
#[test]
fn full_listen_backlog_is_uncertain_and_cannot_trigger_unlink() {
    let temp = Temp::new();
    let path = temp.path();
    let listener = UnixListener::bind(&path).unwrap();
    nix::sys::socket::listen(&listener, nix::sys::socket::Backlog::new(0).unwrap()).unwrap();
    let _queued = UnixStream::connect(&path).unwrap();
    let before = fs::symlink_metadata(&path).unwrap();
    let started = Instant::now();
    assert_eq!(probe(&path), Probe::Uncertain);
    assert_eq!(bind(&path).err().unwrap().code, CONFLICT);
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(
        identity(&before),
        identity(&fs::symlink_metadata(&path).unwrap())
    );
}

#[test]
fn refusal_never_authorizes_unlink_after_identity_permission_or_parent_change() {
    for changed in ["inode", "mode", "parent"] {
        let temp = Temp::new();
        let path = temp.path();
        drop(UnixListener::bind(&path).unwrap());
        let parent = Parent::open(&temp.0).unwrap();
        let before = fs::symlink_metadata(&path).unwrap();
        wait_refused(&path);
        let mut replacement = None;
        match changed {
            "inode" => {
                fs::rename(&path, temp.0.join("old.sock")).unwrap();
                replacement = Some(UnixListener::bind(&path).unwrap());
            }
            "mode" => fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap(),
            _ => fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o750)).unwrap(),
        }
        let current = fs::symlink_metadata(&path).unwrap();
        assert!(remove_refused(&path, &parent, &before).is_err());
        assert_eq!(
            identity(&fs::symlink_metadata(&path).unwrap()),
            identity(&current)
        );
        drop(replacement);
    }
}

#[test]
fn staging_cleanup_cannot_delete_replaced_socket_or_directory() {
    for changed in ["socket", "directory"] {
        let temp = Temp::new();
        let parent = Arc::new(Parent::open(&temp.0).unwrap());
        let mut stage = Staging::create(&parent).unwrap();
        let component = stage.path.file_name().unwrap().as_bytes();
        assert_eq!(component.len(), 9);
        assert!(component.starts_with(b".s-"));
        assert!(component[3..].iter().all(u8::is_ascii_alphanumeric));
        let socket = stage.path.join("s");
        let listener = UnixListener::bind(&socket).unwrap();
        stage.socket = Some(fs::symlink_metadata(&socket).unwrap());
        let saved = temp.0.join("saved");
        if changed == "socket" {
            fs::rename(&socket, &saved).unwrap();
        } else {
            fs::rename(&stage.path, &saved).unwrap();
            fs::create_dir(&stage.path).unwrap();
            fs::set_permissions(&stage.path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fs::write(&socket, b"operator replacement").unwrap();
        assert!(stage.clean().is_err());
        drop(stage);
        assert_eq!(fs::read(&socket).unwrap(), b"operator replacement");
        assert!(saved.exists());
        drop(listener);
    }
}
#[test]
fn staging_cleanup_preserves_same_inode_after_ancestor_rename_and_symlink() {
    let temp = Temp::new();
    let path = temp.0.join("parent");
    fs::create_dir(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    let parent = Arc::new(Parent::open(&path).unwrap());
    let mut stage = Staging::create(&parent).unwrap();
    let socket = stage.path.join("s");
    let listener = UnixListener::bind(&socket).unwrap();
    let expected = fs::symlink_metadata(&socket).unwrap();
    stage.socket = Some(expected.clone());
    let moved = temp.0.join("moved");
    fs::rename(&path, &moved).unwrap();
    symlink(&moved, &path).unwrap();
    // The old final-name-only test would still see precisely the pinned inode.
    assert_eq!(
        identity(&fs::symlink_metadata(&socket).unwrap()),
        identity(&expected)
    );
    assert!(stage.assert_current().is_err());
    assert!(stage.clean().is_err());
    drop(stage);
    assert_eq!(
        identity(&fs::symlink_metadata(&socket).unwrap()),
        identity(&expected)
    );
    drop(listener);
}
#[test]
fn private_parent_and_sticky_trusted_ancestors_are_enforced() {
    let temp = Temp::new();
    fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(bind(&temp.path()).err().unwrap().code, PARENT);
    fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o750)).unwrap();
    let (listener, published) = bind(&temp.path()).unwrap();
    drop(listener);
    drop(published);
    fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o777)).unwrap();
    let child = temp.0.join("private");
    fs::create_dir(&child).unwrap();
    fs::set_permissions(&child, fs::Permissions::from_mode(0o700)).unwrap();
    let path = child.join("authority.sock");
    assert_eq!(bind(&path).err().unwrap().code, PARENT);
    fs::set_permissions(&temp.0, fs::Permissions::from_mode(0o1777)).unwrap();
    let (listener, published) = bind(&path).unwrap();
    published.assert_current().unwrap();
    drop(listener);
    drop(published);
}
#[test]
fn cleanup_preserves_replacements_and_namespace_drift() {
    let temp = Temp::new();
    let path = temp.path();
    let (listener, published) = bind(&path).unwrap();
    let saved = temp.0.join("saved.sock");
    fs::rename(&path, &saved).unwrap();
    fs::write(&path, b"replacement").unwrap();
    assert!(published.assert_current().is_err());
    drop(listener);
    drop(published);
    assert_eq!(fs::read(&path).unwrap(), b"replacement");
    assert!(saved.exists());
    let outer = Temp::new();
    let parent = outer.0.join("parent");
    fs::create_dir(&parent).unwrap();
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
    let path = parent.join("authority.sock");
    let (listener, published) = bind(&path).unwrap();
    let moved = outer.0.join("moved");
    fs::rename(&parent, &moved).unwrap();
    symlink(&moved, &parent).unwrap();
    assert!(published.assert_current().is_err());
    drop(listener);
    drop(published);
    assert!(moved.join("authority.sock").exists());
}
#[test]
fn killed_socket_owner_child() {
    let Some(path) = std::env::var_os("HEPTA_SOCKET_PUBLICATION_CRASH_CHILD") else {
        return;
    };
    let (_listener, _published) = bind(Path::new(&path)).unwrap();
    println!("PUBLICATION_READY");
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::park();
    }
}
#[test]
fn actual_sigkill_residue_can_be_republished_safely() {
    let temp = Temp::new();
    let path = temp.path();
    let mut child = Command::new("/proc/self/exe")
        .args([
            "--exact",
            "local_state_authority::server::publication::tests::killed_socket_owner_child",
            "--nocapture",
        ])
        .env("HEPTA_SOCKET_PUBLICATION_CRASH_CHILD", &path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    loop {
        line.clear();
        assert!(
            output.read_line(&mut line).unwrap() > 0,
            "child exited before publication"
        );
        if line.contains("PUBLICATION_READY") {
            break;
        }
    }
    child.kill().unwrap();
    assert!(!child.wait().unwrap().success());
    assert!(path.exists());
    assert_eq!(probe(&path), Probe::Refused);
    let (listener, published) = bind(&path).unwrap();
    published.assert_current().unwrap();
    drop(listener);
    drop(published);
    assert!(!path.exists());
    no_staging(&temp);
}
