use super::*;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct ManifestFixture {
    root: PathBuf,
    path: PathBuf,
}
impl ManifestFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "hepta-socket-cli-manifest-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("manifest.json");
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../paper-core/config/autonomous-research-state-databases.v1.json");
        fs::copy(source, &path).unwrap();
        Self { root, path }
    }
}
impl Drop for ManifestFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn reconciliation_preserves_actual_socket_error_and_completed_work() {
    let mut cause = error("local_state_authority_client_read_failed");
    cause.details = json!({
        "transport":"local-state-authority-socket-v1",
        "requestBytesSent":57,
        "requestDelivery":"sent",
        "authorityOutcome":"unknown",
        "inspectionRequired":true,
        "initialInventoryHash":"initial",
        "reconciledInventoryHash":"reconciled",
        "databaseScopeHash":"scope",
        "reconciliations":[{"completed":"one"}],
        "pendingInspections":[{"pending":"two"}],
    });
    let report = reconciliation_failure(&cause);
    assert_eq!(report["authorityError"]["code"], cause.code);
    assert_eq!(report["authorityError"]["details"], cause.details);
    assert_eq!(report["authorityError"]["retryable"], false);
    assert_eq!(report["reconciliations"], cause.details["reconciliations"]);
    assert_eq!(
        report["pendingInspections"],
        cause.details["pendingInspections"]
    );
    assert!(report.get("committed").is_none());
    assert!(matches!(
        report_output(StateBackupActionV1::ReconcileAndRenew, report),
        StateBackupCliOutputV1::Report { exit_code: 2, .. }
    ));
}

#[test]
fn reconciliation_process_failure_keeps_original_shape_and_exit_class() {
    let cause = error("process_failure");
    let report = reconciliation_failure(&cause);
    assert_eq!(
        report,
        json!({"version":1,"kind":"AutonomousResearchStateReconcileAndRenewReceipt",
            "status":"autonomous_research_state_reconcile_and_renew_blocked",
            "businessDmlReplayed":false,"backupAttempted":false,
            "initialInventoryHash":null,"reconciledInventoryHash":null,
            "databaseScopeHash":null,"reconciliations":[],"pendingInspections":[],
            "renewalReceipt":null,"blockers":["process_failure"]})
    );
    assert!(matches!(
        report_output(StateBackupActionV1::ReconcileAndRenew, report),
        StateBackupCliOutputV1::Report { exit_code: 2, .. }
    ));
}

#[test]
fn socket_post_action_manifest_drift_keeps_success_or_unknown_operation_report() {
    let mut cause = error("local_state_authority_client_read_failed");
    cause.details = json!({
        "transport":"local-state-authority-socket-v1",
        "requestBytesSent":57,"requestDelivery":"sent",
        "authorityOutcome":"unknown","inspectionRequired":true,
    });
    let success = json!({"status":"autonomous_research_state_reconcile_and_renew_complete",
        "observedResult":"retained"});
    for (operation, expected_before) in [(success, 0), (reconciliation_failure(&cause), 2)] {
        let fixture = ManifestFixture::new();
        let manifest = ManifestFile::load(&fixture.path).unwrap();
        let before = complete_socket_action(
            StateBackupActionV1::ReconcileAndRenew,
            operation.clone(),
            &manifest,
        );
        match before {
            StateBackupCliOutputV1::Report { report, exit_code } => {
                assert_eq!(report, operation);
                assert_eq!(exit_code, expected_before);
            }
            StateBackupCliOutputV1::Help(_) => panic!("unexpected help"),
        }
        // Real observed-file drift, not a caller-supplied boolean failure.
        fs::write(&fixture.path, b"{\"changed\":true}").unwrap();
        let actual_error = manifest.assert_current().unwrap_err();
        match complete_socket_action(
            StateBackupActionV1::ReconcileAndRenew,
            operation.clone(),
            &manifest,
        ) {
            StateBackupCliOutputV1::Report { report, exit_code } => {
                assert_eq!(exit_code, 2);
                assert_eq!(
                    report["status"],
                    "autonomous_research_state_backup_socket_inspection_required"
                );
                assert_eq!(report["operationReport"], operation);
                assert_eq!(report["error"]["code"], actual_error.code);
                assert_eq!(report["error"]["details"], actual_error.details);
                assert_eq!(report["retryable"], false);
                assert_eq!(report["inspectionRequired"], true);
                assert!(report.get("committed").is_none());
                assert!(report.get("authorityOutcome").is_none());
            }
            StateBackupCliOutputV1::Help(_) => panic!("unexpected help"),
        }
    }
}
