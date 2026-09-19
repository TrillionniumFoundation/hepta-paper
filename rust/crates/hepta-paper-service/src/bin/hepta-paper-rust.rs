//! Bounded JSON command interface for the durable Rust composition.
use hepta_paper_service::{
    LegacyDeletionDrillAttestationRequestV1, LegacyNodeFreezeSubjectV1, ObjectStoreV1,
    ServiceRunV1,
    architecture_conformance::{
        ArchitectureConformanceModeV1, inspect_architecture_conformance_v1,
    },
    command_surface::synchronize_command_surface_v1,
    inspect_legacy_deletion_drill_attest_v1, migrate_node_store_v1, native_implementation_hash_v1,
    release_attest::{ReleaseAttestationRequestV1, inspect_release_attestation_v1},
    release_state::inspect_release_state_v1,
    release_trust_gate::build_release_trust_layer_gate_from_values_v1,
    repository_assets::{
        build_repository_asset_externalization_handoff_v1,
        inspect_repository_asset_externalization_v1,
    },
    retirement_matrix::inspect_retirement_matrix_v1,
    retirement_reference::verify_retirement_reference_v1,
    retirement_status::inspect_retirement_status_v1,
    run_service_v1,
    runtime_source_cas::inspect_runtime_source_cas_v1,
    verify_legacy_node_freeze_v1,
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
        Some("verify-architecture") if args.len() >= 2 => {
            let root = PathBuf::from(&args[1]);
            let mut json_output = false;
            for flag in args.iter().skip(2) {
                match flag.as_str() {
                    "--json" | "--strict" => {
                        if flag == "--json" {
                            json_output = true;
                        }
                    }
                    _ => return Err("verify-architecture accepts only --json or --strict".into()),
                }
            }
            let report =
                inspect_architecture_conformance_v1(&root, ArchitectureConformanceModeV1::Strict)?;
            if json_output {
                println!("{}", serde_json::to_string(&report)?);
            } else {
                println!(
                    "{}",
                    report["status"]
                        .as_str()
                        .unwrap_or("architecture_conformance_blocked")
                );
            }
            if report["ready"] != true {
                return Err("architecture conformance verification blocked".into());
            }
        }
        Some("retirement-reference") if args.len() == 2 => {
            let report = verify_retirement_reference_v1(&PathBuf::from(&args[1]))?;
            let blocked = report["status"] == "retirement_reference_blocked";
            println!("{}", serde_json::to_string(&report)?);
            if blocked {
                return Err("retirement reference verification blocked".into());
            }
        }
        Some("retirement-matrix") => {
            let mut workspace_root = None;
            let mut runtime_root = None;
            let mut index = 1;
            while index < args.len() {
                let target =
                    match args[index].as_str() {
                        "--workspace-root" => &mut workspace_root,
                        "--runtime-root" => &mut runtime_root,
                        _ => return Err(
                            "retirement-matrix accepts --workspace-root and --runtime-root only"
                                .into(),
                        ),
                    };
                if target.is_some() || index + 1 >= args.len() {
                    return Err("retirement-matrix arguments must be unique absolute paths".into());
                }
                let path = PathBuf::from(&args[index + 1]);
                if !path.is_absolute() {
                    return Err("retirement-matrix requires absolute root paths".into());
                }
                *target = Some(path);
                index += 2;
            }
            let workspace_root =
                workspace_root.ok_or("retirement-matrix requires --workspace-root")?;
            let runtime_root = runtime_root.ok_or("retirement-matrix requires --runtime-root")?;
            let report = inspect_retirement_matrix_v1(&workspace_root, &runtime_root)?;
            println!("{}", serde_json::to_string(&report)?);
            if report["status"] == "retirement_matrix_partial_blocked" {
                return Err("retirement matrix is locally inspectable but blocked by source or owner evidence".into());
            }
        }
        Some("retirement-drill-attest") if args.len() == 2 => {
            let request: LegacyDeletionDrillAttestationRequestV1 =
                serde_json::from_slice(&read_bounded(&args[1])?)?;
            let report = inspect_legacy_deletion_drill_attest_v1(request)?;
            let blocked = !report.technical_release_ready || !report.physical_deletion_allowed;
            println!("{}", serde_json::to_string(&report)?);
            if blocked {
                return Err(
                    "retirement drill attestation blocked pending external evidence".into(),
                );
            }
        }
        Some("release-trust-gate") if args.len() == 2 => {
            let input: serde_json::Value = serde_json::from_slice(&read_bounded(&args[1])?)?;
            println!(
                "{}",
                serde_json::to_string(&build_release_trust_layer_gate_from_values_v1(&input)?)?
            );
        }
        Some("release-state") if args.len() == 2 => {
            let input: serde_json::Value = serde_json::from_slice(&read_bounded(&args[1])?)?;
            println!(
                "{}",
                serde_json::to_string(&inspect_release_state_v1(&input)?)?
            );
        }
        Some("release-attest") if args.len() == 2 => {
            let request: ReleaseAttestationRequestV1 =
                serde_json::from_slice(&read_bounded(&args[1])?)?;
            let report = inspect_release_attestation_v1(request)?;
            println!("{}", serde_json::to_string(&report)?);
            if report["releaseEvidenceReady"] != true {
                return Err("release attestation blocked pending external evidence".into());
            }
        }
        Some("retirement-status") if args.len() == 2 => {
            let input: serde_json::Value = serde_json::from_slice(&read_bounded(&args[1])?)?;
            println!(
                "{}",
                serde_json::to_string(&inspect_retirement_status_v1(&input)?)?
            );
        }
        Some("runtime-r-source-cas") if args.len() == 2 => {
            let report = inspect_runtime_source_cas_v1(&PathBuf::from(&args[1]));
            let blocked = report.get("ready") != Some(&serde_json::Value::Bool(true));
            println!("{}", serde_json::to_string(&report)?);
            if blocked {
                return Err("R runtime source CAS verification blocked".into());
            }
        }
        _ => {
            return Err(concat!(
                "usage: hepta-paper-rust native-identity | put STATE FILE | ",
                "run CONFIG | serve | inspect-db IMMUTABLE_DB | ",
                "verify-legacy-freeze IMMUTABLE_DB REPOSITORY COMMIT TREE | ",
                "store-migrate NODE_DB [TARGET_VERSION] | ",
                "repository-assets ROOT MANIFEST [--handoff]",
                " | command-surface ROOT [--write-package]",
                " | verify-architecture ROOT [--json] [--strict]",
                " | retirement-reference ROOT",
                " | retirement-matrix --workspace-root ABSOLUTE_PATH --runtime-root ABSOLUTE_PATH",
                " | retirement-drill-attest REQUEST",
                " | release-trust-gate REQUEST",
                " | release-state REQUEST",
                " | release-attest REQUEST",
                " | retirement-status REQUEST",
                " | runtime-r-source-cas REPOSITORY_ROOT"
            )
            .into());
        }
    }
    Ok(())
}
