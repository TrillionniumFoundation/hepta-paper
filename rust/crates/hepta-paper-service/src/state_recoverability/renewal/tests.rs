use super::*;

fn socket_error(sent: usize) -> SqliteMutationCoordinatorError {
    let mut cause = error("local_state_authority_client_read_failed");
    cause.details = json!({
        "transport":"local-state-authority-socket-v1",
        "requestBytesSent":sent,
        "requestDelivery":if sent == 0 { "not_sent" } else { "sent" },
        "authorityOutcome":if sent == 0 { "not_invoked" } else { "unknown" },
        "inspectionRequired":sent > 0,
        "recoverableStagingPath":"/retained/staging",
    });
    cause
}

#[test]
fn actual_socket_failure_keeps_original_delivery_details_without_commit_inference() {
    for sent in [0, 41] {
        let cause = socket_error(sent);
        for report in [
            backup_failure(&cause),
            drill_failure(&cause, Path::new("/bundle")),
        ] {
            assert_eq!(report["authorityError"]["code"], cause.code);
            assert_eq!(report["authorityError"]["details"], cause.details);
            assert_eq!(report["authorityError"]["retryable"], false);
            assert!(report.get("committed").is_none());
            assert!(
                report["authorityError"]["details"]
                    .get("committed")
                    .is_none()
            );
        }
    }
}

#[test]
fn legacy_errors_keep_the_exact_original_report_shape() {
    let cause = error("legacy_failure");
    assert_eq!(
        backup_failure(&cause),
        json!({"version":1,"kind":"AutonomousResearchStateBackupReceipt",
            "status":"autonomous_research_state_backup_blocked",
            "blockers":["legacy_failure"],"recoverableStagingPath":null})
    );
    assert_eq!(
        drill_failure(&cause, Path::new("/bundle")),
        json!({"version":1,"kind":"AutonomousResearchStateRestoreDrillReceipt",
            "status":"autonomous_research_state_restore_drill_blocked",
            "blockers":["legacy_failure"],"bundlePath":"/bundle",
            "bundleManifestHash":null,"authorityCurrentHeadReceiptHash":null})
    );
    let mut unrelated = socket_error(41);
    unrelated.details["transport"] = json!("process-v1");
    assert!(backup_failure(&unrelated).get("authorityError").is_none());
    assert!(
        drill_failure(&unrelated, Path::new("/bundle"))
            .get("authorityError")
            .is_none()
    );
}

#[test]
fn renewal_keeps_unknown_backup_and_drill_failures_in_the_actual_nested_reports() {
    let cause = socket_error(41);
    let backup = backup_failure(&cause);
    let report = blocked(vec![cause.code.clone()], backup.clone(), Value::Null);
    assert_eq!(report["backupReceipt"], backup);
    assert_eq!(
        report["backupReceipt"]["authorityError"]["details"]["authorityOutcome"],
        "unknown"
    );
    let drill = drill_failure(&cause, Path::new("/bundle"));
    let report = blocked(
        vec![cause.code],
        json!({"alreadyPublished":true}),
        drill.clone(),
    );
    assert_eq!(report["restoreDrillReceipt"], drill);
    assert_eq!(
        report["restoreDrillReceipt"]["authorityError"]["details"]["requestBytesSent"],
        41
    );
}
