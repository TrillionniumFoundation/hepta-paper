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
    if (group, name) == ("operator", "campaign") {
        if args.len() > 2 && args[2] != "--" {
            return Err("command_arguments_require_separator".into());
        }
        // The registry delegates its strict-child grammar and errors to the child.
        return Ok(Some(
            std::iter::once("ordinary-campaign-query".to_owned())
                .chain(args.get(3..).unwrap_or_default().iter().cloned())
                .collect(),
        ));
    }
    if (group, name) == ("operator", "autonomous-empirical-plugin-release") {
        if args.len() > 2 && args[2] != "--" {
            return Err("command_arguments_require_separator".into());
        }
        let forwarded = args.get(3..).unwrap_or_default();
        crate::autonomous_empirical_plugin_release::validate_ordinary_template_grammar_v1(
            forwarded,
        )?;
        return Ok(Some(
            std::iter::once("ordinary-autonomous-empirical-plugin-template".to_owned())
                .chain(forwarded.iter().cloned())
                .collect(),
        ));
    }
    if (group, name) == ("operator", "advanced-numerical-plugin") {
        if args.len() > 2 && args[2] != "--" {
            return Err("command_arguments_require_separator".into());
        }
        let forwarded = args.get(3..).unwrap_or_default();
        crate::ordinary_advanced_numerical_plugin::validate_ordinary_numerical_grammar_v1(
            forwarded,
        )?;
        return Ok(Some(
            std::iter::once("ordinary-advanced-numerical-plugin-status".to_owned())
                .chain(forwarded.iter().cloned())
                .collect(),
        ));
    }
    if (group, name) == ("operator", "batch") {
        if args.len() > 2 && args[2] != "--" {
            return Err("command_arguments_require_separator".into());
        }
        return Ok(Some(
            std::iter::once("paper-batch".to_owned())
                .chain(args.get(3..).unwrap_or_default().iter().cloned())
                .collect(),
        ));
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
    let (command, flags, values, maximum_positionals, forwarding_none): (
        &str,
        &[&str],
        &[&str],
        Option<usize>,
        bool,
    ) = match (group, name) {
        ("operator", "portal-target-qualification") => (
            "ordinary-portal-target-qualification",
            &["execute", "help", "require-ready"],
            &[
                "action",
                "candidate",
                "candidate-hash",
                "plan-hash",
                "registry",
                "registry-hash",
                "trust-store",
                "trust-store-hash",
            ],
            None,
            false,
        ),
        ("operator", "nested-runtime-platform-qualification") => (
            "ordinary-nested-runtime-qualification",
            &["help"],
            &[
                "config",
                "config-content-hash",
                "qualification-content-hash",
                "conformance-content-hash",
                "pod-uid",
                "plan-hash",
                "profile-id",
                "runtime-class-name",
                "parent-pod-cpu-millis",
                "parent-pod-memory-bytes",
                "parent-pod-pids",
                "qualification-key-id",
                "qualification-subject-id",
                "qualification-public-key-spki-hash",
                "conformance-key-id",
                "conformance-subject-id",
                "conformance-public-key-spki-hash",
            ],
            None,
            false,
        ),
        ("operator", "personal-gpu-operational-gate") => (
            "ordinary-personal-gpu-operational-gate",
            &["check", "help", "write"],
            &[
                "root",
                "runtime-root",
                "output-root",
                "receipt",
                "run-id",
                "deadline-ms",
            ],
            None,
            false,
        ),
        ("operator", "personal-self-hosted-readiness") => (
            "ordinary-personal-self-hosted-readiness",
            &["gpu-enabled", "help", "json", "require-ready"],
            &["gpu-receipt", "now", "root", "runtime-root"],
            None,
            false,
        ),
        ("operator", "runtime-image-reproducibility") => (
            "ordinary-runtime-image-reproducibility",
            &["help"],
            &["action", "config", "receipt", "runtime-root", "root"],
            None,
            false,
        ),
        ("operator", "external-authority-intake") => (
            "ordinary-external-authority-intake",
            &["help", "require-ready"],
            &[
                "author-config",
                "author-config-hash",
                "release-attestor-config",
                "release-attestor-config-hash",
            ],
            None,
            false,
        ),
        ("maintenance", "release-integrity-key") => (
            "ordinary-release-integrity-key",
            &["execute", "help"],
            &["action", "runtime-root"],
            None,
            false,
        ),
        ("operator", "autonomous-state-backup") => (
            "ordinary-state-backup-status",
            &["help"],
            &[
                "action",
                "runtime-root",
                "authority-config",
                "online-authority-process-config",
                "bundle",
            ],
            None,
            false,
        ),
        ("operator", "autonomous-research-one-shot-campaign-attempt") => (
            "ordinary-one-shot-status",
            &["help"],
            &[
                "action",
                "root",
                "runtime-root",
                "control-root",
                "dataset-mount-file",
                "attempt-id",
            ],
            None,
            false,
        ),
        ("operator", "runtime-r-source-cas") => (
            "ordinary-runtime-r-source-cas",
            &["help"],
            &["action", "seed", "concurrency", "root"],
            None,
            false,
        ),
        ("operator", "reconcile") => (
            "ordinary-reconcile",
            &["legacy-terminal-active-residue"],
            &["campaign-id"],
            None,
            false,
        ),
        ("operator", "workspace") => ("workspace-status", &["require-decoupled"], &[], None, false),
        ("operator", "store") => (
            "store-status",
            &[
                "allow-isolated-verification-evidence",
                "require-trust-clean",
            ],
            &[],
            None,
            false,
        ),
        ("verify", "repository-assets") => (
            "repository-assets",
            &["handoff", "require-externalized"],
            &[],
            None,
            false,
        ),
        ("verify", "store") => ("ordinary-store-integrity", &[], &[], Some(1), false),
        ("verify", "owner") => ("ordinary-owner-acceptance-status", &[], &[], None, true),
        ("verify", "operational") => ("ordinary-operational-proof-status", &[], &[], None, true),
        ("verify", "trust") => ("ordinary-release-trust-gate", &[], &[], None, true),
        ("retirement", "reference") => ("ordinary-retirement-reference", &[], &[], None, true),
        ("operator", "journal-connector-coverage") => (
            "ordinary-journal-connector-coverage",
            &[
                "help",
                "summary",
                "require-family-prototype",
                "require-profile-resolved",
                "require-adapter-implemented",
                "require-sandbox-qualified",
                "require-production-qualified",
                "require-live-ready",
            ],
            &[
                "kind",
                "qualification-registry",
                "qualification-registry-hash",
                "qualification-trust-store",
                "qualification-trust-store-hash",
                "venue",
            ],
            None,
            false,
        ),
        ("operator", "autonomous-supervisor-health") => (
            "ordinary-autonomous-supervisor-health",
            &[
                "help",
                "require-startup-reconciliation",
                "require-machine-intake-reconciliation",
                "require-current-machine-intake",
                "require-strict-machine-intake-reconciliation",
                "require-fully-autonomous",
            ],
            &["external-qualification-config", "runtime-root"],
            None,
            false,
        ),
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
    let mut index = 0;
    while index < forwarded.len() {
        let token = &forwarded[index];
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
            index += 1;
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
        if flags.contains(&key) {
            if value.is_some() {
                return Err(format!("boolean_cli_option_does_not_take_value:--{key}"));
            }
        } else {
            if !values.contains(&key) {
                return Err(format!("unknown_cli_option:--{key}"));
            }
            let value = match value {
                Some(value) => value,
                None => {
                    index += 1;
                    forwarded
                        .get(index)
                        .filter(|value| !value.starts_with("--"))
                        .map(String::as_str)
                        .ok_or_else(|| format!("missing_cli_option_value:--{key}"))?
                }
            };
            if value.is_empty() {
                return Err(format!("empty_cli_option_value:--{key}"));
            }
        }
        if !seen.insert(key) {
            return Err(format!("duplicate_cli_option:--{key}"));
        }
        index += 1;
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

/// Parameter failures use the incumbent ordinary wrapper's complete generated
/// help report. This path performs no filesystem read before refusing arguments.
pub fn canonical_cli_error_report_v1(
    args: &[String],
    error: &str,
) -> Result<serde_json::Value, serde_json::Error> {
    let mut report: serde_json::Value =
        serde_json::from_str(include_str!("data/command-surface-usage.v1.json"))?;
    report["error"] = serde_json::json!(error);
    report["requested"] = serde_json::json!({
        "group": args.first(),
        "name": args.get(1).filter(|name| !name.is_empty()),
    });
    Ok(report)
}
