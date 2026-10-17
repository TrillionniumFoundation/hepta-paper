use super::*;
use serde_json::json;
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};

#[test]
fn actual_original_node_declaration_values_match() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("cases.json")).unwrap();
    assert_eq!(cases.len(), 1536);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .unwrap()
        .to_owned();
    let original = root.join("paper-domain/research/empirical-assertion-contract.mjs");
    let node = std::env::var("HEPTA_TEST_NODE").expect("qualified Node required");
    let version = Command::new(&node).arg("--version").output().unwrap();
    assert!(version.status.success());
    assert_eq!(version.stdout, b"v22.23.1\n");
    let script = r#"
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const original=await import(pathToFileURL(process.argv[1]).href);
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
const observe=(f,v)=>{try{return {value:f(v)};}catch(e){return {error:e.name};}};
process.stdout.write(JSON.stringify(cases.map(({input})=>({assertion:observe(original.assertionMarkerDeclarationValid,input),presentation:observe(original.empiricalPresentationMarkerDeclarationValid,input)}))));
"#;
    let mut child = Command::new(&node)
        .args(["--input-type=module", "--eval", script])
        .arg(&original)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&cases).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.len() <= 1024 * 1024);
    let observed: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(observed.len(), cases.len());
    let cancelled = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut true_values = 0;
    let mut coercion_refusals = 0;
    for (index, (case, original)) in cases.iter().zip(&observed).enumerate() {
        let results = [
            assertion_marker_declaration_valid_v1(&case["input"], &cancelled, deadline),
            empirical_presentation_marker_declaration_valid_v1(
                &case["input"],
                &cancelled,
                deadline,
            ),
        ];
        for (name, result) in ["assertion", "presentation"].into_iter().zip(results) {
            if let Some(value) = original[name]["value"].as_bool() {
                assert_eq!(
                    result.as_ref().copied(),
                    Ok(value),
                    "case {index} {name}: {case}"
                );
                true_values += usize::from(value);
            } else {
                assert_eq!(original[name]["error"], "TypeError");
                assert_eq!(
                    result,
                    Err("native_empirical_marker_string_coercion_refused".into())
                );
                coercion_refusals += 1;
            }
        }
    }
    assert!(true_values > 20 && coercion_refusals > 0);
    println!(
        "actual_original_node_cases={} whole_values={} true_values={true_values} coercion_refusals={coercion_refusals}",
        cases.len(),
        cases.len() * 2
    );
}

#[test]
fn borrowed_budget_cancel_deadline_refuse_and_fresh_retry_matches() {
    let valid = json!({"version":1,"assertionId":"a:1","authorityEntryHash":format!("sha256:{}","a".repeat(64))});
    let cancelled = AtomicBool::new(true);
    let deadline = Instant::now() + Duration::from_secs(30);
    assert_eq!(
        assertion_marker_declaration_valid_v1(&valid, &cancelled, deadline),
        Err("native_empirical_marker_cancelled".into())
    );
    cancelled.store(false, Ordering::SeqCst);
    assert_eq!(
        assertion_marker_declaration_valid_v1(&valid, &cancelled, Instant::now()),
        Err("native_empirical_marker_deadline".into())
    );
    for invalid in [
        json!({"version":1,"assertionId":"a".repeat(64*1024+1),"authorityEntryHash":"x"}),
        json!({"version":1,"assertionId":vec![json!("a");1025],"authorityEntryHash":"x"}),
        json!({"version":1,"assertionId":"a\0","authorityEntryHash":"x"}),
    ] {
        assert!(assertion_marker_declaration_valid_v1(&invalid, &cancelled, deadline).is_err());
    }
    let mut nested = json!("a");
    for _ in 0..65 {
        nested = json!([nested]);
    }
    assert!(assertion_marker_declaration_valid_v1(&nested, &cancelled, deadline).is_err());
    assert_eq!(
        assertion_marker_declaration_valid_v1(&valid, &cancelled, deadline),
        Ok(true)
    );
    let figure = json!({"version":1,"surfaceId":"s:1","surfaceKind":"confirmatory_result_figure", "surfaceAuthorityEntryHash":format!("sha256:{}","A".repeat(64)),"artifactPath":["figures/..pdf"],"artifactHash":format!("SHA256:{}","B".repeat(64))});
    assert_eq!(
        empirical_presentation_marker_declaration_valid_v1(&figure, &cancelled, deadline),
        Ok(true)
    );
    assert_eq!(
        empirical_presentation_marker_declaration_valid_v1(&figure, &cancelled, Instant::now()),
        Err("native_empirical_marker_deadline".into())
    );
    assert_eq!(
        empirical_presentation_marker_declaration_valid_v1(&figure, &cancelled, deadline),
        Ok(true)
    );
}
