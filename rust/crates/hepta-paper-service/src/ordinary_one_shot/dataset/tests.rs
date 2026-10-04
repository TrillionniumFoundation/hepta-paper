use super::*;
use crate::ordinary_one_shot::preflight::tests::{node, workspace};
use std::{
    cell::Cell,
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::PathBuf,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new(variant: &str) -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!("os-data-{}", hex::encode(random)));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let fixture = Self(root);
        let args=vec![workspace().join("rust/crates/hepta-paper-service/src/operator_dataset_harness/fixture-oracle.mjs").to_str().unwrap().into(),workspace().to_str().unwrap().into(),fixture.0.to_str().unwrap().into(),"create".into(),variant.into()];
        let (exit, stdout, stderr) = node(args, None);
        assert_eq!(exit, 0, "{}", String::from_utf8_lossy(&stderr));
        let profile: Value = serde_json::from_slice(&stdout).unwrap();
        hepta_legacy_compatibility::qualify_production_node_profile_v1(&profile).unwrap();
        assert_eq!(profile["sourceOnly"], true);
        assert_eq!(profile["externalActionPerformed"], false);
        // The incumbent binds nested document equality to complete ordered
        // JSON bytes. Keep its actual mount property order through the array.
        let mount = fs::read(fixture.0.join("mount.json")).unwrap();
        let mounts = [b"[".as_slice(), mount.as_slice(), b"]".as_slice()].concat();
        fs::write(fixture.0.join("mounts.json"), mounts).unwrap();
        fs::set_permissions(
            fixture.0.join("mounts.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        fixture
    }
    fn document<'a>(&self, control: &'a ReconciliationReadControlV1) -> MountDocument<'a> {
        load_mount_document(
            &workspace(),
            Some(self.0.join("mounts.json").to_str().unwrap()),
            control,
        )
        .unwrap()
    }
    fn observe<'a, 'b>(
        &self,
        document: &'b MountDocument<'a>,
        control: &'a ReconciliationReadControlV1,
    ) -> ObservedOneShotDatasetV1<'a, 'b> {
        ObservedOneShotDatasetV1::inspect(
            document,
            &self.0.join("runtime"),
            &workspace(),
            control,
            &Value::Null,
        )
        .unwrap()
    }
    fn native_database(&self) {
        let input=serde_json::to_vec(&serde_json::json!({"source":workspace(),"runtime":self.0.join("db"),"profile":"valid"})).unwrap();
        let args = vec![
            "--input-type=module".into(),
            "--eval".into(),
            include_str!("../execution_inputs/oracle.mjs").into(),
        ];
        let (exit, _, stderr) = node(args, Some(input));
        assert_eq!(exit, 0, "{}", String::from_utf8_lossy(&stderr));
        fs::rename(
            self.0.join("db/hepta-paper.sqlite"),
            self.0.join("runtime/hepta-paper.sqlite"),
        )
        .unwrap();
        fs::remove_dir(self.0.join("db")).unwrap();
    }
    fn argv(&self, action: &str) -> Vec<String> {
        [
            "--action",
            action,
            "--runtime-root",
            self.0.join("runtime").to_str().unwrap(),
            "--control-root",
            self.0.join("control").to_str().unwrap(),
            "--dataset-mount-file",
            self.0.join("mounts.json").to_str().unwrap(),
        ]
        .into_iter()
        .map(str::to_owned)
        .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::set_permissions(self.0.join("dataset"), fs::Permissions::from_mode(0o700));
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn actual_normal_plan_and_preflight_v4_dataset_cases_match_incumbent_complete_wire_and_leave_inputs_unchanged()
 {
    for (action, variant) in [
        ("plan", "normal"),
        ("preflight", "revoked"),
        ("plan", "license"),
        ("preflight", "expired"),
    ] {
        let fixture = Fixture::new(variant);
        fixture.native_database();
        let args = fixture.argv(action);
        let database = fs::read(fixture.0.join("runtime/hepta-paper.sqlite")).unwrap();
        let mount_bytes = fs::read(fixture.0.join("mounts.json")).unwrap();
        let mut incumbent = vec![
            workspace()
                .join("paper-core/bin/autonomous-research-one-shot-campaign-attempt.mjs")
                .to_str()
                .unwrap()
                .to_owned(),
        ];
        incumbent.extend_from_slice(&args);
        let expected = node(incumbent, None);
        assert_eq!(expected.0, 2, "{}", String::from_utf8_lossy(&expected.2));
        let actual = crate::ordinary_one_shot::inspect_ordinary_one_shot_status_v1(
            &args,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert_eq!(actual.exit_code, expected.0);
        assert_eq!(
            actual.stdout,
            expected.1,
            "{action}:{variant}:{}",
            String::from_utf8_lossy(&actual.stdout)
        );
        let value: Value = serde_json::from_slice(&actual.stdout).unwrap();
        assert_eq!(value["executionAuthorized"], false);
        assert_eq!(value["sideEffects"]["providerInvocationPerformed"], false);
        assert_eq!(value["sideEffects"]["journalWriteRepositoryOpened"], false);
        assert!(!String::from_utf8_lossy(&actual.stdout).contains("\"oracle\""));
        assert_eq!(
            fs::read(fixture.0.join("runtime/hepta-paper.sqlite")).unwrap(),
            database
        );
        assert_eq!(
            fs::read(fixture.0.join("mounts.json")).unwrap(),
            mount_bytes
        );
        assert!(
            !fixture
                .0
                .join("control/campaign-one-shot-attempt.sqlite")
                .exists()
        );
    }
}

#[test]
fn actual_opaque_host_borrows_survive_await_with_original_control_and_refuse_unqualified_scope() {
    let fixture = Fixture::new("normal");
    let control = ReconciliationReadControlV1::new(
        Arc::new(AtomicBool::new(false)),
        Instant::now() + Duration::from_secs(120),
    );
    let document = fixture.document(&control);
    let held = fixture.observe(&document, &control);
    fn assert_send<T: Send>(_: &T) {}
    fn assert_send_sync<T: Send + Sync>(_: &T) {}
    assert_send_sync(&held);
    let expected_cancelled = control.cancelled.as_ref();
    let expected_deadline = control.deadline;
    let future = held.with_host_inputs(&control.cancelled, control.deadline, |inputs| async move {
        assert!(std::ptr::eq(inputs.control_cancelled(), expected_cancelled));
        assert_eq!(inputs.control_deadline(), expected_deadline);
        assert!(matches!(field(inputs.private_definition(), "cells"), Json::Array(cells) if cells.len()==32));
        assert!(matches!(field(inputs.private_splits(), "entries"), Json::Array(entries) if entries.len()==1));
        assert_eq!(inputs.plugin_authority().startup_inspection["signatureVerified"], true);
        assert_eq!(inputs.plugin_descriptors().as_array().unwrap().len(), 6);
        futures_lite::future::yield_now().await;
        Ok(())
    });
    assert_send(&future);
    futures_lite::future::block_on(future).unwrap();
    held.assert_current(&control.cancelled, control.deadline)
        .unwrap();
    let other = AtomicBool::new(false);
    assert!(
        futures_lite::future::block_on(held.with_host_inputs(
            &other,
            control.deadline,
            |_| async { Ok(()) }
        ))
        .is_err()
    );
    assert!(
        held.assert_current(&control.cancelled, control.deadline)
            .is_err()
    );

    let blocked = Fixture::new("revoked");
    let blocked_document = blocked.document(&control);
    let blocked_held = blocked.observe(&blocked_document, &control);
    let invoked = Cell::new(false);
    assert!(
        futures_lite::future::block_on(blocked_held.with_host_inputs(
            &control.cancelled,
            control.deadline,
            |_| {
                invoked.set(true);
                async { Ok(()) }
            }
        ))
        .is_err()
    );
    assert!(!invoked.get());
}

#[test]
fn actual_mount_and_trust_replacement_across_host_await_poison_old_observation_and_fresh_revoke_refuses()
 {
    for selected in ["mounts.json", "runtime/trust/AUTHORITY_TRUST_STORE.json"] {
        let fixture = Fixture::new("normal");
        let control = ReconciliationReadControlV1::new(
            Arc::new(AtomicBool::new(false)),
            Instant::now() + Duration::from_secs(120),
        );
        let document = fixture.document(&control);
        let held = fixture.observe(&document, &control);
        let path = fixture.0.join(selected);
        let saved = path.with_extension("saved");
        let entered = Cell::new(false);
        let result = futures_lite::future::block_on(held.with_host_inputs(
            &control.cancelled,
            control.deadline,
            |_| async {
                futures_lite::future::yield_now().await;
                entered.set(true);
                fs::rename(&path, &saved).unwrap();
                let mut value: Value = serde_json::from_slice(&fs::read(&saved).unwrap()).unwrap();
                if selected.contains("TRUST") {
                    value["keys"][0]["status"] = Value::from("revoked");
                }
                fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
                if selected.contains("TRUST") {
                    Err("one_shot_dataset_test_host_failure".into())
                } else {
                    Ok(())
                }
            },
        ));
        assert!(
            entered.get(),
            "the replacement must occur inside the held host future"
        );
        assert_ne!(
            result.unwrap_err(),
            "one_shot_dataset_test_host_failure",
            "the currentness check must also run after a failed host future"
        );
        if selected.contains("TRUST") {
            let fresh_document = fixture.document(&control);
            let fresh = fixture.observe(&fresh_document, &control);
            let invoked = Cell::new(false);
            assert!(
                futures_lite::future::block_on(fresh.with_host_inputs(
                    &control.cancelled,
                    control.deadline,
                    |_| {
                        invoked.set(true);
                        async { Ok(()) }
                    }
                ))
                .is_err()
            );
            assert!(!invoked.get());
        }
        fs::remove_file(&path).unwrap();
        fs::rename(&saved, &path).unwrap();
        assert!(
            held.assert_current(&control.cancelled, control.deadline)
                .is_err()
        );
    }
}

#[test]
fn actual_cancellation_expiry_and_attempted_deadline_extension_across_host_await_refuse_without_rebaseline()
 {
    let fixture = Fixture::new("normal");
    let cancel = Arc::new(AtomicBool::new(false));
    let control =
        ReconciliationReadControlV1::new(cancel.clone(), Instant::now() + Duration::from_secs(120));
    let document = fixture.document(&control);
    let held = fixture.observe(&document, &control);
    let cancelled_after_yield = Cell::new(false);
    let result = futures_lite::future::block_on(held.with_host_inputs(
        &cancel,
        control.deadline,
        |_| async {
            futures_lite::future::yield_now().await;
            cancel.store(true, Ordering::Release);
            cancelled_after_yield.set(true);
            Ok(())
        },
    ));
    assert!(cancelled_after_yield.get());
    assert!(cancel.load(Ordering::Acquire));
    assert!(result.is_err());
    cancel.store(false, Ordering::Release);
    assert!(held.assert_current(&cancel, control.deadline).is_err());
    let fresh = fixture.observe(&document, &control);
    assert!(
        fresh
            .assert_current(&cancel, control.deadline + Duration::from_millis(1))
            .is_err()
    );
    assert!(fresh.assert_current(&cancel, control.deadline).is_err());

    let expiry_control =
        ReconciliationReadControlV1::new(cancel, Instant::now() + Duration::from_secs(5));
    let expiry_document = fixture.document(&expiry_control);
    let expiring = fixture.observe(&expiry_document, &expiry_control);
    let expired_after_wait = Cell::new(false);
    let expired = futures_lite::future::block_on(expiring.with_host_inputs(
        &expiry_control.cancelled,
        expiry_control.deadline,
        |_| async {
            async_io::Timer::at(expiry_control.deadline + Duration::from_millis(5)).await;
            expired_after_wait.set(true);
            Ok(())
        },
    ));
    assert!(
        expired_after_wait.get(),
        "the original deadline must expire during the actual await"
    );
    assert!(expired.is_err());
    assert!(
        expiring
            .assert_current(
                &expiry_control.cancelled,
                expiry_control.deadline + Duration::from_secs(120)
            )
            .is_err()
    );
}
