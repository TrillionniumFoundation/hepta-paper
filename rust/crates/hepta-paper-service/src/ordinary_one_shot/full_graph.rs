//! The actual canonical full-campaign graph. A plan is not execution authority.
use super::{contract::contract, json::*};
use hepta_legacy_compatibility::ProductionJsonValue as Json;
use std::sync::atomic::AtomicBool;

#[derive(Clone, Debug)]
pub struct FixedOneShotFullGraphV1 {
    pub nodes: Vec<Json>,
    pub planned_agent_calls: u64,
}
fn id(value: &Json) -> Result<String, String> {
    text(field(value, "nodeId")).ok_or("native_one_shot_full_graph_invalid".into())
}
#[derive(Clone, Copy, Default)]
struct Flags<'a> {
    round: u64,
    priority: u64,
    role: Option<&'a str>,
    language: Option<&'a str>,
    node_id_kind: Option<&'a str>,
    source_closure: bool,
    mutation_forbid: bool,
}
struct Builder<'a> {
    campaign: &'a str,
    intent: &'a Json,
}
impl Builder<'_> {
    fn node(&self, kind: &str, dependencies: Vec<String>, flags: Flags<'_>) -> Json {
        let mut value = object([
            (
                "nodeId",
                string(&format!(
                    "{}:{}:{}",
                    self.campaign,
                    flags.round,
                    flags.node_id_kind.unwrap_or(kind)
                )),
            ),
            ("kind", string(kind)),
            ("roundIndex", Json::Number(flags.round as f64)),
            (
                "dependencies",
                Json::Array(dependencies.iter().map(|v| string(v)).collect()),
            ),
            ("priority", Json::Number(flags.priority as f64)),
            ("maxAttempts", Json::Number(3.0)),
            ("role", flags.role.map_or(Json::Null, string)),
            ("language", flags.language.map_or(Json::Null, string)),
            ("requiresGpu", Json::Bool(false)),
        ]);
        if let Json::Object(values) = &mut value {
            if flags.source_closure {
                values.push((
                    "sourceClosureTerminal".encode_utf16().collect(),
                    Json::Bool(true),
                ));
            }
            if flags.mutation_forbid {
                values.push((
                    "sourceMutationPolicy".encode_utf16().collect(),
                    string("forbid"),
                ));
            }
            values.push((
                "executionIntent".encode_utf16().collect(),
                self.intent.clone(),
            ));
        }
        value
    }
    fn formal(
        &self,
        dependencies: Vec<String>,
        round: u64,
        priority: u64,
        prefix: &str,
        sealed: bool,
    ) -> Result<(Json, Json), String> {
        let theorem_kind = format!("{prefix}theorem-spec");
        let verify_kind = format!("{prefix}formal-verify");
        let theorem = self.node(
            "theorem-spec",
            dependencies,
            Flags {
                round,
                priority,
                role: Some("theorem-spec-author"),
                language: Some("lean"),
                node_id_kind: Some(&theorem_kind),
                source_closure: sealed,
                ..Flags::default()
            },
        );
        let verify = self.node(
            "formal-verify",
            vec![id(&theorem)?],
            Flags {
                round,
                priority: priority + 2,
                role: Some("formal-candidate"),
                language: Some("lean"),
                node_id_kind: Some(&verify_kind),
                source_closure: sealed,
                ..Flags::default()
            },
        );
        Ok((theorem, verify))
    }
}
/// Only the fixed single Python empirical execution profile is in this domain.
/// Formal/research flags come from the caller's actual prepared source profile;
/// neither this immutable graph nor these flags grant qualification or dispatch.
pub fn build_fixed_one_shot_full_graph_v1(
    execution_intent: &Json,
    formal_requested: bool,
    research_verification_required: bool,
    cancelled: &AtomicBool,
) -> Result<FixedOneShotFullGraphV1, String> {
    canonical_bytes(execution_intent, 64 * 1024, cancelled)?;
    let c = contract()?;
    let campaign = c["currentTarget"]["campaignId"]
        .as_str()
        .ok_or("one_shot_status_contract_invalid")?;
    if c["currentTarget"]["revisionRounds"] != 3
        || c["currentTarget"]["refereeCount"] != 3
        || c["currentTarget"]["budgets"]["maxAgentCalls"] != 201
    {
        return Err("native_one_shot_full_graph_invalid".into());
    }
    let b = Builder {
        campaign,
        intent: execution_intent,
    };
    let mut nodes = Vec::new();
    let research = b.node(
        "research-plan",
        vec![],
        Flags {
            priority: 10,
            ..Flags::default()
        },
    );
    let writer = b.node(
        "writer",
        vec![id(&research)?],
        Flags {
            priority: 20,
            role: Some("writer"),
            ..Flags::default()
        },
    );
    let coder = b.node(
        "coder",
        vec![id(&writer)?],
        Flags {
            priority: 20,
            role: Some("coder-python"),
            language: Some("python"),
            ..Flags::default()
        },
    );
    let empirical = b.node(
        "empirical",
        vec![id(&coder)?],
        Flags {
            priority: 30,
            language: Some("python"),
            ..Flags::default()
        },
    );
    let reproduce = b.node(
        "empirical-reproduce",
        vec![id(&empirical)?],
        Flags {
            priority: 35,
            language: Some("python"),
            mutation_forbid: true,
            ..Flags::default()
        },
    );
    let manuscript_dependencies = vec![id(&writer)?, id(&reproduce)?];
    let render_formal = if formal_requested {
        Some(b.formal(
            manuscript_dependencies.clone(),
            0,
            38,
            "render-authority-",
            false,
        )?)
    } else {
        None
    };
    let mut integrate_dependencies = manuscript_dependencies;
    if let Some((_, verify)) = &render_formal {
        integrate_dependencies.push(id(verify)?);
    }
    let integrate = b.node(
        "manuscript-integrate",
        integrate_dependencies,
        Flags {
            priority: 40,
            role: Some("writer"),
            ..Flags::default()
        },
    );
    let formal = if formal_requested {
        Some(b.formal(vec![id(&integrate)?], 0, 42, "", false)?)
    } else {
        None
    };
    let compile_dependencies = vec![id(formal.as_ref().map_or(&integrate, |(_, v)| v))?];
    let compile = b.node(
        "compile",
        compile_dependencies,
        Flags {
            priority: 50,
            language: Some("latex"),
            ..Flags::default()
        },
    );
    let initial_replay = id(&reproduce)?;
    nodes.extend([research, writer, coder, empirical, reproduce]);
    if let Some((theorem, verify)) = &render_formal {
        nodes.extend([theorem.clone(), verify.clone()]);
    }
    nodes.push(integrate);
    let mut formal_ids = Vec::new();
    let mut latest_formal = None;
    if let Some((theorem, verify)) = formal {
        latest_formal = Some(id(&verify)?);
        formal_ids.push(id(&verify)?);
        nodes.extend([theorem, verify]);
    }
    let mut previous = id(&compile)?;
    nodes.push(compile);
    let mut empirical_replays = vec![initial_replay];
    let mut convergence_ids = Vec::new();
    for round in 1..=3 {
        let referees = (1..=3)
            .map(|i| {
                let kind = format!("referee-{i}");
                b.node(
                    &kind,
                    vec![previous.clone()],
                    Flags {
                        round,
                        priority: 60,
                        role: Some(&kind),
                        ..Flags::default()
                    },
                )
            })
            .collect::<Vec<_>>();
        let mut revise_dependencies = referees.iter().map(id).collect::<Result<Vec<_>, _>>()?;
        if let Some(verify) = &latest_formal {
            revise_dependencies.push(verify.clone());
        }
        let revise = b.node(
            "revise",
            revise_dependencies,
            Flags {
                round,
                priority: 70,
                role: Some("reviser"),
                ..Flags::default()
            },
        );
        let formal = if formal_requested {
            Some(b.formal(vec![id(&revise)?], round, 74, "", false)?)
        } else {
            None
        };
        let revision = id(formal.as_ref().map_or(&revise, |(_, v)| v))?;
        let code = b.node(
            "revalidate-code",
            vec![revision.clone()],
            Flags {
                round,
                priority: 80,
                language: Some("python"),
                mutation_forbid: true,
                ..Flags::default()
            },
        );
        let empirical = b.node(
            "revalidate-empirical",
            vec![id(&code)?],
            Flags {
                round,
                priority: 81,
                language: Some("python"),
                mutation_forbid: true,
                ..Flags::default()
            },
        );
        let reproduce = b.node(
            "revalidate-empirical-reproduce",
            vec![id(&empirical)?],
            Flags {
                round,
                priority: 82,
                language: Some("python"),
                mutation_forbid: true,
                ..Flags::default()
            },
        );
        let compile = b.node(
            "revalidate-compile",
            vec![revision.clone()],
            Flags {
                round,
                priority: 80,
                language: Some("latex"),
                ..Flags::default()
            },
        );
        let citations = b.node(
            "revalidate-citations",
            vec![revision.clone()],
            Flags {
                round,
                priority: 80,
                language: Some("latex"),
                ..Flags::default()
            },
        );
        let artifacts = b.node(
            "revalidate-artifacts",
            vec![revision],
            Flags {
                round,
                priority: 80,
                ..Flags::default()
            },
        );
        let dependencies = [
            &code, &empirical, &reproduce, &compile, &citations, &artifacts,
        ]
        .into_iter()
        .map(id)
        .collect::<Result<Vec<_>, _>>()?;
        let revision_referees = (1..=3)
            .map(|i| {
                let kind = format!("revision-referee-{i}");
                b.node(
                    &kind,
                    dependencies.clone(),
                    Flags {
                        round,
                        priority: 85,
                        role: Some(&kind),
                        ..Flags::default()
                    },
                )
            })
            .collect::<Vec<_>>();
        let convergence = b.node(
            "convergence",
            revision_referees
                .iter()
                .map(id)
                .collect::<Result<Vec<_>, _>>()?,
            Flags {
                round,
                priority: 90,
                ..Flags::default()
            },
        );
        previous = id(&convergence)?;
        convergence_ids.push(previous.clone());
        empirical_replays.push(id(&reproduce)?);
        nodes.extend(referees);
        nodes.push(revise);
        if let Some((theorem, verify)) = formal {
            latest_formal = Some(id(&verify)?);
            formal_ids.push(id(&verify)?);
            nodes.extend([theorem, verify]);
        }
        nodes.extend([code, empirical, reproduce, compile, citations, artifacts]);
        nodes.extend(revision_referees);
        nodes.push(convergence);
    }
    let closure_formal = if formal_requested {
        Some(b.formal(vec![previous.clone()], 0, 94, "source-closure-", true)?)
    } else {
        None
    };
    let root = closure_formal
        .as_ref()
        .map(|(_, v)| id(v))
        .transpose()?
        .unwrap_or(previous);
    let seal = b.node(
        "revalidate-empirical-source-seal",
        vec![root],
        Flags {
            priority: 96,
            language: Some("python"),
            source_closure: true,
            mutation_forbid: true,
            ..Flags::default()
        },
    );
    let seal_reproduce = b.node(
        "revalidate-empirical-reproduce-source-seal",
        vec![id(&seal)?],
        Flags {
            priority: 97,
            language: Some("python"),
            source_closure: true,
            mutation_forbid: true,
            ..Flags::default()
        },
    );
    let mut compile_dependencies = convergence_ids;
    if let Some((_, verify)) = &closure_formal {
        compile_dependencies.push(id(verify)?);
    }
    compile_dependencies.push(id(&seal_reproduce)?);
    let final_compile = b.node(
        "final-compile",
        compile_dependencies,
        Flags {
            round: 3,
            priority: 100,
            language: Some("latex"),
            source_closure: true,
            mutation_forbid: true,
            ..Flags::default()
        },
    );
    let mut release_formal_ids = Vec::new();
    if let Some((_, verify)) = &render_formal {
        release_formal_ids.push(id(verify)?);
    }
    release_formal_ids.extend(formal_ids);
    if let Some((_, verify)) = &closure_formal {
        release_formal_ids.push(id(verify)?);
    }
    empirical_replays.push(id(&seal_reproduce)?);
    let research_verify = if research_verification_required {
        let mut dependencies = vec![id(&final_compile)?];
        dependencies.extend(release_formal_ids);
        dependencies.extend(empirical_replays);
        Some(b.node(
            "research-verify",
            dependencies,
            Flags {
                round: 4,
                priority: 105,
                ..Flags::default()
            },
        ))
    } else {
        None
    };
    let mut package_dependencies = vec![id(&final_compile)?];
    if let Some(verify) = &research_verify {
        package_dependencies.push(id(verify)?);
    }
    let package = b.node(
        "package",
        package_dependencies,
        Flags {
            round: 4,
            priority: 110,
            ..Flags::default()
        },
    );
    if let Some((theorem, verify)) = closure_formal {
        nodes.extend([theorem, verify]);
    }
    nodes.extend([seal, seal_reproduce, final_compile]);
    if let Some(verify) = research_verify {
        nodes.push(verify);
    }
    nodes.push(package);
    let mut calls = 0u64;
    for node in &nodes {
        let kind = text(field(node, "kind")).ok_or("native_one_shot_full_graph_invalid")?;
        let agent = matches!(
            kind.as_str(),
            "research-plan" | "writer" | "theorem-spec" | "manuscript-integrate" | "revise"
        ) || kind == "coder"
            || kind.starts_with("coder-")
            || kind.starts_with("referee-")
            || kind.starts_with("revision-referee-");
        calls = calls
            .checked_add(if agent { 3 } else { 0 })
            .and_then(|v| v.checked_add(if kind == "formal-verify" { 18 } else { 0 }))
            .ok_or("native_one_shot_full_graph_invalid")?;
    }
    if calls > 201 || nodes.len() > 128 {
        return Err("native_one_shot_full_graph_budget_exceeded".into());
    }
    canonical_bytes(&Json::Array(nodes.clone()), 1024 * 1024, cancelled)?;
    Ok(FixedOneShotFullGraphV1 {
        nodes,
        planned_agent_calls: calls,
    })
}

#[cfg(test)]
mod tests {
    use super::super::preflight::tests::{node, workspace};
    use super::*;
    use hepta_legacy_compatibility::{
        ProductionJsonEncodingLimitsV1, parse_production_json_v1,
        production_json_stringify_with_limits_v1,
    };
    #[test]
    fn actual_original_complete_graph_and_call_budget_match_all_fixed_profile_variants() {
        let cancelled = AtomicBool::new(false);
        let intent=parse_production_json_v1(br#"{"version":2,"kind":"PaperCampaignModeIntent","requestedMode":"full-campaign","effectiveMode":"full-campaign","literal":"\ud800:\ud83d\ude00","testNumber":1e-7}"#).unwrap();
        for (formal, research) in [(true, true), (true, false), (false, true), (false, false)] {
            let c = contract().unwrap();
            let payload = object([
                ("source", string(workspace().to_str().unwrap())),
                (
                    "campaignId",
                    string(c["currentTarget"]["campaignId"].as_str().unwrap()),
                ),
                ("executionIntent", intent.clone()),
                ("formalRequested", Json::Bool(formal)),
                ("researchVerificationRequired", Json::Bool(research)),
            ]);
            let code = r#"import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';const input=JSON.parse(fs.readFileSync(0,'utf8'));const {buildCampaignModeNodes,plannedAgentCallUpperBound}=await import(pathToFileURL(path.join(input.source,'paper-domain/automation/campaign-mode-graph.mjs')));const nodes=buildCampaignModeNodes({campaignId:input.campaignId,mode:'full-campaign',rounds:3,reviewers:3,executionProfiles:[{label:'python',language:'python',requiresGpu:false}],executionIntent:input.executionIntent,empiricalRequested:true,applyManuscript:true,formalRequested:input.formalRequested,researchVerificationRequired:input.researchVerificationRequired});process.stdout.write(JSON.stringify({nodes,plannedAgentCalls:plannedAgentCallUpperBound(nodes)}));"#;
            let input = production_json_stringify_with_limits_v1(
                &payload,
                ProductionJsonEncodingLimitsV1 {
                    maximum_bytes: 64 * 1024,
                    maximum_values: 64 * 1024,
                    maximum_utf16_units: 64 * 1024,
                },
                &cancelled,
            )
            .unwrap();
            let (exit, bytes, stderr) = node(
                vec!["--input-type=module".into(), "--eval".into(), code.into()],
                Some(input),
            );
            assert_eq!(exit, 0, "{}", String::from_utf8_lossy(&stderr));
            let expected = parse_production_json_v1(&bytes).unwrap();
            let actual =
                build_fixed_one_shot_full_graph_v1(&intent, formal, research, &cancelled).unwrap();
            let limits = ProductionJsonEncodingLimitsV1 {
                maximum_bytes: 1024 * 1024,
                maximum_values: 1024 * 1024,
                maximum_utf16_units: 1024 * 1024,
            };
            let actual_wire = production_json_stringify_with_limits_v1(
                &Json::Array(actual.nodes),
                limits,
                &cancelled,
            )
            .unwrap();
            let expected_wire = production_json_stringify_with_limits_v1(
                field(&expected, "nodes"),
                limits,
                &cancelled,
            )
            .unwrap();
            assert_eq!(actual_wire, expected_wire);
            assert!(number(
                field(&expected, "plannedAgentCalls"),
                actual.planned_agent_calls as f64
            ));
            assert_eq!(actual.planned_agent_calls, if formal { 201 } else { 75 });
        }
    }
}
