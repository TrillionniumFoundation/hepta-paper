//! Byte-verifying prepared-result boundary over a private content-addressed store.

use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use hepta_codex_protocol::Sha256Digest;
use hepta_module_platform::{ActionCandidateV1, PreparedResultV1};
use sha2::{Digest, Sha256};

use crate::{
    ControlPlaneError, DeterministicPreparedResultVerifierV1, PlanCertificateV1,
    PreparedResultVerifierV1, VerifiedPreparedResultV1,
};

/// Artifact and evidence verifier which reads actual immutable object bytes.
///
/// This proves content integrity and contract validity, not scientific truth or
/// provider/release authority. Scientific verifiers must issue their own bound
/// evidence before a capability can become production-qualified.
#[derive(Clone, Debug)]
pub struct FilesystemPreparedResultVerifierV1 {
    root: PathBuf,
    device: u64,
    inode: u64,
    owner: u32,
    maximum_object_bytes: u64,
    contract: DeterministicPreparedResultVerifierV1,
}

impl FilesystemPreparedResultVerifierV1 {
    /// Opens a canonical private directory; no content is trusted from names alone.
    pub fn new(
        root: &Path,
        verifier_hash: Sha256Digest,
        maximum_object_bytes: u64,
    ) -> Result<Self, ControlPlaneError> {
        let metadata =
            fs::symlink_metadata(root).map_err(|_| ControlPlaneError::VerificationInvalid)?;
        if !root.is_absolute()
            || fs::canonicalize(root).ok().as_deref() != Some(root)
            || !metadata.is_dir()
            || metadata.mode() & 0o077 != 0
            || maximum_object_bytes == 0
            || maximum_object_bytes > 64 * 1024 * 1024
        {
            return Err(ControlPlaneError::VerificationInvalid);
        }
        Ok(Self {
            root: root.to_owned(),
            device: metadata.dev(),
            inode: metadata.ino(),
            owner: metadata.uid(),
            maximum_object_bytes,
            contract: DeterministicPreparedResultVerifierV1::new(verifier_hash),
        })
    }

    /// Reads one hash-named regular object with bounded size and change detection.
    pub fn read_object(&self, hash: &Sha256Digest) -> Result<Vec<u8>, ControlPlaneError> {
        self.check_root()?;
        let name = hash.to_string();
        let raw = name
            .strip_prefix("sha256:")
            .ok_or(ControlPlaneError::VerificationInvalid)?;
        let path = self.root.join(raw);
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(nix::fcntl::OFlag::O_NOFOLLOW.bits())
            .open(path)
            .map_err(|_| ControlPlaneError::VerificationInvalid)?;
        let before = file
            .metadata()
            .map_err(|_| ControlPlaneError::VerificationInvalid)?;
        if !before.is_file()
            || before.nlink() != 1
            || before.uid() != self.owner
            || before.mode() & 0o077 != 0
            || before.len() > self.maximum_object_bytes
        {
            return Err(ControlPlaneError::VerificationInvalid);
        }
        let mut bytes = Vec::new();
        std::io::Read::by_ref(&mut file)
            .take(self.maximum_object_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ControlPlaneError::VerificationInvalid)?;
        let after = file
            .metadata()
            .map_err(|_| ControlPlaneError::VerificationInvalid)?;
        self.check_root()?;
        if bytes.len() as u64 != before.len()
            || bytes.len() as u64 > self.maximum_object_bytes
            || before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.ctime() != after.ctime()
            || before.ctime_nsec() != after.ctime_nsec()
            || format!("sha256:{}", hex::encode(Sha256::digest(&bytes))) != name
        {
            return Err(ControlPlaneError::VerificationInvalid);
        }
        Ok(bytes)
    }

    fn check_root(&self) -> Result<(), ControlPlaneError> {
        let current =
            fs::symlink_metadata(&self.root).map_err(|_| ControlPlaneError::VerificationInvalid)?;
        if !current.is_dir()
            || current.dev() != self.device
            || current.ino() != self.inode
            || current.uid() != self.owner
            || current.mode() & 0o077 != 0
        {
            return Err(ControlPlaneError::VerificationInvalid);
        }
        Ok(())
    }
}

impl crate::execution::sealed::Sealed for FilesystemPreparedResultVerifierV1 {}

impl PreparedResultVerifierV1 for FilesystemPreparedResultVerifierV1 {
    fn verify(
        &self,
        result: PreparedResultV1,
        candidate: &ActionCandidateV1,
        plan: &PlanCertificateV1,
    ) -> Result<VerifiedPreparedResultV1, ControlPlaneError> {
        if result.artifact_hashes.len() > 256 {
            return Err(ControlPlaneError::VerificationInvalid);
        }
        for hash in &result.artifact_hashes {
            self.read_object(hash)?;
        }
        self.read_object(&result.evidence_hash)?;
        let mut verified = self.contract.verify(result, candidate, plan)?;
        verified.artifact_contents_verified = true;
        Ok(verified)
    }

    fn verifier_hash(&self) -> &Sha256Digest {
        self.contract.verifier_hash()
    }
}
