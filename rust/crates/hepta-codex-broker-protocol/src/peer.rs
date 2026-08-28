use std::{
    collections::BTreeSet,
    os::unix::net::UnixStream,
    str::FromStr,
};

use hepta_codex_protocol::Sha256Digest;
use rustix::net::sockopt::socket_peercred;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAXIMUM_ALLOWED_IDENTITIES: usize = 64;

/// Kernel-observed Linux Unix-socket peer identity.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerCredentialsV1 {
    pub process_id: i32,
    pub user_id: u32,
    pub group_id: u32,
}

/// Exact UID/GID admission policy for one broker socket.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerPolicyV1 {
    pub version: u16,
    pub policy_id: String,
    pub allowed_user_ids: BTreeSet<u32>,
    pub allowed_group_ids: BTreeSet<u32>,
    pub deny_root: bool,
}

impl PeerPolicyV1 {
    /// Constructs and validates a policy before it can authorize a connection.
    pub fn new<U, G>(
        policy_id: impl Into<String>,
        allowed_user_ids: U,
        allowed_group_ids: G,
        deny_root: bool,
    ) -> Result<Self, PeerAuthorizationError>
    where
        U: IntoIterator<Item = u32>,
        G: IntoIterator<Item = u32>,
    {
        let policy = Self {
            version: 1,
            policy_id: policy_id.into(),
            allowed_user_ids: allowed_user_ids.into_iter().collect(),
            allowed_group_ids: allowed_group_ids.into_iter().collect(),
            deny_root,
        };
        policy.validate()?;
        Ok(policy)
    }

    /// Validates policy shape and prevents accidentally unconstrained peers.
    pub fn validate(&self) -> Result<(), PeerAuthorizationError> {
        if self.version != 1 {
            return Err(PeerAuthorizationError::UnsupportedPolicyVersion(
                self.version,
            ));
        }
        if !valid_identifier(&self.policy_id) {
            return Err(PeerAuthorizationError::InvalidPolicyId);
        }
        if self.allowed_user_ids.is_empty()
            || self.allowed_group_ids.is_empty()
            || self.allowed_user_ids.len() > MAXIMUM_ALLOWED_IDENTITIES
            || self.allowed_group_ids.len() > MAXIMUM_ALLOWED_IDENTITIES
        {
            return Err(PeerAuthorizationError::InvalidIdentitySet);
        }
        if self.deny_root
            && (self.allowed_user_ids.contains(&0) || self.allowed_group_ids.contains(&0))
        {
            return Err(PeerAuthorizationError::RootPresentInDeniedPolicy);
        }
        Ok(())
    }

    /// Hashes the exact policy values bound into admission evidence.
    pub fn policy_hash(&self) -> Result<Sha256Digest, PeerAuthorizationError> {
        self.validate()?;
        let mut hasher = Sha256::new();
        update_field(&mut hasher, b"HeptaPeerPolicyV1");
        update_field(&mut hasher, &self.version.to_be_bytes());
        update_field(&mut hasher, self.policy_id.as_bytes());
        for user_id in &self.allowed_user_ids {
            update_field(&mut hasher, &user_id.to_be_bytes());
        }
        for group_id in &self.allowed_group_ids {
            update_field(&mut hasher, &group_id.to_be_bytes());
        }
        update_field(&mut hasher, &[u8::from(self.deny_root)]);
        digest_from_hasher(hasher)
    }
}

/// Successful peer admission evidence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerAuthorizationV1 {
    pub credentials: PeerCredentialsV1,
    pub policy_id: String,
    pub policy_hash: Sha256Digest,
}

/// Reads Linux `SO_PEERCRED`; request payloads cannot override this identity.
pub fn observe_peer_credentials(
    stream: &UnixStream,
) -> Result<PeerCredentialsV1, PeerAuthorizationError> {
    let credentials = socket_peercred(stream)
        .map_err(|error| PeerAuthorizationError::PeerCredentialRead(error.kind()))?;
    let process_id = credentials.pid.as_raw_pid();
    if process_id <= 0 {
        return Err(PeerAuthorizationError::InvalidPeerProcessId(process_id));
    }
    Ok(PeerCredentialsV1 {
        process_id,
        user_id: credentials.uid.as_raw(),
        group_id: credentials.gid.as_raw(),
    })
}

/// Authorizes the kernel-observed peer under an exact UID/GID policy.
pub fn authorize_peer(
    stream: &UnixStream,
    policy: &PeerPolicyV1,
) -> Result<PeerAuthorizationV1, PeerAuthorizationError> {
    policy.validate()?;
    let credentials = observe_peer_credentials(stream)?;
    if policy.deny_root && (credentials.user_id == 0 || credentials.group_id == 0) {
        return Err(PeerAuthorizationError::RootPeerDenied);
    }
    if !policy.allowed_user_ids.contains(&credentials.user_id) {
        return Err(PeerAuthorizationError::UserIdDenied(
            credentials.user_id,
        ));
    }
    if !policy.allowed_group_ids.contains(&credentials.group_id) {
        return Err(PeerAuthorizationError::GroupIdDenied(
            credentials.group_id,
        ));
    }
    Ok(PeerAuthorizationV1 {
        credentials,
        policy_id: policy.policy_id.clone(),
        policy_hash: policy.policy_hash()?,
    })
}

fn valid_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && bytes.all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
        })
}

fn update_field(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(bytes);
}

fn digest_from_hasher(hasher: Sha256) -> Result<Sha256Digest, PeerAuthorizationError> {
    let digest = format!("sha256:{}", hex::encode(hasher.finalize()));
    Sha256Digest::from_str(&digest).map_err(|_| PeerAuthorizationError::DigestConstruction)
}

/// Peer policy or kernel credential failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum PeerAuthorizationError {
    #[error("unsupported peer policy version: {0}")]
    UnsupportedPolicyVersion(u16),
    #[error("peer policy id is invalid")]
    InvalidPolicyId,
    #[error("peer policy must contain bounded nonempty UID and GID sets")]
    InvalidIdentitySet,
    #[error("root identity is present while the policy denies root")]
    RootPresentInDeniedPolicy,
    #[error("failed to read Linux SO_PEERCRED: {0:?}")]
    PeerCredentialRead(std::io::ErrorKind),
    #[error("kernel returned an invalid peer process id: {0}")]
    InvalidPeerProcessId(i32),
    #[error("root peer is denied")]
    RootPeerDenied,
    #[error("peer user id is denied: {0}")]
    UserIdDenied(u32),
    #[error("peer group id is denied: {0}")]
    GroupIdDenied(u32),
    #[error("failed to construct canonical peer-policy digest")]
    DigestConstruction,
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixStream;

    use super::*;

    #[test]
    fn socket_peer_identity_is_kernel_observed_and_authorized() {
        let (left, _right) = UnixStream::pair().expect("socket pair");
        let observed = observe_peer_credentials(&left).expect("peer credentials");
        let policy = PeerPolicyV1::new(
            "test-peer-v1",
            [observed.user_id],
            [observed.group_id],
            false,
        )
        .expect("peer policy");
        let authorization = authorize_peer(&left, &policy).expect("authorized peer");
        assert_eq!(authorization.credentials, observed);
        assert_eq!(authorization.policy_id, "test-peer-v1");
    }

    #[test]
    fn mismatched_uid_and_gid_fail_closed() {
        let (left, _right) = UnixStream::pair().expect("socket pair");
        let observed = observe_peer_credentials(&left).expect("peer credentials");
        let denied_user = observed.user_id.wrapping_add(1);
        let denied_group = observed.group_id.wrapping_add(1);
        let user_policy = PeerPolicyV1::new(
            "wrong-user-v1",
            [denied_user],
            [observed.group_id],
            false,
        )
        .expect("peer policy");
        assert_eq!(
            authorize_peer(&left, &user_policy),
            Err(PeerAuthorizationError::UserIdDenied(observed.user_id)),
        );
        let group_policy = PeerPolicyV1::new(
            "wrong-group-v1",
            [observed.user_id],
            [denied_group],
            false,
        )
        .expect("peer policy");
        assert_eq!(
            authorize_peer(&left, &group_policy),
            Err(PeerAuthorizationError::GroupIdDenied(
                observed.group_id,
            )),
        );
    }
}
