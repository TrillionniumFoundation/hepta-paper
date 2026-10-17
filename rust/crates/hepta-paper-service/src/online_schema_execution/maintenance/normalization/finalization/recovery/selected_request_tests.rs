//! Real ten-database installation followed by interruption between independent
//! request selection and kernel publication. The Node signer is a private test
//! peer, not a qualified installed principal or activation proof.
use super::*;
use crate::online_schema_execution::{
    maintenance::{
        normalization::{
            NoSchemaNormalizationCheckpointV1,
            installation::{
                NoSchemaInstallationCheckpointV1, SchemaInstallationOptionsV1,
                install_schema_maintenance_v1,
            },
            normalize_schema_maintenance_v1,
        },
        reserve_schema_maintenance_v1,
    },
    plan::{SchemaTransitionPlanOptionsV1, build_schema_transition_plan_v1},
};
use std::{
    cell::RefCell,
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
};
const BASE: i64 = 1_789_560_000_000;
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Peer {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Peer {
    fn call(&mut self, input: Value) -> Value {
        writeln!(self.input, "{input}").unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        assert!(self.output.read_line(&mut line).unwrap() > 0);
        let result: Value = serde_json::from_str(&line).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&result["profile"]).unwrap();
        assert_eq!(result["ok"], true, "{result}");
        result["value"].clone()
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
struct Signing {
    root: PathBuf,
    peer: Rc<RefCell<Peer>>,
}
impl MutationAuthorityTransportV1 for Signing {
    fn invoke(&mut self, request: &Value) -> Result<Value> {
        let operation = match request["kind"].as_str() {
            Some("AutonomousResearchOnlineSchemaTransitionFinalizeRequest") => {
                "finalize-maintenance"
            }
            Some("AutonomousResearchOnlineSchemaTransitionObserveRequest") => "observe-maintenance",
            _ => "reserve-maintenance",
        };
        let result = self
            .peer
            .borrow_mut()
            .call(json!({"operation":operation,"root":self.root,"request":request,"mode":"valid"}));
        ensure(result["accepted"] == true, "test_peer_refused")?;
        Ok(result["receipt"].clone())
    }
}
struct Fixture {
    root: PathBuf,
    setup: Value,
    peer: Rc<RefCell<Peer>>,
}
impl Fixture {
    fn new(version: i64) -> Self {
        let mut child =
            Command::new(std::env::var_os("HEPTA_TEST_NODE").unwrap_or_else(|| "node".into()))
                .arg(
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../../oracle/schema-installation-v1.mjs"),
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
        let peer = Rc::new(RefCell::new(Peer {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            child,
        }));
        let root = std::env::temp_dir().join(format!(
            "hepta-schema-source-rust-{}-selected-request-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let setup = peer
            .borrow_mut()
            .call(json!({"operation":"full-fixture","root":root,"version":version}));
        Self { root, setup, peer }
    }
    fn authority(&self) -> PinnedMutationAuthorityV1<Signing> {
        PinnedMutationAuthorityV1::load(
            Path::new(self.setup["configurationPath"].as_str().unwrap()),
            self.setup["configurationFileHash"].as_str().unwrap(),
            Signing {
                root: self.root.clone(),
                peer: self.peer.clone(),
            },
        )
        .unwrap()
    }
    fn runtime(&self) -> &Path {
        Path::new(self.setup["runtimeRoot"].as_str().unwrap())
    }
    fn journal_path(&self) -> PathBuf {
        self.runtime()
            .join("autonomous-research/online-schema-transition/NORMALIZATION.native.v1.json")
    }
    fn journal(&self) -> Value {
        serde_json::from_slice(&fs::read(self.journal_path()).unwrap()).unwrap()
    }
    fn options<'a>(
        &'a self,
        plan: &'a Value,
        pin: &'a str,
    ) -> ResumeSchemaFinalizationOptionsV1<'a> {
        ResumeSchemaFinalizationOptionsV1 {
            runtime_root: self.runtime(),
            state_database_manifest: &self.setup["stateDatabaseManifest"],
            writer_manifest: &self.setup["writerManifest"],
            expected_transition_id: plan["transitionId"].as_str().unwrap(),
            expected_plan_hash: plan["planHash"].as_str().unwrap(),
            expected_request_hash: pin,
        }
    }
    fn installed(
        &self,
        authority: &mut PinnedMutationAuthorityV1<Signing>,
    ) -> InstalledSchemaMaintenanceV1 {
        let plan = build_schema_transition_plan_v1(
            SchemaTransitionPlanOptionsV1 {
                runtime_root: self.runtime(),
                state_database_manifest: &self.setup["stateDatabaseManifest"],
                writer_manifest: &self.setup["writerManifest"],
                requested_lease_ms: 60000,
                required_execution_window_ms: 2000,
                expected_pre_rebind_pristine_runtime_state_hash:
                    self.setup["expectedPreRebindPristineRuntimeStateHash"].as_str(),
                machine_genesis: None,
            },
            authority,
            &mut || Ok(BASE),
        )
        .unwrap();
        let token = reserve_schema_maintenance_v1(plan, authority, &mut || Ok(BASE)).unwrap();
        let normalized = normalize_schema_maintenance_v1(
            token,
            authority,
            &mut || Ok(BASE),
            &mut NoSchemaNormalizationCheckpointV1,
        )
        .unwrap();
        install_schema_maintenance_v1(
            normalized,
            authority,
            &mut || Ok(BASE),
            SchemaInstallationOptionsV1::default(),
            &mut NoSchemaInstallationCheckpointV1,
        )
        .unwrap()
    }
    fn databases(&self, plan: &Value) -> Vec<Vec<u8>> {
        plan["instances"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                fs::read(
                    self.runtime()
                        .join(row["sourceRelativePath"].as_str().unwrap()),
                )
                .unwrap()
            })
            .collect()
    }
    fn finalized(
        &self,
        authority: &mut PinnedMutationAuthorityV1<Signing>,
    ) -> PreparedSchemaFinalizationV1 {
        let installed = self.installed(authority);
        let mut prepared =
            prepare_schema_transition_finalization_v1(installed, authority, &mut || Ok(BASE))
                .unwrap();
        finalize_prepared_schema_transition_v1(
            &mut prepared,
            authority,
            &mut || Ok(BASE),
            &mut NoSchemaFinalizationCheckpointV1,
        )
        .unwrap();
        prepared
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn interruption() -> crate::sqlite_mutation_coordinator::SqliteMutationCoordinatorError {
    error("test_after_independent_request_selection_before_kernel_publication")
}
fn select(f: &Fixture, name: &str, request: &Value, digest: &str) -> Result<()> {
    fs::write(
        f.root.join(name),
        serde_json::to_vec(&json!({"request":request,"hash":digest})).unwrap(),
    )
    .unwrap();
    Err(interruption())
}
fn selected(f: &Fixture, name: &str) -> Value {
    serde_json::from_slice(&fs::read(f.root.join(name)).unwrap()).unwrap()
}
#[test]
fn selected_finalization_recovers_missing_kernel_intent_without_fresh_lease_or_sql() {
    for version in [1, 2] {
        let f = Fixture::new(version);
        let mut authority = f.authority();
        let installed = f.installed(&mut authority);
        let plan = f.journal()["plan"].clone();
        let before = f.databases(&plan);
        assert_eq!(
            prepare_schema_transition_finalization_with_selection_v1(
                installed,
                &authority,
                &mut || Ok(BASE),
                &mut |request, digest, _| select(&f, "selected-final.json", request, digest)
            )
            .err()
            .unwrap()
            .code,
            interruption().code
        );
        assert!(f.journal().get("finalizationProgress").is_none());
        let independent = selected(&f, "selected-final.json");
        let pin = independent["hash"].as_str().unwrap();
        assert!(
            resume_schema_transition_finalization_v1(f.options(&plan, pin), &authority).is_err()
        );
        let mut changed = independent["request"].clone();
        changed["completedAt"] = json!(iso(BASE + 1).unwrap());
        assert!(
            resume_schema_transition_finalization_from_selected_request_v1(
                f.options(&plan, pin),
                &changed,
                &authority
            )
            .is_err()
        );
        assert!(f.journal().get("finalizationProgress").is_none());
        let prepared = resume_schema_transition_finalization_from_selected_request_v1(
            f.options(&plan, pin),
            &independent["request"],
            &authority,
        )
        .unwrap();
        assert_eq!(prepared.request(), &independent["request"]);
        assert_eq!(prepared.request_hash(), pin);
        assert_eq!(f.databases(&plan), before);
        drop(prepared);
        let resumed =
            resume_schema_transition_finalization_v1(f.options(&plan, pin), &authority).unwrap();
        assert_eq!(resumed.request(), &independent["request"]);
        assert_eq!(f.databases(&plan), before);
    }
}
#[test]
fn selected_v1_observation_recovers_same_nonce_after_prepare_publication_interruption() {
    let f = Fixture::new(1);
    let mut authority = f.authority();
    let finalized = f.finalized(&mut authority);
    let final_pin = finalized.request_hash().to_owned();
    let plan = f.journal()["plan"].clone();
    let before = f.databases(&plan);
    assert_eq!(
        prepare_schema_transition_observation_with_selection_v1(
            finalized,
            &authority,
            &mut || Ok(BASE),
            &mut |request, digest, _| select(&f, "selected-observe.json", request, digest)
        )
        .err()
        .unwrap()
        .code,
        interruption().code
    );
    assert!(f.journal().get("observationProgress").is_none());
    let independent = selected(&f, "selected-observe.json");
    let options = || ResumeSchemaObservationOptionsV1 {
        runtime_root: f.runtime(),
        state_database_manifest: &f.setup["stateDatabaseManifest"],
        writer_manifest: &f.setup["writerManifest"],
        expected_transition_id: plan["transitionId"].as_str().unwrap(),
        expected_plan_hash: plan["planHash"].as_str().unwrap(),
        expected_finalization_request_hash: &final_pin,
        expected_observation_request_hash: independent["hash"].as_str().unwrap(),
    };
    assert!(resume_schema_transition_observation_v1(options(), &authority).is_err());
    let mut changed = independent["request"].clone();
    changed["nonce"] = json!("changed-nonce");
    assert!(
        resume_schema_transition_observation_from_selected_request_v1(
            options(),
            &changed,
            &authority
        )
        .is_err()
    );
    assert!(f.journal().get("observationProgress").is_none());
    let prepared = resume_schema_transition_observation_from_selected_request_v1(
        options(),
        &independent["request"],
        &authority,
    )
    .unwrap();
    assert_eq!(prepared.request(), &independent["request"]);
    assert_eq!(f.databases(&plan), before);
    drop(prepared);
    let again = resume_schema_transition_observation_v1(options(), &authority).unwrap();
    assert_eq!(again.request(), &independent["request"]);
}
#[test]
fn selected_v2_restart_recovers_original_target_intent_without_manager_or_new_request() {
    let f = Fixture::new(2);
    let mut authority = f.authority();
    let finalized = f.finalized(&mut authority);
    let final_pin = finalized.request_hash().to_owned();
    let plan = f.journal()["plan"].clone();
    let before = f.databases(&plan);
    assert_eq!(
        restart::prepare_schema_target_configuration_restart_with_selection_v2(
            finalized,
            &authority,
            &mut || Ok(BASE),
            &mut |request, digest, _| select(&f, "selected-restart.json", request, digest)
        )
        .err()
        .unwrap()
        .code,
        interruption().code
    );
    assert!(
        f.journal()
            .get("targetRestartObservationProgress")
            .is_none()
    );
    let independent = selected(&f, "selected-restart.json");
    let options = || restart::ResumeSchemaTargetRestartOptionsV2 {
        runtime_root: f.runtime(),
        state_database_manifest: &f.setup["stateDatabaseManifest"],
        writer_manifest: &f.setup["writerManifest"],
        expected_transition_id: plan["transitionId"].as_str().unwrap(),
        expected_plan_hash: plan["planHash"].as_str().unwrap(),
        expected_finalization_request_hash: &final_pin,
        expected_target_observation_request_hash: independent["hash"].as_str().unwrap(),
    };
    assert!(restart::resume_schema_target_configuration_restart_v2(options(), &authority).is_err());
    let mut changed = independent["request"].clone();
    changed["nonce"] = json!("changed-restart-nonce");
    assert!(
        restart::resume_schema_target_configuration_restart_from_selected_request_v2(
            options(),
            &changed,
            &authority
        )
        .is_err()
    );
    assert!(
        f.journal()
            .get("targetRestartObservationProgress")
            .is_none()
    );
    let prepared = restart::resume_schema_target_configuration_restart_from_selected_request_v2(
        options(),
        &independent["request"],
        &authority,
    )
    .unwrap();
    assert_eq!(prepared.request(), &independent["request"]);
    assert_eq!(f.databases(&plan), before);
    drop(prepared);
    let again =
        restart::resume_schema_target_configuration_restart_v2(options(), &authority).unwrap();
    assert_eq!(again.request(), &independent["request"]);
}
