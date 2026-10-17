use super::*;
use crate::state_recoverability::{files::ObservedFile, publication::LocalReportDirectoryV1};
use std::{fs::Metadata, os::unix::fs::MetadataExt, path::Path};
fn identity(metadata: &Metadata) -> Json {
    object(vec![
        ("device", string(&metadata.dev().to_string())),
        ("inode", string(&metadata.ino().to_string())),
        ("mode", string(&metadata.mode().to_string())),
        ("size", Json::Number(metadata.len() as f64)),
        (
            "mtimeNs",
            string(
                &(i128::from(metadata.mtime()) * 1_000_000_000 + i128::from(metadata.mtime_nsec()))
                    .to_string(),
            ),
        ),
        ("linkCount", Json::Number(metadata.nlink() as f64)),
    ])
}
fn file_identity(
    scope: &Path,
    path: &Path,
    metadata: &Metadata,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<String, String> {
    let value = object(vec![
        ("version", Json::Number(1.0)),
        ("kind", string("ScopedFileIdentity")),
        ("status", string("scoped_file_identity_verified")),
        ("scopeRoot", string(scope.to_str().ok_or_else(refused)?)),
        ("path", string(path.to_str().ok_or_else(refused)?)),
        ("rootRealPath", string(scope.to_str().ok_or_else(refused)?)),
        ("realPath", string(path.to_str().ok_or_else(refused)?)),
        ("identity", identity(metadata)),
        ("symlinkComponents", Json::Array(vec![])),
        ("blockers", Json::Array(vec![])),
    ]);
    hash("ScopedFileIdentity", &value, cancelled, deadline)
}
pub(super) fn target_identity(
    scope: &LocalReportDirectoryV1,
    parent: &LocalReportDirectoryV1,
    file: &ObservedFile,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<String, String> {
    scope.assert_current().map_err(|_| refused())?;
    parent.assert_current().map_err(|_| refused())?;
    file.assert_current().map_err(|_| refused())?;
    let parent_hash = file_identity(
        &scope.path,
        &parent.path,
        &parent.held.metadata().map_err(|_| refused())?,
        cancelled,
        deadline,
    )?;
    let target_hash = file_identity(
        &scope.path,
        &file.path,
        &file.file.metadata().map_err(|_| refused())?,
        cancelled,
        deadline,
    )?;
    let value = object(vec![
        ("version", Json::Number(1.0)),
        ("kind", string("ScopedWriteTargetIdentity")),
        ("status", string("scoped_write_target_verified")),
        (
            "scopeRoot",
            string(scope.path.to_str().ok_or_else(refused)?),
        ),
        ("target", string(file.path.to_str().ok_or_else(refused)?)),
        (
            "existingParent",
            string(parent.path.to_str().ok_or_else(refused)?),
        ),
        ("parentIdentityHash", string(&parent_hash)),
        ("targetIdentityHash", string(&target_hash)),
        ("blockers", Json::Array(vec![])),
    ]);
    let result = hash("ScopedWriteTargetIdentity", &value, cancelled, deadline)?;
    parent.assert_current().map_err(|_| refused())?;
    file.assert_current().map_err(|_| refused())?;
    Ok(result)
}
pub(super) struct Records {
    pub manifest: Vec<u8>,
    pub manifest_name: String,
    pub receipt: Json,
    pub ledger: Vec<u8>,
    pub ledger_name: String,
}
pub(super) struct RecordInput<'a> {
    pub role: &'a str,
    pub content_type: &'a str,
    pub relative: &'a str,
    pub content: &'a [u8],
    pub object_created: bool,
    pub created_at: &'a str,
    pub identity_hash: &'a str,
}
pub(super) fn records(
    scope: &Path,
    cas: &Path,
    input: RecordInput<'_>,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<Records, String> {
    let content_hash = publication::hash_bytes(input.content);
    let digest = &content_hash[7..];
    let object_path = format!("objects/sha256/{}/{}", &digest[..2], &digest[2..]);
    let mut manifest = object(vec![
        ("version", Json::Number(1.0)),
        ("kind", string("ImmutableArtifactManifest")),
        ("repositoryId", string("filesystem-cas-artifacts")),
        ("role", string(input.role)),
        ("contentType", string(input.content_type)),
        ("logicalPath", string(input.relative)),
        ("contentHash", string(&content_hash)),
        ("bytes", Json::Number(input.content.len() as f64)),
        ("objectPath", string(&object_path)),
        ("createdAt", string(input.created_at)),
    ]);
    let manifest_hash = hash("ImmutableArtifactManifest", &manifest, cancelled, deadline)?;
    if let Json::Object(fields) = &mut manifest {
        fields.push((key("manifestHash"), string(&manifest_hash)));
    }
    let manifest_name = format!("{}.json", &manifest_hash[7..]);
    let manifest_path = format!("manifests/{manifest_name}");
    let mut receipt = object(vec![
        ("version", Json::Number(2.0)),
        ("kind", string("ArtifactWriteReceipt")),
        ("repositoryId", string("filesystem-cas-artifacts")),
        ("role", string(input.role)),
        ("contentType", string(input.content_type)),
        ("path", string(input.relative)),
        ("bytes", Json::Number(input.content.len() as f64)),
        ("hash", string(&content_hash)),
        ("contentAddress", string(&content_hash)),
        ("manifestHash", string(&manifest_hash)),
        ("manifestPath", string(&manifest_path)),
        ("objectCreated", Json::Bool(input.object_created)),
        ("immutableObject", Json::Bool(true)),
        ("atomic", Json::Bool(true)),
        ("scopeRoot", string(scope.to_str().ok_or_else(refused)?)),
        ("casRoot", string(cas.to_str().ok_or_else(refused)?)),
        ("scopedWriteTargetIdentityHash", string(input.identity_hash)),
        ("createdAt", string(input.created_at)),
        ("externalActionPerformed", Json::Bool(false)),
    ]);
    let receipt_hash = hash("ArtifactWriteReceipt", &receipt, cancelled, deadline)?;
    if let Json::Object(fields) = &mut receipt {
        fields.push((key("writeReceiptHash"), string(&receipt_hash)));
    }
    let receipt_id = format!("report-artifact:{receipt_hash}");
    let mut ledger = object(vec![
        ("version", Json::Number(1.0)),
        ("kind", string("FilesystemReportReceiptLedgerEntry")),
        ("receiptId", string(&receipt_id)),
        ("stream", string("report-artifact-writes")),
        ("paperId", Json::Null),
        ("receiptKind", string("ArtifactWriteReceipt")),
        ("receiptHash", string(&receipt_hash)),
        ("receipt", receipt.clone()),
        ("recordedAt", string(input.created_at)),
        ("businessStoreMutated", Json::Bool(false)),
    ]);
    let ledger_hash = hash(
        "FilesystemReportReceiptLedgerEntry",
        &ledger,
        cancelled,
        deadline,
    )?;
    if let Json::Object(fields) = &mut ledger {
        fields.push((
            key("filesystemReportReceiptLedgerEntryHash"),
            string(&ledger_hash),
        ));
    }
    let ledger_name = format!(
        "{}.json",
        &publication::hash_bytes(receipt_id.as_bytes())[7..]
    );
    if let Json::Object(fields) = &mut receipt {
        fields.push((key("ledgerReceiptId"), string(&receipt_id)));
    }
    Ok(Records {
        manifest: pretty(&manifest, cancelled, deadline)?,
        manifest_name,
        receipt,
        ledger: pretty(&ledger, cancelled, deadline)?,
        ledger_name,
    })
}
