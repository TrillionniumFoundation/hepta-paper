use super::*;
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};

fn original(cases: &[Vec<u8>]) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let script = r#"
import fs from 'node:fs';
import { extractFormalSupportSurfaces } from './paper-adapters/research-verify/formal-support-surface-reader.mjs';
import { extractEvidenceBoundManuscriptSurfaces } from './paper-adapters/research-verify/evidence-bound-manuscript-surface-reader.mjs';
import { hashBytes } from './workflow-kernel/record-hash.mjs';
const inputs = JSON.parse(fs.readFileSync(0,'utf8'));
const outputs = inputs.map(bytes => {
  const content = Buffer.from(bytes), read = {content,hash:hashBytes(content)};
  return [extractFormalSupportSurfaces({relative:'chapter/😀.tex',read,trustedAuthority:null}),
    extractEvidenceBoundManuscriptSurfaces({relative:'chapter/😀.tex',read,trustedManuscriptIr:null,trustedPriorArtReceipt:null})];
});
process.stdout.write(JSON.stringify({node:process.version,outputs}));
"#;
    let mut child =
        Command::new(std::env::var("HEPTA_TEST_NODE").unwrap_or_else(|_| "node".into()))
            .args(["--input-type=module", "--eval", script])
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(cases).unwrap())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.len() <= 8 * 1024 * 1024);
    let observed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(observed["node"], "v22.23.1");
    observed
}

#[test]
fn actual_original_node_null_authority_support_surfaces_match_complete_values() {
    let mut cases: Vec<Vec<u8>> = vec![
        b"".to_vec(),
        b"plain\r\nbody\n".to_vec(),
        "😀 before\n".as_bytes().to_vec(),
    ];
    for marker in ["HEPTA_FORMAL_SUPPORT", "HEPTA_EVIDENCE_BOUND_PROSE"] {
        for body in [
            format!("% {marker}_BEGIN {{}}\ntext\n% {marker}_END A\n"),
            format!("% {marker}_BEGIN {{not-json}}\n% {marker}_BEGIN {{}}\n% {marker}_END A"),
            format!("prefix {marker}_BEGIN {{}}\r\n{marker}_END A"),
            format!("% {marker}_BEGIN {{\"version\":1,\"blockId\":\"A\"}}\n% {marker}_END A"),
            format!("% {marker}_BEGIN {{\"toString\":[]}}\n% {marker}_END A"),
            format!("% {marker}_BEGIN {{}} x\n% {marker}_END A x\n"),
            format!("% {marker}_END {}\n", "A".repeat(192)),
            format!("% {marker}_END {}\n", "A".repeat(193)),
            format!("% {marker}_END _bad\n% {marker}_END A_.:-\n"),
            format!("% {marker}_BEGIN \n{{}}\n% {marker}_END A\r"),
            format!("% {}_BEGIN {{}}\n", marker.to_ascii_lowercase()),
            format!("% {marker}_BEGIN {{\r}}\n% {marker}_END A"),
        ] {
            cases.push(body.into_bytes());
        }
        for byte in 0_u8..=255 {
            let begin = format!("% {marker}_BEGIN {{}}").into_bytes();
            let end = format!("% {marker}_END A").into_bytes();
            for mut line in [begin.clone(), end.clone()] {
                line.insert(0, byte);
                cases.push(line);
            }
            for mut line in [begin.clone(), end.clone()] {
                line.push(byte);
                cases.push(line);
            }
            let mut line = format!("% {marker}_BEGIN").into_bytes();
            line.push(byte);
            line.extend_from_slice(b"{}");
            cases.push(line);
            let mut line = format!("% {marker}_END").into_bytes();
            line.push(byte);
            line.extend_from_slice(b"A");
            cases.push(line);
        }
    }
    assert_eq!(cases.len(), 3099);
    let expected = original(&cases);
    let cancelled = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(30);
    for (i, content) in cases.iter().enumerate() {
        let formal = extract_formal_support_surfaces_without_authority_v1(
            "chapter/😀.tex",
            content,
            &cancelled,
            deadline,
        )
        .unwrap();
        let evidence = extract_evidence_bound_surfaces_without_ir_v1(
            "chapter/😀.tex",
            content,
            &cancelled,
            deadline,
        )
        .unwrap();
        assert_eq!(
            json!([formal, evidence]),
            expected["outputs"][i],
            "actual original case {i}"
        );
    }
    println!(
        "actual_original_node_null_support_inputs={} complete_value_slots={}",
        cases.len(),
        cases.len() * 2
    );
}

#[test]
fn actual_null_support_bounds_cancel_deadline_and_fresh_retry_preserve_domain() {
    let c = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(30);
    let inspect = |relative: &str, bytes: &[u8]| {
        extract_formal_support_surfaces_without_authority_v1(relative, bytes, &c, deadline)
    };
    assert!(inspect("m.tex", &vec![b'x'; 1024 * 1024 + 1]).is_err());
    assert!(inspect(&"p".repeat(4097), b"body").is_err());
    assert!(inspect("nul\0.tex", b"body").is_err());
    assert!(inspect("m.tex", &b"\n".repeat(65536)).is_err());
    assert!(inspect("m.tex", &b"HEPTA_FORMAL_SUPPORT_BEGIN\n".repeat(1025)).is_err());
    assert!(
        inspect(
            &"p".repeat(4096),
            &b"HEPTA_FORMAL_SUPPORT_BEGIN\n".repeat(300)
        )
        .is_err()
    );
    c.store(true, Ordering::SeqCst);
    assert!(extract_evidence_bound_surfaces_without_ir_v1("m.tex", b"body", &c, deadline).is_err());
    c.store(false, Ordering::SeqCst);
    assert!(
        extract_formal_support_surfaces_without_authority_v1("m.tex", b"body", &c, Instant::now())
            .is_err()
    );
    assert_eq!(
        inspect("m.tex", b"body").unwrap(),
        json!({"formalSupports":[],"blockers":[]})
    );
    assert_eq!(
        extract_evidence_bound_surfaces_without_ir_v1("m.tex", b"body", &c, deadline).unwrap(),
        json!({"surfaces":[],"blockers":[]})
    );
}
