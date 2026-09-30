//! Normal group/name entrypoints. Validate forwarding before filesystem IO;
//! flat native APIs keep their explicitly documented relocation extensions.
use std::collections::BTreeSet;

/// Resolve the native ordinary entrypoints currently closed over their complete
/// argument grammar. Unimplemented ordinary routes stay explicit refusals.
pub fn resolve_canonical_cli_arguments_v1(args: &[String]) -> Result<Option<Vec<String>>, String> {
    let Some(group) = args.first().map(String::as_str) else {
        return Ok(None);
    };
    if !matches!(group, "operator" | "maintenance" | "verify" | "retirement") {
        return Ok(None);
    }
    let name = args.get(1).map(String::as_str).ok_or("unknown_command")?;
    let (command, flags): (&str, &[&str]) = match (group, name) {
        ("operator", "workspace") => ("workspace-status", &["require-decoupled"]),
        ("verify", "repository-assets") => {
            ("repository-assets", &["handoff", "require-externalized"])
        }
        _ => return Err("native_canonical_route_not_implemented".into()),
    };
    if args.len() > 2 && args[2] != "--" {
        return Err("command_arguments_require_separator".into());
    }
    let forwarded = args.get(3..).unwrap_or_default();
    let mut seen = BTreeSet::new();
    for token in forwarded {
        if token == "--" {
            return Err("unexpected_cli_argument_separator".into());
        }
        let raw = token
            .strip_prefix("--")
            .ok_or_else(|| format!("unexpected_cli_positional:{token}"))?;
        let (key, value) = raw
            .split_once('=')
            .map_or((raw, None), |(k, v)| (k, Some(v)));
        if key.is_empty() {
            return Err("empty_cli_option".into());
        }
        if !flags.contains(&key) {
            return Err(format!("unknown_cli_option:--{key}"));
        }
        if value.is_some() {
            return Err(format!("boolean_cli_option_does_not_take_value:--{key}"));
        }
        if !seen.insert(key) {
            return Err(format!("duplicate_cli_option:--{key}"));
        }
    }
    Ok(Some(
        std::iter::once(command.to_owned())
            .chain(forwarded.iter().cloned())
            .collect(),
    ))
}
