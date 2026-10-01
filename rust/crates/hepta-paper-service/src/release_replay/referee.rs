//! Bounded native compatibility for the four archived plan-only routing
//! families. A returned selection is an observation, never execute authority.
mod matching;
mod payload;
use super::production_core::{budget, integer, js_space, js_text, truthy as js_truthy};
use serde_json::{Value, json};

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum Family {
    Request,
    Resync,
    Merge,
    Final,
}
impl Family {
    fn point(self) -> &'static str {
        match self {
            Self::Request => "referee_revision_request_route",
            Self::Resync => "evidence_resync_route",
            Self::Merge => "ready_merge_boundary",
            Self::Final => "post_apply_final_gate_route",
        }
    }
    fn empty_state(self) -> &'static str {
        match self {
            Self::Request => "NO_BLOCKED_REQUEST_ROUTE_REQUIRED",
            Self::Resync => "NO_RESYNC_ACTION_REQUIRED",
            Self::Merge => "NO_READY_MERGE_CANDIDATE",
            Self::Final => "NO_POST_APPLY_FINAL_GATE_ACTION_REQUIRED",
        }
    }
    fn empty_reason(self, inspected: usize) -> &'static str {
        match self {
            Self::Request => "blocked repair plan has no blocked requests",
            Self::Resync => "evidence resync report has no selected items",
            Self::Merge if inspected > 0 => {
                "ready-merge-set patches exist but none pass ready merge checks"
            }
            Self::Merge => "ready-merge-set report has no ready checked patch candidates",
            Self::Final => "no post-apply final gate route candidates",
        }
    }
    fn noun(self) -> &'static str {
        match self {
            Self::Request => "blocked request repair route",
            Self::Resync => "evidence resync item",
            Self::Merge => "ready merge candidate",
            Self::Final => "post-apply final gate route",
        }
    }
}

fn error() -> String {
    "release_replay_referee_input_outside_bounded_contract".into()
}
fn object(v: &Value) -> Value {
    if v.is_object() { v.clone() } else { json!({}) }
}
fn fallback(v: &Value) -> Value {
    if js_truthy(v) { v.clone() } else { json!("") }
}
fn field(v: &Value, key: &str) -> Value {
    fallback(&v[key])
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Array(v) => !v.is_empty(),
        Value::Object(v) => !v.is_empty(),
        _ => js_truthy(v),
    }
}
fn int(v: &Value) -> Result<i64, String> {
    match v {
        Value::Number(n) if n.as_f64().is_some_and(|n| n.fract() != 0.0) => Ok(0),
        Value::Number(_) | Value::Bool(_) => integer(v),
        _ => integer(&json!(if v.is_null() {
            String::new()
        } else {
            js_text(v)
        })),
    }
}
fn request(v: &Value) -> Value {
    object(&v["request"])
}
fn request_id(v: &Value) -> Result<i64, String> {
    int(&v["request"]["request_id"])
}
fn patch_id(v: &Value) -> Result<i64, String> {
    int(&v["patch_id"])
}
fn ready(v: &Value) -> bool {
    js_truthy(&v["patch_exists"])
        && js_truthy(&v["sha256_ok"])
        && v["git_apply_check"]["returncode"] == 0
}
fn command(v: &Value) -> Result<Value, String> {
    let id = patch_id(v)?;
    Ok(if id > 0 {
        json!(format!("hepta-paper://repair.safe-apply/v1?patch_id={id}"))
    } else {
        json!("")
    })
}
fn route_id(v: &Value) -> Value {
    for name in ["route_id", "route", "task"] {
        if js_truthy(&v[name]) {
            return v[name].clone();
        }
    }
    json!("")
}
fn slugs(v: &Value) -> Vec<Value> {
    v["slugs"].as_array().cloned().unwrap_or_default()
}
fn unique(values: impl Iterator<Item = Value>) -> Vec<Value> {
    let mut result = Vec::new();
    for v in values {
        if truthy(&v) && !result.contains(&v) {
            result.push(v)
        }
    }
    result
}
fn first(v: &Value, names: &[&str]) -> Value {
    names
        .iter()
        .map(|n| &v[*n])
        .find(|v| truthy(v))
        .cloned()
        .unwrap_or(json!(""))
}
fn insert(base: &mut Value, values: Value) {
    if let Some(values) = values.as_object() {
        for (key, value) in values {
            base[key] = value.clone()
        }
    }
}

// JSON objects and arrays do not preserve JavaScript reference identity across
// serialization. These selector values are outside the bounded scalar contract.
fn identity_boundaries(value: &Value) -> Result<(), String> {
    const FIELDS: &[&str] = &[
        "slug",
        "selected_slug",
        "target_slug",
        "request_key",
        "selected_request_key",
        "route_id",
        "selected_route_id",
        "target_route_id",
        "route",
        "selected_route",
        "task",
        "selected_task",
        "repair_mode",
        "selected_repair_mode",
        "next_action",
        "selected_action",
        "action",
        "reason",
        "selected_reason",
    ];
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    if FIELDS.contains(&key.as_str())
                        && (child.is_array()
                            || child.is_object()
                            || child.as_number().is_some_and(|n| {
                                n.as_f64().is_some_and(|v| v.fract() == 0.0)
                                    && !n.is_i64()
                                    && !n.is_u64()
                            }))
                    {
                        return Err(error());
                    }
                    if key == "slugs"
                        && child.as_array().is_some_and(|rows| {
                            rows.iter().any(|row| row.is_array() || row.is_object())
                        })
                    {
                        return Err(error());
                    }
                    pending.push(child);
                }
            }
            Value::Array(rows) => pending.extend(rows),
            _ => {}
        }
    }
    Ok(())
}

/// Dispatch only the fixed eight migration operations. The input envelope is
/// bounded; no caller command is ever executed, signed, or published.
pub fn evaluate_referee_case_v1(case: &Value) -> Result<Value, String> {
    budget(&[case])?;
    if !case.is_object()
        || case
            .as_object()
            .is_some_and(|v| v.keys().any(|v| !["name", "args"].contains(&v.as_str())))
    {
        return Err(error());
    }
    identity_boundaries(case)?;
    let name = case["name"].as_str().ok_or_else(error)?;
    let args = case["args"].as_array().ok_or_else(error)?;
    if args.len() > 5 {
        return Err(error());
    }
    let (family, selection) = match name {
        "referee_revision_request_decision_plan" => (Family::Request, false),
        "referee_revision_request_consuming_selection" => (Family::Request, true),
        "evidence_resync_decision_plan" => (Family::Resync, false),
        "evidence_resync_consuming_selection" => (Family::Resync, true),
        "ready_merge_boundary_decision_plan" => (Family::Merge, false),
        "ready_merge_boundary_consuming_selection" => (Family::Merge, true),
        "post_apply_final_gate_decision_plan" => (Family::Final, false),
        "post_apply_final_gate_consuming_selection" => (Family::Final, true),
        _ => return Err(error()),
    };
    let argument = |index: usize| args.get(index).unwrap_or(&Value::Null);
    let original = argument(0);
    let items = if original.is_null() {
        Vec::new()
    } else {
        original
            .as_array()
            .ok_or_else(error)?
            .iter()
            .map(object)
            .collect::<Vec<_>>()
    };
    if items.len() > 1024
        || (selection && args.len() > 2)
        || (family != Family::Merge && args.len() > 3)
    {
        return Err(error());
    }
    let output = object(argument(1));
    let reference = object(argument(2));
    let selected = if family == Family::Merge {
        items
            .iter()
            .filter(|v| ready(v))
            .cloned()
            .collect::<Vec<_>>()
    } else {
        items.clone()
    };
    let empty = json!({});
    let deterministic = selected.first().unwrap_or(&empty);
    let base = payload::metadata(family, &items, &selected, deterministic)?;
    if selection {
        return selection_result(family, &items, &selected, deterministic, &output, base);
    }
    let mut base = base;
    insert(
        &mut base,
        json!({"consume_allowed":false,"consumption_state":"","reason":"","would_change_route":false,"decision_report_ref":reference}),
    );
    payload::plan_empty_fields(family, &mut base);
    if family == Family::Merge {
        insert(
            &mut base,
            json!({"ready_merge_state":fallback(argument(3)),"ready_merge_status":fallback(argument(4))}),
        )
    }
    let finish = |mut value: Value, state: &str, reason: String| {
        value["consumption_state"] = json!(state);
        value["reason"] = json!(reason);
        Ok(value)
    };
    if selected.is_empty() {
        return finish(
            base,
            family.empty_state(),
            family.empty_reason(items.len()).into(),
        );
    }
    if !truthy(&reference) {
        return finish(
            base,
            "NO_LLM_DECISION_REPORT",
            format!("missing {} LLM decision report", family.point()),
        );
    }
    let issue = matching::reference_issue(&reference);
    if !issue.is_empty() {
        return finish(
            base,
            "INVALID_LLM_DECISION_REPORT",
            format!("{} decision report is not valid: {issue}", family.point()),
        );
    }
    if output["decision_point_id"] != family.point() {
        return finish(
            base,
            "INVALID_DECISION_POINT",
            format!("decision output is not for {}", family.point()),
        );
    }
    let issue = matching::forbidden(&output);
    if !issue.is_empty() {
        let state = if issue.starts_with("external_action_") {
            "EXTERNAL_ACTION_FORBIDDEN"
        } else {
            "FORBIDDEN_DECISION_BOUNDARY"
        };
        return finish(base, state, issue);
    }
    let issue = matching::command_safety(&field(&output, "allowed_command"));
    if !issue.is_empty() {
        let state = match family {
            Family::Request => "ALLOWED_COMMAND_NOT_SAFE_REQUEST_ROUTE",
            Family::Resync => "ALLOWED_COMMAND_NOT_SAFE_EVIDENCE_RESYNC_ROUTE",
            Family::Merge => "ALLOWED_COMMAND_NOT_SAFE_READY_MERGE_BOUNDARY",
            Family::Final => "ALLOWED_COMMAND_NOT_SAFE_POST_APPLY_FINAL_GATE_ROUTE",
        };
        return finish(base, state, issue);
    }
    if matching::requires_human(&output) {
        let description = match family {
            Family::Request => "request route",
            Family::Resync => "evidence resync route",
            Family::Merge => "ready merge boundary",
            Family::Final => "final-gate route",
        };
        return finish(
            base,
            "HUMAN_REVIEW_REQUIRED",
            format!("decision output requires human review before {description} consumption"),
        );
    }
    let mut matched = None;
    for item in &items {
        if matching::plan_matches(family, item, &output)? {
            matched = Some(item);
            break;
        }
    }
    let Some(item) = matched else {
        let state = match family {
            Family::Request => "NO_SELECTABLE_REQUEST_ROUTE",
            Family::Resync => "NO_SELECTABLE_RESYNC_ROUTE",
            Family::Merge => "NO_SELECTABLE_READY_MERGE_CANDIDATE",
            Family::Final => "NO_SELECTABLE_POST_APPLY_FINAL_GATE_ROUTE",
        };
        return finish(
            base,
            state,
            format!(
                "decision output does not identify {}{}",
                if matches!(family, Family::Request | Family::Merge | Family::Final) {
                    "a "
                } else {
                    "an "
                },
                family.noun()
            ),
        );
    };
    let values = payload::plan_selected(family, item, &output)?;
    let changed = payload::changed(family, item, deterministic, &values)?;
    insert(&mut base, values);
    if family == Family::Merge && !ready(item) {
        return finish(
            base,
            "SELECTED_PATCH_NOT_READY",
            "decision output identifies a patch that failed ready merge checks".into(),
        );
    }
    insert(
        &mut base,
        json!({"consume_allowed":true,"would_change_route":changed}),
    );
    finish(
        base,
        "PLAN_ONLY_CONSUMABLE",
        format!(
            "decision output identifies {}{}",
            if matches!(family, Family::Request | Family::Merge | Family::Final) {
                "a "
            } else {
                "an "
            },
            family.noun()
        ),
    )
}

fn selection_result(
    family: Family,
    items: &[Value],
    selected: &[Value],
    deterministic: &Value,
    plan: &Value,
    metadata: Value,
) -> Result<Value, String> {
    let mut matched = None;
    if truthy(&plan["consume_allowed"]) {
        for item in selected {
            if matching::selection_matches(family, item, plan)? {
                matched = Some(item);
                break;
            }
        }
    }
    let empty = json!({});
    let item = matched.unwrap_or(if selected.is_empty() {
        &empty
    } else {
        deterministic
    });
    let mut payload = metadata;
    insert(&mut payload, payload::selection_fields(family, item)?);
    if family == Family::Request {
        payload["deterministic_slug"] = field(&request(deterministic), "slug")
    }
    if family == Family::Resync && matched.is_some() && truthy(&plan["llm_command"]) {
        payload["selected_command"] = plan["llm_command"].clone()
    }
    let consumed = matched.is_some();
    let state = if consumed {
        match family {
            Family::Request => "CONSUMED_LLM_REFEREE_REVISION_REQUEST_ROUTE",
            Family::Resync => "CONSUMED_LLM_EVIDENCE_RESYNC_ROUTE",
            Family::Merge => "CONSUMED_LLM_READY_MERGE_BOUNDARY",
            Family::Final => "CONSUMED_LLM_POST_APPLY_FINAL_GATE_ROUTE",
        }
    } else if selected.is_empty() {
        family.empty_state()
    } else {
        match family {
            Family::Request => "DETERMINISTIC_FALLBACK_NO_LLM_REFEREE_REVISION_REQUEST_CONSUMPTION",
            Family::Resync => "DETERMINISTIC_FALLBACK_NO_LLM_EVIDENCE_RESYNC_CONSUMPTION",
            Family::Merge => "DETERMINISTIC_FALLBACK_NO_LLM_READY_MERGE_CONSUMPTION",
            Family::Final => "DETERMINISTIC_FALLBACK_NO_LLM_POST_APPLY_FINAL_GATE_CONSUMPTION",
        }
    };
    let reason = if consumed {
        json!("")
    } else if js_truthy(&plan["reason"]) {
        plan["reason"].clone()
    } else if selected.is_empty() {
        json!(if family == Family::Merge {
            family.empty_reason(0)
        } else {
            family.empty_reason(items.len())
        })
    } else {
        json!(format!(
            "missing consumable {} LLM decision report",
            family.point()
        ))
    };
    insert(
        &mut payload,
        json!({"decision_consumed":consumed,"selection_state":state,"plan_state":field(plan,"consumption_state"),"would_change_route":consumed&&js_truthy(&plan["would_change_route"]),"fallback_reason":reason,"decision_report_ref":object(&plan["decision_report_ref"])}),
    );
    Ok(payload)
}
