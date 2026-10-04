//! Constructor-order original manifest wire through serde's existing encoder.
use serde::Serialize;
use serde_json::Value;
use std::{io::Write, sync::atomic::AtomicBool, time::Instant};
#[derive(Serialize)]
struct Package<'a> {
    package: &'a Value,
    version: &'a Value,
    file: &'a Value,
    url: &'a Value,
    bytes: &'a Value,
    sha256: &'a Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest<'a> {
    version: &'a Value,
    kind: &'a Value,
    status: &'a Value,
    snapshot: &'a Value,
    lockfile_hash: &'a Value,
    package_count: &'a Value,
    packages: Vec<Package<'a>>,
    exact_lock_closure: &'a Value,
    all_source_archives_content_hashed: &'a Value,
    offline_restore_required: &'a Value,
    r_runtime_source_cas_manifest_hash: &'a Value,
}
struct Output<'a> {
    bytes: Vec<u8>,
    cancelled: &'a AtomicBool,
    deadline: Instant,
}
impl Write for Output<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        super::super::require_acquisition_active(self.cancelled, Some(self.deadline))
            .map_err(std::io::Error::other)?;
        let next = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .filter(|n| (*n as u64) < super::super::MAX_DOCUMENT_BYTES)
            .ok_or_else(|| std::io::Error::other("r_runtime_source_cas_manifest_write_failed"))?;
        self.bytes
            .try_reserve(next - self.bytes.len())
            .map_err(std::io::Error::other)?;
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
pub(in crate::runtime_source_cas) fn encode(
    value: &Value,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Vec<u8>, String> {
    let entries = value["packages"]
        .as_array()
        .ok_or("r_runtime_source_cas_manifest_write_failed")?;
    let ordered = Manifest {
        version: &value["version"],
        kind: &value["kind"],
        status: &value["status"],
        snapshot: &value["snapshot"],
        lockfile_hash: &value["lockfileHash"],
        package_count: &value["packageCount"],
        packages: entries
            .iter()
            .map(|v| Package {
                package: &v["package"],
                version: &v["version"],
                file: &v["file"],
                url: &v["url"],
                bytes: &v["bytes"],
                sha256: &v["sha256"],
            })
            .collect(),
        exact_lock_closure: &value["exactLockClosure"],
        all_source_archives_content_hashed: &value["allSourceArchivesContentHashed"],
        offline_restore_required: &value["offlineRestoreRequired"],
        r_runtime_source_cas_manifest_hash: &value["rRuntimeSourceCasManifestHash"],
    };
    let mut output = Output {
        bytes: Vec::new(),
        cancelled,
        deadline,
    };
    serde_json::to_writer_pretty(&mut output, &ordered)
        .map_err(|_| "r_runtime_source_cas_manifest_write_failed")?;
    super::super::require_acquisition_active(cancelled, Some(deadline))?;
    output.bytes.push(b'\n');
    Ok(output.bytes)
}
