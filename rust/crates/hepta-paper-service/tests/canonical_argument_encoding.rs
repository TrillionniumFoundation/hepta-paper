//! Invalid POSIX argument bytes are refused before opening product state.
use std::{ffi::OsString, os::unix::ffi::OsStringExt, process::Command};

#[test]
fn nonunicode_ordinary_argument_refuses_before_database_or_authority_io() {
    let result = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .args(["verify", "store", "--"])
        .arg(OsString::from_vec(vec![0xff]))
        .env_clear()
        .env("PATH", "/nonexistent")
        .env(
            "HEPTA_PAPER_WORKSPACE_ROOT",
            "/nonexistent/never-open-product-root",
        )
        .env(
            "HEPTA_PAPER_RUNTIME_ROOT",
            "/nonexistent/never-open-product-state",
        )
        .output()
        .unwrap();
    assert_eq!(result.status.code(), Some(1));
    assert!(result.stdout.is_empty());
    assert_eq!(
        String::from_utf8(result.stderr).unwrap().trim_end(),
        "hepta-paper-rust: native_command_argument_encoding_invalid"
    );
}
