use super::{
    Error, Result, ensure,
    files::{self, MAXIMUM_RECEIPT_BYTES, Mirror},
    json::*,
    sqlite,
};
use crate::{
    online_runtime_activation::ordered_json::Json,
    runtime_image_reproducibility::{
        resolve_runtime_image_plugin_authority_v1,
        verify_runtime_image_builtin_plugin_source_binding_v1,
    },
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

const MIRROR_RELATIVE: &str = "autonomous-research/qualification/qualification-receipt.json";
const DATABASE_RELATIVE: &str =
    "autonomous-research/qualification/qualification-receipt.json.publication.sqlite";
const TABLE: &str = "full_research_qualification_pointer_authority";
const FILE_INVALID: &str = "full_research_qualification_pointer_file_invalid";
const DATABASE_INVALID: &str = "full_research_qualification_pointer_database_invalid";
const AUTHORITY_INVALID: &str = "full_research_qualification_pointer_authority_state_invalid";
const MIRROR_DRIFT: &str = "full_research_qualification_pointer_mirror_drift";

/// Read original authoritative pointer plus its byte-bound mirror through actual
/// files and an effective private WAL snapshot. The plugin context is resolved
/// from real source/public signed inputs; no receipt-supplied scope is trusted.
/// `now_millis` selects that context, not a receipt freshness gate. Returned data
/// is not signed/current qualification. All FDs close before return; call before
/// opening any caller-owned business SQLite connection or database descriptor.
pub fn read_full_research_qualification_receipt_pointer_v1(
    runtime_root: &Path,
    repository_root: &Path,
    environment: &BTreeMap<String, String>,
    now_millis: i64,
) -> Result<Option<Value>> {
    ensure(
        !runtime_root.as_os_str().is_empty(),
        "full_research_qualification_pointer_runtime_root_required",
    )?;
    let runtime_root = files::absolute(runtime_root)?;
    let database_path = runtime_root.join(DATABASE_RELATIVE);
    if !files::database_exists(&database_path, FILE_INVALID)? {
        return Ok(None);
    }
    let scope = current_scope(repository_root, environment, now_millis)?;
    let mirror_path = runtime_root.join(MIRROR_RELATIVE);
    // The captured result contains bytes/metadata only, even on success: its
    // regular file descriptor is already closed before any SQLite callback.
    // Defer errors to preserve authority-row absence/error precedence.
    let mirror = Mirror::capture(&mirror_path);
    let authority =
        crate::state_database_inventory::with_database_current_uid_effective_snapshot_path_v1(
            &runtime_root,
            Path::new(DATABASE_RELATIVE),
            "full-research-qualification-publication",
            |path| read_authority(path, &scope).map_err(|error| error.code),
        )
        .map_err(|error| {
            if error.code == "autonomous_research_state_database_source_uid_invalid" {
                Error::new(FILE_INVALID)
            } else {
                Error::new(error.code)
            }
        })?;
    let Some(authority) = authority else {
        return Ok(None);
    };
    let mirror = mirror.map_err(|_| Error::new(MIRROR_DRIFT))?;
    let mirrored = Document::parse(
        &mirror.bytes,
        "full_research_qualification_pointer_json_invalid",
    )
    .and_then(|document| {
        validate_receipt(&document, &scope)?;
        Ok(document)
    })
    .map_err(|_| Error::new(MIRROR_DRIFT))?;
    ensure(
        digest(&mirror.bytes) == authority.content_hash
            && mirrored.stringify == authority.document.stringify,
        MIRROR_DRIFT,
    )?;
    // All snapshot/SQLite owners are now closed. Recheck the captured mirror's
    // original names and metadata; this does not claim cross-file atomicity.
    mirror
        .assert_named_current()
        .map_err(|_| Error::new(MIRROR_DRIFT))?;
    Ok(Some(json!({
        "receipt": authority.document.value,
        "qualificationReceiptPath": mirror_path,
        "databasePath": database_path,
        "contentHash": authority.content_hash,
        "publicationGeneration": authority.publication_generation,
        "qualificationStateHash": authority.state_hash,
        "qualificationStateGeneration": authority.state_generation,
    })))
}

fn current_scope(
    repository_root: &Path,
    environment: &BTreeMap<String, String>,
    now_millis: i64,
) -> Result<Value> {
    let now = crate::sqlite_mutation_coordinator::clock::iso(now_millis)
        .map_err(|_| Error::new("qualification_stored_evidence_plugin_clock_invalid"))?;
    for key in [
        "HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE",
        "HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE",
    ] {
        if let Some(path) = environment
            .get(key)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        {
            ensure(
                Path::new(path).is_absolute(),
                "qualification_stored_evidence_relative_plugin_path_unsupported",
            )?;
        }
    }
    let plugin = resolve_runtime_image_plugin_authority_v1(&json!(environment), &now)
        .map_err(|error| Error::new(error.to_string()))?;
    if plugin.startup_inspection["source"] == "repository-builtin-signed-bundle-v1" {
        verify_runtime_image_builtin_plugin_source_binding_v1(repository_root)
            .map_err(|error| Error::new(error.to_string()))?;
    }
    Ok(plugin.scope)
}

struct Authority {
    document: Document,
    content_hash: String,
    state_hash: String,
    state_generation: i64,
    publication_generation: i64,
}

fn read_authority(path: &Path, scope: &Value) -> Result<Option<Authority>> {
    let connection = sqlite::open(path, MAXIMUM_RECEIPT_BYTES, DATABASE_INVALID)?;
    sqlite::table(
        &connection,
        TABLE,
        &[
            "singleton_id",
            "receipt_json",
            "receipt_content_hash",
            "receipt_hash",
            "runtime_receipt_hash",
            "qualification_state_hash",
            "qualification_state_generation",
            "publisher_scope",
            "publisher_owner_id",
            "publisher_lease_generation",
            "issued_at",
            "expires_at",
            "publication_generation",
        ],
        DATABASE_INVALID,
    )?;
    let mut statement = connection.prepare(
        "SELECT CASE WHEN typeof(receipt_json)='text' AND length(CAST(receipt_json AS BLOB)) BETWEEN 1 AND 16777216 THEN receipt_json END,receipt_content_hash,receipt_hash,runtime_receipt_hash,qualification_state_hash,qualification_state_generation,publisher_scope,publisher_owner_id,publisher_lease_generation,issued_at,expires_at,publication_generation FROM full_research_qualification_pointer_authority WHERE singleton_id=1 LIMIT 2"
    ).map_err(|_| Error::new(DATABASE_INVALID))?;
    let mut rows = statement
        .query([])
        .map_err(|_| Error::new(DATABASE_INVALID))?;
    let Some(row) = rows.next().map_err(|_| Error::new(DATABASE_INVALID))? else {
        return Ok(None);
    };
    let raw = sqlite::text(
        row,
        0,
        MAXIMUM_RECEIPT_BYTES,
        "full_research_qualification_pointer_json_invalid",
    )?;
    let document = Document::parse(
        raw.as_bytes(),
        "full_research_qualification_pointer_json_invalid",
    )?;
    validate_receipt(&document, scope)?;
    let content_hash = sqlite::text(row, 1, 256, AUTHORITY_INVALID)?;
    let receipt_hash = sqlite::text(row, 2, 256, AUTHORITY_INVALID)?;
    let runtime_hash = sqlite::text(row, 3, 256, AUTHORITY_INVALID)?;
    let state_hash = sqlite::text(row, 4, 256, AUTHORITY_INVALID)?;
    let state_generation = sqlite::integer(row, 5, AUTHORITY_INVALID)?;
    let publisher_scope = sqlite::text(row, 6, 256, AUTHORITY_INVALID)?;
    let publisher_owner = sqlite::text(row, 7, 256, AUTHORITY_INVALID)?;
    let publisher_generation = sqlite::integer(row, 8, AUTHORITY_INVALID)?;
    let issued = sqlite::text(row, 9, 128, AUTHORITY_INVALID)?;
    let expires = sqlite::text(row, 10, 128, AUTHORITY_INVALID)?;
    let publication_generation = sqlite::integer(row, 11, AUTHORITY_INVALID)?;
    ensure(
        digest(raw.as_bytes()) == content_hash
            && document.value["fullResearchQualificationReceiptHash"].as_str()
                == Some(&receipt_hash)
            && document.value["runtimeImageReproducibilityReceiptHash"].as_str()
                == Some(&runtime_hash)
            && document.value["issuedAt"].as_str() == Some(&issued)
            && document.value["expiresAt"].as_str() == Some(&expires)
            && hash_like(&Value::String(state_hash.clone()))
            && state_generation >= 1
            && publication_generation >= 1
            && publisher_generation >= 1
            && id(&Value::String(publisher_scope), 256, true)
            && id(&Value::String(publisher_owner), 256, true),
        AUTHORITY_INVALID,
    )?;
    ensure(
        rows.next()
            .map_err(|_| Error::new(DATABASE_INVALID))?
            .is_none(),
        AUTHORITY_INVALID,
    )?;
    Ok(Some(Authority {
        document,
        content_hash,
        state_hash,
        state_generation,
        publication_generation,
    }))
}

fn validate_receipt(document: &Document, scope: &Value) -> Result<()> {
    const INVALID: &str = "full_research_qualification_pointer_receipt_hash_invalid";
    let receipt = &document.value;
    let profiles = &scope["requiredProfiles"];
    ensure(
        receipt.is_object()
            && hash_like(&receipt["fullResearchQualificationReceiptHash"])
            && hash_like(&receipt["runtimeImageReproducibilityReceiptHash"])
            && ordered_equal(
                document
                    .ordered
                    .get("runtimeImageReproducibilityRequiredProfiles"),
                profiles,
            )?
            && manifest_matches(
                document
                    .ordered
                    .get("runtimeImageReproducibilityDefinitionManifestHashes"),
                profiles,
            )
            && [
                "empiricalFamilyPluginPackageHash",
                "empiricalFamilyPluginRegistryHash",
                "empiricalFamilyPluginStartupInspectionHash",
                "runtimeImageReproducibilityActivePluginScopeHash",
            ]
            .iter()
            .all(|field| strict_equal(&receipt[*field], &scope[*field]))
            && ordered_equal(
                document
                    .ordered
                    .get("activeEmpiricalProductionProfileHashes"),
                &scope["activeProductionProfileHashes"],
            )?
            && document.own_hash(
                "FullResearchGoldenMicroCampaignQualificationReceipt",
                "fullResearchQualificationReceiptHash",
            )?,
        INVALID,
    )
}

fn ordered_equal(actual: Option<&Json>, expected: &Value) -> Result<bool> {
    let Some(actual) = actual else {
        return Ok(false);
    };
    let actual = actual
        .stringify()
        .map_err(|_| Error::new("qualification_stored_evidence_json_profile_unsupported"))?;
    let expected = hepta_legacy_compatibility::production_stable_json_v1(expected)
        .map_err(|_| Error::new("qualification_stored_evidence_json_profile_unsupported"))?;
    Ok(actual.as_bytes() == expected)
}

fn manifest_matches(manifest: Option<&Json>, profiles: &Value) -> bool {
    let (Some(Json::Object(entries)), Some(profiles)) = (manifest, profiles.as_array()) else {
        return false;
    };
    entries.len() == profiles.len()
        && entries
            .iter()
            .zip(profiles)
            .all(|((key, value), expected)| {
                expected.as_str() == Some(key) && hash_like(&value.to_value())
            })
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}
