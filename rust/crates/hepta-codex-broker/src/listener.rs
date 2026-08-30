use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    str::FromStr,
};

use hepta_codex_protocol::{AgentRole, Sha256Digest};
use nix::sys::socket::{Backlog, listen};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const HARD_MAXIMUM_BACKLOG: i32 = 256;
const HARD_MAXIMUM_SOCKET_PATH_BYTES: usize = 100;
const MARKER_SUFFIX: &str = ".listener.json";
const MAXIMUM_MARKER_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ListenerPhaseV1 {
    Binding,
    Bound,
    Ready,
    Stopped,
}

/// Filesystem accessibility model for one role-specific Unix listener.
///
/// `ServiceOnly` is appropriate when the connecting client shares the service
/// principal. `SharedRoleGroup` grants traversal/connect permission only to the
/// configured service group; kernel `SO_PEERCRED` and the signed capability are
/// still required and remain authoritative.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrokerListenerAccessModeV1 {
    ServiceOnly,
    SharedRoleGroup,
}

/// Stable object identity for one pathname Unix listener.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerSocketIdentityV1 {
    pub path_hash: Sha256Digest,
    pub device: u64,
    pub inode: u64,
    pub mode: u32,
    pub uid: u32,
    pub gid: u32,
    pub link_count: u64,
}

/// Exact deployment bindings for one role-specific listener instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrokerListenerPolicyV1 {
    pub version: u16,
    pub socket_path: PathBuf,
    pub parent_owner_uid: u32,
    pub parent_owner_gid: Option<u32>,
    pub parent_mode: u32,
    pub service_uid: u32,
    pub service_gid: u32,
    pub socket_mode: u32,
    pub access_mode: BrokerListenerAccessModeV1,
    pub instance_generation: u64,
    pub backlog: i32,
    pub role: AgentRole,
    pub runtime_identity_hash: Sha256Digest,
    pub trust_bundle_hash: Sha256Digest,
    pub journal_path_hash: Sha256Digest,
    pub peer_policy_hash: Sha256Digest,
}

impl BrokerListenerPolicyV1 {
    pub fn validate(&self) -> Result<(), BrokerListenerError> {
        if self.version != 1
            || self.instance_generation == 0
            || self.backlog <= 0
            || self.backlog > HARD_MAXIMUM_BACKLOG
            || !self.socket_path.is_absolute()
            || self.socket_path.file_name().is_none()
            || self.socket_path.as_os_str().as_bytes().len() > HARD_MAXIMUM_SOCKET_PATH_BYTES
            || self.parent_mode & 0o7000 != 0
            || self.parent_mode & 0o007 != 0
            || self.socket_mode & 0o7000 != 0
            || self.socket_mode & 0o007 != 0
        {
            return Err(BrokerListenerError::InvalidPolicy);
        }
        let access_is_valid = match self.access_mode {
            BrokerListenerAccessModeV1::ServiceOnly => {
                self.parent_mode == 0o700 && self.socket_mode == 0o600
            }
            BrokerListenerAccessModeV1::SharedRoleGroup => {
                self.parent_owner_gid == Some(self.service_gid)
                    && self.parent_mode == 0o710
                    && self.socket_mode == 0o660
            }
        };
        if !access_is_valid {
            return Err(BrokerListenerError::AccessModeMismatch);
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
struct ListenerMarkerV1 {
    version: u16,
    generation: u64,
    phase: ListenerPhaseV1,
    role: AgentRole,
    access_mode: BrokerListenerAccessModeV1,
    socket_path_hash: Sha256Digest,
    runtime_identity_hash: Sha256Digest,
    trust_bundle_hash: Sha256Digest,
    journal_path_hash: Sha256Digest,
    peer_policy_hash: Sha256Digest,
    socket_identity: Option<BrokerSocketIdentityV1>,
    qualification_hash: Option<Sha256Digest>,
}

/// Evidence that all listener and dependency bindings were stable at readiness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrokerListenerQualificationV1 {
    pub generation: u64,
    pub role: AgentRole,
    pub access_mode: BrokerListenerAccessModeV1,
    pub socket_identity: BrokerSocketIdentityV1,
    pub runtime_identity_hash: Sha256Digest,
    pub trust_bundle_hash: Sha256Digest,
    pub journal_path_hash: Sha256Digest,
    pub peer_policy_hash: Sha256Digest,
    pub qualification_hash: Sha256Digest,
}

/// Bound listener whose pathname and marker are owned by this instance.
pub struct BrokerListenerV1 {
    listener: Option<UnixListener>,
    policy: BrokerListenerPolicyV1,
    socket_identity: BrokerSocketIdentityV1,
    marker_path: PathBuf,
    stopped: bool,
}

impl BrokerListenerV1 {
    /// Recovers a strictly-owned stale predecessor, binds a fresh socket, and writes a bound marker.
    pub fn bind(policy: BrokerListenerPolicyV1) -> Result<Self, BrokerListenerError> {
        policy.validate()?;
        inspect_parent(&policy)?;
        let marker_path = policy.marker_path();
        recover_predecessor(&policy, &marker_path)?;

        write_marker_atomic(
            &marker_path,
            &marker_for(&policy, ListenerPhaseV1::Binding, None, None),
            &policy,
        )?;

        let listener = UnixListener::bind(&policy.socket_path)
            .map_err(|error| BrokerListenerError::Bind(error.kind()))?;
        fs::set_permissions(
            &policy.socket_path,
            fs::Permissions::from_mode(policy.socket_mode),
        )
        .map_err(|error| BrokerListenerError::Filesystem("socket_permissions", error.kind()))?;
        let backlog =
            Backlog::new(policy.backlog).map_err(|_| BrokerListenerError::InvalidPolicy)?;
        listen(&listener, backlog).map_err(|_| BrokerListenerError::BacklogConfiguration)?;
        listener
            .set_nonblocking(true)
            .map_err(|error| BrokerListenerError::SocketConfiguration(error.kind()))?;
        let socket_identity = inspect_socket(&policy.socket_path, &policy)?;
        write_marker_atomic(
            &marker_path,
            &marker_for(
                &policy,
                ListenerPhaseV1::Bound,
                Some(socket_identity.clone()),
                None,
            ),
            &policy,
        )?;
        Ok(Self {
            listener: Some(listener),
            policy,
            socket_identity,
            marker_path,
            stopped: false,
        })
    }

    /// Marks the listener ready only after all external dependency hashes are bound.
    pub fn mark_ready(&self) -> Result<BrokerListenerQualificationV1, BrokerListenerError> {
        let observed = inspect_socket(&self.policy.socket_path, &self.policy)?;
        if observed != self.socket_identity {
            return Err(BrokerListenerError::SocketIdentityChanged);
        }
        let qualification_hash = hash_qualification(&self.policy, &observed)?;
        write_marker_atomic(
            &self.marker_path,
            &marker_for(
                &self.policy,
                ListenerPhaseV1::Ready,
                Some(observed.clone()),
                Some(qualification_hash.clone()),
            ),
            &self.policy,
        )?;
        Ok(BrokerListenerQualificationV1 {
            generation: self.policy.instance_generation,
            role: self.policy.role,
            access_mode: self.policy.access_mode,
            socket_identity: observed,
            runtime_identity_hash: self.policy.runtime_identity_hash.clone(),
            trust_bundle_hash: self.policy.trust_bundle_hash.clone(),
            journal_path_hash: self.policy.journal_path_hash.clone(),
            peer_policy_hash: self.policy.peer_policy_hash.clone(),
            qualification_hash,
        })
    }

    pub fn accept(&self) -> Result<Option<UnixStream>, BrokerListenerError> {
        let listener = self
            .listener
            .as_ref()
            .ok_or(BrokerListenerError::ListenerStopped)?;
        match listener.accept() {
            Ok((stream, _)) => Ok(Some(stream)),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
            Err(error) => Err(BrokerListenerError::Accept(error.kind())),
        }
    }

    #[must_use]
    pub fn socket_path(&self) -> &Path {
        &self.policy.socket_path
    }

    #[must_use]
    pub fn socket_identity(&self) -> &BrokerSocketIdentityV1 {
        &self.socket_identity
    }

    /// Gracefully closes the fd, removes only the same socket object, and retains a stopped marker.
    pub fn shutdown(mut self) -> Result<(), BrokerListenerError> {
        self.stop_inner()?;
        Ok(())
    }

    fn stop_inner(&mut self) -> Result<(), BrokerListenerError> {
        if self.stopped {
            return Ok(());
        }
        drop(self.listener.take());
        let observed = inspect_socket(&self.policy.socket_path, &self.policy)?;
        if observed != self.socket_identity {
            return Err(BrokerListenerError::SocketIdentityChanged);
        }
        fs::remove_file(&self.policy.socket_path)
            .map_err(|error| BrokerListenerError::Filesystem("socket_remove", error.kind()))?;
        sync_parent(&self.policy.socket_path)?;
        write_marker_atomic(
            &self.marker_path,
            &marker_for(
                &self.policy,
                ListenerPhaseV1::Stopped,
                Some(self.socket_identity.clone()),
                None,
            ),
            &self.policy,
        )?;
        self.stopped = true;
        Ok(())
    }

    #[cfg(test)]
    fn abandon_for_test(mut self) {
        drop(self.listener.take());
        self.stopped = true;
    }
}

impl Drop for BrokerListenerV1 {
    fn drop(&mut self) {
        if !self.stopped {
            let _ = self.stop_inner();
        }
    }
}

fn marker_for(
    policy: &BrokerListenerPolicyV1,
    phase: ListenerPhaseV1,
    socket_identity: Option<BrokerSocketIdentityV1>,
    qualification_hash: Option<Sha256Digest>,
) -> ListenerMarkerV1 {
    ListenerMarkerV1 {
        version: 1,
        generation: policy.instance_generation,
        phase,
        role: policy.role,
        access_mode: policy.access_mode,
        socket_path_hash: hash_path(&policy.socket_path).expect("validated socket path hash"),
        runtime_identity_hash: policy.runtime_identity_hash.clone(),
        trust_bundle_hash: policy.trust_bundle_hash.clone(),
        journal_path_hash: policy.journal_path_hash.clone(),
        peer_policy_hash: policy.peer_policy_hash.clone(),
        socket_identity,
        qualification_hash,
    }
}

fn recover_predecessor(
    policy: &BrokerListenerPolicyV1,
    marker_path: &Path,
) -> Result<(), BrokerListenerError> {
    let marker = load_optional_marker(marker_path, policy)?;
    if let Some(marker) = &marker {
        validate_marker(marker, policy)?;
        if marker.generation >= policy.instance_generation {
            return Err(BrokerListenerError::GenerationRollback {
                previous: marker.generation,
                requested: policy.instance_generation,
            });
        }
    }

    match fs::symlink_metadata(&policy.socket_path) {
        Ok(metadata) => {
            validate_socket_metadata(&metadata, policy)?;
            match UnixStream::connect(&policy.socket_path) {
                Ok(_) => return Err(BrokerListenerError::LiveListenerExists),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::ConnectionRefused
                            | std::io::ErrorKind::NotFound
                            | std::io::ErrorKind::ConnectionReset
                    ) => {}
                Err(error) => return Err(BrokerListenerError::Probe(error.kind())),
            }
            let marker = marker.ok_or(BrokerListenerError::UnrecordedStaleSocket)?;
            if let Some(expected) = marker.socket_identity {
                let observed = socket_identity(&policy.socket_path, &metadata)?;
                if expected != observed {
                    return Err(BrokerListenerError::StaleSocketMarkerMismatch);
                }
            }
            let after = fs::symlink_metadata(&policy.socket_path).map_err(|error| {
                BrokerListenerError::Filesystem("stale_socket_recheck", error.kind())
            })?;
            if !same_socket_object(&metadata, &after) {
                return Err(BrokerListenerError::SocketIdentityChanged);
            }
            fs::remove_file(&policy.socket_path).map_err(|error| {
                BrokerListenerError::Filesystem("stale_socket_remove", error.kind())
            })?;
            sync_parent(&policy.socket_path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(BrokerListenerError::Filesystem(
                "socket_preflight",
                error.kind(),
            ));
        }
    }
    Ok(())
}

fn inspect_parent(policy: &BrokerListenerPolicyV1) -> Result<(), BrokerListenerError> {
    let parent = policy
        .socket_path
        .parent()
        .ok_or(BrokerListenerError::InvalidPolicy)?;
    let canonical = fs::canonicalize(parent)
        .map_err(|error| BrokerListenerError::Filesystem("listener_parent", error.kind()))?;
    if canonical != parent {
        return Err(BrokerListenerError::ParentNonCanonical);
    }
    let metadata = fs::symlink_metadata(parent)
        .map_err(|error| BrokerListenerError::Filesystem("listener_parent", error.kind()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(BrokerListenerError::ParentInvalid);
    }
    if metadata.uid() != policy.parent_owner_uid
        || policy
            .parent_owner_gid
            .is_some_and(|gid| metadata.gid() != gid)
    {
        return Err(BrokerListenerError::ParentOwnerMismatch);
    }
    let mode = metadata.mode() & 0o7777;
    if mode != policy.parent_mode {
        return Err(BrokerListenerError::ParentPermissionsMismatch {
            expected: policy.parent_mode,
            observed: mode,
        });
    }
    Ok(())
}

fn inspect_socket(
    path: &Path,
    policy: &BrokerListenerPolicyV1,
) -> Result<BrokerSocketIdentityV1, BrokerListenerError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| BrokerListenerError::Filesystem("listener_socket", error.kind()))?;
    validate_socket_metadata(&metadata, policy)?;
    socket_identity(path, &metadata)
}

fn validate_socket_metadata(
    metadata: &fs::Metadata,
    policy: &BrokerListenerPolicyV1,
) -> Result<(), BrokerListenerError> {
    if metadata.file_type().is_symlink() || !metadata.file_type().is_socket() {
        return Err(BrokerListenerError::SocketPathInvalid);
    }
    if metadata.uid() != policy.service_uid || metadata.gid() != policy.service_gid {
        return Err(BrokerListenerError::SocketOwnerMismatch);
    }
    let mode = metadata.mode() & 0o7777;
    if mode != policy.socket_mode {
        return Err(BrokerListenerError::SocketPermissionsMismatch {
            expected: policy.socket_mode,
            observed: mode,
        });
    }
    if metadata.nlink() != 1 {
        return Err(BrokerListenerError::SocketLinkCountInvalid(
            metadata.nlink(),
        ));
    }
    Ok(())
}

fn socket_identity(
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<BrokerSocketIdentityV1, BrokerListenerError> {
    Ok(BrokerSocketIdentityV1 {
        path_hash: hash_path(path)?,
        device: metadata.dev(),
        inode: metadata.ino(),
        mode: metadata.mode(),
        uid: metadata.uid(),
        gid: metadata.gid(),
        link_count: metadata.nlink(),
    })
}

fn same_socket_object(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.file_type().is_socket()
        && right.file_type().is_socket()
        && left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.mode() == right.mode()
        && left.uid() == right.uid()
        && left.gid() == right.gid()
        && left.nlink() == right.nlink()
}

fn load_optional_marker(
    path: &Path,
    policy: &BrokerListenerPolicyV1,
) -> Result<Option<ListenerMarkerV1>, BrokerListenerError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(BrokerListenerError::Filesystem(
                "listener_marker",
                error.kind(),
            ));
        }
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != policy.service_uid
        || metadata.gid() != policy.service_gid
        || metadata.mode() & 0o7777 != 0o600
        || metadata.nlink() != 1
        || metadata.size() == 0
        || metadata.size() > MAXIMUM_MARKER_BYTES
    {
        return Err(BrokerListenerError::MarkerInvalid);
    }
    let mut file = File::open(path)
        .map_err(|error| BrokerListenerError::Filesystem("listener_marker", error.kind()))?;
    let opened = file
        .metadata()
        .map_err(|error| BrokerListenerError::Filesystem("listener_marker", error.kind()))?;
    if opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
        return Err(BrokerListenerError::MarkerChanged);
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| BrokerListenerError::Filesystem("listener_marker", error.kind()))?;
    let marker = serde_json::from_slice(&bytes).map_err(|_| BrokerListenerError::MarkerInvalid)?;
    Ok(Some(marker))
}

fn validate_marker(
    marker: &ListenerMarkerV1,
    policy: &BrokerListenerPolicyV1,
) -> Result<(), BrokerListenerError> {
    if marker.version != 1
        || marker.role != policy.role
        || marker.access_mode != policy.access_mode
        || marker.socket_path_hash != hash_path(&policy.socket_path)?
        || marker.runtime_identity_hash != policy.runtime_identity_hash
        || marker.trust_bundle_hash != policy.trust_bundle_hash
        || marker.journal_path_hash != policy.journal_path_hash
        || marker.peer_policy_hash != policy.peer_policy_hash
    {
        return Err(BrokerListenerError::MarkerBindingMismatch);
    }
    Ok(())
}

fn write_marker_atomic(
    path: &Path,
    marker: &ListenerMarkerV1,
    policy: &BrokerListenerPolicyV1,
) -> Result<(), BrokerListenerError> {
    let bytes = serde_json::to_vec(marker).map_err(|_| BrokerListenerError::MarkerInvalid)?;
    if bytes.is_empty()
        || u64::try_from(bytes.len()).map_or(true, |size| size > MAXIMUM_MARKER_BYTES)
    {
        return Err(BrokerListenerError::MarkerInvalid);
    }
    let mut temporary = OsString::from(path.as_os_str());
    temporary.push(format!(".tmp.{}", policy.instance_generation));
    let temporary = PathBuf::from(temporary);
    match fs::remove_file(&temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(BrokerListenerError::Filesystem(
                "listener_marker_temp_remove",
                error.kind(),
            ));
        }
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|error| BrokerListenerError::Filesystem("listener_marker_temp", error.kind()))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| BrokerListenerError::Filesystem("listener_marker_temp", error.kind()))?;
    let metadata = file
        .metadata()
        .map_err(|error| BrokerListenerError::Filesystem("listener_marker_temp", error.kind()))?;
    if metadata.uid() != policy.service_uid
        || metadata.gid() != policy.service_gid
        || metadata.mode() & 0o7777 != 0o600
        || metadata.nlink() != 1
    {
        return Err(BrokerListenerError::MarkerInvalid);
    }
    fs::rename(&temporary, path).map_err(|error| {
        BrokerListenerError::Filesystem("listener_marker_publish", error.kind())
    })?;
    sync_parent(path)
}

fn sync_parent(path: &Path) -> Result<(), BrokerListenerError> {
    let parent = path.parent().ok_or(BrokerListenerError::InvalidPolicy)?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| BrokerListenerError::Filesystem("listener_parent_sync", error.kind()))
}

fn hash_qualification(
    policy: &BrokerListenerPolicyV1,
    socket: &BrokerSocketIdentityV1,
) -> Result<Sha256Digest, BrokerListenerError> {
    let mut hasher = Sha256::new();
    update_length_prefixed(&mut hasher, b"HeptaBrokerListenerQualificationV1");
    update_length_prefixed(&mut hasher, &policy.instance_generation.to_be_bytes());
    update_length_prefixed(&mut hasher, role_name(policy.role).as_bytes());
    update_length_prefixed(
        &mut hasher,
        match policy.access_mode {
            BrokerListenerAccessModeV1::ServiceOnly => b"service_only",
            BrokerListenerAccessModeV1::SharedRoleGroup => b"shared_role_group",
        },
    );
    update_length_prefixed(&mut hasher, socket.path_hash.as_str().as_bytes());
    update_length_prefixed(&mut hasher, &socket.device.to_be_bytes());
    update_length_prefixed(&mut hasher, &socket.inode.to_be_bytes());
    update_length_prefixed(&mut hasher, &socket.mode.to_be_bytes());
    update_length_prefixed(&mut hasher, &socket.uid.to_be_bytes());
    update_length_prefixed(&mut hasher, &socket.gid.to_be_bytes());
    update_length_prefixed(
        &mut hasher,
        policy.runtime_identity_hash.as_str().as_bytes(),
    );
    update_length_prefixed(&mut hasher, policy.trust_bundle_hash.as_str().as_bytes());
    update_length_prefixed(&mut hasher, policy.journal_path_hash.as_str().as_bytes());
    update_length_prefixed(&mut hasher, policy.peer_policy_hash.as_str().as_bytes());
    digest(hasher)
}

fn hash_path(path: &Path) -> Result<Sha256Digest, BrokerListenerError> {
    let mut hasher = Sha256::new();
    update_length_prefixed(&mut hasher, b"CanonicalUnixSocketPathV1");
    update_length_prefixed(&mut hasher, path.as_os_str().as_bytes());
    digest(hasher)
}

fn update_length_prefixed(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(bytes);
}

fn digest(hasher: Sha256) -> Result<Sha256Digest, BrokerListenerError> {
    let value = format!("sha256:{}", hex::encode(hasher.finalize()));
    Sha256Digest::from_str(&value).map_err(|_| BrokerListenerError::DigestConstruction)
}

fn role_name(role: AgentRole) -> &'static str {
    match role {
        AgentRole::Author => "author",
        AgentRole::Reviewer => "reviewer",
        AgentRole::FormalReviewer => "formal_reviewer",
        AgentRole::Repairer => "repairer",
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum BrokerListenerError {
    #[error("broker listener policy is invalid")]
    InvalidPolicy,
    #[error("listener access mode does not match parent/socket owner and mode policy")]
    AccessModeMismatch,
    #[error("listener parent directory is noncanonical")]
    ParentNonCanonical,
    #[error("listener parent directory is invalid")]
    ParentInvalid,
    #[error("listener parent owner does not match policy")]
    ParentOwnerMismatch,
    #[error("listener parent permissions differ: expected {expected:o}, observed {observed:o}")]
    ParentPermissionsMismatch { expected: u32, observed: u32 },
    #[error("listener socket pathname is occupied by a non-socket object")]
    SocketPathInvalid,
    #[error("listener socket owner does not match service principal")]
    SocketOwnerMismatch,
    #[error("listener socket permissions differ: expected {expected:o}, observed {observed:o}")]
    SocketPermissionsMismatch { expected: u32, observed: u32 },
    #[error("listener socket link count is invalid: {0}")]
    SocketLinkCountInvalid(u64),
    #[error("a live listener already owns the role socket")]
    LiveListenerExists,
    #[error("stale listener socket has no qualified generation marker")]
    UnrecordedStaleSocket,
    #[error("stale listener socket differs from its generation marker")]
    StaleSocketMarkerMismatch,
    #[error("listener generation rollback: previous {previous}, requested {requested}")]
    GenerationRollback { previous: u64, requested: u64 },
    #[error("listener generation marker is invalid")]
    MarkerInvalid,
    #[error("listener generation marker changed while being read")]
    MarkerChanged,
    #[error("listener marker dependencies differ from this service instance")]
    MarkerBindingMismatch,
    #[error("listener socket identity changed")]
    SocketIdentityChanged,
    #[error("listener is stopped")]
    ListenerStopped,
    #[error("listener bind failed: {0:?}")]
    Bind(std::io::ErrorKind),
    #[error("listener accept failed: {0:?}")]
    Accept(std::io::ErrorKind),
    #[error("listener stale-socket probe failed: {0:?}")]
    Probe(std::io::ErrorKind),
    #[error("listener socket configuration failed: {0:?}")]
    SocketConfiguration(std::io::ErrorKind),
    #[error("listener backlog configuration failed")]
    BacklogConfiguration,
    #[error("filesystem operation failed for {0}: {1:?}")]
    Filesystem(&'static str, std::io::ErrorKind),
    #[error("failed to construct listener digest")]
    DigestConstruction,
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::{MetadataExt, PermissionsExt, symlink},
        path::PathBuf,
        str::FromStr,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use hepta_codex_protocol::Sha256Digest;

    use super::*;

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TempTree(PathBuf);

    impl TempTree {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos();
            let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "hepta-listener-{}-{nonce}-{sequence}",
                std::process::id(),
            ));
            fs::create_dir(&path).expect("create temp parent");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("private parent");
            Self(path)
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn digest(byte: char) -> Sha256Digest {
        Sha256Digest::from_str(&format!("sha256:{}", byte.to_string().repeat(64)))
            .expect("test digest")
    }

    fn policy(tree: &TempTree, generation: u64) -> BrokerListenerPolicyV1 {
        let metadata = fs::metadata(&tree.0).expect("parent metadata");
        BrokerListenerPolicyV1 {
            version: 1,
            socket_path: tree.0.join("author.sock"),
            parent_owner_uid: metadata.uid(),
            parent_owner_gid: Some(metadata.gid()),
            parent_mode: 0o700,
            service_uid: metadata.uid(),
            service_gid: metadata.gid(),
            socket_mode: 0o600,
            access_mode: BrokerListenerAccessModeV1::ServiceOnly,
            instance_generation: generation,
            backlog: 8,
            role: AgentRole::Author,
            runtime_identity_hash: digest('1'),
            trust_bundle_hash: digest('2'),
            journal_path_hash: digest('3'),
            peer_policy_hash: digest('4'),
        }
    }

    #[test]
    fn binds_marks_ready_and_retains_stopped_generation() {
        let tree = TempTree::new();
        let policy = policy(&tree, 1);
        let marker = policy.marker_path();
        let listener = BrokerListenerV1::bind(policy.clone()).expect("bind listener");
        let qualification = listener.mark_ready().expect("mark ready");
        assert_eq!(qualification.generation, 1);
        assert!(policy.socket_path.exists());
        listener.shutdown().expect("clean shutdown");
        assert!(!policy.socket_path.exists());
        assert!(marker.exists());
    }

    #[test]
    fn access_modes_are_exact_and_fail_closed() {
        let tree = TempTree::new();
        let mut shared = policy(&tree, 1);
        shared.access_mode = BrokerListenerAccessModeV1::SharedRoleGroup;
        shared.parent_owner_gid = Some(shared.service_gid);
        shared.parent_mode = 0o710;
        shared.socket_mode = 0o660;
        fs::set_permissions(&tree.0, fs::Permissions::from_mode(0o710))
            .expect("shared parent mode");
        assert!(shared.validate().is_ok());

        shared.socket_mode = 0o600;
        assert_eq!(
            shared.validate(),
            Err(BrokerListenerError::AccessModeMismatch)
        );

        let mut service_only = policy(&tree, 2);
        service_only.socket_mode = 0o660;
        assert_eq!(
            service_only.validate(),
            Err(BrokerListenerError::AccessModeMismatch)
        );
    }

    #[test]
    fn refuses_live_predecessor_and_generation_rollback() {
        let tree = TempTree::new();
        let first_policy = policy(&tree, 1);
        let first = BrokerListenerV1::bind(first_policy.clone()).expect("first listener");
        first.mark_ready().expect("ready");
        assert_eq!(
            BrokerListenerV1::bind(policy(&tree, 2)).err(),
            Some(BrokerListenerError::LiveListenerExists),
        );
        first.shutdown().expect("shutdown");
        assert!(matches!(
            BrokerListenerV1::bind(policy(&tree, 1)),
            Err(BrokerListenerError::GenerationRollback { .. }),
        ));
    }

    #[test]
    fn recovers_recorded_stale_socket_with_new_generation() {
        let tree = TempTree::new();
        let first_policy = policy(&tree, 1);
        let first = BrokerListenerV1::bind(first_policy.clone()).expect("first listener");
        first.mark_ready().expect("ready");
        first.abandon_for_test();
        assert!(first_policy.socket_path.exists());
        let mut close_propagation_attempts = 0_u16;
        let second = loop {
            match BrokerListenerV1::bind(policy(&tree, 2)) {
                Ok(listener) => break listener,
                Err(BrokerListenerError::LiveListenerExists)
                    if close_propagation_attempts < 100 =>
                {
                    close_propagation_attempts += 1;
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Err(error) => panic!("recover stale socket: {error}"),
            }
        };
        second.shutdown().expect("shutdown second");
    }

    #[test]
    fn rejects_symlink_or_unrecorded_stale_socket() {
        let tree = TempTree::new();
        let policy = policy(&tree, 1);
        let target = tree.0.join("target");
        fs::write(&target, b"not a socket").expect("target");
        symlink(&target, &policy.socket_path).expect("socket symlink");
        assert_eq!(
            BrokerListenerV1::bind(policy.clone()).err(),
            Some(BrokerListenerError::SocketPathInvalid),
        );
        fs::remove_file(&policy.socket_path).expect("remove symlink");
        let stale = UnixListener::bind(&policy.socket_path).expect("unrecorded socket");
        drop(stale);
        fs::set_permissions(&policy.socket_path, fs::Permissions::from_mode(0o600))
            .expect("socket mode");
        assert_eq!(
            BrokerListenerV1::bind(policy).err(),
            Some(BrokerListenerError::UnrecordedStaleSocket),
        );
    }
}
