use super::*;
use std::{collections::BTreeSet, fs, path::PathBuf};

struct Context {
    config: ProcessConfiguration,
    plugin: PluginAuthority,
    inputs: Value,
    policies: Value,
    binding: Value,
    inspection: Value,
}
fn configuration_inspection(
    config: Option<&ProcessConfiguration>,
    blockers: &[String],
) -> Result<Value> {
    let mut blockers: BTreeSet<_> = blockers.iter().cloned().collect();
    let bounded = config.is_some() && blockers.is_empty();
    let pinned = config.is_some_and(|c| c.is_pinned());
    if config.is_some() && !pinned {
        blockers.insert("runtime_reproducibility_configuration_not_pinned".into());
    }
    let ready = bounded && pinned && blockers.is_empty();
    let null = Value::Null;
    let identity = config.map_or(&null, |c| &c.identity);
    seal(
        "RuntimeImageReproducibilityConfigurationInspection",
        json!({"version":2,"kind":"RuntimeImageReproducibilityConfigurationInspection","status":if ready{"runtime_image_reproducibility_configuration_ready"}else if !blockers.is_empty(){"runtime_image_reproducibility_configuration_blocked"}else{"runtime_image_reproducibility_configuration_bounded"},"ready":ready,"boundedReady":bounded,"fullProductionReady":ready,"configured":config.is_some(),"configurationPinned":pinned,"configurationIdentityHash":identity["configurationIdentityHash"],"trustIdentityHash":identity["trustIdentityHash"],"verifierServiceIdentityHashes":array(&identity["verifiers"]).iter().map(|v|v["serviceIdentityHash"].clone()).collect::<Vec<_>>(),"verifierBackendIdentityHashes":array(&identity["verifiers"]).iter().map(|v|v["backend"]["backendIdentityHash"].clone()).collect::<Vec<_>>(),"independentVerifierCount":array(&identity["verifiers"]).len(),"maximumReceiptAgeMs":identity["maximumReceiptAgeMs"],"maximumVerificationCostUsd":identity["maximumVerificationCostUsd"],"verificationCostAuthority":identity["verificationCostAuthority"],"maximumVerifierTimeoutMs":identity["maximumVerifierTimeoutMs"],"minimumRefreshLeadMs":identity["minimumRefreshLeadMs"],"privateSigningKeyLoaded":false,"externalVerifierResponseAttestationRequired":true,"blockers":blockers}),
        "runtimeImageReproducibilityConfigurationInspectionHash",
    )
}
fn blocked(blockers: Vec<String>, configuration: Option<Value>) -> Result<Value> {
    let config = match configuration {
        Some(c) => c,
        None => configuration_inspection(None, &blockers)?,
    };
    let blockers: BTreeSet<_> = blockers.into_iter().collect();
    Ok(
        json!({"version":2,"kind":"RuntimeImageReproducibilityVerificationReport","status":"runtime_image_reproducibility_blocked","ready":false,"configuration":config,"inspection":null,"receipt":null,"publication":null,"externalActionPerformed":false,"blockers":blockers}),
    )
}
fn catalog(root: &Path) -> Result<(Value, Value)> {
    for (source, target) in [
        ("requirements.lock", "scientific-requirements.lock"),
        (
            "hepta-dataset-access-supervisor",
            "hepta-dataset-access-supervisor",
        ),
    ] {
        ensure(
            read_source(
                &root.join("runtime-images/python-scientific").join(source),
                64 * 1024 * 1024,
            )? == read_source(
                &root.join("runtime-images/python-gpu").join(target),
                64 * 1024 * 1024,
            )?,
            &format!("python_gpu_scientific_input_mirror_drift:{source}"),
        )?;
    }
    let cas = crate::runtime_source_cas::inspect_runtime_source_cas_v1(root);
    let mut definitions = json!({
 "python":{"profile":"python","contextPath":"runtime-images/python-scientific","definitionPaths":["Dockerfile","requirements.lock","hepta-dataset-access-supervisor"],"image":"hepta/python-scientific:0.14.0","imageDigest":"sha256:fcf1705c74de423957db8431b88814bbf2810fed04dbd8685329008ac43446cf","definitionManifestHash":"sha256:4e50953602c7feb132da5bd45f94beefe62395669b25b78d98aa18d8ed770b03"},
 "pythonGpu":{"profile":"pythonGpu","contextPath":"runtime-images/python-gpu","definitionPaths":["Dockerfile","requirements.lock","scientific-requirements.lock","hepta-dataset-access-supervisor"],"image":"hepta/python-gpu:0.15.0","imageDigest":"sha256:21acb5fb016d9fd17131215d16e1834fcfeb081e047718d49b6d58d8afa97e2b","definitionManifestHash":"sha256:0cfd59b6df1151cdc128ce97e231234b0ebc17e5312c2aece8f4bbb45cf0cf2f"},
 "r":{"profile":"r","contextPath":"runtime-images/r-scientific","definitionPaths":[".dockerignore","Dockerfile","renv.lock","packages.lock","restore-locked.R","verify-locked.R","normalize-installed.sh","hepta-dataset-access-supervisor"],"contextTransportMetadataPaths":["source-cas/.git","source-cas/.gitattributes"],"image":"hepta/r-scientific:0.14.0","imageDigest":"sha256:5216785588a8b78476b62ec26488232c248ecd58b2ac3bdff58ffa4cdac2f6cd","definitionManifestHash":"sha256:c91e91b0ae7a126e6eaa086f5322259886a9b8856443a6e038e179fdc242b182"}});
    definitions["r"]["definitionPaths"]
        .as_array_mut()
        .ok_or("runtime_reproducibility_registry_invalid")?
        .extend(array(&cas["definitionPaths"]).iter().cloned());
    let mut policies = json!({});
    for p in PROFILES {
        let ready = p != "r" || cas["ready"] == true;
        policies[p] =
            json!({"dependencyArtifactsContentHashed":ready,"sourceArchivesContentHashed":ready});
    }
    Ok((definitions, policies))
}
fn load(root: &Path, path: &Path, environment: &Value, now: &str) -> Result<Context> {
    let expected = environment["HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH"].as_str();
    let config =
        read_runtime_image_reproducibility_process_configuration_v1(path, expected, environment)?;
    let plugin = resolve_runtime_image_plugin_authority_v1(environment, now)?;
    if plugin.startup_inspection["source"] == "repository-builtin-signed-bundle-v1" {
        verify_runtime_image_builtin_plugin_source_binding_v1(root)?;
    }
    let (definitions, policies) = catalog(root)?;
    let inputs = array(&plugin.scope["requiredProfiles"])
        .iter()
        .map(|p| inspect_runtime_image_build_input_closure_v1(root, &definitions[s(p)]))
        .collect::<Result<Vec<_>>>()?;
    let binding = current_runtime_image_release_binding_v1(root)?;
    let inspection = configuration_inspection(Some(&config), &[])?;
    Ok(Context {
        config,
        plugin,
        inputs: json!(inputs),
        policies,
        binding,
        inspection,
    })
}
fn verification<'a>(context: &'a Context, now: &'a str) -> ReceiptVerificationContext<'a> {
    ReceiptVerificationContext {
        now,
        current_code_provenance_hash: s(&context.binding["codeProvenanceHash"]),
        current_release_identity_hash: s(&context.binding["releaseIdentityHash"]),
        current_inputs: &context.inputs,
        configuration: &context.config.identity,
        profile_policies: &context.policies,
        active_plugin_scope: &context.plugin.scope,
        public_keys: &context.config.public_keys,
    }
}
fn generate(context: &Context, now: &str, nonce: &str) -> Result<Value> {
    let start = instant(&now.into()).ok_or("runtime_reproducibility_clock_invalid")?;
    let window = context.config.identity["minimumRefreshLeadMs"]
        .as_i64()
        .ok_or("runtime_reproducibility_configuration_invalid")?;
    build_runtime_image_reproducibility_request_v2(
        &json!({"nonce":nonce,"requestedAt":now,"expiresAt":iso(start+window)?,"configurationIdentityHash":context.config.identity["configurationIdentityHash"],"trustIdentityHash":context.config.identity["trustIdentityHash"],"codeProvenanceHash":context.binding["codeProvenanceHash"],"releaseIdentityHash":context.binding["releaseIdentityHash"],"inputs":context.inputs}),
        &context.plugin.scope,
    )
}
fn absolute(value: &Value, cwd: &Path) -> Result<PathBuf> {
    let value = s(value);
    ensure(
        !value.is_empty() && value.len() <= 4096 && !value.contains('\0'),
        "runtime_reproducibility_path_not_canonical",
    )?;
    let p = Path::new(value);
    let p = if p.is_absolute() {
        p.to_path_buf()
    } else {
        cwd.join(p)
    };
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            _ => out.push(c.as_os_str()),
        }
    }
    Ok(out)
}
/// Native status/request/verify/offline-publish composition. Explicit `now` and
/// `nonce` are accepted for deterministic embedding; the CLI uses the real clock
/// and fresh OS randomness. Online fenced publication is a separate authority API.
pub fn runtime_image_reproducibility_report_v2(options: &Value) -> Result<Value> {
    ensure(
        options.as_object().is_some_and(|o| {
            o.keys().all(|k| {
                [
                    "action",
                    "repositoryRoot",
                    "runtimeRoot",
                    "configPath",
                    "receiptPath",
                    "environment",
                    "now",
                    "nonce",
                ]
                .contains(&k.as_str())
            })
        }),
        "runtime_reproducibility_options_invalid",
    )?;
    let action = options["action"].as_str().unwrap_or("status");
    ensure(
        ["status", "request", "verify", "publish"].contains(&action),
        "runtime_reproducibility_action_invalid",
    )?;
    let cwd = std::env::current_dir()?;
    let root = fs::canonicalize(absolute(&options["repositoryRoot"], &cwd)?)?;
    let environment = &options["environment"];
    ensure(
        environment.is_object(),
        "runtime_reproducibility_environment_invalid",
    )?;
    let now = match options["now"].as_str() {
        Some(n) => n.to_owned(),
        None => clock()?,
    };
    ensure(
        instant(&now.clone().into()).is_some(),
        "runtime_reproducibility_clock_invalid",
    )?;
    let config = if options["configPath"].is_null() {
        &environment["HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG"]
    } else {
        &options["configPath"]
    };
    if s(config).is_empty() {
        return if action == "status" {
            blocked(
                vec!["runtime_reproducibility_configuration_path_required".into()],
                None,
            )
        } else {
            Err("runtime_reproducibility_configuration_path_required".into())
        };
    }
    let config_path = absolute(config, &cwd)?;
    let context = match load(&root, &config_path, environment, &now) {
        Ok(c) => c,
        Err(e) if action == "status" => return blocked(vec![e.to_string()], None),
        Err(e) => return Err(e),
    };
    if context.inspection["fullProductionReady"] != true {
        return if action == "status" {
            blocked(
                array(&context.inspection["blockers"])
                    .iter()
                    .map(|v| s(v).to_owned())
                    .collect(),
                Some(context.inspection),
            )
        } else {
            Err("runtime_reproducibility_configuration_not_pinned".into())
        };
    }
    let receipt = if !options["receiptPath"].is_null() {
        absolute(&options["receiptPath"], &cwd)?
    } else if !s(&environment["HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT"]).is_empty() {
        absolute(
            &environment["HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_RECEIPT"],
            &cwd,
        )?
    } else {
        absolute(&options["runtimeRoot"], &cwd)?
            .join("autonomous-research/runtime-image-reproducibility/receipt.json")
    };
    if action == "status" {
        let stored = match read_runtime_image_reproducibility_publication_v2(
            &receipt,
            &verification(&context, &now),
        ) {
            Ok(Some(s)) => s,
            Ok(None) => {
                return blocked(
                    vec!["runtime_reproducibility_receipt_missing".into()],
                    Some(context.inspection),
                );
            }
            Err(e) => return blocked(vec![e.to_string()], Some(context.inspection)),
        };
        let inspection = &stored["inspection"];
        return Ok(
            json!({"version":2,"kind":"RuntimeImageReproducibilityVerificationReport","status":inspection["status"],"ready":inspection["ready"],"configuration":context.inspection,"inspection":inspection,"receipt":null,"receiptReference":{"receiptPath":receipt,"receiptContentHash":stored["receiptContentHash"],"receiptHash":stored["receipt"]["runtimeImageReproducibilityReceiptHash"]},"publication":null,"externalActionPerformed":false,"blockers":inspection["blockers"]}),
        );
    }
    let nonce = match options["nonce"].as_str() {
        Some(n) => n.to_owned(),
        None => nonce()?,
    };
    let request = generate(&context, &now, &nonce)?;
    if action == "request" {
        return Ok(
            json!({"version":1,"kind":"RuntimeImageReproducibilityRequestReport","status":"runtime_image_reproducibility_request_generated","request":request,"configuration":{"configurationIdentityHash":context.config.identity["configurationIdentityHash"],"trustIdentityHash":context.config.identity["trustIdentityHash"],"independentVerifierCount":2,"configurationPinned":true,"fullProductionReady":true,"privateSigningKeyLoaded":false},"externalActionPerformed":false}),
        );
    }
    let responses = process::invoke_with_directory(&context.config, &request, &root)?;
    let issued = if options["now"].is_null() {
        clock()?
    } else {
        now.clone()
    };
    let issue_ms =
        instant(&issued.clone().into()).ok_or("runtime_reproducibility_clock_invalid")?;
    let age = context.config.identity["maximumReceiptAgeMs"]
        .as_i64()
        .ok_or("runtime_reproducibility_configuration_invalid")?;
    let receipt_value = build_runtime_image_reproducibility_receipt_v2(
        &request,
        &responses,
        &issued,
        &iso(issue_ms + age)?,
        &context.plugin.scope,
    )?;
    // Re-resolve every live authority and source edge after the processes return.
    let current = load(&root, &config_path, environment, &issued)?;
    let inspection = verify_runtime_image_reproducibility_receipt_v2(
        &receipt_value,
        &verification(&current, &issued),
    )?;
    let publication = if action == "publish" {
        publish_runtime_image_reproducibility_offline_v2(
            &receipt,
            &receipt_value,
            &verification(&current, &issued),
        )?
    } else {
        Value::Null
    };
    Ok(
        json!({"version":2,"kind":"RuntimeImageReproducibilityVerificationReport","status":inspection["status"],"ready":inspection["ready"],"configuration":current.inspection,"inspection":inspection,"receipt":if action=="verify"{receipt_value}else{Value::Null},"publication":publication,"externalActionPerformed":true,"blockers":inspection["blockers"]}),
    )
}
