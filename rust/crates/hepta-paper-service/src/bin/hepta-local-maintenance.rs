//! Byte-level local backup commands, never a writer/cutover or restore launcher.
use hepta_paper_service::maintenance::{LocalMaintenanceSessionV1, verify_local_backup_v1};
use std::{env, path::Path};

fn execute() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.as_slice() {
        [command, state] if command == "inspect" => {
            let session = LocalMaintenanceSessionV1::acquire(Path::new(state))?;
            println!("{}", serde_json::to_string(&session.inspect()?)?);
        }
        [command, state, destination] if command == "backup" => {
            let session = LocalMaintenanceSessionV1::acquire(Path::new(state))?;
            println!("{}", serde_json::to_string(&session.backup(Path::new(destination))?)?);
        }
        [command, bundle, expected] if command == "verify" => {
            println!("{}", serde_json::to_string(&verify_local_backup_v1(
                Path::new(bundle), &expected.parse()?,
            )?)?);
        }
        _ => return Err("usage: inspect STATE | backup STATE ABSENT_DESTINATION | verify BUNDLE EXPECTED_MANIFEST_HASH".into()),
    }
    Ok(())
}

fn main() {
    if execute().is_err() {
        eprintln!("local maintenance rejected; preserve private state and reconcile");
        std::process::exit(1);
    }
}
