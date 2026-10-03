//! Closed ordinary grammar over the incumbent passive intake owner.
use super::{
    Control, ExternalAuthorityIntakeError, external_authority_intake_help_json_v1,
    inspect_external_authority_intake_with_environment_v1, unix_millis_to_iso_v1,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

pub const EXTERNAL_AUTHORITY_INTAKE_ENVIRONMENT_KEYS: [&str; 4] = [
    "HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG",
    "HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH",
    "HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG",
    "HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH",
];

#[derive(Debug)]
pub struct ExternalAuthorityIntakeOutputV1 {
    pub value: Value,
    pub exit_code: i32,
}

/// Relative configuration paths use the fixed ordinary deployment workspace.
/// The environment provides only the four original passive configuration fields.
pub fn external_authority_intake_cli_v1(
    argv: &[String],
    environment: &BTreeMap<String, String>,
    workspace: &Path,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<ExternalAuthorityIntakeOutputV1, Box<dyn std::error::Error>> {
    let original = ["operator", "external-authority-intake", "--"]
        .into_iter()
        .map(str::to_owned)
        .chain(argv.iter().cloned())
        .collect::<Vec<_>>();
    // The ordinary frontend and this adapter share one closed registry grammar.
    crate::canonical_cli::resolve_canonical_cli_arguments_v1(&original)?;
    let control = Control {
        cancelled,
        deadline,
    };
    control.check()?;
    let mut options = BTreeMap::new();
    let mut index = 0;
    while index < argv.len() {
        let raw = argv[index]
            .strip_prefix("--")
            .ok_or("external_authority_intake_validated_argument_invalid")?;
        let (key, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(k, v)| (k, Some(v)));
        let value = if matches!(key, "help" | "require-ready") {
            "true"
        } else if let Some(value) = inline {
            value
        } else {
            index += 1;
            argv.get(index)
                .map(String::as_str)
                .ok_or("external_authority_intake_validated_argument_invalid")?
        };
        options.insert(key.to_owned(), value.to_owned());
        index += 1;
    }
    if options.contains_key("help") {
        return Ok(ExternalAuthorityIntakeOutputV1 {
            value: external_authority_intake_help_json_v1(),
            exit_code: 0,
        });
    }
    if !workspace.is_absolute() {
        return Err("external_authority_intake_workspace_invalid".into());
    }
    let selected = |option: &str, environment_key: &str| {
        options
            .get(option)
            .or_else(|| environment.get(environment_key))
            .map(String::as_str)
    };
    let path = |option: &str, key: &str| -> Result<Option<PathBuf>, String> {
        let Some(value) = selected(option, key)
            .map(super::javascript_trim)
            .filter(|s| !s.is_empty())
        else {
            return Ok(None);
        };
        crate::native_workspace::resolve_native_workspace_root_v1(
            workspace,
            Path::new(value),
            Some(Path::new(value)),
        )
        .map(Some)
    };
    let author = path(
        "author-config",
        EXTERNAL_AUTHORITY_INTAKE_ENVIRONMENT_KEYS[0],
    )?;
    let release = path(
        "release-attestor-config",
        EXTERNAL_AUTHORITY_INTAKE_ENVIRONMENT_KEYS[2],
    )?;
    control.check()?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ExternalAuthorityIntakeError::Clock)?;
    let millis = i64::try_from(now.as_millis()).map_err(|_| ExternalAuthorityIntakeError::Clock)?;
    let report = inspect_external_authority_intake_with_environment_v1(
        author.as_deref(),
        selected(
            "author-config-hash",
            EXTERNAL_AUTHORITY_INTAKE_ENVIRONMENT_KEYS[1],
        ),
        release.as_deref(),
        selected(
            "release-attestor-config-hash",
            EXTERNAL_AUTHORITY_INTAKE_ENVIRONMENT_KEYS[3],
        ),
        &unix_millis_to_iso_v1(millis)?,
        environment,
        (cancelled, deadline),
    )?;
    control.check()?;
    let exit_code =
        if options.contains_key("require-ready") && report["readyForLiveVerification"] != true {
            2
        } else {
            0
        };
    Ok(ExternalAuthorityIntakeOutputV1 {
        value: report,
        exit_code,
    })
}
