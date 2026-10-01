//! Budget normalization oracle only. Durable execution, refusal and interruption
//! are independently exercised through the ordinary frontend in route tests.
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use hepta_paper_service::autonomous_research::parse_autonomous_research_arguments;
use serde::Deserialize;
use std::{collections::BTreeMap, path::PathBuf, sync::atomic::AtomicBool};

#[derive(Deserialize)]
struct Row {
    cost: String,
    wall: String,
    units: Option<[f64; 2]>,
    error: Option<String>,
}

#[test]
fn actual_node_budget_policy_matches_native_whole_units_and_preserves_precision_refusals() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let selected =
        PathBuf::from(std::env::var_os("HEPTA_TEST_NODE").unwrap_or_else(|| "node".into()));
    let node = if selected.components().count() == 1 {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|directory| directory.join(&selected))
            .find(|candidate| candidate.is_file())
            .expect("qualified actual Node required")
    } else {
        selected
    }
    .canonicalize()
    .unwrap();
    let cases = [
        "0",
        "-0",
        "1",
        "100",
        "101",
        "100000000",
        "1e300",
        "0.00008",
        "0.000081",
        "0.000001",
        "0.000059",
        "0.000123",
        "0.000249",
        "0.00008000000000000001",
        "8e-5",
        "0.0000015",
        "1.5",
        "3e5",
        "7200000",
        "7200001",
        "0x10",
        "0XFF",
        "0x10000000000000000",
        "0xffffffffffffffffffffffffffffffff",
        "0b10000000000000000000000000000000000000000000000000000000000000000",
        "0o2000000000000000000000",
        "0x1p0",
        "0b10",
        "0o10",
        "  80  ",
        "\u{FEFF}80\u{FEFF}",
        "\u{0085}80",
        "-1",
        "NaN",
        "Infinity",
        "+Infinity",
        "-Infinity",
        "inf",
        "1e400",
        "0x",
        "3.0",
        ".5",
        "1_000",
        "true",
        "0b2",
        "",
        " ",
    ];
    let rows: Vec<_> = cases
        .iter()
        .flat_map(|value| {
            [
                (value.to_string(), "300000".to_owned()),
                ("0.00008".to_owned(), value.to_string()),
            ]
        })
        .collect();
    let script = r#"
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {evaluateAutonomousResearchLaunchModeGate} from './paper-domain/automation/autonomous-research-launch-mode-policy.mjs';
assert.equal(process.version,'v22.23.1');
for (const text of ['0.000123','0.000249']) {
 const usd=Number(text), scaled=usd*1000000, micros=Math.round(scaled);
 assert.equal(Number.isInteger(scaled),false,'actual scaled binary tail');
 assert.equal(usd,micros/1000000,'exact incumbent Number round trip');
}
const rows=JSON.parse(fs.readFileSync(0,'utf8')).map(([cost,wall])=>{
 try {
  const gate=evaluateAutonomousResearchLaunchModeGate({launchMode:'golden-bootstrap',action:'prepare',localOnly:true,budgets:{maxCostUsd:Number(cost),maxWallTimeMs:Number(wall)}});
  const usd=gate.effectiveBudgets.maxCostUsd, scaled=usd*1000000, micros=Math.round(scaled);
  // The existing durable owner represents whole microUSD. Only an exact
  // inverse Number round trip belongs to that domain; 1.5 microUSD stays
  // an explicit precision refusal rather than a rounded permission.
  return {cost,wall,units:[usd===micros/1000000?micros:scaled,gate.effectiveBudgets.maxWallTimeMs],error:null};
 } catch(error) {return {cost,wall,units:null,error:error.message};}
});
process.stdout.write(JSON.stringify(rows));
"#;
    let request = BoundedProcessRequestV1 {
        executable: node,
        arguments: ["--input-type=module", "--eval", script]
            .into_iter()
            .map(Into::into)
            .collect(),
        working_directory: root,
        environment: EnvironmentPolicyV1::new(
            "autonomous-research-budget-oracle-v1",
            ["PATH"],
            ["PATH"],
        )
        .unwrap()
        .build(std::env::vars_os(), &BTreeMap::new())
        .unwrap(),
        stdin: Some(serde_json::to_vec(&rows).unwrap()),
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
        "{:?}: {}",
        output.process,
        String::from_utf8_lossy(&output.process.stderr_tail)
    );
    let oracle: Vec<Row> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(oracle.len(), rows.len());
    for row in oracle {
        // Empty strict CLI values are rejected by the normal registry before
        // business semantics; whitespace is a genuine nonempty Node Number(0).
        let args: Vec<_> = [
            "--paper-id",
            "p",
            "--max-cost-usd",
            &row.cost,
            "--max-wall-ms",
            &row.wall,
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        let native = parse_autonomous_research_arguments(&args);
        match (row.units, row.error) {
            (Some(units), None) if units.iter().all(|n| n.fract() == 0.0) => {
                let actual = native.unwrap_or_else(|error| panic!("{:?}: {error}", args));
                assert_eq!(actual.maximum_cost_microusd, Some(units[0] as u64));
                assert_eq!(actual.maximum_wall_ms, Some(units[1] as u64));
            }
            (Some(_), None) => assert!(
                native
                    .unwrap_err()
                    .contains("fractional_unit_not_supported")
            ),
            (None, Some(error)) => assert_eq!(native.unwrap_err(), error),
            _ => panic!("invalid actual budget oracle shape"),
        }
    }
    // Incumbent help returns before numeric business validation.
    let help: Vec<_> = [
        "--help",
        "--max-cost-usd",
        "NaN",
        "--max-wall-ms",
        "Infinity",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    assert!(parse_autonomous_research_arguments(&help).unwrap().help);
}
