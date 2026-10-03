//! The real binary exposes the same typed names used by its dispatcher.
use hepta_paper_service::cli_commands::CommandV1;
use std::process::Command;
#[test]
fn ordinary_binary_help_json_is_the_compiled_catalog() {
    let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
        .arg("--help-json")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["kind"], "RustCommandCatalogV1");
    assert_eq!(
        value["commands"],
        serde_json::json!(
            CommandV1::ALL
                .iter()
                .map(|command| command.name())
                .collect::<Vec<_>>()
        )
    );
}
#[test]
fn catalog_mode_does_not_accept_extra_arguments_or_unknown_commands() {
    for args in [
        vec!["--help-json", "run"],
        vec!["not-a-command"],
        vec!["RUN"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_hepta-paper-rust"))
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
    }
}
