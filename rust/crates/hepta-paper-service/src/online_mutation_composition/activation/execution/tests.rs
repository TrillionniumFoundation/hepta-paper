use super::*;
use hepta_cutover::DurableCutoverError;

#[test]
fn finalized_result_survives_cutover_postcheck_failure_as_committed() {
    let value = json!({"status":"automation_runtime_reconciled","reconciledNodeCount":3});
    let failure = finish(
        Some(Ok(value.clone())),
        Err(DurableCutoverError::IdentityChanged),
    )
    .unwrap_err();
    assert_eq!(failure.code, fail("native_cutover_postcheck_failed").code);
    assert_eq!(failure.details["committed"], true);
    assert_eq!(failure.details["businessResult"], value);
}

#[test]
fn rich_business_failure_survives_the_outer_application_error() {
    for committed in [false, true] {
        let mut failure = error("fixture_native_business_error");
        failure.details = json!({"committed":committed,"reservationId":"reservation:fixture",
            "reservationReceiptHash":"fixture-reserve-hash","finalizationReceiptHash":"fixture-finalize-hash"});
        failure.state_recoverability_fatal = committed;
        failure.state_recoverability_deferred = !committed;
        failure.retryable = !committed;
        let expected = failure.projection();
        let result = finish(
            Some(Err(failure)),
            Err(DurableCutoverError::Application(
                "fixture_native_business_error".into(),
            )),
        )
        .unwrap_err();
        assert_eq!(result.projection(), expected);
    }
}

#[test]
fn callback_not_entered_never_returns_a_business_success() {
    assert!(finish(None, Err(DurableCutoverError::StaleWriter)).is_err());
    assert_eq!(
        finish(None, Ok(())).unwrap_err().code,
        fail("native_execution_missing").code
    );
    let result = json!({"status":"fixture_finalized"});
    assert_eq!(finish(Some(Ok(result.clone())), Ok(())).unwrap(), result);
}
