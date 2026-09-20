//! Exact local tracked-source secret policy inspection for personal readiness.
//!
//! This module mirrors the incumbent `source-supply-chain-security.mjs` secret
//! policy boundary. It deliberately returns only readiness and never returns
//! matched source lines or secret material.

#![forbid(unsafe_code)]

use regex::Regex;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    process::Command,
};

const POLICY_RELATIVE_PATH: &str = "paper-core/config/source-supply-chain-security-policy.v1.json";
const MAX_POLICY_BYTES: u64 = 128 * 1024;

const ASSURANCE_BOUNDARY: [(&str, &str); 4] = [
    (
        "sast",
        "bounded_high_confidence_source_patterns_not_complete_program_analysis",
    ),
    (
        "secretScan",
        "git_tracked_regular_text_files_high_confidence_patterns",
    ),
    (
        "sbom",
        "local_package_lock_inventory_not_external_attestation",
    ),
    (
        "container",
        "digest_identity_and_explicit_non_deployable_template_placeholder_policy_not_cve_database_scan",
    ),
];

#[derive(Clone, Debug)]
struct AllowlistEntry {
    path: String,
    rule_id: String,
    line_sha256: String,
}

#[derive(Clone, Debug)]
struct TrackedText {
    path: String,
    text: String,
}

fn safe_relative_path(value: &str) -> Option<String> {
    let normalized = value.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized == ".."
        || normalized.starts_with("../")
        || normalized.contains("/../")
    {
        return None;
    }
    Some(normalized)
}

fn sha256_line(line: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(line.as_bytes()))
}

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn secret_rule_ids() -> [&'static str; 7] {
    [
        "pem-private-key",
        "aws-access-key-id",
        "github-token",
        "google-api-key",
        "openai-project-key",
        "slack-token",
        "stripe-live-secret",
    ]
}

fn secret_patterns() -> Option<Vec<(&'static str, Regex)>> {
    [
        (
            "pem-private-key",
            r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----",
        ),
        ("aws-access-key-id", r"\bAKIA[0-9A-Z]{16}\b"),
        ("github-token", r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b"),
        ("google-api-key", r"\bAIza[0-9A-Za-z_-]{35}\b"),
        ("openai-project-key", r"\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b"),
        ("slack-token", r"\bxox[baprs]-[0-9A-Za-z-]{20,}\b"),
        ("stripe-live-secret", r"\bsk_live_[0-9A-Za-z]{20,}\b"),
    ]
    .into_iter()
    .map(|(id, pattern)| Regex::new(pattern).ok().map(|regex| (id, regex)))
    .collect()
}

fn parse_policy(root: &Path) -> Option<Vec<AllowlistEntry>> {
    let path = root.join(POLICY_RELATIVE_PATH);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_POLICY_BYTES
    {
        return None;
    }
    let bytes = read_stable_file(&path, &metadata).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let object = value.as_object()?;
    let mut keys = object.keys().cloned().collect::<Vec<_>>();
    keys.sort();
    if keys
        != vec![
            "assuranceBoundary",
            "kind",
            "sbomPath",
            "secretAllowlist",
            "version",
        ]
    {
        return None;
    }
    if object.get("version")?.as_i64()? != 1
        || object.get("kind")?.as_str()? != "SourceSupplyChainSecurityPolicy"
        || object.get("sbomPath")?.as_str()?
            != "paper-core/config/source-supply-chain-sbom.cdx.json"
    {
        return None;
    }
    let assurance = object.get("assuranceBoundary")?.as_object()?;
    let assurance_keys = assurance.keys().cloned().collect::<BTreeSet<_>>();
    if assurance_keys
        != ASSURANCE_BOUNDARY
            .iter()
            .map(|(key, _)| (*key).to_owned())
            .collect::<BTreeSet<_>>()
    {
        return None;
    }
    for (key, expected) in ASSURANCE_BOUNDARY {
        if assurance.get(key)?.as_str()? != expected {
            return None;
        }
    }
    let allowlist = object.get("secretAllowlist")?.as_array()?;
    let rule_ids = secret_rule_ids();
    let mut seen = BTreeSet::new();
    let mut parsed = Vec::with_capacity(allowlist.len());
    for entry in allowlist {
        let entry = entry.as_object()?;
        let mut keys = entry.keys().cloned().collect::<Vec<_>>();
        keys.sort();
        if keys != vec!["lineSha256", "path", "reason", "ruleId"] {
            return None;
        }
        let path = safe_relative_path(entry.get("path")?.as_str()?)?;
        let rule_id = entry.get("ruleId")?.as_str()?.to_owned();
        if !rule_ids.contains(&rule_id.as_str()) {
            return None;
        }
        let line_sha256 = entry.get("lineSha256")?.as_str()?.to_owned();
        if !valid_sha256(&line_sha256) {
            return None;
        }
        if entry.get("reason")?.as_str()?.trim().is_empty() {
            return None;
        }
        let identity = format!("{path}\0{rule_id}\0{line_sha256}");
        if !seen.insert(identity) {
            return None;
        }
        parsed.push(AllowlistEntry {
            path,
            rule_id,
            line_sha256,
        });
    }
    Some(parsed)
}

fn read_stable_file(path: &Path, before: &std::fs::Metadata) -> std::io::Result<Vec<u8>> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK | nix::libc::O_CLOEXEC);
    let mut file = options.open(path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let after = fs::symlink_metadata(path)?;
    if !after.is_file()
        || after.file_type().is_symlink()
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ino() != after.ino()
        || before.dev() != after.dev()
    {
        return Err(std::io::Error::other("unstable tracked source"));
    }
    Ok(bytes)
}

fn tracked_paths(root: &Path) -> Option<Vec<String>> {
    let output = Command::new("git")
        .args(["ls-files", "-z", "--cached", "--"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut paths = Vec::new();
    for bytes in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|bytes| !bytes.is_empty())
    {
        let path = std::str::from_utf8(bytes)
            .ok()
            .and_then(safe_relative_path)?;
        paths.push(path);
    }
    paths.sort();
    paths.dedup();
    Some(paths)
}

fn tracked_text_files(root: &Path, paths: &[String]) -> Option<Vec<TrackedText>> {
    let mut files = Vec::new();
    for relative in paths {
        let path = root.join(relative);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return None,
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        let bytes = read_stable_file(&path, &metadata).ok()?;
        if bytes.contains(&0) {
            continue;
        }
        files.push(TrackedText {
            path: relative.clone(),
            text: String::from_utf8_lossy(&bytes).into_owned(),
        });
    }
    Some(files)
}

fn source_findings(files: &[TrackedText]) -> Option<Vec<(String, String, String)>> {
    let patterns = secret_patterns()?;
    let mut findings = Vec::new();
    for file in files {
        for raw_line in file.text.split_inclusive('\n') {
            let line = raw_line
                .strip_suffix('\n')
                .map(|line| line.strip_suffix('\r').unwrap_or(line))
                .unwrap_or(raw_line);
            for (rule_id, pattern) in &patterns {
                if pattern.is_match(line) {
                    findings.push((file.path.clone(), (*rule_id).to_owned(), sha256_line(line)));
                }
            }
        }
    }
    Some(findings)
}

fn findings_ready(findings: &[(String, String, String)], allowlist: &[AllowlistEntry]) -> bool {
    let observed = findings
        .iter()
        .map(|(path, rule, hash)| format!("{path}\0{rule}\0{hash}"))
        .collect::<BTreeSet<_>>();
    let allowed = allowlist
        .iter()
        .map(|entry| format!("{}\0{}\0{}", entry.path, entry.rule_id, entry.line_sha256))
        .collect::<BTreeSet<_>>();
    !findings
        .iter()
        .any(|(path, rule, hash)| !allowed.contains(&format!("{path}\0{rule}\0{hash}")))
        && !allowlist.iter().any(|entry| {
            !observed.contains(&format!(
                "{}\0{}\0{}",
                entry.path, entry.rule_id, entry.line_sha256
            ))
        })
}

/// Inspect the committed source secret policy and all Git-tracked text files.
/// `None` means the local source inspection could not be performed (for
/// example, malformed policy, unavailable Git index, or an unstable file).
/// `Some(true)` means no unallowlisted or stale finding exists.
pub(crate) fn inspect_source_security(workspace_root: &Path) -> Option<bool> {
    let allowlist = parse_policy(workspace_root)?;
    let paths = tracked_paths(workspace_root)?;
    let files = tracked_text_files(workspace_root, &paths)?;
    let findings = source_findings(&files)?;
    Some(findings_ready(&findings, &allowlist))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(text: &str) -> Vec<(String, String, String)> {
        source_findings(&[TrackedText {
            path: "tracked.txt".to_owned(),
            text: text.to_owned(),
        }])
        .unwrap_or_default()
    }

    #[test]
    fn detects_all_secret_rule_families_and_multiple_matches() {
        let text = format!(
            "{}{}\n{}{}\n{}{}\n{}{}\n{}{}\n{}{}\n{}{}\n{}{}\n",
            "-----BEGIN ",
            "PRIVATE KEY-----",
            "AKIA",
            "1234567890ABCDEF",
            "ghp_",
            "123456789012345678901234567890123456",
            "AIza",
            "12345678901234567890123456789012345",
            "sk-proj-",
            "123456789012345678901234",
            "xoxb-",
            "12345678901234567890",
            "sk_live_",
            "12345678901234567890",
            "sk_live_",
            "ABCDEFGHIJKLMNOPQRST",
        );
        let findings = scan(&text);
        let ids = findings
            .iter()
            .map(|(_, id, _)| id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids.len(), 8);
        assert!(ids.contains(&"pem-private-key"));
        assert!(ids.contains(&"aws-access-key-id"));
        assert!(ids.contains(&"github-token"));
        assert!(ids.contains(&"google-api-key"));
        assert!(ids.contains(&"openai-project-key"));
        assert!(ids.contains(&"slack-token"));
        assert_eq!(
            ids.iter().filter(|id| **id == "stripe-live-secret").count(),
            2
        );
    }

    #[test]
    fn does_not_return_secret_text() {
        let text = format!("prefix {}{} suffix", "sk_live_", "12345678901234567890");
        let findings = scan(&text);
        assert_eq!(findings.len(), 1);
        assert!(!findings[0].0.contains("sk_live_"));
        assert!(!findings[0].2.contains("sk_live_"));
    }

    #[test]
    fn stale_allowlist_is_blocked() {
        let findings = scan("clean source");
        let allowlist = vec![AllowlistEntry {
            path: "gone.txt".to_owned(),
            rule_id: "github-token".to_owned(),
            line_sha256: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                .to_owned(),
        }];
        assert!(!findings_ready(&findings, &allowlist));
    }
}
