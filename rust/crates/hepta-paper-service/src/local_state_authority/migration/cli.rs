//! Explicit offline journal inspection/export. Parsing is completed before any
//! source observation, and publication starts only after the source owner has
//! closed every SQLite connection. No live migration or daemon start is exposed.
use crate::sqlite_mutation_coordinator::{Result, error, sha};
use serde_json::json;
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};

mod publication;
mod source;

const USAGE: &str = "Usage: hepta-paper-state-authority-journal <inspect|export-native-image> [options]\n\nRequired options:\n  --daemon-configuration PATH\n  --daemon-configuration-sha256 HASH\n  --online-configuration PATH\n  --online-configuration-sha256 HASH\n\nExport also requires:\n  --output-directory PATH       Fresh offline bundle directory.\n\n  --help                        Show this help after validating all arguments.\n\nPaths must be canonical absolute paths. HASH is sha256:<64 lowercase hex digits>.\nThe source database comes only from the pinned daemon configuration. Export\ncreates a separate offline artifact; it does not replace a source journal, stop\nNode, start a daemon, or authorize live migration.\n";

pub(super) struct Options {
    pub daemon_configuration: PathBuf,
    pub daemon_hash: String,
    pub online_configuration: PathBuf,
    pub online_hash: String,
    pub output_directory: Option<PathBuf>,
}

fn invalid(
    reason: &str,
    option: Option<&str>,
) -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    let mut failure = error(format!("local_authority_journal_cli_{reason}"));
    if let Some(option) = option {
        failure.details = json!({"option":option});
    }
    failure
}
fn path(value: &str, option: &str) -> Result<PathBuf> {
    let result = Path::new(value);
    if value.is_empty()
        || value.contains('\0')
        || !result.is_absolute()
        || value.contains("//")
        || (value.len() > 1 && value.ends_with('/'))
        || value.split('/').any(|p| matches!(p, "." | ".."))
        || !result
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
    {
        return Err(invalid("canonical_absolute_path_required", Some(option)));
    }
    Ok(result.to_owned())
}

fn parse(arguments: &[String]) -> Result<Option<(Options, bool)>> {
    let mut command = None;
    let mut help = false;
    let mut values = BTreeMap::new();
    let mut tokens = arguments.iter();
    while let Some(token) = tokens.next() {
        if token == "--" {
            return Err(invalid("argument_separator_unsupported", None));
        }
        let Some(raw) = token.strip_prefix("--") else {
            if command.is_some() {
                return Err(invalid("extra_positional_argument", None));
            }
            command = Some(match token.as_str() {
                "inspect" => false,
                "export-native-image" => true,
                _ => return Err(invalid("command_invalid", None)),
            });
            continue;
        };
        let (key, inline) = raw
            .split_once('=')
            .map_or((raw, None), |(key, value)| (key, Some(value)));
        if key == "help" {
            if inline.is_some() {
                return Err(invalid("help_does_not_take_value", Some(key)));
            }
            if help {
                return Err(invalid("duplicate_option", Some(key)));
            }
            help = true;
            continue;
        }
        if ![
            "daemon-configuration",
            "daemon-configuration-sha256",
            "online-configuration",
            "online-configuration-sha256",
            "output-directory",
        ]
        .contains(&key)
        {
            return Err(invalid("unknown_option", None));
        }
        if values.contains_key(key) {
            return Err(invalid("duplicate_option", Some(key)));
        }
        let value = inline
            .or_else(|| {
                tokens
                    .next()
                    .filter(|value| !value.starts_with("--"))
                    .map(String::as_str)
            })
            .ok_or_else(|| invalid("missing_option_value", Some(key)))?;
        if value.is_empty() {
            return Err(invalid("empty_option_value", Some(key)));
        }
        if key.ends_with("-sha256") {
            if !sha(&json!(value)) {
                return Err(invalid("sha256_invalid", Some(key)));
            }
        } else {
            path(value, key)?;
        }
        values.insert(key.to_owned(), value.to_owned());
    }
    if command == Some(false) && values.contains_key("output-directory") {
        return Err(invalid(
            "output_only_valid_for_export",
            Some("output-directory"),
        ));
    }
    if help {
        return Ok(None);
    }
    let export = command.ok_or_else(|| invalid("command_required", None))?;
    let mut required = |key: &str| {
        values
            .remove(key)
            .ok_or_else(|| invalid("required_option_missing", Some(key)))
    };
    let daemon_configuration = PathBuf::from(required("daemon-configuration")?);
    let daemon_hash = required("daemon-configuration-sha256")?;
    let online_configuration = PathBuf::from(required("online-configuration")?);
    let online_hash = required("online-configuration-sha256")?;
    let output_directory = if export {
        Some(PathBuf::from(required("output-directory")?))
    } else {
        None
    };
    Ok(Some((
        Options {
            daemon_configuration,
            daemon_hash,
            online_configuration,
            online_hash,
            output_directory,
        },
        export,
    )))
}

/// Return help text or one complete JSON result, including a trailing newline.
/// Errors retain their original coordinator fields, including any uncertain
/// publication details. This function does not print or hide those failures.
pub fn run_authority_journal_cli_v1(arguments: &[String]) -> Result<String> {
    let Some((options, export)) = parse(arguments)? else {
        return Ok(USAGE.to_owned());
    };
    let observed = source::read_source(&options, export)?;
    let result = if export {
        let image = observed
            .image
            .as_ref()
            .ok_or_else(|| error("local_authority_journal_image_missing"))?;
        let output = options
            .output_directory
            .as_deref()
            .ok_or_else(|| error("local_authority_journal_output_missing"))?;
        publication::publish_image(output, image, &observed.report, &observed.protected_paths)?
    } else {
        if observed.image.is_some() {
            return Err(error("local_authority_journal_unexpected_image"));
        }
        observed.report
    };
    serde_json::to_string(&result)
        .map(|value| format!("{value}\n"))
        .map_err(|_| error("local_authority_journal_output_invalid"))
}
