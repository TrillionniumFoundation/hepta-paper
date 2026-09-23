use hepta_control_plane::{
    ControlPlaneError, ControlPlaneRunFailurePhaseV1, ControlPlaneRunInspectionV1,
};
use serde_json::{Value, json};

use crate::ServiceError;

pub(crate) fn map_control_run_error(
    error: ControlPlaneError,
    inspection: Option<&ControlPlaneRunInspectionV1>,
) -> ServiceError {
    if error == ControlPlaneError::RunRequiresInspection {
        ServiceError::ControlRequiresInspection {
            inspection: inspection.cloned().map(Box::new),
        }
    } else {
        ServiceError::Control
    }
}

/// Projects an actual service inspection failure in a bounded error/source chain.
///
/// Only the typed `ServiceError::ControlRequiresInspection` variant is recognized;
/// error text and caller JSON are not evidence. The returned diagnostic contains
/// no worker output, paths, credentials or claimed commit outcome. It does not
/// persist charges, authorize recovery or stop a newly constructed service owner.
/// Other errors return `None` so existing CLI error bytes remain unchanged.
/// At most 32 error nodes are inspected, including the supplied error itself.
#[must_use]
pub fn service_control_inspection_report_v1(
    error: &(dyn std::error::Error + 'static),
) -> Option<Value> {
    let mut current = Some(error);
    for _ in 0..32 {
        let source = current?;
        if let Some(ServiceError::ControlRequiresInspection { inspection }) =
            source.downcast_ref::<ServiceError>()
        {
            let diagnostic = inspection.as_ref().map(|inspection| {
                json!({
                    "snapshotHash": inspection.snapshot_hash(),
                    "planHash": inspection.plan_hash(),
                    "reservationIds": inspection.reservation_ids(),
                    "phase": match inspection.phase() {
                        ControlPlaneRunFailurePhaseV1::Execution => "execution",
                        ControlPlaneRunFailurePhaseV1::Finalization => "finalization",
                    },
                    "cause": inspection.cause().map(|cause| cause.to_string()),
                })
            });
            return Some(json!({
                "version": 1,
                "kind": "HeptaServiceControlInspectionRequiredV1",
                "code": "service_control_requires_inspection",
                "inspectionRequired": true,
                "retryable": false,
                "diagnostic": diagnostic,
                "scope": "in_memory_runtime_diagnostic_not_durable_resource_recovery",
            }));
        }
        current = source.source();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_diagnostic_never_downgrades_inspection_to_an_ordinary_error() {
        let error = map_control_run_error(ControlPlaneError::RunRequiresInspection, None);
        assert!(matches!(
            error,
            ServiceError::ControlRequiresInspection { inspection: None }
        ));
        let report = service_control_inspection_report_v1(&error).expect("inspection report");
        assert_eq!(report["inspectionRequired"], true);
        assert_eq!(report["retryable"], false);
        assert!(report["diagnostic"].is_null());
        assert!(report.get("committed").is_none());
        assert!(report.get("authorityOutcome").is_none());
    }

    #[test]
    fn old_errors_and_inspection_text_without_typed_error_are_not_reclassified() {
        let ordinary = map_control_run_error(ControlPlaneError::FrontierInvalid, None);
        assert!(matches!(ordinary, ServiceError::Control));
        assert_eq!(ordinary.to_string(), "control-plane operation rejected");
        assert!(service_control_inspection_report_v1(&ordinary).is_none());
        let copied_text = std::io::Error::other("service_control_requires_inspection");
        assert!(service_control_inspection_report_v1(&copied_text).is_none());
    }

    #[derive(Debug)]
    struct CyclicError;

    impl std::fmt::Display for CyclicError {
        fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            output.write_str("cyclic fixture")
        }
    }

    impl std::error::Error for CyclicError {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(self)
        }
    }

    #[test]
    fn cyclic_caller_error_chain_is_bounded() {
        assert!(service_control_inspection_report_v1(&CyclicError).is_none());
    }
}
