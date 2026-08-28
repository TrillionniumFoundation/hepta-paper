use std::{
    fs::File,
    io::Read,
    os::unix::ffi::OsStrExt,
    path::Path,
    str::FromStr,
};

use hepta_codex_protocol::Sha256Digest;
use sha2::{Digest, Sha256};

use super::types::{DirectoryIdentityV1, FileSystemIdentityV1, RuntimeIdentityError};

pub(super) fn hash_reader(
    reader: &mut File,
    maximum_bytes: u64,
) -> Result<Sha256Digest, RuntimeIdentityError> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| RuntimeIdentityError::Filesystem("content_read", error.kind()))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(read).map_err(|_| RuntimeIdentityError::SizeOverflow)?)
            .ok_or(RuntimeIdentityError::SizeOverflow)?;
        if total > maximum_bytes {
            return Err(RuntimeIdentityError::FileTooLarge {
                observed: total,
                maximum: maximum_bytes,
            });
        }
        hasher.update(&buffer[..read]);
    }
    digest_from_hasher(hasher)
}

pub(super) fn hash_path(path: &Path) -> Result<Sha256Digest, RuntimeIdentityError> {
    let mut hasher = DomainHasher::new("CanonicalUnixPathV1");
    hasher.field("path", path.as_os_str().as_bytes());
    hasher.finish()
}

pub(super) fn hash_directory_identity(
    identity: &DirectoryIdentityV1,
) -> Result<Sha256Digest, RuntimeIdentityError> {
    let mut hasher = DomainHasher::new("DirectoryIdentityV1");
    hasher.digest("canonicalPathHash", &identity.canonical_path_hash);
    hasher.field("device", identity.device.to_string().as_bytes());
    hasher.field("inode", identity.inode.to_string().as_bytes());
    hasher.field("mode", identity.mode.to_string().as_bytes());
    hasher.field("uid", identity.uid.to_string().as_bytes());
    hasher.field("gid", identity.gid.to_string().as_bytes());
    hasher.finish()
}

pub(super) fn hash_file_system_identity(
    identity: &FileSystemIdentityV1,
) -> Result<Sha256Digest, RuntimeIdentityError> {
    let mut hasher = DomainHasher::new("FileSystemIdentityV1");
    hasher.digest("canonicalPathHash", &identity.canonical_path_hash);
    hasher.field("device", identity.device.to_string().as_bytes());
    hasher.field("inode", identity.inode.to_string().as_bytes());
    hasher.field("mode", identity.mode.to_string().as_bytes());
    hasher.field("uid", identity.uid.to_string().as_bytes());
    hasher.field("gid", identity.gid.to_string().as_bytes());
    hasher.field("linkCount", identity.link_count.to_string().as_bytes());
    hasher.field("size", identity.size.to_string().as_bytes());
    hasher.field(
        "modifiedSeconds",
        identity.modified_seconds.to_string().as_bytes(),
    );
    hasher.field(
        "modifiedNanoseconds",
        identity.modified_nanoseconds.to_string().as_bytes(),
    );
    hasher.field(
        "changedSeconds",
        identity.changed_seconds.to_string().as_bytes(),
    );
    hasher.field(
        "changedNanoseconds",
        identity.changed_nanoseconds.to_string().as_bytes(),
    );
    hasher.finish()
}

pub(super) struct DomainHasher(Sha256);

impl DomainHasher {
    pub(super) fn new(domain: &str) -> Self {
        let mut hasher = Sha256::new();
        update_length_prefixed(&mut hasher, domain.as_bytes());
        Self(hasher)
    }

    pub(super) fn field(&mut self, key: &str, value: &[u8]) {
        update_length_prefixed(&mut self.0, key.as_bytes());
        update_length_prefixed(&mut self.0, value);
    }

    pub(super) fn digest(&mut self, key: &str, value: &Sha256Digest) {
        self.field(key, value.as_str().as_bytes());
    }

    pub(super) fn finish(self) -> Result<Sha256Digest, RuntimeIdentityError> {
        digest_from_hasher(self.0)
    }
}

fn update_length_prefixed(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update(u64::try_from(bytes.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(bytes);
}

fn digest_from_hasher(hasher: Sha256) -> Result<Sha256Digest, RuntimeIdentityError> {
    let value = format!("sha256:{}", hex::encode(hasher.finalize()));
    Sha256Digest::from_str(&value).map_err(|_| RuntimeIdentityError::DigestConstruction)
}
