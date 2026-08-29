use std::{
    collections::BTreeSet,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        net::{UnixDatagram, UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, Mutex},
};

use nix::sys::socket::{getsockopt, sockopt::PeerCredentials};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::BrokerServiceErrorV2;

const MAXIMUM_SOCKET_PATH_BYTES: usize = 100;
const MAXIMUM_MARKER_BYTES: u64 = 64 * 1024;
const MARKER_SUFFIX: &str = ".listener-v2.json";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ListenerAccessModeV2 {
    ServiceOnly,
    SharedRoleGroup,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct PeerPrincipalV2 {
    pub uid: u32,
    pub gid: u32,
}

#[derive(Clone, Debug)]
pub struct ListenerPolicyV2 {
    pub socket_path: PathBuf,
    pub service_uid: u32,
    pub service_gid: u32,
    pub parent_mode: u32,
    pub socket_mode: u32,
    pub generation: u64,
    pub access_mode: ListenerAccessModeV2,
    pub allowed_peers: BTreeSet<PeerPrincipalV2>,
}

impl ListenerPolicyV2 {
    pub fn validate(&self) -> Result<(), BrokerServiceErrorV2> {
        if self.generation == 0
            || !self.socket_path.is_absolute()
            || self.socket_path.file_name().is_none()
            || self.socket_path.as_os_str().as_bytes().len() > MAXIMUM_SOCKET_PATH_BYTES
            || self.allowed_peers.is_empty()
        {
            return Err(BrokerServiceErrorV2::InvalidPolicy);
        }
        match self.access_mode {
            ListenerAccessModeV2::ServiceOnly => {
                if self.parent_mode != 0o700 || self.socket_mode != 0o600 {
                    return Err(BrokerServiceErrorV2::InvalidPolicy);
                }
                if self
                    .allowed_peers
                    .iter()
                    .any(|peer| peer.uid != self.service_uid)
                {
                    return Err(BrokerServiceErrorV2::InvalidPolicy);
                }
            }
            ListenerAccessModeV2::SharedRoleGroup => {
                if !matches!(self.parent_mode, 0o710 | 0o750)
                    || self.socket_mode != 0o660
                    || self
                        .allowed_peers
                        .iter()
                        .any(|peer| peer.gid != self.service_gid)
                {
                    return Err(BrokerServiceErrorV2::InvalidPolicy);
                }
            }
        }
        Ok(())
    }

    fn marker_path(&self) -> PathBuf {
        let mut value = OsString::from(self.socket_path.as_os_str());
        value.push(MARKER_SUFFIX);
        PathBuf::from(value)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListenerIdentityV2 {
    pub path_hash: String,
    pub device: u64,
    pub inode: u64,
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
    pub links: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ListenerPhaseV2 {
    Binding,
    Ready,
    Stopped,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListenerMarkerV2 {
    version: u16,
    generation: u64,
    phase: ListenerPhaseV2,
    policy_hash: String,
    identity: Option<ListenerIdentityV2>,
}

#[derive(Clone)]
pub struct ShutdownHandleV2 {
    sender: Arc<Mutex<UnixDatagram>>,
}

impl ShutdownHandleV2 {
    pub fn request_shutdown(&self) -> Result<(), BrokerServiceErrorV2> {
        let sender = self
            .sender
            .lock()
            .map_err(|_| BrokerServiceErrorV2::ShutdownWakeupFailed)?;
        sender
            .send(b"shutdown")
            .map_err(|_| BrokerServiceErrorV2::ShutdownWakeupFailed)?;
        Ok(())
    }
}

pub(crate) enum ListenerEventV2 {
    Connection(UnixStream),
    Shutdown,
    Idle,
}

pub struct RoleListenerV2 {
    listener: Option<UnixListener>,
    policy: ListenerPolicyV2,
    identity: ListenerIdentityV2,
    marker_path: PathBuf,
    shutdown_sender: Arc<Mutex<UnixDatagram>>,
    shutdown_receiver: UnixDatagram,
    stopped: bool,
}

impl RoleListenerV2 {
    pub fn bind(policy: ListenerPolicyV2) -> Result<Self, BrokerServiceErrorV2> {
        policy.validate()?;
        inspect_parent(&policy)?;
        let marker_path = policy.marker_path();
        recover_predecessor(&policy, &marker_path)?;
        write_marker(
            &marker_path,
            &ListenerMarkerV2 {
                version: 2,
                generation: policy.generation,
                phase: ListenerPhaseV2::Binding,
                policy_hash: hash_policy(&policy)?,
                identity: None,
            },
            &policy,
        )?;
        let listener = UnixListener::bind(&policy.socket_path)
            .map_err(|error| BrokerServiceErrorV2::Socket("bind", error.kind()))?;
        fs::set_permissions(
            &policy.socket_path,
            fs::Permissions::from_mode(policy.socket_mode),
        )
        .map_err(|error| BrokerServiceErrorV2::Filesystem("socket_mode", error.kind()))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| BrokerServiceErrorV2::Socket("nonblocking", error.kind()))?;
        let identity = inspect_socket(&policy)?;
        let (shutdown_sender, shutdown_receiver) = UnixDatagram::pair()
            .map_err(|error| BrokerServiceErrorV2::Socket("shutdown_pair", error.kind()))?;
        shutdown_sender
            .set_nonblocking(true)
            .map_err(|error| BrokerServiceErrorV2::Socket("shutdown_sender", error.kind()))?;
        shutdown_receiver
            .set_nonblocking(true)
            .map_err(|error| BrokerServiceErrorV2::Socket("shutdown_receiver", error.kind()))?;
        write_marker(
            &marker_path,
            &ListenerMarkerV2 {
                version: 2,
                generation: policy.generation,
                phase: ListenerPhaseV2::Ready,
                policy_hash: hash_policy(&policy)?,
                identity: Some(identity.clone()),
            },
            &policy,
        )?;
        Ok(Self {
            listener: Some(listener),
            policy,
            identity,
            marker_path,
            shutdown_sender: Arc::new(Mutex::new(shutdown_sender)),
            shutdown_receiver,
            stopped: false,
        })
    }

    #[must_use]
    pub fn shutdown_handle(&self) -> ShutdownHandleV2 {
        ShutdownHandleV2 {
            sender: self.shutdown_sender.clone(),
        }
    }

    #[must_use]
    pub fn identity(&self) -> &ListenerIdentityV2 {
        &self.identity
    }

    pub fn authorize_peer(&self, stream: &UnixStream) -> Result<PeerPrincipalV2, BrokerServiceErrorV2> {
        let credentials = getsockopt(stream, PeerCredentials)
            .map_err(|_| BrokerServiceErrorV2::PeerUnauthorized)?;
        let peer = PeerPrincipalV2 {
            uid: credentials.uid(),
            gid: credentials.gid(),
        };
        if !self.policy.allowed_peers.contains(&peer) {
            return Err(BrokerServiceErrorV2::PeerUnauthorized);
        }
        Ok(peer)
    }

    pub(crate) fn accept_or_shutdown(&self) -> Result<ListenerEventV2, BrokerServiceErrorV2> {
        let mut buffer = [0_u8; 32];
        match self.shutdown_receiver.recv(&mut buffer) {
            Ok(_) => return Ok(ListenerEventV2::Shutdown),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(BrokerServiceErrorV2::Socket("shutdown_receive", error.kind())),
        }
        let listener = self
            .listener
            .as_ref()
            .ok_or(BrokerServiceErrorV2::ListenerSocketInvalid)?;
        match listener.accept() {
            Ok((stream, _)) => Ok(ListenerEventV2::Connection(stream)),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                Ok(ListenerEventV2::Idle)
            }
            Err(error) => Err(BrokerServiceErrorV2::Socket("accept", error.kind())),
        }
    }

    pub fn shutdown(mut self) -> Result<(), BrokerServiceErrorV2> {
        self.stop_inner()
    }

    fn stop_inner(&mut self) -> Result<(), BrokerServiceErrorV2> {
        if self.stopped {
            return Ok(());
        }
        drop(self.listener.take());
        let observed = inspect_socket(&self.policy)?;
        if observed != self.identity {
            return Err(BrokerServiceErrorV2::ListenerIdentityChanged);
        }
        fs::remove_file(&self.policy.socket_path)
            .map_err(|error| BrokerServiceErrorV2::Filesystem("socket_remove", error.kind()))?;
        sync_parent(&self.policy.socket_path)?;
        write_marker(
            &self.marker_path,
            &ListenerMarkerV2 {
                version: 2,
                generation: self.policy.generation,
                phase: ListenerPhaseV2::Stopped,
                policy_hash: hash_policy(&self.policy)?,
                identity: Some(self.identity.clone()),
            },
            &self.policy,
        )?;
        self.stopped = true;
        Ok(())
    }
}

impl Drop for RoleListenerV2 {
    fn drop(&mut self) {
        if !self.stopped {
            let _ = self.stop_inner();
        }
    }
}

fn inspect_parent(policy: &ListenerPolicyV2) -> Result<(), BrokerServiceErrorV2> {
    let parent = policy
        .socket_path
        .parent()
        .ok_or(BrokerServiceErrorV2::ListenerParentInvalid)?;
    let canonical = fs::canonicalize(parent)
        .map_err(|error| BrokerServiceErrorV2::Filesystem("listener_parent", error.kind()))?;
    let metadata = fs::symlink_metadata(parent)
        .map_err(|error| BrokerServiceErrorV2::Filesystem("listener_parent", error.kind()))?;
    if canonical != parent
        || metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != policy.service_uid
        || metadata.gid() != policy.service_gid
        || metadata.mode() & 0o7777 != policy.parent_mode
    {
        return Err(BrokerServiceErrorV2::ListenerParentInvalid);
    }
    Ok(())
}

fn inspect_socket(policy: &ListenerPolicyV2) -> Result<ListenerIdentityV2, BrokerServiceErrorV2> {
    let metadata = fs::symlink_metadata(&policy.socket_path)
        .map_err(|error| BrokerServiceErrorV2::Filesystem("listener_socket", error.kind()))?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_socket()
        || metadata.uid() != policy.service_uid
        || metadata.gid() != policy.service_gid
        || metadata.mode() & 0o7777 != policy.socket_mode
        || metadata.nlink() != 1
    {
        return Err(BrokerServiceErrorV2::ListenerSocketInvalid);
    }
    Ok(ListenerIdentityV2 {
        path_hash: hash_path(&policy.socket_path)?,
        device: metadata.dev(),
        inode: metadata.ino(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        mode: metadata.mode() & 0o7777,
        links: metadata.nlink(),
    })
}

fn recover_predecessor(
    policy: &ListenerPolicyV2,
    marker_path: &Path,
) -> Result<(), BrokerServiceErrorV2> {
    let marker = load_marker(marker_path)?;
    if let Some(marker) = &marker {
        if marker.version != 2
            || marker.policy_hash != hash_policy(policy)?
            || marker.generation >= policy.generation
        {
            return Err(BrokerServiceErrorV2::ListenerGenerationRollback);
        }
    }
    match fs::symlink_metadata(&policy.socket_path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.file_type().is_socket() {
                return Err(BrokerServiceErrorV2::ListenerSocketInvalid);
            }
            match UnixStream::connect(&policy.socket_path) {
                Ok(_) => return Err(BrokerServiceErrorV2::LiveListenerExists),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionRefused
                            | std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::NotFound
                    ) => {}
                Err(error) => return Err(BrokerServiceErrorV2::Socket("stale_probe", error.kind())),
            }
            let marker = marker.ok_or(BrokerServiceErrorV2::UnrecordedStaleListener)?;
            let expected = marker
                .identity
                .ok_or(BrokerServiceErrorV2::ListenerMarkerInvalid)?;
            let observed = ListenerIdentityV2 {
                path_hash: hash_path(&policy.socket_path)?,
                device: metadata.dev(),
                inode: metadata.ino(),
                uid: metadata.uid(),
                gid: metadata.gid(),
                mode: metadata.mode() & 0o7777,
                links: metadata.nlink(),
            };
            if observed != expected {
                return Err(BrokerServiceErrorV2::ListenerIdentityChanged);
            }
            let after = fs::symlink_metadata(&policy.socket_path)
                .map_err(|error| BrokerServiceErrorV2::Filesystem("stale_recheck", error.kind()))?;
            if after.dev() != metadata.dev() || after.ino() != metadata.ino() {
                return Err(BrokerServiceErrorV2::ListenerIdentityChanged);
            }
            fs::remove_file(&policy.socket_path)
                .map_err(|error| BrokerServiceErrorV2::Filesystem("stale_remove", error.kind()))?;
            sync_parent(&policy.socket_path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(BrokerServiceErrorV2::Filesystem(
                "listener_preflight",
                error.kind(),
            ));
        }
    }
    Ok(())
}

fn load_marker(path: &Path) -> Result<Option<ListenerMarkerV2>, BrokerServiceErrorV2> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(BrokerServiceErrorV2::Filesystem(
                "marker_metadata",
                error.kind(),
            ));
        }
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.mode() & 0o7777 != 0o600
        || metadata.nlink() != 1
        || metadata.size() == 0
        || metadata.size() > MAXIMUM_MARKER_BYTES
    {
        return Err(BrokerServiceErrorV2::ListenerMarkerInvalid);
    }
    let mut file = File::open(path)
        .map_err(|error| BrokerServiceErrorV2::Filesystem("marker_open", error.kind()))?;
    let opened = file
        .metadata()
        .map_err(|error| BrokerServiceErrorV2::Filesystem("marker_open", error.kind()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| BrokerServiceErrorV2::Filesystem("marker_read", error.kind()))?;
    let after = file
        .metadata()
        .map_err(|error| BrokerServiceErrorV2::Filesystem("marker_recheck", error.kind()))?;
    if opened.dev() != after.dev()
        || opened.ino() != after.ino()
        || opened.size() != after.size()
    {
        return Err(BrokerServiceErrorV2::ListenerMarkerInvalid);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| BrokerServiceErrorV2::ListenerMarkerInvalid)
}

fn write_marker(
    path: &Path,
    marker: &ListenerMarkerV2,
    policy: &ListenerPolicyV2,
) -> Result<(), BrokerServiceErrorV2> {
    let bytes = serde_json::to_vec(marker).map_err(|_| BrokerServiceErrorV2::Serialization)?;
    if bytes.is_empty()
        || u64::try_from(bytes.len()).map_or(true, |size| size > MAXIMUM_MARKER_BYTES)
    {
        return Err(BrokerServiceErrorV2::ListenerMarkerInvalid);
    }
    let temporary = path.with_extension(format!("tmp.{}", policy.generation));
    match fs::remove_file(&temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(BrokerServiceErrorV2::Filesystem(
                "marker_temp_remove",
                error.kind(),
            ));
        }
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| BrokerServiceErrorV2::Filesystem("marker_create", error.kind()))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| BrokerServiceErrorV2::Filesystem("marker_write", error.kind()))?;
    fs::rename(&temporary, path)
        .map_err(|error| BrokerServiceErrorV2::Filesystem("marker_publish", error.kind()))?;
    sync_parent(path)
}

fn hash_policy(policy: &ListenerPolicyV2) -> Result<String, BrokerServiceErrorV2> {
    let mode = match policy.access_mode {
        ListenerAccessModeV2::ServiceOnly => "service_only",
        ListenerAccessModeV2::SharedRoleGroup => "shared_role_group",
    };
    let peers = policy
        .allowed_peers
        .iter()
        .map(|peer| format!("{}:{}", peer.uid, peer.gid))
        .collect::<Vec<_>>();
    hash_fields(&[
        b"HeptaListenerPolicyV2",
        policy.socket_path.as_os_str().as_bytes(),
        &policy.service_uid.to_be_bytes(),
        &policy.service_gid.to_be_bytes(),
        &policy.parent_mode.to_be_bytes(),
        &policy.socket_mode.to_be_bytes(),
        mode.as_bytes(),
        peers.join(",").as_bytes(),
    ])
}

fn hash_path(path: &Path) -> Result<String, BrokerServiceErrorV2> {
    hash_fields(&[b"HeptaListenerPathV2", path.as_os_str().as_bytes()])
}

fn hash_fields(fields: &[&[u8]]) -> Result<String, BrokerServiceErrorV2> {
    let mut hasher = Sha256::new();
    for field in fields {
        hasher.update(
            u64::try_from(field.len())
                .map_err(|_| BrokerServiceErrorV2::NumericOverflow)?
                .to_be_bytes(),
        );
        hasher.update(field);
    }
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn sync_parent(path: &Path) -> Result<(), BrokerServiceErrorV2> {
    let parent = path
        .parent()
        .ok_or(BrokerServiceErrorV2::ListenerParentInvalid)?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| BrokerServiceErrorV2::Filesystem("parent_sync", error.kind()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(mode: u32) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "hepta-listener-v2-{}-{nonce}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).expect("create root");
            fs::set_permissions(&path, fs::Permissions::from_mode(mode)).expect("mode");
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn ids(path: &Path) -> (u32, u32) {
        let metadata = fs::metadata(path).expect("metadata");
        (metadata.uid(), metadata.gid())
    }

    #[test]
    fn live_listener_accepts_authorized_peer_and_idle_shutdown_wakes() {
        let root = TempRoot::new(0o700);
        let (uid, gid) = ids(&root.0);
        let socket = root.0.join("broker.sock");
        let policy = ListenerPolicyV2 {
            socket_path: socket.clone(),
            service_uid: uid,
            service_gid: gid,
            parent_mode: 0o700,
            socket_mode: 0o600,
            generation: 1,
            access_mode: ListenerAccessModeV2::ServiceOnly,
            allowed_peers: [PeerPrincipalV2 { uid, gid }].into_iter().collect(),
        };
        let listener = RoleListenerV2::bind(policy).expect("bind");
        let _client = UnixStream::connect(&socket).expect("connect");
        let stream = loop {
            match listener.accept_or_shutdown().expect("accept") {
                ListenerEventV2::Connection(stream) => break stream,
                ListenerEventV2::Idle => std::thread::yield_now(),
                ListenerEventV2::Shutdown => panic!("unexpected shutdown"),
            }
        };
        assert_eq!(
            listener.authorize_peer(&stream).expect("authorize"),
            PeerPrincipalV2 { uid, gid }
        );
        let shutdown = listener.shutdown_handle();
        shutdown.request_shutdown().expect("shutdown request");
        assert!(matches!(
            listener.accept_or_shutdown().expect("shutdown event"),
            ListenerEventV2::Shutdown
        ));
        listener.shutdown().expect("listener shutdown");
    }

    #[test]
    fn shared_group_shape_is_explicit_and_unauthorized_peer_fails() {
        let root = TempRoot::new(0o710);
        let (uid, gid) = ids(&root.0);
        let socket = root.0.join("broker.sock");
        let policy = ListenerPolicyV2 {
            socket_path: socket.clone(),
            service_uid: uid,
            service_gid: gid,
            parent_mode: 0o710,
            socket_mode: 0o660,
            generation: 1,
            access_mode: ListenerAccessModeV2::SharedRoleGroup,
            allowed_peers: [PeerPrincipalV2 { uid: uid.saturating_add(1), gid }]
                .into_iter()
                .collect(),
        };
        let listener = RoleListenerV2::bind(policy).expect("bind");
        let _client = UnixStream::connect(&socket).expect("connect");
        let stream = loop {
            match listener.accept_or_shutdown().expect("accept") {
                ListenerEventV2::Connection(stream) => break stream,
                ListenerEventV2::Idle => std::thread::yield_now(),
                ListenerEventV2::Shutdown => panic!("unexpected shutdown"),
            }
        };
        assert!(matches!(
            listener.authorize_peer(&stream),
            Err(BrokerServiceErrorV2::PeerUnauthorized)
        ));
        assert_eq!(fs::metadata(&socket).expect("socket mode").mode() & 0o7777, 0o660);
        listener.shutdown().expect("shutdown");
    }

    #[test]
    fn ambiguous_permission_shapes_are_rejected() {
        let root = TempRoot::new(0o700);
        let (uid, gid) = ids(&root.0);
        let policy = ListenerPolicyV2 {
            socket_path: root.0.join("broker.sock"),
            service_uid: uid,
            service_gid: gid,
            parent_mode: 0o700,
            socket_mode: 0o660,
            generation: 1,
            access_mode: ListenerAccessModeV2::SharedRoleGroup,
            allowed_peers: [PeerPrincipalV2 { uid, gid }].into_iter().collect(),
        };
        assert!(matches!(policy.validate(), Err(BrokerServiceErrorV2::InvalidPolicy)));
    }
}
