//! Actual original profile/offline repository/status comparisons on owned files.
//! Recorded capability fixtures do not prove provider execution or live authority.
#[allow(dead_code)]
mod machine_intake_support;
use hepta_paper_service::{
    topic_producer_profile::TopicProducerProfileReadOptionsV1,
    topic_producer_status::{
        TopicProducerStatusOptionsV1,
        inspect_autonomous_research_topic_producer_status_v1 as inspect,
    },
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read},
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        process::ExitStatusExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
const NOW: &str = "2026-09-22T00:00:00.000Z";
const SCOPE: &str = "owned_actual_topic_status_and_offline_repository_no_provider_execution_or_authority_acceptance";
const META: &str = "autonomous_research_topic_producer_metadata";
const GEN: &str = "autonomous_research_topic_producer_generation";
const DAILY: &str = "autonomous_research_topic_producer_daily_budget";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
    repository: PathBuf,
    profile: PathBuf,
    datasets: PathBuf,
    runtime: PathBuf,
    database: PathBuf,
    environment: BTreeMap<String, String>,
    setup: Value,
    baseline: Vec<u8>,
}
impl Fixture {
    fn new(scenario: &str) -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "hepta-topic-status-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            root.join(".owned-topic-profile-fixture"),
            "owned topic profile fixture\n",
        )
        .unwrap();
        let mut f = Self {
            profile: root.join("profile.json"),
            datasets: root.join("datasets"),
            runtime: root.join("runtime"),
            database: root.join("runtime/autonomous-research/topic-producer/topic-producer.sqlite"),
            repository: Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../..")
                .canonicalize()
                .unwrap(),
            environment: BTreeMap::new(),
            setup: Value::Null,
            baseline: vec![],
            root,
        };
        let profile = f.invoke(
            "topic-producer-profile-v1.mjs",
            json!({"action":"setup","layout":"file"}),
        );
        assert_eq!(profile["value"]["expected"]["ok"], true);
        f.setup = f.oracle(json!({"action":"setup","scenario":scenario}))["value"].clone();
        assert_eq!(f.setup["callbackCount"], 0);
        assert_eq!(f.setup["evidenceScope"], SCOPE);
        f.baseline = fs::read(&f.database).unwrap();
        f
    }
    fn command(&self, script: &str, mut input: Value) -> Command {
        input["root"] = json!(self.root);
        let encoded = input.to_string();
        assert!(encoded.len() < 96 * 1024);
        let mut c = Command::new("node");
        c.arg(self.repository.join("rust/oracle").join(script))
            .arg(encoded)
            .current_dir(&self.root)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("LANG", "en_US.UTF-8");
        c
    }
    fn invoke(&self, script: &str, input: Value) -> Value {
        let output = machine_intake_support::run(&mut self.command(script, input));
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let v: Value = serde_json::from_slice(&output.stdout).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&v["profile"]).unwrap();
        v
    }
    fn oracle(&self, input: Value) -> Value {
        let mut v = self.invoke("topic-producer-status-v1.mjs", input);
        assert_eq!(v["evidenceScope"], SCOPE);
        v.as_object_mut().unwrap().remove("profile");
        v.as_object_mut().unwrap().remove("evidenceScope");
        v
    }
    fn native(&self, now: &str, configuration: &str) -> Value {
        let before = snapshot(&self.root);
        let options = TopicProducerStatusOptionsV1 {
            runtime_root: &self.runtime,
            profile: TopicProducerProfileReadOptionsV1 {
                profile_path: Some(&self.profile),
                dataset_root: Some(&self.datasets),
                repository_root: &self.repository,
                working_directory: &self.root,
                environment: &self.environment,
                expected_profile_hash: None,
                expected_provider_configuration_hash: None,
            },
            expected_machine_intake_configuration_hash: configuration,
            now,
        };
        let actual = match inspect(&options) {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(e) => json!({"ok":false,"error":e.code()}),
        };
        assert_eq!(
            snapshot(&self.root),
            before,
            "native reader must preserve every source byte and mutation metadata"
        );
        actual
    }
    fn compare(&self, now: &str) -> Value {
        self.compare_configuration(now, self.setup["configurationHash"].as_str().unwrap())
    }
    fn compare_configuration(&self, now: &str, configuration: &str) -> Value {
        let expected =
            self.oracle(json!({"action":"inspect","now":now,"configurationHash":configuration}));
        let actual = self.native(now, configuration);
        assert_eq!(actual, expected, "complete actual status/error at {now}");
        actual["value"].clone()
    }
    fn sql(&self, sql: &str) {
        let db = Connection::open(&self.database).unwrap();
        db.execute_batch(sql).unwrap();
        db.close().unwrap();
    }
    fn update(&self, table: &str, column: &str, value: Option<&str>) {
        let db = Connection::open(&self.database).unwrap();
        db.execute(&format!("UPDATE {table} SET {column}=?1"), [value])
            .unwrap();
        db.close().unwrap();
    }
    fn reset(&self) {
        for suffix in ["wal", "shm", "journal"] {
            assert!(!self.sidecar(suffix).exists());
        }
        fs::write(&self.database, &self.baseline).unwrap();
    }
    fn sidecar(&self, suffix: &str) -> PathBuf {
        PathBuf::from(format!("{}-{suffix}", self.database.display()))
    }
    fn capability(&self) -> Value {
        let v = self.oracle(json!({"action":"recorded-capability"}));
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["value"]["recordedCanaryClaimsOnly"], true);
        assert_eq!(v["value"]["providerCalls"], 0);
        v["value"]["capability"].clone()
    }
    fn store_capability(&self, sequence: i64, value: &Value) {
        let db = Connection::open(&self.database).unwrap();
        db.execute(&format!("UPDATE {GEN} SET status='authorized',capability_json=?1,capability_hash=?2,capability_nonce=?3 WHERE generation_sequence=?4"),params![value.to_string(),value["autonomousResearchTopicProducerCapabilityReceiptHash"].as_str(),value["capabilityNonce"].as_str(),sequence]).unwrap();
        db.close().unwrap();
    }
    fn insert_plan(&self, sequence: i64) {
        let result = self.oracle(json!({"action":"planned","sequence":sequence}));
        assert_eq!(result["ok"], true, "{result}");
        let p = &result["value"];
        let db = Connection::open(&self.database).unwrap();
        db.execute(&format!("INSERT INTO {GEN} (generation_sequence,status,lease_generation,producer_topic_id,topic_fingerprint,canonical_research_topic_hash,budget_reservation_id,budget_epoch_start,planned_generation_hash,planned_generation_json,created_at,updated_at) VALUES (?1,'planned',1,?2,?3,?4,?5,?6,?7,?8,?9,?9)"),params![sequence,p["producerTopicId"].as_str(),p["topicFingerprint"].as_str(),p["canonicalResearchTopicHash"].as_str(),p["budgetReservationId"].as_str(),p["budgetEpochStart"].as_str(),p["plannedGenerationHash"].as_str(),p.to_string(),NOW]).unwrap();
        db.execute(
            &format!("UPDATE {META} SET generation_high_watermark=?1"),
            [sequence],
        )
        .unwrap();
        db.close().unwrap();
    }
    fn blocker(&self, code: &str) {
        let v = self.native(NOW, self.setup["configurationHash"].as_str().unwrap());
        assert_eq!(v["ok"], true);
        assert_eq!(v["value"]["ready"], false);
        assert_eq!(v["value"]["blocker"], code, "{v}");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn snapshot(root: &Path) -> Vec<Value> {
    fn visit(path: &Path, rows: &mut Vec<Value>) {
        let m = fs::symlink_metadata(path).unwrap();
        let bytes = if m.is_file() {
            json!(hex::encode(Sha256::digest(fs::read(path).unwrap())))
        } else if m.file_type().is_symlink() {
            json!(fs::read_link(path).unwrap())
        } else {
            Value::Null
        };
        rows.push(json!({"path":path,"dev":m.dev(),"ino":m.ino(),"uid":m.uid(),"gid":m.gid(),"nlink":m.nlink(),"mode":m.mode(),"size":m.size(),"mtime":m.mtime(),"mtimeNs":m.mtime_nsec(),"ctime":m.ctime(),"ctimeNs":m.ctime_nsec(),"bytes":bytes}));
        if m.is_dir() {
            let mut paths = fs::read_dir(path)
                .unwrap()
                .map(|p| p.unwrap().path())
                .collect::<Vec<_>>();
            paths.sort();
            for p in paths {
                visit(&p, rows);
            }
        }
    }
    let mut rows = Vec::new();
    visit(root, &mut rows);
    rows
}
#[test]
fn actual_offline_lifecycle_and_absent_lease_preserve_standalone_readiness() {
    for scenario in ["empty", "lease", "planned"] {
        let f = Fixture::new(scenario);
        let v = f.compare(NOW);
        assert_eq!(v, f.setup["expected"]);
        assert_eq!(v["ready"], scenario != "empty");
        assert_eq!(v["currentlyProducible"], false);
        if scenario == "planned" {
            f.sql("DELETE FROM autonomous_research_topic_producer_lease");
            assert_eq!(f.compare(NOW), v, "no invented lease gate");
        }
    }
}
#[test]
fn metadata_bindings_high_watermark_and_exact_clock_boundaries_match() {
    let f = Fixture::new("planned");
    for key in [
        "machine_intake_configuration_hash",
        "producer_profile_hash",
        "provider_configuration_hash",
        "implementation_sha256",
    ] {
        f.update(
            META,
            key,
            Some("sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
        );
        assert_eq!(
            f.compare(NOW)["blocker"],
            "autonomous_research_topic_producer_authority_mismatch"
        );
        f.reset();
    }
    assert_eq!(
        f.compare_configuration(NOW, "sha256:wrong")["blocker"],
        "autonomous_research_topic_producer_authority_mismatch"
    );
    f.sql(&format!("UPDATE {META} SET generation_high_watermark=2"));
    assert_eq!(
        f.compare(NOW)["blocker"],
        "autonomous_research_topic_producer_high_watermark_invalid"
    );
    f.reset();
    for (now, live, monotonic) in [
        ("2026-09-22T00:14:59.999Z", true, true),
        ("2026-09-22T00:15:00.000Z", false, true),
        ("2026-09-21T23:59:59.999Z", false, false),
    ] {
        let v = f.compare(now);
        assert_eq!(v["live"], live);
        assert_eq!(v["clockMonotonic"], monotonic);
    }
    for value in [None, Some("")] {
        f.update(META, "last_observed_at", value);
        let v = f.compare(NOW);
        assert_eq!(v["live"], false);
        assert_eq!(v["clockMonotonic"], true);
        assert_eq!(v["lastObservedAt"], Value::Null);
    }
}
#[test]
fn daily_limits_utc_epoch_rate_and_retry_boundaries_match() {
    let f = Fixture::new("planned");
    for (column, limit, field) in [
        (
            "provider_canary_attempt_count",
            4.0,
            "canaryBudgetAvailable",
        ),
        (
            "provider_canary_reserved_cost_usd",
            1.0,
            "canaryBudgetAvailable",
        ),
        ("produced_topic_count", 2.0, "topicBudgetAvailable"),
    ] {
        for (number, expected) in [(limit - 1.0, true), (limit, false), (limit + 1.0, false)] {
            f.reset();
            f.sql(&format!("UPDATE {DAILY} SET {column}={number}"));
            assert_eq!(f.compare(NOW)[field], expected, "{column}={number}");
        }
    }
    f.reset();
    f.sql(&format!("UPDATE {DAILY} SET produced_topic_count=2"));
    assert_eq!(
        f.compare("2026-09-23T00:00:00.000Z")["topicBudgetAvailable"],
        true
    );
    f.reset();
    f.update(META, "last_produced_at", Some(NOW));
    f.update(META, "next_attempt_at", Some("2026-09-22T01:00:00.000Z"));
    for (now, eligible) in [
        ("2026-09-22T00:59:59.999Z", false),
        ("2026-09-22T01:00:00.000Z", true),
    ] {
        let v = f.compare(now);
        assert_eq!(v["rateEligible"], eligible);
        assert_eq!(v["retryEligible"], eligible);
    }
    for epoch in [
        "1969-12-31T23:59:59.999Z",
        "-000001-12-31T23:59:59.999Z",
        "+010000-01-01T00:00:00.000Z",
    ] {
        f.reset();
        f.update(META, "last_observed_at", Some(epoch));
        assert_eq!(f.compare(epoch)["live"], true);
    }
}
#[test]
fn all_history_is_checked_and_sequence_gaps_are_allowed() {
    let f = Fixture::new("planned");
    f.insert_plan(3);
    assert_eq!(f.compare(NOW)["generationHighWatermark"], 3);
    f.sql(&format!("DELETE FROM {GEN} WHERE generation_sequence=1"));
    assert_eq!(f.compare(NOW)["ready"], true);
    f.reset();
    f.insert_plan(2);
    let cap = f.capability();
    f.store_capability(2, &cap);
    assert_eq!(f.compare(NOW)["latestCapabilityFresh"], true);
    f.sql(&format!(
        "UPDATE {GEN} SET planned_generation_hash='sha256:bad' WHERE generation_sequence=1"
    ));
    assert_eq!(
        f.compare(NOW)["blocker"],
        "autonomous_research_topic_producer_state_invalid"
    );
    f.reset();
    f.sql(&format!("UPDATE {GEN} SET status='failed',provider_canary_attempt_started=1,error='owned-recorded-failure'"));
    assert_eq!(
        f.compare(NOW)["blocker"],
        "autonomous_research_topic_producer_state_invalid"
    );
}
#[test]
fn full_capability_expiry_binding_rebuild_and_newest_nonnull_selection_match() {
    let f = Fixture::new("planned");
    let cap = f.capability();
    f.store_capability(1, &cap);
    let v = f.compare(NOW);
    assert_eq!(v["currentlyProducible"], true);
    assert_eq!(v["providerMutationRequiresNewLiveCanary"], true);
    f.update(META, "last_observed_at", Some("2026-09-22T00:15:00.000Z"));
    let v = f.compare("2026-09-22T00:15:00.000Z");
    assert_eq!(v["ready"], true);
    assert_eq!(v["latestCapabilityFresh"], false);
    for field in [
        "producerProfileHash",
        "machineIntakeConfigurationHash",
        "implementationSha256",
        "topicFingerprint",
        "plannedGenerationHash",
    ] {
        f.reset();
        let mut invalid = cap.clone();
        invalid[field] =
            json!("sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
        let rehashed=f.oracle(json!({"action":"rehash","domain":"AutonomousResearchTopicProducerCapabilityReceipt","field":"autonomousResearchTopicProducerCapabilityReceiptHash","value":invalid}));
        assert_eq!(rehashed["ok"], true);
        f.store_capability(1, &rehashed["value"]);
        let v = f.compare(NOW);
        assert_eq!(v["ready"], true);
        assert_eq!(
            v["latestCapabilityFresh"], false,
            "rehashed binding {field}"
        );
    }
    f.reset();
    f.store_capability(1, &cap);
    f.insert_plan(2);
    assert_eq!(
        f.compare(NOW)["latestCapabilityFresh"],
        true,
        "skip new null capability"
    );
    let mut newer = f.capability();
    newer["capabilityNonce"] = json!("producer-nonce:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    newer["autonomousResearchTopicProducerCapabilityReceiptHash"] =
        json!("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    f.store_capability(2, &newer);
    assert_eq!(
        f.compare(NOW)["latestCapabilityFresh"],
        false,
        "no fallback to older capability"
    );
}
#[test]
fn actual_dataset_drift_precedes_database_diagnostics_and_leaf_checks_match() {
    let f = Fixture::new("planned");
    fs::write(f.datasets.join("data-0.txt"), "actual owned dataset drift").unwrap();
    let expected = f.oracle(json!({"action":"inspect"}));
    assert_eq!(expected["ok"], false);
    assert_eq!(
        f.native(NOW, f.setup["configurationHash"].as_str().unwrap()),
        expected
    );
    let g = Fixture::new("planned");
    fs::set_permissions(&g.database, fs::Permissions::from_mode(0o622)).unwrap();
    assert_eq!(
        g.compare(NOW)["blocker"],
        "autonomous_research_topic_producer_state_invalid"
    );
    fs::remove_file(&g.database).unwrap();
    assert_eq!(
        g.compare(NOW)["blocker"],
        "autonomous_research_topic_producer_state_missing"
    );
}
#[test]
fn old_schema_requires_upgrade_and_nonordinary_schema_has_explicit_native_refusal() {
    let f = Fixture::new("planned");
    f.sql(&format!(
        "ALTER TABLE {GEN} DROP COLUMN provider_canary_side_effect_inspection_json"
    ));
    assert_eq!(
        f.compare(NOW)["blocker"],
        "autonomous_research_topic_producer_schema_upgrade_required"
    );
    f.reset();
    f.sql(&format!("ALTER TABLE {META} RENAME TO original_metadata; CREATE VIEW {META} AS SELECT * FROM original_metadata"));
    assert_eq!(
        f.oracle(json!({"action":"inspect"}))["value"]["ready"],
        true
    );
    f.blocker("autonomous_research_topic_producer_state_schema_unsupported");
    f.reset();
    f.sql(&format!(
        "ALTER TABLE {META} ADD COLUMN generated_value TEXT GENERATED ALWAYS AS ('owned') VIRTUAL"
    ));
    assert_eq!(
        f.oracle(json!({"action":"inspect"}))["value"]["ready"],
        true
    );
    f.blocker("autonomous_research_topic_producer_state_schema_unsupported");
    f.reset();
    f.sql(&format!("ALTER TABLE {META} RENAME TO original_metadata; CREATE TABLE {META} AS SELECT * FROM original_metadata; INSERT INTO {META} SELECT * FROM original_metadata"));
    assert_eq!(
        f.oracle(json!({"action":"inspect"}))["value"]["ready"],
        true
    );
    f.blocker("autonomous_research_topic_producer_state_storage_profile_unsupported");
}
#[test]
fn nullable_cells_utf8_json_and_schema_bounds_refuse_without_silent_nulls() {
    let f = Fixture::new("planned");
    for (table, column, length) in [
        (META, "next_attempt_at", 4097),
        (GEN, "capability_json", 2 * 1024 * 1024 + 1),
    ] {
        f.reset();
        f.update(table, column, Some(&" ".repeat(length)));
        f.blocker("autonomous_research_topic_producer_state_storage_profile_unsupported");
    }
    f.reset();
    f.sql(&format!(
        "UPDATE {META} SET next_attempt_at=CAST(X'FF' AS TEXT)"
    ));
    f.blocker("autonomous_research_topic_producer_state_storage_profile_unsupported");
    f.reset();
    let sql = (0..130)
        .map(|i| format!("CREATE TABLE owned_bound_{i}(value TEXT); "))
        .collect::<String>();
    f.sql(&sql);
    assert_eq!(
        f.oracle(json!({"action":"inspect"}))["value"]["ready"],
        true
    );
    f.blocker("autonomous_research_topic_producer_status_bound_exceeded");
}
#[test]
fn original_positive_date_spellings_and_engine_json_errors_are_separate_profiles() {
    let f = Fixture::new("planned");
    for column in ["last_observed_at", "last_produced_at", "next_attempt_at"] {
        f.reset();
        f.update(META, column, Some("2026-09-22T00:00:00Z"));
        assert_eq!(
            f.oracle(json!({"action":"inspect"}))["value"]["ready"],
            true
        );
        f.blocker("autonomous_research_topic_producer_date_parse_profile_unsupported");
    }
    f.reset();
    f.update(GEN, "capability_json", Some(""));
    let original = f.oracle(json!({"action":"inspect"}));
    assert_eq!(original["value"]["blocker"], "Unexpected end of JSON input");
    f.blocker("autonomous_research_topic_producer_state_json_profile_unsupported");
}
struct Keeper {
    child: Child,
    reader: Option<JoinHandle<()>>,
    expected: Value,
}
impl Keeper {
    fn start(f: &Fixture) -> Self {
        let mut child = f
            .command(
                "topic-producer-status-v1.mjs",
                json!({"action":"keeper","now":"2026-09-22T00:00:30.000Z"}),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut owner = Self {
            child,
            reader: None,
            expected: Value::Null,
        };
        let (sender, receiver) = mpsc::channel();
        owner.reader = Some(thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = BufReader::new(stdout.take(65537))
                .read_until(b'\n', &mut bytes)
                .map(|_| bytes);
            let _ = sender.send(result);
        }));
        let bytes = receiver
            .recv_timeout(Duration::from_secs(20))
            .expect("owned keeper startup deadline")
            .unwrap();
        owner.reader.take().unwrap().join().unwrap();
        assert!(bytes.len() <= 65536 && bytes.last() == Some(&b'\n'));
        let result: Value = serde_json::from_slice(&bytes).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&result["profile"]).unwrap();
        assert_eq!(result["evidenceScope"], SCOPE);
        assert_eq!(result["ready"], true);
        assert_eq!(result["callbacks"], 0);
        assert_eq!(result["before"], result["retained"]);
        assert_eq!(result["before"]["last_observed_at"], NOW);
        assert_eq!(
            result["expected"]["lastObservedAt"],
            "2026-09-22T00:00:30.000Z"
        );
        assert!(
            result["checkpoint"]["log"].as_i64().unwrap()
                > result["checkpoint"]["checkpointed"].as_i64().unwrap()
        );
        owner.expected = result["expected"].clone();
        assert!(owner.child.try_wait().unwrap().is_none());
        owner
    }
    fn crash(mut self) {
        assert!(self.child.try_wait().unwrap().is_none());
        self.child.kill().unwrap();
        assert_eq!(self.child.wait().unwrap().signal(), Some(9));
    }
}
impl Drop for Keeper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
#[test]
fn actual_original_renewal_held_in_wal_is_read_without_source_mutation() {
    let f = Fixture::new("planned");
    let mut keeper = Keeper::start(&f);
    let expected = keeper.expected.clone();
    assert_eq!(f.compare("2026-09-22T00:00:30.000Z"), expected);
    assert!(keeper.child.try_wait().unwrap().is_none());
}
#[test]
fn crashed_original_renewal_without_source_shm_uses_private_effective_snapshot() {
    let f = Fixture::new("planned");
    let keeper = Keeper::start(&f);
    let expected = keeper.expected.clone();
    keeper.crash();
    assert!(f.sidecar("wal").exists());
    fs::remove_file(f.sidecar("shm")).unwrap();
    assert_eq!(
        f.native(
            "2026-09-22T00:00:30.000Z",
            f.setup["configurationHash"].as_str().unwrap()
        ),
        json!({"ok":true,"value":expected})
    );
    assert!(!f.sidecar("shm").exists(), "never repair original SHM");
}
