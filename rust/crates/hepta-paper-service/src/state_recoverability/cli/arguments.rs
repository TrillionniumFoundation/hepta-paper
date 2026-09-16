use super::*;
pub const USAGE: &str = "Usage: autonomous-research-state-backup --action status|backup|restore-drill|renew|reconcile-and-renew [options]\n\n  status                         Inspect canonical state-database coverage.\n  backup                         Create an externally fenced, authority-finalized bundle.\n  restore-drill                  Verify a bundle against the live external authority head.\n  renew                          Atomically create a backup and drill that exact bundle.\n  reconcile-and-renew            Reconcile all online mutation finalizations, then renew.\n  --runtime-root PATH            Runtime root to inspect or back up.\n  --authority-config PATH        External broker process configuration (required for writes/drills).\n  --online-authority-process-config PATH\n                                 Pinned online mutation authority process configuration.\n  --bundle PATH                  Bundle directory for restore-drill.\n\nNo local flag can replace the signed linearizable authority-head protocol.";
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StateBackupActionV1 {
    Status,
    Backup,
    RestoreDrill,
    Renew,
    ReconcileAndRenew,
}
impl StateBackupActionV1 {
    pub(super) fn ready_status(self) -> &'static str {
        match self {
            Self::Status => "autonomous_research_state_database_inventory_ready",
            Self::Backup => "autonomous_research_state_backup_recorded",
            Self::RestoreDrill => "autonomous_research_state_restore_drill_passed",
            Self::Renew => "autonomous_research_state_backup_renewal_complete",
            Self::ReconcileAndRenew => "autonomous_research_state_reconcile_and_renew_complete",
        }
    }
}
pub(super) struct Arguments {
    pub help: bool,
    pub action: StateBackupActionV1,
    pub runtime: Option<String>,
    pub backup_configuration: Option<String>,
    pub online_configuration: Option<String>,
    pub bundle: Option<String>,
}
pub(super) fn parse(argv: &[String]) -> std::result::Result<Arguments, String> {
    let mut parsed = std::collections::BTreeMap::new();
    let mut tokens = argv.iter();
    while let Some(token) = tokens.next() {
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
        let value = if key == "help" {
            if inline.is_some() {
                return Err("boolean_cli_option_does_not_take_value:--help".into());
            }
            String::new()
        } else {
            if ![
                "action",
                "runtime-root",
                "authority-config",
                "online-authority-process-config",
                "bundle",
            ]
            .contains(&key)
            {
                return Err(format!("unknown_cli_option:--{key}"));
            }
            let value = inline
                .or_else(|| {
                    tokens
                        .next()
                        .filter(|next| !next.starts_with("--"))
                        .map(String::as_str)
                })
                .ok_or_else(|| format!("missing_cli_option_value:--{key}"))?;
            if value.is_empty() {
                return Err(format!("empty_cli_option_value:--{key}"));
            }
            value.into()
        };
        if parsed.insert(key.to_owned(), value).is_some() {
            return Err(format!("duplicate_cli_option:--{key}"));
        }
    }
    let help = parsed.contains_key("help");
    // The incumbent validates every token before --help, but help takes
    // precedence over action selection and its action-specific requirements.
    let action = if help {
        StateBackupActionV1::Status
    } else {
        match parsed.get("action").map_or("status", String::as_str) {
            "status" => StateBackupActionV1::Status,
            "backup" => StateBackupActionV1::Backup,
            "restore-drill" => StateBackupActionV1::RestoreDrill,
            "renew" => StateBackupActionV1::Renew,
            "reconcile-and-renew" => StateBackupActionV1::ReconcileAndRenew,
            other => {
                return Err(format!(
                    "autonomous_research_state_backup_action_invalid:{other}"
                ));
            }
        }
    };
    if action == StateBackupActionV1::RestoreDrill && !parsed.contains_key("bundle") {
        return Err("autonomous_research_state_backup_bundle_required".into());
    }
    if action == StateBackupActionV1::ReconcileAndRenew
        && (!parsed.contains_key("authority-config")
            || !parsed.contains_key("online-authority-process-config"))
    {
        return Err(
            "autonomous_research_state_reconcile_and_renew_authority_configuration_required".into(),
        );
    }
    Ok(Arguments {
        help,
        action,
        runtime: parsed.remove("runtime-root"),
        backup_configuration: parsed.remove("authority-config"),
        online_configuration: parsed.remove("online-authority-process-config"),
        bundle: parsed.remove("bundle"),
    })
}
/// Node's POSIX path.resolve semantics. It normalizes lexical parent components
/// before any filesystem access; it does not follow symlinks or create paths.
pub(super) fn resolve(cwd: &Path, input: &Path) -> Result<PathBuf> {
    ensure(
        cwd.is_absolute(),
        "autonomous_research_state_backup_working_directory_invalid",
    )?;
    let input = if input.is_absolute() {
        input.to_owned()
    } else {
        cwd.join(input)
    };
    let mut resolved = PathBuf::from("/");
    for component in input.components() {
        match component {
            std::path::Component::Normal(name) => resolved.push(name),
            std::path::Component::ParentDir => {
                resolved.pop();
            }
            std::path::Component::RootDir | std::path::Component::CurDir => (),
            std::path::Component::Prefix(_) => {
                return Err(error("autonomous_research_state_backup_path_invalid"));
            }
        }
    }
    ensure(
        resolved.to_str().is_some(),
        "autonomous_research_state_backup_path_invalid",
    )?;
    Ok(resolved)
}
