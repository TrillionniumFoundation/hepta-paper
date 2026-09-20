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
    automation_status::automation_status_help_json_v1,
    command_surface::{
        ci_command_matrix_json_v1, classify_npm_script_surface_json_v1, command_usage_json_v1,
        generated_npm_route_scripts_json_v1, synchronize_command_surface_json_v1,
    },
    external_authority_intake::{
        external_authority_intake_help_json_v1, inspect_external_authority_intake_v1,
        unix_millis_to_iso_v1,
    },
    generic_domain_capability_evidence::{
        converge_generic_domain_capability_evidence_v1,
        generic_domain_capability_evidence_help_json_v1,
        inspect_generic_domain_capability_evidence_v1,
    },
    inspect_legacy_deletion_drill_attest_v1,
    local_golden_dataset::{
        execute_local_golden_dataset_provisioning_v1, inspect_local_golden_dataset_provisioning_v1,
        local_golden_dataset_provisioning_usage, parse_local_golden_dataset_provisioning_arguments,
    },
    migrate_node_store_v1, native_implementation_hash_v1,
    personal_self_hosted_gpu::{
        blocked_personal_gpu_receipt_v1, verify_personal_gpu_operational_receipt,
    },
    personal_self_hosted_readiness::{
        PersonalSelfHostedReadinessOptions, canonical_observed_at_v1,
        inspect_personal_self_hosted_readiness_v1, personal_self_hosted_readiness_help_json_v1,
    },
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
    fs::{self, File},
    io::{self, BufRead, Read},
    os::unix::{fs::MetadataExt, fs::OpenOptionsExt},
    path::{Component, Path, PathBuf},
    process::Command,
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

fn safe_personal_gpu_token(value: &str) -> String {
    let mut token = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | ':' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    token.truncate(180);
    if token.is_empty() {
        "error".to_owned()
    } else {
        token
    }
}

fn workspace_commit_for_personal_gpu(root: &Path) -> Option<String> {
    let output = Command::new("git")
        .current_dir(root)
        .args(["rev-parse", "HEAD"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let commit = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    if commit.len() == 40
        && commit
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        Some(commit)
    } else {
        None
    }
}

fn lexical_absolute_path(path: PathBuf) -> PathBuf {
    let candidate = if path.is_absolute() {
        path
    } else {
        env::current_dir().map_or(path.clone(), |cwd| cwd.join(path))
    };
    let mut normalized = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::RootDir => normalized.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
            Component::Prefix(_) => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn personal_gpu_check_fallback(
    workspace_root: &Path,
    failure: &str,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let created_at = current_unix_millis()?;
    let failure_token = format!(
        "personal_gpu_gate_failed:{}",
        safe_personal_gpu_token(failure)
    );
    blocked_personal_gpu_receipt_v1(
        created_at,
        workspace_commit_for_personal_gpu(workspace_root).as_deref(),
        &failure_token,
    )
}

fn read_personal_gpu_receipt(path: &Path) -> Result<Vec<u8>, ()> {
    const MAX_RECEIPT_BYTES: u64 = 64 * 1024 * 1024;
    let parent = path.parent().ok_or(())?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|_| ())?;
    if !parent_metadata.is_dir()
        || parent_metadata.file_type().is_symlink()
        || fs::canonicalize(parent).map_err(|_| ())? != parent
        || fs::canonicalize(path).map_err(|_| ())? != path
    {
        return Err(());
    }
    let before = fs::symlink_metadata(path).map_err(|_| ())?;
    if !before.is_file()
        || before.file_type().is_symlink()
        || before.nlink() != 1
        || before.len() > MAX_RECEIPT_BYTES
    {
        return Err(());
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| ())?;
    let opened = file.metadata().map_err(|_| ())?;
    if opened.dev() != before.dev()
        || opened.ino() != before.ino()
        || opened.mode() != before.mode()
        || opened.len() != before.len()
        || opened.mtime_nsec() != before.mtime_nsec()
        || opened.nlink() != before.nlink()
    {
        return Err(());
    }
    let mut bytes = Vec::new();
    file.take(MAX_RECEIPT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > MAX_RECEIPT_BYTES {
        return Err(());
    }
    let after = fs::symlink_metadata(path).map_err(|_| ())?;
    if after.dev() != before.dev()
        || after.ino() != before.ino()
        || after.mode() != before.mode()
        || after.len() != before.len()
        || after.mtime_nsec() != before.mtime_nsec()
        || after.nlink() != before.nlink()
    {
        return Err(());
    }
    Ok(bytes)
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
        Some("automation-status") if args.len() >= 2 => {
            let mut help = false;
            let mut json = false;
            for flag in args.iter().skip(1) {
                match flag.as_str() {
                    "--help" if !help => help = true,
                    "--json" if !json => json = true,
                    _ => {
                        return Err(
                            "automation-status currently supports only --help [--json] (bounded help metadata)"
                                .into(),
                        );
                    }
                }
            }
            if !help {
                return Err(
                    "automation-status currently supports only --help [--json] (bounded help metadata)"
                        .into(),
                );
            }
            // `--json` is accepted by the incumbent parser but does not change
            // its help payload. This route intentionally exposes no readiness
            // observers, handoff, provider probe, or authority action.
            let _ = json;
            println!("{}", automation_status_help_json_v1());
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
        Some("external-authority-intake") => {
            let mut author_config = None;
            let mut author_hash = None;
            let mut release_config = None;
            let mut release_hash = None;
            let mut require_ready = false;
            let mut help = false;
            let mut index = 1;
            while index < args.len() {
                match args[index].as_str() {
                    "--author-config" if index + 1 < args.len() && author_config.is_none() => {
                        author_config = Some(PathBuf::from(&args[index + 1]));
                        index += 2;
                    }
                    "--author-config-hash" if index + 1 < args.len() && author_hash.is_none() => {
                        author_hash = Some(args[index + 1].clone());
                        index += 2;
                    }
                    "--release-attestor-config"
                        if index + 1 < args.len() && release_config.is_none() =>
                    {
                        release_config = Some(PathBuf::from(&args[index + 1]));
                        index += 2;
                    }
                    "--release-attestor-config-hash"
                        if index + 1 < args.len() && release_hash.is_none() =>
                    {
                        release_hash = Some(args[index + 1].clone());
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
                        return Err("external-authority-intake accepts --author-config PATH --author-config-hash sha256:... --release-attestor-config PATH --release-attestor-config-hash sha256:... [--require-ready] [--help] only".into());
                    }
                }
            }
            if help {
                println!(
                    "{}",
                    serde_json::to_string(&external_authority_intake_help_json_v1())?
                );
                return Ok(());
            }
            let author_config = author_config.or_else(|| {
                env::var("HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG")
                    .ok()
                    .map(PathBuf::from)
            });
            let author_hash =
                author_hash.or_else(|| env::var("HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH").ok());
            let release_config = release_config.or_else(|| {
                env::var("HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG")
                    .ok()
                    .map(PathBuf::from)
            });
            let release_hash = release_hash
                .or_else(|| env::var("HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH").ok());
            let observed_at = unix_millis_to_iso_v1(current_unix_millis()?)?;
            let report = inspect_external_authority_intake_v1(
                author_config.as_deref(),
                author_hash.as_deref(),
                release_config.as_deref(),
                release_hash.as_deref(),
                &observed_at,
            )?;
            let ready = report["ready"] == true;
            println!("{}", serde_json::to_string(&report)?);
            if require_ready && !ready {
                std::process::exit(2);
            }
        }
        Some("generic-domain-capability-evidence") => {
            let mut action = "status".to_owned();
            let mut action_seen = false;
            let mut runtime_root = None;
            let mut help = false;
            let mut index = 1;
            while index < args.len() {
                match args[index].as_str() {
                    "--action" if index + 1 < args.len() && !action_seen => {
                        action = args[index + 1].clone();
                        action_seen = true;
                        index += 2;
                    }
                    "--runtime-root" if index + 1 < args.len() && runtime_root.is_none() => {
                        let path = PathBuf::from(&args[index + 1]);
                        if !path.is_absolute() {
                            return Err(
                                "generic-domain-capability-evidence requires an absolute runtime root"
                                    .into(),
                            );
                        }
                        runtime_root = Some(path);
                        index += 2;
                    }
                    "--help" if !help => {
                        help = true;
                        index += 1;
                    }
                    _ => {
                        return Err("generic-domain-capability-evidence accepts --action status|converge --runtime-root ABSOLUTE_PATH [--help] only".into());
                    }
                }
            }
            if help {
                println!(
                    "{}",
                    serde_json::to_string(&generic_domain_capability_evidence_help_json_v1())?
                );
                return Ok(());
            }
            let runtime_root = runtime_root.ok_or(
                "generic-domain-capability-evidence requires --runtime-root ABSOLUTE_PATH",
            )?;
            match action.as_str() {
                "status" => {
                    let report = inspect_generic_domain_capability_evidence_v1(&runtime_root)?;
                    let ready = report["ready"] == true;
                    println!("{}", serde_json::to_string(&report)?);
                    if !ready {
                        std::process::exit(2);
                    }
                }
                "converge" => {
                    let report = converge_generic_domain_capability_evidence_v1(&runtime_root)?;
                    println!("{}", serde_json::to_string(&report)?);
                    std::process::exit(2);
                }
                _ => {
                    return Err(
                        "generic-domain-capability-evidence --action must be status or converge"
                            .into(),
                    );
                }
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
        Some("local-golden-dataset-provision") => {
            let Some(options) = parse_local_golden_dataset_provisioning_arguments(&args[1..])?
            else {
                println!("{}", local_golden_dataset_provisioning_usage());
                return Ok(());
            };
            if options.action == "plan" {
                let report = inspect_local_golden_dataset_provisioning_v1(&options)?;
                println!("{}", serde_json::to_string(&report)?);
            } else {
                let report = execute_local_golden_dataset_provisioning_v1(&options)?;
                let ready = report["ready"] == true;
                println!("{}", serde_json::to_string(&report)?);
                if !ready {
                    std::process::exit(2);
                }
            }
        }
        Some("personal-gpu-operational-gate") => {
            let mut check = false;
            let mut help = false;
            let mut write = false;
            let mut workspace_root = None;
            let mut runtime_root = None;
            let mut receipt = None;
            let mut index = 1;
            while index < args.len() {
                match args[index].as_str() {
                    "--check" if !check => {
                        check = true;
                        index += 1;
                    }
                    "--help" if !help => {
                        help = true;
                        index += 1;
                    }
                    "--write" if !write => {
                        write = true;
                        index += 1;
                    }
                    "--root" if index + 1 < args.len() && workspace_root.is_none() => {
                        workspace_root = Some(PathBuf::from(&args[index + 1]));
                        index += 2;
                    }
                    "--runtime-root" if index + 1 < args.len() && runtime_root.is_none() => {
                        runtime_root = Some(PathBuf::from(&args[index + 1]));
                        index += 2;
                    }
                    "--receipt" if index + 1 < args.len() && receipt.is_none() => {
                        receipt = Some(PathBuf::from(&args[index + 1]));
                        index += 2;
                    }
                    // These execution arguments are accepted by Node's strict
                    // parser, but the Rust partial route intentionally refuses
                    // to execute or write any GPU work.
                    "--output-root" | "--run-id" | "--deadline-ms" if index + 1 < args.len() => {
                        index += 2;
                    }
                    _ => {
                        return Err("personal-gpu-operational-gate accepts --check [--root PATH] [--runtime-root PATH] [--receipt PATH] [--help] only; GPU execution is not ported".into());
                    }
                }
            }
            if help {
                println!(
                    "personal-gpu-operational-gate [--write] [--check] [--root PATH] [--runtime-root PATH]\n  Runs the local single-host GPU/PDE/DL gate. Green is personal-only and non-promotable."
                );
                return Ok(());
            }
            if !check {
                return Err("personal-gpu-operational-gate Rust route currently supports only read-only --check; GPU execution is not ported".into());
            }
            let resolve_path = lexical_absolute_path;
            let workspace_root = workspace_root.map(resolve_path).unwrap_or_else(|| {
                lexical_absolute_path(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
            });
            let runtime_root = runtime_root
                .or_else(|| env::var("HEPTA_PAPER_RUNTIME_ROOT").ok().map(PathBuf::from))
                .map(resolve_path)
                .unwrap_or_else(|| {
                    workspace_root
                        .parent()
                        .unwrap_or_else(|| Path::new("/"))
                        .join("hepta-paper-runtime/native-runtime")
                });
            let receipt_path = receipt.map(resolve_path).unwrap_or_else(|| {
                runtime_root.join("gpu-personal/personal-gpu-operational-receipt.json")
            });
            if !workspace_root.is_absolute()
                || !runtime_root.is_absolute()
                || !receipt_path.is_absolute()
            {
                return Err(
                    "personal-gpu-operational-gate requires absolute root and receipt paths".into(),
                );
            }
            // `--write` is deliberately ignored only when paired with check,
            // matching Node's check-first branch while retaining read-only Rust
            // behavior.  No branch below writes the supplied receipt path.
            let _ = write;
            let report = match read_personal_gpu_receipt(&receipt_path) {
                Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                    Ok(value) if verify_personal_gpu_operational_receipt(&value) => value,
                    _ => personal_gpu_check_fallback(
                        &workspace_root,
                        "personal_gpu_existing_receipt_invalid",
                    )?,
                },
                Err(_) => {
                    let basename = receipt_path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("receipt.json");
                    personal_gpu_check_fallback(
                        &workspace_root,
                        &format!("personal_gpu_artifact_read_failed:{basename}"),
                    )?
                }
            };
            let ready = report["personalProductionReady"] == serde_json::Value::Bool(true);
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !ready {
                std::process::exit(2);
            }
        }
        Some("personal-self-hosted-readiness") => {
            let mut workspace_root = None;
            let mut runtime_root = None;
            let mut cpu_receipt = None;
            let mut gpu_receipt = None;
            let mut gpu_enabled = false;
            let mut require_ready = false;
            let mut help = false;
            let mut observed_at = None;
            let mut index = 1;
            while index < args.len() {
                match args[index].as_str() {
                    "--root" | "--workspace-root"
                        if index + 1 < args.len() && workspace_root.is_none() =>
                    {
                        workspace_root = Some(PathBuf::from(&args[index + 1]));
                        index += 2;
                    }
                    "--runtime-root" if index + 1 < args.len() && runtime_root.is_none() => {
                        runtime_root = Some(PathBuf::from(&args[index + 1]));
                        index += 2;
                    }
                    "--cpu-receipt" if index + 1 < args.len() && cpu_receipt.is_none() => {
                        cpu_receipt = Some(PathBuf::from(&args[index + 1]));
                        index += 2;
                    }
                    "--gpu-receipt" if index + 1 < args.len() && gpu_receipt.is_none() => {
                        gpu_receipt = Some(PathBuf::from(&args[index + 1]));
                        index += 2;
                    }
                    "--gpu-enabled" if !gpu_enabled => {
                        gpu_enabled = true;
                        index += 1;
                    }
                    "--require-ready" if !require_ready => {
                        require_ready = true;
                        index += 1;
                    }
                    "--help" if !help => {
                        help = true;
                        index += 1;
                    }
                    "--now" if index + 1 < args.len() && observed_at.is_none() => {
                        observed_at = Some(args[index + 1].clone());
                        index += 2;
                    }
                    _ => {
                        return Err("personal-self-hosted-readiness accepts --root PATH [--runtime-root PATH] [--cpu-receipt PATH] [--gpu-enabled --gpu-receipt PATH] [--require-ready] [--now ISO|UNIX_MILLIS] [--help] only".into());
                    }
                }
            }
            if help {
                println!(
                    "{}",
                    serde_json::to_string(&personal_self_hosted_readiness_help_json_v1())?
                );
                return Ok(());
            }
            let resolve_path = |path: PathBuf| {
                if path.is_absolute() {
                    path
                } else {
                    env::current_dir()
                        .map(|cwd| cwd.join(&path))
                        .unwrap_or(path)
                }
            };
            let workspace_root = workspace_root
                .or_else(|| env::var("HEPTA_WORKSPACE_ROOT").ok().map(PathBuf::from))
                .map(resolve_path)
                .unwrap_or(env::current_dir()?);
            let runtime_root = runtime_root
                .or_else(|| env::var("HEPTA_PAPER_RUNTIME_ROOT").ok().map(PathBuf::from))
                .map(resolve_path)
                .unwrap_or_else(|| {
                    workspace_root
                        .parent()
                        .unwrap_or_else(|| Path::new("/"))
                        .join("hepta-paper-runtime/native-runtime")
                });
            if !workspace_root.is_absolute() || !runtime_root.is_absolute() {
                return Err("personal-self-hosted-readiness requires absolute root paths".into());
            }
            let observed_at = match observed_at {
                Some(value) => canonical_observed_at_v1(&value)?,
                None => unix_millis_to_iso_v1(current_unix_millis()?)?,
            };
            cpu_receipt = cpu_receipt.map(resolve_path);
            gpu_receipt = gpu_receipt.map(resolve_path);
            let environment = [
                "HEPTA_FORMAL_OPERATIONAL_RECEIPT",
                "HEPTA_PERSONAL_CPU_RECEIPT",
                "HEPTA_PERSONAL_GPU_RECEIPT",
                "HEPTA_PERSONAL_GPU_ENABLED",
                "HEPTA_PERSONAL_GPU_DISABLED_REASON",
            ]
            .into_iter()
            .filter_map(|name| env::var(name).ok().map(|value| (name.to_owned(), value)))
            .chain(cpu_receipt.as_ref().map(|path| {
                (
                    "HEPTA_PERSONAL_CPU_RECEIPT".to_owned(),
                    path.to_string_lossy().into_owned(),
                )
            }))
            .chain(gpu_receipt.as_ref().map(|path| {
                (
                    "HEPTA_PERSONAL_GPU_RECEIPT".to_owned(),
                    path.to_string_lossy().into_owned(),
                )
            }))
            .collect::<BTreeMap<_, _>>();
            let options = PersonalSelfHostedReadinessOptions {
                workspace_root,
                runtime_root,
                cpu_receipt,
                gpu_receipt,
                gpu_enabled: gpu_enabled
                    || environment
                        .get("HEPTA_PERSONAL_GPU_ENABLED")
                        .is_some_and(|v| v == "true"),
                observed_at,
                environment,
            };
            let report = inspect_personal_self_hosted_readiness_v1(&options)?;
            println!("{}", serde_json::to_string(&report)?);
            if require_ready && report["personalSelfHostedProductionReady"] != true {
                std::process::exit(2);
            }
        }
        _ => {
            return Err(concat!(
                "usage: hepta-paper-rust native-identity | put STATE FILE | ",
                "run CONFIG | serve | inspect-db IMMUTABLE_DB | ",
                "store-integrity IMMUTABLE_DB | ",
                "store-status IMMUTABLE_DB [RUNTIME_ROOT] | ",
                "automation-status --help [--json] | ",
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
                " | external-authority-intake [--author-config PATH --author-config-hash sha256:...] [--release-attestor-config PATH --release-attestor-config-hash sha256:...] [--require-ready]",
                " | generic-domain-capability-evidence --action status|converge --runtime-root ABSOLUTE_PATH",
                " | research-capability-matrix --request ABSOLUTE_JSON_PATH [--require-production-ready]",
                " | local-golden-dataset-provision --action plan|execute [options]",
                " | personal-self-hosted-readiness [--root ABSOLUTE_PATH] [--runtime-root ABSOLUTE_PATH] [--cpu-receipt PATH] [--gpu-enabled --gpu-receipt PATH] [--require-ready] [--now ISO|UNIX_MILLIS] [--help]"
            )
            .into());
        }
    }
    Ok(())
}
