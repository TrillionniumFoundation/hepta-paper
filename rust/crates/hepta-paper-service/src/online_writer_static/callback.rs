use super::ast::*;
use super::*;
fn root_identifier(mut node: &Value) -> Option<&Value> {
    while kind(node) == "ChainExpression" {
        node = &node["expression"];
    }
    while kind(node) == "MemberExpression" {
        node = &node["object"];
    }
    (kind(node) == "Identifier").then_some(node)
}
fn raw_name(name: &str) -> bool {
    let name = name.to_lowercase();
    name == "db"
        || ["database", "store", "persistence"]
            .iter()
            .any(|part| name.contains(part))
}
fn member_raw(member: &Value) -> bool {
    let mut current = &member["object"];
    while kind(current) == "MemberExpression" {
        if property_name(&current["property"]).is_some_and(|name| raw_name(&name)) {
            return true;
        }
        current = &current["object"];
    }
    false
}
fn reference(parsed: &Parsed, node: &Value) -> Option<u32> {
    parsed.references.get(&span(node)?).copied()
}
fn callback<'a>(
    parsed: &Parsed,
    call: &'a Value,
    declarations: &DeclarationIndex<'a>,
) -> Option<&'a Value> {
    let value = &callback_property(call)?["value"];
    if ["FunctionExpression", "ArrowFunctionExpression"].contains(&kind(value)) {
        return Some(value);
    }
    if kind(value) != "Identifier" {
        return None;
    }
    let symbol = parsed.symbols.get(&reference(parsed, value)?)?;
    for declaration in &symbol.definitions {
        let Some(definition) = declarations.get(*declaration) else {
            continue;
        };
        let candidate = if kind(definition) == "VariableDeclarator" {
            &definition["init"]
        } else {
            definition
        };
        if [
            "FunctionDeclaration",
            "FunctionExpression",
            "ArrowFunctionExpression",
        ]
        .contains(&kind(candidate))
        {
            return Some(candidate);
        }
    }
    None
}
pub(super) fn violations(
    parsed: &Parsed,
    declarations: &DeclarationIndex<'_>,
    source: &str,
    call: &Value,
    binding: Option<&(String, String)>,
    entrypoint: &str,
) -> Vec<Value> {
    let Some(property) = callback_property(call) else {
        return vec![];
    };
    let row = |node: &Value, capability: String, method: &str| {
        let (line, column) = location(source, node);
        json!({"entrypoint":entrypoint,"databaseRole":binding.map(|b|&b.0),"operationId":binding.map(|b|&b.1),"capabilityBinding":capability,"method":method,"line":line,"column":column})
    };
    let Some(callback) = callback(parsed, call, declarations) else {
        return vec![row(
            property,
            property["value"]["name"]
                .as_str()
                .or_else(|| property["value"]["type"].as_str())
                .unwrap_or("unknown")
                .into(),
            "uninspectable-callback",
        )];
    };
    let callback_scope = span(callback)
        .and_then(|span| parsed.function_scopes.get(&span))
        .copied();
    let mut trusted = BTreeSet::new();
    let parameter = &callback["params"][0];
    if callback_scope.is_some()
        && kind(parameter) == "Identifier"
        && let Some(id) = span(parameter).and_then(|span| parsed.bindings.get(&span))
    {
        trusted.insert(*id);
    }
    let mut raw = parsed
        .symbols
        .iter()
        .filter(|(_, s)| raw_name(&s.name))
        .map(|(id, _)| *id)
        .collect::<BTreeSet<_>>();
    if kind(&call["callee"]) == "MemberExpression"
        && let Some(id) =
            root_identifier(&call["callee"]["object"]).and_then(|n| reference(parsed, n))
    {
        raw.insert(id);
    }
    if let Some(id) = object_property(&call["arguments"][0], "database")
        .and_then(|p| root_identifier(&p["value"]))
        .and_then(|n| reference(parsed, n))
    {
        raw.insert(id);
    }
    loop {
        let before = trusted.len() + raw.len();
        for (id, symbol) in &parsed.symbols {
            let within = callback_scope.is_some_and(|scope| symbol.scopes.contains(&scope));
            for declaration in &symbol.definitions {
                let Some(definition) = declarations
                    .get(*declaration)
                    .filter(|d| kind(d) == "VariableDeclarator")
                else {
                    continue;
                };
                let init = &definition["init"];
                if within
                    && kind(init) == "Identifier"
                    && reference(parsed, init).is_some_and(|v| trusted.contains(&v))
                {
                    trusted.insert(*id);
                }
                if root_identifier(init)
                    .and_then(|n| reference(parsed, n))
                    .is_some_and(|v| raw.contains(&v))
                {
                    raw.insert(*id);
                }
            }
        }
        if before == trusted.len() + raw.len() {
            break;
        }
    }
    let mut output = Vec::new();
    walk(&callback["body"], &mut |node| {
        if kind(node) != "MemberExpression" {
            return;
        }
        let dynamic = node["computed"] == true
            && !["Literal", "TemplateLiteral"].contains(&kind(&node["property"]));
        let method = if dynamic {
            Some("dynamic".to_owned())
        } else {
            property_name(&node["property"])
        };
        let Some(method) = method else {
            return;
        };
        let Some(root) = root_identifier(node) else {
            return;
        };
        let Some(id) = reference(parsed, root) else {
            return;
        };
        if ([
            "exec",
            "execute",
            "prepare",
            "query",
            "queryRows",
            "run",
            "transaction",
        ]
        .contains(&method.as_str())
            || dynamic)
            && (raw.contains(&id) || member_raw(node))
            && !trusted.contains(&id)
        {
            output.push(row(
                node,
                root["name"].as_str().unwrap_or_default().into(),
                &method,
            ));
        }
    });
    output
}
