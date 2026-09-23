use super::*;
use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, SourceType};
#[derive(Clone)]
pub(super) struct Symbol {
    pub name: String,
    pub definitions: Vec<(u32, u32)>,
    pub scopes: Vec<u32>,
}
pub(super) struct Parsed {
    pub tree: Value,
    pub references: BTreeMap<(u32, u32), u32>,
    pub bindings: BTreeMap<(u32, u32), u32>,
    pub symbols: BTreeMap<u32, Symbol>,
    pub function_scopes: BTreeMap<(u32, u32), u32>,
}
pub(super) fn parse(path: &str, source: &str) -> Result<Parsed> {
    let fail = || {
        error(format!(
            "autonomous_research_online_writer_ast_parse_failed:{path}"
        ))
    };
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
    if !parsed.diagnostics.is_empty() || parsed.panicked {
        return Err(fail());
    }
    let built = SemanticBuilder::new_compiler()
        .with_build_nodes(true)
        .with_check_syntax_error(true)
        .build(&parsed.program);
    if !built.diagnostics.is_empty() {
        return Err(fail());
    }
    let semantic = built.semantic;
    let scopes = semantic.scoping();
    let tree =
        serde_json::from_str(&parsed.program.to_estree_json(false, true)).map_err(|_| fail())?;
    let mut references = BTreeMap::new();
    let mut function_scopes = BTreeMap::new();
    for node in semantic.nodes().iter() {
        match node.kind() {
            AstKind::IdentifierReference(reference) => {
                if let Some(id) = reference
                    .reference_id
                    .get()
                    .and_then(|id| scopes.get_reference(id).symbol_id())
                {
                    references.insert(
                        (reference.span.start, reference.span.end),
                        id.index() as u32,
                    );
                }
            }
            AstKind::Function(function) => {
                if let Some(scope) = function.scope_id.get() {
                    function_scopes.insert(
                        (function.span.start, function.span.end),
                        scope.index() as u32,
                    );
                }
            }
            AstKind::ArrowFunctionExpression(function) => {
                if let Some(scope) = function.scope_id.get() {
                    function_scopes.insert(
                        (function.span.start, function.span.end),
                        scope.index() as u32,
                    );
                }
            }
            _ => {}
        }
    }
    let mut bindings = BTreeMap::new();
    let mut symbols = BTreeMap::new();
    for id in scopes.symbol_ids() {
        let span = scopes.symbol_span(id);
        bindings.insert((span.start, span.end), id.index() as u32);
        symbols.insert(
            id.index() as u32,
            Symbol {
                name: scopes.symbol_name(id).to_owned(),
                definitions: scopes
                    .symbol_declarations(id)
                    .map(|node| {
                        let span = semantic.nodes().get_node(node).span();
                        (span.start, span.end)
                    })
                    .collect(),
                scopes: scopes
                    .scope_ancestors(scopes.symbol_scope_id(id))
                    .map(|id| id.index() as u32)
                    .collect(),
            },
        );
    }
    Ok(Parsed {
        tree,
        references,
        bindings,
        symbols,
        function_scopes,
    })
}
pub(super) fn span(node: &Value) -> Option<(u32, u32)> {
    Some((
        u32::try_from(node["start"].as_u64()?).ok()?,
        u32::try_from(node["end"].as_u64()?).ok()?,
    ))
}
pub(super) fn kind(node: &Value) -> &str {
    node["type"].as_str().unwrap_or_default()
}
pub(super) fn children(node: &Value) -> Vec<&Value> {
    let mut result = Vec::new();
    if let Some(object) = node.as_object() {
        for (key, value) in object {
            if ["loc", "range", "start", "end"].contains(&key.as_str()) {
                continue;
            }
            if let Some(values) = value.as_array() {
                result.extend(values.iter().filter(|v| v["type"].is_string()));
            } else if value["type"].is_string() {
                result.push(value);
            }
        }
    }
    result.sort_by_key(|v| span(v).map(|s| s.0));
    result
}
pub(super) fn walk<'a>(node: &'a Value, visit: &mut impl FnMut(&'a Value)) {
    visit(node);
    for child in children(node) {
        walk(child, visit);
    }
}
/// A single immutable AST owns every referenced declaration. Build the same
/// first matching declaration map once; no caller input survives this parse.
pub(super) struct DeclarationIndex<'a>(BTreeMap<(u32, u32), &'a Value>);
impl<'a> DeclarationIndex<'a> {
    pub(super) fn new(tree: &'a Value) -> Self {
        let mut entries = BTreeMap::new();
        walk(tree, &mut |node| {
            if [
                "VariableDeclarator",
                "FunctionDeclaration",
                "FunctionExpression",
                "ArrowFunctionExpression",
            ]
            .contains(&kind(node))
                && let Some(position) = span(node)
            {
                entries.entry(position).or_insert(node);
            }
        });
        Self(entries)
    }
    pub(super) fn get(&self, target: (u32, u32)) -> Option<&'a Value> {
        self.0.get(&target).copied()
    }
}
#[cfg(test)]
pub(super) fn find_node(tree: &Value, target: (u32, u32)) -> Option<&Value> {
    if span(tree) == Some(target)
        && [
            "VariableDeclarator",
            "FunctionDeclaration",
            "FunctionExpression",
            "ArrowFunctionExpression",
        ]
        .contains(&kind(tree))
    {
        return Some(tree);
    }
    children(tree)
        .into_iter()
        .find_map(|node| find_node(node, target))
}
pub(super) fn property_name(node: &Value) -> Option<String> {
    match kind(node) {
        "Identifier" => node["name"].as_str().map(str::to_owned),
        "Literal" => Some(match &node["value"] {
            Value::String(s) => s.clone(),
            v => v.to_string(),
        }),
        _ => None,
    }
}
pub(super) fn static_string(node: &Value) -> Option<String> {
    match kind(node) {
        "Literal" => node["value"].as_str().map(str::to_owned),
        "TemplateLiteral" => Some(
            node["quasis"]
                .as_array()?
                .iter()
                .map(|q| {
                    q["value"]["cooked"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .or_else(|| q["value"]["raw"].as_str())
                        .unwrap_or_default()
                })
                .collect::<Vec<_>>()
                .join("?"),
        ),
        _ => None,
    }
}
pub(super) fn call_name(call: &Value) -> Option<String> {
    match kind(&call["callee"]) {
        "Identifier" => call["callee"]["name"].as_str().map(str::to_owned),
        "MemberExpression" => property_name(&call["callee"]["property"]),
        _ => None,
    }
}
pub(super) fn object_property<'a>(object: &'a Value, key: &str) -> Option<&'a Value> {
    if kind(object) != "ObjectExpression" {
        return None;
    }
    object["properties"]
        .as_array()?
        .iter()
        .find(|p| kind(p) == "Property" && property_name(&p["key"]).as_deref() == Some(key))
}
pub(super) fn callback_property(call: &Value) -> Option<&Value> {
    object_property(&call["arguments"][0], "mutate")
}
pub(super) fn literal_binding(call: &Value) -> Option<(String, String)> {
    Some((
        static_string(&object_property(&call["arguments"][0], "databaseRole")?["value"])?,
        static_string(&object_property(&call["arguments"][0], "operationId")?["value"])?,
    ))
}
pub(super) fn fenced(call: &Value) -> bool {
    let name = call_name(call);
    name.as_deref() == Some("executeMutation")
        || (matches!(name.as_deref(), Some("mutate" | "mutation"))
            && literal_binding(call).is_some())
}
pub(super) fn named_function(node: &Value, parent: Option<&Value>) -> Option<String> {
    if kind(node) == "FunctionDeclaration"
        && let Some(name) = node["id"]["name"].as_str()
    {
        return Some(name.into());
    }
    let parent = parent?;
    match kind(parent) {
        "VariableDeclarator" if kind(&parent["id"]) == "Identifier" => {
            parent["id"]["name"].as_str().map(str::to_owned)
        }
        "Property" | "MethodDefinition" => property_name(&parent["key"]),
        _ => None,
    }
}
pub(super) fn enclosing(ancestors: &[&Value]) -> String {
    for index in (0..ancestors.len().saturating_sub(1)).rev() {
        let node = ancestors[index];
        if [
            "FunctionDeclaration",
            "FunctionExpression",
            "ArrowFunctionExpression",
        ]
        .contains(&kind(node))
            && let Some(name) = named_function(node, index.checked_sub(1).map(|i| ancestors[i]))
        {
            return name;
        }
    }
    "moduleSchemaProvisioning".into()
}
pub(super) fn location(source: &str, node: &Value) -> (usize, usize) {
    let offset = span(node).map(|s| s.0 as usize).unwrap_or(0);
    let before = source.get(..offset).unwrap_or_default();
    let line = before.chars().filter(|c| *c == '\n').count() + 1;
    let column = before
        .rsplit('\n')
        .next()
        .unwrap_or_default()
        .encode_utf16()
        .count();
    (line, column)
}

#[cfg(test)]
mod declaration_index_tests {
    use super::*;
    #[test]
    fn index_retains_recursive_first_match_for_every_declared_span() {
        let source = "export function outer(db) { let raw = db; const cb = (tx) => { const alias = tx; return alias.run('x'); }; function nested() { let raw = 3; return raw; } return db.executeMutation({mutate: cb}); }";
        let parsed = parse("fixture.mjs", source).unwrap();
        let index = DeclarationIndex::new(&parsed.tree);
        walk(&parsed.tree, &mut |node| {
            if let Some(position) = span(node) {
                let before = find_node(&parsed.tree, position);
                let after = index.get(position);
                assert_eq!(before, after);
                if let (Some(before), Some(after)) = (before, after) {
                    assert!(std::ptr::eq(before, after));
                }
            }
        });
        assert_eq!(index.get((u32::MAX - 1, u32::MAX)), None);
        let duplicate = json!({"type":"Program","start":0,"end":10,"body":[
            {"type":"VariableDeclarator","start":1,"end":2,"id":{"type":"Identifier","start":1,"end":2,"name":"first"}},
            {"type":"FunctionDeclaration","start":1,"end":2,"id":{"type":"Identifier","start":1,"end":2,"name":"second"}}
        ]});
        let index = DeclarationIndex::new(&duplicate);
        assert_eq!(index.get((1, 2)), find_node(&duplicate, (1, 2)));
        assert_eq!(index.get((1, 2)).unwrap()["id"]["name"], "first");
    }
}
