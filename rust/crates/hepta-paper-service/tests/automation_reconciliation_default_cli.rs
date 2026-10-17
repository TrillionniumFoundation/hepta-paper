//! Actual incumbent CLI parity for passive environment defaults and live clocks.
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const NOW: &str = "2026-08-01T05:00:00.000Z";
static NEXT: AtomicU64 = AtomicU64::new(0);
fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
struct Fixture {
    root: PathBuf,
    runtime: PathBuf,
    database: PathBuf,
}
impl Fixture {
    fn new(legacy: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-reconcile-default-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let runtime = root.join("hepta-paper-runtime/native-runtime");
        fs::create_dir_all(&runtime).unwrap();
        fs::create_dir(root.join("deployment")).unwrap();
        let database = runtime.join("hepta-paper.sqlite");
        let oracle = if legacy {
            "legacy-terminal-active-residue-v1.mjs"
        } else {
            "automation-runtime-reconciliation-v1.mjs"
        };
        let mut command = Command::new("node");
        command.arg(repo().join("rust/oracle").join(oracle)).args([
            "--database",
            database.to_str().unwrap(),
            "--at",
            NOW,
            "--prepare",
        ]);
        if legacy {
            command.arg("--prepare-only");
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        Self {
            root,
            runtime,
            database,
        }
    }
    fn native(&self, args: &[&str], runtime: Option<&str>) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_hepta-automation-reconcile"));
        command
            .current_dir(&self.root)
            .args(args)
            .env("HEPTA_PAPER_WORKSPACE_ROOT", "deployment")
            .env_remove("HEPTA_PAPER_RUNTIME_ROOT");
        if let Some(runtime) = runtime {
            command.env("HEPTA_PAPER_RUNTIME_ROOT", runtime);
        }
        command.output().unwrap()
    }
    fn original_cli(&self, args: &[&str], samples: &Value) -> Value {
        // Replay the observed business clock only. The actual Node entrypoint,
        // layout selection, store and planner remain the incumbent source.
        let preload = self.root.join("clock.mjs");
        fs::write(
            &preload,
            format!(
                r#"
if (process.versions.node !== '22.23.1') throw Error('pinned_node_required');
const RealDate = Date, businessSamples = {samples};
// The original CLI imports one immutable-bundle startup clock before planning.
const samples = [businessSamples[0], ...businessSamples]; let next = 0;
globalThis.Date = class extends RealDate {{
  constructor(...args) {{ super(...(args.length ? args : [samples[next++]])); }}
}};
process.on('exit', () => {{ if (next !== samples.length) process.exitCode = 19; }});
"#
            ),
        )
        .unwrap();
        let output = Command::new("node")
            .current_dir(&self.root)
            .arg("--import")
            .arg(preload)
            .arg(repo().join("paper-core/bin/automation-reconcile.mjs"))
            .args(args)
            .env(
                "HEPTA_PAPER_RUNTIME_ROOT",
                "hepta-paper-runtime/./native-runtime",
            )
            .env("HEPTA_PAPER_ASSET_ROOT", self.root.join("assets"))
            .output()
            .unwrap();
        report(output)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn report(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[test]
fn passive_default_environment_and_relocated_workspace_match_original_cli() {
    let f = Fixture::new(false);
    let expected = f.original_cli(&[], &json!([NOW, NOW]));
    let before = fs::read(&f.database).unwrap();
    for runtime in [
        None,
        Some(""),
        Some("hepta-paper-runtime/./native-runtime"),
        Some(f.runtime.to_str().unwrap()),
    ] {
        let actual = report(f.native(&["--at", NOW], runtime));
        assert_eq!(actual, expected, "runtime={runtime:?}");
        assert_eq!(fs::read(&f.database).unwrap(), before);
    }
    // An explicit database selects that store even when the environment points
    // to a missing runtime. Selection does not enroll or create either store.
    assert_eq!(
        report(f.native(
            &["--database", f.database.to_str().unwrap(), "--at", NOW],
            Some("missing")
        )),
        expected
    );
    assert!(!f.root.join("missing").exists());
}

#[test]
fn live_standard_and_legacy_default_plans_replay_exact_incumbent_clock_samples() {
    for legacy in [false, true] {
        let f = Fixture::new(legacy);
        let args = if legacy {
            vec![
                "--legacy-terminal-active-residue",
                "--campaign-id",
                "legacy-campaign",
            ]
        } else {
            vec![]
        };
        let before = fs::read(&f.database).unwrap();
        let started = now_ms();
        let actual = report(f.native(&args, Some("hepta-paper-runtime/native-runtime")));
        let finished = now_ms();
        let parse = hepta_paper_service::journal_connector_coverage::qualification::canonical_instant_millis;
        let planned = parse(actual["plannedAt"].as_str().unwrap()).unwrap();
        assert!((started..=finished).contains(&planned));
        let samples = if legacy {
            json!([planned])
        } else {
            let cutoff = parse(actual["noProgressCutoff"].as_str().unwrap()).unwrap();
            let cutoff_sample = cutoff + 1_800_000;
            assert!((started..=finished).contains(&cutoff_sample));
            json!([planned, cutoff_sample])
        };
        assert_eq!(actual, f.original_cli(&args, &samples));
        assert_eq!(fs::read(&f.database).unwrap(), before);
    }
}

#[test]
fn missing_default_and_unadmitted_execute_do_not_create_or_mutate_state() {
    let f = Fixture::new(false);
    let before = fs::read(&f.database).unwrap();
    let missing = f.native(&[], Some("missing-runtime"));
    assert_eq!(missing.status.code(), Some(2));
    assert!(!f.root.join("missing-runtime").exists());
    let rejected = f.native(&["--execute"], Some("hepta-paper-runtime/native-runtime"));
    assert_eq!(rejected.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("unsupported argument"));
    assert_eq!(fs::read(&f.database).unwrap(), before);
}

#[test]
fn legacy_live_plan_ignores_unused_nonfinite_threshold_like_explicit_clock() {
    let fixture = Fixture::new(true);
    let args = [
        "--legacy-terminal-active-residue",
        "--campaign-id",
        "legacy-campaign",
        "--no-progress-seconds",
        "NaN",
    ];
    let before = fs::read(&fixture.database).unwrap();
    let actual = report(fixture.native(&args, Some("hepta-paper-runtime/native-runtime")));
    let expected = fixture.original_cli(&args, &json!([actual["plannedAt"]]));
    assert_eq!(actual, expected);
    let explicit_args = args.into_iter().chain(["--at", NOW]).collect::<Vec<_>>();
    assert_eq!(
        report(fixture.native(&explicit_args, Some("hepta-paper-runtime/native-runtime"))),
        fixture.original_cli(&args, &json!([NOW])),
    );
    let absent = fixture.native(
        &["--legacy-terminal-active-residue"],
        Some("hepta-paper-runtime/native-runtime"),
    );
    assert_eq!(absent.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&absent.stderr)
            .contains("legacy_terminal_active_residue_campaign_id_invalid")
    );
    assert_eq!(fs::read(&fixture.database).unwrap(), before);
}
