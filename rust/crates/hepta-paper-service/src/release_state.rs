//! Pure release-state consistency contract.

use serde_json::{Value, json};
use std::collections::BTreeSet;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ReleaseStateError {
    #[error("release state request must be an object")]
    RequestInvalid,
    #[error("Cannot destructure property 'packageJson' of 'object null' as it is null.")]
    NullRequest,
}

fn version(value: Option<&Value>) -> Option<[u64; 3]> {
    let value = javascript_string_or_empty(value);
    let mut parts = value.split('.');
    let parsed: Vec<u64> = parts
        .by_ref()
        .map(|part| {
            if part.len() > 1 && part.starts_with('0') {
                return None;
            }
            if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            part.parse().ok()
        })
        .collect::<Option<Vec<_>>>()?;
    (parsed.len() == 3).then(|| [parsed[0], parsed[1], parsed[2]])
}

fn text(value: Option<&Value>) -> String {
    javascript_string_or_empty(value)
}

fn javascript_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| match value {
                Value::Null => String::new(),
                _ => javascript_string(value),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn javascript_string_or_empty(value: Option<&Value>) -> String {
    value
        .filter(|value| javascript_truthy(value))
        .map(javascript_string)
        .unwrap_or_default()
}

fn javascript_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        // Arrays and objects are truthy in JavaScript, including empty ones.
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn javascript_strict_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(left)), Some(Value::Bool(right))) => left == right,
        (Some(Value::Number(left)), Some(Value::Number(right))) => left.as_f64() == right.as_f64(),
        (Some(Value::String(left)), Some(Value::String(right))) => left == right,
        // Distinct JSON object/array locations are distinct JavaScript references.
        (Some(Value::Array(left)), Some(Value::Array(right))) => std::ptr::eq(left, right),
        (Some(Value::Object(left)), Some(Value::Object(right))) => std::ptr::eq(left, right),
        _ => false,
    }
}

fn exact_line_count(document: &str, expected: &str) -> usize {
    document
        .split('\n')
        .filter(|line| line.strip_suffix('\r').unwrap_or(line) == expected)
        .count()
}

fn documentation(
    version_text: &str,
    current: &str,
    release: &str,
    changelog: &str,
) -> (Option<&'static str>, Vec<String>) {
    let profiles = [
        (
            "development",
            format!(
                "This is the normative status for the unreleased v{version_text} development candidate."
            ),
            format!(
                "Version {version_text} is an unreleased automation-first research-production candidate."
            ),
            format!("## Unreleased ({version_text} development)"),
        ),
        (
            "finalized",
            format!("Release state: finalized v{version_text} source."),
            format!("Version {version_text} is finalized from this exact source commit."),
            format!("## {version_text} (finalized source)"),
        ),
        (
            "legacy_released",
            format!("This is the normative status for the v{version_text} architecture release."),
            format!("Version {version_text} is the current release."),
            format!("## {version_text}"),
        ),
    ];
    let candidates: Vec<(&str, [usize; 3])> = profiles
        .iter()
        .map(|(name, a, b, c)| {
            (
                *name,
                [
                    exact_line_count(current, a),
                    exact_line_count(release, b),
                    exact_line_count(changelog, c),
                ],
            )
        })
        .collect();
    let active: Vec<_> = candidates
        .iter()
        .filter(|(_, counts)| counts.iter().any(|count| *count > 0))
        .collect();
    if active.is_empty() {
        return (
            None,
            vec!["release_documentation_state_unrecognized".to_owned()],
        );
    }
    if active.len() > 1 {
        return (None, vec!["release_documentation_state_mixed".to_owned()]);
    }
    let (name, counts) = active[0];
    if counts.iter().any(|count| *count > 1) {
        return (
            None,
            vec![format!("release_documentation_marker_duplicate:{name}")],
        );
    }
    if counts.iter().any(|count| *count != 1) {
        return (
            None,
            vec![format!("release_documentation_state_partial:{name}")],
        );
    }
    (Some(name), Vec::new())
}

fn duplicate_values(values: &[String]) -> Vec<String> {
    let mut sorted = values.to_vec();
    sorted.sort();
    let mut duplicates = sorted
        .windows(2)
        .filter(|pair| pair[0] == pair[1])
        .map(|pair| pair[0].clone())
        .collect::<Vec<_>>();
    // Match the Node Set-backed duplicateValues helper: a value repeated
    // three or more times still contributes one diagnostic.
    duplicates.dedup();
    duplicates
}

fn unique_values(values: &[String]) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .iter()
        .filter(|value| seen.insert((*value).clone()))
        .cloned()
        .collect()
}

fn inspect_tags(
    version_text: &str,
    parsed: Option<[u64; 3]>,
    head: Option<&Value>,
    all: Option<&Value>,
) -> Value {
    let mut errors = Vec::new();
    let strings = |value: Option<&Value>| {
        value.and_then(Value::as_array).and_then(|values| {
            values
                .iter()
                .map(|value| value.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        })
    };
    // `inspectReleaseState` destructures `headTags = []` and `allTags = []`;
    // an omitted property therefore means an empty snapshot.  Preserve the
    // incumbent distinction between an omitted property and an explicit
    // null/non-array value, which remains an invalid snapshot.
    let head = match head {
        None => Some(Vec::new()),
        Some(value) => strings(Some(value)),
    };
    let all = match all {
        None => Some(Vec::new()),
        Some(value) => strings(Some(value)),
    };
    if head.is_none() {
        errors.push("head_tag_snapshot_invalid".to_owned());
    }
    if all.is_none() {
        errors.push("repository_tag_snapshot_invalid".to_owned());
    }
    let (Some(head), Some(all)) = (head, all) else {
        return json!({"currentTag": format!("v{version_text}"), "isTaggedRelease": false, "currentTagExists": false, "errors": errors});
    };
    for tag in duplicate_values(&head) {
        errors.push(format!("head_tag_snapshot_duplicate:{tag}"));
    }
    for tag in duplicate_values(&all) {
        errors.push(format!("repository_tag_snapshot_duplicate:{tag}"));
    }
    for tag in &head {
        if !all.contains(tag) {
            errors.push(format!("head_tag_missing_from_repository_snapshot:{tag}"));
        }
    }
    let current = format!("v{version_text}");
    for tag in unique_values(&head)
        .iter()
        .filter(|tag| tag.starts_with('v'))
    {
        if version(
            tag.get(1..)
                .map(|value| Value::String(value.to_owned()))
                .as_ref(),
        )
        .is_some()
            && tag != &current
        {
            errors.push(format!("head_release_tag_version_mismatch:{tag}"));
        }
    }
    if let Some(parsed) = parsed {
        for tag in unique_values(&all)
            .iter()
            .filter(|tag| tag.starts_with('v'))
        {
            if let Some(other) = version(
                tag.get(1..)
                    .map(|value| Value::String(value.to_owned()))
                    .as_ref(),
            ) && other > parsed
            {
                errors.push(format!("repository_tag_newer_than_package:{tag}"));
            }
        }
    }
    json!({"currentTag": current, "isTaggedRelease": head.contains(&format!("v{version_text}")), "currentTagExists": all.contains(&format!("v{version_text}")), "errors": errors})
}

/// Evaluate the release-state contract from a JSON request. This does not read
/// git or claim that the composite release verification command has run.
pub fn inspect_release_state_v1(input: &Value) -> Result<Value, ReleaseStateError> {
    if input.is_null() {
        return Err(ReleaseStateError::NullRequest);
    }
    if !input.is_object() {
        return Err(ReleaseStateError::RequestInvalid);
    }
    let package = input.get("packageJson");
    let lock = input.get("packageLock");
    let package_version = package.and_then(|value| value.get("version"));
    let version_text = text(package_version);
    let parsed = version(package_version);
    let mut errors = Vec::new();
    if parsed.is_none() {
        errors.push("package_version_must_be_plain_semver".to_owned());
    }
    if !javascript_strict_equal(lock.and_then(|value| value.get("version")), package_version) {
        errors.push("package_lock_version_mismatch".to_owned());
    }
    if !javascript_strict_equal(
        lock.and_then(|value| value.get("packages"))
            .and_then(|value| value.get(""))
            .and_then(|value| value.get("version")),
        package_version,
    ) {
        errors.push("package_lock_root_version_mismatch".to_owned());
    }
    let package_name = package.and_then(|value| value.get("name"));
    if !javascript_strict_equal(lock.and_then(|value| value.get("name")), package_name) {
        errors.push("package_lock_name_mismatch".to_owned());
    }
    if !javascript_strict_equal(
        lock.and_then(|value| value.get("packages"))
            .and_then(|value| value.get(""))
            .and_then(|value| value.get("name")),
        package_name,
    ) {
        errors.push("package_lock_root_name_mismatch".to_owned());
    }
    if package
        .and_then(|value| value.get("engines"))
        .and_then(|value| value.get("node"))
        .and_then(Value::as_str)
        != Some(">=22.23.1 <23")
    {
        errors.push("node_engine_policy_mismatch".to_owned());
    }
    if package
        .and_then(|value| value.get("packageManager"))
        .and_then(Value::as_str)
        != Some("npm@10.9.8")
    {
        errors.push("package_manager_policy_mismatch".to_owned());
    }
    let mut state = None;
    let mut profile = None;
    if parsed.is_some() {
        let (documentation_profile, doc_errors) = documentation(
            &version_text,
            &text(input.get("currentStatus")),
            &text(input.get("releaseDocument")),
            &text(input.get("changelog")),
        );
        errors.extend(doc_errors);
        profile = documentation_profile;
        let tags = inspect_tags(
            &version_text,
            parsed,
            input.get("headTags"),
            input.get("allTags"),
        );
        errors.extend(
            tags.get("errors")
                .and_then(Value::as_array)
                .unwrap_or(&vec![])
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned),
        );
        let tagged = tags
            .get("isTaggedRelease")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let exists = tags
            .get("currentTagExists")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        match profile {
            Some("development") => {
                state = Some("development");
                if tagged {
                    errors.push("development_documentation_cannot_be_tagged".to_owned());
                } else if exists {
                    errors.push("development_version_tag_already_exists".to_owned());
                }
            }
            Some("finalized") => {
                state = Some(if tagged { "released" } else { "release_ready" });
                if !tagged && exists {
                    errors.push("release_ready_version_tag_already_exists".to_owned());
                }
            }
            Some("legacy_released") => {
                if tagged {
                    state = Some("released");
                } else {
                    errors.push("legacy_released_documentation_requires_head_tag".to_owned());
                    if exists {
                        errors.push("legacy_release_tag_not_at_head".to_owned());
                    }
                }
            }
            _ => {}
        }
    }
    let output_version = package_version
        .filter(|value| javascript_truthy(value))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(
        json!({"ok": errors.is_empty(), "kind":"ReleaseStateConsistency", "contractVersion":2, "version": output_version, "state": state, "documentationProfile": profile, "errors": errors}),
    )
}
