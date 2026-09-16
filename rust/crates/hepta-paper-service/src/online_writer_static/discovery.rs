use super::ast::*;
use super::*;
fn regex_match(pattern: &str, source: &str) -> Result<bool> {
    Ok(regex::Regex::new(pattern)
        .map_err(|e| error(e.to_string()))?
        .is_match(source))
}
fn candidate(path: &str, source: &str, config: &Value) -> Result<bool> {
    if path.starts_with("paper-adapters/persistence/")
        || path.starts_with("paper-adapters/submission/")
    {
        return Ok(true);
    }
    static PATTERNS: std::sync::OnceLock<std::result::Result<Vec<regex::Regex>, String>> =
        std::sync::OnceLock::new();
    let patterns=PATTERNS.get_or_init(||{
        let mut raw=vec![r#"from ['"]node:sqlite['"]"#.to_owned(),r"\.executeMutation\s*\(".into(),r"\b(?:store|database|db|getApi\(\)|statement|stmt)\.(?:exec|execute|run|prepare|query|transaction)\s*\(".into(),r"\b(?:createSqliteStore|createReadOnlySqliteStore|writableStore|open[A-Za-z0-9]*Writable[A-Za-z0-9]*)\s*\(".into(),r"(?s)\bcreate[A-Za-z0-9]+Repository\s*\(\s*\{[^}]*\bcreate\s*:\s*true\b".into()];
        if let Some(sources)=config["WRITABLE_FACTORY_IMPORT_SOURCES"].as_object(){for entries in sources.values(){for entry in strings(entries){raw.push(format!(r"\b{}\s*\(",regex::escape(entry)));}}}
        raw.into_iter().map(|pattern|regex::Regex::new(&pattern).map_err(|e|e.to_string())).collect()
    }).as_ref().map_err(error)?;
    Ok(patterns.iter().any(|pattern| pattern.is_match(source)))
}
fn canonical_import(path: &str, source: &str) -> Option<String> {
    if !source.starts_with('.') {
        return None;
    }
    let joined = format!(
        "{}/{}",
        path.rsplit_once('/').map(|p| p.0).unwrap_or(""),
        source
    );
    let mut parts = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else {
                    parts.push(part);
                }
            }
            _ => parts.push(part),
        }
    }
    let mut result = parts.join("/");
    if !parts
        .last()
        .is_some_and(|p| p.rsplit_once('.').is_some_and(|(a, _)| !a.is_empty()))
    {
        result.push_str(".mjs");
    }
    Some(result)
}
fn imported(parsed: &Parsed, path: &str, config: &Value) -> BTreeSet<String> {
    let mut bindings = BTreeSet::new();
    for node in parsed.tree["body"].as_array().into_iter().flatten() {
        if kind(node) != "ImportDeclaration" {
            continue;
        }
        let Some(source) = node["source"]["value"]
            .as_str()
            .and_then(|s| canonical_import(path, s))
        else {
            continue;
        };
        let allowed = strings(&config["WRITABLE_FACTORY_IMPORT_SOURCES"][&source]);
        for specifier in node["specifiers"].as_array().into_iter().flatten() {
            if kind(specifier) == "ImportSpecifier"
                && property_name(&specifier["imported"])
                    .is_some_and(|name| allowed.contains(&name.as_str()))
                && let Some(local) = specifier["local"]["name"].as_str()
            {
                bindings.insert(local.into());
            }
        }
    }
    bindings
}
fn mutation_argument(call: &Value) -> Result<bool> {
    let mut found = false;
    let mut failure = None;
    for arg in call["arguments"].as_array().into_iter().flatten() {
        walk(arg, &mut |node| {
            if let Some(value) = static_string(node) {
                match mutation_sql(&value) {
                    Ok(true) => found = true,
                    Err(e) => failure = Some(e),
                    _ => {}
                }
            }
        });
    }
    if let Some(e) = failure {
        return Err(e);
    }
    Ok(found)
}
fn dynamic(call: &Value) -> bool {
    call["arguments"].as_array().into_iter().flatten().any(|a| {
        matches!(kind(a), "Identifier" | "MemberExpression")
            || (kind(a) == "TemplateLiteral"
                && a["expressions"].as_array().is_some_and(|a| !a.is_empty()))
    })
}
fn create_true(call: &Value) -> bool {
    call["arguments"].as_array().into_iter().flatten().any(|a| {
        object_property(a, "create")
            .is_some_and(|p| kind(&p["value"]) == "Literal" && p["value"]["value"] == true)
    })
}
fn exclusion<'a>(config: &'a Value, key: &str) -> Option<(Option<&'a str>, &'a str)> {
    for (classification, registry) in [
        (
            "authority-principal-writer",
            "AUTHORITY_PRINCIPAL_WRITER_ENTRYPOINTS",
        ),
        (
            "quiesced-maintenance-writer",
            "QUIESCED_MAINTENANCE_WRITER_ENTRYPOINTS",
        ),
        (
            "private-copy-simulation-writer",
            "PRIVATE_COPY_SIMULATION_WRITER_ENTRYPOINTS",
        ),
        (
            "staged-provisioning-writer",
            "STAGED_PROVISIONING_WRITER_ENTRYPOINTS",
        ),
    ] {
        if let Some(reason) = config[registry][key].as_str() {
            return Some((Some(classification), reason));
        }
    }
    config["NON_WRITER_ENTRYPOINT_EXCLUSIONS"][key]
        .as_str()
        .map(|reason| (None, reason))
}
struct Discovery<'a> {
    parsed: &'a Parsed,
    source: &'a str,
    path: &'a str,
    config: &'a Value,
    imported: BTreeSet<String>,
    mutations: Vec<String>,
    direct: BTreeSet<String>,
    functions: BTreeSet<String>,
    calls: Vec<(String, BTreeSet<String>)>,
    bindings: Vec<Value>,
    violations: Vec<Value>,
}
impl Discovery<'_> {
    fn mutation(&mut self, entry: String) {
        if !self.mutations.contains(&entry) {
            self.mutations.push(entry);
        }
    }
    fn visit<'a>(&mut self, node: &'a Value, ancestors: &mut Vec<&'a Value>) -> Result<()> {
        ancestors.push(node);
        if [
            "FunctionDeclaration",
            "FunctionExpression",
            "ArrowFunctionExpression",
        ]
        .contains(&kind(node))
            && let Some(name) =
                named_function(node, ancestors.len().checked_sub(2).map(|i| ancestors[i]))
        {
            self.functions.insert(name);
        }
        if kind(node) == "CallExpression" {
            let property = call_name(node);
            let name = property.as_deref().unwrap_or_default();
            let caller = ancestors
                .iter()
                .rposition(|a| kind(a) == "CallExpression" && fenced(a))
                .map(|i| enclosing(&ancestors[..=i]))
                .unwrap_or_else(|| enclosing(ancestors));
            if let Some(property) = &property {
                if let Some((_, callees)) = self.calls.iter_mut().find(|(name, _)| name == &caller)
                {
                    callees.insert(property.clone());
                } else {
                    self.calls
                        .push((caller.clone(), BTreeSet::from([property.clone()])));
                }
            }
            let binding = literal_binding(node);
            if name == "executeMutation"
                || (["mutate", "mutation"].contains(&name) && callback_property(node).is_some())
            {
                self.violations.extend(super::callback::violations(
                    self.parsed,
                    self.source,
                    node,
                    binding.as_ref(),
                    &caller,
                ));
            }
            if name == "executeMutation"
                || (["mutate", "mutation"].contains(&name) && binding.is_some())
            {
                self.bindings.push(json!({"entrypoint":caller,"databaseRole":binding.as_ref().map(|v|&v.0),"operationId":binding.as_ref().map(|v|&v.1)}));
            }
            let mutation_sql = ["exec", "execute", "prepare", "query", "queryRows", "run"]
                .contains(&name)
                && mutation_argument(node)?;
            let direct_dynamic = ["execute", "exec"].contains(&name) && dynamic(node);
            let writable = ["createSqliteStore", "writableStore"].contains(&name)
                || self.imported.contains(name)
                || strings(&self.config["WRITABLE_FACTORY_IMPORT_SOURCES"][self.path])
                    .contains(&name)
                || (regex_match(r"^create[A-Za-z0-9]+Repository$", name)? && create_true(node));
            if mutation_sql || direct_dynamic || name == "run" || writable {
                self.mutation(caller.clone());
            }
            if mutation_sql || direct_dynamic {
                self.direct.insert(caller);
            }
        }
        if let Some(literal) = static_string(node)
            && mutation_sql(&literal)?
        {
            let entry = enclosing(ancestors);
            self.mutation(entry.clone());
            self.direct.insert(entry);
        }
        for child in children(node) {
            self.visit(child, ancestors)?;
        }
        ancestors.pop();
        Ok(())
    }
}
pub fn discover_online_writer_mutation_entrypoints_v1(path: &str, source: &str) -> Result<Value> {
    let config = config()?;
    if let Some(reason) = config["NON_WRITER_EXCLUSIONS"][path].as_str() {
        return Ok(
            json!({"entrypoints":[],"allFunctions":[],"coordinatorBindings":[],"callbackBoundaryViolations":[],"exclusionReason":reason}),
        );
    }
    if !candidate(path, source, &config)? {
        return Ok(
            json!({"entrypoints":[],"allFunctions":[],"coordinatorBindings":[],"callbackBoundaryViolations":[],"exclusionReason":null}),
        );
    }
    let parsed = parse(path, source)?;
    let mut discovery = Discovery {
        parsed: &parsed,
        source,
        path,
        config: &config,
        imported: imported(&parsed, path, &config),
        mutations: vec![],
        direct: BTreeSet::new(),
        functions: BTreeSet::from(["moduleSchemaProvisioning".into()]),
        calls: Vec::new(),
        bindings: vec![],
        violations: vec![],
    };
    discovery.visit(&parsed.tree, &mut vec![])?;
    loop {
        let before = discovery.mutations.len();
        for (caller, callees) in &discovery.calls {
            if !discovery.mutations.contains(caller)
                && callees.iter().any(|c| discovery.mutations.contains(c))
            {
                discovery.mutations.push(caller.clone());
            }
        }
        if discovery.mutations.len() == before {
            break;
        }
    }
    for entry in strings(&config["GENERIC_MUTATION_SURFACES"][path]) {
        if discovery.functions.contains(entry) {
            discovery.mutation(entry.into());
        }
    }
    let mut candidates = discovery.mutations.clone();
    for binding in &discovery.bindings {
        if let Some(entry) = binding["entrypoint"].as_str()
            && !candidates.iter().any(|v| v == entry)
        {
            candidates.push(entry.into());
        }
    }
    let mut excluded = Vec::new();
    let mut excluded_names = BTreeSet::new();
    for entry in candidates {
        let key = format!("{path}:{entry}");
        if let Some((classification, reason)) = exclusion(&config, &key)
            && (!discovery.direct.contains(&entry)
                || strings(&config["DIRECT_SQL_ALLOWED_ENTRYPOINT_EXCLUSIONS"])
                    .contains(&key.as_str()))
        {
            discovery.mutations.retain(|v| v != &entry);
            excluded_names.insert(entry.clone());
            let mut row = json!({"sourceFile":path,"entrypoint":entry,"reason":reason});
            if let Some(classification) = classification {
                row["classification"] = json!(classification);
            }
            excluded.push(row);
        }
    }
    let mut bindings = Vec::new();
    for binding in discovery.bindings {
        if !excluded_names.contains(binding["entrypoint"].as_str().unwrap_or_default())
            && !bindings.contains(&binding)
        {
            bindings.push(binding);
        }
    }
    let collator = hepta_legacy_compatibility::ProductionCollationV1::load()
        .map_err(|e| error(e.to_string()))?;
    bindings.sort_by(|a, b| {
        collator
            .compare(
                a["entrypoint"].as_str().unwrap_or_default(),
                b["entrypoint"].as_str().unwrap_or_default(),
            )
            .then_with(|| {
                collator.compare(
                    a["operationId"].as_str().unwrap_or("null"),
                    b["operationId"].as_str().unwrap_or("null"),
                )
            })
    });
    discovery
        .violations
        .retain(|v| !excluded_names.contains(v["entrypoint"].as_str().unwrap_or_default()));
    Ok(
        json!({"entrypoints":js_sorted(discovery.mutations),"allFunctions":js_sorted(discovery.functions.into_iter().collect()),"coordinatorBindings":bindings,"callbackBoundaryViolations":discovery.violations,"exclusionReason":null,"excludedEntrypoints":excluded}),
    )
}
