use super::*;
use hepta_cutover::{DurableCutoverModeV1, DurableCutoverPhaseV1};

fn state() -> DurableCutoverStateV1 {
    DurableCutoverStateV1 {
        version: 1,
        cutover_id: "native-transfer".into(),
        database_path: "/srv/runtime/hepta-paper.sqlite".into(),
        mode: DurableCutoverModeV1::Production,
        phase: DurableCutoverPhaseV1::Canary,
        old_writer_id: "node".into(),
        new_writer_id: "rust".into(),
        writer_id: Some("rust".into()),
        generation: 3,
        token: "native-transfer:3".into(),
        revision: 4,
        shadow_cases: 1,
        shadow_mismatches: 0,
        canary_scopes: vec![RECONCILIATION_WRITER_SCOPE_V1.into()],
        production_activation: true,
        activation_receipt_hash: Some("observed-receipt".into()),
    }
}
#[test]
fn transferred_business_failure_preserves_commit_and_recovery_details_without_auto_retry() {
    for committed in [json!(false), json!(true), Value::Null] {
        let mut cause = error("fixture_business_refused");
        cause.details = json!({"committed":committed,"reservationId":"actual-reservation"});
        cause.state_recoverability_fatal = committed == true;
        cause.state_recoverability_deferred = committed == false;
        cause.retryable = true;
        let expected = cause.projection();
        let failure = after_transfer(Err(cause), &state()).unwrap_err();
        assert_eq!(failure.details["businessError"], expected);
        assert_eq!(failure.details["committed"], committed);
        assert_eq!(failure.details["reservationId"], "actual-reservation");
        assert_eq!(failure.details["cutoverCommitted"], true);
        assert_eq!(failure.details["productionActivationPerformed"], true);
        assert_eq!(failure.code, "fixture_business_refused");
        assert_eq!(failure.state_recoverability_fatal, committed == true);
        assert_eq!(failure.state_recoverability_deferred, committed == false);
        assert!(!failure.retryable);
    }
}
#[test]
fn unresolved_lower_transfer_never_claims_rollback_or_dispatches_business() {
    let failure = unresolved_transfer(hepta_cutover::DurableCutoverError::RevisionConflict);
    assert_eq!(failure.details["cutoverCommitted"], Value::Null);
    assert_eq!(failure.details["cutoverOutcome"], "requires_inspection");
    assert_eq!(failure.details["businessExecutionStarted"], false);
    assert!(!failure.retryable);
}
#[test]
fn successful_transfer_keeps_both_observed_state_and_business_result() {
    let business = json!({"status":"automation_runtime_reconciled"});
    let result = after_transfer(Ok(business.clone()), &state()).unwrap();
    assert_eq!(result["businessResult"], business);
    assert_eq!(result["cutoverState"], json!(state()));
    assert_eq!(result["cutoverCommitted"], true);
    assert_eq!(result["nodeRetirementVerified"], false);
}
