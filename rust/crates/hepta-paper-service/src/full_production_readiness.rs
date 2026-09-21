//! Full-production readiness with pinned independent owner and operational proof
//! verification. The five-axis policy revalidates evidence at aggregation time.
//! Package helper execution is bounded and descriptor-pinned. Live automation
//! and off-host WORM verification remain explicit blocking gates until their
//! native adapters are implemented.

#![forbid(unsafe_code)]

pub mod offhost;
pub mod owner;
mod package_recovery;
pub mod policy;

#[cfg(test)]
mod composition_tests;

use crate::deployment_environment::load_readiness_deployment_environment_v1;
use hepta_legacy_compatibility::production_hash_record_v1;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_REFERENCE_BYTES: u64 = 16 * 1024 * 1024;
const SHA256_PREFIX: &str = "sha256:";

pub const FULL_PRODUCTION_READINESS_USAGE: &str = r#"{
  "version": 1,
  "kind": "FullProductionReadinessUsage",
  "usage": "full-production-readiness --owner-trust-store PATH --owner-trust-store-sha256 sha256:... --owner-acceptance-document PATH --owner-acceptance-document-sha256 sha256:... --package-recovery-readiness-command PATH --package-recovery-readiness-command-sha256 sha256:... [--root PATH] [--runtime-root PATH] [--live-provider-canary] [--live-release-attestor] [--require-full-production]",
  "localObservationEffects": "none",
  "externalAction": "never",
  "semanticNotReadyExitCode": 2,
  "rustBoundary": "pinned owner signature and operational proof verification; package recovery execution, live automation and off-host WORM remain fail-closed"
}"#;

#[derive(Clone, Debug, Default)]
pub struct FullProductionReadinessOptions {
    pub help: bool,
    pub json: bool,
    pub live_provider_canary: bool,
    pub live_release_attestor: bool,
    pub require_full_production: bool,
    pub deployment_environment_file: Option<PathBuf>,
    pub owner_acceptance_document: Option<PathBuf>,
    pub owner_acceptance_document_sha256: Option<String>,
    pub owner_trust_store: Option<PathBuf>,
    pub owner_trust_store_sha256: Option<String>,
    pub package_recovery_readiness_command: Option<PathBuf>,
    pub package_recovery_readiness_command_sha256: Option<String>,
    pub root: Option<PathBuf>,
    pub runtime_root: Option<PathBuf>,
    /// Base environment supplied by the command boundary. The Node route
    /// starts with `process.env` and then overlays the owner-private file;
    /// tests and library callers may provide an explicit object instead.
    pub environment: Value,
}

fn option_value(args: &[String], index: &mut usize, key: &str) -> Result<String, String> {
    if *index + 1 >= args.len() || args[*index + 1].starts_with("--") {
        return Err(format!("full_production_readiness_{key}_value_required"));
    }
    let value = args[*index + 1].clone();
    *index += 2;
    Ok(value)
}

/// Parse the Node option surface with duplicate and unknown-option rejection.
pub fn parse_full_production_readiness_arguments(
    args: &[String],
) -> Result<FullProductionReadinessOptions, String> {
    let mut options = FullProductionReadinessOptions::default();
    let mut seen = std::collections::BTreeSet::new();
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        let key = flag.strip_prefix("--").unwrap_or(flag);
        if !seen.insert(key.to_owned()) {
            return Err(format!("duplicate_cli_option:{flag}"));
        }
        match flag {
            "--help" => options.help = true,
            "--json" => options.json = true,
            "--live-provider-canary" => options.live_provider_canary = true,
            "--live-release-attestor" => options.live_release_attestor = true,
            "--require-full-production" => options.require_full_production = true,
            "--deployment-environment-file" => {
                options.deployment_environment_file = Some(PathBuf::from(option_value(
                    args,
                    &mut index,
                    "deployment_environment_file",
                )?));
                continue;
            }
            "--owner-acceptance-document" => {
                options.owner_acceptance_document = Some(PathBuf::from(option_value(
                    args,
                    &mut index,
                    "owner_acceptance_document",
                )?));
                continue;
            }
            "--owner-acceptance-document-sha256" => {
                options.owner_acceptance_document_sha256 = Some(option_value(
                    args,
                    &mut index,
                    "owner_acceptance_document_sha256",
                )?);
                continue;
            }
            "--owner-trust-store" => {
                options.owner_trust_store = Some(PathBuf::from(option_value(
                    args,
                    &mut index,
                    "owner_trust_store",
                )?));
                continue;
            }
            "--owner-trust-store-sha256" => {
                options.owner_trust_store_sha256 =
                    Some(option_value(args, &mut index, "owner_trust_store_sha256")?);
                continue;
            }
            "--package-recovery-readiness-command" => {
                options.package_recovery_readiness_command = Some(PathBuf::from(option_value(
                    args,
                    &mut index,
                    "package_recovery_readiness_command",
                )?));
                continue;
            }
            "--package-recovery-readiness-command-sha256" => {
                options.package_recovery_readiness_command_sha256 = Some(option_value(
                    args,
                    &mut index,
                    "package_recovery_readiness_command_sha256",
                )?);
                continue;
            }
            "--root" => {
                options.root = Some(PathBuf::from(option_value(args, &mut index, "root")?));
                continue;
            }
            "--runtime-root" => {
                options.runtime_root = Some(PathBuf::from(option_value(
                    args,
                    &mut index,
                    "runtime_root",
                )?));
                continue;
            }
            _ => {
                return Err(format!(
                    "unsupported_full_production_readiness_argument:{flag}"
                ));
            }
        }
        index += 1;
    }
    if options.help {
        return Ok(options);
    }
    for (name, present) in [
        ("owner_trust_store", options.owner_trust_store.is_some()),
        (
            "owner_trust_store_sha256",
            options.owner_trust_store_sha256.is_some(),
        ),
        (
            "owner_acceptance_document",
            options.owner_acceptance_document.is_some(),
        ),
        (
            "owner_acceptance_document_sha256",
            options.owner_acceptance_document_sha256.is_some(),
        ),
        (
            "package_recovery_readiness_command",
            options.package_recovery_readiness_command.is_some(),
        ),
        (
            "package_recovery_readiness_command_sha256",
            options.package_recovery_readiness_command_sha256.is_some(),
        ),
    ] {
        if !present {
            return Err(format!("full_production_readiness_{name}_required"));
        }
    }
    if let Some(path) = options.deployment_environment_file.as_ref()
        && !path.is_absolute()
    {
        return Err(
            "full_production_readiness_deployment_environment_file_must_be_absolute".to_owned(),
        );
    }
    for (name, path) in [
        ("owner_trust_store", options.owner_trust_store.as_ref()),
        (
            "owner_acceptance_document",
            options.owner_acceptance_document.as_ref(),
        ),
        (
            "package_recovery_readiness_command",
            options.package_recovery_readiness_command.as_ref(),
        ),
    ] {
        if path.is_some_and(|path| !path.is_absolute()) {
            return Err(format!("full_production_readiness_{name}_must_be_absolute"));
        }
    }
    Ok(options)
}

fn valid_sha256(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        value.strip_prefix(SHA256_PREFIX).is_some_and(|hex| {
            hex.len() == 64
                && hex
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
    })
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn read_stable_regular(path: &Path, expected: &fs::Metadata) -> Option<Vec<u8>> {
    let parent = path.parent()?;
    let parent_before = fs::symlink_metadata(parent).ok()?;
    if !parent_before.is_dir() || fs::canonicalize(parent).ok()?.as_path() != parent {
        return None;
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC);
    let mut file = options.open(path).ok()?;
    let before = file.metadata().ok()?;
    if !before.is_file() || before.nlink() != 1 || before.len() > MAX_REFERENCE_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.by_ref()
        .take(MAX_REFERENCE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let after = file.metadata().ok()?;
    let path_after = fs::symlink_metadata(path).ok()?;
    let parent_after = fs::symlink_metadata(parent).ok()?;
    let stable = expected.dev() == path_after.dev()
        && expected.ino() == path_after.ino()
        && expected.mode() == path_after.mode()
        && expected.nlink() == path_after.nlink()
        && expected.len() == path_after.len()
        && expected.mtime() == path_after.mtime()
        && expected.mtime_nsec() == path_after.mtime_nsec()
        && before.dev() == after.dev()
        && before.ino() == after.ino()
        && before.mode() == after.mode()
        && before.nlink() == after.nlink()
        && before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && parent_before.dev() == parent_after.dev()
        && parent_before.ino() == parent_after.ino()
        && parent_before.mode() == parent_after.mode()
        && parent_before.nlink() == parent_after.nlink()
        && fs::canonicalize(parent).ok()?.as_path() == parent
        && bytes.len() as u64 <= MAX_REFERENCE_BYTES;
    stable.then_some(bytes)
}

fn inspect_reference(path: Option<&Path>, expected_hash: Option<&str>, executable: bool) -> Value {
    let path_text = path.map(|path| path.to_string_lossy().into_owned());
    let absolute = path.is_some_and(Path::is_absolute);
    let hash_format_valid = valid_sha256(expected_hash);
    let (is_regular, is_symlink, mode, nlink, observed_hash, size) =
        path.map_or((false, false, None, None, None, None), |path| {
            let link = fs::symlink_metadata(path).ok();
            let is_symlink = link
                .as_ref()
                .is_some_and(|value| value.file_type().is_symlink());
            let is_regular = link
                .as_ref()
                .is_some_and(|value| value.file_type().is_file());
            let mode = link.as_ref().map(|value| value.permissions().mode());
            let nlink = link.as_ref().map(MetadataExt::nlink);
            let size = link.as_ref().map(|value| value.len());
            let bytes = (is_regular
                && !is_symlink
                && nlink == Some(1)
                && size.unwrap_or(0) <= MAX_REFERENCE_BYTES)
                .then(|| {
                    link.as_ref()
                        .and_then(|metadata| read_stable_regular(path, metadata))
                })
                .flatten();
            let observed_hash = bytes.as_deref().map(digest);
            (is_regular, is_symlink, mode, nlink, observed_hash, size)
        });
    let executable_ok =
        !executable || mode.is_some_and(|mode| mode & 0o111 != 0 && mode & 0o222 == 0);
    let hash_matches = hash_format_valid && observed_hash.as_deref() == expected_hash;
    json!({
        "path": path_text,
        "absolute": absolute,
        "regular": is_regular,
        "symlink": is_symlink,
        "mode": mode,
        "nlink": nlink,
        "size": size,
        "expectedSha256": expected_hash,
        "observedSha256": observed_hash,
        "hashFormatValid": hash_format_valid,
        "hashMatches": hash_matches,
        "executableReferenceValid": executable_ok,
        "singleLink": nlink == Some(1),
        "referenceValid": absolute && is_regular && !is_symlink && nlink == Some(1) && hash_matches && executable_ok,
    })
}

fn blocker(blockers: &mut Vec<String>, value: &str) {
    blockers.push(value.to_owned());
}

/// Match Node's `path.resolve` at the command boundary.  The Node route
/// accepts relative root values (including relative deployment-environment
/// values) and resolves them from the process working directory before
/// passing them into the readiness query.
fn resolve_path_from_process(path: PathBuf) -> PathBuf {
    let candidate = if path.is_absolute() {
        path
    } else {
        std::env::current_dir().map_or(path.clone(), |cwd| cwd.join(path))
    };
    let mut resolved = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::RootDir => resolved.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(value) => resolved.push(value),
            Component::Prefix(value) => resolved.push(value.as_os_str()),
        }
    }
    resolved
}

/// Defaults corresponding to `defaultPaperAssetRoot()` and
/// `defaultPaperRuntimeRoot()` from the incumbent workspace-layout module.
fn default_asset_root(workspace_root: &Path) -> PathBuf {
    let parent = workspace_root.parent().unwrap_or(workspace_root);
    if parent
        .file_name()
        .is_some_and(|name| name == "paper_factory")
    {
        parent.to_path_buf()
    } else {
        parent.join("hepta-paper-assets")
    }
}

fn default_runtime_root(workspace_root: &Path) -> PathBuf {
    workspace_root
        .parent()
        .unwrap_or(workspace_root)
        .join("hepta-paper-runtime/native-runtime")
}

pub fn full_production_readiness_help_json_v1() -> Value {
    serde_json::from_str(FULL_PRODUCTION_READINESS_USAGE)
        .expect("static full production readiness usage JSON")
}

/// Inspect local references without executing or mutating anything.
pub fn inspect_full_production_readiness_v1(
    options: &FullProductionReadinessOptions,
    workspace_root: &Path,
) -> Result<Value, String> {
    inspect_with_owner_references(options, workspace_root, owner::PinnedOwnerReferences::open)
}

fn inspect_with_owner_references(
    options: &FullProductionReadinessOptions,
    workspace_root: &Path,
    pin_owner: impl Fn(
        &Path,
        &str,
        &Path,
        &str,
    )
        -> Result<owner::PinnedOwnerReferences, owner::OwnerAcceptanceInspectionError>,
) -> Result<Value, String> {
    let workspace_root = resolve_path_from_process(workspace_root.to_path_buf());
    if !workspace_root.is_absolute() {
        return Err("full_production_readiness_workspace_root_must_be_absolute".to_owned());
    }
    let base_environment = if options.environment.is_object() {
        options.environment.clone()
    } else {
        json!({})
    };
    let deployment_environment = load_readiness_deployment_environment_v1(
        &base_environment,
        options.deployment_environment_file.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    let root = options
        .root
        .clone()
        .or_else(|| {
            deployment_environment.environment["HEPTA_PAPER_ASSET_ROOT"]
                .as_str()
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| default_asset_root(&workspace_root));
    let runtime_root = options
        .runtime_root
        .clone()
        .or_else(|| {
            deployment_environment.environment["HEPTA_PAPER_RUNTIME_ROOT"]
                .as_str()
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| default_runtime_root(&workspace_root));
    let root = resolve_path_from_process(root);
    let runtime_root = resolve_path_from_process(runtime_root);
    let owner_trust = inspect_reference(
        options.owner_trust_store.as_deref(),
        options.owner_trust_store_sha256.as_deref(),
        false,
    );
    let owner_acceptance = inspect_reference(
        options.owner_acceptance_document.as_deref(),
        options.owner_acceptance_document_sha256.as_deref(),
        false,
    );
    let package_command = inspect_reference(
        options.package_recovery_readiness_command.as_deref(),
        options.package_recovery_readiness_command_sha256.as_deref(),
        true,
    );
    let offhost_contract_path =
        workspace_root.join("paper-core/config/offhost-worm-contract.v1.json");
    let offhost_contract = fs::read(&offhost_contract_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let mut blockers = vec![
        "rust_full_production_offhost_worm_custody_verification_not_ported".to_owned(),
        "rust_full_production_automation_plane_aggregation_not_ported".to_owned(),
    ];
    let references = match (
        options.owner_trust_store.as_deref(),
        options.owner_trust_store_sha256.as_deref(),
        options.owner_acceptance_document.as_deref(),
        options.owner_acceptance_document_sha256.as_deref(),
    ) {
        (Some(trust), Some(trust_hash), Some(acceptance), Some(acceptance_hash)) => {
            pin_owner(trust, trust_hash, acceptance, acceptance_hash)
                .map_err(|error| error.to_string())
        }
        _ => Err("full_production_owner_acceptance_reference_invalid".to_owned()),
    };
    let mut inspection_errors = Vec::new();
    if let Err(error) = &references {
        inspection_errors.push(error.clone());
    }
    let references = references.ok();
    let owner_inspection = references.as_ref().and_then(|references| {
        references
            .inspect_workspace(&workspace_root)
            .map_err(|error| {
                inspection_errors.push(error.to_string());
            })
            .ok()
    });
    let operational_inspection = references.as_ref().and_then(|references| {
        crate::operational_status::production::inspect_production_proofs(
            &workspace_root,
            &runtime_root,
            references.trust_document(),
        )
        .map_err(|error| {
            inspection_errors.push(error.to_string());
        })
        .ok()
    });
    let owner_report = owner_inspection.as_ref().map(|inspection| inspection.report().clone())
        .unwrap_or_else(|| json!({
            "version": 1, "kind": "IndependentExternalOwnerAcceptanceInspection",
            "status": "independent_external_owner_acceptance_blocked",
            "externallyAccepted": 0, "required": owner::FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED,
            "familyManifestBound": false, "familyManifestHash": null,
            "localAdminAccepted": 0, "automaticAcceptanceForbidden": true,
        }));
    // A missing source observation never receives a fabricated commit identity.
    let operational_report = operational_inspection.as_ref().map(|inspection| inspection.report.clone())
        .unwrap_or_else(|| json!({
            "version": 1, "kind": "IndependentProductionOperationalProofInspection",
            "status": "independent_production_operational_proof_blocked",
            "releaseCommit": null, "verified": 0,
            "required": policy::FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS.len(),
            "capabilities": policy::FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS.iter().map(|id| json!({
                "capabilityId": id, "verified": false, "operationalReceiptHashes": [], "issuerAssurances": [],
            })).collect::<Vec<_>>(),
            "externalIndependentRequired": true, "conformanceCannotQualify": true,
        }));
    if owner_trust["referenceValid"] != true {
        blocker(&mut blockers, "owner_trust_store_reference_invalid");
    }
    if owner_acceptance["referenceValid"] != true {
        blocker(&mut blockers, "owner_acceptance_document_reference_invalid");
    }
    if package_command["referenceValid"] != true {
        blocker(
            &mut blockers,
            "package_recovery_readiness_command_reference_invalid",
        );
    }
    let contract_id = offhost_contract
        .as_ref()
        .filter(|value| value["version"] == 1 && value["kind"] == "OffhostWormSnapshotContract")
        .and_then(|value| value["contractId"].as_str())
        .filter(|id| !id.is_empty());
    if contract_id.is_none() {
        blocker(&mut blockers, "offhost_worm_contract_invalid");
    }
    if !options.live_provider_canary {
        blocker(&mut blockers, "live_provider_canary_not_requested");
    }
    if !options.live_release_attestor {
        blocker(&mut blockers, "live_release_attestor_not_requested");
    }
    let package_inspection = match (
        options.package_recovery_readiness_command.as_deref(),
        options.package_recovery_readiness_command_sha256.as_deref(),
    ) {
        (Some(command), Some(command_hash)) if package_command["referenceValid"] == true => {
            match package_recovery::query_package_retention_recovery_readiness_v1(
                command,
                command_hash,
                &root,
                &runtime_root,
                &workspace_root,
                &deployment_environment.environment,
            ) {
                Ok(result) => result["inspection"].clone(),
                Err(error) => {
                    inspection_errors.push(error);
                    json!({
                        "version": 1, "kind": "PackageRetentionRecoveryReadinessInspection",
                        "status": "not_executed", "ready": false,
                    })
                }
            }
        }
        _ => json!({
            "version": 1, "kind": "PackageRetentionRecoveryReadinessInspection",
            "status": "not_executed", "ready": false,
        }),
    };
    // Keep the nested value on the exact Node protocol boundary even when no
    // native mount/custody probe has run. This is a blocked observation, not a
    // fabricated qualification claim.
    let worm_contract_id = contract_id.unwrap_or("invalid-contract");
    let worm_target_root = offhost_contract
        .as_ref()
        .and_then(|value| value["targetMountRoot"].as_str())
        .filter(|value| value.starts_with('/'))
        .unwrap_or("/");
    let worm_inspection = json!({
        "version": 1, "kind": "OffhostWormTargetStatus",
        "status": "offhost_worm_target_blocked",
        "contractId": worm_contract_id,
        "targetMountRoot": worm_target_root,
        "mountAvailable": false, "mountIdentity": null, "mountObservationHash": null,
        "targetDirectoryIdentity": null, "targetDeviceMajorMinor": null, "targetMountId": null,
        "mountDeviceMatchesTarget": false, "mountIdMatchesTarget": false,
        "expectedStorageIdentityHash": null, "storageIdentityMatchesContract": false,
        "distinctDevice": false, "storageIdentityHash": null,
        "custodyRequired": true, "currentProtectionLevel": "unknown",
        "custodyDeclaredQualified": false, "offHostOrOffsiteCustodyQualified": false,
        "custodyStatus": "offhost_or_offsite_custody_blocked", "custodyBlockers": [
            "rust_full_production_offhost_worm_custody_verification_not_ported"
        ],
        "custodyEvidenceStatus": "offhost_worm_custody_evidence_blocked",
        "custodyEvidenceBundleHash": null, "custodyTrustStoreHash": null,
        "custodyEvidenceExpiresAt": null,
        "blockers": ["rust_full_production_offhost_worm_custody_verification_not_ported"],
    });
    let automation_report = json!({
        "version": 2, "kind": "AutomationPlaneStatus",
        "status": "rust_automation_aggregation_not_ported", "productionReady": false,
    });
    let now_millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "full_production_readiness_clock_invalid".to_owned())?
        .as_millis();
    let now_millis = i64::try_from(now_millis)
        .map_err(|_| "full_production_readiness_clock_invalid".to_owned())?;
    let observed_at = crate::external_authority_intake::unix_millis_to_iso_v1(now_millis)
        .map_err(|_| "full_production_readiness_clock_invalid".to_owned())?;
    let aggregate = policy::evaluate_full_production_readiness_v1(&json!({
        "automationReport": automation_report,
        "packageRetentionRecoveryInspection": package_inspection,
        "offhostWormCustodyInspection": worm_inspection,
        "independentExternalOwnerAcceptanceInspection": owner_report,
        "independentProductionOperationalProofInspection": operational_report,
        "offhostWormContractId": contract_id,
        "observedAt": observed_at,
    }));
    let mut payload = match aggregate {
        Ok(report) => report,
        Err(error) => {
            inspection_errors.push(error.to_string());
            json!({
                "version": 1, "kind": "FullProductionReadinessStatus",
                "status": "full_production_blocked", "fullProductionStatus": "full_production_blocked",
                "fullProductionReady": false, "observedAt": observed_at,
                "automationPlaneStatus": automation_report["status"], "automationPlaneReady": false,
                "packageRetentionRecoveryReady": false, "packageRetentionRecoveryInspection": package_inspection,
                "offhostWormCustodyReady": false, "offhostWormCustodyInspection": worm_inspection,
                "independentExternalOwnerAcceptanceReady": false,
                "independentExternalOwnerAcceptanceInspection": owner_report,
                "independentProductionOperationalProofReady": false,
                "independentProductionOperationalProofInspection": operational_report,
            })
        }
    };
    if let Some(policy_blockers) = payload["blockers"].as_array() {
        blockers.extend(
            policy_blockers
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned),
        );
    }
    blockers.extend(inspection_errors.iter().cloned());
    blockers.sort();
    blockers.dedup();
    let object = payload.as_object_mut().expect("readiness report object");
    object.remove("fullProductionReadinessStatusHash");
    object.extend(json!({
        "root": root, "runtimeRoot": runtime_root,
        "deploymentEnvironment": deployment_environment.inspection,
        "references": {"ownerTrustStore": owner_trust, "ownerAcceptanceDocument": owner_acceptance, "packageRecoveryReadinessCommand": package_command},
        "offhostWormContract": offhost_contract.as_ref().map(|value| json!({"version": value["version"], "kind": value["kind"], "contractId": value["contractId"]})),
        "liveProviderCanaryRequested": options.live_provider_canary,
        "liveReleaseAttestorVerificationRequested": options.live_release_attestor,
        "externalActionPerformed": false, "serviceStateChanged": false,
        "blockers": blockers, "inspectionErrors": inspection_errors,
        "rustBoundary": "pinned-owner-and-operational-proof-verification",
    }).as_object().expect("metadata object").clone());
    // Retain the original source and authority snapshots through aggregation.
    // A replacement invalidates the observation instead of retaining an earlier
    // positive count in a newly hashed report.
    if let Some(inspection) = &owner_inspection {
        inspection
            .assert_current()
            .map_err(|error| error.to_string())?;
    }
    if let Some(inspection) = &operational_inspection {
        inspection
            .assert_current()
            .map_err(|error| error.to_string())?;
    }
    if let Some(references) = &references {
        references
            .assert_current()
            .map_err(|error| error.to_string())?;
    }
    let hash = production_hash_record_v1("FullProductionReadinessStatus", &payload)
        .map_err(|_| "full_production_readiness_status_hash_failed".to_owned())?;
    let mut report = payload;
    report["fullProductionReadinessStatusHash"] = json!(hash.as_str());
    Ok(report)
}

pub fn execute_full_production_readiness_v1(
    options: &FullProductionReadinessOptions,
    workspace_root: &Path,
) -> Result<Value, String> {
    inspect_full_production_readiness_v1(options, workspace_root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[test]
    fn parser_requires_all_pinned_inputs_and_rejects_duplicates() {
        assert!(parse_full_production_readiness_arguments(&[]).is_err());
        assert!(
            parse_full_production_readiness_arguments(&["--help".into(), "--help".into()]).is_err()
        );
        assert!(
            parse_full_production_readiness_arguments(&[
                "--deployment-environment-file".into(),
                "relative.env".into(),
                "--owner-trust-store".into(),
                "/tmp/trust".into(),
                "--owner-trust-store-sha256".into(),
                format!("{SHA256_PREFIX}{}", "a".repeat(64)),
                "--owner-acceptance-document".into(),
                "/tmp/acceptance".into(),
                "--owner-acceptance-document-sha256".into(),
                format!("{SHA256_PREFIX}{}", "b".repeat(64)),
                "--package-recovery-readiness-command".into(),
                "/tmp/command".into(),
                "--package-recovery-readiness-command-sha256".into(),
                format!("{SHA256_PREFIX}{}", "c".repeat(64)),
            ])
            .is_err()
        );
    }

    #[test]
    fn inspection_is_always_blocked_and_never_claims_external_action() {
        let options = FullProductionReadinessOptions {
            root: Some(PathBuf::from("/tmp/root")),
            runtime_root: Some(PathBuf::from("/tmp/runtime")),
            ..Default::default()
        };
        let report =
            inspect_full_production_readiness_v1(&options, Path::new("/tmp/workspace")).unwrap();
        assert_eq!(report["fullProductionReady"], false);
        assert_eq!(report["externalActionPerformed"], false);
        assert!(report["blockers"].as_array().unwrap().len() >= 5);
    }

    #[test]
    fn explicit_deployment_environment_selects_default_roots_and_is_reported() {
        let path = std::env::temp_dir().join(format!(
            "hepta-full-production-environment-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(
            &path,
            "HEPTA_PAPER_ASSET_ROOT=/srv/hepta/assets\nHEPTA_PAPER_RUNTIME_ROOT=/srv/hepta/runtime\n",
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let options = FullProductionReadinessOptions {
            deployment_environment_file: Some(path.clone()),
            ..Default::default()
        };
        let report =
            inspect_full_production_readiness_v1(&options, Path::new("/tmp/workspace")).unwrap();
        assert_eq!(report["root"], "/srv/hepta/assets");
        assert_eq!(report["runtimeRoot"], "/srv/hepta/runtime");
        assert_eq!(
            report["deploymentEnvironment"]["status"],
            "automation_readiness_deployment_environment_loaded"
        );
        assert_eq!(
            report["deploymentEnvironment"]["loadedKeys"],
            json!(["HEPTA_PAPER_ASSET_ROOT", "HEPTA_PAPER_RUNTIME_ROOT"])
        );
        assert!(
            report["deploymentEnvironment"]["fileHash"]
                .as_str()
                .is_some_and(|hash| hash.starts_with(SHA256_PREFIX))
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn ambient_environment_selects_default_roots_without_file() {
        let options = FullProductionReadinessOptions {
            environment: json!({
                "HEPTA_PAPER_ASSET_ROOT": "/ambient/hepta/assets",
                "HEPTA_PAPER_RUNTIME_ROOT": "/ambient/hepta/runtime",
            }),
            ..Default::default()
        };
        let report =
            inspect_full_production_readiness_v1(&options, Path::new("/tmp/workspace")).unwrap();
        assert_eq!(report["root"], "/ambient/hepta/assets");
        assert_eq!(report["runtimeRoot"], "/ambient/hepta/runtime");
        assert_eq!(
            report["deploymentEnvironment"]["status"],
            "automation_readiness_ambient_environment_observed"
        );
        assert_eq!(report["deploymentEnvironment"]["filePath"], Value::Null);
        assert_eq!(report["deploymentEnvironment"]["loadedKeys"], json!([]));
    }

    #[test]
    fn roots_match_node_path_resolve_and_workspace_layout_defaults() {
        let workspace = Path::new("/tmp/hepta-production-workspace");
        let options = FullProductionReadinessOptions {
            root: Some(PathBuf::from("./relative-assets/../assets")),
            runtime_root: Some(PathBuf::from("./relative-runtime/../runtime")),
            ..Default::default()
        };
        let cwd = std::env::current_dir().unwrap();
        let report = inspect_full_production_readiness_v1(&options, workspace).unwrap();
        assert_eq!(
            report["root"],
            cwd.join("assets").to_string_lossy().as_ref()
        );
        assert_eq!(
            report["runtimeRoot"],
            cwd.join("runtime").to_string_lossy().as_ref()
        );

        let defaults = inspect_full_production_readiness_v1(
            &FullProductionReadinessOptions::default(),
            workspace,
        )
        .unwrap();
        assert_eq!(defaults["root"], "/tmp/hepta-paper-assets");
        assert_eq!(
            defaults["runtimeRoot"],
            "/tmp/hepta-paper-runtime/native-runtime"
        );
    }
}
