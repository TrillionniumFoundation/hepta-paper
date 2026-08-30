use std::{io::Cursor, process::Command};

use hepta_codex_event_stream::{DecodeError, StreamLimits, decode_stream};

fn run(scenario: &str) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_fake-codex"))
        .arg(scenario)
        .output()
        .expect("fake-codex must launch")
}

#[test]
fn success_scenario_is_a_valid_terminal_stream() {
    let output = run("success");
    assert!(output.status.success());
    let decoded = decode_stream(Cursor::new(output.stdout), StreamLimits::default())
        .expect("success fixture must decode");
    assert_eq!(decoded.thread_id, "thread-1");
    assert_eq!(decoded.event_count, 5);
}

#[test]
fn malformed_and_post_terminal_scenarios_fail_closed() {
    let malformed = run("malformed-json");
    assert!(matches!(
        decode_stream(Cursor::new(malformed.stdout), StreamLimits::default()),
        Err(DecodeError::InvalidJson { .. })
    ));

    let late = run("event-after-terminal");
    assert!(matches!(
        decode_stream(Cursor::new(late.stdout), StreamLimits::default()),
        Err(DecodeError::EventAfterTerminal { .. })
    ));
}

#[test]
fn oversized_scenario_is_rejected_at_the_byte_boundary() {
    let output = run("oversized-line");
    assert!(matches!(
        decode_stream(Cursor::new(output.stdout), StreamLimits::default()),
        Err(DecodeError::LineBytesExceeded { .. })
    ));
}
