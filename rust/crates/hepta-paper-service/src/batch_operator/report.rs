//! Complete preview/report projection from observed tasks and the existing DAG.
use super::*;
use std::io::{self, Write};
fn hash(kind: &str, value: &Value) -> Result<String, String> {
    hepta_legacy_compatibility::production_hash_record_v1(kind, value)
        .map(|h| h.as_str().to_owned())
        .map_err(|e| e.to_string())
}
struct BoundedOutput(Vec<u8>);
impl Write for BoundedOutput {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        if self
            .0
            .len()
            .checked_add(b.len())
            .is_none_or(|size| size > 16 * 1024 * 1024)
        {
            return Err(io::Error::other("native_batch_operator_output_budget_v1"));
        }
        self.0.extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(super) fn bounded_pretty_json(value: &Value) -> Result<Vec<u8>, String> {
    let mut output = BoundedOutput(Vec::new());
    serde_json::to_writer_pretty(&mut output, value).map_err(|e| e.to_string())?;
    Ok(output.0)
}
fn text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        _ => v.to_string(),
    }
}
fn workflow_row(state: &Value) -> Value {
    let mut row = json!({"paper_id":state["paperId"],"venue":state["venue"].as_str().unwrap_or(""),"source_workspace":state["sourceWorkspace"].as_str().unwrap_or(""),"next_action":state["nextAction"].as_str().unwrap_or(""),"auto_level":state["autoLevel"].as_str().unwrap_or(""),"submission_intent":state["submissionIntent"]["status"].as_str().unwrap_or(""),"production_disposition":state["submissionIntent"]["disposition"].as_str().unwrap_or("")});
    for (output, input) in [
        ("draft_status", "draftStatus"),
        ("compile_status", "compileStatus"),
        ("research_verify_status", "researchVerifyStatus"),
        ("package_status", "packageStatus"),
        ("readiness_status", "readinessStatus"),
        ("runner_status", "runnerStatus"),
        ("submission_status", "submissionStatus"),
    ] {
        row[output] = state[input].clone();
    }
    row
}
pub(super) fn result(
    row: &Value,
    command: Option<&Value>,
    mode: &str,
    recorded: &str,
) -> Result<Value, String> {
    let command = command.unwrap_or(&Value::Null);
    let plan = &command["campaignPlan"];
    let nodes = plan["nodes"].as_array().cloned().unwrap_or_default();
    let mut kinds = nodes
        .iter()
        .filter_map(|n| n["kind"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    kinds.sort();
    kinds.dedup();
    let queue = json!({"version":1,"kind":"PaperBatchCampaignQueueStatus","status":if command.is_null(){"paper_campaign_not_applicable"}else{"paper_campaign_planned_not_queued"},"executionStatus":if command.is_null(){"not_applicable"}else{"planned_not_queued"},"workflowExecutionPerformed":false,"campaignId":command["campaignId"],"campaignPlanHash":command["campaignPlanHash"],"nodeCount":nodes.len(),"nodeKinds":kinds,"requestedMode":command["requestedMode"].as_str().unwrap_or(mode),"effectiveMode":plan["mode"],"releaseHandoffRequired":plan["releaseHandoffRequired"]==true,"externalSubmissionEnabled":plan["externalSubmissionEnabled"]==true,"idempotentReplay":false});
    let mut lineage = json!({"version":1,"kind":"WorkflowAuthorityLineageReceipt","status":"workflow_authority_lineage_previewed","paperId":row["task"]["paperId"],"mode":mode,"campaignId":command["campaignId"],"campaignPlanHash":command["campaignPlanHash"],"workflowReceiptHash":null,"operationalAuthority":"campaign-dag-v1","operationalAuthorityTables":["paper_campaigns","campaign_nodes","campaign_events"],"batchRole":"command_use_case_facade","paperStatusRole":"canonical_read_projection","legacyWorkflowStateRole":"explicit_compatibility_projection","legacyProjectionRequested":false,"legacyProjectionAuthorized":false,"recordedAt":recorded,"externalActionPerformed":false});
    lineage["workflowAuthorityLineageReceiptHash"] =
        json!(hash("WorkflowAuthorityLineageReceipt", &lineage)?);
    let state = &row["state"];
    let status = row["task"]["registry"]["status"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| state["stage"].as_str().filter(|s| !s.is_empty()))
        .or_else(|| state["readinessStatus"].as_str().filter(|s| !s.is_empty()))
        .unwrap_or("unknown");
    let projection = json!({"version":1,"kind":"CanonicalPaperStatusReadProjection","paperId":row["task"]["paperId"],"status":status,"source":"papers.status","role":"canonical_read_projection","operationalAuthority":"campaign-dag-v1","recordedAt":recorded});
    Ok(
        json!({"paperId":row["task"]["paperId"],"task":row["task"],"state":state,"campaignCommand":command,"campaignPlan":plan,"campaignSubmission":null,"campaignQueue":queue,"workflowStateProjection":null,"workflowAuthorityLineage":lineage,"workflowAuthorityLedgerEntry":null,"paperStatusProjection":projection,"workflowRow":workflow_row(state)}),
    )
}
const HEADERS: &[&str] = &[
    "paper_id",
    "venue",
    "draft_status",
    "compile_status",
    "research_verify_status",
    "package_status",
    "readiness_status",
    "runner_status",
    "submission_status",
    "next_action",
    "auto_level",
    "submission_intent",
    "production_disposition",
];
fn markdown(rows: &[Value]) -> String {
    let mut lines = vec![
        format!("| {} |", HEADERS.join(" | ")),
        format!("| {} |", vec!["---"; HEADERS.len()].join(" | ")),
    ];
    for row in rows {
        lines.push(format!(
            "| {} |",
            HEADERS
                .iter()
                .map(|key| text(&row[*key]).replace('|', "/").replace('\n', " "))
                .collect::<Vec<_>>()
                .join(" | ")
        ));
    }
    lines.join("\n") + "\n"
}
fn family(code: &str) -> &'static str {
    let s = code.to_lowercase();
    for (name, words) in [
        ("source", &["source", "main_tex", "tex"][..]),
        ("venue", &["venue"][..]),
        ("build", &["latex", "compile", "build"][..]),
        (
            "research_verify",
            &["evidence", "claim", "proof", "research", "reproduc"][..],
        ),
        (
            "package",
            &["artifact", "package", "zip", "pdf", "checksum", "sha256"][..],
        ),
        (
            "runner_handoff",
            &[
                "runner", "receipt", "handoff", "manifest", "dry_run", "replay",
            ][..],
        ),
        (
            "authorization",
            &["approval", "authorize", "authorization", "live_submit"][..],
        ),
        (
            "submission",
            &["submit", "submission", "portal", "external"][..],
        ),
    ] {
        if words.iter().any(|word| s.contains(word)) {
            return name;
        }
    }
    "other"
}
fn families(results: &[Value]) -> Result<(Value, String), String> {
    let mut data = BTreeMap::<String, (usize, usize, BTreeMap<String, usize>, Vec<Value>)>::new();
    for result in results {
        let mut seen = std::collections::BTreeSet::new();
        for code in result["state"]["blockers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let name = family(code);
            let entry = data.entry(name.into()).or_default();
            entry.1 += 1;
            *entry.2.entry(code.to_owned()).or_default() += 1;
            if seen.insert(name) {
                entry.0 += 1;
                if entry.3.len() < 32 {
                    entry.3.push(result["paperId"].clone());
                }
            }
        }
    }
    let collation =
        hepta_legacy_compatibility::ProductionCollationV1::load().map_err(|e| e.to_string())?;
    let mut ordered = data.into_iter().collect::<Vec<_>>();
    ordered.sort_by(|(a, x), (b, y)| y.0.cmp(&x.0).then_with(|| collation.compare(a, b)));
    let mut output = serde_json::Map::new();
    let mut table = vec![
        "| family | papers | blockers | top_blockers |".to_owned(),
        "| --- | --- | --- | --- |".to_owned(),
    ];
    for (name, (papers, total, blockers, ids)) in ordered {
        let mut top = blockers.iter().collect::<Vec<_>>();
        top.sort_by(|(a, x), (b, y)| y.cmp(x).then_with(|| collation.compare(a, b)));
        top.truncate(12);
        table.push(format!(
            "| {name} | {papers} | {total} | {} |",
            top.iter()
                .map(|(code, count)| format!("{code}:{count}"))
                .collect::<Vec<_>>()
                .join(", ")
                .replace('|', "/")
        ));
        output.insert(name.clone(),json!({"family":name,"paperCount":papers,"blockerCount":total,"blockers":blockers,"paperIds":ids,"topBlockers":top.iter().map(|(code,count)|json!({"code":code,"count":count})).collect::<Vec<_>>()}));
    }
    Ok((Value::Object(output), table.join("\n") + "\n"))
}
fn summary_rows(rows: &[Value], mode: &str) -> Value {
    let count = |field: &str, accepted: &[&str]| {
        rows.iter()
            .filter(|row| row[field].as_str().is_some_and(|v| accepted.contains(&v)))
            .count()
    };
    json!({"mode":mode,"total":rows.len(),"sourceReady":count("draft_status",&["source_tex_present"]),"buildReady":count("compile_status",&["compiled_pdf_present","build_ready","build_passed"]),"researchContractStatusObserved":count("research_verify_status",&["verified","evidence_present","proposal_seed_present","manual_review_only"]),"packageReady":count("package_status",&["package_present","package_ready"]),"localDryRunReady":count("readiness_status",&["ready_for_local_dry_run"]),"dryRunReceipts":count("runner_status",&["dry_run_receipt_recorded"]),"reviewedSubmitBlocked":count("next_action",&["paper.venue.reviewed_submit"]),"blocked":count("readiness_status",&["blocked"]),"activeSubmissionCandidates":count("production_disposition",&["active_submission"]),"needsVenueDecision":count("submission_intent",&["needs_venue_decision"]),"needsSourceAdapt":count("submission_intent",&["source_adapt_required"]),"nonSubmissionArchive":count("submission_intent",&["non_submission_archive"])} )
}
fn optional(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(crate::automation_runtime_reconciliation::sqlite_number::trim)
        .filter(|s| !s.is_empty())
}
pub(super) fn build(
    options: &NativeBatchCliOptionsV1,
    scan: &Value,
    results: &[Value],
    target: Value,
    provenance: Value,
    generated: &str,
) -> Result<Value, String> {
    let rows = results
        .iter()
        .map(|r| r["workflowRow"].clone())
        .collect::<Vec<_>>();
    let (families, family_table) = families(results)?;
    let campaigns=results.iter().filter(|r|!r["campaignQueue"]["campaignId"].is_null()).map(|r|{let q=&r["campaignQueue"];json!({"paperId":r["paperId"],"status":q["status"],"executionStatus":q["executionStatus"],"workflowExecutionPerformed":false,"campaignId":q["campaignId"],"campaignPlanHash":q["campaignPlanHash"],"requestedMode":q["requestedMode"],"effectiveMode":q["effectiveMode"],"releaseHandoffRequired":q["releaseHandoffRequired"],"externalSubmissionEnabled":q["externalSubmissionEnabled"],"nodeCount":q["nodeCount"],"nodeKinds":q["nodeKinds"],"idempotentReplay":false})}).collect::<Vec<_>>();
    let mut kinds = campaigns
        .iter()
        .flat_map(|c| {
            c["nodeKinds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    kinds.sort();
    kinds.dedup();
    let status = if !campaigns.is_empty() {
        "paper_campaigns_planned_not_queued"
    } else if options.mode == "inventory" {
        "paper_batch_inventory_preview"
    } else {
        "paper_campaign_plan_preview_unavailable"
    };
    let counts = results
        .iter()
        .map(|r| r["campaignQueue"]["nodeCount"].as_u64().unwrap_or(0))
        .collect::<Vec<_>>();
    let queue = json!({"planned":results.iter().filter(|r|!r["campaignPlan"].is_null()).count(),"submitted":0,"queued":0,"replayed":0,"nodeCount":counts.iter().sum::<u64>(),"maximumNodesPerCampaign":counts.iter().max().copied().unwrap_or(0),"workflowExecutionsPerformed":0,"status":status,"executionStatus":"not_executed","workflowExecutionPerformed":false,"campaignIds":campaigns.iter().map(|c|c["campaignId"].clone()).collect::<Vec<_>>(),"campaignPlanHashes":campaigns.iter().map(|c|c["campaignPlanHash"].clone()).collect::<Vec<_>>(),"nodeKinds":kinds});
    let mut summary = summary_rows(&rows, &options.mode);
    summary["campaignQueue"] = queue;
    summary["proposalStaging"] = json!({"staged":results.iter().filter(|r|r["task"]["registry"]["inventorySource"]=="proposal_staging").count(),"sourceSkeletons":results.iter().filter(|r|r["task"]["registry"]["inventorySource"]=="proposal_staging"&&r["task"]["sourceWorkspace"].as_str().is_some_and(|s|s.contains("/runtime/proposals/"))).count()});
    summary["blockerFamilies"] = families;
    let mut report = json!({"version":2,"kind":"PaperBatchRunReport","status":status,"executionStatus":"not_executed","workflowExecutionPerformed":false,"generatedAt":generated,"root":options.root,"runtimeRoot":options.runtime_root,"mode":options.mode,"execute":false,"codeProvenance":provenance,"requestedTargetOverride":optional(&options.target_override),"requestedDatasetRoot":optional(&options.dataset_root),"requestedBenchmarkId":optional(&options.benchmark_id),"requestedApplyManuscript":options.apply_manuscript,"registryRefs":scan["registryRefs"],"targetScopeReceipt":target,"inventory":{"source":scan["inventorySource"],"fallback":scan["inventoryFallback"],"quarantinedCount":scan["quarantined"].as_array().map_or(0,Vec::len),"quarantined":scan["quarantined"]},"summary":summary,"campaignSubmissions":campaigns,"rows":rows,"results":results,"markdownTable":markdown(&rows),"blockerFamilyTable":family_table,"safety":{"vendoredReferenceRuntimeScanPerformed":false,"importsOldPaperFactoryControlPlane":false,"externalActionPerformed":false,"reviewedSubmitBlockedByDefault":true}});
    report["reportHash"] = json!(hash("PaperBatchRunReport", &report)?);
    Ok(report)
}
fn ordered_object(
    value: &Value,
    keys: &[&str],
) -> crate::online_runtime_activation::ordered_json::Json {
    use crate::online_runtime_activation::ordered_json::Json;
    Json::Object(
        keys.iter()
            .map(|key| ((*key).into(), Json::Scalar(value[*key].clone())))
            .collect(),
    )
}
fn console_summary(report: &Value) -> Result<String, String> {
    use crate::online_runtime_activation::ordered_json::Json;
    let summary = &report["summary"];
    let mut fields = vec![];
    for key in [
        "mode",
        "total",
        "sourceReady",
        "buildReady",
        "researchContractStatusObserved",
        "packageReady",
        "localDryRunReady",
        "dryRunReceipts",
        "reviewedSubmitBlocked",
        "blocked",
        "activeSubmissionCandidates",
        "needsVenueDecision",
        "needsSourceAdapt",
        "nonSubmissionArchive",
    ] {
        fields.push((key.into(), Json::Scalar(summary[key].clone())));
    }
    fields.push((
        "campaignQueue".into(),
        ordered_object(
            &summary["campaignQueue"],
            &[
                "planned",
                "submitted",
                "queued",
                "replayed",
                "nodeCount",
                "maximumNodesPerCampaign",
                "workflowExecutionsPerformed",
                "status",
                "executionStatus",
                "workflowExecutionPerformed",
                "campaignIds",
                "campaignPlanHashes",
                "nodeKinds",
            ],
        ),
    ));
    fields.push((
        "proposalStaging".into(),
        ordered_object(&summary["proposalStaging"], &["staged", "sourceSkeletons"]),
    ));
    let collation =
        hepta_legacy_compatibility::ProductionCollationV1::load().map_err(|e| e.to_string())?;
    let mut families = summary["blockerFamilies"]
        .as_object()
        .ok_or("native_batch_operator_summary_shape_invalid")?
        .iter()
        .collect::<Vec<_>>();
    families.sort_by(|(a, x), (b, y)| {
        y["paperCount"]
            .as_u64()
            .cmp(&x["paperCount"].as_u64())
            .then_with(|| collation.compare(a, b))
    });
    let mut family_fields = vec![];
    for (name, value) in families {
        let mut keys = vec![];
        for result in report["results"]
            .as_array()
            .ok_or("native_batch_operator_summary_shape_invalid")?
        {
            for code in result["state"]["blockers"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if family(code) == name && !keys.contains(&code) {
                    keys.push(code);
                }
            }
        }
        let blockers = ordered_object(&value["blockers"], &keys);
        let top = Json::Array(
            value["topBlockers"]
                .as_array()
                .ok_or("native_batch_operator_summary_shape_invalid")?
                .iter()
                .map(|v| ordered_object(v, &["code", "count"]))
                .collect(),
        );
        family_fields.push((
            name.clone(),
            Json::Object(vec![
                ("family".into(), Json::Scalar(value["family"].clone())),
                (
                    "paperCount".into(),
                    Json::Scalar(value["paperCount"].clone()),
                ),
                (
                    "blockerCount".into(),
                    Json::Scalar(value["blockerCount"].clone()),
                ),
                ("blockers".into(), blockers),
                ("paperIds".into(), Json::Scalar(value["paperIds"].clone())),
                ("topBlockers".into(), top),
            ]),
        ));
    }
    fields.push(("blockerFamilies".into(), Json::Object(family_fields)));
    Json::Object(fields).stringify().map_err(|e| e.to_string())
}
pub(super) fn console(report: &Value) -> Result<String, String> {
    Ok(format!(
        "paper-production-core {}: {}\n{}\n\n{}",
        text(&report["mode"]),
        text(&report["status"]),
        console_summary(report)?,
        text(&report["markdownTable"])
    ))
}
