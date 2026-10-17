//! Ordinary local portal-qualification facade. Imports reuse the original
//! atomic local registry owner; no network, credentials or live commit permit.
use crate::{
    canonical_cli::resolve_canonical_cli_arguments_v1,
    native_workspace::current_native_command_workspace_root_v1,
    ordinary_readonly_frontend::OrdinaryReadonlyOutputV1,
    portal_target_qualification::{
        portal_target_qualification_cli_at_v1, portal_target_qualification_cli_with_control_v1,
    },
};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub fn inspect_ordinary_portal_target_qualification_v1(
    argv: &[String],
    cancelled: Arc<AtomicBool>,
) -> Result<OrdinaryReadonlyOutputV1, String> {
    let wrapped = [
        "operator".to_owned(),
        "portal-target-qualification".to_owned(),
        "--".to_owned(),
    ]
    .into_iter()
    .chain(argv.iter().cloned())
    .collect::<Vec<_>>();
    resolve_canonical_cli_arguments_v1(&wrapped)?;
    let output = if argv.iter().any(|s| s == "--help") {
        portal_target_qualification_cli_at_v1(argv, &BTreeMap::new(), 0)
            .map_err(|e| e.to_string())?
    } else {
        let deadline = Instant::now()
            .checked_add(Duration::from_secs(120))
            .ok_or("portal_target_qualification_deadline_invalid")?;
        if cancelled.load(Ordering::Acquire) {
            return Err("portal_target_qualification_cancelled".into());
        }
        let root = current_native_command_workspace_root_v1(None)?;
        let mut environment = BTreeMap::new();
        for key in [
            "HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY",
            "HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY_HASH",
            "HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE",
            "HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE_HASH",
        ] {
            match std::env::var(key) {
                Ok(value) => {
                    environment.insert(key.to_owned(), value);
                }
                Err(std::env::VarError::NotPresent) => (),
                Err(std::env::VarError::NotUnicode(_)) => {
                    return Err(format!(
                        "portal_target_qualification_environment_encoding_invalid:{key}"
                    ));
                }
            }
        }
        let now = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "portal_target_qualification_clock_invalid")?
                .as_millis(),
        )
        .map_err(|_| "portal_target_qualification_clock_invalid")?;
        portal_target_qualification_cli_with_control_v1(
            argv,
            &environment,
            now,
            &root,
            &cancelled,
            deadline,
        )
        .map_err(|e| e.to_string())?
    };
    let mut stdout = serde_json::to_vec_pretty(&output.report)
        .map_err(|_| "portal_target_qualification_output_encoding_invalid")?;
    stdout.push(b'\n');
    Ok(OrdinaryReadonlyOutputV1 {
        stdout,
        stderr: Vec::new(),
        exit_code: output.exit_code,
    })
}
