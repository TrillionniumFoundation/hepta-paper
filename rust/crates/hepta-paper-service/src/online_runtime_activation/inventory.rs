use super::*;
use crate::sqlite_mutation_coordinator::{DATABASE_ROLES, manifest::assert_writer_manifest_v1};
use serde_json::json;
use std::collections::BTreeSet;

fn relative(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && !s.contains('\\')
            && !s.starts_with('/')
            && !s.contains("//")
            && !s.ends_with('/')
            && !s.split('/').any(|c| c == "." || c == "..")
    })
}
fn scope_role(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        (2..=64).contains(&s.len())
            && s.as_bytes()[0].is_ascii_lowercase()
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    })
}
pub fn state_database_scope_hash_v1(instances: &Value) -> Result<String> {
    let instances = instances
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| error("autonomous_research_state_database_scope_empty"))?;
    let mut scope = Vec::new();
    for entry in instances {
        if !scope_role(&entry["role"])
            || !nonempty(&entry["instanceId"])
            || !relative(&entry["sourceRelativePath"])
        {
            return Err(error("autonomous_research_state_database_scope_invalid"));
        }
        scope.push(json!({"instanceId":entry["instanceId"],"role":entry["role"],"sourceRelativePath":entry["sourceRelativePath"]}));
    }
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    scope.sort_by(|a, b| {
        collator.compare(
            a["instanceId"].as_str().unwrap_or_default(),
            b["instanceId"].as_str().unwrap_or_default(),
        )
    });
    hash("AutonomousResearchStateDatabaseScope", &json!(scope))
}
pub fn state_database_inventory_hash_v1(inventory: &Value) -> Result<String> {
    if inventory["version"] != 1
        || inventory["kind"] != "AutonomousResearchStateDatabaseInventory"
        || inventory["status"] != "autonomous_research_state_database_inventory_ready"
        || !sha(&inventory["manifestHash"])
        || !sha(&inventory["databaseScopeHash"])
        || !inventory["instances"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
    {
        return Err(error(
            "autonomous_research_state_database_inventory_invalid",
        ));
    }
    let mut payload = serde_json::Map::new();
    for key in [
        "manifestId",
        "manifestHash",
        "databaseScopeHash",
        "instances",
    ] {
        if let Some(value) = inventory.get(key) {
            payload.insert(key.to_owned(), value.clone());
        }
    }
    hash(
        "AutonomousResearchStateDatabaseInventory",
        &Value::Object(payload),
    )
}
/// A closed, correctly hashed inventory claim. Files and authority receipts are
/// not validated by this function and this value does not authorize mutation.
pub fn assert_closed_activation_inventory_v1(inventory: &Value, manifest: &Value) -> Result<()> {
    assert_writer_manifest_v1(manifest).map_err(|e| error(e.to_string()))?;
    let fail = || error("autonomous_research_online_runtime_activation_inventory_invalid");
    let inventory_hash = state_database_inventory_hash_v1(inventory).map_err(|_| fail())?;
    let scope_hash = state_database_scope_hash_v1(&inventory["instances"]).map_err(|_| fail())?;
    let instances = inventory["instances"].as_array().ok_or_else(fail)?;
    if inventory["manifestId"] != "hepta-paper-autonomous-research-state-databases-v1"
        || inventory["inventoryHash"] != inventory_hash
        || inventory["databaseScopeHash"] != scope_hash
        || !empty(&inventory["blockers"])
        || instances.len() != DATABASE_ROLES.len()
        || manifest["coverage"]["coveredRoleCount"] != manifest["coverage"]["requiredRoleCount"]
        || manifest["coverage"]["percent"] != 100
        || manifest["coverage"]["coveredDatabaseRoles"] != manifest["requiredDatabaseRoles"]
    {
        return Err(fail());
    }
    let mut ids = Vec::new();
    let mut roles = BTreeSet::new();
    for entry in instances {
        if ![
            "instanceId",
            "role",
            "sourceRelativePath",
            "schemaContractId",
        ]
        .iter()
        .all(|k| nonempty(&entry[k]))
            || !sha(&entry["schemaHash"])
            || entry["quickCheck"] != "ok"
            || entry["foreignKeyViolationCount"] != 0
            || !empty(&entry["missingSchemaObjects"])
        {
            return Err(fail());
        }
        ids.push(entry["instanceId"].as_str().ok_or_else(fail)?);
        roles.insert(entry["role"].as_str().ok_or_else(fail)?);
    }
    if roles != DATABASE_ROLES.iter().copied().collect()
        || !ids
            .windows(2)
            .all(|p| p[0].encode_utf16().cmp(p[1].encode_utf16()).is_lt())
    {
        return Err(fail());
    }
    Ok(())
}
fn project(inventory: &super::ordered_json::Json) -> Result<String> {
    use super::ordered_json::Json;
    let fail = || error("autonomous_research_online_runtime_activation_inventory_invalid");
    let instances = inventory
        .get("instances")
        .and_then(Json::array)
        .ok_or_else(fail)?;
    let mut rows = Vec::new();
    for entry in instances {
        let id = entry
            .get("instanceId")
            .and_then(Json::string)
            .filter(|s| !s.is_empty())
            .ok_or_else(fail)?;
        let mut row = Vec::new();
        for key in [
            "role",
            "instanceId",
            "sourceRelativePath",
            "schemaContractId",
            "schemaHash",
            "sourceSha256",
            "sourceFileIdentity",
            "walSha256",
            "walFileIdentity",
            "missingSchemaObjects",
            "quickCheck",
            "foreignKeyViolationCount",
        ] {
            if let Some(value) = entry.get(key) {
                row.push((key.to_owned(), value.clone()));
            }
        }
        rows.push((id, Json::Object(row)));
    }
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    rows.sort_by(|(a, _), (b, _)| collator.compare(a, b));
    Json::Array(rows.into_iter().map(|(_, v)| v).collect()).stringify()
}
/// The input must be raw JSON: a serde_json::Value cannot preserve the member
/// order used by Node's JSON.stringify comparison. Objects obey Node's numeric
/// property ordering, duplicate-member last-value rule and scalar encoding.
pub fn stable_activation_inventory_scope_json_v1(left: &[u8], right: &[u8]) -> Result<bool> {
    use super::ordered_json::Json;
    let parse = |bytes: &[u8]| {
        serde_json::from_slice::<Json>(bytes)
            .map_err(|_| error("autonomous_research_online_runtime_activation_inventory_invalid"))
    };
    let left = parse(left)?;
    let right = parse(right)?;
    let scope = |v: &Json| -> Result<String> {
        v.get("databaseScopeHash")
            .ok_or_else(|| {
                error("autonomous_research_online_runtime_activation_inventory_invalid")
            })?
            .stringify()
    };
    Ok(scope(&left)? == scope(&right)? && project(&left)? == project(&right)?)
}
