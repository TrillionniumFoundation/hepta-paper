//! Pure release-state consistency contract.

use serde_json::{Value, json};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ReleaseStateError {
    #[error("release state request must be an object")]
    RequestInvalid,
    #[error("Cannot destructure property 'packageJson' of 'object null' as it is null.")]
    NullRequest,
}

fn version(value: Option<&Value>) -> Option<[u64; 3]> {
    let value = value?.as_str()?;
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
    value.and_then(Value::as_str).unwrap_or_default().to_owned()
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
    sorted
        .windows(2)
        .filter(|pair| pair[0] == pair[1])
        .map(|pair| pair[0].clone())
        .collect()
}

fn inspect_tags(
    version_text: &str,
    parsed: Option<[u64; 3]>,
    head: Option<&Value>,
    all: Option<&Value>,
) -> Value {
    let mut errors = Vec::new();
    let head = head.and_then(Value::as_array);
    let all = all.and_then(Value::as_array);
    if head.is_none() || head.is_some_and(|values| values.iter().any(|value| !value.is_string())) {
        errors.push("head_tag_snapshot_invalid".to_owned());
    }
    if all.is_none() || all.is_some_and(|values| values.iter().any(|value| !value.is_string())) {
        errors.push("repository_tag_snapshot_invalid".to_owned());
    }
    if !errors.is_empty() {
        return json!({"currentTag": format!("v{version_text}"), "isTaggedRelease": false, "currentTagExists": false, "errors": errors});
    }
    let head: Vec<String> = head
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect();
    let all: Vec<String> = all
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect();
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
    for tag in head.iter().filter(|tag| tag.starts_with('v')) {
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
        for tag in all.iter().filter(|tag| tag.starts_with('v')) {
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
    let version_text = text(package.and_then(|value| value.get("version")));
    let parsed = version(package.and_then(|value| value.get("version")));
    let mut errors = Vec::new();
    if parsed.is_none() {
        errors.push("package_version_must_be_plain_semver".to_owned());
    }
    if lock.and_then(|value| value.get("version")) != package.and_then(|value| value.get("version"))
    {
        errors.push("package_lock_version_mismatch".to_owned());
    }
    if lock
        .and_then(|value| value.get("packages"))
        .and_then(|value| value.get(""))
        .and_then(|value| value.get("version"))
        != package.and_then(|value| value.get("version"))
    {
        errors.push("package_lock_root_version_mismatch".to_owned());
    }
    let package_name = package.and_then(|value| value.get("name"));
    if lock.and_then(|value| value.get("name")) != package_name {
        errors.push("package_lock_name_mismatch".to_owned());
    }
    if lock
        .and_then(|value| value.get("packages"))
        .and_then(|value| value.get(""))
        .and_then(|value| value.get("name"))
        != package_name
    {
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
    Ok(
        json!({"ok": errors.is_empty(), "kind":"ReleaseStateConsistency", "contractVersion":2, "version": if version_text.is_empty() { Value::Null } else { Value::String(version_text) }, "state": state, "documentationProfile": profile, "errors": errors}),
    )
}
