//! Full-production owner acceptance adapter.
//!
//! This module is intentionally separate from the bounded readiness route.  It
//! performs the owner evidence work that the Node composition performs before
//! aggregation: it pins the two root-owned public files, verifies the real
//! Ed25519 authority signature, rebuilds the current family manifest, and only
//! then counts accepted legacy entries.  A JSON assertion is never enough to
//! qualify a family.

#![forbid(unsafe_code)]

use crate::{
    operational_status::authority,
    owner_status::{build_owner_acceptance_families_v1, reader},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};
use thiserror::Error;

/// Node's full-production policy is intentionally pinned to the checked-in
/// legacy family manifest.  These values are independently checked even when
/// a caller supplies a malformed or substituted manifest value.
pub const FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED: usize = 249;
pub const FULL_PRODUCTION_OWNER_FAMILY_MANIFEST_HASH: &str =
    "sha256:5937b03f562e7c2c26abd461bae87ffe25845e8511eee039f134f0db18c09b94";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum OwnerAcceptanceInspectionError {
    #[error("full_production_owner_acceptance_manifest_invalid")]
    ManifestInvalid,
    #[error("full_production_owner_acceptance_manifest_drift")]
    ManifestDrift,
    #[error("full_production_owner_acceptance_reference_invalid")]
    ReferenceInvalid,
    #[error("full_production_owner_acceptance_reference_changed")]
    ReferenceChanged,
    #[error("full_production_owner_acceptance_json_invalid")]
    JsonInvalid,
    #[error("full_production_owner_acceptance_hash_invalid")]
    HashInvalid,
}

type Result<T> = std::result::Result<T, OwnerAcceptanceInspectionError>;

fn is_sha256(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        let Some(hex) = text.strip_prefix("sha256:") else {
            return false;
        };
        hex.len() == 64
            && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
            && hex.bytes().all(|byte| !byte.is_ascii_uppercase())
    })
}

fn is_bare_sha256(value: &str) -> bool {
    value.len() == 64
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        && value.bytes().all(|byte| !byte.is_ascii_uppercase())
}

fn exact_manifest_shape(manifest: &Value) -> Option<(&[Value], &str)> {
    if manifest["version"] != 1 || manifest["kind"] != "CapabilityOwnerAcceptanceFamilyManifest" {
        return None;
    }
    let families = manifest["families"].as_array()?;
    let hash = manifest["familyManifestHash"].as_str()?;
    Some((families.as_slice(), hash))
}

fn manifest_entry_count(families: &[Value]) -> Option<usize> {
    let mut ids = BTreeSet::new();
    let mut count = 0;
    for family in families {
        if family["version"] != 1
            || family["kind"] != "CapabilityOwnerAcceptanceFamily"
            || family["familyId"].as_str().is_none_or(str::is_empty)
            || !is_sha256(&family["familyHash"])
            || family["businessDecision"]
                .as_str()
                .is_none_or(str::is_empty)
            || family["migrationAction"].as_str().is_none_or(str::is_empty)
            || family["capabilityIds"].as_array().is_none()
        {
            return None;
        }
        for entry in family["legacyEntries"].as_array()? {
            let id = entry["legacyMatrixEntryId"].as_str()?;
            let source = entry["sourceSha256"].as_str()?;
            if id.is_empty() || !is_bare_sha256(source) || !ids.insert(id) {
                return None;
            }
            count += 1;
        }
    }
    Some(count)
}

/// Verify the signed acceptance document against the exact current family
/// manifest.  The returned map contains one value per accepted legacy entry;
/// its value carries the assurance/classification from the verified trust key.
pub fn verify_owner_acceptance_document_v1(
    document: &Value,
    trust_store: &Value,
    family_manifest: &Value,
) -> BTreeMap<String, Value> {
    let mut accepted = BTreeMap::new();
    if document["kind"] != "CapabilityOwnerAcceptance"
        || !(document["version"] == 1 || document["version"] == 2)
    {
        return accepted;
    }
    let Some(keys) = authority::verify(document, trust_store, &["capability_owner"], 1) else {
        return accepted;
    };
    let key = keys.first();
    let assurance = key
        .and_then(|key| key["assurance"].as_str())
        .unwrap_or("unspecified");
    let acceptance_class = match assurance {
        "external_independent" => "external_independent_owner_acceptance",
        "local_admin_delegated" => "local_admin_delegated_owner_acceptance",
        _ => "unclassified_owner_acceptance",
    };
    let Some(families) = family_manifest["families"].as_array() else {
        return accepted;
    };
    if document["version"] == 2 {
        if document["familyManifestHash"] != family_manifest["familyManifestHash"] {
            return accepted;
        }
        // Node's Map keeps the final value for duplicate IDs.  The outer
        // inspection rejects duplicate IDs, but retaining this behaviour here
        // keeps this value helper faithful when called independently.
        let mut by_family = BTreeMap::<&str, &Value>::new();
        for entry in document["acceptedFamilies"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(id) = entry["familyId"].as_str() {
                by_family.insert(id, entry);
            }
        }
        for family in families {
            let Some(id) = family["familyId"].as_str() else {
                continue;
            };
            let Some(entry) = by_family.get(id) else {
                continue;
            };
            if entry["familyHash"] != family["familyHash"]
                || entry["businessDecision"] != family["businessDecision"]
            {
                continue;
            }
            for legacy in family["legacyEntries"].as_array().into_iter().flatten() {
                if let Some(legacy_id) = legacy["legacyMatrixEntryId"].as_str() {
                    accepted.insert(
                        legacy_id.to_owned(),
                        json!({
                            "issuerAssurance": assurance,
                            "acceptanceClass": acceptance_class,
                        }),
                    );
                }
            }
        }
    } else {
        for entry in document["acceptedEntries"].as_array().into_iter().flatten() {
            if let Some(id) = entry["legacyMatrixEntryId"].as_str() {
                accepted.insert(
                    id.to_owned(),
                    json!({
                        "issuerAssurance": assurance,
                        "acceptanceClass": acceptance_class,
                    }),
                );
            }
        }
    }
    accepted
}

/// Build the exact Node `IndependentExternalOwnerAcceptanceInspection` value.
/// The adapter never turns local-admin or unclassified evidence into external
/// acceptance and never trusts a document's claimed count.
pub fn inspect_independent_external_owner_acceptance_v1(
    matrix: &Value,
    family_manifest: &Value,
    document: &Value,
    trust_store: &Value,
) -> Result<Value> {
    let generated = build_owner_acceptance_families_v1(matrix)
        .map_err(|_| OwnerAcceptanceInspectionError::ManifestInvalid)?;
    let Some((families, family_hash)) = exact_manifest_shape(family_manifest) else {
        return Err(OwnerAcceptanceInspectionError::ManifestInvalid);
    };
    let Some(required) = manifest_entry_count(families) else {
        return Err(OwnerAcceptanceInspectionError::ManifestInvalid);
    };
    if required != FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED
        || family_hash != FULL_PRODUCTION_OWNER_FAMILY_MANIFEST_HASH
        || generated != *family_manifest
    {
        return Err(OwnerAcceptanceInspectionError::ManifestDrift);
    }
    let expected_ids = families
        .iter()
        .filter_map(|family| family["familyId"].as_str())
        .collect::<Vec<_>>();
    let actual_ids = document["acceptedFamilies"]
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .map(|entry| entry["familyId"].as_str().unwrap_or_default())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut expected_sorted = expected_ids.clone();
    expected_sorted.sort_unstable();
    let mut actual_sorted = actual_ids.clone();
    actual_sorted.sort_unstable();
    let family_manifest_bound = document["version"] == 2
        && document["kind"] == "CapabilityOwnerAcceptance"
        && document["familyManifestHash"] == family_manifest["familyManifestHash"]
        && actual_ids.len() == expected_ids.len()
        && actual_ids.iter().collect::<BTreeSet<_>>().len() == actual_ids.len()
        && actual_sorted == expected_sorted;
    let accepted = if family_manifest_bound {
        verify_owner_acceptance_document_v1(document, trust_store, family_manifest)
    } else {
        BTreeMap::new()
    };
    let externally_accepted = accepted
        .values()
        .filter(|record| {
            record["issuerAssurance"] == "external_independent"
                && record["acceptanceClass"] == "external_independent_owner_acceptance"
        })
        .count();
    let local_admin_accepted = accepted
        .values()
        .filter(|record| {
            record["issuerAssurance"] == "local_admin_delegated"
                && record["acceptanceClass"] == "local_admin_delegated_owner_acceptance"
        })
        .count();
    Ok(json!({
        "version": 1,
        "kind": "IndependentExternalOwnerAcceptanceInspection",
        "status": if family_manifest_bound && externally_accepted == required {
            "independent_external_owner_acceptance_ready"
        } else {
            "independent_external_owner_acceptance_blocked"
        },
        "externallyAccepted": externally_accepted,
        "required": required,
        "familyManifestBound": family_manifest_bound,
        "familyManifestHash": document["familyManifestHash"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(|value| Value::String(value.to_owned()))
            .unwrap_or(Value::Null),
        "localAdminAccepted": local_admin_accepted,
        "automaticAcceptanceForbidden": true,
    }))
}

/// A pinned owner reference pair suitable for passing to operational-proof
/// aggregation.  Callers must call `assert_current` immediately before using
/// the values; this mirrors Node's descriptor/path snapshot assertions.
#[derive(Clone, Debug)]
pub struct PinnedOwnerReferences {
    trust: reader::Snapshot,
    acceptance: reader::Snapshot,
    root: PathBuf,
    root_metadata: fs::Metadata,
}

impl PinnedOwnerReferences {
    /// Read the exact `capabilities-public` pair and bind both bytes to their
    /// declared hashes. Production always requires UID 0 for this public
    /// authority directory; tests use the private `open_with_required_uid`
    /// helper below for temporary fixtures.
    pub fn open(
        owner_trust_store: &Path,
        owner_trust_store_sha256: &str,
        owner_acceptance_document: &Path,
        owner_acceptance_document_sha256: &str,
    ) -> Result<Self> {
        Self::open_with_policy(
            owner_trust_store,
            owner_trust_store_sha256,
            owner_acceptance_document,
            owner_acceptance_document_sha256,
            0,
        )
    }

    fn open_with_policy(
        owner_trust_store: &Path,
        owner_trust_store_sha256: &str,
        owner_acceptance_document: &Path,
        owner_acceptance_document_sha256: &str,
        required_uid: u32,
    ) -> Result<Self> {
        if !owner_trust_store.is_absolute()
            || !owner_acceptance_document.is_absolute()
            || owner_trust_store.file_name().and_then(|v| v.to_str())
                != Some("OWNER_TRUST_STORE.json")
            || owner_acceptance_document
                .file_name()
                .and_then(|v| v.to_str())
                != Some("CAPABILITY_OWNER_ACCEPTANCE.json")
        {
            return Err(OwnerAcceptanceInspectionError::ReferenceInvalid);
        }
        let root = owner_trust_store
            .parent()
            .ok_or(OwnerAcceptanceInspectionError::ReferenceInvalid)?;
        if owner_acceptance_document.parent() != Some(root)
            || root.file_name().and_then(|v| v.to_str()) != Some("capabilities-public")
            || root.parent().is_none()
        {
            return Err(OwnerAcceptanceInspectionError::ReferenceInvalid);
        }
        let root_metadata = fs::symlink_metadata(root)
            .map_err(|_| OwnerAcceptanceInspectionError::ReferenceInvalid)?;
        if !root_metadata.is_dir()
            || root_metadata.file_type().is_symlink()
            || root_metadata.uid() != required_uid
            || root_metadata.mode() & 0o022 != 0
            || fs::canonicalize(root).ok().as_deref() != Some(root)
        {
            return Err(OwnerAcceptanceInspectionError::ReferenceInvalid);
        }
        let trust = reader::read(owner_trust_store, true)
            .map_err(|_| OwnerAcceptanceInspectionError::ReferenceInvalid)?;
        if trust.content_hash != owner_trust_store_sha256 || trust.selected_uid() != required_uid {
            return Err(OwnerAcceptanceInspectionError::HashInvalid);
        }
        let acceptance = reader::read(owner_acceptance_document, true)
            .map_err(|_| OwnerAcceptanceInspectionError::ReferenceInvalid)?;
        if acceptance.content_hash != owner_acceptance_document_sha256
            || acceptance.selected_uid() != required_uid
        {
            return Err(OwnerAcceptanceInspectionError::HashInvalid);
        }
        Ok(Self {
            trust,
            acceptance,
            root: root.to_path_buf(),
            root_metadata: root_metadata.clone(),
        })
    }

    #[cfg(test)]
    pub(super) fn open_with_required_uid(
        owner_trust_store: &Path,
        owner_trust_store_sha256: &str,
        owner_acceptance_document: &Path,
        owner_acceptance_document_sha256: &str,
        required_uid: u32,
    ) -> Result<Self> {
        Self::open_with_policy(
            owner_trust_store,
            owner_trust_store_sha256,
            owner_acceptance_document,
            owner_acceptance_document_sha256,
            required_uid,
        )
    }

    #[cfg(test)]
    pub(super) fn open_with_uid(
        owner_trust_store: &Path,
        owner_trust_store_sha256: &str,
        owner_acceptance_document: &Path,
        owner_acceptance_document_sha256: &str,
        required_uid: u32,
    ) -> Result<Self> {
        Self::open_with_policy(
            owner_trust_store,
            owner_trust_store_sha256,
            owner_acceptance_document,
            owner_acceptance_document_sha256,
            required_uid,
        )
    }

    pub fn trust_document(&self) -> &Value {
        &self.trust.document
    }

    pub fn acceptance_document(&self) -> &Value {
        &self.acceptance.document
    }

    pub fn trust_hash(&self) -> &str {
        &self.trust.content_hash
    }

    pub fn acceptance_hash(&self) -> &str {
        &self.acceptance.content_hash
    }

    pub fn assert_current(&self) -> Result<()> {
        let current_root = fs::symlink_metadata(&self.root)
            .map_err(|_| OwnerAcceptanceInspectionError::ReferenceChanged)?;
        if !same_protected_directory(&self.root_metadata, &current_root)
            || fs::canonicalize(&self.root).ok().as_deref() != Some(self.root.as_path())
        {
            return Err(OwnerAcceptanceInspectionError::ReferenceChanged);
        }
        self.trust
            .assert_current()
            .map_err(|_| OwnerAcceptanceInspectionError::ReferenceChanged)?;
        self.acceptance
            .assert_current()
            .map_err(|_| OwnerAcceptanceInspectionError::ReferenceChanged)
    }

    pub fn inspect(&self, matrix: &Value, family_manifest: &Value) -> Result<Value> {
        self.assert_current()?;
        inspect_independent_external_owner_acceptance_v1(
            matrix,
            family_manifest,
            self.acceptance_document(),
            self.trust_document(),
        )
    }

    /// Read and retain the workspace matrix and family manifest snapshots,
    /// then perform owner inspection. The caller must retain this value and
    /// call `assert_current` before using its report for final aggregation.
    pub fn inspect_workspace(&self, workspace_root: &Path) -> Result<PinnedOwnerInspection> {
        if !workspace_root.is_absolute() {
            return Err(OwnerAcceptanceInspectionError::ReferenceInvalid);
        }
        self.assert_current()?;
        let matrix = reader::read(
            &workspace_root.join("migration/legacy-semantic-migration-matrix.json"),
            false,
        )
        .map_err(|_| OwnerAcceptanceInspectionError::ReferenceInvalid)?;
        let family_manifest = reader::read(
            &workspace_root
                .join("paper-domain/governance/legacy-owner-acceptance-family-manifest.v1.json"),
            false,
        )
        .map_err(|_| OwnerAcceptanceInspectionError::ReferenceInvalid)?;
        let report = inspect_independent_external_owner_acceptance_v1(
            &matrix.document,
            &family_manifest.document,
            self.acceptance_document(),
            self.trust_document(),
        )?;
        self.assert_current()?;
        matrix
            .assert_current()
            .map_err(|_| OwnerAcceptanceInspectionError::ReferenceChanged)?;
        family_manifest
            .assert_current()
            .map_err(|_| OwnerAcceptanceInspectionError::ReferenceChanged)?;
        Ok(PinnedOwnerInspection {
            references: self.clone(),
            matrix,
            family_manifest,
            report,
        })
    }
}

fn same_protected_directory(expected: &fs::Metadata, current: &fs::Metadata) -> bool {
    expected.is_dir()
        && !expected.file_type().is_symlink()
        && current.is_dir()
        && !current.file_type().is_symlink()
        && expected.dev() == current.dev()
        && expected.ino() == current.ino()
        && expected.mode() == current.mode()
        && expected.uid() == current.uid()
        && expected.gid() == current.gid()
        && expected.nlink() == current.nlink()
        && expected.len() == current.len()
        && expected.mtime() == current.mtime()
        && expected.mtime_nsec() == current.mtime_nsec()
        && expected.ctime() == current.ctime()
        && expected.ctime_nsec() == current.ctime_nsec()
}

/// Retained owner plus workspace source snapshots and their derived report.
#[derive(Clone, Debug)]
pub struct PinnedOwnerInspection {
    references: PinnedOwnerReferences,
    matrix: reader::Snapshot,
    family_manifest: reader::Snapshot,
    report: Value,
}

impl PinnedOwnerInspection {
    pub fn report(&self) -> &Value {
        &self.report
    }

    pub fn owner_references(&self) -> &PinnedOwnerReferences {
        &self.references
    }

    pub fn assert_current(&self) -> Result<()> {
        self.references.assert_current()?;
        self.matrix
            .assert_current()
            .map_err(|_| OwnerAcceptanceInspectionError::ReferenceChanged)?;
        self.family_manifest
            .assert_current()
            .map_err(|_| OwnerAcceptanceInspectionError::ReferenceChanged)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::{
        fs,
        io::Write,
        os::unix::{fs::MetadataExt, fs::PermissionsExt},
        process::{Command, Stdio},
        sync::atomic::{AtomicU64, Ordering},
    };

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn sha256(bytes: &[u8]) -> String {
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    fn oracle(mode: &str) -> (Value, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "hepta-full-production-owner-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut child = Command::new("node")
            .arg(repository.join("rust/oracle/owner-status-v1.mjs"))
            .current_dir(&repository)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(json!({"root":root,"mode":mode}).to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        (serde_json::from_slice(&output.stdout).unwrap(), root)
    }

    fn cleanup(root: &Path) {
        let _ = fs::remove_dir_all(root);
    }

    fn node_owner_inspection(node: &Value) -> Value {
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut child = Command::new("node")
            .arg(repository.join("rust/oracle/full-production-owner-v1.mjs"))
            .current_dir(&repository)
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
                &json!({
                    "document": node["document"],
                    "trust": node["trust"],
                    "familyManifest": node["manifest"],
                })
                .to_string()
                .into_bytes(),
            )
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    #[test]
    fn owner_inspection_matches_node_for_real_signature_and_family_mutations() {
        for mode in [
            "complete",
            "none",
            "version_one",
            "local",
            "partial",
            "wrong_manifest",
            "wrong_family",
            "wrong_decision",
            "bad_signature",
            "revoked",
            "wrong_role",
            "null_family",
            "duplicate_family",
        ] {
            let (node, root) = oracle(mode);
            let native = inspect_independent_external_owner_acceptance_v1(
                &node["matrix"],
                &node["manifest"],
                &node["document"],
                &node["trust"],
            )
            .unwrap();
            let expected = node_owner_inspection(&node);
            assert_eq!(native, expected, "{mode}");
            cleanup(&root);
        }
    }

    #[test]
    fn pinned_owner_references_bind_hashes_and_detect_replacement() {
        let (node, source_root) = oracle("complete");
        let root = source_root.join("capabilities-public");
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let trust = root.join("OWNER_TRUST_STORE.json");
        let acceptance = root.join("CAPABILITY_OWNER_ACCEPTANCE.json");
        let trust_bytes = serde_json::to_vec(&node["trust"]).unwrap();
        let acceptance_bytes = serde_json::to_vec(&node["document"]).unwrap();
        fs::write(&trust, &trust_bytes).unwrap();
        fs::write(&acceptance, &acceptance_bytes).unwrap();
        fs::set_permissions(&trust, fs::Permissions::from_mode(0o600)).unwrap();
        fs::set_permissions(&acceptance, fs::Permissions::from_mode(0o600)).unwrap();
        let pinned = PinnedOwnerReferences::open_with_uid(
            &trust,
            &sha256(&trust_bytes),
            &acceptance,
            &sha256(&acceptance_bytes),
            fs::symlink_metadata(&root).unwrap().uid(),
        )
        .unwrap();
        assert_eq!(pinned.trust_document(), &node["trust"]);
        assert_eq!(pinned.acceptance_document(), &node["document"]);
        assert_eq!(
            pinned.inspect(&node["matrix"], &node["manifest"]).unwrap()["externallyAccepted"],
            FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED
        );
        fs::set_permissions(&root, fs::Permissions::from_mode(0o777)).unwrap();
        assert_eq!(
            pinned.assert_current().unwrap_err(),
            OwnerAcceptanceInspectionError::ReferenceChanged
        );
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(&acceptance, b"{}").unwrap();
        assert_eq!(
            pinned.assert_current().unwrap_err(),
            OwnerAcceptanceInspectionError::ReferenceChanged
        );
        cleanup(&source_root);
    }
}
