//! Signed pristine rebind edges, independently of archive directory ordering.
use super::*;
use crate::sqlite_mutation_coordinator::timestamp;
fn linked(previous: &Value, next: &Value) -> bool {
    let reserve = &next["reserveRequest"];
    let receipt = &next["reservation"];
    let previous_finalization = &previous["finalization"];
    let Some(heads) = receipt["previousDatabaseHeads"].as_array() else {
        return false;
    };
    let Some(genesis) = previous["reservation"]["databaseGenesis"].as_array() else {
        return false;
    };
    let Some(instances) = reserve["instances"].as_array() else {
        return false;
    };
    let Some(installations) = previous["installations"].as_array() else {
        return false;
    };
    let time_order = timestamp(&previous["observation"]["observedAt"])
        .zip(timestamp(&reserve["requestedAt"]))
        .is_some_and(|(before, after)| before <= after);
    next["version"] == 2
        && reserve["sourceWriterManifestHash"] == previous["writerManifestHash"]
        && same_fields(
            &previous["reserveRequest"],
            reserve,
            &["scopeId", "databaseScopeHash"],
        )
        && receipt["previousGlobalSequence"] == previous_finalization["globalSequence"]
        && previous_finalization["globalSequence"] == 0
        && receipt["previousGlobalHash"] == previous_finalization["globalHash"]
        && previous
            .get("postPristineRuntimeStateHash")
            .is_none_or(|value| reserve["prePristineRuntimeStateHash"] == *value)
        && time_order
        && heads.len() == genesis.len()
        && heads.len() == instances.len()
        && heads.len() == installations.len()
        && heads
            .iter()
            .zip(genesis)
            .zip(instances)
            .zip(installations)
            .enumerate()
            .all(|(index, (((head, old), instance), installation))| {
                same_fields(head, old, &["databaseRole", "databaseInstanceId"])
                    && same_fields(head, instance, &["databaseRole", "databaseInstanceId"])
                    && same_fields(head, installation, &["databaseRole", "databaseInstanceId"])
                    && head["sequence"] == old["databaseSequence"]
                    && head["sequence"] == 0
                    && head["hash"] == old["databaseHash"]
                    && head["stateHash"] == old["stateHash"]
                    && head["schemaHash"] == old["schemaHash"]
                    && head["schemaHash"] == installation["postSchemaHash"]
                    && instance["preSchemaHash"] == installation["postSchemaHash"]
                    && instance["preSchemaContractId"] == old["schemaContractId"]
                    && installation
                        .get("postPristineStateHash")
                        .is_none_or(|value| instance["prePristineStateHash"] == *value)
                    && instance["sourceRelativePath"]
                        == previous["reserveRequest"]["instances"][index]["sourceRelativePath"]
                    && old["globalSequence"] == 0
                    && old["globalHash"] == previous_finalization["globalHash"]
            })
}
pub(super) fn verify(current: &Value, archives: &[Value]) -> Result<(), String> {
    let fail = || format!("{PREFIX}previous_node_history_lineage_unproven");
    let mut remaining: Vec<_> = archives
        .iter()
        .filter(|value| value["transitionId"] != current["transitionId"])
        .collect();
    let mut endpoint = current;
    let mut visited = BTreeSet::new();
    loop {
        if !visited.insert(endpoint["transitionId"].clone().to_string()) {
            return Err(fail());
        }
        if endpoint["version"] == 1 {
            return if remaining.is_empty() {
                Ok(())
            } else {
                Err(fail())
            };
        }
        let matches: Vec<_> = remaining
            .iter()
            .enumerate()
            .filter(|(_, value)| linked(value, endpoint))
            .map(|(index, _)| index)
            .collect();
        if matches.len() != 1 {
            return Err(fail());
        }
        endpoint = remaining.remove(matches[0]);
    }
}
