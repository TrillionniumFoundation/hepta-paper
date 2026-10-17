//! Runnable disposable SQLite / Node / Rust single-writer drill.
use hepta_cutover::{DurableCutoverCoordinatorV1, DurableCutoverModeV1};
use rusqlite::Connection;
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, process::Command};

fn rust_rows(path: &PathBuf) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let database = Connection::open(path)?;
    let mut statement = database.prepare("SELECT id,value FROM records ORDER BY id")?;
    let records = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?, "value": row.get::<_, String>(1)?,
            }))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(serde_json::to_vec(&records)?)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("usage: local_cutover_drill /absolute/new/directory")?,
    );
    if !root.is_absolute() || root.exists() {
        return Err("drill directory must be absolute and absent".into());
    }
    fs::create_dir(&root)?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    let path = root.join("local-native.sqlite");
    let database = Connection::open(&path)?;
    database.execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY,value TEXT NOT NULL); INSERT INTO records VALUES(1,'node-era');")?;
    drop(database);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let mut coordinator = DurableCutoverCoordinatorV1::create(
        &path,
        "local-cutover-drill",
        "node",
        "rust",
        DurableCutoverModeV1::LocalDrill,
    )?;
    coordinator.quiesce(0)?;
    coordinator.backup_restore_drill(
        1,
        &root.join("backup.sqlite"),
        &root.join("restored.sqlite"),
    )?;
    let node = Command::new("node").args(["--input-type=module","-e",r#"
        import { DatabaseSync } from 'node:sqlite';
        const database = new DatabaseSync(process.env.HEPTA_CUTOVER_DRILL_DATABASE,{readOnly:true});
        process.stdout.write(JSON.stringify(database.prepare('SELECT id,value FROM records ORDER BY id').all()));
        database.close();
    "#]).env("HEPTA_CUTOVER_DRILL_DATABASE",&path).output()?;
    if !node.status.success() {
        return Err(format!(
            "Node query failed: {}",
            String::from_utf8_lossy(&node.stderr)
        )
        .into());
    }
    let comparison =
        coordinator.compare_shadow(2, "records-query", &node.stdout, &rust_rows(&path)?)?;
    if !comparison.equal {
        return Err("actual Node/Rust shadow mismatch".into());
    }
    let state = coordinator.start_local_canary(3, vec!["campaign-canary".into()])?;
    let lease = state.writer_fence().ok_or("Rust writer lease missing")?;
    coordinator.with_writer(&lease, "campaign-canary", || {
        let database = Connection::open(&path).map_err(|e| e.to_string())?;
        database
            .execute("INSERT INTO records VALUES(2,'rust-era-committed')", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    })?;
    drop(coordinator);
    let mut coordinator = DurableCutoverCoordinatorV1::open(&path)?;
    coordinator.promote_local(4)?;
    let final_state = coordinator.rollback_local(5)?;
    coordinator.verify_journal()?;
    let rows: serde_json::Value = serde_json::from_slice(&rust_rows(&path)?)?;
    if rows.as_array().map(Vec::len) != Some(2) {
        return Err("rollback lost committed data".into());
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "status":"local_cutover_drill_passed", "productionActivation":false,
            "legacySchemaTranslationVerified":false,"shadow":comparison,
            "state":final_state,"preservedRecords":rows,
        }))?
    );
    Ok(())
}
