//! Registry syntax and argument normalization; product execution/authority are
//! tested separately. Incumbent Node flags do not mint a native admission.
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use hepta_paper_service::canonical_cli::resolve_canonical_cli_arguments_v1;
use serde::Deserialize;
use std::{collections::BTreeMap, path::PathBuf, sync::atomic::AtomicBool};

#[derive(Deserialize)]
struct GrammarRow {
    forwarded: Vec<String>,
    normalized: Option<Vec<String>>,
    error: Option<String>,
}
#[derive(Deserialize)]
struct ExtensionRow {
    forwarded: Vec<String>,
    incumbent_error: String,
    normalized: Vec<String>,
}
#[derive(Deserialize)]
struct GrammarOracle {
    rows: Vec<GrammarRow>,
    outer: Vec<GrammarRow>,
    extensions: Vec<ExtensionRow>,
}

#[test]
fn canonical_research_registry_grammar_matches_actual_node_without_business_effects() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let selected_node =
        PathBuf::from(std::env::var_os("HEPTA_TEST_NODE").unwrap_or_else(|| "node".into()));
    let node = if selected_node.components().count() == 1 {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|directory| directory.join(&selected_node))
            .find(|candidate| candidate.is_file())
            .expect("actual Node oracle must be available")
    } else {
        selected_node
    }
    .canonicalize()
    .unwrap();
    // Only these explicit versioned native workflow inputs extend the
    // incumbent grammar. Their acceptance here conveys no authority.
    let extensions = [
        "workflow-file",
        "workflow-root",
        "definition-hash",
        "amendment-file",
        "research-qualification-request",
        "through-steps",
        "expected-revision",
    ];
    let script = r#"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
assert.equal(process.version, 'v22.23.1');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const {COMMAND_REGISTRY_ROUTES: routes}
  = await import(pathToFileURL(path.join(input.root, 'paper-core/src/command-registry-routes.mjs')));
const {parseStrictCliArguments} = await import(pathToFileURL(path.join(input.root, 'paper-core/src/strict-cli-arguments.mjs')));
const schema = routes.find(row => row.group === 'operator' && row.name === 'autonomous-research').forwardedArgumentSchema;
assert.deepEqual(schema.repeatableValueFlags, [], 'incumbent repeatable syntax needs a corpus update');
const normalized = parsed => ['autonomous-research', ...Object.entries(parsed).filter(([key]) => key !== '_')
  .flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, value])];
function observation(forwarded) {
  try { return {forwarded, normalized: normalized(parseStrictCliArguments(forwarded, schema)), error: null}; }
  catch (error) { return {forwarded, normalized: null, error: error.message}; }
}
const cases = [[], ['--'], ['--help'], ['--help', '--'], ['x'], ['--bad'], ['--bad=1'], ['--=x'], ['--help='], ['--help=true'], ['--help', '--help']];
for (const key of schema.booleanFlags) cases.push([`--${key}`], [`--${key}=1`], [`--${key}=`], [`--${key}`, `--${key}`], [`--${key}`, 'x'], ['--', `--${key}`]);
for (const key of schema.valueFlags) cases.push([`--${key}`], [`--${key}`, ''], [`--${key}`, '--'], [`--${key}`, '--bad'], [`--${key}`, 'value'], [`--${key}`, '-h'], [`--${key}`, '-'], [`--${key}=value`], [`--${key}=`], [`--${key}=a=b`], [`--${key}`, 'a', `--${key}`, 'b'], [`--${key}=a`, `--${key}=b`], [`--${key}`, 'a', `--${key}`]);
cases.push(['--objective=论文 Δ 🧪'], ['--objective=--a=b'], ['--objective', 'line\nvalue'],
  [...schema.booleanFlags.map(key => `--${key}`), ...schema.valueFlags.flatMap(key => [`--${key}`, `value:${key}`])]);
const outer = [['--help'], ['x'], ['--paper-id', 'p']].map(forwarded => {
  const output = spawnSync(process.execPath, [path.join(input.root, 'paper-core/bin/hepta-paper.mjs'), 'operator', 'autonomous-research', ...forwarded],
    {cwd: input.root, env: {PATH: process.env.PATH}, shell: false, timeout: 10000, encoding: 'utf8', maxBuffer: 1024 * 1024});
  assert.equal(output.error, undefined); assert.equal(output.signal, null); assert.equal(output.status, 2);
  assert.equal(output.stdout, ''); return {forwarded, error: JSON.parse(output.stderr).error, normalized: null};
});
const extensions = input.extensions.map(key => {
  const forwarded = [`--${key}`, 'value']; const incumbent = observation(forwarded);
  assert.equal(incumbent.error, `unknown_cli_option:--${key}`);
  return {forwarded, incumbent_error: incumbent.error, normalized: ['autonomous-research', ...forwarded]};
});
process.stdout.write(JSON.stringify({rows: cases.map(observation), outer, extensions}));
"#;
    // Reuse the existing bounded process-group owner, including verified
    // cleanup. Oracle failures cannot leave an unbounded wait or allocation.
    let request = BoundedProcessRequestV1 {
        executable: node,
        arguments: ["--input-type=module", "--eval", script]
            .into_iter()
            .map(Into::into)
            .collect(),
        working_directory: root.clone(),
        environment: EnvironmentPolicyV1::new(
            "canonical-research-grammar-oracle-v1",
            ["PATH"],
            ["PATH"],
        )
        .unwrap()
        .build(std::env::vars_os(), &BTreeMap::new())
        .unwrap(),
        stdin: Some(
            serde_json::to_vec(&serde_json::json!({"root": root, "extensions": extensions}))
                .unwrap(),
        ),
    };
    let output = run_bounded_process_capturing_stdout_with_cancellation(
        &request,
        ProcessLimitsV1 {
            timeout_ms: 60_000,
            maximum_stdin_bytes: 64 * 1024,
            maximum_stdout_bytes: 1024 * 1024,
            maximum_stderr_bytes: 1024 * 1024,
            maximum_tail_bytes: 64 * 1024,
            ..ProcessLimitsV1::default()
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(
        output.process.termination_reason == ProcessTerminationReason::Exited
            && output.process.exit_code == Some(0)
            && output.process.signal.is_none()
            && output.process.process_group_cleanup_verified,
        "oracle process {:?}: {}",
        output.process,
        String::from_utf8_lossy(&output.process.stderr_tail)
    );
    let oracle: GrammarOracle = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        oracle.rows.len() >= 631,
        "actual registry coverage unexpectedly contracted"
    );
    for row in &oracle.rows {
        let args = [
            "operator".to_owned(),
            "autonomous-research".to_owned(),
            "--".to_owned(),
        ]
        .into_iter()
        .chain(row.forwarded.iter().cloned())
        .collect::<Vec<_>>();
        let actual = resolve_canonical_cli_arguments_v1(&args);
        match (&row.normalized, &row.error) {
            (Some(expected), None) => {
                assert_eq!(actual, Ok(Some(expected.clone())), "{:?}", row.forwarded)
            }
            (None, Some(expected)) => {
                assert_eq!(actual, Err(expected.clone()), "{:?}", row.forwarded)
            }
            _ => panic!("invalid actual Node oracle row"),
        }
    }
    for row in &oracle.outer {
        let args = ["operator".to_owned(), "autonomous-research".to_owned()]
            .into_iter()
            .chain(row.forwarded.iter().cloned())
            .collect::<Vec<_>>();
        assert_eq!(
            resolve_canonical_cli_arguments_v1(&args),
            Err(row.error.clone().unwrap())
        );
    }
    for row in &oracle.extensions {
        assert!(row.incumbent_error.starts_with("unknown_cli_option:--"));
        let args = [
            "operator".to_owned(),
            "autonomous-research".to_owned(),
            "--".to_owned(),
        ]
        .into_iter()
        .chain(row.forwarded.iter().cloned())
        .collect::<Vec<_>>();
        assert_eq!(
            resolve_canonical_cli_arguments_v1(&args),
            Ok(Some(row.normalized.clone()))
        );
    }
    eprintln!(
        "actual Node grammar {} incumbent cases, {} outer refusals, {} explicit native extensions; business/authority not executed",
        oracle.rows.len(),
        oracle.outer.len(),
        oracle.extensions.len()
    );
}
