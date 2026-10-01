//! Complete, fixed venue/referee explicit-retirement policy calculations.
//! Catalogs are parsed as data with the existing pinned Oxc parser. No JavaScript
//! is executed to calculate a native result and retirement grants no authority.
use super::{Matrix, Owner, SourceGraph, digest, error};
use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

struct Profile {
    catalog: &'static str,
    catalog_hash: &'static str,
    suite: &'static str,
    suite_hash: &'static str,
    declaration: &'static str,
    kind: &'static str,
    disposition: &'static str,
    migration_action: &'static str,
    unknown_path: &'static str,
    source_count: usize,
    minimum_reason_length: usize,
    ast_profile: &'static str,
}
const PROFILES: &[Profile] = &[
    Profile {
        catalog: "migration/venue-resolve-retirements.mjs",
        catalog_hash: "sha256:0d56743d65c4a18ae8c0afaa2e975bf924e8247b6ad43c99e626a9eb707770f8",
        suite: "migration/tests/p1-venue-resolve-retirements.mjs",
        suite_hash: "sha256:22954ef79b9f427f6886a96bf722f9b19752de7f4517e7227d79e112b6d5788d",
        declaration: "RETIREMENTS",
        kind: "P1VenueResolveExplicitRetirementTest",
        disposition: "retired_generated_control_evidence_surface",
        migration_action: "retire_generated_control_evidence_surface",
        unknown_path: "paperctl_modules/not-retired.py",
        source_count: 6,
        minimum_reason_length: 40,
        ast_profile: "venue_resolve_v1",
    },
    Profile {
        catalog: "migration/referee-revise-retirements.mjs",
        catalog_hash: "sha256:b64f6c54ab7bdfe2919c972caddad9a6aa282ab1c5c0d4f1198fd86a7231f0ec",
        suite: "migration/tests/p1-referee-revise-retirements.mjs",
        suite_hash: "sha256:8645d6174125cdf7b5ff9ed662535f7b22fa8cf7e27e8dae12890a6f82e13be3",
        declaration: "CAPSTONE_SYMBOLS",
        kind: "P1RefereeReviseExplicitRetirementTest",
        disposition: "retired_generated_referee_control_evidence_surface",
        migration_action: "retire_generated_referee_control_evidence_surface",
        unknown_path: "paperctl_modules/referee_revision.py",
        source_count: 18,
        minimum_reason_length: 60,
        ast_profile: "referee_revise_v1",
    },
];
#[derive(Clone, Debug)]
struct Entry {
    source_path: String,
    public_symbols: Vec<String>,
    disposition: String,
    reason: String,
}
#[derive(Debug)]
struct Catalog(Vec<Entry>);
impl Catalog {
    fn lookup(&self, path: &str) -> Option<&Entry> {
        self.0.iter().find(|entry| entry.source_path == path)
    }
}
fn invalid() -> String {
    error("native_retirement_catalog_invalid")
}
fn static_key(property: &Value) -> Result<&str, String> {
    if property["type"] != "Property"
        || property["kind"] != "init"
        || property["method"] != false
        || property["computed"] != false
        || property["shorthand"] != false
    {
        return Err(invalid());
    }
    match property["key"]["type"].as_str() {
        Some("Identifier") => property["key"]["name"].as_str().ok_or_else(invalid),
        Some("Literal") => property["key"]["value"].as_str().ok_or_else(invalid),
        _ => Err(invalid()),
    }
}
fn properties(node: &Value) -> Result<BTreeMap<&str, &Value>, String> {
    if node["type"] != "ObjectExpression" {
        return Err(invalid());
    }
    let raw = node["properties"].as_array().ok_or_else(invalid)?;
    if raw.len() > 256 {
        return Err(invalid());
    }
    let mut result = BTreeMap::new();
    for property in raw {
        if result
            .insert(static_key(property)?, &property["value"])
            .is_some()
        {
            return Err(invalid());
        }
    }
    Ok(result)
}
fn literal(node: &Value) -> Result<String, String> {
    if node["type"] != "Literal" {
        return Err(invalid());
    }
    node["value"]
        .as_str()
        .filter(|s| s.len() <= 4096 && !s.contains('\0'))
        .map(str::to_owned)
        .ok_or_else(invalid)
}
fn strings(node: &Value) -> Result<Vec<String>, String> {
    if node["type"] != "ArrayExpression" {
        return Err(invalid());
    }
    let elements = node["elements"].as_array().ok_or_else(invalid)?;
    if elements.is_empty() || elements.len() > 256 {
        return Err(invalid());
    }
    elements.iter().map(literal).collect()
}
fn fixed_tree(profile: &Profile, bytes: &[u8]) -> Result<Value, String> {
    fixed_tree_with_limit(profile, bytes, 16 * 1024)
}
fn fixed_tree_with_limit(
    profile: &Profile,
    bytes: &[u8],
    source_limit: usize,
) -> Result<Value, String> {
    // Exact immutable identities are checked before allocation or parsing. The
    // caller cannot enlarge this parser profile or choose a different program.
    if bytes.is_empty() || bytes.len() > source_limit || digest(bytes) != profile.catalog_hash {
        return Err(error("native_retirement_fixed_catalog_changed"));
    }
    let source = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
    if parsed.panicked || !parsed.diagnostics.is_empty() {
        return Err(invalid());
    }
    let encoded = parsed.program.to_estree_json(false, true);
    if encoded.len() > 512 * 1024 {
        return Err(error("native_retirement_catalog_ast_budget"));
    }
    serde_json::from_str(&encoded).map_err(|_| invalid())
}
fn first_initializer<'a>(profile: &Profile, tree: &'a Value) -> Result<&'a Value, String> {
    let body = tree["body"].as_array().ok_or_else(invalid)?;
    let first = body.first().ok_or_else(invalid)?;
    if first["type"] != "VariableDeclaration" || first["kind"] != "const" {
        return Err(invalid());
    }
    let declarations = first["declarations"].as_array().ok_or_else(invalid)?;
    if declarations.len() != 1
        || declarations[0]["id"]["type"] != "Identifier"
        || declarations[0]["id"]["name"] != profile.declaration
    {
        return Err(invalid());
    }
    Ok(&declarations[0]["init"])
}
fn referee_constants(tree: &Value) -> Result<(String, String), String> {
    let mut stack = vec![(tree, 0_usize)];
    let mut visited = 0_usize;
    let mut result = None;
    while let Some((node, depth)) = stack.pop() {
        visited += 1;
        if visited > 4096 || depth > 64 {
            return Err(error("native_retirement_catalog_ast_budget"));
        }
        if node["type"] == "ObjectExpression" {
            // Other objects may be shorthand maps; only the export object has
            // these two explicit literal fields. Its whole source is fixed.
            let raw = node["properties"].as_array().ok_or_else(invalid)?;
            let fields: BTreeMap<_, _> = raw
                .iter()
                .filter_map(|p| static_key(p).ok().map(|key| (key, &p["value"])))
                .collect();
            if let (Some(disposition), Some(reason)) =
                (fields.get("disposition"), fields.get("reason"))
                && result
                    .replace((literal(disposition)?, literal(reason)?))
                    .is_some()
            {
                return Err(invalid());
            }
        }
        match node {
            Value::Object(object) => stack.extend(
                object
                    .values()
                    .filter(|v| v.is_object() || v.is_array())
                    .map(|v| (v, depth + 1)),
            ),
            Value::Array(array) => stack.extend(
                array
                    .iter()
                    .filter(|v| v.is_object() || v.is_array())
                    .map(|v| (v, depth + 1)),
            ),
            _ => {}
        }
    }
    result.ok_or_else(invalid)
}
fn catalog(profile: &Profile, bytes: &[u8]) -> Result<Catalog, String> {
    let tree = fixed_tree(profile, bytes)?;
    let first = first_initializer(profile, &tree)?;
    let mut entries = Vec::new();
    if profile.declaration == "RETIREMENTS" {
        if first["type"] != "ArrayExpression" {
            return Err(invalid());
        }
        for element in first["elements"].as_array().ok_or_else(invalid)? {
            let fields = properties(element)?;
            if fields.len() != 4 {
                return Err(invalid());
            }
            let field = |key| fields.get(key).copied().ok_or_else(invalid);
            entries.push(Entry {
                source_path: literal(field("sourcePath")?)?,
                public_symbols: strings(field("publicSymbols")?)?,
                disposition: literal(field("disposition")?)?,
                reason: literal(field("reason")?)?,
            });
        }
    } else {
        let (disposition, reason) = referee_constants(&tree)?;
        if first["type"] != "ObjectExpression" {
            return Err(invalid());
        }
        let mut seen = BTreeSet::new();
        for property in first["properties"].as_array().ok_or_else(invalid)? {
            let source_path = static_key(property)?.to_owned();
            if !seen.insert(source_path.clone()) {
                return Err(invalid());
            }
            entries.push(Entry {
                source_path,
                public_symbols: strings(&property["value"])?,
                disposition: disposition.clone(),
                reason: reason.clone(),
            });
        }
    }
    let result = Catalog(entries);
    validate_catalog(profile, &result)?;
    Ok(result)
}
fn validate_catalog(profile: &Profile, catalog: &Catalog) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    if catalog.0.len() != profile.source_count || catalog.lookup(profile.unknown_path).is_some() {
        return Err(invalid());
    }
    for entry in &catalog.0 {
        if !entry.source_path.is_ascii()
            || !entry.source_path.starts_with("paperctl_modules/")
            || !entry.source_path.ends_with(".py")
            || !seen.insert(&entry.source_path)
            || entry.disposition != profile.disposition
            || entry.reason.encode_utf16().count() < profile.minimum_reason_length
            || catalog
                .lookup(&entry.source_path)
                .is_none_or(|found| !std::ptr::eq(found, entry))
        {
            return Err(invalid());
        }
    }
    Ok(())
}
fn audit_matches(entry: &Entry, audit: &Value) -> Result<(), String> {
    if audit["public"] != json!(entry.public_symbols)
        || [
            "writes",
            "external_calls",
            "network_imports",
            "process_imports",
        ]
        .iter()
        .any(|key| audit[*key].as_array().is_none_or(|v| !v.is_empty()))
    {
        return Err(error("native_retirement_source_effect_or_symbol_mismatch"));
    }
    Ok(())
}
pub(super) fn production_path(path: &str) -> bool {
    path.ends_with(".mjs")
        && ["paper-core/src/", "paper-core/bin/", "paper-adapters/"]
            .iter()
            .any(|root| path.starts_with(root))
}
pub(super) fn referenced(bytes: &[u8], needle: &str) -> bool {
    // The original observer escapes every regexp metacharacter and searches an
    // ASCII source path. Searching the exact bytes is equivalent, including
    // Node UTF-8 replacement semantics and its inserted newline boundaries.
    bytes
        .windows(needle.len())
        .any(|part| part == needle.as_bytes())
}
pub(super) struct Observed {
    pub summaries: BTreeMap<String, Value>,
    pub accepted_source_paths: BTreeSet<String>,
    pub receipt: Value,
}
// A fixed source-bound symbol object reuses the exact catalog parser and
// initializer grammar; callers cannot choose a program or parser executable.
pub(super) fn fixed_symbol_table(
    bytes: &[u8],
    sha256: &'static str,
    declaration: &'static str,
) -> Result<Vec<(String, Vec<String>)>, String> {
    let profile = Profile {
        catalog: "migration/build-package-retirements.mjs",
        catalog_hash: sha256,
        suite: "",
        suite_hash: "",
        declaration,
        kind: "",
        disposition: "",
        migration_action: "",
        unknown_path: "",
        source_count: 0,
        minimum_reason_length: 0,
        ast_profile: "",
    };
    let tree = fixed_tree(&profile, bytes)?;
    let fields = properties(first_initializer(&profile, &tree)?)?;
    fields
        .into_iter()
        .map(|(path, values)| Ok((path.into(), strings(values)?)))
        .collect()
}
// The 54,299-byte research catalog has one fixed hash and initializer. Older
// profiles retain their original sixteen KiB cap; no external input chooses
// this bound, declaration, source program or parser.
pub(super) fn fixed_research_symbol_table(
    bytes: &[u8],
) -> Result<Vec<(String, Vec<String>)>, String> {
    let profile = Profile {
        catalog: "migration/research-verify-retirements.mjs",
        catalog_hash: "sha256:ad5ca54eb2b0a6ba881123b018d281d933ed52b0cd204013d722122dcb39576f",
        suite: "",
        suite_hash: "",
        declaration: "PUBLIC_SYMBOLS",
        kind: "",
        disposition: "",
        migration_action: "",
        unknown_path: "",
        source_count: 0,
        minimum_reason_length: 0,
        ast_profile: "",
    };
    let tree = fixed_tree_with_limit(&profile, bytes, 64 * 1024)?;
    let fields = properties(first_initializer(&profile, &tree)?)?;
    fields
        .into_iter()
        .map(|(path, values)| Ok((path.into(), strings(values)?)))
        .collect()
}
pub(super) fn inspect(
    owner: &mut Owner<'_>,
    graph: &mut SourceGraph,
    matrix: &Matrix,
    ast: &(Value, Value),
) -> Result<Observed, String> {
    let native = ast.0["native"]["audits"].as_array().ok_or_else(invalid)?;
    let bindings = ast.1["bindings"].as_array().ok_or_else(invalid)?;
    if native.len() != 245 || bindings.len() != native.len() {
        return Err(invalid());
    }
    let mut audits = BTreeMap::new();
    for (binding, audit) in bindings.iter().zip(native) {
        let path = binding["sourcePath"].as_str().ok_or_else(invalid)?;
        if audits.insert(path.to_owned(), (binding, audit)).is_some() {
            return Err(invalid());
        }
    }
    let mut catalogs = Vec::new();
    let mut accepted = BTreeSet::new();
    let mut catalog_receipts = Vec::new();
    for profile in PROFILES {
        owner.remaining()?;
        let bytes = graph.read_input(owner, profile.catalog)?;
        let suite = graph.read_input(owner, profile.suite)?;
        if digest(&suite) != profile.suite_hash {
            return Err(error("native_retirement_fixed_suite_changed"));
        }
        let parsed = catalog(profile, &bytes)?;
        for entry in &parsed.0 {
            owner.remaining()?;
            let row = matrix
                .entries
                .iter()
                .find(|row| row.source.path == entry.source_path)
                .ok_or_else(invalid)?;
            if row.verification_class != "explicit_retirement"
                || row.migration_action != profile.migration_action
                || row.source.symbols != entry.public_symbols
                || row.behavior_tests.len() != 1
                || row.behavior_tests[0].path != profile.suite
            {
                return Err(error("native_retirement_matrix_policy_mismatch"));
            }
            let (binding, audit) = audits.get(&entry.source_path).ok_or_else(invalid)?;
            if binding["matrixId"] != row.id
                || binding["sourceSha256"] != format!("sha256:{}", row.source.sha256)
                || binding["profile"] != profile.ast_profile
            {
                return Err(invalid());
            }
            audit_matches(entry, audit)?;
            if !accepted.insert(entry.source_path.clone()) {
                return Err(invalid());
            }
        }
        catalog_receipts.push(json!({"path":profile.catalog,"sha256":digest(&bytes),"bytes":bytes.len(),"suite":profile.suite,"suiteSha256":digest(&suite),"retiredSourceCount":parsed.0.len(),"publicSymbolCount":parsed.0.iter().map(|e|e.public_symbols.len()).sum::<usize>(),"unknownPath":profile.unknown_path,"unknownLookupReturnedNull":true,"borrowedEntryLookupIdentityVerified":true}));
        catalogs.push((profile, parsed));
    }
    let paths: Vec<_> = graph
        .paths()
        .filter(|path| production_path(path))
        .map(str::to_owned)
        .collect();
    if paths.is_empty() {
        return Err(error("native_retirement_production_graph_empty"));
    }
    let mut scanned = Vec::new();
    let mut scanned_bytes = 0_u64;
    for path in &paths {
        owner.remaining()?;
        let bytes = graph.read_input(owner, path)?;
        for source in &accepted {
            owner.remaining()?;
            if referenced(&bytes, source) {
                return Err(format!(
                    "{}:{path}:{source}",
                    error("native_retirement_production_reference_found")
                ));
            }
        }
        scanned_bytes += bytes.len() as u64;
        scanned.push(json!({"path":path,"sha256":digest(&bytes),"bytes":bytes.len()}));
    }
    let summaries = catalogs.iter().map(|(profile, catalog)| (profile.suite.to_owned(), json!({"ok":true,"kind":profile.kind,"retiredSourceCount":catalog.0.len(),"publicSymbolCount":catalog.0.iter().map(|e|e.public_symbols.len()).sum::<usize>(),"sourceWrites":0,"sourceExternalCalls":0,"heptaProductionReferences":0}))).collect();
    Ok(Observed {
        summaries,
        accepted_source_paths: accepted,
        receipt: json!({"version":1,"kind":"NativeFixedExplicitRetirementPolicyObservation","scope":"six_venue_and_eighteen_referee_complete_explicit_retirement_policies","catalogs":catalog_receipts,"parser":{"name":"oxc_parser","version":"0.148.0","javaScriptExecuted":false,"fixedCatalogMaximumBytes":16*1024},"productionReferenceScan":{"roots":["paper-core/src","paper-core/bin","paper-adapters"],"extension":".mjs","actualFileCount":paths.len(),"actualBytes":scanned_bytes,"inputs":scanned,"references":0,"sourceGraphHeldBytesUsed":true},"retiredSourceCount":24,"fullRustProductImplementationClaimed":false,"behavioralReplacementClaimed":false}),
    })
}
pub(super) fn compare(
    observed: &mut Observed,
    executions: &BTreeMap<String, Value>,
) -> Result<(), String> {
    for (suite, native) in &observed.summaries {
        if executions.get(suite).map(|value| &value["actualResult"]) != Some(native) {
            return Err(format!(
                "{}:{suite}",
                error("native_retirement_full_suite_mismatch")
            ));
        }
    }
    observed.receipt["actualSameInputFullNodeSuiteResultsMatched"] = json!(true);
    observed.receipt["nativeSummaryResults"] = json!(observed.summaries);
    observed.receipt["completeNativeExplicitRetirementSuiteCount"] =
        json!(observed.summaries.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const VENUE: &[u8] =
        include_bytes!("../../../../../../../migration/venue-resolve-retirements.mjs");
    const REFEREE: &[u8] =
        include_bytes!("../../../../../../../migration/referee-revise-retirements.mjs");
    #[test]
    fn fixed_real_catalogs_parse_lookup_and_refuse_replaced_bytes() {
        for (profile, raw) in PROFILES.iter().zip([VENUE, REFEREE]) {
            let parsed = catalog(profile, raw).unwrap();
            assert_eq!(parsed.0.len(), profile.source_count);
            assert!(parsed.lookup(profile.unknown_path).is_none());
            let mut changed = raw.to_vec();
            changed.push(b'\n');
            assert!(
                catalog(profile, &changed)
                    .unwrap_err()
                    .ends_with("fixed_catalog_changed")
            );
            assert!(catalog(profile, &vec![b' '; 16 * 1024 + 1]).is_err());
            let mut changed = Catalog(parsed.0.clone());
            changed.0[0].disposition = "accepted".into();
            assert!(validate_catalog(profile, &changed).is_err());
            changed.0[0] = parsed.0[0].clone();
            changed.0[0].reason.clear();
            assert!(validate_catalog(profile, &changed).is_err());
            changed.0[0] = parsed.0[0].clone();
            changed.0[1] = changed.0[0].clone();
            assert!(validate_catalog(profile, &changed).is_err());
        }
    }
    #[test]
    fn symbols_effects_and_exact_literal_references_are_actual_rejections() {
        let catalog = catalog(&PROFILES[0], VENUE).unwrap();
        let entry = &catalog.0[0];
        let valid = json!({"public":entry.public_symbols,"writes":[],"external_calls":[],"network_imports":[],"process_imports":[]});
        audit_matches(entry, &valid).unwrap();
        for key in [
            "public",
            "writes",
            "external_calls",
            "network_imports",
            "process_imports",
        ] {
            let mut changed = valid.clone();
            changed[key] = json!(["unexpected"]);
            assert!(audit_matches(entry, &changed).is_err());
            changed[key] = Value::Null;
            assert!(audit_matches(entry, &changed).is_err());
        }
        assert!(referenced(
            format!("// {}", entry.source_path).as_bytes(),
            &entry.source_path
        ));
        assert!(!referenced(
            b"paperctl_modules/decision_pointsXpy",
            &entry.source_path
        ));
        assert!(production_path("paper-core/src/nested/a.mjs"));
        assert!(!production_path("paper-core/test/a.mjs"));
        assert!(!production_path("paper-adapters/a.js"));
    }
}
