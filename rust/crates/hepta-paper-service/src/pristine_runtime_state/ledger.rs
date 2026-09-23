use super::query::{canonical_timestamp, fail, field_number, null_field, rows, string, timestamp};
use crate::online_runtime_activation::ordered_json::Json;
use crate::sqlite_mutation_coordinator::{Result, hash, keys, sha};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};
const BACKUP: &[&str] = &[
    "version",
    "kind",
    "status",
    "sourcePath",
    "backupPath",
    "backupSha256",
    "bytes",
    "createdAt",
];
const V2: &[&str] = &[
    "backupLedgerReceiptId",
    "backupLedgerReceiptSha256",
    "backupPath",
    "backupSha256",
    "foreignKeyViolationCount",
    "hashMatches",
    "kind",
    "performedAt",
    "productionStoreMutated",
    "quickCheck",
    "status",
    "version",
];
const V3_ORDER: &[&str] = &[
    "version",
    "kind",
    "receiptRole",
    "status",
    "backupPath",
    "backupSha256",
    "backupLedgerReceiptSha256",
    "backupLedgerReceiptId",
    "hashMatches",
    "quickCheck",
    "foreignKeyViolationCount",
    "performedAt",
    "liveDatabaseHashMethod",
    "liveDatabaseSha256Before",
    "restoreDrillBusinessWritePerformed",
    "restoreDrillAdministrativeWritePerformed",
    "concurrentBusinessStateChangesAttested",
    "writerQuiescenceAttested",
    "businessProjectionComparisonPerformed",
];
fn normalize(path: &str) -> PathBuf {
    let mut result = PathBuf::new();
    for part in Path::new(path).components() {
        match part {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            p => result.push(p.as_os_str()),
        }
    }
    result
}
fn backup(v: &Value) -> bool {
    let source = v["sourcePath"].as_str().unwrap_or("");
    let target = v["backupPath"].as_str().unwrap_or("");
    let s = normalize(source);
    let t = normalize(target);
    keys(v, BACKUP)
        && v["version"].as_f64() == Some(1.)
        && v["kind"] == "HeptaStoreBackupReceipt"
        && v["status"] == "hepta_store_backup_recorded"
        && Path::new(source).is_absolute()
        && Path::new(target).is_absolute()
        && s.file_name().is_some_and(|n| n == "hepta-paper.sqlite")
        && s.parent()
            .is_some_and(|p| t.parent() == Some(p.join("backups").as_path()))
        && t.file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.ends_with(".sqlite"))
        && sha(&v["backupSha256"])
        && v["bytes"]
            .as_f64()
            .is_some_and(|n| n > 0. && n.fract() == 0. && n <= 9_007_199_254_740_991.)
        && timestamp(&v["createdAt"]).is_some()
}
fn restore(v: &Value, raw: &str) -> bool {
    let passed = v["hashMatches"] == true
        && v["quickCheck"] == "ok"
        && v["foreignKeyViolationCount"].as_f64() == Some(0.);
    let common = v["kind"] == "HeptaStoreRestoreDrillReceipt"
        && v["backupPath"].as_str().is_some_and(|s| !s.is_empty())
        && sha(&v["backupSha256"])
        && sha(&v["backupLedgerReceiptSha256"])
        && v["backupLedgerReceiptId"]
            == format!(
                "store-admin:{}",
                v["backupLedgerReceiptSha256"].as_str().unwrap_or("")
            )
        && canonical_timestamp(&v["performedAt"]).is_some()
        && [
            "hepta_store_restore_drill_passed",
            "hepta_store_restore_drill_blocked",
        ]
        .iter()
        .any(|s| v["status"] == *s)
        && (v["status"] != "hepta_store_restore_drill_passed" || passed)
        && v["hashMatches"].is_boolean()
        && v["quickCheck"].as_str().is_some_and(|s| !s.is_empty())
        && (null_field(v, "foreignKeyViolationCount")
            || v["foreignKeyViolationCount"]
                .as_f64()
                .is_some_and(|n| n >= 0. && n.fract() == 0. && n <= 9_007_199_254_740_991.));
    if !common {
        return false;
    }
    if v["version"].as_f64() == Some(2.) {
        return keys(v, V2) && v["productionStoreMutated"] == false;
    }
    if v["version"].as_f64() != Some(3.)
        || !keys(v, V3_ORDER)
        || v["receiptRole"] != "administrative_ledger_subject"
        || v["liveDatabaseHashMethod"] != "sqlite_online_backup_sha256_v1"
        || !sha(&v["liveDatabaseSha256Before"])
        || v["restoreDrillAdministrativeWritePerformed"] != true
        || [
            "restoreDrillBusinessWritePerformed",
            "concurrentBusinessStateChangesAttested",
            "writerQuiescenceAttested",
            "businessProjectionComparisonPerformed",
        ]
        .iter()
        .any(|k| v[*k] != false)
        || (v["status"] == "hepta_store_restore_drill_blocked" && passed)
    {
        return false;
    }
    let Ok(original) = serde_json::from_str::<Json>(raw) else {
        return false;
    };
    let rebuilt = Json::Object(
        V3_ORDER
            .iter()
            .map(|k| ((*k).to_owned(), Json::Scalar(v[*k].clone())))
            .collect(),
    );
    original.stringify().ok() == rebuilt.stringify().ok()
}
pub(super) fn inspect(db: &Connection) -> Result<()> {
    let policy = json!({"version":1,"policyId":"store-administrator","writerId":"hepta-store-administrator","writerKind":"native-store-administrator","assurance":"in_process_registered_administrator","allowedKinds":["HeptaStoreBackupReceipt","HeptaStoreRestoreDrillReceipt"],"allowedStreams":["store-admin"]});
    let policy_hash = hash("ReceiptIssuerPolicy", &policy)?;
    let entries = rows(
        db,
        "SELECT * FROM receipt_ledger ORDER BY receipt_id",
        &[],
        10000,
        4 * 1024 * 1024,
    )?;
    let mut backups = BTreeMap::new();
    let mut restores = Vec::new();
    for row in entries {
        let raw = string(&row["receipt_json"]).map_err(|_| fail("receipt_ledger_json_invalid"))?;
        let receipt = crate::sqlite_mutation_coordinator::authority::files::parse(
            raw.as_bytes(),
            "autonomous_research_pristine_state_receipt_ledger_json_invalid",
        )?;
        let backup = backup(&receipt);
        let restore = restore(&receipt, raw);
        let kind = receipt["kind"].as_str().unwrap_or("Receipt");
        // All accepted exact schemas exclude override hash fields, so the actual
        // selector's fallback is the only possible valid receipt hash branch.
        let receipt_hash = hash(kind, &receipt)?;
        let evidence = if backup {
            "backup"
        } else if restore {
            "restore_drill"
        } else {
            ""
        };
        let instant = if backup {
            &receipt["createdAt"]
        } else {
            &receipt["performedAt"]
        };
        if evidence.is_empty()
            || row["receipt_sha256"] != receipt_hash
            || row["receipt_id"] != format!("store-admin:{receipt_hash}")
            || row["stream"] != "store-admin"
            || row["kind"] != receipt["kind"]
            || row["status"] != receipt["status"]
            || !null_field(&row, "paper_id")
            || row["environment"] != "administrative"
            || row["evidence_class"] != evidence
            || !null_field(&row, "release_commit")
            || field_number(&row, "writer_trusted") != Some(1.)
            || row["issuer_policy_id"] != "store-administrator"
            || row["issuer_policy_hash"] != policy_hash
            || row["writer_id"] != policy["writerId"]
            || row["writer_kind"] != policy["writerKind"]
            || row["issuer_assurance"] != policy["assurance"]
            || timestamp(&row["created_at"])
                .zip(timestamp(instant))
                .is_none_or(|(row, receipt)| row < receipt)
        {
            return Err(fail("receipt_ledger_semantics_invalid"));
        }
        if backup {
            backups.insert(receipt_hash, receipt);
        } else {
            restores.push(receipt);
        }
    }
    for restore in restores {
        let Some(backup) = restore["backupLedgerReceiptSha256"]
            .as_str()
            .and_then(|hash| backups.get(hash))
        else {
            return Err(fail("receipt_ledger_causal_binding_invalid"));
        };
        if restore["backupPath"] != backup["backupPath"]
            || restore["backupSha256"] != backup["backupSha256"]
            || timestamp(&restore["performedAt"])
                .zip(timestamp(&backup["createdAt"]))
                .is_none_or(|(r, b)| r < b)
        {
            return Err(fail("receipt_ledger_causal_binding_invalid"));
        }
    }
    Ok(())
}
