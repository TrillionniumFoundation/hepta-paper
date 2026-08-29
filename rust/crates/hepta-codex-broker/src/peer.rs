use std::{collections::BTreeSet, os::unix::net::UnixStream, str::FromStr};

use nix::sys::socket::{GetSockOpt, sockopt::PeerCredentials};
use hepta_codex_protocol::Sha256Digest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MAXIMUM_ALLOWED_PRINCIPALS: usize = 64;

/// Kernel-observed identity of the process connected to the broker socket.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerIdentityV1 {
    pub pid: i32,
    pub uid: u32,
    pub gid: u32,
}

/// An exact UID/GID pair authorized to submit broker requests.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerPrincipalV1 {
    pub uid: u32,
    pub gid: u32,
}

/// Versioned exact-principal allowlist.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerPolicyV1 {
    pub version: u16,
    pub allowed_principals: BTreeSet<PeerPrincipalV1>,
}

impl PeerPolicyV1 {
    /// Constructs a nonempty exact-principal policy.
    pub fn new<I>(principals: I) -> Result<Self, PeerAuthorizationError>
    where
        I: IntoIterator<Item = PeerPrincipalV1>,
    {
        let policy = Self {
            version: 1,
            allowed_principals: principals.into_iter().collect(),
        };
        policy.validate()?;
        Ok(policy)
    }

    /// Canonical domain-separated hash bound into listener readiness evidence.
    pub fn policy_hash(&self) -> Result<Sha256Digest, PeerAuthorizationError> {
        self.validate()?;
        let mut hasher = Sha256::new();
        hash_field(&mut hasher, b"HeptaBrokerPeerPolicyV1");
        hash_field(&mut hasher, &self.version.to_be_bytes());
        for principal in &self.allowed_principals {
            hash_field(&mut hasher, &principal.uid.to_be_bytes());
            hash_field(&mut hasher, &principal.gid.to_be_bytes());
        }
        Sha256Digest::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
            .map_err(|_| PeerAuthorizationError::DigestConstruction)
    }

    /// Authorizes a kernel-observed peer.
    pub fn authorize(&self, peer: PeerIdentityV1) -> Result<(), PeerAuthorizationError> {
        self.validate()?;
        if peer.pid <= 0 {
            return Err(PeerAuthorizationError::InvalidPeerPid(peer.pid));
        }
        let principal = PeerPrincipalV1 {
            uid: peer.uid,
            gid: peer.gid,
        };
        if !self.allowed_principals.contains(&principal) {
            return Err(PeerAuthorizationError::PrincipalDenied(principal));
        }
        Ok(())
    }

    fn validate(&self) -> Result<(), PeerAuthorizationError> {
        if self.version != 1 {
            return Err(PeerAuthorizationError::UnsupportedPolicyVersion(
                self.version,
            ));
        }
        if self.allowed_principals.is_empty()
            || self.allowed_principals.len() > MAXIMUM_ALLOWED_PRINCIPALS
        {
            return Err(PeerAuthorizationError::InvalidPrincipalCount);
        }
        Ok(())
    }
}

fn hash_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

/// Reads Linux `SO_PEERCRED` from a connected Unix stream.
pub fn inspect_peer_identity(
    stream: &UnixStream,
) -> Result<PeerIdentityV1, PeerAuthorizationError> {
    let credentials = PeerCredentials
        .get(stream)
        .map_err(|_| PeerAuthorizationError::PeerCredentialsUnavailable)?;
    let peer = PeerIdentityV1 {
        pid: credentials.pid(),
        uid: credentials.uid(),
        gid: credentials.gid(),
    };
    if peer.pid <= 0 {
        return Err(PeerAuthorizationError::InvalidPeerPid(peer.pid));
    }
    Ok(peer)
}

/// Socket credential or policy failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum PeerAuthorizationError {
    #[error("unsupported peer policy version: {0}")]
    UnsupportedPolicyVersion(u16),
    #[error("peer policy principal count is invalid")]
    InvalidPrincipalCount,
    #[error("peer credentials are unavailable")]
    PeerCredentialsUnavailable,
    #[error("peer pid is invalid: {0}")]
    InvalidPeerPid(i32),
    #[error("peer principal is denied: uid={0:?}")]
    PrincipalDenied(PeerPrincipalV1),
    #[error("failed to construct peer-policy digest")]
    DigestConstruction,
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixStream;

    use super::*;

    #[test]
    fn authorizes_the_kernel_observed_local_peer() {
        let (_client, server) = UnixStream::pair().expect("Unix stream pair");
        let peer = inspect_peer_identity(&server).expect("peer credentials");
        let policy = PeerPolicyV1::new([PeerPrincipalV1 {
            uid: peer.uid,
            gid: peer.gid,
        }])
        .expect("peer policy");
        assert!(policy.authorize(peer).is_ok());
        assert!(policy.policy_hash().is_ok());
    }

    #[test]
    fn rejects_an_unlisted_principal() {
        let (_client, server) = UnixStream::pair().expect("Unix stream pair");
        let peer = inspect_peer_identity(&server).expect("peer credentials");
        let denied_uid = peer.uid.checked_add(1).unwrap_or(0);
        let policy = PeerPolicyV1::new([PeerPrincipalV1 {
            uid: denied_uid,
            gid: peer.gid,
        }])
        .expect("peer policy");
        assert!(matches!(
            policy.authorize(peer),
            Err(PeerAuthorizationError::PrincipalDenied(_)),
        ));
    }
}
