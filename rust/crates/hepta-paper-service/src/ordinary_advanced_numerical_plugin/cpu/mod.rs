//! CPU-only normal run through the existing signed configuration/source/process owners.
mod association;
mod collector;
mod limits;
mod process;
mod receipt;
mod recovery;
mod workspace;
use super::*;
use crate::state_recoverability::publication::{Directory, LocalReportDirectoryV1};
use sha2::{Digest, Sha256};
pub(super) struct RunWitness<'a> {
    workspace: Option<workspace::CpuWorkspace<'a>>,
    output_observation: StatusInputs<'a>,
    output: Directory,
    execution_facts: recovery::ExecutionFacts,
    association_facts: Option<Value>,
    held_association: Option<association::HeldAssociation>,
}
impl RunWitness<'_> {
    pub(super) fn error_context(&self, error: String) -> String {
        let error = self.execution_facts.context(error);
        self.association_facts
            .as_ref()
            .map_or(error.clone(), |facts| association::context(error, facts))
    }
    pub(super) fn assert_current(&self) -> Result<(), String> {
        if let Some(workspace) = &self.workspace {
            workspace.assert_current()?;
        }
        if let Some(association) = &self.held_association {
            association.assert_current()?;
        }
        self.output_observation.assert_current()?;
        self.output.assert_current().map_err(|e| e.to_string())
    }
}
fn blocked(
    prepared: &configuration::Prepared,
    request: Option<&Json>,
    blockers: Vec<Json>,
    worker: Option<Json>,
) -> Json {
    let mut report = object([
        ("version", Json::Number(1.0)),
        ("kind", text("AdvancedNumericalPluginExecutionReceipt")),
        (
            "status",
            text("advanced_numerical_plugin_execution_blocked"),
        ),
        ("productionQualified", Json::Bool(false)),
        ("blockers", Json::Array(blockers)),
        ("pluginId", field(&prepared.report, "pluginId").clone()),
        (
            "analysisFamily",
            field(&prepared.report, "analysisFamily").clone(),
        ),
        (
            "qualificationStatementHash",
            field(
                field(&prepared.report, "capabilities"),
                "qualificationStatementHash",
            )
            .clone(),
        ),
        (
            "qualificationEvidenceBundleHash",
            field(
                field(&prepared.report, "capabilities"),
                "qualificationEvidenceBundleHash",
            )
            .clone(),
        ),
    ]);
    if let Json::Object(fields) = &mut report {
        // Original blockedExecution overwrites the existing productionQualified field
        // without changing its first position.
        if let Some((_, v)) = fields
            .iter_mut()
            .find(|(k, _)| k.iter().copied().eq("productionQualified".encode_utf16()))
        {
            *v = field(&prepared.report, "productionQualified").clone();
        }
        if let Some(r) = request {
            fields.push((
                "requestHash".encode_utf16().collect(),
                field(r, "advancedNumericalPluginRequestHash").clone(),
            ));
        }
        if let Some(w) = worker {
            fields.push(("workerReceipt".encode_utf16().collect(), w));
        }
    }
    report
}
fn checked_path<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .ok_or_else(|| "advanced_numerical_plugin_cpu_run_input_invalid".into())
}
fn runtime_identity(
    workspace: &workspace::CpuWorkspace<'_>,
    descriptor: &Value,
    c: &AtomicBool,
    d: Instant,
) -> Result<String, String> {
    let name = checked_path(&descriptor["runtime"], "executable")?;
    let payload = object([
        ("version", Json::Number(1.0)),
        ("kind", text("HostRuntimeIdentity")),
        ("runtimeType", text("host")),
        ("executionClass", text("host")),
        ("runnerId", text("bubblewrap-kernel-isolation-worker-v4")),
        ("backend", text("bubblewrap")),
        ("executable", text(name)),
        (
            "executableInvocationPath",
            text(&workspace.runtime_path.to_string_lossy()),
        ),
        ("executableInvocationName", text(name)),
        (
            "resolvedExecutable",
            text(&workspace.runtime_path.to_string_lossy()),
        ),
        ("executableHash", text(&workspace.executable_hash)),
        ("available", Json::Bool(true)),
        ("allowlisted", Json::Bool(true)),
        ("cacheable", Json::Bool(false)),
    ]);
    check(c, d)?;
    let h = hash("WorkerExecutionRuntimeIdentity", &payload, c)?;
    check(c, d)?;
    Ok(h)
}
pub(super) fn run<'a>(
    a: &Arguments,
    prepared: &configuration::Prepared,
    source: &mut StatusInputs<'a>,
    root: &Path,
    c: &'a AtomicBool,
    d: Instant,
) -> Result<(Json, i32, Option<RunWitness<'a>>), String> {
    let mut execution_facts: Option<recovery::ExecutionFacts> = None;
    let mut association_facts: Option<Value> = None;
    let result: Result<_, String> = (|| {
        source.require_control(c, d)?;
        let descriptor = &prepared.descriptor;
        if descriptor["version"] != 1
            || descriptor["runtime"]["language"] != "python"
            || descriptor["runtime"]["requiresGpu"] == true
        {
            return Err("advanced_numerical_plugin_cpu_python_run_domain_v1_unaccepted".into());
        }
        let limits = limits::CpuExecutionLimits::from_descriptor(descriptor)?;
        limits.require_time_budget(c, d)?;
        let path =
            configuration::resolve(root, a.values.get("request").map_or("", String::as_str))?;
        let input = configuration::read_cpu_request_v1(source, &path, c, d).map_err(|e| e.code)?;
        if !matches!(input, Json::Object(_)) {
            return Err("advanced_numerical_plugin_document_json_invalid".into());
        }
        let target = configuration::resolve(
            root,
            a.values.get("output-directory").map_or("", String::as_str),
        )?;
        if !target.starts_with(&prepared.output_root) {
            return Ok((
                blocked(
                    prepared,
                    None,
                    vec![text("advanced_numerical_plugin_output_scope_invalid")],
                    None,
                ),
                1,
                None,
            ));
        }
        let request = execution_contract::request_v1(&prepared.descriptor_raw, &input, c, d)?;
        // This version preserves unknown prior outputs and refuses any path alias.
        let output = Directory::open_or_create(&target, true).map_err(|e| e.to_string())?;
        let target_result = target.join("result.json");
        let mut prior = StatusInputs::new(c, d)?;
        if let Some(metadata) = prior.probe(&target_result)? {
            if metadata.directory
                || metadata.link_count != 1
                || metadata.size > limits.maximum_output_bytes
            {
                return Ok((
                    blocked(
                        prepared,
                        Some(&request),
                        vec![text(
                            "advanced_numerical_plugin_result_preexists_unsafe_or_out_of_domain",
                        )],
                        None,
                    ),
                    1,
                    None,
                ));
            }
            let raw = prior.document(&target_result, limits.maximum_output_bytes)?;
            let digest = format!("sha256:{:x}", Sha256::digest(&raw));
            execution_facts = Some(recovery::ExecutionFacts::preexisting(
                &target_result,
                &digest,
                raw.len() as u64,
            ));
            let previous = parse_production_json_v1(&raw).unwrap_or(Json::Null);
            let valid = execution_contract::result_valid_v1(
                &previous,
                &prepared.descriptor_raw,
                &request,
                c,
                d,
            )?;
            let mut report = blocked(
                prepared,
                Some(&request),
                vec![text("advanced_numerical_plugin_result_preexists")],
                None,
            );
            if let Json::Object(fields) = &mut report {
                fields.push((
                    "previousResultObservation".encode_utf16().collect(),
                    object([
                        ("path", text(&target_result.to_string_lossy())),
                        ("sha256", text(&digest)),
                        ("bytes", Json::Number(raw.len() as f64)),
                        ("resultContractMatchesCurrentRequest", Json::Bool(valid)),
                        ("executionAuthority", Json::Bool(false)),
                        ("status", text("retained_preexisting_result_no_overwrite")),
                    ]),
                ));
            }
            prior.assert_current()?;
            output.assert_current().map_err(|e| e.to_string())?;
            check(c, d)?;
            return Ok((
                report,
                1,
                Some(RunWitness {
                    workspace: None,
                    output_observation: prior,
                    output,
                    association_facts: association_facts.clone(),
                    held_association: None,
                    execution_facts: execution_facts
                        .as_ref()
                        .ok_or("advanced_numerical_plugin_execution_observation_missing")?
                        .clone(),
                }),
            ));
        }
        if let Some(recovered) =
            association::recover(prepared, &request, &output, &mut prior, &limits, c, d)?
        {
            association_facts = Some(recovered.facts);
            let mut report = blocked(
                prepared,
                Some(&request),
                vec![text(
                    "advanced_numerical_plugin_prior_attempt_outcome_unknown",
                )],
                None,
            );
            if let Json::Object(fields) = &mut report {
                fields.push((
                    "executionAssociationObservation".encode_utf16().collect(),
                    recovered.observation,
                ));
            }
            let facts = recovery::ExecutionFacts::unknown_prepared();
            execution_facts = Some(facts.clone());
            return Ok((
                report,
                1,
                Some(RunWitness {
                    workspace: None,
                    output_observation: prior,
                    output,
                    execution_facts: facts,
                    association_facts: association_facts.clone(),
                    held_association: Some(recovered.held),
                }),
            ));
        }
        prior.assert_current()?;
        drop(prior);
        let allowed = LocalReportDirectoryV1::open_or_create(&prepared.output_root, false)
            .map_err(|e| e.to_string())?;
        let availability = field(&prepared.report, "sandboxAvailability");
        if !matches!(field(availability, "available"), Json::Bool(true)) {
            return Err(
                "advanced_numerical_plugin_cpu_sandbox_unavailable_domain_v1_unaccepted".into(),
            );
        }
        let workspace = workspace::CpuWorkspace::prepare(
            &prepared.plugin_root,
            allowed,
            descriptor,
            source,
            c,
            d,
        )?;
        let identity = runtime_identity(&workspace, descriptor, c, d)?;
        // Compute BOM from real, held current host observations before execution.
        let bom = collector::collect(&workspace, descriptor, &identity, &request, source, &limits)?;
        let bom_hash = checked_path(&value(&bom, c)?, "environmentBomHash")?.to_owned();
        let mut output_observation = StatusInputs::new(c, d)?;
        association_facts = Some(association::persist(
            prepared,
            &request,
            &workspace,
            &output,
            &mut output_observation,
            c,
            d,
        )?);
        let executed = process::execute(&workspace, source, descriptor, &request, &limits)?;
        execution_facts = Some(recovery::ExecutionFacts::observed(
            &executed.actual,
            &executed.invocation_id,
            &workspace.output.path.join("result.json"),
            &limits,
        ));
        let mut artifacts = Vec::new();
        let mut artifact_blockers = Vec::new();
        let private_result = workspace.output.path.join("result.json");
        let mut result_document = Json::Null;
        let signal_name = process::receipt_signal_name(executed.actual.process.signal)?;
        if executed.actual.process.exit_code == Some(0) {
            if let Some(m) = output_observation.probe(&private_result)? {
                let cap = limits.maximum_output_bytes;
                if m.directory || m.link_count != 1 || m.size > cap {
                    artifact_blockers.push(
                        "worker_output_path_unsafe:result.json:materialization_failed".to_owned(),
                    );
                } else {
                    let raw = output_observation.document(&private_result, cap)?;
                    check(c, d)?;
                    let digest = format!("sha256:{:x}", Sha256::digest(&raw));
                    let facts = execution_facts
                        .as_mut()
                        .ok_or("advanced_numerical_plugin_execution_observation_missing")?;
                    facts.publication_attempted(&target_result, &digest, raw.len() as u64);
                    output
                        .write_new("result.json", &raw)
                        .map_err(|e| e.to_string())?;
                    facts.publication_saved();
                    let published = output_observation.archive(&target_result, cap)?;
                    if published != (digest.clone(), raw.len() as u64) {
                        return Err("advanced_numerical_plugin_published_result_changed".into());
                    }
                    artifacts.push((digest, raw.len() as u64));
                    result_document = parse_production_json_v1(&raw).unwrap_or(Json::Null);
                }
            } else {
                artifact_blockers
                    .push("worker_declared_output_missing_from_separate_root:result.json".into());
            }
        }
        workspace.assert_current()?;
        source.assert_current()?;
        output_observation.assert_current()?;
        output.assert_current().map_err(|e| e.to_string())?;
        check(c, d)?;
        let stdout = std::str::from_utf8(&executed.actual.stdout)
            .map_err(|_| "advanced_numerical_plugin_execution_output_domain_unaccepted")?;
        let stderr = std::str::from_utf8(&executed.actual.process.stderr_tail)
            .map_err(|_| "advanced_numerical_plugin_execution_output_domain_unaccepted")?;
        let snapshot = workspace.source_snapshot();
        let work_snapshot = workspace.work_snapshot();
        let invocation = value(&executed.invocation, c)?;
        let args: Vec<_> = invocation["arguments"]
            .as_array()
            .ok_or("advanced_numerical_plugin_invocation_invalid")?
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or("advanced_numerical_plugin_invocation_invalid")
            })
            .collect::<Result<_, _>>()?;
        let artifact_views: Vec<_> = artifacts
            .iter()
            .map(|(h, n)| receipt::Artifact {
                path: "result.json",
                sha256: h,
                bytes: *n,
            })
            .collect();
        let declared = vec!["result.json".to_owned()];
        let availability = value(field(&prepared.report, "sandboxAvailability"), c)?;
        let setup_verified = executed.actual.process.exit_code == Some(0);
        let process_limit_available = availability["processLimit"]["available"] == true;
        let process_limit_mechanism = availability["processLimit"]["mechanism"]
            .as_str()
            .ok_or("advanced_numerical_plugin_process_limit_unavailable")?;
        let dataset_hash = &executed
            .permitted_environment
            .first()
            .ok_or("advanced_numerical_plugin_execution_environment_invalid")?
            .1;
        let receipt = receipt::cpu_worker_receipt_v1(
            &receipt::CpuObservations {
                invocation: receipt::Invocation {
                    process_invocation_id: &executed.invocation_id,
                    executable_target: workspace
                        .runtime_path
                        .to_str()
                        .ok_or("advanced_numerical_plugin_path_domain_unaccepted")?,
                    arguments: &args,
                    working_directory: "/work",
                    source_merkle_hash: checked_path(snapshot, "merkleHash")?,
                    source_manifest_hash: checked_path(snapshot, "manifestHash")?,
                    standard_input: None,
                },
                result: receipt::ProcessResult {
                    launcher_pid: Some(f64::from(executed.actual.process.process_id)),
                    exit_code: executed.actual.process.exit_code,
                    signal: signal_name.as_deref(),
                    stdout,
                    stderr,
                    error_message: None,
                    errored: false,
                    aborted: false,
                    timed_out: false,
                },
                source: receipt::SourceSnapshots {
                    merkle_before: checked_path(snapshot, "merkleHash")?,
                    merkle_after: Some(checked_path(snapshot, "merkleHash")?),
                    manifest_before: checked_path(snapshot, "manifestHash")?,
                    manifest_after: Some(checked_path(snapshot, "manifestHash")?),
                    work_merkle: checked_path(work_snapshot, "merkleHash")?,
                    work_manifest: checked_path(work_snapshot, "manifestHash")?,
                    expected_merkle: descriptor["sourceIdentity"]["merkleHash"].as_str(),
                    expected_manifest: descriptor["sourceIdentity"]["workspaceManifestHash"]
                        .as_str(),
                    after_blockers: &[],
                },
                runtime: receipt::Runtime {
                    identity_type: Some("host"),
                    identity_hash: Some(&identity),
                    executable_hash: Some(&workspace.executable_hash),
                    executable_hash_after: Some(&workspace.executable_hash),
                    invocation_name: descriptor["runtime"]["executable"].as_str(),
                    invocation_path: workspace.runtime_path.to_str(),
                    overlay_target: workspace.runtime_path.to_str(),
                },
                isolation: receipt::Isolation {
                    network_namespace: setup_verified,
                    filesystem_namespace: setup_verified,
                    source_readonly_mount: setup_verified,
                    ephemeral_work_root: true,
                    immutable_work_root: setup_verified,
                    workspace_execution_snapshot: true,
                    readonly_runtime: setup_verified,
                    memory_limit: setup_verified,
                    cpu_limit: setup_verified,
                    process_limit_available,
                    process_limit_mechanism,
                },
                limits: receipt::Limits {
                    timeout_ms: executed.timeout_ms,
                    memory_bytes: limits.memory_bytes,
                    cpu_seconds: limits.cpu_seconds,
                    maximum_pids: limits.maximum_pids,
                    maximum_output_bytes: limits.maximum_output_bytes,
                    maximum_captured_bytes: executed.maximum_captured,
                },
                declared_outputs: &declared,
                separate_output_root: true,
                artifacts: &artifact_views,
                artifact_blockers: &artifact_blockers,
                environment_binding_hash: &executed.environment_binding_hash,
                environment_bom: &bom,
                environment_bom_hash: &bom_hash,
                permitted_environment: &executed.permitted_environment,
                dataset_authorization_set_hash: dataset_hash,
                production_evidence_eligible: true,
            },
            c,
            d,
        )?;
        if !environment_bom::against_worker_receipt_v2(&bom, &receipt, c, d)? {
            return Err("advanced_numerical_plugin_current_environment_binding_invalid".into());
        }
        if !matches!(field(&receipt, "ok"), Json::Bool(true)) {
            let mut blockers = vec![text("advanced_numerical_plugin_worker_execution_blocked")];
            if let Json::Array(b) = field(&receipt, "blockers") {
                blockers.extend(b.iter().cloned());
            }
            let recovered = association::recover(
                prepared,
                &request,
                &output,
                &mut output_observation,
                &limits,
                c,
                d,
            )?
            .ok_or("advanced_numerical_plugin_execution_association_missing")?;
            let mut report = blocked(prepared, Some(&request), blockers, Some(receipt));
            if let Json::Object(fields) = &mut report {
                fields.push((
                    "executionAssociationObservation".encode_utf16().collect(),
                    recovered.observation,
                ));
            }
            recovered.held.assert_current()?;
            return Ok((
                report,
                1,
                Some(RunWitness {
                    workspace: Some(workspace),
                    output_observation,
                    output,
                    association_facts: association_facts.clone(),
                    held_association: None,
                    execution_facts: execution_facts
                        .as_ref()
                        .ok_or("advanced_numerical_plugin_execution_observation_missing")?
                        .clone(),
                }),
            ));
        }
        if !execution_contract::result_valid_v1(
            &result_document,
            &prepared.descriptor_raw,
            &request,
            c,
            d,
        )? {
            return Err(
                "advanced_numerical_plugin_result_invalid_receipt_domain_v1_unaccepted".into(),
            );
        }
        let caps = field(&prepared.report, "capabilities");
        let qualified = field(&prepared.report, "productionQualified").clone();
        let status = if matches!(qualified, Json::Bool(true)) {
            "advanced_numerical_plugin_execution_completed_qualified"
        } else {
            "advanced_numerical_plugin_execution_completed_unqualified"
        };
        let mut report = object([
            ("version", Json::Number(1.0)),
            ("kind", text("AdvancedNumericalPluginExecutionReceipt")),
            ("status", text(status)),
            ("pluginId", field(&prepared.report, "pluginId").clone()),
            (
                "analysisFamily",
                field(&prepared.report, "analysisFamily").clone(),
            ),
            (
                "pluginDescriptorHash",
                field(&prepared.report, "descriptorHash").clone(),
            ),
            (
                "signedBundleHash",
                field(&prepared.report, "signedBundleHash").clone(),
            ),
            (
                "requestHash",
                field(&request, "advancedNumericalPluginRequestHash").clone(),
            ),
            (
                "resultHash",
                field(&result_document, "advancedNumericalPluginResultHash").clone(),
            ),
            ("workerReceiptHash", field(&receipt, "receiptHash").clone()),
            ("workerReceipt", receipt),
            ("result", result_document),
            ("productionQualified", qualified),
            (
                "qualificationStatementHash",
                field(caps, "qualificationStatementHash").clone(),
            ),
            (
                "qualificationEvidenceBundleHash",
                field(caps, "qualificationEvidenceBundleHash").clone(),
            ),
            (
                "qualificationInspectionHash",
                field(caps, "qualificationInspectionHash").clone(),
            ),
            (
                "qualificationRequirement",
                field(caps, "qualificationRequirement").clone(),
            ),
            ("blockers", Json::Array(vec![])),
        ]);
        let digest = hash("AdvancedNumericalPluginExecutionReceipt", &report, c)?;
        if let Json::Object(fields) = &mut report {
            fields.push((
                "advancedNumericalPluginExecutionReceiptHash"
                    .encode_utf16()
                    .collect(),
                text(&digest),
            ));
        }
        workspace.assert_current()?;
        source.assert_current()?;
        output_observation.assert_current()?;
        output.assert_current().map_err(|e| e.to_string())?;
        check(c, d)?;
        Ok((
            report,
            0,
            Some(RunWitness {
                workspace: Some(workspace),
                output_observation,
                output,
                association_facts: association_facts.clone(),
                held_association: None,
                execution_facts: execution_facts
                    .as_ref()
                    .ok_or("advanced_numerical_plugin_execution_observation_missing")?
                    .clone(),
            }),
        ))
    })();
    result.map_err(|error| {
        let error = execution_facts
            .as_ref()
            .map_or(error.clone(), |facts| facts.context(error));
        association_facts
            .as_ref()
            .map_or(error.clone(), |facts| association::context(error, facts))
    })
}
