//! Native historical Python AST observations. Never executes the input source.
//! Production callers must contain this parser in the existing bounded process owner.
use rustpython_ast::Visitor;
use rustpython_parser::{Mode, Parse, Tok, ast, lexer};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use unicode_normalization::UnicodeNormalization;
const REQUEST_BYTES: usize = 16 * 1024 * 1024;
const CASE_COUNT: usize = 256;
const OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const AGGREGATE_AST_ITEMS: usize = 4_000_000;
const SOURCE_BYTES: usize = 4 * 1024 * 1024;
const NODE_COUNT: usize = 100_000;
const DEPTH: usize = 128;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    version: u16,
    kind: String,
    profile: String,
    source: String,
    source_path: Option<String>,
}
#[derive(Clone, Copy)]
enum Profile {
    Basic,
    Venue,
    Submission,
    Research,
}
fn profile(value: &str) -> Result<Profile, String> {
    match value {
        "build_package_v1" | "referee_revise_v1" => Ok(Profile::Basic),
        "venue_resolve_v1" => Ok(Profile::Venue),
        "submission_v1" => Ok(Profile::Submission),
        "research_verify_v1" => Ok(Profile::Research),
        _ => Err("python_ast_profile_invalid".into()),
    }
}
fn lexical_budget(source: &str) -> Result<usize, String> {
    if source.len() > SOURCE_BYTES || (source.contains('\0') || source.starts_with('\u{feff}')) {
        return Err("python_ast_source_budget_or_encoding".into());
    }
    let (mut count, mut nesting, mut segment) = (0_usize, 0_usize, 0_usize);
    for token in lexer::lex(source, Mode::Module) {
        let (token, _) = token.map_err(|_| "python_ast_lexical_refusal".to_owned())?;
        count += 1;
        if count > NODE_COUNT {
            return Err("python_ast_token_budget".into());
        }
        if matches!(
            token,
            Tok::Newline | Tok::Comma | Tok::Colon | Tok::Semi | Tok::Indent | Tok::Dedent
        ) {
            segment = 0;
        } else {
            segment += 1;
            if segment > 512 {
                return Err("python_ast_expression_segment_budget".into());
            }
        }
        match token {
            Tok::Lpar | Tok::Lsqb | Tok::Lbrace | Tok::Indent => {
                nesting += 1;
                if nesting > DEPTH {
                    return Err("python_ast_lexical_depth_budget".into());
                }
            }
            Tok::Rpar | Tok::Rsqb | Tok::Rbrace | Tok::Dedent => {
                nesting = nesting.saturating_sub(1)
            }
            _ => (),
        }
    }
    Ok(count)
}
fn call_name(value: &ast::Expr) -> String {
    let (mut cursor, mut parts) = (value, Vec::new());
    while let ast::Expr::Attribute(attr) = cursor {
        parts.push(attr.attr.as_str().nfkc().collect::<String>());
        cursor = &attr.value;
    }
    if let ast::Expr::Name(name) = cursor {
        parts.push(name.id.as_str().nfkc().collect::<String>());
    }
    parts.reverse();
    parts.join(".")
}
fn constant_string(value: &ast::Expr) -> Option<&str> {
    match value {
        ast::Expr::Constant(v) => match &v.value {
            ast::Constant::Str(s) => Some(s),
            _ => None,
        },
        _ => None,
    }
}
struct Audit {
    profile: Profile,
    nodes: usize,
    depth: usize,
    refused: bool,
    imports: BTreeSet<String>,
    writes: BTreeSet<String>,
    processes: BTreeSet<String>,
}
impl Audit {
    fn enter(&mut self) -> bool {
        self.nodes += 1;
        self.depth += 1;
        if self.nodes > NODE_COUNT || self.depth > DEPTH {
            self.refused = true
        }
        !self.refused
    }
    fn root_import(&mut self, name: &str) {
        if let Some(root) = name.nfkc().collect::<String>().split('.').next() {
            self.imports.insert(root.to_owned());
        }
    }
}
impl Visitor for Audit {
    fn visit_stmt(&mut self, node: ast::Stmt) {
        if self.enter() {
            self.generic_visit_stmt(node)
        }
        self.depth = self.depth.saturating_sub(1);
    }
    fn visit_expr(&mut self, node: ast::Expr) {
        if self.enter() {
            self.generic_visit_expr(node)
        }
        self.depth = self.depth.saturating_sub(1);
    }
    fn visit_pattern(&mut self, node: ast::Pattern) {
        if self.enter() {
            self.generic_visit_pattern(node)
        }
        self.depth = self.depth.saturating_sub(1);
    }
    fn visit_stmt_import(&mut self, node: ast::StmtImport) {
        for alias in node.names {
            self.root_import(alias.name.as_str());
        }
    }
    fn visit_stmt_import_from(&mut self, node: ast::StmtImportFrom) {
        if let Some(module) = node.module {
            self.root_import(module.as_str());
        }
    }
    fn visit_expr_call(&mut self, node: ast::ExprCall) {
        let name = call_name(&node.func);
        if name == "open" || name.ends_with(".open") {
            let index = if !matches!(self.profile, Profile::Basic | Profile::Venue)
                && name.ends_with(".open")
            {
                0
            } else {
                1
            };
            let mut mode = node.args.get(index).and_then(constant_string);
            for keyword in &node.keywords {
                if keyword
                    .arg
                    .as_ref()
                    .is_some_and(|v| v.as_str().nfkc().eq("mode".chars()))
                    && matches!(keyword.value, ast::Expr::Constant(_))
                {
                    mode = constant_string(&keyword.value);
                }
            }
            if let Some(mode) = mode
                && mode.chars().any(|c| "wax+".contains(c))
            {
                self.writes.insert(format!("{name}:{mode}"));
            }
        }
        let base = [
            "write_text",
            "write_bytes",
            "unlink",
            "remove",
            "rename",
            "mkdir",
            "makedirs",
            "rmdir",
            "removedirs",
            "touch",
        ];
        let extra = ["write", "writestr", "copy", "copy2", "move"];
        let leaf = name.rsplit('.').next().unwrap_or("");
        if base.contains(&leaf)
            || (!matches!(self.profile, Profile::Basic | Profile::Venue) && extra.contains(&leaf))
        {
            self.writes.insert(name.clone());
        }
        if [
            "os.system",
            "subprocess.run",
            "subprocess.call",
            "subprocess.Popen",
            "subprocess.check_call",
            "subprocess.check_output",
        ]
        .contains(&name.as_str())
        {
            self.processes.insert(name);
        }
        self.generic_visit_expr_call(node);
    }
    // The generated visitor leaves these auxiliary structures empty. Traverse
    // their actual children so defaults, keywords, with contexts and match guards
    // have the same observations as Python ast.walk.
    fn visit_arguments(&mut self, node: ast::Arguments) {
        for arg in node
            .posonlyargs
            .into_iter()
            .chain(node.args)
            .chain(node.kwonlyargs)
        {
            self.visit_arg(arg.def);
            if let Some(v) = arg.default {
                self.visit_expr(*v)
            }
        }
        for arg in [node.vararg, node.kwarg].into_iter().flatten() {
            self.visit_arg(*arg)
        }
    }
    fn visit_arg(&mut self, node: ast::Arg) {
        if let Some(v) = node.annotation {
            self.visit_expr(*v)
        }
    }
    fn visit_keyword(&mut self, node: ast::Keyword) {
        self.visit_expr(node.value)
    }
    fn visit_comprehension(&mut self, node: ast::Comprehension) {
        self.visit_expr(node.target);
        self.visit_expr(node.iter);
        for v in node.ifs {
            self.visit_expr(v)
        }
    }
    fn visit_withitem(&mut self, node: ast::WithItem) {
        self.visit_expr(node.context_expr);
        if let Some(v) = node.optional_vars {
            self.visit_expr(*v)
        }
    }
    fn visit_match_case(&mut self, node: ast::MatchCase) {
        self.visit_pattern(node.pattern);
        if let Some(v) = node.guard {
            self.visit_expr(*v)
        }
        for v in node.body {
            self.visit_stmt(v)
        }
    }
}
fn inspect(request: Request) -> Result<(Value, usize, usize), String> {
    if request.version != 1 || request.kind != "NativePythonRetirementAstRequest" {
        return Err("python_ast_request_invalid".into());
    }
    let selected = profile(&request.profile)?;
    if request
        .source_path
        .as_ref()
        .is_some_and(|v| v.len() > 4096 || v.contains('\0'))
    {
        return Err("python_ast_context_path_budget".into());
    }
    if matches!(selected, Profile::Venue) && request.source_path.is_none() {
        return Err("python_ast_venue_context_path_missing".into());
    }
    let tokens = lexical_budget(&request.source)?;
    let tree = ast::Suite::parse(&request.source, "held-historical-source.py")
        .map_err(|_| "python_ast_syntax_refusal".to_owned())?;
    let public = tree
        .iter()
        .filter_map(|v| match v {
            ast::Stmt::FunctionDef(v) => Some(v.name.as_str().nfkc().collect::<String>()),
            ast::Stmt::AsyncFunctionDef(v) => Some(v.name.as_str().nfkc().collect::<String>()),
            ast::Stmt::ClassDef(v) => Some(v.name.as_str().nfkc().collect::<String>()),
            _ => None,
        })
        .filter(|n| !n.starts_with('_'))
        .collect::<Vec<_>>();
    let mut audit = Audit {
        profile: selected,
        nodes: 0,
        depth: 0,
        refused: false,
        imports: BTreeSet::new(),
        writes: BTreeSet::new(),
        processes: BTreeSet::new(),
    };
    for statement in tree {
        audit.visit_stmt(statement)
    }
    if audit.refused {
        return Err("python_ast_node_or_depth_budget".into());
    }
    let network = audit
        .imports
        .iter()
        .filter(|v| ["requests", "httpx", "urllib", "socket", "aiohttp"].contains(&v.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let mut output = match selected {
        Profile::Research => {
            json!({"public":public,"writes":audit.writes,"process_calls":audit.processes,"network_imports":network,"subprocess_import":audit.imports.contains("subprocess"),"sqlite_import":audit.imports.contains("sqlite3")})
        }
        _ => {
            json!({"public":public,"writes":audit.writes,"external_calls":audit.processes,"network_imports":network,"process_imports":audit.imports.iter().filter(|v|v.as_str()=="subprocess").collect::<Vec<_>>()})
        }
    };
    if matches!(selected, Profile::Venue) {
        output["path"] = json!(
            request
                .source_path
                .ok_or_else(|| "python_ast_venue_context_path_missing".to_owned())?
        );
    }
    Ok((output, tokens, audit.nodes))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BatchRequest {
    version: u16,
    kind: String,
    cases: Vec<Request>,
}
/// Machine-owned fixed limits; the request has no budget override fields.
pub fn python_ast_resource_limits_v1() -> Value {
    json!({"version":1,"profile":"immutable_245_python_ast_observation_v1","maximumRequestBytes":REQUEST_BYTES,"maximumOutputBytes":OUTPUT_BYTES,"maximumCases":CASE_COUNT,"maximumSourceFileBytes":SOURCE_BYTES,"maximumSourceAggregateBytes":REQUEST_BYTES,"maximumTokensPerSource":NODE_COUNT,"maximumCoreAstNodesPerSource":NODE_COUNT,"maximumLexerAndCoreAstDepth":DEPTH,"maximumExpressionSegmentTokens":512,"maximumAggregateTokensAndCoreAstNodes":AGGREGATE_AST_ITEMS,"maximumContextPathBytes":4096,"sourceExecutionAllowed":false,"productPythonDelegationAllowed":false})
}
/// Parse only already bounded data; the caller owns its held source/ELF and
/// process-group lifecycle. This function has no filesystem or Python runtime.
pub fn inspect_python_ast_worker_bytes_v1(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() > REQUEST_BYTES {
        return Err("python_ast_request_byte_budget".into());
    }
    let request: BatchRequest =
        serde_json::from_slice(bytes).map_err(|_| "python_ast_batch_json_refusal".to_owned())?;
    if request.version != 1
        || request.kind != "NativePythonRetirementAstBatchRequest"
        || request.cases.is_empty()
        || request.cases.len() > CASE_COUNT
    {
        return Err("python_ast_batch_identity_or_count".into());
    }
    let mut aggregate_bytes = 0_usize;
    let mut aggregate_tokens = 0_usize;
    let mut aggregate_nodes = 0_usize;
    let mut audits = Vec::new();
    for case in request.cases {
        aggregate_bytes = aggregate_bytes
            .checked_add(case.source.len())
            .filter(|v| *v <= REQUEST_BYTES)
            .ok_or_else(|| "python_ast_aggregate_source_budget".to_owned())?;
        let (audit, tokens, nodes) = inspect(case)?;
        aggregate_tokens = aggregate_tokens
            .checked_add(tokens)
            .filter(|v| *v <= AGGREGATE_AST_ITEMS)
            .ok_or_else(|| "python_ast_aggregate_token_budget".to_owned())?;
        aggregate_nodes = aggregate_nodes
            .checked_add(nodes)
            .filter(|v| *v <= AGGREGATE_AST_ITEMS)
            .ok_or_else(|| "python_ast_aggregate_node_budget".to_owned())?;
        audits.push(audit);
    }
    let result = json!({
        "version":1,
        "kind":"NativePythonRetirementAstBatchInspection",
        "parser":{"name":"rustpython-parser","version":"0.4.0","astVisitorVersion":"0.4.0"},
        "caseCount":audits.len(),
        "sourceBytes":aggregate_bytes,
        "visitedCoreAstNodeCount":aggregate_nodes,
        "lexicalTokenCount":aggregate_tokens,
        "audits":audits,
        "sourceExecuted":false,
        "productPythonDelegationPerformed":false,
        "fullRustProductImplementationClaimed":false
    });
    let mut output =
        serde_json::to_vec(&result).map_err(|_| "python_ast_output_encoding".to_owned())?;
    if output.len() >= OUTPUT_BYTES {
        return Err("python_ast_output_budget".into());
    }
    output.push(b'\n');
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn batch(source: &str, profile: &str, path: Option<&str>) -> Vec<u8> {
        serde_json::to_vec(&json!({"version":1,"kind":"NativePythonRetirementAstBatchRequest","cases":[{"version":1,"kind":"NativePythonRetirementAstRequest","profile":profile,"source":source,"sourcePath":path}]})).expect("encode fixed test input")
    }
    #[test]
    fn closed_worker_rejects_shape_syntax_encoding_depth_and_budgets() {
        for bytes in [
            b"".to_vec(),
            b"{}".to_vec(),
            b"\xff".to_vec(),
            batch("broken =", "build_package_v1", None),
            batch("x=1\0", "build_package_v1", None),
            batch("\u{feff}x=1", "build_package_v1", None),
            batch("x=1", "unqualified", None),
            batch(
                &("(".repeat(129) + "1" + &")".repeat(129)),
                "build_package_v1",
                None,
            ),
            batch(
                &("x=".to_owned() + &"1+".repeat(300) + "1"),
                "build_package_v1",
                None,
            ),
        ] {
            assert!(inspect_python_ast_worker_bytes_v1(&bytes).is_err());
        }
        let mut invalid: Value = serde_json::from_slice(&batch("x=1", "build_package_v1", None))
            .expect("decode fixture");
        invalid["callerAcceptedCaseCount"] = json!(245);
        assert!(
            inspect_python_ast_worker_bytes_v1(
                &serde_json::to_vec(&invalid).expect("encode invalid")
            )
            .is_err()
        );
        let oversized = vec![b' '; REQUEST_BYTES + 1];
        assert!(inspect_python_ast_worker_bytes_v1(&oversized).is_err());
        let too_many = json!({"version":1,"kind":"NativePythonRetirementAstBatchRequest","cases":vec![json!({"version":1,"kind":"NativePythonRetirementAstRequest","profile":"build_package_v1","source":"x=1"});257]});
        assert!(
            inspect_python_ast_worker_bytes_v1(
                &serde_json::to_vec(&too_many).expect("encode count refusal")
            )
            .is_err()
        );
    }
    #[test]
    fn actual_ast_walk_includes_defaults_keywords_comprehensions_and_match_guards() {
        let source = "import subprocess\n@open('decorator','w')\ndef public(a: subprocess.run()=open('default','a'), *, b=open('keyword','x')):\n with open('context','w') as f:\n  values=[subprocess.call() for x in range(1) if open('comprehension','a')]\n match values:\n  case [] if open('match','w'):\n   pass\n";
        let result: Value = serde_json::from_slice(
            &inspect_python_ast_worker_bytes_v1(&batch(source, "research_verify_v1", None))
                .expect("parse actual AST"),
        )
        .expect("decode actual AST");
        assert_eq!(result["audits"][0]["public"], json!(["public"]));
        assert_eq!(
            result["audits"][0]["writes"],
            json!(["open:a", "open:w", "open:x"])
        );
        assert_eq!(
            result["audits"][0]["process_calls"],
            json!(["subprocess.call", "subprocess.run"])
        );
        assert_eq!(result["sourceExecuted"], false);
        assert_eq!(result["productPythonDelegationPerformed"], false);
    }
    #[test]
    fn python_identifier_normalization_and_venue_context_are_observed_as_data() {
        let source = "import ｓｕｂｐｒｏｃｅｓｓ\ndef Kelvin():\n ｓｕｂｐｒｏｃｅｓｓ.run()\ndef _ｐｒｉｖａｔｅ():\n pass\nopen('file',ｍｏｄｅ='w')\n";
        let result: Value = serde_json::from_slice(
            &inspect_python_ast_worker_bytes_v1(&batch(
                source,
                "venue_resolve_v1",
                Some("/held/fixed-source.py"),
            ))
            .expect("parse identifiers"),
        )
        .expect("decode identifiers");
        assert_eq!(result["audits"][0]["public"], json!(["Kelvin"]));
        assert_eq!(
            result["audits"][0]["external_calls"],
            json!(["subprocess.run"])
        );
        assert_eq!(
            result["audits"][0]["process_imports"],
            json!(["subprocess"])
        );
        assert_eq!(result["audits"][0]["writes"], json!(["open:w"]));
        assert_eq!(result["audits"][0]["path"], "/held/fixed-source.py");
        assert!(
            inspect_python_ast_worker_bytes_v1(&batch("x=1", "venue_resolve_v1", None)).is_err()
        );
    }
}
