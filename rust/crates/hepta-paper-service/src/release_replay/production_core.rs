//! Pure, bounded migration compatibility for the archived production audit.
//! This computes observations only: no repair, provider, publication or authority.
use serde_json::{Value, json};
use std::collections::BTreeMap;

const MAX_RECORD_BYTES: usize = 64 * 1024;
const MAX_PAPERS: usize = 1024;
const MAX_OPERATION_BYTES: usize = 4 * 1024 * 1024;
const MAX_DEPTH: usize = 32;
const MAX_NODES: usize = 100_000;
const MAX_INTEGER: f64 = 9_007_199_254_740_991.0;
const STATES: &[(&str, &str, &str)] = &[
    (
        "SOURCE_MISSING",
        "BLOCKED_SOURCE_MISSING",
        "restore or declare source before repair automation can run",
    ),
    (
        "CONTRACT_MISSING",
        "BLOCKED_CONTRACT_MISSING",
        "declare paper profile and proof/quality contract before referee repair automation can run",
    ),
    (
        "PROOF_BLOCKED",
        "SYNC_PROOF_BLOCKERS",
        "sync proof-readiness blockers into referee repair requests",
    ),
    (
        "REPAIR_REQUESTED",
        "RUN_REFEREE_REPAIR",
        "run referee repair runner/orchestrator for open proof-readiness requests",
    ),
    (
        "GATE_BLOCKED",
        "RUN_GATE",
        "run or repair local gate after proof/referee blockers clear",
    ),
    (
        "PACKAGE_BLOCKED",
        "RUN_PACKAGE_REBUILD",
        "create/verify local packages after upstream paper state clears",
    ),
    (
        "PREFLIGHT_BLOCKED",
        "RUN_SUBMISSION_PREFLIGHT",
        "run submission preflight after package verification clears",
    ),
    (
        "WARNING_REVIEW_BLOCKED",
        "RUN_WARNING_REVIEW",
        "resolve or explicitly explain submission-preflight warnings before release",
    ),
    (
        "LOCAL_RELEASE_BLOCKED",
        "RUN_RELEASE_VERIFY",
        "freeze or verify local release after preflight clears",
    ),
];

fn invalid() -> String {
    "release_replay_production_core_input_outside_bounded_contract".into()
}
/// Every public compatibility function applies the same aggregate, depth and
/// node limits before any clone, recursion, coercion or generated output.
pub(super) fn budget(values: &[&Value]) -> Result<(), String> {
    let mut pending = values.iter().map(|v| (*v, 0)).collect::<Vec<_>>();
    let mut nodes = 0usize;
    let mut bytes = 0usize;
    while let Some((value, depth)) = pending.pop() {
        nodes = nodes.checked_add(1).ok_or_else(invalid)?;
        if depth > MAX_DEPTH || nodes > MAX_NODES {
            return Err(invalid());
        }
        let count = match value {
            Value::String(v) => v.len(),
            Value::Array(v) => {
                pending.extend(v.iter().map(|v| (v, depth + 1)));
                v.len()
            }
            Value::Object(v) => {
                pending.extend(v.values().map(|v| (v, depth + 1)));
                v.keys()
                    .try_fold(0usize, |n, key| n.checked_add(key.len()))
                    .ok_or_else(invalid)?
            }
            _ => 32,
        };
        bytes = bytes.checked_add(count).ok_or_else(invalid)?;
        if bytes > MAX_OPERATION_BYTES {
            return Err(invalid());
        }
    }
    let mut serialized = 0usize;
    for value in values {
        serialized = serialized
            .checked_add(serde_json::to_vec(value).map_err(|_| invalid())?.len())
            .filter(|n| *n <= MAX_OPERATION_BYTES)
            .ok_or_else(invalid)?;
    }
    Ok(())
}
fn record(value: &Value) -> Result<(), String> {
    budget(&[value])?;
    if !value.is_object()
        || serde_json::to_vec(value).map_err(|_| invalid())?.len() > MAX_RECORD_BYTES
    {
        return Err(invalid());
    }
    Ok(())
}
fn array_field(value: &Value, field: &str) -> Result<Vec<Value>, String> {
    if value[field].is_null() {
        return Ok(Vec::new());
    }
    let values = value[field].as_array().ok_or_else(invalid)?;
    if values.len() > MAX_PAPERS {
        return Err(invalid());
    }
    Ok(values.clone())
}
pub(super) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|x| x != 0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
fn fallback(v: &Value, default: Value) -> Value {
    if truthy(v) { v.clone() } else { default }
}
fn object(v: &Value) -> Value {
    if v.is_object() { v.clone() } else { json!({}) }
}
pub(super) fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
pub(super) fn integer(v: &Value) -> Result<i64, String> {
    let n = match v {
        Value::Null => 0.0,
        Value::Bool(v) => {
            if *v {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(v) => v.as_f64().ok_or_else(invalid)?.trunc(),
        Value::String(v) => {
            let t = v.trim_matches(js_space);
            let digits = t.strip_prefix(['+', '-']).unwrap_or(t);
            if t.is_empty() || digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
                0.0
            } else {
                t.parse::<f64>().map_err(|_| invalid())?
            }
        }
        _ => 0.0,
    };
    if !n.is_finite() || n.abs() > MAX_INTEGER {
        return Err(invalid());
    }
    Ok(n as i64)
}
pub(super) fn js_text(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::String(v) => v.clone(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => {
            let mut b = ryu_js::Buffer::new();
            b.format(v.as_f64().unwrap_or(0.0)).into()
        }
        Value::Array(v) => v
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_text(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
fn validate(v: &Value) -> Result<(), String> {
    record(v)?;
    for name in [
        "proof_readiness",
        "latest_gate",
        "repair_queue",
        "package",
        "submission_preflight",
        "warning_review",
        "release_verify",
        "manual_venue_authorization",
    ] {
        if !v[name].is_null() && !v[name].is_object() {
            return Err(invalid());
        }
    }
    if !v["proof_readiness"]["failed_report_ids"].is_null()
        && !v["proof_readiness"]["failed_report_ids"].is_array()
    {
        return Err(invalid());
    }
    Ok(())
}
fn package_status(v: &Value) -> Value {
    fallback(
        &v["status"],
        if truthy(&v["present"]) {
            json!("PASS")
        } else {
            json!("MISSING")
        },
    )
}

/// Recover the incumbent priority, upstream suppression, and coercion behavior.
/// Structured fields must be objects, failed_report_ids an array, records <=64KiB,
/// and coerced integers must stay in the finite JavaScript safe-integer domain.
pub fn evaluate_snapshot_v1(snapshot: &Value) -> Result<Value, String> {
    validate(snapshot)?;
    let proof = object(&snapshot["proof_readiness"]);
    let gate = object(&snapshot["latest_gate"]);
    let repair = object(&snapshot["repair_queue"]);
    let source = truthy(&snapshot["source_ready"]);
    let contract = truthy(&proof["contract_declared"]);
    let proof_count = integer(&proof["blocker_count"])?;
    let proof_blocked = truthy(&proof["workflow_readiness_blocking"]) || proof_count > 0;
    let repair_count = integer(&repair["open_proof_blocker_count"])?;
    let repair_requested = repair_count > 0;
    let gate_status = fallback(&gate["status"], json!("MISSING"));
    let package = package_status(&snapshot["package"]);
    let preflight = package_status(&snapshot["submission_preflight"]);
    let warning = object(&snapshot["warning_review"]);
    let warning_count = integer(if warning["warning_count"].is_null() {
        &snapshot["submission_preflight"]["warning_count"]
    } else {
        &warning["warning_count"]
    })?;
    let unresolved = integer(&warning["unresolved_count"])?;
    let raw_warning_status = fallback(&warning["status"], json!("MISSING"));
    let (warning_status, warning_ref) = if warning_count <= 0 && raw_warning_status == "MISSING" {
        (
            json!("PASS"),
            json!({"warning_count":0,"unresolved_count":0,"status":"NOT_REQUIRED","present":false}),
        )
    } else {
        (
            json!(if raw_warning_status == "PASS" && unresolved == 0 {
                "PASS"
            } else {
                "FAIL"
            }),
            warning,
        )
    };
    let mut release = package_status(&snapshot["release_verify"]);
    if release == "PASS"
        && snapshot["release_verify"]["current_package_verify_semantics_pass"] == false
    {
        release = json!("FAIL")
    }
    let external = truthy(&snapshot["manual_venue_authorization"]["external_action_authorized"]);
    let mut stages = Vec::new();
    let mut upstream = false;
    let mut add = |name: &str, status: &str, detail: Value, blocking: bool, reference: Value| {
        let suppressed = upstream && status == "FAIL";
        let status = if suppressed { "SKIP" } else { status };
        let blocking = blocking && !suppressed;
        let detail = if suppressed {
            json!(format!("blocked_by_upstream:{}", js_text(&detail)))
        } else {
            detail
        };
        stages.push(json!({"name":name,"status":status,"blocking":blocking,"detail":detail,"ref":fallback(&reference,json!({}))}));
        if blocking && status == "FAIL" {
            upstream = true
        }
    };
    add(
        "SourceWorkspace",
        if source { "PASS" } else { "FAIL" },
        fallback(&snapshot["main_tex"], json!("missing main tex")),
        true,
        json!({}),
    );
    add(
        "ProofOrQualityContract",
        if contract { "PASS" } else { "FAIL" },
        fallback(
            &proof["proof_state"],
            json!("missing declared proof/quality contract"),
        ),
        true,
        json!({"proof_readiness_hash":fallback(&proof["proof_readiness_hash"],json!(""))}),
    );
    let joined = proof["failed_report_ids"]
        .as_array()
        .map(|v| {
            v.iter()
                .map(|v| {
                    if v.is_null() {
                        String::new()
                    } else {
                        js_text(v)
                    }
                })
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default();
    add(
        "ProofReadinessReport",
        if proof_blocked {
            "FAIL"
        } else if contract {
            "PASS"
        } else {
            "SKIP"
        },
        fallback(&json!(joined), fallback(&proof["proof_state"], json!(""))),
        true,
        json!({"blocker_count":proof_count}),
    );
    add(
        "RefereeRepairQueue",
        if repair_requested {
            "ATTENTION"
        } else if !proof_blocked {
            "PASS"
        } else {
            "FAIL"
        },
        json!(format!(
            "open_proof_blockers={}",
            if repair["open_proof_blocker_count"].is_null() {
                "0".to_string()
            } else {
                js_text(&repair["open_proof_blocker_count"])
            }
        )),
        proof_blocked && !repair_requested,
        repair.clone(),
    );
    add(
        "GateRun",
        if gate_status == "PASS" {
            "PASS"
        } else {
            "FAIL"
        },
        gate_status.clone(),
        true,
        gate,
    );
    add(
        "ArtifactPackage",
        if package == "PASS" { "PASS" } else { "FAIL" },
        package.clone(),
        true,
        object(&snapshot["package"]),
    );
    add(
        "SubmissionPreflight",
        if preflight == "PASS" { "PASS" } else { "FAIL" },
        preflight.clone(),
        true,
        object(&snapshot["submission_preflight"]),
    );
    add(
        "WarningReview",
        if warning_status == "PASS" {
            "PASS"
        } else {
            "FAIL"
        },
        warning_status.clone(),
        true,
        warning_ref,
    );
    add(
        "ReleaseVerification",
        if release == "PASS" { "PASS" } else { "FAIL" },
        release.clone(),
        true,
        object(&snapshot["release_verify"]),
    );
    add(
        "ManualVenueAuthorization",
        if external { "PASS" } else { "ATTENTION" },
        json!(if external {
            "external_action_authorized"
        } else {
            "external_action_not_authorized"
        }),
        false,
        object(&snapshot["manual_venue_authorization"]),
    );
    let (state, action) = if !source {
        (
            "SOURCE_MISSING",
            "restore or declare the source workspace and main tex",
        )
    } else if !contract {
        (
            "CONTRACT_MISSING",
            "declare the paper-specific proof/quality contract",
        )
    } else if proof_blocked && repair_requested {
        (
            "REPAIR_REQUESTED",
            "dispatch or complete the open proof-readiness repair requests",
        )
    } else if proof_blocked {
        (
            "PROOF_BLOCKED",
            "sync proof blockers into the referee repair queue",
        )
    } else if gate_status != "PASS" {
        ("GATE_BLOCKED", "run or repair the paper gate")
    } else if package != "PASS" {
        (
            "PACKAGE_BLOCKED",
            "create and verify a local package after upstream gates pass",
        )
    } else if preflight != "PASS" {
        ("PREFLIGHT_BLOCKED", "run or repair submission preflight")
    } else if warning_status != "PASS" {
        (
            "WARNING_REVIEW_BLOCKED",
            "run or repair warning review before local release",
        )
    } else if release != "PASS" {
        (
            "LOCAL_RELEASE_BLOCKED",
            "freeze and verify the local release archive",
        )
    } else if !external {
        (
            "EXTERNAL_AUTH_REQUIRED",
            "request explicit human venue/external submission authorization",
        )
    } else {
        (
            "PRODUCTION_READY_LOCAL_ONLY",
            "ready for authorized external submission handoff",
        )
    };
    let blocking: Vec<_> = stages
        .iter()
        .filter(|v| v["blocking"] == true && v["status"] == "FAIL")
        .cloned()
        .collect();
    Ok(
        json!({"slug":fallback(&snapshot["slug"],json!("")),"status":if state=="PRODUCTION_READY_LOCAL_ONLY"{"PASS"}else if state=="EXTERNAL_AUTH_REQUIRED"{"ATTENTION"}else{"FAIL"},"production_state":state,"next_action":action,"source_ready":source,"proof_blocked":proof_blocked,"proof_blocker_count":proof_count,"repair_requested":repair_requested,"open_proof_blocker_count":repair_count,"stage_checks":stages,"blocking_stage_count":blocking.len(),"blocking_stages":blocking,"inputs":snapshot}),
    )
}

pub fn summarize_v1(papers: &[Value]) -> Result<Value, String> {
    if papers.len() > MAX_PAPERS {
        return Err(invalid());
    }
    budget(&papers.iter().collect::<Vec<_>>())?;
    let mut states = BTreeMap::<String, i64>::new();
    let mut statuses = BTreeMap::<String, i64>::new();
    let mut proof = 0i64;
    let mut repair = 0i64;
    for paper in papers {
        if !paper.is_object() {
            return Err(invalid());
        }
        *states
            .entry(js_text(&fallback(&paper["production_state"], json!(""))))
            .or_default() += 1;
        *statuses
            .entry(js_text(&fallback(&paper["status"], json!(""))))
            .or_default() += 1;
        proof = proof
            .checked_add(integer(&paper["proof_blocker_count"])?)
            .filter(|v| v.unsigned_abs() <= MAX_INTEGER as u64)
            .ok_or_else(invalid)?;
        repair = repair
            .checked_add(integer(&paper["open_proof_blocker_count"])?)
            .filter(|v| v.unsigned_abs() <= MAX_INTEGER as u64)
            .ok_or_else(invalid)?;
    }
    let fail = statuses.get("FAIL").copied().unwrap_or(0);
    let attention = statuses.get("ATTENTION").copied().unwrap_or(0);
    let mut value = json!({"status":if fail>0{"FAIL"}else if attention>0{"ATTENTION"}else{"PASS"},"paper_count":papers.len(),"pass_count":statuses.get("PASS").copied().unwrap_or(0),"fail_count":fail,"attention_count":attention,"state_counts":states,"proof_blocked_count":papers.iter().filter(|v|truthy(&v["proof_blocked"])).count(),"proof_blocker_count":proof,"open_proof_blocker_count":repair});
    for (field, state) in [
        ("source_missing_count", "SOURCE_MISSING"),
        ("contract_missing_count", "CONTRACT_MISSING"),
        ("repair_requested_count", "REPAIR_REQUESTED"),
        ("gate_blocked_count", "GATE_BLOCKED"),
        ("package_blocked_count", "PACKAGE_BLOCKED"),
        ("preflight_blocked_count", "PREFLIGHT_BLOCKED"),
        ("warning_review_blocked_count", "WARNING_REVIEW_BLOCKED"),
        ("local_release_blocked_count", "LOCAL_RELEASE_BLOCKED"),
        ("external_auth_required_count", "EXTERNAL_AUTH_REQUIRED"),
        (
            "production_ready_local_only_count",
            "PRODUCTION_READY_LOCAL_ONLY",
        ),
    ] {
        value[field] = json!(states.get(state).copied().unwrap_or(0));
    }
    Ok(value)
}

pub fn audit_v1(
    snapshots: &[Value],
    label: &str,
    created_at: &str,
    skipped: &[Value],
) -> Result<Value, String> {
    if snapshots.len() > MAX_PAPERS
        || created_at.is_empty()
        || created_at.len() > 256
        || label.len() > 256
        || skipped.len() > MAX_PAPERS
    {
        return Err(invalid());
    }
    budget(&snapshots.iter().chain(skipped).collect::<Vec<_>>())?;
    let papers = snapshots
        .iter()
        .map(evaluate_snapshot_v1)
        .collect::<Result<Vec<_>, _>>()?;
    let summary = summarize_v1(&papers)?;
    Ok(
        json!({"created_at":created_at,"command":"paper-production-core-audit","status":summary["status"],"label":label,
        "report_schema":{"schema_id":"paper_factory.paper_production.core_audit.v1","stable_top_level_fields":["created_at","command","status","label","report_schema","paper_contract_chain","paper_profiles","summary","papers","skipped","boundary"],"stable_summary_fields":["paper_count","pass_count","fail_count","attention_count","state_counts","contract_missing_count","proof_blocked_count","repair_requested_count","external_auth_required_count"],"deprecated_fields":[],"notes":["A paper has exactly one highest-priority production_state.","Missing proof/quality contract is production-blocking even when lower proof-readiness reports are migration ATTENTION.","External submission is never implied by local package, preflight, archive, or release verification."]},
        "paper_contract_chain":["PaperRegistryRecord","SourceWorkspace","ClaimInventory","ClaimClassification","EvidenceProvenance","ProofOrQualityContract","ProofReadinessReport","RefereeRepairQueue","GateRun","ArtifactPackage","SubmissionPreflight","HandoffIndex","LocalArchive","ReleaseVerification","ManualVenueAuthorization","ExternalSubmissionReceipt"],
        "paper_profiles":["theorem_or_proof_paper","empirical_or_experiment_paper","systems_or_artifact_paper","survey_or_position_paper","external_data_or_human_subjects_paper"],"summary":summary,"papers":papers,"skipped":skipped,
        "boundary":{"source_mutation_performed":false,"package_mutation_performed":false,"archive_mutation_performed":false,"provider_model_call_performed":false,"external_action_performed":false,"secret_material_read_performed":false,"commit_performed":false}}),
    )
}

pub fn frontier_v1(report: &Value) -> Result<Value, String> {
    budget(&[report])?;
    if !report.is_object()
        || (!report["summary"].is_null() && !report["summary"].is_object())
        || (!report["summary"]["state_counts"].is_null()
            && !report["summary"]["state_counts"].is_object())
    {
        return Err(invalid());
    }
    let papers = array_field(report, "papers")?;
    if papers.iter().any(|v| !v.is_object()) {
        return Err(invalid());
    }
    if papers.is_empty() {
        return Ok(
            json!({"action":"NO_TARGETS","terminal":true,"state":"","paper_count":0,"slugs":[],"reason":"no selected papers"}),
        );
    }
    let fail = integer(&report["summary"]["fail_count"])?;
    if fail == 0 {
        let mut states = papers
            .iter()
            .filter_map(|v| v["production_state"].as_str())
            .filter(|v| matches!(*v, "EXTERNAL_AUTH_REQUIRED" | "PRODUCTION_READY_LOCAL_ONLY"))
            .collect::<Vec<_>>();
        states.sort_unstable();
        states.dedup();
        return Ok(
            json!({"action":"LOCAL_PRODUCTION_COMPLETE","terminal":true,"state":states.join(","),"paper_count":papers.len(),"slugs":papers.iter().map(|v|fallback(&v["slug"],json!(""))).collect::<Vec<_>>(),"reason":"local production core has no failing states"}),
        );
    }
    for &(state, action, reason) in STATES {
        let count = integer(&report["summary"]["state_counts"][state])?;
        if count <= 0 {
            continue;
        }
        return Ok(
            json!({"action":action,"terminal":action.starts_with("BLOCKED_"),"state":state,"paper_count":count,"slugs":papers.iter().filter(|v|v["production_state"]==state).map(|v|fallback(&v["slug"],json!(""))).collect::<Vec<_>>(),"reason":reason}),
        );
    }
    Ok(
        json!({"action":"BLOCKED_UNKNOWN_STATE","terminal":true,"state":"","paper_count":fail,"slugs":papers.iter().filter(|v|v["status"]=="FAIL").map(|v|fallback(&v["slug"],json!(""))).collect::<Vec<_>>(),"reason":"production audit failed with no recognized repair-loop frontier"}),
    )
}

pub fn shard_v1(frontier: &Value, worker_limit: &Value) -> Result<Value, String> {
    budget(&[frontier, worker_limit])?;
    if !frontier.is_object() {
        return Err(invalid());
    }
    let slugs = array_field(frontier, "slugs")?
        .into_iter()
        .filter(truthy)
        .collect::<Vec<_>>();
    if slugs.len() > MAX_PAPERS {
        return Err(invalid());
    }
    let limit = integer(worker_limit)?.max(0);
    let applied = frontier["action"] == "RUN_REFEREE_REPAIR" && limit > 0;
    let split = if applied {
        usize::try_from(limit)
            .unwrap_or(usize::MAX)
            .min(slugs.len())
    } else {
        slugs.len()
    };
    Ok(
        json!({"worker_limit":limit,"worker_limit_applied":applied,"frontier_slugs":slugs,"selected_slugs":slugs[..split],"deferred_slugs":slugs[split..]}),
    )
}

pub fn resolve_artifact_v1(request: &Value) -> Result<Value, String> {
    record(request)?;
    let requested = fallback(&request["requestedLabel"], json!(""));
    let latest = fallback(&request["latestLabel"], json!(""));
    let count = integer(&request["requestedPackageCount"])?;
    let present = if request["requestedPresentCount"].is_null() {
        count
    } else {
        integer(&request["requestedPresentCount"])?
    };
    let (label, source, back) = if truthy(&requested) && present > 0 {
        (requested.clone(), "requested_label", json!(""))
    } else if truthy(&latest) && latest != requested {
        (latest.clone(), "latest_package_label", requested.clone())
    } else {
        (
            fallback(&requested, latest.clone()),
            if truthy(&requested) {
                "requested_label"
            } else if truthy(&latest) {
                "latest_package_label"
            } else {
                ""
            },
            json!(""),
        )
    };
    Ok(
        json!({"artifact_label":label,"artifact_label_source":source,"fallback_from_label":back,"requested_package_count":count,"requested_present_count":present}),
    )
}
