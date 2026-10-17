//! Execute the actual product target without supplying credentials or authority.
use std::process::Command;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_hepta-codex-broker")
}

#[test]
fn deployment_named_binary_has_a_non_effectful_help_entry() {
    assert_eq!(
        std::path::Path::new(binary()).file_name().unwrap(),
        "hepta-codex-broker"
    );
    for option in ["--help", "-h"] {
        let output = Command::new(binary()).arg(option).output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "usage: hepta-codex-broker <absolute-config.json>\n"
        );
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn missing_extra_and_relative_arguments_cannot_start_the_broker() {
    for arguments in [
        Vec::<&str>::new(),
        vec!["relative.json"],
        vec!["--unknown"],
        vec!["--help", "extra"],
        vec!["/missing/config.json", "extra"],
    ] {
        let output = Command::new(binary()).args(arguments).output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(error.contains("usage:") || error.contains("configuration path must be absolute"));
    }
}
