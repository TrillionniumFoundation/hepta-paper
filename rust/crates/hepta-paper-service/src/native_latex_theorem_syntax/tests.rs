use super::*;
#[test]
fn actual_parser_shared_budget_cancel_deadline_refuse_and_fresh_retry_matches() {
    let source = r"\newtheorem{result}{Result}\begin{result}x\end{result}\begin{proof}q\end{proof}";
    let cancelled = AtomicBool::new(false);
    let work = LatexSyntaxControlV1::new(&cancelled, Instant::now() + Duration::from_secs(30));
    let value = analyze_latex_theorem_environments_with_control_v1(source, &work).unwrap();
    assert_eq!(value.theorem_statement_count, 1);
    assert_eq!(value.proof_environment_count, 1);
    assert!(value.blockers.is_empty());
    assert!(value.theorem_proof_pairing_blockers.is_empty());
    let expired = LatexSyntaxControlV1::new(&cancelled, Instant::now());
    assert!(
        parse_new_theorem_declarations_with_control_v1(source, &expired)
            .unwrap_err()
            .ends_with("deadline_exceeded")
    );
    let budget = LatexSyntaxControlV1::new(&cancelled, Instant::now() + Duration::from_secs(30));
    budget.remaining_work.set(1);
    assert!(
        analyze_latex_theorem_environments_with_control_v1(source, &budget)
            .unwrap_err()
            .ends_with("work_budget_exceeded")
    );
    assert!(
        mask_latex_comments_with_control_v1("", &budget)
            .unwrap_err()
            .ends_with("work_budget_exceeded")
    );
    let matches = LatexSyntaxControlV1::new(&cancelled, Instant::now() + Duration::from_secs(30));
    matches.remaining_matches.set(1);
    assert!(
        analyze_latex_theorem_environments_with_control_v1(source, &matches)
            .unwrap_err()
            .ends_with("match_budget_exceeded")
    );
    let cancelled_during_actual_parse =
        LatexSyntaxControlV1::new(&cancelled, Instant::now() + Duration::from_secs(30));
    cancelled_during_actual_parse.checkpoint.set(Some(|owner| {
        if owner.remaining_work.get() < 256 * 1024 * 1024 - 128 {
            owner.cancelled.store(true, Ordering::Release);
        }
    }));
    assert!(
        analyze_latex_theorem_environments_with_control_v1(source, &cancelled_during_actual_parse)
            .unwrap_err()
            .ends_with("cancelled")
    );
    cancelled.store(false, Ordering::Release);
    assert!(
        parse_new_theorem_declarations_with_control_v1(source, &cancelled_during_actual_parse)
            .unwrap_err()
            .ends_with("cancelled")
    );
    let retry = LatexSyntaxControlV1::new(&cancelled, Instant::now() + Duration::from_secs(30));
    assert_eq!(
        analyze_latex_theorem_environments_with_control_v1(source, &retry).unwrap(),
        value
    );
    assert!(
        analyze_latex_theorem_environments(&"x".repeat(8 * 1024 * 1024 + 1))
            .unwrap_err()
            .ends_with("input_budget_exceeded")
    );
}

#[test]
fn actual_original_node_four_syntax_values_and_utf16_offsets_match() {
    use serde_json::{Value, json};
    use std::{
        io::Write,
        path::Path,
        process::{Command, Stdio},
    };
    let input = include_bytes!("../../../../oracle/latex-theorem-syntax.v1.cases.json");
    let cases: Vec<Value> = serde_json::from_slice(input).unwrap();
    assert_eq!(cases.len(), 937);
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let original = root.join("paper-domain/quality/latex-theorem-environment-syntax.mjs");
    let driver = format!(
        "import fs from 'node:fs';import {{pathToFileURL}} from 'node:url';const m=await import(pathToFileURL({}).href);const cases=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(cases.map(c=>({{mask:m.maskLatexComments(c.source),macros:m.analyzeTheoremEnvironmentMacroDefinitions(c.source,{{theoremEnvironments:c.theoremEnvironments}}),declarations:m.parseNewTheoremDeclarations(c.source),complete:m.analyzeLatexTheoremEnvironments(c.source)}}))));",
        serde_json::to_string(&original.to_str().unwrap()).unwrap()
    );
    let node = std::env::var_os("HEPTA_TEST_NODE").unwrap_or_else(|| "node".into());
    let mut child = Command::new(node)
        .args(["--input-type=module", "--eval", &driver])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let original: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(original.len(), cases.len());
    for (index, (case, expected)) in cases.iter().zip(original).enumerate() {
        let source = case["source"].as_str().unwrap();
        let extra: Vec<String> = case["theoremEnvironments"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().into())
            .collect();
        let observed = json!({
            "mask":mask_latex_comments(source).unwrap(),
            "macros":analyze_theorem_environment_macro_definitions(source,&extra).unwrap(),
            "declarations":parse_new_theorem_declarations(source).unwrap(),
            "complete":analyze_latex_theorem_environments(source).unwrap(),
        });
        assert_eq!(observed, expected, "case {index}: {source:?}");
    }
    eprintln!(
        "{}",
        json!({"kind":"NativeActualOriginalLatexTheoremSyntaxDifferential","caseCount":cases.len(),"originalNodeExecuted":true,"wholeFourFunctionValuesMatched":true,"utf16OffsetsMatched":true,"academicEvidenceEligible":false,"authorityGranted":false})
    );
}
