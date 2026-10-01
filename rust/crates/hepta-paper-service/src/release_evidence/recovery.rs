//! Recovery verifies existing native diagnostic bytes, pinned keys and the
//! current actual source. It never treats a diagnostic as a ready release.
use super::{Directory, ObservedFile, RECEIPT_BYTES, checkpoint};
use crate::release_integrity_key::LoadedReleaseIntegrityKeyV1;
use crate::release_replay::local_signature::{
    LocalReleaseIntegritySignatureV1, verify_local_release_integrity_signature_v1,
};
use crate::state_recoverability::publication::publish_receipt_bytes;
use hepta_control_plane::canonical_hash_v1;
use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, sync::atomic::AtomicBool, time::Instant};
const MAX_DIRECTORY_ENTRIES: usize = 256;
const MAX_RECEIPTS: usize = 16;
const MAX_AGGREGATE_BYTES: u64 = 64 * 1024 * 1024;
fn error(code: &str) -> String {
    format!("release_evidence_recovery_{code}")
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn final_name(hash: &str) -> Result<String, String> {
    let hash = hash
        .strip_prefix("sha256:")
        .filter(|v| hex(v, 64))
        .ok_or_else(|| error("payload_hash_invalid"))?;
    Ok(format!("NATIVE_BLOCKED_DRILL_v1_{hash}.json"))
}
fn selected(name: &str) -> bool {
    name.strip_prefix("NATIVE_BLOCKED_DRILL_v1_")
        .and_then(|v| v.strip_suffix(".json"))
        .is_some_and(|v| hex(v, 64))
        || name.strip_prefix(".pending-").is_some_and(|v| hex(v, 32))
}
fn verify(
    bytes: &[u8],
    source: &Value,
    key: &LoadedReleaseIntegrityKeyV1,
) -> Result<(Value, String), String> {
    if bytes.is_empty() || bytes.len() as u64 > RECEIPT_BYTES {
        return Err(error("byte_budget"));
    }
    let value = crate::sqlite_mutation_coordinator::authority::files::parse(
        bytes,
        "release_evidence_recovery_json_invalid",
    )
    .map_err(|e| e.to_string())?;
    if value.as_object().is_none_or(|v| v.len() != 4)
        || value["version"] != 1
        || value["kind"] != "NativeBlockedReplayIntegrityReceipt"
    {
        return Err(error("envelope_invalid"));
    }
    let payload = &value["payload"];
    if payload["version"] != 13
        || payload["kind"] != "ReleaseAttestationPolicyReplayInspection"
        || payload["sourceBound"] != true
        || payload["status"] != "release_attestation_blocked"
        || payload["nativeSourceCapture"] != *source
    {
        return Err(error("source_or_scope_mismatch"));
    }
    for field in [
        "releaseEvidenceReady",
        "physicalDeletionAllowed",
        "nodeRetirement",
        "externalActionPerformed",
    ] {
        if payload[field] != false {
            return Err(error("authority_boundary_invalid"));
        }
    }
    for field in [
        "policyReplayComplete",
        "rustBehavioralSuiteMatchingComplete",
        "fullRestoredArchiveAndRuntimeReplayComplete",
        "fullRustProductImplementationClaimed",
    ] {
        if payload["matrixPolicyReplay"][field] != false {
            return Err(error("authority_boundary_invalid"));
        }
    }
    let signature: LocalReleaseIntegritySignatureV1 =
        serde_json::from_value(value["signature"].clone())
            .map_err(|_| error("signature_contract_invalid"))?;
    verify_local_release_integrity_signature_v1(
        payload,
        &signature,
        &key.public_key_pem,
        &key.public_key_fingerprint,
    )?;
    let mut unhashed = payload.clone();
    let hash = unhashed
        .as_object_mut()
        .and_then(|v| v.remove("reportHash"))
        .ok_or_else(|| error("report_hash_missing"))?;
    let expected = canonical_hash_v1(&json!({"kind":payload["kind"],"value":unhashed}))
        .map_err(|_| error("report_hash_invalid"))?
        .to_string();
    if hash != expected {
        return Err(error("report_hash_mismatch"));
    }
    key.assert_current().map_err(|e| e.to_string())?;
    let name = final_name(&signature.payload_hash)?;
    Ok((value, name))
}
pub(super) fn recover(
    directory: &Directory,
    source: &Value,
    key: &LoadedReleaseIntegrityKeyV1,
    cancelled: &AtomicBool,
    started: Instant,
) -> Result<Value, String> {
    checkpoint(cancelled, started)?;
    directory.assert_current().map_err(|e| e.to_string())?;
    let before = directory.held.metadata().map_err(|e| e.to_string())?;
    let mut names = BTreeSet::new();
    let mut count = 0_usize;
    for entry in fs::read_dir(&directory.path).map_err(|e| e.to_string())? {
        checkpoint(cancelled, started)?;
        count += 1;
        if count > MAX_DIRECTORY_ENTRIES {
            return Err(error("directory_entry_budget"));
        }
        let name = entry
            .map_err(|e| e.to_string())?
            .file_name()
            .into_string()
            .map_err(|_| error("name_encoding_invalid"))?;
        if selected(&name) && !names.insert(name) {
            return Err(error("duplicate_name"));
        }
    }
    use std::os::unix::fs::MetadataExt;
    let after = directory.held.metadata().map_err(|e| e.to_string())?;
    if before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err(error("directory_changed_during_selection"));
    }
    directory.assert_current().map_err(|e| e.to_string())?;
    if names.len() > MAX_RECEIPTS {
        return Err(error("receipt_count_budget"));
    }
    let mut aggregate = 0_u64;
    let mut selected_receipts = Vec::new();
    for name in names {
        checkpoint(cancelled, started)?;
        let held = ObservedFile::open(&directory.path.join(&name), RECEIPT_BYTES)
            .map_err(|e| e.to_string())?;
        let bytes = held.bytes(RECEIPT_BYTES).map_err(|e| e.to_string())?;
        aggregate = aggregate
            .checked_add(bytes.len() as u64)
            .filter(|v| *v <= MAX_AGGREGATE_BYTES)
            .ok_or_else(|| error("aggregate_byte_budget"))?;
        let (value, final_name) = verify(&bytes, source, key)?;
        if name.starts_with("NATIVE_BLOCKED_DRILL_v1_") && name != final_name {
            return Err(error("final_name_mismatch"));
        }
        selected_receipts.push((name, held, bytes, value, final_name));
    }
    let mut observations = Vec::new();
    for (name, held, bytes, value, final_name) in selected_receipts {
        checkpoint(cancelled, started)?;
        held.assert_current().map_err(|e| e.to_string())?;
        key.assert_current().map_err(|e| e.to_string())?;
        let mut published = false;
        if name.starts_with(".pending-") {
            let path = directory.path.join(&final_name);
            match fs::symlink_metadata(&path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    publish_receipt_bytes(directory, &final_name, &value, &bytes, None)
                        .map_err(|e| format!("{}:{e}", error("no_clobber_publication_failed")))?;
                    published = true;
                }
                Ok(_) => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        let final_held = ObservedFile::open(&directory.path.join(&final_name), RECEIPT_BYTES)
            .map_err(|e| e.to_string())?;
        if final_held.bytes(RECEIPT_BYTES).map_err(|e| e.to_string())? != bytes {
            return Err(error("published_byte_conflict"));
        }
        held.assert_current().map_err(|e| e.to_string())?;
        final_held.assert_current().map_err(|e| e.to_string())?;
        key.assert_current().map_err(|e| e.to_string())?;
        observations.push(json!({"inputName":name,"finalName":final_name,"bytes":bytes.len(),"newNoClobberPublication":published,"signatureVerified":true,"currentSourceBindingVerified":true,"pendingInputRetained":name.starts_with(".pending-")}));
    }
    directory.assert_current().map_err(|e| e.to_string())?;
    checkpoint(cancelled, started)?;
    Ok(
        json!({"version":1,"kind":"NativeBlockedReleaseDiagnosticRecovery","status":"integrity_diagnostics_observed_release_blocked","receipts":observations,"actualReadBytes":aggregate,"directoryEntriesObserved":count,"resourceLimits":{"maximumDirectoryEntries":MAX_DIRECTORY_ENTRIES,"maximumReceipts":MAX_RECEIPTS,"maximumReceiptBytes":RECEIPT_BYTES,"maximumAggregateBytes":MAX_AGGREGATE_BYTES},"releaseEvidenceReady":false,"physicalDeletionAllowed":false,"nodeRetirement":false,"externalActionPerformed":false}),
    )
}
