//! Actual native executable checks that cannot contact a production authority.
use std::{
    io::Write,
    process::{Command, Stdio},
};
fn run(args: &[&str], stdin: &[u8]) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hepta-paper-state-authority-client"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(stdin).unwrap();
    child.wait_with_output().unwrap()
}
#[test]
fn fixed_native_cli_help_and_input_errors() {
    let output = run(&["--help"], b"");
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert_eq!(
        output.stdout,
        b"Usage: hepta-paper-state-authority-client < request.json\n"
    );
    for (args, input, error) in [
        (
            vec!["--help", "--socket-path=/tmp/other"],
            b"".as_slice(),
            "unknown_cli_option:--socket-path",
        ),
        (
            vec!["--timeout=1"],
            b"".as_slice(),
            "unknown_cli_option:--timeout",
        ),
        (
            vec![],
            b"{\"kind\":1,\"kind\":2}".as_slice(),
            "local_state_authority_client_request_invalid",
        ),
        (
            vec![],
            b"[]".as_slice(),
            "local_state_authority_client_configuration_invalid",
        ),
    ] {
        let output = run(&args, input);
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        assert_eq!(
            String::from_utf8(output.stderr).unwrap(),
            format!("{error}\n")
        );
    }
}
