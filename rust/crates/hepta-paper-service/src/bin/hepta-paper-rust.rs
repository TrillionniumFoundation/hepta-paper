//! Bounded JSON command interface for the durable Rust composition.
use hepta_paper_service::{
    LegacyNodeFreezeSubjectV1, ObjectStoreV1, ServiceRunV1,
    command_surface::synchronize_command_surface_v1,
    migrate_node_store_v1, native_implementation_hash_v1,
    release_trust_gate::build_release_trust_layer_gate_from_values_v1,
    repository_assets::{
        build_repository_asset_externalization_handoff_v1,
        inspect_repository_asset_externalization_v1,
    },
    retirement_reference::verify_retirement_reference_v1,
    run_service_v1, verify_legacy_node_freeze_v1,
};
use std::{
    env,
    fs::File,
    io::{self, BufRead, Read},
    path::PathBuf,
};

fn read_bounded(path: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("input exceeds 16MiB".into());
    }
    Ok(bytes)
}
fn main() {
    if let Err(error) = command() {
        eprintln!("hepta-paper-rust: {error}");
        std::process::exit(1);
    }
}
fn command() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("native-identity") if args.len() == 1 => {
            println!("{}", native_implementation_hash_v1()?);
        }
        Some("put") if args.len() == 3 => {
            let store = ObjectStoreV1::open(&PathBuf::from(&args[1]))?;
            println!("{}", store.put(&read_bounded(&args[2])?)?);
        }
        Some("run") if args.len() == 2 => {
            let config: ServiceRunV1 = serde_json::from_slice(&read_bounded(&args[1])?)?;
            println!("{}", serde_json::to_string(&run_service_v1(config)?)?);
        }
        Some("serve") if args.len() == 1 => {
            // One closed JSON request per line; EOF performs orderly shutdown.
            let mut stdin = io::stdin().lock();
            loop {
                let mut line = Vec::new();
                let count = (&mut stdin)
                    .take(16 * 1024 * 1024 + 1)
                    .read_until(b'\n', &mut line)?;
                if count == 0 {
                    break;
                }
                if line.len() > 16 * 1024 * 1024 {
                    return Err("request exceeds 16MiB".into());
                }
                let config: ServiceRunV1 = serde_json::from_slice(&line)?;
                println!("{}", serde_json::to_string(&run_service_v1(config)?)?);
            }
        }
        Some("verify-legacy-freeze") if args.len() == 5 => {
            let receipt = verify_legacy_node_freeze_v1(
                PathBuf::from(&args[1]),
                LegacyNodeFreezeSubjectV1 {
                    repository: args[2].clone(),
                    commit: args[3].clone(),
                    tree: args[4].clone(),
                },
            )?;
            println!("{}", serde_json::to_string(receipt.receipt())?);
        }
        Some("inspect-db") if args.len() == 2 => {
            let store = hepta_readonly_store::ReadOnlyStoreV1::open(PathBuf::from(&args[1]))?;
            println!(
                "{}",
                serde_json::to_string(&store.node_logical_snapshot()?)?
            );
        }
        Some("store-migrate") if (args.len() == 2 || args.len() == 3) => {
            let target = args.get(2).map(|value| value.parse::<u32>()).transpose()?;
            println!(
                "{}",
                serde_json::to_string(&migrate_node_store_v1(&PathBuf::from(&args[1]), target,)?)?
            );
        }
        Some("repository-assets") if args.len() == 3 || args.len() == 4 => {
            let root = PathBuf::from(&args[1]);
            let manifest: serde_json::Value = serde_json::from_slice(&read_bounded(&args[2])?)?;
            let value = if args.get(3).map(String::as_str) == Some("--handoff") {
                build_repository_asset_externalization_handoff_v1(&root, &manifest)?
            } else if args.len() == 3 {
                inspect_repository_asset_externalization_v1(&root, &manifest)?
            } else {
                return Err("repository-assets accepts only --handoff".into());
            };
            println!("{}", serde_json::to_string(&value)?);
        }
        Some("command-surface") if args.len() == 2 || args.len() == 3 => {
            let write = args.get(2).map(String::as_str) == Some("--write-package");
            if args.len() == 3 && !write {
                return Err("command-surface accepts only --write-package".into());
            }
            println!(
                "{}",
                serde_json::to_string(&synchronize_command_surface_v1(
                    &PathBuf::from(&args[1]),
                    write
                )?)?
            );
        }
        Some("retirement-reference") if args.len() == 2 => {
            let report = verify_retirement_reference_v1(&PathBuf::from(&args[1]))?;
            let blocked = report["status"] == "retirement_reference_blocked";
            println!("{}", serde_json::to_string(&report)?);
            if blocked {
                return Err("retirement reference verification blocked".into());
            }
        }
        Some("release-trust-gate") if args.len() == 2 => {
            let input: serde_json::Value = serde_json::from_slice(&read_bounded(&args[1])?)?;
            println!(
                "{}",
                serde_json::to_string(&build_release_trust_layer_gate_from_values_v1(&input)?)?
            );
        }
        _ => {
            return Err(concat!(
                "usage: hepta-paper-rust native-identity | put STATE FILE | ",
                "run CONFIG | serve | inspect-db IMMUTABLE_DB | ",
                "verify-legacy-freeze IMMUTABLE_DB REPOSITORY COMMIT TREE | ",
                "store-migrate NODE_DB [TARGET_VERSION] | ",
                "repository-assets ROOT MANIFEST [--handoff]",
                " | command-surface ROOT [--write-package]",
                " | retirement-reference ROOT",
                " | release-trust-gate REQUEST"
            )
            .into());
        }
    }
    Ok(())
}
