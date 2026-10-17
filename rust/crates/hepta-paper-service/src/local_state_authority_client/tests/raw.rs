use super::*;

#[test]
fn cli_wire_path_retains_request_and_receipt_object_order_without_value_round_trip() {
    let temp = Temp::new();
    let options = temp.options();
    let listener = UnixListener::bind(&options.socket_path).unwrap();
    let request = br#"{"version":1,"instances":[{"databaseRole":"native","databaseInstanceId":"db","nested":{"second":2,"first":1}}]}"#;
    let receipt = r#"{"version":1,"instances":[{"databaseRole":"native","databaseInstanceId":"db","nested":{"second":2,"first":1}}],"signature":"untrusted-transport-fixture"}"#;
    let worker = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut actual = Vec::new();
        stream.read_to_end(&mut actual).unwrap();
        let mut expected = request.to_vec();
        expected.push(b'\n');
        assert_eq!(actual, expected);
        let envelope = format!("{{\"receipt\":{receipt},\"ok\":true}}\n");
        for chunk in envelope.as_bytes().chunks(7) {
            stream.write_all(chunk).unwrap();
        }
    });
    let output =
        run_local_state_authority_client_json_v1(&[], request.as_slice(), &options).unwrap();
    assert_eq!(output.get(), receipt);
    assert_eq!(
        format_local_state_authority_client_json_output_v1(&output).unwrap(),
        format!("{receipt}\n")
    );
    // Returning a semantic Value remains available, but is explicitly not a
    // member-order-preserving wire representation.
    let value: Value = serde_json::from_str(receipt).unwrap();
    assert_ne!(serde_json::to_string(&value).unwrap(), receipt);
    worker.join().unwrap();
}

#[test]
fn raw_requests_keep_strict_validation_and_byte_limit_before_any_connection() {
    let temp = Temp::new();
    let mut options = temp.options();
    options.maximum_message_bytes = 1024;
    let listener = UnixListener::bind(&options.socket_path).unwrap();
    listener.set_nonblocking(true).unwrap();
    for bytes in [
        br#"{"instances":[{"x":1,"x":2}]}"#.as_slice(),
        b"{\"x\":\"\xff\"}",
        br#"{"x":1e999}"#,
        b"{} {}",
    ] {
        assert_eq!(
            request_local_state_authority_json_v1(bytes, &options)
                .unwrap_err()
                .to_string(),
            "local_state_authority_client_request_invalid"
        );
    }
    assert_eq!(
        request_local_state_authority_json_v1(&vec![b' '; 1025], &options)
            .unwrap_err()
            .to_string(),
        "local_state_authority_client_request_too_large"
    );
    let exactly_full = format!("{{\"pad\":\"{}\"}}", "x".repeat(1014));
    assert_eq!(exactly_full.len(), 1024);
    assert_eq!(
        request_local_state_authority_json_v1(exactly_full.as_bytes(), &options)
            .unwrap_err()
            .to_string(),
        "local_state_authority_client_request_too_large"
    );
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[test]
fn raw_response_never_bypasses_duplicate_validation_and_help_still_avoids_io() {
    let temp = Temp::new();
    let options = temp.options();
    let worker = server(
        &options,
        vec![br#"{"ok":true,"receipt":{"instances":[{"role":"a","role":"b"}]}}"#.to_vec()],
        json!({}),
    );
    assert_eq!(
        request_local_state_authority_json_v1(b"{}", &options)
            .unwrap_err()
            .to_string(),
        "local_state_authority_client_response_invalid"
    );
    worker.join().unwrap();
    let output = run_local_state_authority_client_json_v1(
        &["--help".into()],
        b"invalid".as_slice(),
        &options,
    )
    .unwrap();
    assert_eq!(
        format_local_state_authority_client_json_output_v1(&output).unwrap(),
        format!("{USAGE}\n")
    );
}

#[test]
fn semantic_api_keeps_nonobject_error_precedence_above_wire_length() {
    let temp = Temp::new();
    let mut options = temp.options();
    options.maximum_message_bytes = 1024;
    for request in [json!("x".repeat(2048)), json!(["x".repeat(2048)])] {
        assert_eq!(
            request_local_state_authority_v1(&request, &options)
                .unwrap_err()
                .to_string(),
            "local_state_authority_client_configuration_invalid"
        );
        assert_eq!(
            node_request(&request, &options)["error"],
            "local_state_authority_client_configuration_invalid"
        );
    }
}
