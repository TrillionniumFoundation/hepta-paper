//! Incumbent campaign query presentation, without writer or provider authority.
use super::json::{
    field as f, nullable, nullish_number, object, same_scalar, string, text, truthy,
};
use hepta_legacy_compatibility::{ProductionCollationV1, ProductionJsonValue as Json};

pub(super) fn campaign(value: &Json) -> Result<Json, String> {
    if matches!(value, Json::Null) {
        return Err("Cannot read properties of null (reading 'campaignId')".into());
    }
    Ok(object([
        ("campaignId", nullable(f(value, "campaignId"))),
        ("paperId", nullable(f(value, "paperId"))),
        ("status", nullable(f(value, "status"))),
        (
            "effectiveStatus",
            if truthy(f(value, "effectiveStatus")) {
                f(value, "effectiveStatus").clone()
            } else {
                nullable(f(value, "status"))
            },
        ),
        ("currentPhase", nullable(f(value, "currentPhase"))),
        (
            "currentReviewRound",
            nullish_number(f(value, "currentReviewRound"), 0.0)?,
        ),
        ("maxRounds", nullish_number(f(value, "maxRounds"), 0.0)?),
        (
            "usage",
            object([
                (
                    "agentCalls",
                    nullish_number(f(value, "agentCallCount"), 0.0)?,
                ),
                ("cpuJobs", nullish_number(f(value, "cpuJobCount"), 0.0)?),
                ("gpuJobs", nullish_number(f(value, "gpuJobCount"), 0.0)?),
                ("tokens", nullish_number(f(value, "tokenCount"), 0.0)?),
                (
                    "costUsd",
                    if same_scalar(f(value, "costKnown"), &Json::Bool(false))
                        || matches!(f(value, "costUsd"), Json::Null)
                    {
                        string("unknown")
                    } else {
                        f(value, "costUsd").clone()
                    },
                ),
            ]),
        ),
        ("stopReason", nullable(f(value, "stopReason"))),
        (
            "lineage",
            object([
                ("parent", nullable(f(value, "parentCampaignId"))),
                ("supersedes", nullable(f(value, "supersedesCampaignId"))),
                ("recoveryOf", nullable(f(value, "recoveryOfCampaignId"))),
            ]),
        ),
        ("updatedAt", nullable(f(value, "updatedAt"))),
    ]))
}
pub(super) fn node(value: &Json) -> Result<Json, String> {
    Ok(object([
        ("nodeId", nullable(f(value, "nodeId"))),
        ("kind", nullable(f(value, "kind"))),
        ("roundIndex", nullish_number(f(value, "roundIndex"), 0.0)?),
        ("status", nullable(f(value, "status"))),
        (
            "attemptCount",
            nullish_number(f(value, "attemptCount"), 0.0)?,
        ),
        ("maxAttempts", nullish_number(f(value, "maxAttempts"), 0.0)?),
        ("failureClass", nullable(f(value, "failureClass"))),
        ("reviewerId", nullable(f(value, "reviewerId"))),
        ("childSessionId", nullable(f(value, "childSessionId"))),
        ("reviewHash", nullable(f(value, "reviewHash"))),
        ("resolvedModel", nullable(f(value, "resolvedModel"))),
        ("resultHash", nullable(f(value, "resultSha256"))),
        ("updatedAt", nullable(f(value, "updatedAt"))),
    ]))
}
pub(super) fn status(
    campaign_value: Json,
    nodes: Vec<Json>,
    details: bool,
) -> Result<Json, String> {
    if details {
        return Ok(object([
            ("campaign", campaign_value),
            ("nodes", Json::Array(nodes)),
        ]));
    }
    let mut counts: Vec<(Vec<u16>, u64)> = Vec::new();
    let mut active = Vec::new();
    let mut failed = Vec::new();
    for value in &nodes {
        let state = f(value, "status");
        let key = if truthy(state) {
            text(state)
        } else {
            text(&string("unknown"))
        };
        if let Some((_, count)) = counts.iter_mut().find(|(name, _)| *name == key) {
            *count += 1;
        } else {
            counts.push((key, 1));
        }
        if same_scalar(state, &string("leased")) || same_scalar(state, &string("running")) {
            active.push(node(value)?);
        }
        if same_scalar(state, &string("failed_terminal")) {
            failed.push(node(value)?);
        }
    }
    let collation = ProductionCollationV1::load().map_err(|error| error.to_string())?;
    counts.sort_by(|(left, _), (right, _)| {
        collation.compare(
            &String::from_utf16_lossy(left),
            &String::from_utf16_lossy(right),
        )
    });
    Ok(object([
        ("campaign", campaign(&campaign_value)?),
        (
            "nodeCounts",
            Json::Object(
                counts
                    .into_iter()
                    .map(|(key, count)| (key, Json::Number(count as f64)))
                    .collect(),
            ),
        ),
        ("activeNodes", Json::Array(active)),
        ("failedNodes", Json::Array(failed)),
    ]))
}
pub(super) fn event(value: &Json) -> Json {
    let event = f(value, "event");
    let selected = |key| {
        if truthy(f(value, key)) {
            nullable(f(value, key))
        } else {
            nullable(f(event, key))
        }
    };
    object([
        ("eventId", nullable(f(value, "eventId"))),
        ("campaignId", selected("campaignId")),
        ("nodeId", selected("nodeId")),
        ("kind", selected("kind")),
        (
            "detail",
            if truthy(f(event, "detail")) {
                f(event, "detail").clone()
            } else {
                Json::Object(Vec::new())
            },
        ),
        ("createdAt", selected("createdAt")),
        ("eventHash", nullable(f(value, "eventSha256"))),
    ])
}
pub(super) fn log(value: Json, details: bool) -> Result<Json, String> {
    if details {
        return Ok(value);
    }
    let result = f(&value, "result");
    let failure = f(&value, "failureDetail");
    let receipt = |names: &[&str], data: &Json, fallback: &Json| {
        names
            .iter()
            .map(|key| f(data, key))
            .find(|v| truthy(v))
            .map_or_else(|| nullable(fallback), Clone::clone)
    };
    let result_report = if truthy(result) {
        object([
            ("kind", nullable(f(result, "kind"))),
            ("status", nullable(f(result, "status"))),
            (
                "receiptHash",
                receipt(
                    &[
                        "receiptHash",
                        "agentExecutionReceiptHash",
                        "multiLanguageEmpiricalReceiptHash",
                        "automationRepairExecutionReceiptHash",
                    ],
                    result,
                    f(&value, "resultSha256"),
                ),
            ),
            (
                "blockers",
                if matches!(f(result, "blockers"), Json::Array(_)) {
                    f(result, "blockers").clone()
                } else {
                    Json::Array(Vec::new())
                },
            ),
            ("usage", nullable(f(result, "usage"))),
            ("summary", nullable(f(result, "summary"))),
        ])
    } else {
        Json::Null
    };
    let failure_report = if truthy(failure) {
        let tail = if truthy(f(failure, "stderrTail")) {
            text(f(failure, "stderrTail"))
        } else {
            Vec::new()
        };
        object([
            ("message", nullable(f(failure, "message"))),
            (
                "blockers",
                if matches!(f(failure, "blockers"), Json::Array(_)) {
                    f(failure, "blockers").clone()
                } else {
                    Json::Array(Vec::new())
                },
            ),
            ("receiptKind", nullable(f(failure, "receiptKind"))),
            ("receiptStatus", nullable(f(failure, "receiptStatus"))),
            (
                "receiptHash",
                receipt(&["receiptHash"], failure, f(&value, "failureSha256")),
            ),
            (
                "stderrTail",
                Json::String(tail[tail.len().saturating_sub(2000)..].to_vec()),
            ),
        ])
    } else {
        Json::Null
    };
    Ok(object([
        ("node", node(&value)?),
        ("result", result_report),
        ("failure", failure_report),
    ]))
}
