use super::*;
use std::{
    fs,
    os::unix::net::UnixListener,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
const CHILD: &str =
    "local_state_authority_client::manager::kernel_identity::tests::kernel_identity_child";
const STATUS: &[u8] = b"Name:\tdaemon\nTgid:\t17\nPid:\t17\nUid:\t1 2 3 4\nGid:\t5 6 7 8\nGroups:\t6 9 1000 \nNSpid:\t17 2\n";
const FDINFO: &[u8] = b"pos:\t0\nflags:\t02000002\nmnt_id:\t5\nino:\t19\nPid:\t17\nNSpid:\t17 2\n";

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "hepta-kernel-identity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("fixture directory");
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct ChildOwner(Child);
impl Drop for ChildOwner {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

#[test]
fn actual_socket_peer_kernel_groups_match_the_unchanged_current_process() {
    let (socket, _peer) = UnixStream::pair().expect("real socket pair");
    let origin = peer::SocketPeer::observe(&socket, deadline()).expect("actual pidfd");
    let observed = observe(&origin, deadline()).expect("actual original peer status");
    assert_eq!(observed.pid, std::process::id());
    assert_eq!(observed.tgid, std::process::id());
    assert_eq!(observed.uids[0], nix::unistd::getuid().as_raw());
    assert_eq!(observed.uids[1], nix::unistd::geteuid().as_raw());
    assert_eq!(observed.gids[0], nix::unistd::getgid().as_raw());
    assert_eq!(observed.gids[1], nix::unistd::getegid().as_raw());
    assert_eq!(
        observed.supplementary_gids,
        nix::unistd::getgroups()
            .expect("kernel getgroups")
            .into_iter()
            .map(|gid| gid.as_raw())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        observe(&origin, deadline()).expect("reobserve unchanged"),
        observed
    );
    assert_eq!(observed.report()["procDescriptorsClosedBeforeReturn"], true);
}

#[test]
fn fdinfo_binding_and_status_preserve_actual_numeric_semantics() {
    let binding = parse_fdinfo(FDINFO).expect("pidfd fdinfo");
    let identity = parse_status(STATUS).expect("status");
    assert_eq!(binding.pid, identity.pid);
    assert_eq!(binding.namespace_pids, identity.namespace_pids);
    assert_eq!(identity.uids, [1, 2, 3, 4]);
    assert_eq!(identity.gids, [5, 6, 7, 8]);
    assert_eq!(identity.supplementary_gids, [6, 9, 1000]);
    assert_status_binding(&binding, &identity, 17, 2, 6).expect("same kernel subject");
    assert!(assert_status_binding(&binding, &identity, 18, 2, 6).is_err());
    assert!(assert_status_binding(&binding, &identity, 17, 3, 6).is_err());
    assert!(assert_status_binding(&binding, &identity, 17, 2, 7).is_err());
    let status = String::from_utf8(STATUS.to_vec()).expect("fixture");
    for value in [
        status.replace("17", "18"),
        status.replace("Tgid:\t17", "Tgid:\t18"),
        status.replace("17 2", "17 3"),
    ] {
        let other = parse_status(value.as_bytes()).expect("well-shaped but different subject");
        assert!(assert_status_binding(&binding, &other, 17, 2, 6).is_err());
    }
    let empty = String::from_utf8(STATUS.to_vec())
        .expect("fixture")
        .replace("6 9 1000 ", "");
    assert!(
        parse_status(empty.as_bytes())
            .expect("empty groups allowed")
            .supplementary_gids
            .is_empty()
    );
    // Linux can preserve duplicate supplemental IDs; this is an observation
    // of the actual list, not a normalized configured-name set.
    let repeated = String::from_utf8(STATUS.to_vec())
        .expect("fixture")
        .replace("6 9 1000 ", "6 6 ");
    assert_eq!(
        parse_status(repeated.as_bytes())
            .expect("actual repeated IDs")
            .supplementary_gids,
        [6, 6]
    );
}

#[test]
fn duplicate_missing_malformed_and_inconsistent_critical_fields_are_refused() {
    for key in ["Pid", "Tgid", "Uid", "Gid", "Groups", "NSpid"] {
        let status = String::from_utf8(STATUS.to_vec()).expect("fixture");
        let line = status
            .lines()
            .find(|line| line.starts_with(&format!("{key}:")))
            .expect("field");
        assert!(
            parse_status(format!("{status}{line}\n").as_bytes()).is_err(),
            "duplicate {key}"
        );
        let missing = status
            .lines()
            .filter(|line| !line.starts_with(&format!("{key}:")))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        assert!(parse_status(missing.as_bytes()).is_err(), "missing {key}");
    }
    for (from, to) in [
        ("Uid:\t1 2 3 4", "Uid:\t1 2 3"),
        ("Gid:\t5 6 7 8", "Gid:\t5 6 7 8 9"),
        ("Uid:\t1 2 3 4", "Uid:\t1 +2 3 4"),
        ("Uid:\t1 2 3 4", "Uid:\t1 -2 3 4"),
        ("Uid:\t1 2 3 4", "Uid:\t1 4294967296 3 4"),
        ("Uid:\t1 2 3 4", "Uid:\t1 02 3 4"),
        ("Groups:\t6 9 1000 ", "Groups:\t6 9x 1000"),
        ("Groups:\t6 9 1000 ", "Groups:\t6\r9 1000"),
        ("Pid:\t17", "Pid:\t0"),
        ("Tgid:\t17", "Tgid:\t2147483648"),
        ("NSpid:\t17 2", "NSpid:\t18 2"),
        ("NSpid:\t17 2", "NSpid:\t17 0"),
    ] {
        let value = String::from_utf8(STATUS.to_vec())
            .expect("fixture")
            .replace(from, to);
        assert!(parse_status(value.as_bytes()).is_err(), "malformed {to}");
    }
    assert!(parse_status(&STATUS[..STATUS.len() - 1]).is_err());
    assert!(parse_status(b"Pid: 17\n\0").is_err());
    assert!(parse_status(b"Pid 17\n").is_err());
    for invalid in [
        b"Pid: -1\nNSpid: -1\n".as_slice(),
        b"Pid: 0\nNSpid: 0\n",
        b"Pid: 17\nNSpid: 18\n",
        b"Pid: 17\nPid: 17\nNSpid: 17\n",
        b"Pid: 17\nNSpid: 17\nNSpid: 17\n",
        b"Pid: 17\n",
    ] {
        assert!(parse_fdinfo(invalid).is_err());
    }
}

#[test]
fn parser_byte_field_group_and_namespace_budgets_have_real_boundaries() {
    let status = String::from_utf8(STATUS.to_vec()).expect("fixture");
    let exact = status.replace("6 9 1000 ", &"1 ".repeat(MAXIMUM_SUPPLEMENTARY_GIDS));
    assert_eq!(
        parse_status(exact.as_bytes())
            .expect("group ceiling")
            .supplementary_gids
            .len(),
        MAXIMUM_SUPPLEMENTARY_GIDS
    );
    let excess = status.replace("6 9 1000 ", &"1 ".repeat(MAXIMUM_SUPPLEMENTARY_GIDS + 1));
    assert!(parse_status(excess.as_bytes()).is_err());
    let namespaces = format!("17{}", " 1".repeat(MAXIMUM_NAMESPACE_PIDS - 1));
    assert_eq!(
        parse_status(status.replace("17 2", &namespaces).as_bytes())
            .expect("namespace ceiling")
            .namespace_pids
            .len(),
        MAXIMUM_NAMESPACE_PIDS
    );
    assert!(
        parse_status(
            status
                .replace("17 2", &format!("{namespaces} 1"))
                .as_bytes()
        )
        .is_err()
    );
    let mut exact_bytes = status.clone();
    exact_bytes.push_str("Padding:");
    exact_bytes.push_str(&"x".repeat(MAXIMUM_STATUS_BYTES - exact_bytes.len() - 1));
    exact_bytes.push('\n');
    assert_eq!(exact_bytes.len(), MAXIMUM_STATUS_BYTES);
    parse_status(exact_bytes.as_bytes()).expect("exact byte budget");
    exact_bytes.push('\n');
    assert!(parse_status(exact_bytes.as_bytes()).is_err());
    let too_many = (0..MAXIMUM_STATUS_FIELDS + 1)
        .map(|index| format!("F{index}: 0\n"))
        .collect::<String>();
    assert!(records(too_many.as_bytes(), MAXIMUM_STATUS_BYTES).is_err());
    assert!(parse_fdinfo(&vec![b'x'; MAXIMUM_FDINFO_BYTES + 1]).is_err());
}

#[test]
fn bounded_positional_read_and_real_procfs_refusal_preserve_resource_rules() {
    let directory = Directory::new();
    let path = directory.0.join("status-fixture");
    fs::write(&path, b"abcd").expect("bounded file");
    let file = File::open(&path).expect("reader");
    assert_eq!(
        read_bounded(&file, 4, deadline()).expect("at bound"),
        b"abcd"
    );
    fs::write(&path, b"abcde").expect("one extra byte");
    assert!(read_bounded(&file, 4, deadline()).is_err());
    assert!(read_bounded(&file, 4, Instant::now()).is_err());
    assert_eq!(
        verify_procfs(&file)
            .expect_err("regular fixture is not procfs")
            .to_string(),
        NAMESPACE
    );
    let proc = File::from(
        open(
            Path::new("/proc"),
            OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .expect("actual proc"),
    );
    verify_procfs(&proc).expect("actual procfs type");
    let device = proc.metadata().expect("proc device").dev();
    assert!(
        open_proc_child(&proc, Path::new("self"), true, device).is_err(),
        "generic opens never follow the magic link"
    );
}

fn fd_targets() -> BTreeMap<i32, PathBuf> {
    let own_listing = PathBuf::from(format!("/proc/{}/fd", std::process::id()));
    fs::read_dir("/proc/self/fd")
        .expect("owned process descriptors")
        .filter_map(|entry| {
            let entry = entry.expect("fd entry");
            let target = fs::read_link(entry.path()).expect("fd target");
            if target == own_listing {
                return None;
            }
            Some((
                entry
                    .file_name()
                    .to_str()
                    .expect("fd decimal")
                    .parse()
                    .expect("fd number"),
                target,
            ))
        })
        .collect()
}

#[test]
#[ignore = "owned independent process fixture, selected only by the parent test"]
fn kernel_identity_child() {
    let root =
        PathBuf::from(std::env::var_os("HEPTA_KERNEL_IDENTITY_CHILD_ROOT").expect("child root"));
    let _listener = UnixListener::bind(root.join("peer.sock")).expect("owned child listener");
    let (socket, _peer) = UnixStream::pair().expect("own kernel peer");
    let origin = peer::SocketPeer::observe(&socket, deadline()).expect("own original pidfd");
    let baseline = fd_targets();
    for _ in 0..3 {
        observe(&origin, deadline()).expect("actual proc observation");
        assert_eq!(
            fd_targets(),
            baseline,
            "all proc/status/fdinfo handles closed before return"
        );
    }
    let mut control = UnixStream::connect(root.join("control.sock")).expect("parent control");
    let report = json!({
        "pid":std::process::id(),"uid":nix::unistd::geteuid().as_raw(),"gid":nix::unistd::getegid().as_raw(),
        "groups":nix::unistd::getgroups().expect("getgroups").into_iter().map(|value| value.as_raw()).collect::<Vec<_>>()
    });
    let bytes = serde_json::to_vec(&report).expect("child facts");
    control.write_all(&bytes).expect("actual child facts");
    control.shutdown(Shutdown::Write).expect("fact EOF");
    let mut release = [0_u8; 1];
    control
        .set_read_timeout(Some(Duration::from_secs(10)))
        .expect("release bound");
    assert_eq!(control.read(&mut release).expect("parent release"), 1);
}

#[test]
fn independent_original_peer_status_is_bound_to_its_pidfd_and_refuses_exit() {
    let directory = Directory::new();
    let listener = UnixListener::bind(directory.0.join("control.sock")).expect("control");
    listener.set_nonblocking(true).expect("bounded accept");
    let mut child = ChildOwner(
        Command::new("/proc/self/exe")
            .args(["--exact", CHILD, "--ignored", "--nocapture"])
            .env("HEPTA_KERNEL_IDENTITY_CHILD_ROOT", &directory.0)
            .stdout(Stdio::null())
            .spawn()
            .expect("independent child"),
    );
    let end = deadline();
    let mut control = loop {
        match listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => panic!("control accept: {error}"),
        }
        assert!(Instant::now() < end, "child readiness deadline");
        assert!(child.0.try_wait().expect("child status").is_none());
        thread::sleep(Duration::from_millis(10));
    };
    control
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("fact deadline");
    let mut bytes = Vec::new();
    (&mut control)
        .take(MAXIMUM_STATUS_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .expect("child facts");
    assert!(bytes.len() <= MAXIMUM_STATUS_BYTES);
    let expected: Value = serde_json::from_slice(&bytes).expect("actual child getgroups");
    let socket = UnixStream::connect(directory.0.join("peer.sock")).expect("actual child peer");
    let origin = peer::SocketPeer::observe(&socket, deadline()).expect("original kernel pidfd");
    let observed = observe(&origin, deadline()).expect("actual child status");
    assert_eq!(observed.pid, child.0.id());
    assert_eq!(json!(observed.pid), expected["pid"]);
    assert_eq!(json!(observed.uids[1]), expected["uid"]);
    assert_eq!(json!(observed.gids[1]), expected["gid"]);
    assert_eq!(json!(observed.supplementary_gids), expected["groups"]);
    control.write_all(&[1]).expect("child may exit");
    assert!(child.0.wait().expect("reap child").success());
    assert_eq!(
        observe(&origin, deadline())
            .expect_err("dead original peer")
            .to_string(),
        "local_state_authority_socket_peer_exited"
    );
}
