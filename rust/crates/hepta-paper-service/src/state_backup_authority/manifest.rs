use super::*;
use std::collections::BTreeSet;
const MUTATION_OBJECTS: &[&str] = &[
    "index:idx_autonomous_research_online_mutation_marker_head",
    "table:autonomous_research_online_mutation_authority_marker",
    "table:autonomous_research_online_mutation_authority_metadata",
    "table:autonomous_research_online_mutation_finalization_receipt",
    "trigger:autonomous_research_online_mutation_finalization_marker_required",
    "trigger:autonomous_research_online_mutation_finalization_no_delete",
    "trigger:autonomous_research_online_mutation_finalization_no_update",
    "trigger:autonomous_research_online_mutation_marker_no_delete",
    "trigger:autonomous_research_online_mutation_marker_no_update",
    "trigger:autonomous_research_online_mutation_metadata_no_delete",
    "trigger:autonomous_research_online_mutation_metadata_no_update",
];
const RESIDENT_OBJECTS: &[&str] = &[
    "index:idx_autonomous_research_online_authority_receipt_latest",
    "table:autonomous_research_online_authority_journal_metadata",
    "table:autonomous_research_online_authority_receipt_journal",
    "trigger:autonomous_research_online_authority_journal_no_delete",
    "trigger:autonomous_research_online_authority_journal_no_update",
];
pub(super) fn relative(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        !s.is_empty()
            && !s.contains(['\\', '\0'])
            && !s.starts_with('/')
            && !s.contains("//")
            && !s.ends_with('/')
            && !s.split('/').any(|c| c == "." || c == "..")
    })
}
fn role(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        (2..=64).contains(&s.len())
            && s.as_bytes()[0].is_ascii_lowercase()
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    })
}
fn object(v: &Value) -> bool {
    let Some((kind, name)) = v.as_str().and_then(|s| s.split_once(':')) else {
        return false;
    };
    matches!(kind, "table" | "index" | "trigger" | "view")
        && (1..=128).contains(&name.len())
        && (name.as_bytes()[0].is_ascii_alphabetic() || name.as_bytes()[0] == b'_')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
pub fn assert_state_database_manifest_v1(manifest: &Value) -> Result<()> {
    if !keys(
        manifest,
        &[
            "version",
            "kind",
            "manifestId",
            "unknownAutonomousResearchSqlitePolicy",
            "databases",
            "excludedDatabases",
        ],
    ) || number(&manifest["version"]) != Some(1)
        || manifest["kind"] != "AutonomousResearchStateDatabaseManifest"
        || !role(&manifest["manifestId"])
        || manifest["unknownAutonomousResearchSqlitePolicy"] != "block"
        || !manifest["databases"].is_array()
        || !manifest["excludedDatabases"].is_array()
    {
        return Err(error("autonomous_research_state_database_manifest_invalid"));
    }
    let mut roles = BTreeSet::new();
    for entry in manifest["databases"].as_array().into_iter().flatten() {
        let per = entry["cardinality"] == "per-paper";
        let key = if per {
            "relativePathPattern"
        } else {
            "relativePath"
        };
        let Some(objects) = entry["requiredSchemaObjects"].as_array() else {
            return Err(error(
                "autonomous_research_state_database_manifest_entry_invalid",
            ));
        };
        if !keys(
            entry,
            &[
                "role",
                "cardinality",
                key,
                "minimumInstances",
                "schemaContractId",
                "requiredSchemaObjects",
            ],
        ) || !role(&entry["role"])
            || !matches!(
                entry["cardinality"].as_str(),
                Some("singleton" | "per-paper")
            )
            || number(&entry["minimumInstances"]).is_none_or(|v| v < 1)
            || !role(&entry["schemaContractId"])
            || objects.is_empty()
            || !objects.iter().all(object)
            || !objects.windows(2).all(|p| p[0].as_str() < p[1].as_str())
        {
            return Err(error(
                "autonomous_research_state_database_manifest_entry_invalid",
            ));
        }
        if !relative(&entry[key])
            || (per
                && entry[key]
                    .as_str()
                    .is_none_or(|v| v.matches("{paperId}").count() != 1))
        {
            return Err(error(if per {
                "autonomous_research_state_database_manifest_pattern_invalid"
            } else {
                "autonomous_research_state_database_manifest_path_invalid"
            }));
        }
        let contains = |wanted: &&str| objects.iter().any(|v| v == *wanted);
        if !MUTATION_OBJECTS.iter().all(contains)
            || (entry["role"] == "resident-instance" && !RESIDENT_OBJECTS.iter().all(contains))
        {
            return Err(error(
                "autonomous_research_state_database_online_authority_schema_required",
            ));
        }
        if !roles.insert(entry["role"].as_str().unwrap_or_default()) {
            return Err(error(
                "autonomous_research_state_database_manifest_roles_invalid",
            ));
        }
    }
    if roles
        != crate::sqlite_mutation_coordinator::DATABASE_ROLES
            .iter()
            .copied()
            .collect()
    {
        return Err(error(
            "autonomous_research_state_database_manifest_roles_invalid",
        ));
    }
    let mut exclusions = BTreeSet::new();
    for entry in manifest["excludedDatabases"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if !keys(
            entry,
            &["relativePath", "status", "presence", "requiredBytes"],
        ) || !relative(&entry["relativePath"])
            || entry["relativePath"]
                .as_str()
                .is_none_or(|v| v.contains('/'))
            || entry["status"] != "retired-empty-unreferenced-placeholder"
            || entry["presence"] != "optional"
            || number(&entry["requiredBytes"]) != Some(0)
        {
            return Err(error(
                "autonomous_research_state_database_manifest_exclusion_invalid",
            ));
        }
        if !exclusions.insert(entry["relativePath"].as_str().unwrap_or_default()) {
            return Err(error(
                "autonomous_research_state_database_manifest_exclusion_duplicate",
            ));
        }
    }
    Ok(())
}
pub fn state_database_manifest_hash_v1(manifest: &Value) -> Result<String> {
    assert_state_database_manifest_v1(manifest)?;
    hash("AutonomousResearchStateDatabaseManifest", manifest)
}
pub fn state_database_scope_hash_v1(instances: &Value) -> Result<String> {
    let instances = instances
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or_else(|| error("autonomous_research_state_database_scope_empty"))?;
    let mut values = Vec::new();
    for entry in instances {
        if !role(&entry["role"])
            || entry["instanceId"].as_str().is_none_or(str::is_empty)
            || !relative(&entry["sourceRelativePath"])
        {
            return Err(error("autonomous_research_state_database_scope_invalid"));
        }
        values.push(json!({"instanceId":entry["instanceId"],"role":entry["role"],"sourceRelativePath":entry["sourceRelativePath"]}));
    }
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    values.sort_by(|a, b| {
        collator.compare(
            a["instanceId"].as_str().unwrap_or_default(),
            b["instanceId"].as_str().unwrap_or_default(),
        )
    });
    hash("AutonomousResearchStateDatabaseScope", &json!(values))
}
