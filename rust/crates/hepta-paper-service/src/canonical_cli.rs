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
    if (group, name) == ("maintenance", "release-attest") {
        if args.len() > 2 && args[2] != "--" {
            return Err("command_arguments_require_separator".into());
        }
        if args.len() > 3 {
            return Err("command_does_not_accept_arguments".into());
        }
        // The incumbent registry has no forwarding and already inserts the
        // explicit execute flag in its fixed argv.
        return Ok(Some(vec!["release-evidence".into(), "--execute".into()]));
    }
    if (group, name) == ("operator", "autonomous-research") {
        if args.len() > 2 && args[2] != "--" {
            return Err("command_arguments_require_separator".into());
        }
        return canonical_research_arguments_v1(args.get(3..).unwrap_or_default()).map(Some);
    }
    if (group, name) == ("maintenance", "command-surface-sync") {
        if args.len() > 2 && args[2] != "--" {
            return Err("command_arguments_require_separator".into());
        }
        if !args.get(3..).unwrap_or_default().is_empty() {
            return Err("command_does_not_accept_arguments".into());
        }
        return Ok(Some(vec!["ordinary-command-surface-sync".to_owned()]));
    }
    let (command, flags, maximum_positionals, forwarding_none): (
        &str,
        &[&str],
        Option<usize>,
        bool,
    ) = match (group, name) {
        ("operator", "workspace") => ("workspace-status", &["require-decoupled"], None, false),
        ("operator", "store") => (
            "store-status",
            &[
                "allow-isolated-verification-evidence",
                "require-trust-clean",
            ],
            None,
            false,
        ),
        ("verify", "repository-assets") => (
            "repository-assets",
            &["handoff", "require-externalized"],
            None,
            false,
        ),
        ("verify", "store") => ("ordinary-store-integrity", &[], Some(1), false),
        ("verify", "owner") => ("ordinary-owner-acceptance-status", &[], None, true),
        ("verify", "operational") => ("ordinary-operational-proof-status", &[], None, true),
        ("retirement", "reference") => ("ordinary-retirement-reference", &[], None, true),
        _ => return Err("native_canonical_route_not_implemented".into()),
    };
    if args.len() > 2 && args[2] != "--" {
        return Err("command_arguments_require_separator".into());
    }
    let forwarded = args.get(3..).unwrap_or_default();
    if forwarding_none && !forwarded.is_empty() {
        return Err("command_does_not_accept_arguments".into());
    }
    let mut seen = BTreeSet::new();
    let mut positionals = 0;
    for token in forwarded {
        if token == "--" {
            return Err("unexpected_cli_argument_separator".into());
        }
        if !token.starts_with("--")
            && let Some(maximum) = maximum_positionals
        {
            positionals += 1;
            if positionals > maximum {
                return Err(format!("too_many_cli_positionals:{positionals}"));
            }
            continue;
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

/// Validate the incumbent registry grammar before routing a business request.
/// Versioned research admission and local workflow references are explicit
/// native extensions; no incumbent credential flag becomes a native permit.
fn canonical_research_arguments_v1(args: &[String]) -> Result<Vec<String>, String> {
    const BOOLEANS: &[&str] = &[
        "help",
        "human-subjects",
        "private-data",
        "require-launch-ready",
        "require-full-ready",
        "require-bounded-golden-ready",
        "unlimited-tokens",
        "unlimited-cost",
    ];
    const VALUES: &[&str] = &[
        "action",
        "launch-mode",
        "paper-id",
        "campaign-id",
        "objective",
        "protocol-family",
        "revision-rounds",
        "referee-count",
        "root",
        "runtime-root",
        "dataset-mount-file",
        "concurrency",
        "agent-slots",
        "cpu-slots",
        "gpu-slots",
        "memory-mib",
        "max-wall-ms",
        "max-agent-calls",
        "max-cpu-jobs",
        "max-gpu-jobs",
        "max-tokens",
        "max-cost-usd",
        "agent-provider",
        "model",
        "formal-review-provider",
        "formal-review-model",
        "formal-review-codex-binary",
        "formal-review-codex-home",
        "codex-home",
        "codex-binary",
        "external-qualification-config",
        "qualification-maximum-attempts",
        "qualification-maximum-epochs",
        "qualification-maximum-total-attempts",
        "qualification-initial-backoff-ms",
        "qualification-maximum-backoff-ms",
        "qualification-deadline-ms",
        "qualification-epoch-cooldown-ms",
        "qualification-global-deadline-ms",
        "qualification-exhausted-cooldown-ms",
        "qualification-attempt-lease-ms",
        "qualification-maximum-total-cost-usd",
        "qualification-attempt-reservation-cost-usd",
        "qualification-renewal-lead-ms",
        "workflow-file",
        "workflow-root",
        "definition-hash",
        "amendment-file",
        "research-qualification-request",
        "through-steps",
        "expected-revision",
    ];
    let mut seen = BTreeSet::new();
    let mut normalized = vec!["autonomous-research".to_owned()];
    let mut index = 0;
    while index < args.len() {
        let token = &args[index];
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
        if BOOLEANS.contains(&key) {
            if inline.is_some() {
                return Err(format!("boolean_cli_option_does_not_take_value:--{key}"));
            }
            if !seen.insert(key) {
                return Err(format!("duplicate_cli_option:--{key}"));
            }
            normalized.push(format!("--{key}"));
        } else {
            if !VALUES.contains(&key) {
                return Err(format!("unknown_cli_option:--{key}"));
            }
            let value = if let Some(value) = inline {
                value
            } else {
                let value = args
                    .get(index + 1)
                    .filter(|value| !value.starts_with("--"))
                    .ok_or_else(|| format!("missing_cli_option_value:--{key}"))?;
                index += 1;
                value.as_str()
            };
            if value.is_empty() {
                return Err(format!("empty_cli_option_value:--{key}"));
            }
            if !seen.insert(key) {
                return Err(format!("duplicate_cli_option:--{key}"));
            }
            normalized.push(format!("--{key}"));
            normalized.push(value.to_owned());
        }
        index += 1;
    }
    Ok(normalized)
}
