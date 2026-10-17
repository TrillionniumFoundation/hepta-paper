//! Fixed archive command policy calculation. Route labels are inventory data;
//! this component never executes a legacy command or grants native authority.
use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::{AtomicBool, Ordering},
};

/// Exact fixed source graph inputs; callers must bind these bytes through the
/// existing source/archive owners before treating a result as replay evidence.
pub struct LegacyCommandDispositionFixedInputsV1<'a> {
    pub paperctl: &'a [u8],
    pub catalog: &'a [u8],
    pub suite: &'a [u8],
    pub manifest: &'a [u8],
    pub batch_entrypoint: &'a [u8],
    pub batch_application: &'a [u8],
    pub mode_registry: &'a [u8],
}
fn command_policy_error(suffix: &str) -> String {
    format!("release_replay_native_command_disposition_{suffix}")
}
fn command_policy_checkpoint(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        Err(command_policy_error("cancelled"))
    } else {
        Ok(())
    }
}
fn command_policy_pin(
    bytes: &[u8],
    maximum: usize,
    pin: &str,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    command_policy_checkpoint(cancelled)?;
    if bytes.is_empty() || bytes.len() > maximum {
        return Err(command_policy_error("input_budget"));
    }
    let mut hash = Sha256::new();
    for block in bytes.chunks(65536) {
        command_policy_checkpoint(cancelled)?;
        hash.update(block);
    }
    if format!("{:x}", hash.finalize()) != pin {
        return Err(command_policy_error("fixed_input_changed"));
    }
    Ok(())
}
fn command_policy_ast(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > 64 * 1024 {
        return Err(command_policy_error("ast_input_budget"));
    }
    let source = std::str::from_utf8(bytes).map_err(|_| command_policy_error("input_utf8"))?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
    if parsed.panicked || !parsed.diagnostics.is_empty() {
        return Err(command_policy_error("fixed_grammar_changed"));
    }
    let encoded = parsed.program.to_estree_json(false, true);
    if encoded.len() > 2 * 1024 * 1024 {
        return Err(command_policy_error("ast_output_budget"));
    }
    serde_json::from_str(&encoded).map_err(|_| command_policy_error("ast_invalid"))
}
fn command_policy_constant<'a>(tree: &'a Value, name: &str) -> Result<&'a Value, String> {
    let mut found = None;
    let body = tree["body"]
        .as_array()
        .filter(|v| v.len() <= 256)
        .ok_or_else(|| command_policy_error("ast_invalid"))?;
    for raw in body {
        let node = if raw["type"] == "ExportNamedDeclaration" {
            &raw["declaration"]
        } else {
            raw
        };
        if node["type"] != "VariableDeclaration" || node["kind"] != "const" {
            continue;
        }
        for item in node["declarations"]
            .as_array()
            .ok_or_else(|| command_policy_error("ast_invalid"))?
        {
            if item["id"]["type"] == "Identifier"
                && item["id"]["name"] == name
                && found.replace(&item["init"]).is_some()
            {
                return Err(command_policy_error("duplicate_constant"));
            }
        }
    }
    found.ok_or_else(|| command_policy_error("constant_missing"))
}
fn command_policy_string_object(node: &Value) -> Result<BTreeMap<String, String>, String> {
    if node["type"] != "CallExpression"
        || node["optional"] != false
        || node["callee"]["type"] != "MemberExpression"
        || node["callee"]["computed"] != false
        || node["callee"]["object"]["name"] != "Object"
        || node["callee"]["property"]["name"] != "freeze"
    {
        return Err(command_policy_error("constant_grammar"));
    }
    let args = node["arguments"]
        .as_array()
        .filter(|v| v.len() == 1)
        .ok_or_else(|| command_policy_error("constant_grammar"))?;
    if args[0]["type"] != "ObjectExpression" {
        return Err(command_policy_error("constant_grammar"));
    }
    let raw = args[0]["properties"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .ok_or_else(|| command_policy_error("constant_grammar"))?;
    let mut result = BTreeMap::new();
    for property in raw {
        if property["type"] != "Property"
            || property["kind"] != "init"
            || property["method"] != false
            || property["computed"] != false
            || property["shorthand"] != false
            || property["value"]["type"] != "Literal"
        {
            return Err(command_policy_error("constant_grammar"));
        }
        let key = if property["key"]["type"] == "Identifier" {
            property["key"]["name"].as_str()
        } else if property["key"]["type"] == "Literal" {
            property["key"]["value"].as_str()
        } else {
            None
        }
        .ok_or_else(|| command_policy_error("constant_grammar"))?;
        let value = property["value"]["value"]
            .as_str()
            .filter(|v| v.len() <= 4096)
            .ok_or_else(|| command_policy_error("constant_grammar"))?;
        if result.insert(key.into(), value.into()).is_some() {
            return Err(command_policy_error("duplicate_constant"));
        }
    }
    Ok(result)
}
fn command_policy_pattern(tree: &Value, name: &str) -> Result<Regex, String> {
    let node = command_policy_constant(tree, name)?;
    let pattern = node["regex"]["pattern"]
        .as_str()
        .filter(|v| v.len() <= 1024)
        .ok_or_else(|| command_policy_error("pattern_grammar"))?;
    if node["type"] != "Literal" || node["regex"]["flags"] != "" {
        return Err(command_policy_error("pattern_grammar"));
    }
    Regex::new(pattern).map_err(|_| command_policy_error("pattern_grammar"))
}
fn command_policy_reexport(tree: &Value, source: &str) -> Result<(), String> {
    let body = tree["body"]
        .as_array()
        .ok_or_else(|| command_policy_error("reexport_grammar"))?;
    let mut count = 0;
    for item in body {
        if item["type"] != "ExportNamedDeclaration" || item["source"]["value"] != source {
            continue;
        }
        for specifier in item["specifiers"]
            .as_array()
            .ok_or_else(|| command_policy_error("reexport_grammar"))?
        {
            if specifier["type"] == "ExportSpecifier"
                && specifier["exported"]["name"] == "PAPER_BATCH_MODES"
                && specifier["local"]["name"] == "PAPER_BATCH_MODES"
            {
                count += 1;
            }
        }
    }
    if count != 1 {
        return Err(command_policy_error("mode_source_binding"));
    }
    Ok(())
}
fn command_policy_pending_target(command: &str) -> &'static str {
    if command.starts_with("research-compute") {
        "paper-adapters/research-verify"
    } else if command.contains("referee") {
        "paper-adapters/referee-review+referee-revise"
    } else if command.contains("submission") {
        "paper-adapters/submission"
    } else if command.contains("venue") {
        "paper-adapters/venue-resolve+journal-manage"
    } else if command.contains("source") {
        "paper-adapters/source-adapt+build-package"
    } else if ["package", "compile", "artifact"]
        .iter()
        .any(|v| command.contains(v))
    {
        "paper-adapters/build-package"
    } else {
        "paper-core/src/paper-batch-runner.mjs+paper-core/src/contracts"
    }
}
/// Complete fixed 760-command policy manifest and exact fixed Node suite result.
/// No route labels are evidence of Rust business execution.
pub fn inspect_legacy_paperctl_command_disposition_fixed_v1(
    inputs: LegacyCommandDispositionFixedInputsV1<'_>,
    cancelled: &AtomicBool,
) -> Result<Value, String> {
    for (bytes, maximum, pin) in [
        (
            inputs.paperctl,
            16 * 1024 * 1024,
            "ffe4dfc7de97062cb99b6398c49b1e99355aba4492acc513b7d387126d617d8a",
        ),
        (
            inputs.catalog,
            64 * 1024,
            "d2033c02cd8f4767bbf105b9fd10460fcd8d3012386911ab46b602990a907c95",
        ),
        (
            inputs.suite,
            64 * 1024,
            "6b54737b2e597594d15fb4ac12eb382b28891e88f0bef3f8604754876f64a090",
        ),
        (
            inputs.manifest,
            512 * 1024,
            "30978d63597f9e0333862f6cd44fcbbf8fd5c237d36a6e1ad3fcc054debbea30",
        ),
        (
            inputs.batch_entrypoint,
            64 * 1024,
            "668da16ac64bbeac3be278f4171d6e4cae0e609dfe58d02b16c7a71c8bb4ed60",
        ),
        (
            inputs.batch_application,
            64 * 1024,
            "7de61563e0b1849e7bef373b0ae4fb45c3c9e6d50df11e37c0ac54895ad83820",
        ),
        (
            inputs.mode_registry,
            64 * 1024,
            "5e21138b483b16dd498775376f8c2312eb7e966695b2b79255ed8a543afc7194",
        ),
    ] {
        command_policy_pin(bytes, maximum, pin, cancelled)?;
    }
    command_policy_checkpoint(cancelled)?;
    let catalog = command_policy_ast(inputs.catalog)?;
    let routes = command_policy_string_object(command_policy_constant(
        &catalog,
        "NATIVE_REPLACEMENT_ROUTES",
    )?)?;
    let report_only = command_policy_pattern(&catalog, "REPORT_ONLY_MARKERS")?;
    let semantic = command_policy_pattern(&catalog, "PAPER_SEMANTIC_FAMILY")?;
    let export = command_policy_pattern(&catalog, "DATA_EXPORT_FAMILY")?;
    let entrypoint = command_policy_ast(inputs.batch_entrypoint)?;
    let application = command_policy_ast(inputs.batch_application)?;
    command_policy_reexport(
        &entrypoint,
        "../../paper-composition/batch/paper-batch-application.mjs",
    )?;
    command_policy_reexport(
        &application,
        "../../paper-domain/workflow/mode-registry.mjs",
    )?;
    let modes_tree = command_policy_ast(inputs.mode_registry)?;
    let mode_map =
        command_policy_string_object(command_policy_constant(&modes_tree, "PAPER_BATCH_MODES")?)?;
    let modes = mode_map.values().collect::<BTreeSet<_>>();
    if modes.len() != mode_map.len() {
        return Err(command_policy_error("duplicate_mode"));
    }
    let mode_pattern =
        Regex::new(r"--mode ([a-z-]+)").map_err(|_| command_policy_error("pattern_unavailable"))?;
    for target in routes.values() {
        if !target.starts_with("paper-production-core ") {
            return Err(command_policy_error("native_target_invalid"));
        }
        if let Some(mode) = mode_pattern.captures(target).and_then(|v| v.get(1))
            && !mode_map.values().any(|value| value == mode.as_str())
        {
            return Err(command_policy_error("native_mode_unbound"));
        }
    }
    let source =
        std::str::from_utf8(inputs.paperctl).map_err(|_| command_policy_error("input_utf8"))?;
    let parser = Regex::new(r#"\.add_parser\(\s*['"]([^'"]+)['"]"#)
        .map_err(|_| command_policy_error("pattern_unavailable"))?;
    let dispatch = Regex::new(r#"args\.cmd\s*==\s*['"]([^'"]+)['"]"#)
        .map_err(|_| command_policy_error("pattern_unavailable"))?;
    let mut source_line = 1;
    let mut previous = 0;
    let mut entries = Vec::new();
    let mut parser_set = BTreeSet::new();
    let mut counts = BTreeMap::<String, u64>::new();
    for found in parser.captures_iter(source) {
        command_policy_checkpoint(cancelled)?;
        let matched = found
            .get(0)
            .ok_or_else(|| command_policy_error("parser_grammar"))?;
        source_line += source.as_bytes()[previous..matched.start()]
            .iter()
            .filter(|v| **v == b'\n')
            .count();
        previous = matched.start();
        let command = found
            .get(1)
            .ok_or_else(|| command_policy_error("parser_grammar"))?
            .as_str();
        if entries.len() >= 1024 || !parser_set.insert(command.to_owned()) {
            return Err(command_policy_error("parser_command_budget_or_duplicate"));
        }
        let (disposition, target, rationale) = if let Some(target) = routes.get(command) {
            (
                "native_hepta_replacement_route",
                Some(target.as_str()),
                "canonical local paper-production route exists in hepta-paper",
            )
        } else if report_only.is_match(command) {
            (
                "quarantined_report_or_control_evidence",
                Some("runtime/legacy-retirement audit archive"),
                "report/gate/capstone surface is retained only as non-authoritative audit evidence",
            )
        } else if semantic.is_match(command) {
            (
                "blocked_pending_p1_semantic_migration",
                Some(command_policy_pending_target(command)),
                "legacy command is unavailable from the canonical hepta entrypoint until its P1 symbol matrix row is complete",
            )
        } else if export.is_match(command) {
            (
                "legacy_data_export_only",
                Some("hepta-native SQLite/import-only migration tooling"),
                "legacy command may describe source data but is not an executable hepta control-plane route",
            )
        } else {
            (
                "retired_outside_hepta_paper_control_plane",
                None,
                "command belongs to the legacy multi-product factory rather than the hepta-paper product surface",
            )
        };
        *counts.entry(disposition.to_owned()).or_default() += 1;
        entries.push(json!({"command":command,"sourceLine":source_line,"disposition":disposition,"target":target,"rationale":rationale,"legacyExecutionAllowed":false,"externalActionAllowed":false}));
    }
    let mut dispatch_count = 0;
    let mut dispatch_set = BTreeSet::new();
    for found in dispatch.captures_iter(source) {
        command_policy_checkpoint(cancelled)?;
        dispatch_count += 1;
        if dispatch_count > 2048 {
            return Err(command_policy_error("dispatch_budget"));
        }
        dispatch_set.insert(
            found
                .get(1)
                .ok_or_else(|| command_policy_error("dispatch_grammar"))?
                .as_str()
                .to_owned(),
        );
    }
    if parser_set != dispatch_set || entries.len() != 760 {
        return Err(command_policy_error("parser_dispatch_set_mismatch"));
    }
    let expected_counts = BTreeMap::from([
        ("native_hepta_replacement_route".to_owned(), 10),
        ("blocked_pending_p1_semantic_migration".to_owned(), 87),
        ("quarantined_report_or_control_evidence".to_owned(), 566),
        ("legacy_data_export_only".to_owned(), 4),
        ("retired_outside_hepta_paper_control_plane".to_owned(), 93),
    ]);
    if counts != expected_counts {
        return Err(command_policy_error("disposition_counts_mismatch"));
    }
    let manifest = json!({"version":1,"kind":"LegacyPaperctlCommandDispositionManifest","source":{"path":"bin/paperctl","sha256":format!("{:x}",Sha256::digest(inputs.paperctl)),"commandCount":entries.len()},"policy":{"canonicalEntrypoint":"paper-production-core","legacyEntrypointAllowed":false,"unlistedLegacyCommandAllowed":false,"pendingP1CommandAllowed":false,"reportOnlyCommandAuthoritative":false,"liveExternalActionAllowed":false},"counts":counts,"entries":entries});
    let fixed: Value = serde_json::from_slice(inputs.manifest)
        .map_err(|_| command_policy_error("manifest_invalid"))?;
    if manifest != fixed {
        return Err(command_policy_error("regenerated_manifest_mismatch"));
    }
    command_policy_checkpoint(cancelled)?;
    let suite = json!({"ok":true,"kind":"P0PaperctlCommandDispositionTest","parserCommandCount":parser_set.len(),"dispatchCommandCount":dispatch_count,"explicitDispositionCount":manifest["entries"].as_array().map_or(0,Vec::len),"nativeRouteCount":counts["native_hepta_replacement_route"],"pendingP1Count":counts["blocked_pending_p1_semantic_migration"],"legacyEntrypointAllowed":false,"externalActionPerformed":false});
    Ok(
        json!({"version":1,"kind":"NativeFixedLegacyCommandDispositionCalculation","manifest":manifest,"suiteResult":suite,"boundPaperBatchModes":mode_map,"parserDispatchSetsEqual":true,"regeneratedManifestMatchesFixedSource":true,"nativeRouteLabelsGrantExecution":false,"fullRustBusinessImplementationClaimed":false,"externalActionPerformed":false}),
    )
}

#[cfg(test)]
mod command_disposition_refusal_tests {
    use super::*;
    fn malformed(bytes: &[u8]) -> LegacyCommandDispositionFixedInputsV1<'_> {
        LegacyCommandDispositionFixedInputsV1 {
            paperctl: bytes,
            catalog: b"no",
            suite: b"no",
            manifest: b"no",
            batch_entrypoint: b"no",
            batch_application: b"no",
            mode_registry: b"no",
        }
    }
    #[test]
    fn cancelled_fixed_policy_never_hashes_or_parses_inputs() {
        let error = inspect_legacy_paperctl_command_disposition_fixed_v1(
            malformed(b"not original"),
            &AtomicBool::new(true),
        )
        .unwrap_err();
        assert_eq!(error, "release_replay_native_command_disposition_cancelled");
    }
    #[test]
    fn modified_source_refuses_before_caller_manifest_or_authority_is_considered() {
        let error = inspect_legacy_paperctl_command_disposition_fixed_v1(
            malformed(b"args.cmd == 'submit'"),
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(
            error,
            "release_replay_native_command_disposition_fixed_input_changed"
        );
    }
    #[test]
    fn only_fixed_paperctl_field_has_the_measured_sixteen_mib_ceiling() {
        let bytes = vec![0; 16 * 1024 * 1024 + 1];
        let error = inspect_legacy_paperctl_command_disposition_fixed_v1(
            malformed(&bytes),
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(
            error,
            "release_replay_native_command_disposition_input_budget"
        );
        assert_eq!(
            command_policy_pin(
                &vec![0; 64 * 1024 + 1],
                64 * 1024,
                "",
                &AtomicBool::new(false)
            )
            .unwrap_err(),
            "release_replay_native_command_disposition_input_budget"
        );
    }
}
