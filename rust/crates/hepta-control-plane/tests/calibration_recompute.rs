use hepta_control_plane::{CalibrationObservationV1, CalibrationPolicyV1, assess_calibration_v1};

#[test]
fn calibration_receipt_recomputes_policy_and_observations() {
    let policy = CalibrationPolicyV1 {
        version: 1,
        minimum_samples: 1,
        maximum_p95_duration_error_ppm: 100_000,
        maximum_p95_cost_error_ppm: 100_000,
    };
    let observations = [CalibrationObservationV1 {
        observation_id: "one".into(),
        predicted_duration_micros: 11,
        actual_duration_micros: 10,
        predicted_cost_microusd: 0,
        actual_cost_microusd: 0,
    }];
    let report = assess_calibration_v1(&policy, &observations).expect("assessment");
    report.validate().expect("body integrity");
    report
        .verify_observations(&policy, &observations)
        .expect("exact recomputation");
    let mut stricter = policy.clone();
    stricter.maximum_p95_duration_error_ppm = 99_999;
    assert!(
        report
            .verify_observations(&stricter, &observations)
            .is_err()
    );
    let mut changed = observations.clone();
    changed[0].actual_duration_micros = 9;
    assert!(report.verify_observations(&policy, &changed).is_err());
    let mut tampered = report;
    tampered.accepted = false;
    assert!(tampered.validate().is_err());
}
