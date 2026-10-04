use super::*;
use serde_json::json;

#[test]
fn snapshot_url_is_fixed_and_response_status_identity_and_size_are_bounded() {
    let entry = json!({"package":"demo","version":"1.0.0","file":"demo_1.0.0.tar.gz"});
    let url = snapshot_url(&entry).unwrap();
    let mut wire = b"archive\nHEPTA_R_SOURCE_HTTP_V1\n404\nignored\n".to_vec();
    wire.extend_from_slice(format!("\nHEPTA_R_SOURCE_HTTP_V1\n200\n{url}\n").as_bytes());
    assert_eq!(
        snapshot_response(wire.clone(), &url).unwrap(),
        b"archive\nHEPTA_R_SOURCE_HTTP_V1\n404\nignored\n"
    );
    for status in ["000", "199", "301", "307", "401", "404", "500", "20X"] {
        let bytes = format!("body\nHEPTA_R_SOURCE_HTTP_V1\n{status}\n{url}\n").into_bytes();
        assert!(snapshot_response(bytes, &url).is_err());
    }
    for bad in [
        "https://example.invalid/archive",
        "http://packagemanager.posit.co/archive",
        "https://packagemanager.posit.co/cran/latest/archive",
    ] {
        assert!(snapshot_response(wire.clone(), bad).is_err());
    }
    for field in ["package", "version", "file"] {
        for bad in [
            "../other",
            "x?query",
            "x#fragment",
            "x%2fother",
            "x/other",
            "-option",
        ] {
            let mut altered = entry.clone();
            altered[field] = json!(bad);
            assert!(snapshot_url(&altered).is_err(), "{field}: {bad}");
        }
    }
    let mut large = vec![b'x'; SNAPSHOT_ARCHIVE_BYTES as usize + 1];
    large.extend_from_slice(format!("\nHEPTA_R_SOURCE_HTTP_V1\n200\n{url}\n").as_bytes());
    assert_eq!(
        snapshot_response(large, &url).unwrap_err(),
        "r_runtime_source_cas_snapshot_size_exceeded"
    );
}

#[test]
fn snapshot_timeout_uses_existing_process_owner_after_stdout_eof() {
    let cancelled = AtomicBool::new(false);
    let mut execution = ArchiveExecution::new(&cancelled);
    let environment = EnvironmentPolicyV1::new("snapshot-test", ["PATH"], ["PATH"])
        .unwrap()
        .build(
            std::iter::empty(),
            &BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
        )
        .unwrap();
    let request = BoundedProcessRequestV1 {
        executable: fs::canonicalize("/bin/sh").unwrap(),
        arguments: vec![
            "-c".into(),
            "exec 1>&- 2>&-; trap '' TERM INT; sleep 30".into(),
        ],
        working_directory: fs::canonicalize(std::env::temp_dir()).unwrap(),
        environment,
        stdin: None,
    };
    let limits = ProcessLimitsV1 {
        timeout_ms: 50,
        termination_grace_ms: 10,
        cleanup_timeout_ms: 1000,
        poll_interval_ms: 5,
        maximum_stdin_bytes: 1,
        maximum_stdout_bytes: 1024,
        maximum_stderr_bytes: 1024,
        maximum_tail_bytes: 256,
    };
    assert_eq!(
        execution.capture(&request, limits, "snapshot").unwrap_err(),
        "r_runtime_source_cas_snapshot_timeout"
    );
    assert!(execution.cleanup_verified());
}
