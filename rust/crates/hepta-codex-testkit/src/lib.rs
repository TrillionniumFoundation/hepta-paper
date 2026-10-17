//! Deterministic Codex JSONL and process-failure fixtures.

#![forbid(unsafe_code)]

use std::{fmt, str::FromStr};

/// Named fault scenario emitted by the `fake-codex` binary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Scenario {
    Success,
    TurnFailed,
    MalformedJson,
    InvalidUtf8,
    DuplicateTerminal,
    MissingTerminal,
    UnknownTerminal,
    EventAfterTerminal,
    ConflictingThreadId,
    BlankLine,
    OversizedLine,
}

impl Scenario {
    /// Stable CLI spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::TurnFailed => "turn-failed",
            Self::MalformedJson => "malformed-json",
            Self::InvalidUtf8 => "invalid-utf8",
            Self::DuplicateTerminal => "duplicate-terminal",
            Self::MissingTerminal => "missing-terminal",
            Self::UnknownTerminal => "unknown-terminal",
            Self::EventAfterTerminal => "event-after-terminal",
            Self::ConflictingThreadId => "conflicting-thread-id",
            Self::BlankLine => "blank-line",
            Self::OversizedLine => "oversized-line",
        }
    }

    /// Process exit status used by the fake binary.
    #[must_use]
    pub const fn exit_code(self) -> i32 {
        match self {
            Self::TurnFailed => 1,
            Self::MalformedJson | Self::InvalidUtf8 => 2,
            _ => 0,
        }
    }

    /// Exact stdout bytes for the scenario.
    #[must_use]
    pub fn stdout(self) -> Vec<u8> {
        match self {
            Self::Success => jsonl(&[
                r#"{"type":"thread.started","thread_id":"thread-1"}"#,
                r#"{"type":"turn.started"}"#,
                r#"{"type":"item.started","item":{"id":"item-1","type":"agent_message"}}"#,
                r#"{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"done"}}"#,
                r#"{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":3,"output_tokens":5,"reasoning_output_tokens":2}}"#,
            ]),
            Self::TurnFailed => jsonl(&[
                r#"{"type":"thread.started","thread_id":"thread-1"}"#,
                r#"{"type":"turn.started"}"#,
                r#"{"type":"error","message":"provider failure"}"#,
                r#"{"type":"turn.failed","error":{"message":"provider failure"}}"#,
            ]),
            Self::MalformedJson => {
                let mut bytes = standard_prefix();
                bytes.extend_from_slice(b"{not-json}\n");
                bytes
            }
            Self::InvalidUtf8 => {
                let mut bytes = standard_prefix();
                bytes.extend_from_slice(&[0xff, b'\n']);
                bytes
            }
            Self::DuplicateTerminal => jsonl(&[
                r#"{"type":"thread.started","thread_id":"thread-1"}"#,
                r#"{"type":"turn.started"}"#,
                r#"{"type":"turn.completed"}"#,
                r#"{"type":"turn.completed"}"#,
            ]),
            Self::MissingTerminal => standard_prefix(),
            Self::UnknownTerminal => jsonl(&[
                r#"{"type":"thread.started","thread_id":"thread-1"}"#,
                r#"{"type":"turn.started"}"#,
                r#"{"type":"turn.cancelled"}"#,
            ]),
            Self::EventAfterTerminal => jsonl(&[
                r#"{"type":"thread.started","thread_id":"thread-1"}"#,
                r#"{"type":"turn.started"}"#,
                r#"{"type":"turn.completed"}"#,
                r#"{"type":"error","message":"late"}"#,
            ]),
            Self::ConflictingThreadId => jsonl(&[
                r#"{"type":"thread.started","thread_id":"thread-1"}"#,
                r#"{"type":"turn.started","thread_id":"thread-2"}"#,
                r#"{"type":"turn.completed"}"#,
            ]),
            Self::BlankLine => {
                let mut bytes = standard_prefix();
                bytes.extend_from_slice(b"\n");
                bytes.extend_from_slice(b"{\"type\":\"turn.completed\"}\n");
                bytes
            }
            Self::OversizedLine => {
                let mut bytes = standard_prefix();
                bytes.extend_from_slice(b"{\"type\":\"item.updated\",\"payload\":\"");
                bytes.extend(std::iter::repeat_n(b'x', 2 * 1024 * 1024));
                bytes.extend_from_slice(b"\"}\n{\"type\":\"turn.completed\"}\n");
                bytes
            }
        }
    }
}

impl fmt::Display for Scenario {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for Scenario {
    type Err = ParseScenarioError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "success" => Ok(Self::Success),
            "turn-failed" => Ok(Self::TurnFailed),
            "malformed-json" => Ok(Self::MalformedJson),
            "invalid-utf8" => Ok(Self::InvalidUtf8),
            "duplicate-terminal" => Ok(Self::DuplicateTerminal),
            "missing-terminal" => Ok(Self::MissingTerminal),
            "unknown-terminal" => Ok(Self::UnknownTerminal),
            "event-after-terminal" => Ok(Self::EventAfterTerminal),
            "conflicting-thread-id" => Ok(Self::ConflictingThreadId),
            "blank-line" => Ok(Self::BlankLine),
            "oversized-line" => Ok(Self::OversizedLine),
            _ => Err(ParseScenarioError),
        }
    }
}

/// Unknown fake-Codex scenario.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ParseScenarioError;

impl fmt::Display for ParseScenarioError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("unknown fake-codex scenario")
    }
}

impl std::error::Error for ParseScenarioError {}

fn standard_prefix() -> Vec<u8> {
    jsonl(&[
        r#"{"type":"thread.started","thread_id":"thread-1"}"#,
        r#"{"type":"turn.started"}"#,
    ])
}

fn jsonl(lines: &[&str]) -> Vec<u8> {
    let mut output = lines.join("\n").into_bytes();
    output.push(b'\n');
    output
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::Scenario;

    #[test]
    fn scenario_names_round_trip() {
        for scenario in [
            Scenario::Success,
            Scenario::TurnFailed,
            Scenario::MalformedJson,
            Scenario::InvalidUtf8,
            Scenario::DuplicateTerminal,
            Scenario::MissingTerminal,
            Scenario::UnknownTerminal,
            Scenario::EventAfterTerminal,
            Scenario::ConflictingThreadId,
            Scenario::BlankLine,
            Scenario::OversizedLine,
        ] {
            assert_eq!(Scenario::from_str(scenario.as_str()), Ok(scenario));
        }
    }
}
