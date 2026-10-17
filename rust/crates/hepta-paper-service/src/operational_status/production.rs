//! Full-production proof aggregation using the explicitly pinned public trust
//! supplied by the owner-reference adapter. Runtime-local trust is never used
//! as a fallback for this path; conformance receipts are never counted.
use super::*;
use std::path::PathBuf;

pub(crate) struct ProductionProofInspection {
    pub report: Value,
    workspace_root: PathBuf,
    provenance: Value,
    targets: Vec<(PathBuf, Option<String>)>,
    receipts: Vec<files::Snapshot>,
}

impl ProductionProofInspection {
    pub(crate) fn assert_current(&self) -> Result<()> {
        for receipt in &self.receipts {
            receipt.assert_current()?;
        }
        for (path, expected) in &self.targets {
            let observed = match fs::read(path) {
                Ok(bytes) => Some(hash(&bytes)),
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => return Err(error("capability_target_read_failed")),
            };
            if observed != *expected {
                return Err(error("full_production_operational_source_changed"));
            }
        }
        if current_operational_code_provenance_v1(&self.workspace_root)? != self.provenance {
            return Err(error("full_production_operational_source_changed"));
        }
        Ok(())
    }
}

/// Only the full-production composition supplies trust after reading and
/// retaining the protected, content-pinned owner reference. The return value
/// is a local observation, not a writer or activation capability.
pub(crate) fn inspect_production_proofs(
    workspace_root: &Path,
    runtime_root: &Path,
    trust: &Value,
) -> Result<ProductionProofInspection> {
    let provenance = current_operational_code_provenance_v1(workspace_root)?;
    let commit = provenance["commit"]
        .as_str()
        .filter(|value| object_id(&json!(value)))
        .ok_or_else(|| error("code_provenance_commit_required"))?;
    let mut catalog = OPERATIONAL_CAPABILITIES_V1.to_vec();
    catalog.sort_by_key(|(id, _)| *id);
    let mut targets = Vec::new();
    let mut accepted = Vec::new();
    let mut capabilities = Vec::new();
    for (id, target) in &catalog {
        let path = workspace_root.join(target);
        let digest = match fs::read(&path) {
            Ok(bytes) => Some(hash(&bytes)),
            Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(error("capability_target_read_failed")),
        };
        let binding = json!([{"path": target, "sha256": digest}]);
        targets.push((path, digest));
        let directory = runtime_root.join("operational-proof/capabilities").join(id);
        let mut paths = Vec::new();
        if let Ok(entries) = fs::read_dir(&directory) {
            for entry in entries {
                let entry = entry.map_err(|_| error("capability_proof_directory_read_failed"))?;
                if entry.file_name().to_string_lossy().ends_with(".json") {
                    paths.push(entry.path());
                    // Bound input accumulation; exceeding the limit must not
                    // preserve a verified prefix of a partially scanned set.
                    if paths.len() > 4096 {
                        return Err(error("capability_proof_directory_limit_exceeded"));
                    }
                }
            }
        }
        paths.sort();
        let mut receipts = BTreeSet::new();
        for path in paths {
            if let Ok(receipt) = files::read(runtime_root, &path)
                && targets_match_json(&receipt, &binding)
                && operational_receipt(&receipt.document, trust, id, &binding, commit)
                && let Ok(digest) = record_hash("CapabilityOperationalReceipt", &receipt.document)
            {
                receipts.insert(digest);
                accepted.push(receipt);
            }
        }
        capabilities.push(json!({
            "capabilityId": id,
            "verified": !receipts.is_empty(),
            "operationalReceiptHashes": receipts,
            "issuerAssurances": if receipts.is_empty() { json!([]) } else { json!(["external_independent"]) },
        }));
    }
    let verified = capabilities
        .iter()
        .filter(|value| value["verified"] == true)
        .count();
    let report = json!({
        "version": 1,
        "kind": "IndependentProductionOperationalProofInspection",
        "status": if verified == catalog.len() { "independent_production_operational_proof_ready" } else { "independent_production_operational_proof_blocked" },
        "releaseCommit": commit,
        "verified": verified,
        "required": catalog.len(),
        "capabilities": capabilities,
        "externalIndependentRequired": true,
        "conformanceCannotQualify": true,
    });
    let result = ProductionProofInspection {
        report,
        workspace_root: workspace_root.into(),
        provenance,
        targets,
        receipts: accepted,
    };
    result.assert_current()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        process::{Command, Stdio},
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new(mutation: Option<&str>, trust_override: &str) -> (Self, Value) {
            let fixture = Self(std::env::temp_dir().join(format!(
                "hepta-production-proof-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            )));
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
            let mut child = Command::new("node")
                .arg(root.join("rust/oracle/operational-status-v1.mjs"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(
                    json!({
                        "root": fixture.0, "prepare": true, "mutate": mutation,
                        "productionTrustOverride": trust_override
                    })
                    .to_string()
                    .as_bytes(),
                )
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let node: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(node["profile"]["node"], "v22.23.1");
            assert!(node.get("error").is_none(), "{node}");
            (fixture, node)
        }
        fn inspect(&self) -> ProductionProofInspection {
            let trust = serde_json::from_slice(
                &fs::read(self.0.join("capabilities-public/OWNER_TRUST_STORE.json")).unwrap(),
            )
            .unwrap();
            inspect_production_proofs(&self.0.join("workspace"), &self.0.join("runtime"), &trust)
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn pinned_external_trust_and_complete_operational_inspection_match_node() {
        for mode in ["valid", "invalid", "runtime-invalid"] {
            let (fixture, node) = Fixture::new(None, mode);
            let inspection = fixture.inspect();
            assert_eq!(inspection.report, node["productionInspection"], "{mode}");
            assert_eq!(
                inspection.report["verified"],
                if mode == "invalid" { 0 } else { 16 }
            );
        }
    }
    #[test]
    fn malformed_receipts_and_conformance_never_supply_operational_proof() {
        for mutation in [
            "tamper_signature",
            "reordered_targets",
            "reused_subject",
            "local_assurance",
            "retired_key",
            "receipt_symlink",
            "missing_operational",
            "dirty_source",
        ] {
            let (fixture, node) = Fixture::new(Some(mutation), "valid");
            assert_eq!(
                fixture.inspect().report,
                node["productionInspection"],
                "{mutation}"
            );
            assert!(node["productionInspection"]["verified"].as_u64().unwrap() < 16);
        }
    }
    #[test]
    fn accepted_receipt_and_source_changes_invalidate_retained_inspection() {
        for source in [false, true] {
            let (fixture, _) = Fixture::new(None, "valid");
            let inspection = fixture.inspect();
            let path = if source {
                fixture
                    .0
                    .join("workspace")
                    .join(OPERATIONAL_CAPABILITIES_V1[0].1)
            } else {
                fixture
                    .0
                    .join("runtime/operational-proof/capabilities")
                    .join(OPERATIONAL_CAPABILITIES_V1[0].0)
                    .join("receipt.json")
            };
            fs::write(path, "changed").unwrap();
            assert!(inspection.assert_current().is_err());
        }
    }
}
