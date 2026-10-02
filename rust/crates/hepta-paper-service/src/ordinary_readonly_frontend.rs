//! Ordinary read-only registry workers use their existing CLI owners in-process.
//! A deployment path observation does not grant portal or supervisor authority.
use crate::{
    journal_connector_coverage::{
        journal_connector_coverage_cli_v2, journal_connector_coverage_in_working_directory_v2,
        validate_journal_connector_coverage_cli_arguments_v2,
    },
    native_workspace::current_native_command_workspace_root_v1,
    supervisor_health::cli::{
        SupervisorHealthEntryV1, inspect_supervisor_health_command_in_working_directory_v1,
        inspect_supervisor_health_command_v1, validate_supervisor_health_cli_arguments_v1,
    },
};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OrdinaryReadonlyRouteV1 {
    JournalConnectorCoverage,
    AutonomousSupervisorHealth,
}

/// Exact native worker streams, including their trailing newline. The ordinary
/// registry dispatcher owns its separate exit-2 grammar refusals.
#[derive(Debug, Eq, PartialEq)]
pub struct OrdinaryReadonlyOutputV1 {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: i32,
}

fn refusal(error: impl std::fmt::Display) -> OrdinaryReadonlyOutputV1 {
    OrdinaryReadonlyOutputV1 {
        stdout: Vec::new(),
        stderr: format!("{error}\n").into_bytes(),
        exit_code: 1,
    }
}

fn encode(
    value: &serde_json::Value,
    pretty: bool,
    exit_code: i32,
    error: &str,
) -> OrdinaryReadonlyOutputV1 {
    let encoded = if pretty {
        serde_json::to_vec_pretty(value)
    } else {
        serde_json::to_vec(value)
    };
    match encoded {
        Ok(mut stdout) => {
            stdout.push(b'\n');
            OrdinaryReadonlyOutputV1 {
                stdout,
                stderr: Vec::new(),
                exit_code,
            }
        }
        Err(_) => refusal(error),
    }
}

pub fn inspect_ordinary_readonly_frontend_v1(
    route: OrdinaryReadonlyRouteV1,
    argv: &[String],
) -> OrdinaryReadonlyOutputV1 {
    // Both incumbent workers validate the complete grammar before help. Their
    // own parser still runs; a help token never skips unknown/duplicate errors.
    let help = match route {
        OrdinaryReadonlyRouteV1::JournalConnectorCoverage => {
            match validate_journal_connector_coverage_cli_arguments_v2(argv) {
                Ok(help) => help,
                Err(error) => return refusal(error),
            }
        }
        OrdinaryReadonlyRouteV1::AutonomousSupervisorHealth => {
            match validate_supervisor_health_cli_arguments_v1(
                argv,
                SupervisorHealthEntryV1::Standalone,
            ) {
                Ok(help) => help,
                Err(error) => return refusal(error),
            }
        }
    };
    let workspace = if help {
        None
    } else {
        match current_native_command_workspace_root_v1(None) {
            Ok(root) => Some(root),
            Err(error) => return refusal(error),
        }
    };
    match route {
        OrdinaryReadonlyRouteV1::JournalConnectorCoverage => {
            let mut environment = BTreeMap::new();
            if !help {
                for key in [
                    "HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY",
                    "HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY_HASH",
                    "HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE",
                    "HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE_HASH",
                ] {
                    match std::env::var(key) {
                        Ok(value) => {
                            environment.insert(key.to_owned(), value);
                        }
                        Err(std::env::VarError::NotPresent) => {}
                        Err(std::env::VarError::NotUnicode(_)) => {
                            return refusal(format!(
                                "journal_connector_coverage_environment_encoding_invalid:{key}"
                            ));
                        }
                    }
                }
            }
            let result = match workspace {
                Some(root) => {
                    journal_connector_coverage_in_working_directory_v2(argv, &environment, &root)
                }
                None => journal_connector_coverage_cli_v2(argv, &environment),
            };
            match result {
                Ok(output) => encode(
                    &output.value,
                    true,
                    output.exit_code,
                    "journal_connector_coverage_output_encoding_failed",
                ),
                Err(error) => refusal(error),
            }
        }
        OrdinaryReadonlyRouteV1::AutonomousSupervisorHealth => {
            let result = match workspace {
                Some(root) => inspect_supervisor_health_command_in_working_directory_v1(
                    argv,
                    SupervisorHealthEntryV1::Standalone,
                    &root,
                ),
                None => {
                    inspect_supervisor_health_command_v1(argv, SupervisorHealthEntryV1::Standalone)
                }
            };
            match result {
                Ok(output) => encode(
                    &output.report,
                    false,
                    output.exit_code,
                    "health_report_serialization_failed",
                ),
                Err(error) => refusal(error),
            }
        }
    }
}
