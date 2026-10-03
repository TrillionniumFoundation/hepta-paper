//! Existing service/SQLite/CAS owner tests with controlled authority observation.
use super::*;

#[test]
fn research_uses_post_authority_io_time_for_writer_lease_admission() {
    let temp = Temp::new();
    let config = configuration(&temp);
    let mut qualification = TestQualification::valid();
    qualification.expires_at = 1_000_000;
    qualification.post_io_delta_ms = 100_000;
    let mut clock = || Ok(1_000);
    assert!(run_with_clock(config, &qualification, &mut clock).is_err());
    let attempts = temp.0.join("attempts");
    assert!(!attempts.exists() || std::fs::read_dir(attempts).unwrap().next().is_none());
}

#[test]
fn research_authority_loss_after_preparation_keeps_cache_and_prevents_commit() {
    let temp = Temp::new();
    let config = configuration(&temp);
    let mut withdrawn = TestQualification::valid();
    withdrawn.reject_when_prepared = Some(temp.0.join("attempts"));
    let mut clock = || Ok(1_000);
    assert!(run_with_clock(config.clone(), &withdrawn, &mut clock).is_err());
    let records = || {
        std::fs::read_dir(temp.0.join("attempts"))
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                (
                    path.file_name().unwrap().to_owned(),
                    std::fs::read(&path).unwrap(),
                )
            })
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    let retained = records();
    assert!(retained.keys().any(|name| {
        std::path::Path::new(name)
            .extension()
            .is_some_and(|extension| extension == "prepared")
    }));
    assert!(run_with_clock(config.clone(), &withdrawn, &mut clock).is_err());
    assert_eq!(records(), retained);
    let fresh = TestQualification::valid();
    let recovered = run_with_clock(config.clone(), &fresh, &mut clock).unwrap();
    assert!(recovered.control_plane_receipt.commit_receipts[0].newly_committed);
    assert_eq!(
        records(),
        retained,
        "recover through original cache, not another dispatch"
    );
    let replay = run_with_clock(config, &fresh, &mut clock).unwrap();
    assert!(!replay.control_plane_receipt.commit_receipts[0].newly_committed);
    assert_eq!(
        recovered.control_plane_receipt.commit_receipts[0].result_hash,
        replay.control_plane_receipt.commit_receipts[0].result_hash
    );
    assert!(
        !replay.release_authority && !replay.submission_authority && !replay.production_activation
    );
}
