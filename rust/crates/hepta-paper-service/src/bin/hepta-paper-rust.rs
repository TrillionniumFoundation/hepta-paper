//! Bounded JSON command interface for the durable Rust composition.
use hepta_paper_service::{
    LegacyDeletionDrillAttestationRequestV1, LegacyNodeFreezeSubjectV1, ObjectStoreV1,
    ServiceRunV1,
    advanced_numerical::{
        ADVANCED_NUMERICAL_MAX_INPUT_BYTES, execute_advanced_numerical_plugin_v1,
    },
    architecture_conformance::{
        ArchitectureConformanceModeV1, inspect_architecture_conformance_v1,
    },
    command_surface::{
        ci_command_matrix_json_v1, classify_npm_script_surface_json_v1, command_usage_json_v1,
        generated_npm_route_scripts_json_v1, synchronize_command_surface_json_v1,
    },
    inspect_legacy_deletion_drill_attest_v1, migrate_node_store_v1, native_implementation_hash_v1,
    release_attest::{ReleaseAttestationRequestV1, inspect_release_attestation_v1},
    release_state::inspect_release_state_v1,
    release_trust_gate::build_release_trust_layer_gate_from_values_v1,
    repository_assets::{
        build_repository_asset_externalization_handoff_v1,
        inspect_repository_asset_externalization_v1,
    },
    research_capability_matrix::build_research_capability_matrix_v2,
    retirement_matrix::inspect_retirement_matrix_v1,
    retirement_reference::verify_retirement_reference_v1,
    retirement_status::inspect_retirement_status_v1,
    run_service_v1,
    runtime_source_cas::{acquire_runtime_source_cas_from_seed_v1, inspect_runtime_source_cas_v1},
    state_recoverability::safety_inspection::{
        StateSafetyInspectionOptionsV1, inspect_autonomous_research_state_safety_v1,
    },
    store_status::inspect_store_status_v1,
    verify_legacy_node_freeze_v1,
};
use std::{
    collections::BTreeMap,
    env,
    fs::File,
    io::{self, BufRead, Read},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
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

fn current_unix_millis() -> Result<i64, Box<dyn std::error::Error>> {
    let millis = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    Ok(i64::try_from(millis).map_err(|_| "current clock exceeds signed millisecond range")?)
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
        Some("store-integrity") if args.len() == 2 => {
            let store = hepta_readonly_store::ReadOnlyStoreV1::open(PathBuf::from(&args[1]))?;
            let report = store.node_logical_integrity_report()?;
            println!("{}", serde_json::to_string(&report)?);
            if report.status != "sqlite_logical_integrity_verified" {
                return Err("sqlite logical integrity report blocked".into());
            }
        }
        Some("store-status") if args.len() == 2 || args.len() == 3 => {
            let runtime_root = args.get(2).map(PathBuf::from);
            let report =
                inspect_store_status_v1(&PathBuf::from(&args[1]), runtime_root.as_deref())?;
            println!("{}", serde_json::to_string(&report)?);
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
            let root = PathBuf::from(&args[1]);
            match args.get(2).map(String::as_str) {
                None => {
                    println!("{}", classify_npm_script_surface_json_v1(&root)?);
                }
                Some("--write-package") | Some("--check-package") => {
                    let write = args.get(2).map(String::as_str) == Some("--write-package");
                    let check = args.get(2).map(String::as_str) == Some("--check-package");
                    let output = synchronize_command_surface_json_v1(&root, write)?;
                    let blocked = serde_json::from_str::<serde_json::Value>(&output)?.get("ready")
                        != Some(&serde_json::Value::Bool(true));
                    println!("{output}");
                    if (write || check) && blocked {
                        return Err("command-surface package inspection blocked".into());
                    }
                }
                Some("--npm-aliases") => {
                    println!("{}", generated_npm_route_scripts_json_v1(&root)?);
                }
                Some("--ci-matrix") => {
                    println!("{}", ci_command_matrix_json_v1(&root)?);
                }
                Some("--help-artifact") => {
                    println!("{}", command_usage_json_v1(&root)?);
                }
                Some(_) => {
                    return Err(
                        "command-surface accepts --write-package, --check-package, --npm-aliases, --help-artifact, or --ci-matrix"
                            .into(),
                    );
                }
            }
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
        Some("advanced-numerical-plugin") if args.len() == 2 => {
            let mut bytes = Vec::new();
            File::open(&args[1])?
                .take(ADVANCED_NUMERICAL_MAX_INPUT_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() > ADVANCED_NUMERICAL_MAX_INPUT_BYTES {
                return Err("advanced numerical request exceeds 32KiB".into());
            }
            let request: serde_json::Value = serde_json::from_slice(&bytes)?;
            let result = execute_advanced_numerical_plugin_v1(&request)?;
            println!("{}", serde_json::to_string(&result)?);
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
        Some("runtime-r-source-cas") if args.len() >= 2 => {
            let repository_root = PathBuf::from(&args[1]);
            let mut action = "status";
            let mut seed = None;
            let mut action_seen = false;
            let mut seed_seen = false;
            let mut index = 2;
            while index < args.len() {
                match args[index].as_str() {
                    "--action" if index + 1 < args.len() && !action_seen => {
                        action = args[index + 1].as_str();
                        action_seen = true;
                        index += 2;
                    }
                    "--seed" if index + 1 < args.len() && !seed_seen => {
                        seed = Some(PathBuf::from(&args[index + 1]));
                        seed_seen = true;
                        index += 2;
                    }
                    _ => {
                        return Err(
                            "runtime-r-source-cas accepts ROOT [--action status|acquire] [--seed DIRECTORY] only".into(),
                        );
                    }
                }
            }
            let report = match action {
                "status" => inspect_runtime_source_cas_v1(&repository_root),
                "acquire" => {
                    let seed = seed.ok_or("runtime-r-source-cas acquire requires --seed")?;
                    acquire_runtime_source_cas_from_seed_v1(&repository_root, &seed)?
                }
                _ => return Err("runtime-r-source-cas action must be status or acquire".into()),
            };
            let blocked = report.get("ready") != Some(&serde_json::Value::Bool(true));
            println!("{}", serde_json::to_string(&report)?);
            if blocked {
                return Err("R runtime source CAS verification blocked".into());
            }
        }
        Some("research-readiness") => {
            let mut workspace_root = None;
            let mut runtime_root = None;
            let mut working_directory = env::current_dir()?;
            let mut now = current_unix_millis()?;
            let mut require_ready = false;
            let mut help = false;
            let mut working_directory_seen = false;
            let mut now_seen = false;
            let mut index = 1;
            while index < args.len() {
                match args[index].as_str() {
                    "--workspace-root" if index + 1 < args.len() && workspace_root.is_none() => {
                        workspace_root = Some(PathBuf::from(&args[index + 1]));
                        index += 2;
                    }
                    "--runtime-root" if index + 1 < args.len() && runtime_root.is_none() => {
                        runtime_root = Some(PathBuf::from(&args[index + 1]));
                        index += 2;
                    }
                    "--working-directory" if index + 1 < args.len() && !working_directory_seen => {
                        working_directory = PathBuf::from(&args[index + 1]);
                        working_directory_seen = true;
                        index += 2;
                    }
                    "--now" if index + 1 < args.len() && !now_seen => {
                        now = args[index + 1]
                            .parse::<i64>()
                            .map_err(|_| "research-readiness --now requires signed milliseconds")?;
                        now_seen = true;
                        index += 2;
                    }
                    "--require-ready" if !require_ready => {
                        require_ready = true;
                        index += 1;
                    }
                    "--help" if !help => {
                        help = true;
                        index += 1;
                    }
                    _ => {
                        return Err("research-readiness accepts --workspace-root ABSOLUTE_PATH --runtime-root ABSOLUTE_PATH [--working-directory ABSOLUTE_PATH] [--now UNIX_MILLIS] [--require-ready] [--help] only".into());
                    }
                }
            }
            if help {
                println!(
                    "{}",
                    serde_json::json!({
                        "version": 1,
                        "kind": "ResearchReadinessUsage",
                        "usage": "research-readiness --workspace-root ABSOLUTE_PATH --runtime-root ABSOLUTE_PATH [--working-directory ABSOLUTE_PATH] [--now UNIX_MILLIS] [--require-ready]",
                        "mutation": "read-only passive state-safety observation; no authority RPC or canonical state write",
                        "localObservationEffects": "reads actual state-database, backup, cache, authority-configuration and writer-source inputs when configured",
                        "externalAction": "none",
                        "environmentKeys": [
                            "HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG",
                            "HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG",
                            "HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG"
                        ]
                    })
                );
                return Ok(());
            }
            let workspace_root = workspace_root
                .ok_or("research-readiness requires --workspace-root ABSOLUTE_PATH")?;
            let runtime_root =
                runtime_root.ok_or("research-readiness requires --runtime-root ABSOLUTE_PATH")?;
            for (name, path) in [
                ("workspace-root", &workspace_root),
                ("runtime-root", &runtime_root),
                ("working-directory", &working_directory),
            ] {
                if !path.is_absolute() {
                    return Err(format!(
                        "research-readiness requires {name} to be an absolute path"
                    )
                    .into());
                }
            }
            let environment = [
                "HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG",
                "HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG",
                "HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG",
            ]
            .into_iter()
            .filter_map(|name| env::var(name).ok().map(|value| (name.into(), value)))
            .collect::<BTreeMap<_, _>>();
            let report =
                inspect_autonomous_research_state_safety_v1(&StateSafetyInspectionOptionsV1 {
                    workspace_root,
                    runtime_root,
                    working_directory,
                    now,
                    environment,
                })?;
            let ready = report["ready"] == serde_json::Value::Bool(true);
            println!("{}", serde_json::to_string(&report)?);
            if require_ready && !ready {
                return Err("research readiness state-safety inspection is blocked".into());
            }
        }
        Some("research-capability-matrix") => {
            let mut request = None;
            let mut require_production_ready = false;
            let mut index = 1;
            while index < args.len() {
                match args[index].as_str() {
                    "--request" if index + 1 < args.len() && request.is_none() => {
                        let path = PathBuf::from(&args[index + 1]);
                        if !path.is_absolute() {
                            return Err(
                                "research-capability-matrix requires an absolute request path"
                                    .into(),
                            );
                        }
                        request = Some(path);
                        index += 2;
                    }
                    "--require-production-ready" if !require_production_ready => {
                        require_production_ready = true;
                        index += 1;
                    }
                    _ => {
                        return Err(
                            "research-capability-matrix accepts --request ABSOLUTE_JSON_PATH [--require-production-ready] only"
                                .into(),
                        );
                    }
                }
            }
            let request = request
                .ok_or("research-capability-matrix requires --request ABSOLUTE_JSON_PATH")?;
            let readiness: serde_json::Value = serde_json::from_slice(&read_bounded(
                request
                    .to_str()
                    .ok_or("research-capability-matrix request path must be valid UTF-8")?,
            )?)?;
            let report = build_research_capability_matrix_v2(&readiness)?;
            let production_ready = report["fullyAutonomousProductionReady"] == true;
            println!("{}", serde_json::to_string(&report)?);
            if require_production_ready && !production_ready {
                return Err(
                    "research capability matrix is descriptive and not production ready".into(),
                );
            }
        }
        _ => {
            return Err(concat!(
                "usage: hepta-paper-rust native-identity | put STATE FILE | ",
                "run CONFIG | serve | inspect-db IMMUTABLE_DB | ",
                "store-integrity IMMUTABLE_DB | ",
                "store-status IMMUTABLE_DB [RUNTIME_ROOT] | ",
                "verify-legacy-freeze IMMUTABLE_DB REPOSITORY COMMIT TREE | ",
                "store-migrate NODE_DB [TARGET_VERSION] | ",
                "repository-assets ROOT MANIFEST [--handoff]",
                " | command-surface ROOT [--write-package|--check-package|--npm-aliases|--help-artifact|--ci-matrix]",
                " | verify-architecture ROOT [--json] [--strict]",
                " | advanced-numerical-plugin REQUEST",
                " | retirement-reference ROOT",
                " | retirement-matrix --workspace-root ABSOLUTE_PATH --runtime-root ABSOLUTE_PATH",
                " | retirement-drill-attest REQUEST",
                " | release-trust-gate REQUEST",
                " | release-state REQUEST",
                " | release-attest REQUEST",
                " | retirement-status REQUEST",
                " | runtime-r-source-cas REPOSITORY_ROOT [--action status|acquire] [--seed DIRECTORY]",
                " | research-readiness --workspace-root ABSOLUTE_PATH --runtime-root ABSOLUTE_PATH [--working-directory ABSOLUTE_PATH] [--now UNIX_MILLIS] [--require-ready]",
                " | research-capability-matrix --request ABSOLUTE_JSON_PATH [--require-production-ready]"
            )
            .into());
        }
    }
    Ok(())
}
