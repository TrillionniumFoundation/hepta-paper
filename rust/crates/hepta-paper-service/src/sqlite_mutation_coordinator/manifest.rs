use super::*;
use std::collections::{BTreeMap, BTreeSet};
pub const WRITER_MANIFEST_KIND: &str = "AutonomousResearchOnlineWriterCoverageManifest";
pub const INTEGRATED_STATUS: &str = "coordinator-integrated-reserve-apply-finalize-v1";
pub const UNCOVERED_STATUS: &str = "uncovered-no-coordinator-integration";
fn values(value: &Value) -> Option<Vec<&str>> {
    value.as_array()?.iter().map(Value::as_str).collect()
}
fn sorted_unique(value: &Value) -> bool {
    values(value).is_some_and(|v| !v.is_empty() && v.windows(2).all(|p| p[0] < p[1]))
}
fn dml(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| ["business-dml", "lease-or-budget-dml", "publication-dml"].contains(&s))
}
fn source(value: &Value) -> bool {
    let Some(s) = value.as_str() else {
        return false;
    };
    if let Some(s) = s
        .strip_prefix("store/migrations/")
        .and_then(|s| s.strip_suffix(".sql"))
    {
        return !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
    }
    [
        "paper-adapters/",
        "paper-application/",
        "paper-composition/",
        "paper-core/bin/",
    ]
    .iter()
    .any(|prefix| {
        s.strip_prefix(prefix)
            .and_then(|s| s.strip_suffix(".mjs"))
            .is_some_and(|s| {
                !s.is_empty()
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
            })
    })
}
pub fn assert_writer_manifest_v1(manifest: &Value) -> Result<()> {
    let required = DATABASE_ROLES.iter().copied().collect::<BTreeSet<_>>();
    let fail = || error("autonomous_research_online_writer_operation_manifest_invalid");
    let Some(operations) = manifest["operations"].as_array() else {
        return Err(fail());
    };
    let Some(writers) = manifest["writers"].as_array() else {
        return Err(fail());
    };
    if !keys(
        manifest,
        &[
            "version",
            "kind",
            "manifestId",
            "protocol",
            "requiredDatabaseRoles",
            "writers",
            "operations",
            "coverage",
        ],
    ) || manifest["version"] != 1
        || manifest["kind"] != WRITER_MANIFEST_KIND
        || !safe(&manifest["manifestId"])
        || manifest["protocol"] != ONLINE_MUTATION_PROTOCOL
        || values(&manifest["requiredDatabaseRoles"]) != Some(required.iter().copied().collect())
        || operations.is_empty()
        || !keys(
            &manifest["coverage"],
            &[
                "requiredRoleCount",
                "coveredRoleCount",
                "coveredDatabaseRoles",
                "percent",
            ],
        )
        || manifest["coverage"]["requiredRoleCount"] != json!(required.len())
        || !integer(&manifest["coverage"]["coveredRoleCount"], 0)
        || manifest["coverage"]["coveredRoleCount"]
            .as_u64()
            .is_none_or(|n| n > required.len() as u64)
        || !manifest["coverage"]["coveredDatabaseRoles"].is_array()
        || !manifest["coverage"]["percent"].is_number()
    {
        return Err(fail());
    }
    let mut by_id = BTreeMap::new();
    let mut anchors = BTreeSet::new();
    let mut enumerated = BTreeSet::new();
    for operation in operations {
        if !keys(
            operation,
            &[
                "operationId",
                "databaseRole",
                "sourceFile",
                "entrypoint",
                "mutationClass",
                "protocolStatus",
                "coordinatorIntegrated",
            ],
        ) || !safe(&operation["operationId"])
            || by_id.contains_key(&operation["operationId"].as_str())
            || !role(&operation["databaseRole"])
            || !source(&operation["sourceFile"])
            || !safe(&operation["entrypoint"])
            || !operation["mutationClass"].as_str().is_some_and(|s| {
                [
                    "business-dml",
                    "lease-or-budget-dml",
                    "publication-dml",
                    "schema-or-genesis-ddl",
                    "cross-database-maintenance",
                ]
                .contains(&s)
            })
            || !operation["coordinatorIntegrated"].is_boolean()
            || operation["protocolStatus"]
                != if operation["coordinatorIntegrated"] == true {
                    INTEGRATED_STATUS
                } else {
                    UNCOVERED_STATUS
                }
            || (operation["coordinatorIntegrated"] == true && !dml(&operation["mutationClass"]))
        {
            return Err(error("autonomous_research_online_writer_operation_invalid"));
        }
        let anchor = (
            text(operation, "databaseRole")?,
            text(operation, "sourceFile")?,
            text(operation, "entrypoint")?,
        );
        if !anchors.insert(anchor) {
            return Err(error(
                "autonomous_research_online_writer_source_anchor_duplicate",
            ));
        }
        enumerated.insert(text(operation, "databaseRole")?);
        by_id.insert(operation["operationId"].as_str(), operation);
    }
    if enumerated != required {
        return Err(error(
            "autonomous_research_online_writer_operation_roles_incomplete",
        ));
    }
    let mut assigned = BTreeSet::new();
    let mut writer_ids = BTreeSet::new();
    let mut covered = BTreeSet::new();
    for writer in writers {
        let Some(writer_roles) = values(&writer["databaseRoles"]) else {
            return Err(error("autonomous_research_online_writer_invalid"));
        };
        let Some(operation_ids) = values(&writer["operationIds"]) else {
            return Err(error("autonomous_research_online_writer_invalid"));
        };
        if !keys(
            writer,
            &[
                "writerId",
                "databaseRoles",
                "operationIds",
                "implementationHash",
                "protocol",
            ],
        ) || !safe(&writer["writerId"])
            || writer_ids.contains(&writer["writerId"].as_str())
            || !sorted_unique(&writer["databaseRoles"])
            || !writer_roles.iter().all(|r| required.contains(r))
            || !sorted_unique(&writer["operationIds"])
            || !sha(&writer["implementationHash"])
            || writer["protocol"] != ONLINE_MUTATION_PROTOCOL
        {
            return Err(error("autonomous_research_online_writer_invalid"));
        }
        let mut actual_roles = BTreeSet::new();
        for id in operation_ids {
            let Some(operation) = by_id.get(&Some(id)) else {
                return Err(error(
                    "autonomous_research_online_writer_operation_assignment_invalid",
                ));
            };
            if operation["coordinatorIntegrated"] != true || !assigned.insert(id) {
                return Err(error(
                    "autonomous_research_online_writer_operation_assignment_invalid",
                ));
            }
            actual_roles.insert(text(operation, "databaseRole")?);
        }
        if actual_roles.iter().copied().collect::<Vec<_>>() != writer_roles {
            return Err(error(
                "autonomous_research_online_writer_role_assignment_invalid",
            ));
        }
        covered.extend(writer_roles);
        writer_ids.insert(writer["writerId"].as_str());
    }
    let integrated = operations
        .iter()
        .filter(|o| o["coordinatorIntegrated"] == true)
        .filter_map(|o| o["operationId"].as_str())
        .collect::<BTreeSet<_>>();
    if assigned != integrated {
        return Err(error(
            "autonomous_research_online_writer_integrated_operation_unassigned",
        ));
    }
    for operation in operations {
        if covered.contains(text(operation, "databaseRole")?)
            && dml(&operation["mutationClass"])
            && operation["coordinatorIntegrated"] != true
        {
            return Err(error(format!(
                "autonomous_research_online_writer_role_dml_coverage_incomplete:{}",
                text(operation, "operationId")?
            )));
        }
    }
    if manifest["coverage"]["coveredRoleCount"] != json!(covered.len())
        || values(&manifest["coverage"]["coveredDatabaseRoles"])
            != Some(covered.iter().copied().collect())
        || manifest["coverage"]["percent"].as_f64()
            != Some(covered.len() as f64 * 100.0 / required.len() as f64)
    {
        return Err(error("autonomous_research_online_writer_coverage_invalid"));
    }
    Ok(())
}
pub fn writer_manifest_hash_v1(manifest: &Value) -> Result<String> {
    assert_writer_manifest_v1(manifest)?;
    hash(WRITER_MANIFEST_KIND, manifest)
}
