//! Explicit local maintenance. Restore never overwrites state; GC quarantines.
use hepta_codex_protocol::Sha256Digest;
use hepta_paper_service::maintenance::{
    LocalGcPlanV1, LocalMaintenanceSessionV1, restore_local_backup_v1,
    verify_local_backup_recovery_v1, verify_local_backup_v1,
};
use std::{collections::BTreeSet, env, io::Read, os::unix::fs::OpenOptionsExt, path::Path};

fn read<T: serde::de::DeserializeOwned>(path: &str) -> Result<T, Box<dyn std::error::Error>> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags((nix::fcntl::OFlag::O_NOFOLLOW | nix::fcntl::OFlag::O_NONBLOCK).bits())
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err("expected regular request".into());
    }
    let mut data = Vec::new();
    file.take(1024 * 1024 + 1).read_to_end(&mut data)?;
    if data.len() > 1024 * 1024 {
        return Err("request bound".into());
    }
    Ok(serde_json::from_slice(&data)?)
}
fn print<T: serde::Serialize>(value: &T) -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", serde_json::to_string(value)?);
    Ok(())
}
fn execute() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.as_slice() {
        [cmd, state] if cmd == "inspect" => {
            print(&LocalMaintenanceSessionV1::acquire(Path::new(state))?.inspect()?)?
        }
        [cmd, state] if cmd == "quiesce" => {
            LocalMaintenanceSessionV1::acquire(Path::new(state))?.quiesce()?;
            print(&serde_json::json!({"version":1,"quiesced":true,"productionActivation":false}))?;
        }
        [cmd, state, dest] if cmd == "backup" => {
            print(&LocalMaintenanceSessionV1::acquire(Path::new(state))?.backup(Path::new(dest))?)?
        }
        [cmd, bundle, expected] if cmd == "verify" => print(&verify_local_backup_v1(
            Path::new(bundle),
            &expected.parse()?,
        )?)?,
        [cmd, state, definition, now] if cmd == "recovery-readiness" => print(
            &LocalMaintenanceSessionV1::acquire(Path::new(state))?
                .verify_recovery(&definition.parse()?, now.parse()?)?,
        )?,
        [cmd, bundle, manifest, definition, now] if cmd == "verify-recovery" => {
            print(&verify_local_backup_recovery_v1(
                Path::new(bundle),
                &manifest.parse()?,
                &definition.parse()?,
                now.parse()?,
            )?)?
        }
        [
            cmd,
            bundle,
            dest,
            stage,
            manifest,
            definition,
            revision,
            now,
        ] if cmd == "restore" => print(&restore_local_backup_v1(
            Path::new(bundle),
            Path::new(dest),
            Path::new(stage),
            &manifest.parse()?,
            &definition.parse()?,
            revision.parse()?,
            now.parse()?,
        )?)?,
        [cmd, state, definition, revision, pins, quarantine] if cmd == "gc-plan" => {
            let pins: BTreeSet<Sha256Digest> = read(pins)?;
            let plan = LocalMaintenanceSessionV1::acquire(Path::new(state))?.plan_gc(
                &definition.parse()?,
                revision.parse()?,
                pins,
                Path::new(quarantine),
            )?;
            print(&serde_json::json!({"planHash":plan.plan_hash()?,"plan":plan}))?;
        }
        [cmd, state, plan, expected] if cmd == "gc-apply" => {
            let plan: LocalGcPlanV1 = read(plan)?;
            print(
                &LocalMaintenanceSessionV1::acquire(Path::new(state))?
                    .apply_gc(&plan, &expected.parse()?)?,
            )?;
        }
        [cmd, state, quarantine, expected] if cmd == "gc-resume" => print(
            &LocalMaintenanceSessionV1::acquire(Path::new(state))?
                .resume_gc(Path::new(quarantine), &expected.parse()?)?,
        )?,
        _ => return Err("unsupported maintenance command or arguments".into()),
    }
    Ok(())
}
fn main() {
    if execute().is_err() {
        eprintln!("local maintenance rejected; preserve private state and reconcile");
        std::process::exit(1);
    }
}
