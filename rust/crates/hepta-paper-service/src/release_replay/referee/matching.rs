use super::*;
use regex::Regex;
const OPERATIONS: &[&str] = &[
    "delete", "email", "publish", "sendmail", "submit", "upload", "withdraw",
];
const FORBIDDEN_FLAGS: &[&str] = &[
    "human_authorized",
    "recorder_write_path_authorized",
    "decision_consumption_authorized",
    "workflow_execution_authorized",
    "model_call_authorized",
    "external_action_authorized",
    "external_action_performed",
    "source_mutation_authorized",
    "source_mutation_performed",
    "package_mutation_authorized",
    "package_mutation_performed",
    "archive_mutation_authorized",
    "archive_mutation_performed",
    "provider_model_call_authorized",
    "provider_model_call_performed",
    "secret_material_read_authorized",
    "secret_material_read_performed",
    "candidate_patch_queue_mutation_performed",
    "patch_queue_merge_performed",
    "crontab_mutation_authorized",
    "crontab_mutation_performed",
    "commit_authorized",
    "commit_performed",
    "approval_execution_authorized",
    "applies_decision",
    "apply_decision",
    "closes_human_boundary",
    "human_decision_closed",
];
fn canonical(key: &str) -> String {
    let mut result = String::new();
    let mut previous = None;
    let mut separator = false;
    for c in key.trim_matches(js_space).chars() {
        if matches!(c, '.' | '-') {
            if !separator {
                result.push('_')
            }
            separator = true;
            previous = Some(c);
            continue;
        }
        separator = false;
        if c.is_ascii_uppercase()
            && previous.is_some_and(|v: char| v.is_ascii_lowercase() || v.is_ascii_digit())
        {
            result.push('_')
        }
        result.extend(c.to_lowercase());
        previous = Some(c);
    }
    result
}
fn external(value: &str) -> bool {
    let text = value.trim_matches(js_space).to_lowercase();
    text.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && text.bytes().all(|v| {
            v.is_ascii_lowercase() || v.is_ascii_digit() || matches!(v, b'_' | b'.' | b'-')
        })
        && text.split(['.', '_', '-']).any(|v| OPERATIONS.contains(&v))
}
pub(super) fn forbidden(output: &Value) -> String {
    let Some(map) = output.as_object() else {
        return String::new();
    };
    for (key, value) in map {
        if FORBIDDEN_FLAGS.contains(&canonical(key).as_str()) && truthy(value) {
            return format!("{key} must be false for plan-only decision consumption");
        }
    }
    for (key, value) in map {
        let field = canonical(key);
        if ![
            "action",
            "external_operation",
            "operation",
            "operation_id",
            "requested_operation",
            "runtime_operation",
            "selected_action",
            "selected_operation",
        ]
        .contains(&field.as_str())
            && !field.ends_with("_operation")
        {
            continue;
        }
        if let Some(text) = value.as_str()
            && external(text)
        {
            return format!(
                "external_action_operation {key}={text} must not be consumed by plan-only decision routing"
            );
        }
    }
    String::new()
}
pub(super) fn command_safety(command: &Value) -> String {
    let value = js_text(command);
    let value = value.trim_matches(js_space);
    if value.is_empty() {
        return String::new();
    }
    if ["\n", "\r", ";", "|", "&&", "||", "`", "$("]
        .iter()
        .any(|v| value.contains(v))
    {
        return "allowed_command contains shell control syntax".into();
    }
    let lower = value.to_lowercase();
    let Ok(flags) = Regex::new(r"(^|[^a-z0-9_.-])(--[a-z0-9][a-z0-9_.-]*)") else {
        return "allowed_command safety pattern unavailable".into();
    };
    for captures in flags.captures_iter(&lower) {
        let flag = &captures[2];
        if ["--apply", "--apply-status", "--execute", "--send-approved"].contains(&flag) {
            return format!("allowed_command contains approval/execution boundary flag {flag}");
        }
    }
    let Ok(words) = Regex::new(r"[a-z][a-z0-9_.-]*") else {
        return "allowed_command safety pattern unavailable".into();
    };
    for token in words.find_iter(&lower) {
        let token = token.as_str();
        if [
            "curl", "email", "ftp", "portal", "scp", "sendmail", "ssh", "submit", "upload",
        ]
        .contains(&token)
            || external(token)
        {
            return "allowed_command contains external-action token".into();
        }
    }
    String::new()
}
pub(super) fn requires_human(value: &Value) -> bool {
    value.as_object().is_some_and(|v| {
        v.iter().any(|(key, value)| {
            [
                "requires_human",
                "requires_human_confirmation",
                "human_review_required",
            ]
            .contains(&canonical(key).as_str())
                && truthy(value)
        })
    })
}
pub(super) fn reference_issue(value: &Value) -> String {
    value["validation_issues"]
        .as_array()
        .map(|issues| {
            issues
                .iter()
                .map(|v| {
                    if v.is_object() {
                        js_text(if js_truthy(&v["issue"]) {
                            &v["issue"]
                        } else if js_truthy(&v["message"]) {
                            &v["message"]
                        } else {
                            v
                        })
                    } else {
                        js_text(v)
                    }
                })
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
                .join("; ")
        })
        .unwrap_or_default()
}
fn integer_match(selected: &Value, actual: i64) -> Result<bool, String> {
    Ok(!truthy(selected) || int(selected)? == actual)
}
fn value_match(selected: &Value, actual: Value) -> bool {
    !truthy(selected) || *selected == actual
}
fn any(values: &[Value]) -> bool {
    values.iter().any(truthy)
}
pub(super) fn plan_matches(family: Family, item: &Value, output: &Value) -> Result<bool, String> {
    match family {
        Family::Request => {
            let r = request(item);
            let id = first(
                output,
                &["selected_request_id", "request_id", "target_request_id"],
            );
            let key = first(output, &["selected_request_key", "request_key"]);
            let slug = first(output, &["selected_slug", "slug"]);
            let mode = first(
                output,
                &[
                    "selected_repair_mode",
                    "repair_mode",
                    "selected_route",
                    "route",
                    "selected_task",
                    "task",
                ],
            );
            let allowed = field(output, "allowed_command");
            let action = first(output, &["next_action", "selected_action"]);
            Ok(integer_match(&id, request_id(item)?)?
                && value_match(&key, field(&r, "request_key"))
                && value_match(&slug, field(&r, "slug"))
                && value_match(&mode, field(item, "repair_mode"))
                && value_match(&allowed, field(item, "next_command_after_repair"))
                && (!truthy(&action)
                    || [
                        field(item, "repair_mode"),
                        field(item, "next_command_after_repair"),
                        field(&r, "request_key"),
                    ]
                    .contains(&action))
                && any(&[id, key, slug, mode, allowed, action]))
        }
        Family::Resync => {
            let r = request(item);
            let rid = first(
                output,
                &["selected_request_id", "request_id", "target_request_id"],
            );
            let pid = first(
                output,
                &["selected_patch_id", "patch_id", "target_patch_id"],
            );
            let key = first(output, &["selected_request_key", "request_key"]);
            let classification = first(
                output,
                &[
                    "selected_classification",
                    "classification",
                    "selected_route",
                    "route",
                    "selected_task",
                    "task",
                ],
            );
            let allowed = field(output, "allowed_command");
            let action = first(output, &["next_action", "selected_action"]);
            Ok(integer_match(&rid, request_id(item)?)?
                && integer_match(&pid, patch_id(item)?)?
                && value_match(&key, field(&r, "request_key"))
                && value_match(&classification, field(item, "classification"))
                && (!truthy(&allowed)
                    || [
                        field(item, "next_command"),
                        field(item, "patch_hygiene_command"),
                    ]
                    .contains(&allowed))
                && (!truthy(&action)
                    || [
                        field(item, "classification"),
                        field(item, "recommended_action"),
                        field(item, "next_command"),
                        field(item, "patch_hygiene_command"),
                        field(&r, "request_key"),
                    ]
                    .contains(&action))
                && any(&[rid, pid, key, classification, allowed, action]))
        }
        Family::Merge => {
            let pid = first(
                output,
                &["selected_patch_id", "patch_id", "target_patch_id"],
            );
            let slug = first(output, &["selected_slug", "slug"]);
            let batch = first(
                output,
                &["selected_batch_id", "batch_id", "target_batch_id"],
            );
            let route = first(
                output,
                &[
                    "selected_ready_merge_route",
                    "selected_route",
                    "route",
                    "selected_task",
                    "task",
                ],
            );
            let allowed = field(output, "allowed_command");
            let action = first(output, &["next_action", "selected_action"]);
            let cmd = command(item)?;
            let mut routes = vec![
                json!("ready_merge"),
                json!("ready_merge_boundary"),
                json!("merge_plan"),
                json!("merge_queue_plan"),
                cmd.clone(),
            ];
            let route_allowed = !truthy(&route) || routes.contains(&route);
            routes.extend([
                field(item, "slug"),
                field(item, "batch_id"),
                json!(patch_id(item)?.to_string()),
            ]);
            Ok(integer_match(&pid, patch_id(item)?)?
                && value_match(&slug, field(item, "slug"))
                && value_match(&batch, field(item, "batch_id"))
                && route_allowed
                && value_match(&allowed, cmd)
                && (!truthy(&action) || routes.contains(&action))
                && any(&[pid, slug, batch, route, allowed, action]))
        }
        Family::Final => {
            let route = first(
                output,
                &[
                    "selected_final_gate_route",
                    "selected_route",
                    "route",
                    "selected_task",
                    "task",
                    "next_action",
                    "selected_action",
                ],
            );
            let slug = first(output, &["selected_slug", "slug"]);
            let allowed = field(output, "allowed_command");
            Ok((!truthy(&route)
                || [
                    route_id(item),
                    field(item, "route_kind"),
                    field(item, "next_command"),
                ]
                .contains(&route))
                && (!truthy(&slug) || slugs(item).contains(&slug) || slug == field(item, "slug"))
                && value_match(&allowed, field(item, "next_command"))
                && any(&[route, slug, allowed]))
        }
    }
}
pub(super) fn selection_matches(
    family: Family,
    item: &Value,
    plan: &Value,
) -> Result<bool, String> {
    Ok(match family {
        Family::Request => {
            integer_match(&plan["llm_request_id"], request_id(item)?)?
                && value_match(
                    &plan["llm_request_key"],
                    field(&request(item), "request_key"),
                )
                && value_match(&plan["llm_repair_mode"], field(item, "repair_mode"))
                && value_match(
                    &plan["llm_command"],
                    field(item, "next_command_after_repair"),
                )
        }
        Family::Resync => {
            integer_match(&plan["llm_request_id"], request_id(item)?)?
                && integer_match(&plan["llm_patch_id"], patch_id(item)?)?
                && value_match(
                    &plan["llm_request_key"],
                    field(&request(item), "request_key"),
                )
                && value_match(&plan["llm_classification"], field(item, "classification"))
                && (!truthy(&plan["llm_command"])
                    || [
                        field(item, "next_command"),
                        field(item, "patch_hygiene_command"),
                    ]
                    .contains(&plan["llm_command"]))
        }
        Family::Merge => {
            integer_match(&plan["llm_patch_id"], patch_id(item)?)?
                && value_match(&plan["llm_slug"], field(item, "slug"))
                && value_match(&plan["llm_batch_id"], field(item, "batch_id"))
                && value_match(&plan["llm_command"], command(item)?)
        }
        Family::Final => {
            value_match(&plan["llm_route"], route_id(item))
                && value_match(&plan["llm_route_kind"], field(item, "route_kind"))
                && value_match(&plan["llm_command"], field(item, "next_command"))
                && (slugs(&json!({"slugs":plan["llm_slugs"]})).is_empty()
                    || slugs(item) == slugs(&json!({"slugs":plan["llm_slugs"]})))
        }
    })
}
