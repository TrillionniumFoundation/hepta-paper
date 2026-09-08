//! Bounded JSON command interface for the durable Rust composition.
use hepta_paper_service::{
    LegacyNodeFreezeSubjectV1, ObjectStoreV1, ServiceRunV1, native_implementation_hash_v1,
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
        _ => {
            return Err(concat!(
                "usage: hepta-paper-rust native-identity | put STATE FILE | ",
                "run CONFIG | serve | inspect-db IMMUTABLE_DB | ",
                "verify-legacy-freeze IMMUTABLE_DB REPOSITORY COMMIT TREE"
            )
            .into());
        }
    }
    Ok(())
}
