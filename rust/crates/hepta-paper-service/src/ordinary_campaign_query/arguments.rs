//! The incumbent strict-child grammar is checked before workspace discovery.
use std::collections::{BTreeMap, BTreeSet};

const BOOLEANS: &[&str] = &[
    "execute",
    "inline",
    "json",
    "help",
    "gpu",
    "gpu-scientific",
    "effective",
    "details",
    "retain-failed-workspaces",
    "apply",
    "apply-manuscript",
    "local-only",
    "write-queue",
    "skip-quality-gates",
];
const VALUES: &[&str] = &[
    "root",
    "runtime-root",
    "mode",
    "agent-provider",
    "openclaw-agent",
    "model",
    "formal-review-provider",
    "formal-review-model",
    "formal-review-codex-binary",
    "formal-review-codex-home",
    "codex-home",
    "codex-binary",
    "ollama-model",
    "concurrency",
    "agent-slots",
    "cpu-slots",
    "gpu-slots",
    "gpu-device-selector",
    "gpu-scientific-deadline-ms",
    "memory-mib",
    "max-wall-ms",
    "max-agent-calls",
    "max-cpu-jobs",
    "max-gpu-jobs",
    "max-tokens",
    "max-cost-usd",
    "action",
    "campaign-id",
    "run-id",
    "node-id",
    "rounds",
    "referees",
    "minimum-revision-rounds",
    "quality-profile",
    "languages",
    "metric-schema",
    "benchmark-id",
    "status",
    "limit",
    "before",
    "kind",
    "reason",
    "parent-campaign-id",
    "supersedes-campaign-id",
    "recovery-of-campaign-id",
    "worker-memory-mib",
    "worker-cpu-seconds",
    "package-lifecycle-receipt-hash",
    "target",
    "venue",
    "from-venue",
];
const REPEATED: &[&str] = &[
    "paper",
    "dataset",
    "dataset-license",
    "dataset-authorization",
    "dataset-harness",
];
#[derive(Default)]
pub(super) struct Arguments {
    booleans: BTreeSet<String>,
    values: BTreeMap<String, Vec<String>>,
}
impl Arguments {
    pub(super) fn flag(&self, name: &str) -> bool {
        self.booleans.contains(name)
    }
    pub(super) fn value(&self, name: &str) -> Option<&str> {
        self.values
            .get(name)
            .and_then(|values| values.first())
            .map(String::as_str)
    }
    pub(super) fn parse(argv: &[String]) -> Result<Self, String> {
        if argv.len() > 10_000
            || argv
                .iter()
                .try_fold(0usize, |n, v| n.checked_add(v.len()))
                .is_none_or(|n| n > 4 * 1024 * 1024)
        {
            return Err("campaign_query_argument_limit_exceeded".into());
        }
        let mut parsed = Self::default();
        let mut index = 0;
        while let Some(token) = argv.get(index) {
            index += 1;
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
                if !parsed.booleans.insert(key.to_owned()) {
                    return Err(format!("duplicate_cli_option:--{key}"));
                }
                continue;
            }
            if !VALUES.contains(&key) && !REPEATED.contains(&key) {
                return Err(format!("unknown_cli_option:--{key}"));
            }
            let value = if let Some(value) = inline {
                value
            } else {
                let value = argv
                    .get(index)
                    .filter(|v| !v.starts_with("--"))
                    .ok_or_else(|| format!("missing_cli_option_value:--{key}"))?;
                index += 1;
                value
            };
            if value.is_empty() {
                return Err(format!("empty_cli_option_value:--{key}"));
            }
            if !REPEATED.contains(&key) && parsed.values.contains_key(key) {
                return Err(format!("duplicate_cli_option:--{key}"));
            }
            parsed
                .values
                .entry(key.to_owned())
                .or_default()
                .push(value.to_owned());
        }
        Ok(parsed)
    }
    pub(super) fn validate_query(&self) -> Result<&str, String> {
        if self.flag("local-only")
            && !matches!(
                self.value("mode"),
                Some("empirical-analysis" | "local-review-loop")
            )
        {
            return Err("paper_campaign_local_only_mode_invalid".into());
        }
        if self.value("campaign-id").is_some() && self.value("run-id").is_some() {
            return Err("--campaign-id and --run-id cannot be combined".into());
        }
        if self.flag("write-queue") && !self.flag("execute") {
            return Err("venue_migration_queue_persistence_requires_execute".into());
        }
        if (self.value("target").is_some() || self.value("venue").is_some())
            && self.value("from-venue").is_none()
        {
            return Err("venue_migration_source_venue_required".into());
        }
        let action = self.value("action").unwrap_or("");
        if !matches!(action, "list" | "status" | "events" | "logs") {
            return Err("native_campaign_action_not_implemented".into());
        }
        // In the incumbent this flag selects a writable bootstrap even for a
        // query. A passive observer cannot grant or ignore that writer scope.
        if self.flag("apply") {
            return Err("native_campaign_apply_authority_required".into());
        }
        Ok(action)
    }
}
