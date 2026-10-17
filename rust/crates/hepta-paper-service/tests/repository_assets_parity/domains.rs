use super::*;

#[test]
fn repository_asset_date_raw_coercion_and_handoff_match_bounded_actual_node() {
    use hepta_legacy_compatibility::production_hash_record_v1;
    use serde_json::json;
    use sha2::{Digest, Sha256};
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let directory = std::env::temp_dir().join(format!("asset-domains-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let fixture = Fixture(directory);
    let root = fixture.0.as_path();
    std::fs::create_dir(root.join("asset")).unwrap();
    let bytes = b"asset date and raw identity fixture\n";
    std::fs::write(root.join("asset/identity.txt"), bytes).unwrap();
    let digest = format!("sha256:{}", hex::encode(Sha256::digest(bytes)));
    let asset = json!({"assetId":"fixture", "sourcePath":"asset", "identityFile":"asset/identity.txt",
        "expectedIdentitySha256":digest, "currentStorage":"repository", "targetStorage":"registry",
        "requiredExternalReferenceKind":"content-addressed-artifact", "retentionPolicy":"retain",
        "migrationStatus":"externalized", "externalReference":{"kind":"content-addressed-artifact",
        "location":"https://example.invalid/identity", "digest":digest,
        "restoreDrillReceipt":{"version":1,"kind":"RepositoryAssetExternalRestoreDrillReceipt",
        "status":"repository_asset_external_restore_verified","assetId":"fixture",
        "externalReferenceDigest":digest,"restoredIdentitySha256":digest,"verifiedAt":"2026-09-24T00:00:00.000Z"}}});
    let manifest =
        json!({"version":1,"kind":"RepositoryAssetExternalizationManifest","assets":[asset]});
    fn rehash(value: &mut Value) {
        let receipt = &mut value["assets"][0]["externalReference"]["restoreDrillReceipt"];
        receipt
            .as_object_mut()
            .unwrap()
            .remove("repositoryAssetExternalRestoreDrillReceiptHash");
        let hash = production_hash_record_v1("RepositoryAssetExternalRestoreDrillReceipt", receipt)
            .unwrap();
        receipt["repositoryAssetExternalRestoreDrillReceiptHash"] =
            Value::String(hash.as_str().to_owned());
    }
    let dates = [
        json!("Thu, 24 Sep 2026 00:00:00 GMT"),
        json!("2026-09-24"),
        json!(1),
        json!(["2026-09-24"]),
        json!("2026-13-01T00:00:00Z"),
        json!("2026-09-32T00:00:00Z"),
        json!("2026-09-24T25:00:00Z"),
        json!("2026-09-24T00:00:61Z"),
        json!("2026-09-24T24:00:00.001Z"),
        json!("2026-09-24T00:00:00Zjunk"),
        json!("2026-09-24T00:00:00.Z"),
        json!("2026-09-24T00:00:00+99:00"),
        json!("2026-09-24T00:00:00+05:30"),
        json!("2026-09-24T00:00:00+0530"),
        json!("2026-09-24T24:00:00.000Z"),
        json!("2026-02-31T00:00:00Z"),
        json!("2026-09-24T00:00:00.000000001Z"),
        json!(0),
        json!(false),
        Value::Null,
    ];
    let mut cases = Vec::new();
    for date in dates {
        let mut value = manifest.clone();
        value["assets"][0]["externalReference"]["restoreDrillReceipt"]["verifiedAt"] = date;
        rehash(&mut value);
        cases.push(value);
    }
    for (field, raw) in [
        ("sourcePath", json!(["asset"])),
        ("identityFile", json!(["asset/identity.txt"])),
        ("currentStorage", json!(["repository"])),
        ("targetStorage", json!(12)),
        ("currentStorage", json!(9007199254740993u64)),
        ("assetId", json!({"id":9007199254740993u64})),
        ("currentStorage", json!(false)),
        ("targetStorage", json!(0)),
        ("assetId", json!(["fixture"])),
        ("expectedIdentitySha256", json!([digest])),
        ("retentionPolicy", json!({"policy":"retain"})),
        ("migrationStatus", json!(["externalized"])),
        ("sourcePath", json!("../outside")),
        ("identityFile", json!("../outside")),
        (
            "requiredExternalReferenceKind",
            json!(["content-addressed-artifact"]),
        ),
        ("migrationStatus", json!("toString")),
        ("migrationStatus", json!("__proto__")),
    ] {
        let mut value = manifest.clone();
        value["assets"][0][field] = raw;
        cases.push(value);
    }
    // Equal JSON arrays have distinct Node identity; primitive numbers use
    // Number equality rather than their lexical JSON spelling.
    for id in [
        json!(["fixture"]),
        json!({"id":"fixture"}),
        json!(1),
        Value::Null,
    ] {
        let mut value = manifest.clone();
        value["assets"][0]["assetId"] = id.clone();
        value["assets"][0]["migrationStatus"] = json!("pending-external-registry-reference");
        let second = value["assets"][0].clone();
        value["assets"].as_array_mut().unwrap().push(second);
        cases.push(value);
    }
    let pairs = cases
        .into_iter()
        .flat_map(|mut value| {
            rehash(&mut value);
            [(value.clone(), false), (value, true)]
        })
        .collect::<Vec<_>>();
    for chunk in pairs.chunks(32) {
        let oracle = oracle_requests(root.to_str().unwrap(), chunk.to_vec());
        for (index, (manifest, handoff)) in chunk.iter().enumerate() {
            assert_eq!(
                rust_result(root, manifest, *handoff),
                oracle["results"][index],
                "{manifest} handoff={handoff}"
            );
        }
    }
}

#[test]
fn ordinary_repository_assets_copied_default_frontends_match_all_date_coercion_modes() {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let selected =
        PathBuf::from(std::env::var_os("HEPTA_TEST_NODE").unwrap_or_else(|| "node".into()));
    let node = if selected.components().count() == 1 {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|p| p.join(&selected))
            .find(|p| p.is_file())
            .unwrap()
    } else {
        selected
    }
    .canonicalize()
    .unwrap();
    let input =
        serde_json::json!({"source":source,"native":env!("CARGO_BIN_EXE_hepta-paper-rust")});
    let request = BoundedProcessRequestV1 {
        executable: node,
        arguments: vec![
            source
                .join("rust/oracle/repository-assets-normal-domain-v1.mjs")
                .into_os_string(),
        ],
        working_directory: source,
        environment: EnvironmentPolicyV1::new(
            "repository-assets-normal-oracle-v1",
            ["PATH", "TZ"],
            ["PATH"],
        )
        .unwrap()
        .build(std::env::vars_os(), &BTreeMap::new())
        .unwrap(),
        stdin: Some(serde_json::to_vec(&input).unwrap()),
    };
    let output = run_bounded_process_capturing_stdout_with_cancellation(
        &request,
        ProcessLimitsV1 {
            timeout_ms: 120_000,
            maximum_stdin_bytes: 65536,
            maximum_stdout_bytes: 65536,
            maximum_stderr_bytes: 1024 * 1024,
            maximum_tail_bytes: 65536,
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
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(report["inputs"].as_u64().unwrap() >= 32);
    assert_eq!(report["modes"], 5);
    assert_eq!(
        report["comparisons"].as_u64().unwrap(),
        report["inputs"].as_u64().unwrap() * report["modes"].as_u64().unwrap()
    );
    assert_eq!(report["copiedDefaultRoot"], true);
    assert_eq!(report["sourceAndFixtureInputsUnchanged"], true);
    assert_eq!(report["completeHandoffDiagnostics"], true);
    assert_eq!(report["authority"], false);
}
