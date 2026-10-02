use super::*;

fn node(
    id: &str,
    kind: &str,
    deps: Vec<String>,
    position: (u64, u64),
    role: Option<&str>,
    language: Option<&str>,
    intent: &Value,
) -> Value {
    let (round, priority) = position;
    json!({"nodeId":format!("{id}:{round}:{kind}"),"kind":kind,"roundIndex":round,"dependencies":deps,"priority":priority,"maxAttempts":3,"role":role,"language":language,"requiresGpu":false,"executionIntent":intent})
}
fn node_id(node: &Value) -> Result<String, String> {
    node["nodeId"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(refusal)
}
fn formal_chain(
    id: &str,
    deps: Vec<String>,
    round: u64,
    priority: u64,
    intent: &Value,
    sealed: bool,
) -> Result<Vec<Value>, String> {
    let mut theorem = node(
        id,
        "theorem-spec",
        deps,
        (round, priority),
        Some("theorem-spec-author"),
        Some("lean"),
        intent,
    );
    let mut verify = node(
        id,
        "formal-verify",
        vec![node_id(&theorem)?],
        (round, priority + 2),
        Some("formal-candidate"),
        Some("lean"),
        intent,
    );
    if sealed {
        theorem["sourceClosureTerminal"] = json!(true);
        verify["sourceClosureTerminal"] = json!(true);
    }
    Ok(vec![theorem, verify])
}
fn referees(id: &str, deps: Vec<String>, round: u64, priority: u64, intent: &Value) -> Vec<Value> {
    (1..=3)
        .map(|i| {
            let kind = format!("referee-{i}");
            node(
                id,
                &kind,
                deps.clone(),
                (round, priority),
                Some(&kind),
                None,
                intent,
            )
        })
        .collect()
}
fn graph(
    id: &str,
    mode: &str,
    rounds: u64,
    formal: bool,
    intent: &Value,
) -> Result<Vec<Value>, String> {
    let mut nodes = Vec::new();
    match mode {
        "local-build" => nodes.push(node(
            id,
            "compile",
            vec![],
            (0, 10),
            None,
            Some("latex"),
            intent,
        )),
        "research-verify" => {
            if formal {
                nodes.extend(formal_chain(id, vec![], 0, 10, intent, false)?);
            }
            let deps = nodes.last().map(node_id).transpose()?.into_iter().collect();
            nodes.push(node(
                id,
                "research-verify",
                deps,
                (0, if formal { 20 } else { 10 }),
                None,
                None,
                intent,
            ));
        }
        "referee-review" => nodes.extend(referees(id, vec![], 1, 10, intent)),
        "local-package" | "reviewed-submit" | "local-dry-run" => {
            if formal {
                let compile = node(id, "compile", vec![], (0, 10), None, Some("latex"), intent);
                let deps = vec![node_id(&compile)?];
                nodes.push(compile);
                nodes.extend(formal_chain(id, deps, 0, 20, intent, true)?);
            }
            let deps = nodes.last().map(node_id).transpose()?.into_iter().collect();
            let mut compile = node(
                id,
                "final-compile",
                deps,
                (0, if formal { 30 } else { 10 }),
                None,
                Some("latex"),
                intent,
            );
            if formal {
                compile["sourceClosureTerminal"] = json!(true);
                compile["sourceMutationPolicy"] = json!("forbid");
            }
            let compile_id = node_id(&compile)?;
            let research = node(
                id,
                "research-verify",
                vec![compile_id.clone()]
                    .into_iter()
                    .chain(if formal {
                        vec![format!("{id}:0:formal-verify")]
                    } else {
                        vec![]
                    })
                    .collect(),
                (0, if formal { 30 } else { 20 }),
                None,
                None,
                intent,
            );
            let mut package_deps = vec![compile_id.clone(), node_id(&research)?];
            nodes.extend([compile, research]);
            let include = mode == "local-dry-run";
            if include {
                let reviews = referees(
                    id,
                    vec![compile_id],
                    1,
                    if formal { 40 } else { 30 },
                    intent,
                );
                for r in &reviews {
                    package_deps.push(node_id(r)?);
                }
                nodes.extend(reviews);
            }
            nodes.push(node(
                id,
                "package",
                package_deps,
                (
                    if include { 2 } else { 1 },
                    if formal {
                        if include { 50 } else { 40 }
                    } else if include {
                        40
                    } else {
                        30
                    },
                ),
                None,
                None,
                intent,
            ));
        }
        "referee-revise" => {
            let reviews = referees(id, vec![], 1, 10, intent);
            let revise = node(
                id,
                "revise",
                reviews.iter().map(node_id).collect::<Result<_, _>>()?,
                (1, 20),
                Some("reviser"),
                None,
                intent,
            );
            let mut deps = vec![node_id(&revise)?];
            nodes.extend(reviews);
            nodes.push(revise);
            if formal {
                let chain = formal_chain(id, deps, 1, 24, intent, false)?;
                deps = vec![node_id(chain.last().ok_or_else(refusal)?)?];
                nodes.extend(chain);
            }
            let validations = [
                ("revalidate-compile", Some("latex")),
                ("revalidate-citations", Some("latex")),
                ("revalidate-artifacts", None),
            ]
            .map(|(kind, language)| node(id, kind, deps.clone(), (1, 30), None, language, intent));
            let final_deps = validations.iter().map(node_id).collect::<Result<_, _>>()?;
            nodes.extend(validations);
            nodes.push(node(
                id,
                "final-compile",
                final_deps,
                (1, 40),
                None,
                Some("latex"),
                intent,
            ));
        }
        "local-review-loop" => {
            if formal {
                return Err(
                    "native_batch_campaign_formal_review_loop_domain_v1_not_implemented".into(),
                );
            }
            let compile = node(id, "compile", vec![], (0, 50), None, Some("latex"), intent);
            let mut previous = node_id(&compile)?;
            nodes.push(compile);
            for round in 1..=rounds {
                let reviews = referees(id, vec![previous], round, 60, intent);
                let revise = node(
                    id,
                    "revise",
                    reviews.iter().map(node_id).collect::<Result<_, _>>()?,
                    (round, 70),
                    Some("reviser"),
                    None,
                    intent,
                );
                let deps = vec![node_id(&revise)?];
                nodes.extend(reviews);
                nodes.push(revise);
                let validations = [
                    ("revalidate-compile", Some("latex")),
                    ("revalidate-citations", Some("latex")),
                    ("revalidate-artifacts", None),
                ]
                .map(|(kind, language)| {
                    node(id, kind, deps.clone(), (round, 80), None, language, intent)
                });
                let revision_deps = validations
                    .iter()
                    .map(node_id)
                    .collect::<Result<Vec<_>, _>>()?;
                nodes.extend(validations);
                let revision_reviews = (1..=3)
                    .map(|i| {
                        let kind = format!("revision-referee-{i}");
                        node(
                            id,
                            &kind,
                            revision_deps.clone(),
                            (round, 85),
                            Some(&kind),
                            None,
                            intent,
                        )
                    })
                    .collect::<Vec<_>>();
                let convergence = node(
                    id,
                    "convergence",
                    revision_reviews
                        .iter()
                        .map(node_id)
                        .collect::<Result<_, _>>()?,
                    (round, 90),
                    None,
                    None,
                    intent,
                );
                previous = node_id(&convergence)?;
                nodes.extend(revision_reviews);
                nodes.push(convergence);
            }
            nodes.push(node(
                id,
                "final-compile",
                vec![previous],
                (rounds, 100),
                None,
                Some("latex"),
                intent,
            ));
        }
        _ => return Err(refusal()),
    }
    if nodes.len() > 128 {
        return Err("native_batch_campaign_graph_budget_v1_refused".into());
    }
    Ok(nodes)
}
pub(super) fn build(
    input: &NativeBatchCampaignCommandInputV1,
    subject: &Value,
    id: &str,
    mode: &str,
    binding: Value,
) -> Result<Value, String> {
    let languages: Vec<String> =
        serde_json::from_value(subject["languages"].clone()).map_err(|_| refusal())?;
    let profiles = normalize_profiles(
        &[
            &subject["paperQualityProfile"],
            &subject["paperQualityProfiles"],
            &input.paper_task["paperQualityProfile"],
            &input.paper_task["paperQualityProfiles"],
        ],
        &languages,
        true,
    )?;
    let formal = profiles.iter().any(|p| p == "formal_theorem_or_proof");
    if profiles.iter().any(|p| p == "empirical_or_experiment") {
        return Err("campaign_empirical_profile_requires_benchmark_selector".into());
    }
    let venue = optional(&subject["venueTarget"]);
    if venue.is_some_and(|v| v.len() > 256 || v.chars().any(|c| c < ' ' || c == '\u{007f}')) {
        return Err("campaign_venue_target_invalid".into());
    }
    if mode == "reviewed-submit" && venue.is_none() {
        return Err("campaign_reviewed_submit_venue_target_required".into());
    }
    let requested_rounds = input.options.max_rounds.clamp(1, 10);
    let rounds = if mode == "local-review-loop" {
        requested_rounds
    } else {
        1
    };
    let research_required = matches!(
        mode,
        "local-package" | "research-verify" | "local-dry-run" | "reviewed-submit"
    );
    let quality_requirements = json!({"formalVerificationRequired":formal,"empiricalVerificationRequired":false,"researchVerificationRequired":research_required});
    let intent = json!({"version":2,"kind":"PaperCampaignModeIntent","requestedMode":mode,"effectiveMode":mode,"requestedMaxRounds":requested_rounds,"effectiveMaxRounds":rounds,"venueTarget":venue,"datasetRoot":null,"datasetMountNames":[],"benchmarkId":null,"benchmarkSelectorHash":null,"applyManuscript":false,"paperQualityProfile":profiles.first(),"paperQualityProfiles":profiles,"paperQualityRequirements":quality_requirements,"formalVerificationRequired":formal,"empiricalVerificationRequired":false});
    let nodes = graph(id, mode, rounds, formal, &intent)?;
    let planned_calls: u64 = nodes
        .iter()
        .map(|n| {
            let kind = n["kind"].as_str().unwrap_or_default();
            if kind == "formal-verify" {
                18
            } else if matches!(
                kind,
                "research-plan" | "writer" | "theorem-spec" | "manuscript-integrate" | "revise"
            ) || kind.starts_with("referee-")
                || kind.starts_with("revision-referee-")
            {
                3
            } else {
                0
            }
        })
        .sum();
    let mut payload = json!({"version":4,"kind":"PaperCampaignPlan","campaignId":id,"terminalSiblingSettlementPolicyVersion":1,"parentCampaignId":null,"supersedesCampaignId":null,"recoveryOfCampaignId":null,"paperId":input.paper_task["paperId"],"sourceWorkspace":input.source_workspace,"requestedMode":mode,"mode":mode,"executionIntent":intent,"requestedMaxRounds":requested_rounds,"maxRounds":rounds,"refereeCount":3,"languages":languages,"requiresGpu":false,"paperQualityProfile":profiles.first(),"paperQualityProfiles":profiles,"paperQualityRequirements":quality_requirements,"researchVerificationRequired":research_required,"convergenceThresholds":{"minimumRoundIndex":1},"sourceVenue":optional(&input.paper_task["venueTarget"]),"venueTarget":venue,"datasetRoot":null,"benchmarkId":null,"benchmarkSelector":null,"applyManuscript":false,"datasetMounts":[],"metricSchema":{"version":1,"minimumMetricCount":1,"absoluteTolerance":1e-9,"relativeTolerance":1e-6,"metrics":[]},"budgets":{"maxWallTimeMs":21_600_000,"maxAgentCalls":planned_calls.max(30),"maxCpuJobs":32,"maxGpuJobs":8,"maxTokenCount":500_000,"maxCostUsd":100,"maxMemoryMiB":8192},"commandBinding":binding,"nodes":nodes,"externalSubmissionEnabled":false,"releaseHandoffRequired":mode=="reviewed-submit"});
    if research_required || formal {
        payload["researchVerificationInput"] = research_input::build(input, &profiles)?;
    }
    let h = hash("PaperCampaignPlan", &payload)?;
    payload["campaignPlanHash"] = json!(h);
    Ok(payload)
}
