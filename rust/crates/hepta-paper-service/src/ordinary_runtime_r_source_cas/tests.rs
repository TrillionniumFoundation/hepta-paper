use super::*;
use std::{fs, time::SystemTime};

#[test]
fn original_grammar_controls_and_resource_bounds_precede_root_selection() {
    let cancelled = Arc::new(AtomicBool::new(true));
    assert_eq!(
        inspect_ordinary_runtime_r_source_cas_v1(&["--help".into()], cancelled).unwrap_err(),
        "r_runtime_source_cas_cancelled"
    );
    assert_eq!(
        run(
            &["--help".into()],
            &AtomicBool::new(false),
            Instant::now() - Duration::from_secs(1)
        )
        .unwrap_err(),
        "native_inventory_deadline_exceeded"
    );
    assert_eq!(
        inspect_ordinary_runtime_r_source_cas_v1(
            &["--help".into(), "--help".into()],
            Arc::new(AtomicBool::new(false))
        )
        .unwrap_err(),
        "duplicate_cli_option:--help"
    );
    assert_eq!(
        inspect_ordinary_runtime_r_source_cas_v1(
            &["--root=".into()],
            Arc::new(AtomicBool::new(false))
        )
        .unwrap_err(),
        "empty_cli_option_value:--root"
    );
    assert_eq!(
        inspect_ordinary_runtime_r_source_cas_v1(
            &["--root".into(), "x".repeat(65537)],
            Arc::new(AtomicBool::new(false))
        )
        .unwrap_err(),
        "r_runtime_source_cas_argument_limit_exceeded"
    );
    let help = inspect_ordinary_runtime_r_source_cas_v1(
        &["--action=wrong".into(), "--help".into()],
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    assert_eq!(help.exit_code, 0);
    assert!(help.stderr.is_empty());
    assert_eq!(help.stdout, format!("{USAGE}\n").as_bytes());
}

#[test]
fn bounded_serializer_reserves_newline_and_rechecks_the_retained_status_epoch() {
    let unique = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "hepta-r-normal-serializer-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir(&root).unwrap();
    let cancelled = AtomicBool::new(false);
    let deadline = Instant::now() + Duration::from_secs(120);
    let observed = inspect_retained_status_v1(&root, &cancelled, deadline).unwrap();
    let mut writer = BoundedReportWriter {
        bytes: Vec::new(),
        observed: &observed,
        cancelled: &cancelled,
        deadline,
    };
    assert!(writer.write_all(&vec![b'x'; MAX_OUTPUT_BYTES]).is_err());
    assert!(writer.bytes.is_empty());
    writer.write_all(b"ok").unwrap();
    writer.observed.assert_current().unwrap();
    fs::create_dir(root.join("runtime-images")).unwrap();
    assert!(writer.observed.assert_current().is_err());
    drop(writer);
    drop(observed);
    fs::remove_dir_all(root).unwrap();
}
