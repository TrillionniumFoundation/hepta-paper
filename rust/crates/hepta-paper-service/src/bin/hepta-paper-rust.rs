//! Bounded JSON command interface for the durable Rust composition.
#[path = "shared/ordinary_readonly.rs"]
mod ordinary_readonly;
use hepta_paper_service::{
    LegacyDeletionDrillAttestationRequestV1, LegacyNodeFreezeSubjectV1, ObjectStoreV1,
    ServiceRunV1,
    advanced_numerical::{
        ADVANCED_NUMERICAL_MAX_INPUT_BYTES, execute_advanced_numerical_plugin_v1,
        inspect_advanced_numerical_plugin_status_v1,
    },
    architecture_conformance::{
        ArchitectureConformanceModeV1, inspect_architecture_conformance_v1,
    },
    automation_status::automation_status_help_json_v1,
    autonomous_empirical_plugin_release::{
        AUTONOMOUS_EMPIRICAL_PLUGIN_RELEASE_USAGE,
        autonomous_empirical_plugin_release_help_json_v1,
        execute_autonomous_empirical_plugin_release_v1,
        inspect_autonomous_empirical_plugin_release_v1,
        parse_autonomous_empirical_plugin_release_arguments,
    },
    autonomous_intake_authority_rotation::{
        AUTONOMOUS_INTAKE_AUTHORITY_ROTATION_USAGE,
        autonomous_intake_authority_rotation_help_json_v1,
        execute_autonomous_intake_authority_rotation_v1,
        inspect_autonomous_intake_authority_rotation_v1,
        parse_autonomous_intake_authority_rotation_arguments,
    },
    autonomous_research::{
        autonomous_research_help_json_v1, execute_autonomous_research_with_cancellation_v1,
        inspect_autonomous_research_v1, parse_autonomous_research_arguments,
    },
    autonomous_research_one_shot_campaign_attempt::{
        autonomous_research_one_shot_campaign_attempt_help_json_v1,
        execute_autonomous_research_one_shot_campaign_attempt_v1,
        inspect_autonomous_research_one_shot_campaign_attempt_v1,
        parse_autonomous_research_one_shot_campaign_attempt_arguments,
    },
    autonomous_state_partial_root_maintenance::{
        AUTONOMOUS_STATE_PARTIAL_ROOT_MAINTENANCE_USAGE,
        execute_autonomous_state_partial_root_maintenance_v1,
        inspect_autonomous_state_partial_root_maintenance_v1,
        parse_autonomous_state_partial_root_maintenance_arguments,
    },
    autonomous_state_provision::{
        AUTONOMOUS_STATE_PROVISIONING_USAGE, execute_autonomous_state_provisioning_v1,
        inspect_autonomous_state_provisioning_v1, parse_autonomous_state_provisioning_arguments,
    },
    autonomous_submission_dispatcher::{
        AUTONOMOUS_SUBMISSION_DISPATCHER_USAGE, inspect_autonomous_submission_dispatcher_v1,
        parse_autonomous_submission_dispatcher_arguments,
    },
    autonomous_submission_dispatcher_challenge::{
        AutonomousSubmissionDispatcherChallengeOptions,
        inspect_autonomous_submission_dispatcher_challenge_v1,
    },
    cli_commands::CommandV1,
    command_surface::{
        ci_command_matrix_json_v1, classify_npm_script_surface_json_v1, command_usage_json_v1,
        generated_npm_route_scripts_json_v1, synchronize_command_surface_json_v1,
    },
    critical_module_coverage::{
        CRITICAL_MODULE_COVERAGE_USAGE, critical_module_coverage_help_json_v1,
        inspect_critical_module_coverage_v1, parse_critical_module_coverage_arguments,
    },
    external_authority_intake::{
        external_authority_intake_help_json_v1, inspect_external_authority_intake_v1,
        unix_millis_to_iso_v1,
    },
    full_production_readiness::{
        FULL_PRODUCTION_READINESS_USAGE, execute_full_production_readiness_v1,
        full_production_readiness_help_json_v1, inspect_full_production_readiness_v1,
        parse_full_production_readiness_arguments,
    },
    full_suite_verification::{
        FULL_SUITE_VERIFICATION_USAGE, full_suite_verification_help_json_v1,
        inspect_full_suite_verification_v1, parse_full_suite_verification_arguments,
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
    native_implementation_hash_v1,
    personal_self_hosted_gpu::{
        blocked_personal_gpu_receipt_v1, encode_personal_gpu_operational_receipt_v1,
        parse_personal_gpu_operational_receipt_v1, personal_gpu_receipt_json_v1,
        read_personal_gpu_receipt_v1, write_personal_gpu_receipt_v1,
    },
    personal_self_hosted_readiness::{
        PersonalSelfHostedReadinessOptions, canonical_observed_at_v1,
        inspect_personal_self_hosted_readiness_v1, personal_self_hosted_readiness_help_json_v1,
    },
    release_attest::{
        ReleaseAttestationRequestV1, ReleaseAttestationSourceRequestV2,
        inspect_release_attestation_source_with_cancellation_v2, inspect_release_attestation_v1,
    },
    release_replay::{
        ReleaseAttestationMeasuredPolicyReplayRequestV8,
        ReleaseAttestationNativeAstPolicyReplayRequestV9,
        ReleaseAttestationNativeCommandDispositionPolicyReplayRequestV12,
        ReleaseAttestationNativeResearchRetirementPolicyReplayRequestV13,
        ReleaseAttestationNativeRetirementPolicyReplayRequestV10,
        ReleaseAttestationPolicyReplayRequestV4, ReleaseAttestationReplayRequestV3,
        inspect_release_attestation_measured_policy_replay_with_cancellation_v8,
        inspect_release_attestation_native_ast_policy_replay_with_cancellation_v9,
        inspect_release_attestation_native_command_disposition_policy_replay_with_cancellation_v12,
        inspect_release_attestation_native_research_retirement_policy_replay_with_cancellation_v13,
        inspect_release_attestation_native_retirement_policy_replay_with_cancellation_v10,
        inspect_release_attestation_policy_replay_with_cancellation_v4,
        inspect_release_attestation_replay_with_cancellation_v3,
    },
    release_state::inspect_release_state_v1,
    release_trust_gate::build_release_trust_layer_gate_from_values_v1,
    repository_assets::{
        build_repository_asset_externalization_handoff_v1,
        inspect_repository_asset_externalization_v1,
    },
    research_capability_matrix::build_research_capability_matrix_v2,
    retirement_matrix::inspect_retirement_matrix_v1,
    retirement_reference::verify_retirement_reference_with_cancellation_v1,
    retirement_status::inspect_retirement_status_v1,
    run_service_v1,
    runtime_source_cas::{
        acquire_runtime_source_cas_from_seed_with_cancellation_v1,
        inspect_runtime_source_cas_with_cancellation_v1,
    },
    state_recoverability::safety_inspection::{
        StateSafetyInspectionOptionsV1, inspect_autonomous_research_state_safety_v1,
    },
    strict_full_auto_acceptance::{
        STRICT_FULL_AUTO_ACCEPTANCE_USAGE, execute_strict_full_auto_acceptance_v1,
        inspect_strict_full_auto_acceptance_v1, parse_strict_full_auto_acceptance_arguments,
        strict_full_auto_acceptance_help_json_v1,
    },
    submission_handoff_export::{
        SUBMISSION_HANDOFF_EXPORT_USAGE, execute_submission_handoff_export_v1,
        inspect_submission_handoff_export_v1, parse_submission_handoff_export_arguments,
    },
    verify_legacy_node_freeze_v1,
};
use std::{
    collections::BTreeMap,
    env,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

/// Resolve default product paths from the actual frontend, never the caller's
/// working directory or a different checkout's compile-time path.
fn default_command_workspace_v1() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(hepta_paper_service::native_workspace::current_native_command_workspace_root_v1(None)?)
}
fn default_command_runtime_v1() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(hepta_paper_service::native_workspace::current_native_command_runtime_root_v1()?)
}
fn default_command_assets_v1() -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(path) = env::var_os("HEPTA_PAPER_ASSET_ROOT").filter(|value| !value.is_empty()) {
        return Ok(lexical_absolute_path(PathBuf::from(path)));
    }
    let workspace = default_command_workspace_v1()?;
    let parent = workspace.parent().unwrap_or(&workspace);
    Ok(
        if parent
            .file_name()
            .is_some_and(|name| name == "paper_factory")
        {
            parent.to_path_buf()
        } else {
            parent.join("hepta-paper-assets")
        },
    )
}
fn default_store_integrity_database_v1() -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(default_command_runtime_v1()?.join("hepta-paper.sqlite"))
}

fn ordinary_store_integrity_database_v1(
    argument: Option<&String>,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let explicit_database = argument
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if let Some(database) = explicit_database.as_ref().filter(|path| path.is_absolute()) {
        return Ok(
            hepta_paper_service::native_workspace::resolve_native_workspace_root_v1(
                Path::new("/"),
                database,
                Some(database),
            )?,
        );
    }
    let explicit_runtime = if explicit_database.is_none() {
        env::var_os("HEPTA_PAPER_RUNTIME_ROOT")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    } else {
        None
    };
    if let Some(runtime) = explicit_runtime.as_ref().filter(|path| path.is_absolute()) {
        let runtime = hepta_paper_service::native_workspace::resolve_native_workspace_root_v1(
            Path::new("/"),
            runtime,
            Some(runtime),
        )?;
        return Ok(runtime.join("hepta-paper.sqlite"));
    }
    let workspace = default_command_workspace_v1()?;
    if let Some(database) = explicit_database {
        return Ok(
            hepta_paper_service::native_workspace::resolve_native_workspace_root_v1(
                &workspace,
                &database,
                Some(&database),
            )?,
        );
    }
    let runtime = if let Some(runtime) = explicit_runtime {
        hepta_paper_service::native_workspace::resolve_native_workspace_root_v1(
            &workspace,
            &runtime,
            Some(&runtime),
        )?
    } else {
        workspace
            .parent()
            .unwrap_or(&workspace)
            .join("hepta-paper-runtime/native-runtime")
    };
    Ok(runtime.join("hepta-paper.sqlite"))
}

// This ordinary reader uses the existing signal flag while SQLite is open.
// Once its owned handles are closed, signals regain Node's termination status,
// including during a blocked stdout write. Libraries retain no signal handlers.
fn ordinary_store_integrity_command_v1(
    argument: Option<&String>,
) -> Result<(), Box<dyn std::error::Error>> {
    let database = ordinary_store_integrity_database_v1(argument)?;
    let (report, bytes) = ordinary_readonly::with_node_termination_v1(|cancelled| {
        let store = hepta_readonly_store::OrdinaryReadOnlyStoreV1::open_with_cancellation(
            database,
            cancelled,
            std::time::Instant::now() + std::time::Duration::from_secs(300),
        )?;
        let report = store.node_logical_integrity_report()?;
        let bytes = serde_json::to_string_pretty(&report)?;
        store.verify_unchanged()?;
        drop(store);
        Ok((report, bytes))
    })?;
    println!("{bytes}");
    if report.status != "sqlite_logical_integrity_verified" {
        std::process::exit(1);
    }
    Ok(())
}

fn ordinary_governance_status_command_v1(owner: bool) -> Result<(), Box<dyn std::error::Error>> {
    let workspace =
        hepta_paper_service::native_workspace::current_native_command_workspace_root_v1(None)?;
    // The Node group wrapper executes its worker in the physical workspace.
    // Its relative runtime and asset environment paths resolve from that root.
    let path_from_environment = |name: &str, fallback: PathBuf| -> Result<PathBuf, String> {
        if let Some(selected) = env::var_os(name).filter(|value| !value.is_empty()) {
            let selected = PathBuf::from(selected);
            hepta_paper_service::native_workspace::resolve_native_workspace_root_v1(
                &workspace,
                &selected,
                Some(&selected),
            )
        } else {
            Ok(fallback)
        }
    };
    let parent = workspace.parent().unwrap_or(&workspace);
    let runtime = path_from_environment(
        "HEPTA_PAPER_RUNTIME_ROOT",
        parent.join("hepta-paper-runtime/native-runtime"),
    )?;
    let report = ordinary_readonly::with_node_termination_v1(|cancelled| {
        if owner {
            Ok(hepta_paper_service::operational_status::inspect_ordinary_owner_acceptance_status_with_cancellation_v1(
                &workspace, &runtime, &cancelled,
            )?)
        } else {
            let asset_default = if parent
                .file_name()
                .is_some_and(|name| name == "paper_factory")
            {
                parent.to_owned()
            } else {
                parent.join("hepta-paper-assets")
            };
            let assets = path_from_environment("HEPTA_PAPER_ASSET_ROOT", asset_default)?;
            Ok(hepta_paper_service::operational_status::capability_operational_proof_status_with_cancellation_v1(
                &workspace, &runtime, &assets, &cancelled,
            )?)
        }
    })?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn ordinary_retirement_reference_command_v1() -> Result<(), Box<dyn std::error::Error>> {
    let workspace = default_command_workspace_v1()?;
    let root = if let Some(selected) =
        env::var_os("HEPTA_RETIREMENT_REFERENCE").filter(|value| !value.is_empty())
    {
        let selected = PathBuf::from(selected);
        hepta_paper_service::native_workspace::resolve_native_workspace_root_v1(
            &workspace,
            &selected,
            Some(&selected),
        )?
    } else {
        PathBuf::from(
            "/data/home-data/hepta-paper-legacy-reference/retirement-source-snapshot-2026-07-13",
        )
    };
    let report = ordinary_readonly::with_node_termination_v1(|cancelled| {
        Ok(verify_retirement_reference_with_cancellation_v1(
            &root, &cancelled,
        )?)
    })?;
    let blocked = report["status"] == "retirement_reference_blocked";
    println!("{}", serde_json::to_string_pretty(&report)?);
    if blocked {
        std::process::exit(1);
    }
    Ok(())
}

fn read_bounded(path: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    const MAXIMUM_INPUT_BYTES: u64 = 16 * 1024 * 1024;
    // A request is a cooperative regular-file snapshot. Special files must
    // never wait for a writer before the command can install cancellation.
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC)
        .open(path)?;
    let before = file.metadata()?;
    if !before.is_file() {
        return Err("input must be a regular file".into());
    }
    if before.len() > MAXIMUM_INPUT_BYTES {
        return Err("input exceeds 16MiB".into());
    }
    let identity = |value: &fs::Metadata| {
        (
            value.dev(),
            value.ino(),
            value.uid(),
            value.gid(),
            value.mode(),
            value.nlink(),
            value.len(),
            value.mtime(),
            value.mtime_nsec(),
            value.ctime(),
            value.ctime_nsec(),
        )
    };
    if identity(&before) != identity(&fs::symlink_metadata(path)?) {
        return Err("input changed during read".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAXIMUM_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAXIMUM_INPUT_BYTES {
        return Err("input exceeds 16MiB".into());
    }
    if bytes.len() as u64 != before.len()
        || identity(&before) != identity(&file.metadata()?)
        || identity(&before) != identity(&fs::symlink_metadata(path)?)
    {
        return Err("input changed during read".into());
    }
    Ok(bytes)
}
fn default_repository_asset_paths() -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>> {
    let root = default_command_workspace_v1()?;
    let manifest = root.join("paper-core/config/repository-asset-externalization.v1.json");
    Ok((root, manifest))
}

fn main() {
    if let Err(error) = command() {
        if let Some(report) =
            hepta_paper_service::service_control_inspection_report_v1(error.as_ref())
        {
            eprintln!("{report}");
        } else {
            eprintln!("hepta-paper-rust: {error}");
        }
        std::process::exit(1);
    }
}

fn current_unix_millis() -> Result<i64, Box<dyn std::error::Error>> {
    let millis = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    Ok(i64::try_from(millis).map_err(|_| "current clock exceeds signed millisecond range")?)
}

fn safe_personal_gpu_token(value: &str) -> String {
    let token = value
        .encode_utf16()
        .take(180)
        .map(|unit| {
            if unit <= 127 {
                let character = char::from(unit as u8);
                if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | ':' | '-') {
                    return character;
                }
            }
            '_'
        })
        .collect::<String>();
    if token.is_empty() {
        "error".to_owned()
    } else {
        token
    }
}

fn workspace_commit_for_personal_gpu(root: &Path) -> Option<String> {
    hepta_paper_service::operational_status::current_operational_code_provenance_v1(root)
        .ok()?
        .get("commit")?
        .as_str()
        .map(str::to_owned)
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

const PERSONAL_GPU_USAGE: &str = "personal-gpu-operational-gate [--write] [--check] [--root PATH] [--runtime-root PATH]\n  Runs the local single-host GPU/PDE/DL gate. Green is personal-only and non-promotable.";

fn parse_personal_gpu_arguments(args: &[String]) -> Result<BTreeMap<String, String>, String> {
    let mut parsed = BTreeMap::new();
    let mut index = 0;
    while index < args.len() {
        let token = args[index].as_str();
        if token == "--" {
            return Err("unexpected_cli_argument_separator".into());
        }
        let raw = token
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected_cli_positional:{token}"))?;
        let (key, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(key, value)| (key, Some(value)));
        if key.is_empty() {
            return Err("empty_cli_option".into());
        }
        let boolean = matches!(key, "check" | "help" | "write");
        let value = if boolean {
            if inline.is_some() {
                return Err(format!("boolean_cli_option_does_not_take_value:--{key}"));
            }
            "true".to_owned()
        } else {
            if !matches!(
                key,
                "root" | "runtime-root" | "receipt" | "output-root" | "run-id" | "deadline-ms"
            ) {
                return Err(format!("unknown_cli_option:--{key}"));
            }
            let value = match inline {
                Some(value) => value,
                None => {
                    index += 1;
                    let value = args
                        .get(index)
                        .filter(|value| !value.starts_with("--"))
                        .ok_or_else(|| format!("missing_cli_option_value:--{key}"))?;
                    value.as_str()
                }
            };
            if value.is_empty() {
                return Err(format!("empty_cli_option_value:--{key}"));
            }
            value.to_owned()
        };
        // The Node parser validates the value before reporting duplication.
        if parsed.insert(key.to_owned(), value).is_some() {
            return Err(format!("duplicate_cli_option:--{key}"));
        }
        index += 1;
    }
    Ok(parsed)
}

fn parse_dispatcher_challenge_arguments(
    args: &[String],
) -> Result<BTreeMap<String, String>, String> {
    let mut parsed = BTreeMap::new();
    let value_flags = [
        "action",
        "plan-hash",
        "idempotency-key",
        "portal-id",
        "portal-configuration-hash",
        "portal-descriptor-hash",
        "runtime-root",
    ];
    let mut index = 0;
    while index < args.len() {
        let token = args[index].as_str();
        let raw = token
            .strip_prefix("--")
            .ok_or_else(|| "unexpected_cli_positional".to_owned())?;
        if raw == "help" {
            if parsed
                .insert("help".to_owned(), "true".to_owned())
                .is_some()
            {
                return Err("duplicate_cli_option:--help".into());
            }
            index += 1;
            continue;
        }
        let (key, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(key, value)| (key, Some(value)));
        if !value_flags.contains(&key) {
            return Err(format!("unknown_cli_option:--{key}"));
        }
        let value = match inline {
            Some(value) if !value.is_empty() => value.to_owned(),
            Some(_) => return Err(format!("empty_cli_option_value:--{key}")),
            None => {
                index += 1;
                let value = args
                    .get(index)
                    .filter(|value| !value.starts_with("--") && !value.is_empty())
                    .ok_or_else(|| format!("missing_cli_option_value:--{key}"))?;
                value.clone()
            }
        };
        if parsed.insert(key.to_owned(), value).is_some() {
            return Err(format!("duplicate_cli_option:--{key}"));
        }
        index += 1;
    }
    if parsed.contains_key("help") {
        return Ok(parsed);
    }
    let action = parsed.get("action").map(String::as_str).unwrap_or("status");
    if !matches!(action, "publish" | "status")
        || ![
            "plan-hash",
            "idempotency-key",
            "portal-id",
            "portal-configuration-hash",
            "portal-descriptor-hash",
        ]
        .iter()
        .all(|key| parsed.contains_key(*key))
        || !parsed["plan-hash"].starts_with("sha256:")
        || !parsed["idempotency-key"].starts_with("sha256:")
        || !parsed["portal-configuration-hash"].starts_with("sha256:")
        || !parsed["portal-descriptor-hash"].starts_with("sha256:")
    {
        return Err("autonomous_submission_dispatcher_challenge_arguments_invalid".into());
    }
    Ok(parsed)
}

const DISPATCHER_CHALLENGE_USAGE: &str = r#"{
  "version": 1,
  "kind": "AutonomousSubmissionDispatcherChallengeUsage",
  "usage": "autonomous-submission-dispatcher-challenge --action publish|status --plan-hash sha256:... --idempotency-key sha256:... --portal-id ID --portal-configuration-hash sha256:... --portal-descriptor-hash sha256:...",
  "publisherHasPortalCredentials": false,
  "statusIsReadOnly": true,
  "residentDispatcherPrincipalRequired": true
}"#;

// One CLI signal adapter; libraries never change process-global handlers.
fn command_cancellation_flag()
-> Result<std::sync::Arc<std::sync::atomic::AtomicBool>, Box<dyn std::error::Error>> {
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    for signal in [signal_hook::consts::SIGINT, signal_hook::consts::SIGTERM] {
        signal_hook::flag::register(signal, std::sync::Arc::clone(&cancelled))?;
    }
    Ok(cancelled)
}

fn command() -> Result<(), Box<dyn std::error::Error>> {
    let args = env::args_os()
        .skip(1)
        .map(|argument| {
            argument
                .into_string()
                .map_err(|_| "native_command_argument_encoding_invalid")
        })
        .collect::<Result<Vec<_>, _>>()?;
    // Internal data-only worker selected only by the current native ELF owner.
    // It reads bounded JSON and never executes Python source or grants authority.
    if args.as_slice() == ["__hepta_internal_retirement_python_ast_v1"] {
        let mut bytes = Vec::new();
        io::stdin()
            .lock()
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        let output =
            hepta_paper_service::release_replay::python_ast::inspect_python_ast_worker_bytes_v1(
                &bytes,
            )?;
        io::stdout().lock().write_all(&output)?;
        return Ok(());
    }
    let args = match hepta_paper_service::canonical_cli::resolve_canonical_cli_arguments_v1(&args) {
        Ok(Some(arguments)) => arguments,
        Ok(None) => args,
        Err(error) => {
            eprintln!("{}", serde_json::json!({"error": error}));
            std::process::exit(2);
        }
    };
    if args.as_slice() == ["--help-json"] {
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "version": 1, "kind": "RustCommandCatalogV1",
                "commands": CommandV1::ALL.iter().map(|command| command.name()).collect::<Vec<_>>()
            }))?
        );
        return Ok(());
    }
    match args.first().and_then(|name| CommandV1::parse(name)) {
        Some(CommandV1::NativeIdentity) if args.len() == 1 => {
            println!("{}", native_implementation_hash_v1()?);
        }
        Some(CommandV1::Put) if args.len() == 3 => {
            let bytes = read_bounded(&args[2])?;
            let store = ObjectStoreV1::open(&PathBuf::from(&args[1]))?;
            println!("{}", store.put(&bytes)?);
        }
        Some(CommandV1::Run) if args.len() == 2 => {
            let config: ServiceRunV1 = serde_json::from_slice(&read_bounded(&args[1])?)?;
            println!("{}", serde_json::to_string(&run_service_v1(config)?)?);
        }
        Some(CommandV1::Serve) if args.len() == 1 => {
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
        Some(CommandV1::VerifyLegacyFreeze) if args.len() == 5 => {
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
        Some(CommandV1::InspectDb) if args.len() == 2 => {
            let store = hepta_readonly_store::ReadOnlyStoreV1::open_known_installed_v1(
                PathBuf::from(&args[1]),
            )?;
            println!(
                "{}",
                serde_json::to_string(&store.node_logical_snapshot()?)?
            );
        }
        Some(
            command @ (CommandV1::OrdinaryJournalConnectorCoverage
            | CommandV1::OrdinaryAutonomousSupervisorHealth),
        ) => {
            use hepta_paper_service::ordinary_readonly_frontend::{
                OrdinaryReadonlyRouteV1, inspect_ordinary_readonly_frontend_v1,
            };
            let route = match command {
                CommandV1::OrdinaryJournalConnectorCoverage => {
                    OrdinaryReadonlyRouteV1::JournalConnectorCoverage
                }
                _ => OrdinaryReadonlyRouteV1::AutonomousSupervisorHealth,
            };
            let output = inspect_ordinary_readonly_frontend_v1(route, &args[1..]);
            io::stdout().lock().write_all(&output.stdout)?;
            io::stderr().lock().write_all(&output.stderr)?;
            if output.exit_code != 0 {
                std::process::exit(output.exit_code);
            }
        }
        Some(CommandV1::OrdinaryOwnerAcceptanceStatus) if args.len() == 1 => {
            ordinary_governance_status_command_v1(true)?;
        }
        Some(CommandV1::OrdinaryOperationalProofStatus) if args.len() == 1 => {
            ordinary_governance_status_command_v1(false)?;
        }
        Some(CommandV1::PaperBatch) => {
            let cwd = env::current_dir()?;
            let output = ordinary_readonly::with_node_termination_v1(|cancelled| {
                Ok(
                    hepta_paper_service::batch_operator::run_native_batch_operator_v1(
                        &args[1..],
                        &cwd,
                        &cancelled,
                    )?,
                )
            })?;
            io::stdout().lock().write_all(&output.stdout)?;
            io::stderr().lock().write_all(&output.stderr)?;
            if output.exit_code != 0 {
                std::process::exit(output.exit_code);
            }
        }
        Some(CommandV1::OrdinaryStoreIntegrity) if args.len() == 1 || args.len() == 2 => {
            ordinary_store_integrity_command_v1(args.get(1))?;
        }
        Some(CommandV1::StoreIntegrity) if args.len() == 1 || args.len() == 2 => {
            let database = match args.get(1) {
                Some(path) => PathBuf::from(path),
                None => default_store_integrity_database_v1()?,
            };
            let store = hepta_readonly_store::ReadOnlyStoreV1::open_known_installed_v1(database)?;
            let report = store.node_logical_integrity_report()?;
            println!("{}", serde_json::to_string(&report)?);
            if report.status != "sqlite_logical_integrity_verified" {
                return Err("sqlite logical integrity report blocked".into());
            }
        }
        Some(CommandV1::StoreStatus) => {
            let ordinary = env::args().nth(1).as_deref() == Some("operator")
                && env::args().nth(2).as_deref() == Some("store");
            let mut cwd = env::current_dir()?;
            let mut environment = BTreeMap::new();
            for key in [
                "HEPTA_PAPER_WORKSPACE_ROOT",
                "HEPTA_PAPER_ASSET_ROOT",
                "HEPTA_PAPER_RUNTIME_ROOT",
                "PAPER_FACTORY_LEGACY_ROOT",
            ] {
                match env::var(key) {
                    Ok(value) => {
                        environment.insert(key.to_owned(), value);
                    }
                    Err(env::VarError::NotPresent) => (),
                    Err(env::VarError::NotUnicode(_)) => {
                        return Err(
                            hepta_paper_service::store_status::StoreStatusError::Utf8.into()
                        );
                    }
                }
            }
            if ordinary
                && !environment
                    .get("HEPTA_PAPER_RUNTIME_ROOT")
                    .is_some_and(|value| !value.is_empty() && Path::new(value).is_absolute())
            {
                cwd = hepta_paper_service::native_workspace::resolve_native_command_workspace_root_v1(
                    &cwd, &environment, None,
                )?;
                environment.insert(
                    "HEPTA_PAPER_WORKSPACE_ROOT".to_owned(),
                    cwd.to_str()
                        .ok_or("native_workspace_root_invalid")?
                        .to_owned(),
                );
            }
            match hepta_paper_service::store_status::store_status_cli_v1(
                &args[1..],
                &cwd,
                &environment,
            ) {
                Ok((report, code)) => {
                    println!("{}", serde_json::to_string(&report)?);
                    if code != 0 {
                        std::process::exit(code);
                    }
                }
                Err(hepta_paper_service::store_status::StoreStatusError::Arguments(message)) => {
                    eprintln!("{}", serde_json::json!({"error": message}));
                    std::process::exit(2);
                }
                Err(error) => return Err(error.into()),
            }
        }
        Some(CommandV1::AutomationStatus) if args.len() >= 2 => {
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
        Some(CommandV1::StoreMigrate) => {
            use hepta_paper_service::node_migration::{
                migrate_node_store_with_control_v1, parse_node_migration_arguments_v1,
            };
            let options = parse_node_migration_arguments_v1(&args[1..])?;
            let cancelled = command_cancellation_flag()?;
            let receipt = migrate_node_store_with_control_v1(
                &options.path,
                options.target_version,
                cancelled,
                options.timeout,
            )?;
            println!("{}", serde_json::to_string(&receipt)?);
        }
        Some(CommandV1::WorkspaceStatus) => {
            let mut environment: BTreeMap<String, String> = [
                "HEPTA_PAPER_WORKSPACE_ROOT",
                "HEPTA_PAPER_ASSET_ROOT",
                "HEPTA_PAPER_RUNTIME_ROOT",
                "PAPER_FACTORY_LEGACY_ROOT",
            ]
            .into_iter()
            .filter_map(|name| env::var(name).ok().map(|value| (name.to_owned(), value)))
            .collect();
            let mut cwd = env::current_dir()?;
            if env::args().nth(1).as_deref() == Some("operator")
                && env::args().nth(2).as_deref() == Some("workspace")
            {
                cwd = hepta_paper_service::native_workspace::resolve_native_command_workspace_root_v1(
                    &cwd, &environment, None,
                )?;
                environment.insert(
                    "HEPTA_PAPER_WORKSPACE_ROOT".to_owned(),
                    cwd.to_str()
                        .ok_or("native_workspace_root_invalid")?
                        .to_owned(),
                );
            }
            let (report, code) = hepta_paper_service::workspace_status::workspace_status_cli_v1(
                &args[1..],
                &cwd,
                &environment,
            )?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if code != 0 {
                std::process::exit(code);
            }
        }
        Some(CommandV1::RepositoryAssets) => {
            let explicit_paths = if args.get(1).is_none_or(|value| value.starts_with("--")) {
                None
            } else if args.len() >= 3 && !args[2].starts_with("--") {
                Some((PathBuf::from(&args[1]), PathBuf::from(&args[2])))
            } else {
                return Err(format!("unexpected_cli_positional:{}", args[1]).into());
            };
            let flag_start = if explicit_paths.is_some() { 3 } else { 1 };
            let mut handoff = false;
            let mut require_externalized = false;
            for token in args.iter().skip(flag_start) {
                if token == "--" {
                    return Err("unexpected_cli_argument_separator".into());
                }
                let Some(raw) = token.strip_prefix("--") else {
                    return Err(format!("unexpected_cli_positional:{token}").into());
                };
                let (key, inline_value) = raw
                    .split_once('=')
                    .map_or((raw, None), |(key, value)| (key, Some(value)));
                if key.is_empty() {
                    return Err("empty_cli_option".into());
                }
                let flag = match key {
                    "handoff" => &mut handoff,
                    "require-externalized" => &mut require_externalized,
                    _ => return Err(format!("unknown_cli_option:--{key}").into()),
                };
                if inline_value.is_some() {
                    return Err(format!("boolean_cli_option_does_not_take_value:--{key}").into());
                }
                if *flag {
                    return Err(format!("duplicate_cli_option:--{key}").into());
                }
                *flag = true;
            }
            let (root, manifest_path) = match explicit_paths {
                Some(paths) => paths,
                None => default_repository_asset_paths()?,
            };
            let manifest: serde_json::Value = serde_json::from_slice(&read_bounded(
                manifest_path
                    .to_str()
                    .ok_or("repository_asset_manifest_path_invalid")?,
            )?)?;
            let inspection = inspect_repository_asset_externalization_v1(&root, &manifest)?;
            let value = if handoff {
                build_repository_asset_externalization_handoff_v1(&root, &manifest)?
            } else {
                inspection.clone()
            };
            println!("{}", serde_json::to_string(&value)?);
            let repository_boundary_ready = inspection
                .get("repositoryBoundaryReady")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let fully_externalized = inspection
                .get("fullyExternalized")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            if !repository_boundary_ready || (require_externalized && !fully_externalized) {
                std::process::exit(1);
            }
        }
        Some(CommandV1::OrdinaryCommandSurfaceSync) if args.len() == 1 => {
            let root = hepta_paper_service::native_workspace::current_native_command_surface_workspace_root_v1()?;
            let output =
                hepta_paper_service::command_surface::synchronize_command_surface_pretty_json_v1(
                    &root, true,
                )?;
            let blocked = serde_json::from_str::<serde_json::Value>(&output)?.get("ready")
                != Some(&serde_json::Value::Bool(true));
            println!("{output}");
            if blocked {
                std::process::exit(1);
            }
        }
        Some(CommandV1::CommandSurface) if args.len() == 2 || args.len() == 3 => {
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
        Some(CommandV1::VerifyArchitecture) if args.len() >= 2 => {
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
        Some(CommandV1::VerifyCritical) => {
            let options = match parse_critical_module_coverage_arguments(&args[1..]) {
                Ok(options) => options,
                Err(error) => {
                    eprintln!("{error}\n{CRITICAL_MODULE_COVERAGE_USAGE}");
                    std::process::exit(1);
                }
            };
            if options.help {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&critical_module_coverage_help_json_v1())?
                );
                return Ok(());
            }
            // The Node command binds its workspace to the installed source
            // tree (`HEPTA_WORKSPACE_ROOT`), so invoking the native command
            // from another cwd must not silently switch its deployment
            // defaults to that caller directory.
            let workspace_root = default_command_workspace_v1()?;
            let report = inspect_critical_module_coverage_v1(&options, &workspace_root)
                .map_err(|error| format!("critical module coverage preflight failed: {error}"))?;
            if options.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!(
                    "{}",
                    report["status"]
                        .as_str()
                        .unwrap_or("critical_module_coverage_blocked")
                );
            }
            if options.require_ok && report["ok"] != true {
                std::process::exit(2);
            }
        }
        Some(CommandV1::VerifyFull) => {
            let options = match parse_full_suite_verification_arguments(&args[1..]) {
                Ok(options) => options,
                Err(error) => {
                    eprintln!("{error}\n{FULL_SUITE_VERIFICATION_USAGE}");
                    std::process::exit(1);
                }
            };
            if options.help {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&full_suite_verification_help_json_v1()?)?
                );
                return Ok(());
            }
            let report = if options.preflight {
                inspect_full_suite_verification_v1(&options)?
            } else {
                let cancelled = command_cancellation_flag()?;
                hepta_paper_service::full_suite_verification::execute_full_suite_verification_v1(
                    &options, &cancelled,
                )?
            };
            if options.json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!(
                    "{}",
                    report["status"].as_str().unwrap_or("verify_full_blocked")
                );
            }
            if report["ok"] != true {
                std::process::exit(2);
            }
        }
        Some(CommandV1::AdvancedNumericalPlugin) if args.len() == 2 => {
            if args[1] == "status" {
                println!(
                    "{}",
                    serde_json::to_string(&inspect_advanced_numerical_plugin_status_v1())?
                );
            } else {
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
        }
        Some(CommandV1::RetirementReference) if args.len() == 2 => {
            let cancelled = command_cancellation_flag()?;
            let report = verify_retirement_reference_with_cancellation_v1(
                &PathBuf::from(&args[1]),
                &cancelled,
            )?;
            let blocked = report["status"] == "retirement_reference_blocked";
            println!("{}", serde_json::to_string(&report)?);
            if blocked {
                return Err("retirement reference verification blocked".into());
            }
        }
        Some(CommandV1::OrdinaryRetirementReference) if args.len() == 1 => {
            ordinary_retirement_reference_command_v1()?;
        }
        Some(CommandV1::RetirementMatrix) => {
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
        Some(CommandV1::RetirementDrillAttest) if args.len() == 2 => {
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
        Some(CommandV1::ReleaseTrustGate) if args.len() == 2 => {
            let input: serde_json::Value = serde_json::from_slice(&read_bounded(&args[1])?)?;
            println!(
                "{}",
                serde_json::to_string(&build_release_trust_layer_gate_from_values_v1(&input)?)?
            );
        }
        Some(CommandV1::ReleaseState) if args.len() == 2 => {
            let input: serde_json::Value = serde_json::from_slice(&read_bounded(&args[1])?)?;
            println!(
                "{}",
                serde_json::to_string(&inspect_release_state_v1(&input)?)?
            );
        }
        Some(CommandV1::ReleaseEvidence) => {
            // Validate the complete ordinary grammar before process handlers,
            // path selection, source capture or key access.
            let options =
                hepta_paper_service::release_evidence::parse_release_evidence_arguments_v1(
                    &args[1..],
                )?;
            if options.help {
                println!(
                    "{}",
                    hepta_paper_service::release_evidence::RELEASE_EVIDENCE_USAGE
                );
            } else {
                let mut environment = std::collections::BTreeMap::new();
                for name in [
                    "HEPTA_PAPER_WORKSPACE_ROOT",
                    "HEPTA_PAPER_RUNTIME_ROOT",
                    "HEPTA_PAPER_ASSET_ROOT",
                    "PAPER_FACTORY_LEGACY_ROOT",
                    "HEPTA_PAPER_RUNTIME_ISOLATED",
                ] {
                    if let Some(raw) = std::env::var_os(name) {
                        let value = raw
                            .into_string()
                            .map_err(|_| "native_command_environment_encoding_invalid")?;
                        environment.insert(name.to_owned(), value);
                    }
                }
                let cancelled = command_cancellation_flag()?;
                let report = hepta_paper_service::release_evidence::execute_release_evidence_with_cancellation_v1(&args[1..], &environment, &cancelled)?;
                println!("{}", serde_json::to_string(&report)?);
            }
        }
        Some(CommandV1::ReleaseAttest) if args.len() == 2 => {
            let bytes = read_bounded(&args[1])?;
            let discriminator: serde_json::Value = serde_json::from_slice(&bytes)?;
            let report = if discriminator["version"] == 13 {
                let request: ReleaseAttestationNativeResearchRetirementPolicyReplayRequestV13 =
                    serde_json::from_slice(&bytes)?;
                let cancelled = command_cancellation_flag()?;
                inspect_release_attestation_native_research_retirement_policy_replay_with_cancellation_v13(request,&cancelled)?
            } else if discriminator["version"] == 12 {
                let request: ReleaseAttestationNativeCommandDispositionPolicyReplayRequestV12 =
                    serde_json::from_slice(&bytes)?;
                let cancelled = command_cancellation_flag()?;
                inspect_release_attestation_native_command_disposition_policy_replay_with_cancellation_v12(
                    request, &cancelled,
                )?
            } else if discriminator["version"] == 10 {
                let request: ReleaseAttestationNativeRetirementPolicyReplayRequestV10 =
                    serde_json::from_slice(&bytes)?;
                let cancelled = command_cancellation_flag()?;
                inspect_release_attestation_native_retirement_policy_replay_with_cancellation_v10(
                    request, &cancelled,
                )?
            } else if discriminator["version"] == 9 {
                let request: ReleaseAttestationNativeAstPolicyReplayRequestV9 =
                    serde_json::from_slice(&bytes)?;
                let cancelled = command_cancellation_flag()?;
                inspect_release_attestation_native_ast_policy_replay_with_cancellation_v9(
                    request, &cancelled,
                )?
            } else if discriminator["version"] == 8 {
                let request: ReleaseAttestationMeasuredPolicyReplayRequestV8 =
                    serde_json::from_slice(&bytes)?;
                let cancelled = command_cancellation_flag()?;
                inspect_release_attestation_measured_policy_replay_with_cancellation_v8(
                    request, &cancelled,
                )?
            } else if discriminator["version"] == 4 {
                let request: ReleaseAttestationPolicyReplayRequestV4 =
                    serde_json::from_slice(&bytes)?;
                let cancelled = command_cancellation_flag()?;
                inspect_release_attestation_policy_replay_with_cancellation_v4(request, &cancelled)?
            } else if discriminator["version"] == 3 {
                let request: ReleaseAttestationReplayRequestV3 = serde_json::from_slice(&bytes)?;
                let cancelled = command_cancellation_flag()?;
                inspect_release_attestation_replay_with_cancellation_v3(request, &cancelled)?
            } else if discriminator["version"] == 2 {
                let request: ReleaseAttestationSourceRequestV2 = serde_json::from_slice(&bytes)?;
                let cancelled = command_cancellation_flag()?;
                inspect_release_attestation_source_with_cancellation_v2(request, &cancelled)?
            } else {
                let request: ReleaseAttestationRequestV1 = serde_json::from_slice(&bytes)?;
                inspect_release_attestation_v1(request)?
            };
            println!("{}", serde_json::to_string(&report)?);
            if report["releaseEvidenceReady"] != true {
                return Err("release attestation blocked; inspect implementationBlockers and externalQualificationBlockers".into());
            }
        }
        Some(CommandV1::RetirementStatus) if args.len() == 1 || args.len() == 2 => {
            let input: serde_json::Value = if args.len() == 1 {
                serde_json::json!({})
            } else {
                serde_json::from_slice(&read_bounded(&args[1])?)?
            };
            println!(
                "{}",
                serde_json::to_string(&inspect_retirement_status_v1(&input)?)?
            );
        }
        Some(CommandV1::RuntimeRSourceCas) if args.len() >= 2 => {
            let repository_root = PathBuf::from(&args[1]);
            let mut action = "status";
            let mut seed = None;
            let mut snapshot = false;
            let mut action_seen = false;
            let mut seed_seen = false;
            let mut index = 2;
            while index < args.len() {
                match args[index].as_str() {
                    "--snapshot" if !snapshot => {
                        snapshot = true;
                        index += 1;
                    }
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
                            "runtime-r-source-cas accepts ROOT [--action status|acquire] [--seed DIRECTORY | --snapshot] only".into(),
                        );
                    }
                }
            }
            if snapshot && (seed.is_some() || action != "acquire") {
                return Err(
                    "runtime-r-source-cas --snapshot requires exclusive acquire mode".into(),
                );
            }
            let report = match action {
                "status" => {
                    let cancelled = command_cancellation_flag()?;
                    inspect_runtime_source_cas_with_cancellation_v1(&repository_root, &cancelled)
                }
                "acquire" => {
                    let cancelled = command_cancellation_flag()?;
                    if snapshot {
                        hepta_paper_service::runtime_source_cas::acquire_runtime_source_cas_from_snapshot_with_cancellation_v1(
                            &repository_root, &cancelled,
                        )?
                    } else {
                        let seed = seed
                            .ok_or("runtime-r-source-cas acquire requires --seed or --snapshot")?;
                        acquire_runtime_source_cas_from_seed_with_cancellation_v1(
                            &repository_root,
                            &seed,
                            &cancelled,
                        )?
                    }
                }
                _ => return Err("runtime-r-source-cas action must be status or acquire".into()),
            };
            let blocked = report.get("ready") != Some(&serde_json::Value::Bool(true));
            println!("{}", serde_json::to_string(&report)?);
            if blocked {
                return Err("R runtime source CAS verification blocked".into());
            }
        }
        Some(CommandV1::ResearchReadiness) => {
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
        Some(CommandV1::ExternalAuthorityIntake) => {
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
        Some(CommandV1::GenericDomainCapabilityEvidence) => {
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
        Some(CommandV1::ResearchCapabilityMatrix) => {
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
        Some(CommandV1::LocalGoldenDatasetProvision) => {
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
        Some(CommandV1::AutonomousOnlineSchemaTransition) => {
            let report =
                hepta_paper_service::online_schema_execution::cli::schema_transition_plan_cli_v1(
                    &args[1..],
                    &mut hepta_paper_service::sqlite_mutation_coordinator::clock::SystemMutationClockV1,
                )?;
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        Some(CommandV1::AutonomousStateProvision) => {
            if args
                .get(1)
                .is_some_and(|value| value == "--recover-publication")
            {
                let report = hepta_paper_service::autonomous_state_provision::publication_recovery::reconcile_publication_cli_v1(&args[1..])?;
                println!("{}", serde_json::to_string(&report)?);
                return Ok(());
            }
            if args
                .get(1)
                .is_some_and(|value| value == "--recover-staging")
            {
                let report = hepta_paper_service::autonomous_state_provision::recovery::recover_staging_cli_v1(&args[1..])?;
                println!("{}", serde_json::to_string(&report)?);
                return Ok(());
            }
            let Some(options) = parse_autonomous_state_provisioning_arguments(&args[1..])? else {
                println!("{AUTONOMOUS_STATE_PROVISIONING_USAGE}");
                return Ok(());
            };
            if options.action == "plan" {
                let report = inspect_autonomous_state_provisioning_v1(&options)?;
                println!("{}", serde_json::to_string(&report)?);
            } else {
                let report = execute_autonomous_state_provisioning_v1(&options)?;
                println!("{}", serde_json::to_string(&report)?);
                if report["ready"] != true {
                    std::process::exit(2);
                }
            }
        }
        Some(CommandV1::AutonomousStatePartialRootMaintenance) => {
            let Some(options) =
                parse_autonomous_state_partial_root_maintenance_arguments(&args[1..])?
            else {
                println!("{AUTONOMOUS_STATE_PARTIAL_ROOT_MAINTENANCE_USAGE}");
                return Ok(());
            };
            if options.action == "plan" {
                let report = inspect_autonomous_state_partial_root_maintenance_v1(&options)?;
                println!("{}", serde_json::to_string(&report)?);
            } else {
                let report = execute_autonomous_state_partial_root_maintenance_v1(&options)?;
                println!("{}", serde_json::to_string(&report)?);
                if report["ready"] != true {
                    std::process::exit(2);
                }
            }
        }
        Some(CommandV1::PersonalGpuOperationalGate) => {
            let options = match parse_personal_gpu_arguments(&args[1..]) {
                Ok(options) => options,
                Err(error) => {
                    eprintln!("{error}\n{PERSONAL_GPU_USAGE}");
                    std::process::exit(2);
                }
            };
            if options.contains_key("help") {
                println!("{PERSONAL_GPU_USAGE}");
                return Ok(());
            }
            if !options.contains_key("check") {
                return Err("personal-gpu-operational-gate Rust route currently supports only --check; GPU execution is not ported".into());
            }
            let workspace_root = match options.get("root") {
                Some(path) => lexical_absolute_path(PathBuf::from(path)),
                None => default_command_workspace_v1()?,
            };
            // Runtime defaults belong to the frontend independently of the
            // CLI provenance --root, as in Node's defaultPaperRuntimeRoot.
            let runtime_root = match options.get("runtime-root") {
                Some(path) => lexical_absolute_path(PathBuf::from(path)),
                None => default_command_runtime_v1()?,
            };
            let receipt = options.get("receipt").map(PathBuf::from);
            let resolve_path = lexical_absolute_path;
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
            // A valid Node --check returns before its write path. Only a failed
            // check with explicit --write publishes the newly built fallback.
            let mut original_json = None;
            let report = match read_personal_gpu_receipt_v1(&receipt_path) {
                Ok(bytes) => match parse_personal_gpu_operational_receipt_v1(&bytes) {
                    Ok(value) => {
                        original_json = Some(personal_gpu_receipt_json_v1(&bytes)?);
                        value
                    }
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
            let is_fallback = original_json.is_none();
            let rendered = match original_json {
                Some(json) => json,
                None => encode_personal_gpu_operational_receipt_v1(&report)?,
            };
            if is_fallback && options.contains_key("write") {
                // Node reports the blocked receipt even when publication fails.
                let _ = write_personal_gpu_receipt_v1(&receipt_path, &rendered);
            }
            println!("{rendered}");
            if !ready {
                std::process::exit(2);
            }
        }
        Some(CommandV1::AutonomousIntakeAuthorityRotation) => {
            let mut options = match parse_autonomous_intake_authority_rotation_arguments(&args[1..])
            {
                Ok(options) => options,
                Err(error) => {
                    eprintln!("{error}\n{AUTONOMOUS_INTAKE_AUTHORITY_ROTATION_USAGE}");
                    std::process::exit(1);
                }
            };
            if options.help {
                println!(
                    "{}",
                    serde_json::to_string_pretty(
                        &autonomous_intake_authority_rotation_help_json_v1()
                    )?
                );
                return Ok(());
            }
            options.runtime_root = Some(match options.runtime_root.take() {
                Some(path) => lexical_absolute_path(path),
                None => default_command_runtime_v1()?,
            });
            options.next_machine_intake_config = options
                .next_machine_intake_config
                .take()
                .map(lexical_absolute_path);
            options.topic_producer_profile = options
                .topic_producer_profile
                .take()
                .map(lexical_absolute_path);
            options.rotation_intent = options.rotation_intent.take().map(lexical_absolute_path);
            let report = if options.action == "apply" {
                execute_autonomous_intake_authority_rotation_v1(&options)
            } else {
                inspect_autonomous_intake_authority_rotation_v1(&options)
            };
            println!("{}", serde_json::to_string_pretty(&report)?);
            if report["ready"] != serde_json::Value::Bool(true) {
                std::process::exit(2);
            }
        }
        Some(CommandV1::AutonomousEmpiricalPluginRelease) => {
            let options = match parse_autonomous_empirical_plugin_release_arguments(&args[1..]) {
                Ok(options) => options,
                Err(error) => {
                    eprintln!("{error}\n{AUTONOMOUS_EMPIRICAL_PLUGIN_RELEASE_USAGE}");
                    std::process::exit(1);
                }
            };
            if options.help {
                println!(
                    "{}",
                    serde_json::to_string_pretty(
                        &autonomous_empirical_plugin_release_help_json_v1()
                    )?
                );
                return Ok(());
            }
            let report = if options.action == "publish" {
                execute_autonomous_empirical_plugin_release_v1(&options)
            } else {
                inspect_autonomous_empirical_plugin_release_v1(&options)
            };
            println!("{}", serde_json::to_string_pretty(&report)?);
            if options.action == "publish"
                || (options.action != "template"
                    && report["ready"] != serde_json::Value::Bool(true))
            {
                std::process::exit(2);
            }
        }
        Some(CommandV1::AutonomousSubmissionDispatcher) => {
            let mut options = match parse_autonomous_submission_dispatcher_arguments(&args[1..]) {
                Ok(options) => options,
                Err(error) => {
                    eprintln!("{error}\n{AUTONOMOUS_SUBMISSION_DISPATCHER_USAGE}");
                    std::process::exit(1);
                }
            };
            if options.help {
                println!("{AUTONOMOUS_SUBMISSION_DISPATCHER_USAGE}");
                return Ok(());
            }
            if options.runtime_root.is_none() {
                options.runtime_root = env::var("HEPTA_PAPER_RUNTIME_ROOT")
                    .ok()
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from);
            }
            if options.root.is_none() {
                options.root = env::var("HEPTA_PAPER_ASSET_ROOT")
                    .ok()
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from);
            }
            let workspace_root = env::current_dir()?;
            let report = inspect_autonomous_submission_dispatcher_v1(
                &options,
                &workspace_root,
                current_unix_millis()?,
            )?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if report["ready"] != serde_json::Value::Bool(true) {
                std::process::exit(2);
            }
        }
        Some(CommandV1::AutonomousSubmissionDispatcherChallenge) => {
            let options = match parse_dispatcher_challenge_arguments(&args[1..]) {
                Ok(options) => options,
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            };
            if options.contains_key("help") {
                println!("{DISPATCHER_CHALLENGE_USAGE}");
                // The incumbent entrypoint treats the usage object as a
                // non-ready status report and exits 2.
                std::process::exit(2);
            }
            if options
                .get("action")
                .map(String::as_str)
                .unwrap_or("status")
                == "publish"
            {
                return Err(
                    "rust_autonomous_submission_dispatcher_challenge_publish_not_ported".into(),
                );
            }
            let runtime_root = match options.get("runtime-root") {
                Some(path) => lexical_absolute_path(PathBuf::from(path)),
                None => default_command_runtime_v1()?,
            };
            let report = inspect_autonomous_submission_dispatcher_challenge_v1(
                &AutonomousSubmissionDispatcherChallengeOptions {
                    runtime_root,
                    now_millis: current_unix_millis()?,
                    plan_hash: options.get("plan-hash").cloned(),
                    idempotency_key: options.get("idempotency-key").cloned(),
                    portal_id: options.get("portal-id").cloned(),
                    portal_configuration_hash: options.get("portal-configuration-hash").cloned(),
                    portal_descriptor_hash: options.get("portal-descriptor-hash").cloned(),
                },
            )?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if report["ready"] != serde_json::Value::Bool(true) {
                std::process::exit(2);
            }
        }
        Some(CommandV1::AutonomousResearch) => {
            let options = match parse_autonomous_research_arguments(&args[1..]) {
                Ok(options) => options,
                Err(error) => {
                    eprintln!("{error}");
                    std::process::exit(1);
                }
            };
            if options.help {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&autonomous_research_help_json_v1())?
                );
                return Ok(());
            }
            let report = if options.action == "prepare" || options.action == "status" {
                inspect_autonomous_research_v1(&options)
            } else {
                let cancelled = command_cancellation_flag()?;
                execute_autonomous_research_with_cancellation_v1(&options, cancelled)
            };
            println!("{}", serde_json::to_string_pretty(&report)?);
            if report["ready"] != serde_json::Value::Bool(true) {
                std::process::exit(2);
            }
        }
        Some(CommandV1::AutonomousResearchOneShotCampaignAttempt) => {
            let mut options =
                parse_autonomous_research_one_shot_campaign_attempt_arguments(&args[1..])?;
            if options.help {
                println!(
                    "{}",
                    serde_json::to_string_pretty(
                        &autonomous_research_one_shot_campaign_attempt_help_json_v1()
                    )?
                );
                return Ok(());
            }
            options.root = Some(match options.root.take() {
                Some(path) => lexical_absolute_path(path),
                None => default_command_assets_v1()?,
            });
            options.runtime_root = Some(match options.runtime_root.take() {
                Some(path) => lexical_absolute_path(path),
                None => default_command_runtime_v1()?,
            });
            let workspace_root = default_command_workspace_v1()?;
            options.control_root = Some(
                options
                    .control_root
                    .map(lexical_absolute_path)
                    .unwrap_or_else(|| {
                        options
                            .runtime_root
                            .as_ref()
                            .and_then(|path| path.parent())
                            .unwrap_or(&workspace_root)
                            .join("one-shot-campaign-control")
                    }),
            );
            options.dataset_mount_file = options.dataset_mount_file.map(lexical_absolute_path);
            let report = if options.action == "execute" {
                execute_autonomous_research_one_shot_campaign_attempt_v1(&options, &workspace_root)
            } else {
                inspect_autonomous_research_one_shot_campaign_attempt_v1(&options, &workspace_root)
            };
            println!("{}", serde_json::to_string_pretty(&report)?);
            std::process::exit(2);
        }
        Some(CommandV1::SubmissionHandoffExport) => {
            let options = match parse_submission_handoff_export_arguments(&args[1..]) {
                Ok(options) => options,
                Err(error) => {
                    eprintln!("{error}\n{SUBMISSION_HANDOFF_EXPORT_USAGE}");
                    std::process::exit(1);
                }
            };
            if options.help {
                println!("{SUBMISSION_HANDOFF_EXPORT_USAGE}");
                return Ok(());
            }
            let report = if options.action == "export" {
                execute_submission_handoff_export_v1(&options)?
            } else {
                inspect_submission_handoff_export_v1(&options)?
            };
            let blocked = report["status"]
                != serde_json::Value::String("submission_handoff_export_preflight_ready".into())
                || report["ready"] == serde_json::Value::Bool(false)
                || options.action == "export";
            println!("{}", serde_json::to_string_pretty(&report)?);
            if blocked {
                std::process::exit(2);
            }
        }
        Some(CommandV1::FullProductionReadiness) => {
            let mut options = match parse_full_production_readiness_arguments(&args[1..]) {
                Ok(options) => options,
                Err(error) => {
                    eprintln!("{error}\n{FULL_PRODUCTION_READINESS_USAGE}");
                    std::process::exit(1);
                }
            };
            if options.help {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&full_production_readiness_help_json_v1())?
                );
                return Ok(());
            }
            options.environment = serde_json::Value::Object(
                env::vars()
                    .map(|(key, value)| (key, serde_json::Value::String(value)))
                    .collect(),
            );
            // The Node command binds its workspace to the installed source
            // tree (`HEPTA_WORKSPACE_ROOT`), so invoking the native command
            // from another cwd must not silently switch its deployment
            // defaults to that caller directory.
            let workspace_root = default_command_workspace_v1()?;
            let report = if options.require_full_production {
                execute_full_production_readiness_v1(&options, &workspace_root)?
            } else {
                inspect_full_production_readiness_v1(&options, &workspace_root)?
            };
            println!("{}", serde_json::to_string_pretty(&report)?);
            if options.require_full_production && report["fullProductionReady"] != true {
                std::process::exit(2);
            }
        }
        Some(CommandV1::StrictFullAutoAcceptance) => {
            let options = match parse_strict_full_auto_acceptance_arguments(&args[1..]) {
                Ok(options) => options,
                Err(error) => {
                    eprintln!("{error}\n{STRICT_FULL_AUTO_ACCEPTANCE_USAGE}");
                    std::process::exit(1);
                }
            };
            if options.help {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&strict_full_auto_acceptance_help_json_v1())?
                );
                return Ok(());
            }
            let report = if options.execute {
                execute_strict_full_auto_acceptance_v1(&options)
            } else {
                inspect_strict_full_auto_acceptance_v1(&options)
            };
            println!("{}", serde_json::to_string_pretty(&report)?);
            if (options.require_accepted && report["strictFullAutoAccepted"] != true)
                || (options.require_adopted && report["ready"] != true)
            {
                std::process::exit(2);
            }
        }
        Some(CommandV1::AutonomousSupervisor) => {
            use hepta_paper_service::supervisor_health::cli::{
                SupervisorHealthEntryV1, inspect_supervisor_health_command_v1,
            };
            let result =
                inspect_supervisor_health_command_v1(&args[1..], SupervisorHealthEntryV1::Unified)?;
            println!("{}", serde_json::to_string(&result.report)?);
            if result.exit_code != 0 {
                std::process::exit(result.exit_code);
            }
        }
        Some(CommandV1::PersonalSelfHostedReadiness) => {
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
                "store-integrity [IMMUTABLE_DB] | ",
                "store-status [IMMUTABLE_DB [RUNTIME_ROOT]] [--allow-isolated-verification-evidence] | ",
                "automation-status --help [--json] | ",
                "verify-legacy-freeze IMMUTABLE_DB REPOSITORY COMMIT TREE | ",
                "store-migrate NODE_DB [TARGET_VERSION] [--timeout-ms N] | ",
                "repository-assets ROOT MANIFEST [--handoff] [--require-externalized]",
                " | command-surface ROOT [--write-package|--check-package|--npm-aliases|--help-artifact|--ci-matrix]",
                " | verify-architecture ROOT [--json] [--strict]",
                " | verify-critical [--root ABSOLUTE_PATH] [--runtime-root ABSOLUTE_PATH] [--evidence ABSOLUTE_JSON_PATH --evidence-sha256 sha256:...] [--require-ok] [--json]",
                " | verify-full --workspace-root ABSOLUTE_PATH [--require-parity] [--json]",
                " | advanced-numerical-plugin REQUEST",
                " | retirement-reference ROOT",
                " | retirement-matrix --workspace-root ABSOLUTE_PATH --runtime-root ABSOLUTE_PATH",
                " | retirement-drill-attest REQUEST",
                " | release-trust-gate REQUEST",
                " | release-state REQUEST",
                " | release-attest REQUEST",
                " | retirement-status [REQUEST]",
                " | runtime-r-source-cas REPOSITORY_ROOT [--action status|acquire] [--seed DIRECTORY | --snapshot]",
                " | research-readiness --workspace-root ABSOLUTE_PATH --runtime-root ABSOLUTE_PATH [--working-directory ABSOLUTE_PATH] [--now UNIX_MILLIS] [--require-ready]",
                " | external-authority-intake [--author-config PATH --author-config-hash sha256:...] [--release-attestor-config PATH --release-attestor-config-hash sha256:...] [--require-ready]",
                " | generic-domain-capability-evidence --action status|converge --runtime-root ABSOLUTE_PATH",
                " | research-capability-matrix --request ABSOLUTE_JSON_PATH [--require-production-ready]",
                " | local-golden-dataset-provision --action plan|execute [options]",
                " | autonomous-state-provision --action plan|execute [options]",
                " | autonomous-state-partial-root-maintenance --action plan|execute [options]",
                " | personal-gpu-operational-gate --check [--root PATH] [--runtime-root PATH] [--receipt PATH] [--help]",
                " | submission-handoff-export --campaign-id ID --bundle-root ABSOLUTE_PATH --request ABSOLUTE_JSON_PATH [--action inspect|export]",
                " | autonomous-research --action prepare|launch|status|resume|converge --paper-id ID [--launch-mode local-run|production-run|golden-bootstrap]",
                " | autonomous-research-one-shot-campaign-attempt --action plan|preflight|execute|status [--dataset-mount-file PATH|--attempt-id ID] [--root PATH --runtime-root PATH --control-root PATH]",
                " | autonomous-empirical-plugin-release --action template|plan|publish|inspect [--template ABSOLUTE_PATH] [--package-id ID --package-version SEMVER --benchmark-family FAMILY] [--signing-config ABSOLUTE_PATH] [--install-root ABSOLUTE_PATH] [--activation ABSOLUTE_PATH]",
                " | autonomous-intake-authority-rotation --action plan|apply --runtime-root PATH --next-machine-intake-config PATH --topic-producer-profile PATH [--rotation-intent PATH --expected-authority-generation N --plan-hash sha256:... --execute]",
                " | full-production-readiness --owner-trust-store PATH --owner-trust-store-sha256 sha256:... --owner-acceptance-document PATH --owner-acceptance-document-sha256 sha256:... --package-recovery-readiness-command PATH --package-recovery-readiness-command-sha256 sha256:... [--root PATH] [--runtime-root PATH] [--live-provider-canary] [--live-release-attestor] [--require-full-production]",
                " | strict-full-auto-acceptance --action plan|inspect-runtime-adoption-candidate|adoption-status|adopt-runtime|status|execute|converge --configuration ABSOLUTE_PATH [--plan-hash sha256:... --execute] [--require-accepted|--require-adopted]",
                " | personal-self-hosted-readiness [--root ABSOLUTE_PATH] [--runtime-root ABSOLUTE_PATH] [--cpu-receipt PATH] [--gpu-enabled --gpu-receipt PATH] [--require-ready] [--now ISO|UNIX_MILLIS] [--help]"
            )
            .into());
        }
    }
    Ok(())
}
