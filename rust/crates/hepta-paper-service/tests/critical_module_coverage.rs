use hepta_paper_service::critical_module_coverage::{
    CriticalModuleCoverageOptions, inspect_critical_module_coverage_v1,
    parse_critical_module_coverage_arguments,
};
use std::path::Path;

#[test]
fn parser_rejects_unpaired_evidence_and_relative_roots() {
    assert!(
        parse_critical_module_coverage_arguments(&[
            "--evidence".into(),
            "/tmp/evidence.json".into(),
        ])
        .is_err()
    );
    assert!(
        parse_critical_module_coverage_arguments(&["--root".into(), "relative".into(),]).is_err()
    );
}

#[test]
fn missing_node_evidence_is_explicitly_blocked() {
    let report = inspect_critical_module_coverage_v1(
        &CriticalModuleCoverageOptions::default(),
        Path::new("/tmp/workspace"),
    )
    .unwrap();
    assert_eq!(report["ok"], false);
    assert!(
        report["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == "critical_module_coverage_node_evidence_required")
    );
}
