//! Narrow retained-file prerequisite shared by both process transports.
//!
//! An ELF file can itself be an interpreter. Matching a reviewed adapter and
//! the authority child topology remains the owning native composition's job.
//! No opaque deployment, adapter qualification or ready flag is created here.
use super::*;
use hepta_codex_protocol::Sha256Digest;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{FileExt, MetadataExt},
};

impl Snapshot {
    // Deliberately uses the existing Snapshot descriptor. In particular, never
    // open/clone a replacement pathname, including when it aliases live SQLite.
    fn assert_held_elf_identity(
        &self,
        expected_path: &Path,
        expected_hash: &Sha256Digest,
        code: &str,
    ) -> Result<()> {
        self.assert_current()?;
        if self.path.as_os_str() != expected_path.as_os_str() || !self.executable() {
            return Err(error(code));
        }
        let length = self.bytes().len();
        if length < 4 {
            return Err(error(code));
        }
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut offset = 0usize;
        while offset < length {
            let end = buffer.len().min(length - offset);
            self.file
                .read_exact_at(&mut buffer[..end], offset as u64)
                .map_err(|_| error(code))?;
            if offset == 0 && &buffer[..4] != b"\x7fELF" {
                return Err(error(code));
            }
            digest.update(&buffer[..end]);
            offset += end;
        }
        if format!("sha256:{}", hex::encode(digest.finalize())) != expected_hash.as_str() {
            return Err(error(code));
        }
        self.assert_current()
    }

    /// Root-owned installed ELF with exactly the expected pinned command bytes.
    /// This performs no RPC and yields no authority or reviewed-adapter proof.
    pub(crate) fn assert_native_elf_command_v1(
        &self,
        expected_path: &Path,
        expected_hash: &Sha256Digest,
        code: &str,
    ) -> Result<()> {
        self.assert_held_elf_identity(expected_path, expected_hash, code)?;
        let metadata = self.file.metadata().map_err(|_| error(code))?;
        if metadata.uid() != 0
            || metadata.gid() != 0
            || !matches!(metadata.mode() & 0o7777, 0o555 | 0o755)
            || metadata.nlink() != 1
            || !metadata.is_file()
        {
            return Err(error(code));
        }
        // Snapshot::assert_current pins these same ancestors' identities. Safe
        // root ownership and modes are checked again without opening any FD.
        for path in self.path.ancestors().skip(1) {
            let metadata = fs::symlink_metadata(path).map_err(|_| error(code))?;
            if !metadata.is_dir()
                || metadata.is_symlink()
                || metadata.uid() != 0
                || metadata.gid() != 0
                || metadata.mode() & 0o022 != 0
            {
                return Err(error(code));
            }
        }
        self.assert_current()
    }
}

#[cfg(test)]
mod tests;
