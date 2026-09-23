use super::{
    Result, authority, common_receipt, error, exact_keys, files, hash, nonempty, object_id,
    record_hash, sha, stripped,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::{Component, Path, PathBuf},
};

const PROVENANCE_KEYS: &[&str] = &[
    "version",
    "kind",
    "packageVersion",
    "commit",
    "commitTree",
    "tags",
    "treeDirty",
    "indexStateHash",
    "repositoryEntryCount",
    "repositoryContentHash",
    "worktreeStateHash",
    "evidenceEnvironment",
    "evidenceClass",
];
fn provenance_valid(value: &Value) -> bool {
    exact_keys(value, PROVENANCE_KEYS)
        && value["version"] == 2
        && value["kind"] == "CodeProvenance"
        && nonempty(&value["packageVersion"])
        && object_id(&value["commit"])
        && object_id(&value["commitTree"])
        && value["tags"].as_array().is_some_and(|tags| {
            tags.iter().all(Value::is_string)
                && tags
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<BTreeSet<_>>()
                    .len()
                    == tags.len()
        })
        && value["treeDirty"].is_boolean()
        && [
            "indexStateHash",
            "repositoryContentHash",
            "worktreeStateHash",
        ]
        .iter()
        .all(|key| sha(&value[*key]))
        && value["repositoryEntryCount"]
            .as_u64()
            .is_some_and(|v| v > 0 && v <= 9_007_199_254_740_991)
        && nonempty(&value["evidenceEnvironment"])
        && nonempty(&value["evidenceClass"])
}
fn exact_provenance(document: &Value, current: &Value, commit: &str) -> bool {
    let bound = &document["codeProvenance"];
    provenance_valid(bound)
        && provenance_valid(current)
        && bound["treeDirty"] == false
        && current["treeDirty"] == false
        && bound["commit"] == commit
        && current["commit"] == commit
        && bound == current
        && record_hash("CapabilityVerificationCodeProvenance", bound)
            .is_ok_and(|digest| document["codeProvenanceHash"] == digest)
}
fn production_subject(root: &Path) -> Result<Value> {
    let root =
        fs::canonicalize(root).map_err(|_| error("capability_production_asset_root_invalid"))?;
    let relative = "submission/AoM/A_Theory_of__Expectations/main.tex";
    let mut cursor = root.clone();
    let mut identities = vec![(
        cursor.clone(),
        fs::symlink_metadata(&cursor)
            .map_err(|_| error("capability_production_asset_root_invalid"))?,
    )];
    for part in Path::new(relative).components() {
        cursor.push(part);
        let meta = fs::symlink_metadata(&cursor)
            .map_err(|_| error("capability_production_source_not_regular"))?;
        if meta.is_symlink()
            || (!meta.is_dir() && cursor != root.join(relative))
            || (cursor == root.join(relative)
                && (!meta.is_file() || meta.len() == 0 || meta.len() > 128 * 1024 * 1024))
        {
            return Err(error("capability_production_source_not_regular"));
        }
        identities.push((cursor.clone(), meta));
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(&cursor)
        .map_err(|_| error("capability_production_source_not_regular"))?;
    let expected = &identities
        .last()
        .ok_or_else(|| error("capability_production_source_not_regular"))?
        .1;
    if !files::same(
        expected,
        &file
            .metadata()
            .map_err(|_| error("capability_production_source_not_regular"))?,
    ) {
        return Err(error("capability_production_source_unstable"));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(128 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("capability_production_source_not_regular"))?;
    if bytes.len() as u64 != expected.len()
        || !files::same(
            expected,
            &file
                .metadata()
                .map_err(|_| error("capability_production_source_not_regular"))?,
        )
    {
        return Err(error("capability_production_source_unstable"));
    }
    for (path, meta) in identities {
        if !files::same(
            &meta,
            &fs::symlink_metadata(path)
                .map_err(|_| error("capability_production_source_unstable"))?,
        ) {
            return Err(error("capability_production_source_unstable"));
        }
    }
    Ok(
        json!({"paperId":"A_Theory_of__Expectations","sourcePath":relative,"sourceHash":hash(&bytes)}),
    )
}
fn subject_binding(document: &Value, subject: &Value) -> bool {
    document["productionSubject"] == *subject
        && document["inputHashes"]
            .as_array()
            .is_some_and(|hashes| hashes.contains(&subject["sourceHash"]))
}
fn self_hash(document: &Value, kind: &str, field: &str, signatures: bool) -> bool {
    let mut payload = stripped(document, &[field]);
    if signatures && let Some(object) = payload.as_object_mut() {
        object.insert("signatures".to_owned(), json!([]));
    }
    record_hash(kind, &payload).is_ok_and(|digest| document[field] == digest)
}
fn has_external_action(value: &Value) -> bool {
    let mut pending = vec![value];
    let mut inspected = 0;
    while let Some(value) = pending.pop() {
        match value {
            Value::Array(values) => {
                inspected += 1;
                pending.extend(values);
            }
            Value::Object(values) => {
                inspected += 1;
                if values.get("externalActionPerformed") == Some(&Value::Bool(true))
                    || values.get("providerCallPerformed") == Some(&Value::Bool(true))
                {
                    return true;
                }
                pending.extend(values.values());
            }
            _ => (),
        }
        if inspected > 10_000 {
            return true;
        }
    }
    false
}
fn evidence_valid(
    document: &Value,
    capability: &str,
    targets: &Value,
    commit: &str,
    subject: &Value,
    provenance: &Value,
) -> bool {
    if document["kind"] != "CapabilityConformanceReplayEvidence"
        || document["version"] != 2
        || document["status"] != "production_source_bound_conformance_replay_verified"
        || document["executionClass"] != "production_source_bound_conformance"
        || document["evidenceEnvironment"] != "production_source_bound"
        || document["evidenceClass"] != "conformance"
        || document["externalActionPerformed"] != false
        || document["productionEligible"] != false
        || has_external_action(&json!([document["firstResult"], document["secondResult"]]))
        || !common_receipt(document, capability, targets, commit)
        || !subject_binding(document, subject)
        || !exact_provenance(document, provenance, commit)
    {
        return false;
    }
    let first = record_hash(
        "CapabilityOperationalResult",
        &json!({"capabilityId":capability,"result":document["firstResult"]}),
    );
    let second = record_hash(
        "CapabilityOperationalResult",
        &json!({"capabilityId":capability,"result":document["secondResult"]}),
    );
    let (Ok(first), Ok(second)) = (first, second) else {
        return false;
    };
    let comparison = json!({"version":1,"kind":"CapabilityOperationalReplayComparison","capabilityId":capability,"firstResultHash":first,"secondResultHash":second,"replayMatched":first == second});
    first == second
        && document["resultHash"] == first
        && record_hash("CapabilityOperationalReplayComparison", &comparison)
            .is_ok_and(|digest| document["replayReceiptHash"] == digest)
        && self_hash(
            document,
            "CapabilityConformanceReplayEvidence",
            "executionReceiptHash",
            false,
        )
}
fn receipt_assurance(
    document: &Value,
    trust: &Value,
    capability: &str,
    targets: &Value,
    commit: &str,
    subject: &Value,
    provenance: &Value,
) -> Option<String> {
    if document["kind"] != "CapabilityConformanceReceipt"
        || document["version"] != 2
        || document["status"] != "production_source_bound_conformance_replay_verified"
        || document["executionClass"] != "production_source_bound_conformance"
        || document["evidenceEnvironment"] != "production_source_bound"
        || document["evidenceClass"] != "conformance"
        || document["productionEligible"] != false
        || document["externalActionPerformed"] != false
        || !common_receipt(document, capability, targets, commit)
        || !subject_binding(document, subject)
        || !exact_provenance(document, provenance, commit)
        || !self_hash(
            document,
            "CapabilityConformanceReceipt",
            "capabilityConformanceReceiptHash",
            true,
        )
    {
        return None;
    }
    let keys = authority::verify(document, trust, &["capability_owner"], 1)?;
    let assurances = keys
        .iter()
        .map(|key| {
            key["assurance"]
                .as_str()
                .filter(|v| !v.is_empty())
                .unwrap_or("unspecified")
        })
        .collect::<BTreeSet<_>>();
    if assurances.is_empty() || assurances.contains("unspecified") {
        return None;
    }
    Some(assurances.into_iter().collect::<Vec<_>>().join("+"))
}
fn artifact(root: &Path, value: &Value) -> Result<PathBuf> {
    let path = value
        .as_str()
        .ok_or_else(|| error("conformance_artifact_logical_path_invalid"))?;
    if !path.starts_with("conformance-proof/")
        || path.contains('\\')
        || path.ends_with('/')
        || path.contains("//")
        || Path::new(path)
            .components()
            .any(|v| !matches!(v, Component::Normal(_)))
        || path.split('/').any(|v| v == "." || v == "..")
    {
        return Err(error("conformance_artifact_logical_path_invalid"));
    }
    Ok(root.join(path))
}
pub(super) fn load(
    root: &Path,
    asset: &Path,
    provenance: &Value,
    catalog: &[(&str, &str)],
    targets: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, (String, String)>> {
    if !provenance_valid(provenance) || provenance["treeDirty"] != false {
        return Err(error("conformance_clean_head_required"));
    }
    let subject = production_subject(asset)?;
    let commit = provenance["commit"]
        .as_str()
        .ok_or_else(|| error("conformance_code_provenance_invalid"))?;
    let trust = files::read(root, &root.join("owner-acceptance/OWNER_TRUST_STORE.json"))?;
    let manifest = files::read(
        root,
        &root.join(format!(
            "conformance-proof/CAPABILITY_CONFORMANCE_REPLAY_MANIFEST_{}.json",
            &commit[..12]
        )),
    )?;
    let doc = &manifest.document;
    let entries = doc["verified"]
        .as_array()
        .ok_or_else(|| error("conformance_replay_manifest_capabilities_mismatch"))?;
    if doc["kind"] != "CapabilityConformanceReplayManifest"
        || doc["version"] != 2
        || doc["status"] != "all_capabilities_conformance_replayed"
        || doc["productionEligible"] != false
        || doc["externalActionPerformed"] != false
        || doc["releaseCommit"] != commit
        || !subject_binding(doc, &subject)
        || doc["paperId"] != subject["paperId"]
        || doc["productionSourceHash"] != subject["sourceHash"]
        || doc["capabilityCount"] != catalog.len()
        || entries.len() != catalog.len()
        || !exact_provenance(doc, provenance, commit)
        || !self_hash(
            doc,
            "CapabilityConformanceReplayManifest",
            "capabilityConformanceReplayManifestHash",
            false,
        )
    {
        return Err(error("conformance_replay_manifest_invalid"));
    }
    let mut verified = BTreeMap::new();
    let mut accepted = Vec::new();
    for entry in entries {
        let capability = entry["capabilityId"]
            .as_str()
            .ok_or_else(|| error("conformance_manifest_entry_invalid"))?;
        let target = targets
            .get(capability)
            .ok_or_else(|| error("conformance_manifest_capability_duplicate_or_unknown"))?;
        if verified.contains_key(capability) {
            return Err(error(
                "conformance_manifest_capability_duplicate_or_unknown",
            ));
        }
        let receipt = files::read(root, &artifact(root, &entry["receiptPath"])?)?;
        let evidence = files::read(root, &artifact(root, &entry["evidencePath"])?)?;
        let r = &receipt.document;
        let e = &evidence.document;
        let assurance = receipt_assurance(
            r,
            &trust.document,
            capability,
            target,
            commit,
            &subject,
            provenance,
        )
        .ok_or_else(|| error("conformance_manifest_entry_invalid"))?;
        if !evidence_valid(e, capability, target, commit, &subject, provenance)
            || !super::targets_match_json(&receipt, target)
            || !super::targets_match_json(&evidence, target)
            || ["resultHash", "executionReceiptHash", "replayReceiptHash"]
                .iter()
                .any(|key| entry[*key] != r[*key] || entry[*key] != e[*key])
            || entry["conformanceReceiptHash"] != r["capabilityConformanceReceiptHash"]
            || r["executionEvidencePath"] != entry["evidencePath"]
            || ["productionSubject", "inputHashes", "targetHashes"]
                .iter()
                .any(|key| {
                    receipt
                        .ordered
                        .get(key)
                        .and_then(|value| value.encode(false).ok())
                        != evidence
                            .ordered
                            .get(key)
                            .and_then(|value| value.encode(false).ok())
                })
        {
            return Err(error("conformance_manifest_entry_invalid"));
        }
        verified.insert(
            capability.to_owned(),
            (
                r["capabilityConformanceReceiptHash"]
                    .as_str()
                    .ok_or_else(|| error("conformance_manifest_entry_invalid"))?
                    .to_owned(),
                assurance,
            ),
        );
        accepted.push(receipt);
        accepted.push(evidence);
    }
    if verified.len() != catalog.len() || production_subject(asset)? != subject {
        return Err(error("conformance_manifest_entry_invalid"));
    }
    // Stronger snapshot retention than the Node v2 conformance loader: receipt
    // replacement during inspection invalidates the entire manifest.
    trust.assert_current()?;
    manifest.assert_current()?;
    for snapshot in accepted {
        snapshot.assert_current()?;
    }
    Ok(verified)
}
