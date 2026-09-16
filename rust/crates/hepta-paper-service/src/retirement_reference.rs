//! Read-only verification of the immutable legacy retirement source snapshot.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path, process::Command};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RetirementReferenceError {
    #[error("retirement reference filesystem operation failed")]
    Io(#[from] std::io::Error),
    #[error("retirement reference JSON is invalid")]
    Json(#[from] serde_json::Error),
}

fn sha256_file(path: &Path) -> Result<String, RetirementReferenceError> {
    let digest = Sha256::digest(fs::read(path)?);
    Ok(format!("sha256:{digest:x}"))
}

fn read_json(
    path: &Path,
    blockers: &mut Vec<String>,
    missing: &str,
) -> Result<Option<Value>, RetirementReferenceError> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(value) => Ok(Some(value)),
            Err(_) => {
                blockers.push(missing.to_owned());
                Ok(None)
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            blockers.push(missing.to_owned());
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

/// Verify the receipt-bound archive set without mutating it or consulting a
/// live legacy runtime. The result shape follows the Node verifier exactly.
pub fn verify_retirement_reference_v1(root: &Path) -> Result<Value, RetirementReferenceError> {
    let mut blockers = Vec::new();
    let receipt = read_json(
        &root.join("RETIREMENT_SOURCE_SNAPSHOT_RECEIPT.json"),
        &mut blockers,
        "retirement_snapshot_receipt_missing_or_invalid",
    )?;
    let immutable = read_json(
        &root.join("IMMUTABILITY_RECEIPT.json"),
        &mut blockers,
        "immutability_receipt_missing_or_invalid",
    )?;
    if let Some(archives) = receipt
        .as_ref()
        .and_then(|value| value.get("archives"))
        .and_then(Value::as_array)
    {
        for archive in archives {
            let name = archive
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let path = root.join(name);
            match fs::metadata(&path) {
                Ok(metadata) => {
                    if archive.get("bytes").and_then(Value::as_u64) != Some(metadata.len()) {
                        blockers.push(format!("archive_size_mismatch:{name}"));
                    }
                    if archive.get("sha256").and_then(Value::as_str)
                        != Some(sha256_file(&path)?.as_str())
                    {
                        blockers.push(format!("archive_hash_mismatch:{name}"));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    blockers.push(format!("archive_missing:{name}"));
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
    if let Some(files) = immutable
        .as_ref()
        .and_then(|value| value.get("files"))
        .and_then(Value::as_array)
    {
        for item in files {
            let name = item.get("name").and_then(Value::as_str).unwrap_or_default();
            let path = root.join(name);
            if !path.exists() {
                continue;
            }
            match Command::new("lsattr").arg("-d").arg(&path).output() {
                Ok(output) if output.status.success() => {
                    let attributes = String::from_utf8_lossy(&output.stdout)
                        .split_whitespace()
                        .next()
                        .unwrap_or_default()
                        .to_owned();
                    if !attributes.contains('i') {
                        blockers.push(format!("archive_not_immutable:{name}"));
                    }
                }
                Ok(_) | Err(_) => {
                    blockers.push(format!("archive_immutability_unverifiable:{name}"))
                }
            }
        }
    }
    Ok(json!({
        "version": 1,
        "kind": "LegacyRetirementReferenceVerification",
        "status": if blockers.is_empty() { "retirement_reference_verified" } else { "retirement_reference_blocked" },
        "referenceRoot": root,
        "runtimeDependencyAllowed": false,
        "liveLegacyRootExists": Path::new("/data/home-data/paper_factory").exists(),
        "archiveCount": receipt.as_ref().and_then(|value| value.get("archives")).and_then(Value::as_array).map_or(0, Vec::len),
        "blockers": blockers,
    }))
}
