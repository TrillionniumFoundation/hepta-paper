use super::*;
use hepta_codex_runtime::{
    BoundedProcessRequestV1, EnvironmentPolicyV1, ProcessLimitsV1, ProcessTerminationReason,
    run_bounded_process_capturing_stdout_with_cancellation,
};
use std::{
    collections::BTreeMap, ffi::OsString, fs, os::unix::fs::PermissionsExt, path::PathBuf,
    sync::atomic::Ordering, time::Duration,
};

struct Fixture {
    root: PathBuf,
    repository: PathBuf,
}
impl Fixture {
    fn new(variant: &str) -> Self {
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .unwrap()
            .to_owned();
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let root =
            std::env::temp_dir().join(format!("hepta-dataset-reader-{}", hex::encode(random)));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let fixture = Self { root, repository };
        fixture.oracle("create", variant);
        fixture
    }
    fn oracle(&self, action: &str, variant: &str) {
        let node = std::env::var_os("HEPTA_PRODUCTION_NODE_BINARY")
            .or_else(|| std::env::var_os("HEPTA_TEST_NODE"))
            .map(PathBuf::from)
            .expect("qualified absolute producer Node input");
        assert!(node.is_absolute());
        let environment = EnvironmentPolicyV1::new(
            "dataset-reader-source-oracle",
            ["PATH", "HOME", "LANG", "LC_ALL"],
            ["PATH"],
        )
        .unwrap()
        .build(
            std::iter::empty::<(OsString, OsString)>(),
            &BTreeMap::from([
                (
                    "PATH".into(),
                    node.parent()
                        .unwrap_or(Path::new("/usr/bin"))
                        .to_string_lossy()
                        .into_owned(),
                ),
                ("HOME".into(), self.root.to_string_lossy().into_owned()),
                ("LANG".into(), "C.UTF-8".into()),
                ("LC_ALL".into(), "C.UTF-8".into()),
            ]),
        )
        .unwrap();
        let cancel = AtomicBool::new(false);
        let result=run_bounded_process_capturing_stdout_with_cancellation(&BoundedProcessRequestV1 {
            executable:node,arguments:[
                self.repository.join("rust/crates/hepta-paper-service/src/operator_dataset_harness/fixture-oracle.mjs").into_os_string(),
                self.repository.clone().into_os_string(),self.root.clone().into_os_string(),action.into(),variant.into(),
            ].into(),working_directory:self.repository.clone(),environment,stdin:None,
        },ProcessLimitsV1 {timeout_ms:60000,maximum_stdout_bytes:128*1024,maximum_stderr_bytes:128*1024,maximum_tail_bytes:128*1024,..Default::default()},&cancel).unwrap();
        assert_eq!(result.process.exit_code, Some(0), "{:?}", result.process);
        assert_eq!(
            result.process.termination_reason,
            ProcessTerminationReason::Exited
        );
        assert!(result.process.process_group_cleanup_verified);
        let profile: Value = serde_json::from_slice(&result.stdout).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&profile).unwrap();
        assert_eq!(profile["sourceOnly"], true);
        assert_eq!(profile["externalActionPerformed"], false);
    }
    fn mount(&self) -> Json {
        hepta_legacy_compatibility::parse_production_json_v1(
            &fs::read(self.root.join("mount.json")).unwrap(),
        )
        .unwrap()
    }
    fn inspect<'a>(
        &self,
        mount: &Json,
        c: &'a AtomicBool,
        d: Instant,
    ) -> OperatorDatasetHarnessObservation<'a> {
        inspect_operator_dataset_harness_v1(
            mount,
            &self.root.join("runtime"),
            &self.repository,
            c,
            d,
            &Value::Null,
        )
        .unwrap()
    }
    fn assert_oracle(&self, observation: &OperatorDatasetHarnessObservation<'_>) {
        let actual = wire(observation.receipt()).unwrap();
        let expected = fs::read(self.root.join("oracle.json")).unwrap();
        assert_eq!(
            String::from_utf8(actual).unwrap(),
            String::from_utf8(expected).unwrap()
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::set_permissions(self.root.join("dataset"), fs::Permissions::from_mode(0o700));
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn actual_incumbent_signed_receipts_and_scope_refusals_match_whole_ordered_wire() {
    for variant in [
        "normal",
        "license",
        "promotion",
        "revoked",
        "float-version",
        "subjects",
        "duplicates",
        "expired",
    ] {
        let fixture = Fixture::new(variant);
        let mount = fixture.mount();
        let c = AtomicBool::new(false);
        let d = Instant::now() + Duration::from_secs(120);
        let observation = fixture.inspect(&mount, &c, d);
        fixture.assert_oracle(&observation);
        observation.assert_current(&c, d).unwrap();
        assert!(boolean(
            get(observation.receipt(), "externalActionPerformed"),
            false
        ));
        if matches!(variant, "normal" | "float-version") {
            let (plugin, descriptors) =
                observation.verified_plugin_context_for_host(&c, d).unwrap();
            assert_eq!(plugin.startup_inspection["signatureVerified"], true);
            assert_eq!(
                plugin.registry["autonomousEmpiricalFamilyPluginRegistryHash"],
                plugin.package["registry"]["autonomousEmpiricalFamilyPluginRegistryHash"]
            );
            assert_eq!(descriptors.as_array().unwrap().len(), 6);
            let (definition, splits) = observation.private_definition_for_host(&c, d).unwrap();
            assert_eq!(array(get(definition, "cells")).len(), 32);
            assert_eq!(array(get(splits, "entries")).len(), 1);
            assert!(
                !String::from_utf8(wire(observation.receipt()).unwrap())
                    .unwrap()
                    .contains("\"oracle\"")
            );
            assert!(boolean(
                get(observation.receipt(), "academicPromotionEligible"),
                false
            ));
        } else {
            assert!(observation.private_definition_for_host(&c, d).is_err());
            assert!(observation.verified_plugin_context_for_host(&c, d).is_err());
        }
    }
}
#[test]
fn retained_trust_replacement_refuses_and_fresh_revoked_retry_matches_incumbent() {
    let fixture = Fixture::new("normal");
    let mount = fixture.mount();
    let c = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(120);
    let observation = fixture.inspect(&mount, &c, d);
    let path = fixture
        .root
        .join("runtime/trust/AUTHORITY_TRUST_STORE.json");
    let old = fs::read(&path).unwrap();
    let mut trust: Value = serde_json::from_slice(&old).unwrap();
    trust["keys"][0]["status"] = Value::from("revoked");
    fs::rename(&path, path.with_extension("old")).unwrap();
    fs::write(&path, serde_json::to_vec(&trust).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(observation.assert_current(&c, d).is_err());
    assert!(observation.private_definition_for_host(&c, d).is_err());
    fixture.oracle("read", "normal");
    let fresh = fixture.inspect(&mount, &c, d);
    fixture.assert_oracle(&fresh);
    assert!(fresh.private_definition_for_host(&c, d).is_err());
}
#[test]
fn same_control_owner_cancellation_deadline_and_expired_input_fail_before_host_borrow() {
    let fixture = Fixture::new("normal");
    let mount = fixture.mount();
    let c = AtomicBool::new(false);
    let d = Instant::now() + Duration::from_secs(2);
    let observation = fixture.inspect(&mount, &c, d);
    let other = AtomicBool::new(false);
    assert!(observation.assert_current(&other, d).is_err());
    assert!(
        observation
            .assert_current(&c, d + Duration::from_secs(1))
            .is_err()
    );
    c.store(true, Ordering::SeqCst);
    assert!(observation.private_definition_for_host(&c, d).is_err());
    let deadline_control = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(2);
    let expiring = fixture.inspect(&mount, &deadline_control, deadline);
    std::thread::sleep(
        deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(2),
    );
    assert!(
        expiring
            .private_definition_for_host(&deadline_control, deadline)
            .is_err()
    );
    let absent = fixture.root.join("absent");
    assert!(
        inspect_operator_dataset_harness_v1(
            &mount,
            &absent,
            &fixture.repository,
            &deadline_control,
            Instant::now(),
            &Value::Null
        )
        .err()
        .unwrap()
        .contains("deadline")
    );
}
#[test]
fn cancelled_and_oversized_mounts_refuse_before_any_path_access() {
    let c = AtomicBool::new(true);
    let missing = Path::new("/this-dataset-reader-fixture-must-not-exist");
    let d = Instant::now() + Duration::from_secs(120);
    let error =
        inspect_operator_dataset_harness_v1(&Json::Null, missing, missing, &c, d, &Value::Null)
            .err()
            .unwrap();
    assert!(error.contains("cancel"));
    c.store(false, Ordering::SeqCst);
    let oversized = Json::String(vec![b'x' as u16; 17 * 1024 * 1024]);
    let error =
        inspect_operator_dataset_harness_v1(&oversized, missing, missing, &c, d, &Value::Null)
            .err()
            .unwrap();
    assert!(!error.contains("directory"));
    assert!(!missing.exists());
}
