use super::*;
use nix::fcntl::{Flock, FlockArg};

fn records(temp: &Temp) -> BTreeSet<String> {
    fs::read_dir(temp.0.join("attempts"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect()
}

#[test]
fn changed_plan_cannot_escape_an_unprepared_start_after_owner_reopen() {
    let temp = Temp::new();
    let failed =
        configuration_for_job(&temp, NativeBusinessJobV1::BuildPackage { entries: vec![] });
    assert!(run_service_v1(failed).is_err());
    let before = records(&temp);
    assert_eq!(before.len(), 1);
    assert!(before.iter().all(|name| name.ends_with(".started")));
    // New service, fresh request payload and different plan hash, same durable owner.
    // Previously this valid build could dispatch despite the unresolved first start.
    let next = build_configuration(&temp);
    assert!(run_service_v1(next).is_err());
    assert_eq!(records(&temp), before);
}

#[test]
fn independent_executor_descriptor_cannot_dispatch_under_held_directory_lock() {
    let temp = Temp::new();
    let config = build_configuration(&temp);
    let directory = fs::File::open(temp.0.join("attempts")).unwrap();
    let guard = Flock::lock(directory, FlockArg::LockExclusiveNonblock).unwrap();
    assert!(run_service_v1(config.clone()).is_err());
    assert!(records(&temp).is_empty());
    drop(guard);
    let receipt = run_service_v1(config).unwrap();
    assert_eq!(receipt.commit_receipts.len(), 1);
    assert!(receipt.commit_receipts[0].newly_committed);
}

#[test]
fn orphan_prepared_cache_and_corrupt_start_block_new_dispatch_without_cleanup() {
    for orphan_prepared in [true, false] {
        let temp = Temp::new();
        let config = build_configuration(&temp);
        run_service_v1(config.clone()).unwrap();
        let start = records(&temp)
            .into_iter()
            .find(|name| name.ends_with(".started"))
            .unwrap();
        if orphan_prepared {
            fs::remove_file(temp.0.join("attempts").join(start)).unwrap();
        } else {
            fs::write(
                temp.0.join("attempts").join(start),
                b"wrong dispatch identity",
            )
            .unwrap();
        }
        let before = records(&temp);
        assert!(run_service_v1(config).is_err());
        assert_eq!(records(&temp), before);
    }
}

#[test]
fn unknown_attempt_record_blocks_execution_instead_of_being_ignored() {
    let temp = Temp::new();
    let config = build_configuration(&temp);
    fs::write(
        temp.0.join("attempts").join("unclassified-record"),
        b"residue",
    )
    .unwrap();
    let before = records(&temp);
    assert!(run_service_v1(config).is_err());
    assert_eq!(records(&temp), before);
}

#[test]
fn donor_prepared_record_cannot_settle_another_requests_unknown_start() {
    let target = Temp::new();
    let failed = configuration_for_job(
        &target,
        NativeBusinessJobV1::BuildPackage { entries: vec![] },
    );
    assert!(run_service_v1(failed).is_err());
    let start = records(&target).into_iter().next().unwrap();
    assert!(start.ends_with(".started"));

    let donor = Temp::new();
    run_service_v1(build_configuration(&donor)).unwrap();
    let prepared = records(&donor)
        .into_iter()
        .find(|name| name.ends_with(".prepared"))
        .unwrap();
    // Copy actual donor CAS bytes too: existence and correct content hashes do
    // not make an unrelated evidence.requestHash settle the target's start.
    let target_objects = ObjectStoreV1::open(&target.0).unwrap();
    for entry in fs::read_dir(donor.0.join("objects")).unwrap() {
        target_objects
            .put(&fs::read(entry.unwrap().path()).unwrap())
            .unwrap();
    }
    let destination = target
        .0
        .join("attempts")
        .join(start.replace(".started", ".prepared"));
    fs::write(
        &destination,
        fs::read(donor.0.join("attempts").join(prepared)).unwrap(),
    )
    .unwrap();
    fs::set_permissions(&destination, fs::Permissions::from_mode(0o600)).unwrap();
    let before = records(&target);
    assert_eq!(before.len(), 2);
    assert!(matches!(
        run_service_v1(build_configuration(&target)),
        Err(hepta_paper_service::ServiceError::ControlRequiresInspection { .. })
    ));
    assert_eq!(records(&target), before);
}

fn other_campaign(temp: &Temp) -> ServiceRunV1 {
    let mut other = build_configuration(temp);
    other.snapshot.campaign_id = "different-campaign".into();
    other.snapshot.campaign_revision = 1;
    let snapshot_hash = other.snapshot.snapshot_hash().unwrap();
    other.frontier.snapshot_hash = snapshot_hash.clone();
    for candidate in &mut other.frontier.candidates {
        candidate.snapshot_hash = snapshot_hash.clone();
    }
    other
}

fn prepared_record(temp: &Temp) -> (PathBuf, hepta_module_platform::PreparedResultV1) {
    let prepared = records(temp)
        .into_iter()
        .find(|name| name.ends_with(".prepared"))
        .unwrap();
    let path = temp.0.join("attempts").join(prepared);
    let result = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    (path, result)
}

#[test]
fn missing_or_corrupt_evidence_cannot_unlock_a_different_campaign() {
    for mode in ["intact", "corrupt", "missing"] {
        let temp = Temp::new();
        run_service_v1(build_configuration(&temp)).unwrap();
        let (_, result) = prepared_record(&temp);
        let evidence = temp
            .0
            .join("objects")
            .join(result.evidence_hash.as_str().trim_start_matches("sha256:"));
        match mode {
            "corrupt" => fs::write(&evidence, b"corrupt retained evidence").unwrap(),
            "missing" => fs::remove_file(&evidence).unwrap(),
            _ => (),
        }
        let before = records(&temp);
        let outcome = run_service_v1(other_campaign(&temp));
        if mode == "intact" {
            assert!(outcome.unwrap().commit_receipts[0].newly_committed);
            assert_eq!(records(&temp).len(), before.len() + 2);
        } else {
            assert!(matches!(
                outcome,
                Err(hepta_paper_service::ServiceError::ControlRequiresInspection { .. })
            ));
            assert_eq!(records(&temp), before);
        }
    }
}

#[test]
fn self_hashed_evidence_requires_one_typed_matching_request_identity() {
    for mode in [
        "wrong_request",
        "wrong_version",
        "missing_request",
        "duplicate_request",
    ] {
        let temp = Temp::new();
        run_service_v1(build_configuration(&temp)).unwrap();
        let (path, mut result) = prepared_record(&temp);
        let objects = ObjectStoreV1::open(&temp.0).unwrap();
        let original: serde_json::Value =
            serde_json::from_slice(&objects.read(&result.evidence_hash).unwrap()).unwrap();
        let request = original["requestHash"].as_str().unwrap();
        let evidence = match mode {
            "wrong_request" => format!(
                "{{\"version\":1,\"requestHash\":\"sha256:{}\"}}",
                "0".repeat(64)
            ),
            "wrong_version" => format!("{{\"version\":2,\"requestHash\":\"{request}\"}}"),
            "missing_request" => "{\"version\":1}".into(),
            _ => format!(
                "{{\"version\":1,\"requestHash\":\"{request}\",\"requestHash\":\"{request}\"}}"
            ),
        };
        // Rehash every changed object: an internally consistent CAS is still
        // insufficient without the exact service-owned identity binding.
        result.evidence_hash = objects.put(evidence.as_bytes()).unwrap();
        fs::write(&path, serde_json::to_vec(&result).unwrap()).unwrap();
        let before = records(&temp);
        assert!(matches!(
            run_service_v1(other_campaign(&temp)),
            Err(hepta_paper_service::ServiceError::ControlRequiresInspection { .. })
        ));
        assert_eq!(records(&temp), before);
    }
}
