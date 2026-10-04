//! Actual ordinary nullary registry grammar. Product source, trust, effects,
//! cancellation, and recovery are validated independently by the normal owner.
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use hepta_paper_service::canonical_cli::resolve_canonical_cli_arguments_v1;
use serde::Deserialize;
use std::{collections::BTreeMap, path::PathBuf, sync::atomic::AtomicBool};
#[derive(Deserialize)]
struct Row {
    args: Vec<String>,
    normalized: Option<Vec<String>>,
    error: Option<String>,
}
#[derive(Deserialize)]
struct Oracle {
    rows: Vec<Row>,
}
#[test]
fn canonical_governance_nullary_grammar_matches_actual_node_before_source_io() {
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
    let script = r#"
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
assert.equal(process.version, 'v22.23.1');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const {COMMAND_REGISTRY_ROUTES: routes}=await import(pathToFileURL(path.join(input.root,'paper-core/src/command-registry-routes.mjs')));
const tokens=['--','--help','--unknown','','x','-','-h','--root','/tmp','--=x','--require-ok','--handoff','--foo=true'];
const tails=[[],['--'],...tokens.map(t=>[t]),...tokens.map(t=>['--',t]),...tokens.flatMap(a=>tokens.map(b=>['--',a,b]))];
const rows=[];
for(const [group,name,command] of [['verify','owner','ordinary-owner-acceptance-status'],['verify','operational','ordinary-operational-proof-status'],['retirement','reference','ordinary-retirement-reference']]) {
 const route=routes.find(row=>row.group===group&&row.name===name);
 assert.equal(route.forwardingPolicy,'none');
 for(const tail of tails) {
  const args=[group,name,...tail];
  if(tail.length===0 || (tail.length===1&&tail[0]==='--')) {
   rows.push({args,normalized:[command],error:null});continue;
  }
  const output=spawnSync(process.execPath,[path.join(input.root,'paper-core/bin/hepta-paper.mjs'),...args],
   {cwd:input.root,env:{PATH:process.env.PATH},shell:false,timeout:10000,encoding:'utf8',maxBuffer:1024*1024});
  assert.equal(output.error,undefined);assert.equal(output.signal,null);assert.equal(output.status,2,output.stderr);assert.equal(output.stdout,'');
  rows.push({args,normalized:null,error:JSON.parse(output.stderr).error});
 }
}
process.stdout.write(JSON.stringify({rows}));
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
            "canonical-governance-grammar-oracle-v1",
            ["PATH"],
            ["PATH"],
        )
        .unwrap()
        .build(std::env::vars_os(), &BTreeMap::new())
        .unwrap(),
        stdin: Some(serde_json::to_vec(&serde_json::json!({"root": root})).unwrap()),
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
    let oracle: Oracle = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(oracle.rows.len(), 591);
    for row in &oracle.rows {
        match (&row.normalized, &row.error) {
            (Some(expected), None) => assert_eq!(
                resolve_canonical_cli_arguments_v1(&row.args),
                Ok(Some(expected.clone())),
                "{:?}",
                row.args
            ),
            (None, Some(expected)) => assert_eq!(
                resolve_canonical_cli_arguments_v1(&row.args),
                Err(expected.clone()),
                "{:?}",
                row.args
            ),
            _ => panic!("invalid actual Node grammar row"),
        }
    }
    eprintln!(
        "591 actual owner/operational/reference registry grammar cases; source and authority not executed"
    );
}
