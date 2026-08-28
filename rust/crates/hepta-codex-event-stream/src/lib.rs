//! Bounded, fail-closed decoder for `codex exec --json` JSONL output.

#![forbid(unsafe_code)]

use std::{
    collections::BTreeSet,
    io::{self, BufRead, BufReader, Read},
    str::FromStr,
};

use hepta_codex_protocol::{Sha256Digest, TerminalEventKind, TokenUsage};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Resource limits applied before an event can influence broker state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StreamLimits {
    pub maximum_total_bytes: usize,
    pub maximum_line_bytes: usize,
    pub maximum_event_count: usize,
}

impl Default for StreamLimits {
    fn default() -> Self {
        Self {
            maximum_total_bytes: 8 * 1024 * 1024,
            maximum_line_bytes: 1024 * 1024,
            maximum_event_count: 10_000,
        }
    }
}

impl StreamLimits {
    fn validate(self) -> Result<Self, DecodeError> {
        if self.maximum_total_bytes == 0
            || self.maximum_line_bytes == 0
            || self.maximum_event_count == 0
            || self.maximum_line_bytes > self.maximum_total_bytes
        {
            return Err(DecodeError::InvalidLimits);
        }
        Ok(self)
    }
}

/// Raw event classification retained for audit and forward compatibility.
#[derive(Clone, Debug, PartialEq)]
pub enum CodexEvent {
    ThreadStarted { thread_id: String, payload: Value },
    TurnStarted { payload: Value },
    ItemStarted { payload: Value },
    ItemUpdated { payload: Value },
    ItemCompleted { payload: Value },
    Error { payload: Value },
    Unknown { event_type: String, payload: Value },
    TurnCompleted {
        usage: Option<TokenUsage>,
        payload: Value,
    },
    TurnFailed { payload: Value },
}

/// Validated summary of a complete, terminal JSONL stream.
#[derive(Clone, Debug, PartialEq)]
pub struct DecodedStream {
    pub events: Vec<CodexEvent>,
    pub thread_id: String,
    pub terminal_event_kind: TerminalEventKind,
    pub usage: Option<TokenUsage>,
    pub raw_stream_hash: Sha256Digest,
    pub event_count: usize,
    pub total_bytes: usize,
    pub unknown_event_types: Vec<String>,
}

/// Decode a complete JSONL stream while enforcing byte, line and event limits.
pub fn decode_stream<R: Read>(reader: R, limits: StreamLimits) -> Result<DecodedStream, DecodeError> {
    let limits = limits.validate()?;
    let mut reader = BufReader::new(reader);
    let mut state = DecoderState::default();
    let mut stream_hasher = Sha256::new();
    let mut total_bytes = 0usize;
    let mut line_number = 0usize;

    while let Some(raw_line) = read_bounded_line(
        &mut reader,
        limits,
        line_number.saturating_add(1),
        &mut total_bytes,
    )? {
        line_number = line_number.saturating_add(1);
        if state.events.len() >= limits.maximum_event_count {
            return Err(DecodeError::EventCountExceeded {
                maximum: limits.maximum_event_count,
            });
        }
        stream_hasher.update(&raw_line);
        let content = strip_line_ending(&raw_line);
        if content.is_empty() {
            return Err(DecodeError::BlankLine { line: line_number });
        }
        let text = std::str::from_utf8(content)
            .map_err(|_| DecodeError::InvalidUtf8 { line: line_number })?;
        let payload: Value = serde_json::from_str(text).map_err(|error| DecodeError::InvalidJson {
            line: line_number,
            message: error.to_string(),
        })?;
        let object = payload
            .as_object()
            .ok_or(DecodeError::EventNotObject { line: line_number })?;
        let event_type = object
            .get("type")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 128)
            .ok_or(DecodeError::InvalidEventType { line: line_number })?
            .to_owned();
        state.accept(line_number, &event_type, payload)?;
    }

    state.finish(total_bytes, stream_hasher)
}

fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    limits: StreamLimits,
    line: usize,
    total_bytes: &mut usize,
) -> Result<Option<Vec<u8>>, DecodeError> {
    let mut output = Vec::new();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return if output.is_empty() {
                Ok(None)
            } else {
                Ok(Some(output))
            };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(buffer.len(), |index| index.saturating_add(1));
        let next_line_size = output.len().saturating_add(take);
        if next_line_size > limits.maximum_line_bytes {
            return Err(DecodeError::LineBytesExceeded {
                line,
                maximum: limits.maximum_line_bytes,
            });
        }
        let next_total = total_bytes.saturating_add(take);
        if next_total > limits.maximum_total_bytes {
            return Err(DecodeError::TotalBytesExceeded {
                maximum: limits.maximum_total_bytes,
            });
        }
        output.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        *total_bytes = next_total;
        if newline.is_some() {
            return Ok(Some(output));
        }
    }
}

fn strip_line_ending(raw_line: &[u8]) -> &[u8] {
    let without_newline = raw_line.strip_suffix(b"\n").unwrap_or(raw_line);
    without_newline
        .strip_suffix(b"\r")
        .unwrap_or(without_newline)
}

#[derive(Default)]
struct DecoderState {
    events: Vec<CodexEvent>,
    thread_id: Option<String>,
    turn_started: bool,
    terminal_event_kind: Option<TerminalEventKind>,
    usage: Option<TokenUsage>,
    unknown_event_types: BTreeSet<String>,
}

impl DecoderState {
    fn accept(
        &mut self,
        line: usize,
        event_type: &str,
        payload: Value,
    ) -> Result<(), DecodeError> {
        if self.terminal_event_kind.is_some() {
            return Err(DecodeError::EventAfterTerminal {
                line,
                event_type: event_type.to_owned(),
            });
        }
        let object = payload
            .as_object()
            .ok_or(DecodeError::EventNotObject { line })?;
        self.validate_thread_reference(line, object)?;
        let started_thread_id = if event_type == "thread.started" {
            Some(
                object
                    .get("thread_id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty() && value.len() <= 256)
                    .ok_or(DecodeError::InvalidThreadId { line })?
                    .to_owned(),
            )
        } else {
            None
        };
        let completed_usage = if event_type == "turn.completed" {
            parse_usage(line, object.get("usage"))?
        } else {
            None
        };
        let event = match event_type {
            "thread.started" => self.accept_thread_started(
                line,
                started_thread_id.ok_or(DecodeError::InvalidThreadId { line })?,
                payload,
            )?,
            "turn.started" => self.accept_turn_started(line, payload)?,
            "item.started" => {
                self.require_turn(line, event_type)?;
                CodexEvent::ItemStarted { payload }
            }
            "item.updated" => {
                self.require_turn(line, event_type)?;
                CodexEvent::ItemUpdated { payload }
            }
            "item.completed" => {
                self.require_turn(line, event_type)?;
                CodexEvent::ItemCompleted { payload }
            }
            "error" => {
                self.require_thread(line, event_type)?;
                CodexEvent::Error { payload }
            }
            "turn.completed" => {
                self.require_turn(line, event_type)?;
                self.terminal_event_kind = Some(TerminalEventKind::TurnCompleted);
                self.usage = completed_usage;
                CodexEvent::TurnCompleted {
                    usage: completed_usage,
                    payload,
                }
            }
            "turn.failed" => {
                self.require_turn(line, event_type)?;
                self.terminal_event_kind = Some(TerminalEventKind::TurnFailed);
                CodexEvent::TurnFailed { payload }
            }
            unknown if looks_terminal(unknown) => {
                return Err(DecodeError::UnknownTerminalEvent {
                    line,
                    event_type: unknown.to_owned(),
                });
            }
            unknown => {
                self.require_thread(line, unknown)?;
                self.unknown_event_types.insert(unknown.to_owned());
                CodexEvent::Unknown {
                    event_type: unknown.to_owned(),
                    payload,
                }
            }
        };
        self.events.push(event);
        Ok(())
    }

    fn accept_thread_started(
        &mut self,
        line: usize,
        thread_id: String,
        payload: Value,
    ) -> Result<CodexEvent, DecodeError> {
        if self.thread_id.is_some() || !self.events.is_empty() {
            return Err(DecodeError::DuplicateOrLateThreadStarted { line });
        }
        self.thread_id = Some(thread_id.clone());
        Ok(CodexEvent::ThreadStarted { thread_id, payload })
    }

    fn accept_turn_started(
        &mut self,
        line: usize,
        payload: Value,
    ) -> Result<CodexEvent, DecodeError> {
        self.require_thread(line, "turn.started")?;
        if self.turn_started {
            return Err(DecodeError::DuplicateTurnStarted { line });
        }
        self.turn_started = true;
        Ok(CodexEvent::TurnStarted { payload })
    }

    fn validate_thread_reference(
        &self,
        line: usize,
        object: &Map<String, Value>,
    ) -> Result<(), DecodeError> {
        let Some(reference) = object.get("thread_id") else {
            return Ok(());
        };
        let reference = reference
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .ok_or(DecodeError::InvalidThreadId { line })?;
        if let Some(expected) = &self.thread_id
            && reference != expected
        {
            return Err(DecodeError::ConflictingThreadId {
                line,
                expected: expected.clone(),
                observed: reference.to_owned(),
            });
        }
        Ok(())
    }

    fn require_thread(&self, line: usize, event_type: &str) -> Result<(), DecodeError> {
        if self.thread_id.is_none() {
            return Err(DecodeError::EventBeforeThread {
                line,
                event_type: event_type.to_owned(),
            });
        }
        Ok(())
    }

    fn require_turn(&self, line: usize, event_type: &str) -> Result<(), DecodeError> {
        self.require_thread(line, event_type)?;
        if !self.turn_started {
            return Err(DecodeError::EventBeforeTurn {
                line,
                event_type: event_type.to_owned(),
            });
        }
        Ok(())
    }

    fn finish(
        self,
        total_bytes: usize,
        stream_hasher: Sha256,
    ) -> Result<DecodedStream, DecodeError> {
        let thread_id = self.thread_id.ok_or(DecodeError::MissingThreadStarted)?;
        if !self.turn_started {
            return Err(DecodeError::MissingTurnStarted);
        }
        let terminal_event_kind = self
            .terminal_event_kind
            .ok_or(DecodeError::MissingTerminalEvent)?;
        let digest = format!("sha256:{}", hex::encode(stream_hasher.finalize()));
        let raw_stream_hash = Sha256Digest::from_str(&digest)
            .map_err(|_| DecodeError::InternalDigestConstruction)?;
        let event_count = self.events.len();
        Ok(DecodedStream {
            events: self.events,
            thread_id,
            terminal_event_kind,
            usage: self.usage,
            raw_stream_hash,
            event_count,
            total_bytes,
            unknown_event_types: self.unknown_event_types.into_iter().collect(),
        })
    }
}

fn parse_usage(line: usize, value: Option<&Value>) -> Result<Option<TokenUsage>, DecodeError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let object = value
        .as_object()
        .ok_or(DecodeError::InvalidUsage { line })?;
    Ok(Some(TokenUsage {
        input_tokens: usage_field(line, object, "input_tokens")?,
        cached_input_tokens: usage_field(line, object, "cached_input_tokens")?,
        output_tokens: usage_field(line, object, "output_tokens")?,
        reasoning_output_tokens: usage_field(line, object, "reasoning_output_tokens")?,
    }))
}

fn usage_field(
    line: usize,
    object: &Map<String, Value>,
    key: &str,
) -> Result<u64, DecodeError> {
    match object.get(key) {
        None => Ok(0),
        Some(value) => value.as_u64().ok_or(DecodeError::InvalidUsage { line }),
    }
}

fn looks_terminal(event_type: &str) -> bool {
    [
        ".completed",
        ".failed",
        ".cancelled",
        ".canceled",
        ".interrupted",
        ".aborted",
    ]
    .iter()
    .any(|suffix| event_type.ends_with(suffix))
}

/// Structural or resource-bound JSONL decoding failure.
#[derive(Debug, Error)]
pub enum DecodeError {
    #[error("stream limits are invalid")]
    InvalidLimits,
    #[error("stream exceeded {maximum} total bytes")]
    TotalBytesExceeded { maximum: usize },
    #[error("line {line} exceeded {maximum} bytes")]
    LineBytesExceeded { line: usize, maximum: usize },
    #[error("stream exceeded {maximum} events")]
    EventCountExceeded { maximum: usize },
    #[error("line {line} is blank")]
    BlankLine { line: usize },
    #[error("line {line} is not valid UTF-8")]
    InvalidUtf8 { line: usize },
    #[error("line {line} is invalid JSON: {message}")]
    InvalidJson { line: usize, message: String },
    #[error("line {line} event must be a JSON object")]
    EventNotObject { line: usize },
    #[error("line {line} event type is missing or invalid")]
    InvalidEventType { line: usize },
    #[error("line {line} thread.started is duplicated or not first")]
    DuplicateOrLateThreadStarted { line: usize },
    #[error("thread.started event is missing")]
    MissingThreadStarted,
    #[error("line {line} thread id is missing or invalid")]
    InvalidThreadId { line: usize },
    #[error("line {line} thread id conflicts: expected {expected}, observed {observed}")]
    ConflictingThreadId {
        line: usize,
        expected: String,
        observed: String,
    },
    #[error("line {line} turn.started is duplicated")]
    DuplicateTurnStarted { line: usize },
    #[error("turn.started event is missing")]
    MissingTurnStarted,
    #[error("line {line} event {event_type} occurred before thread.started")]
    EventBeforeThread { line: usize, event_type: String },
    #[error("line {line} event {event_type} occurred before turn.started")]
    EventBeforeTurn { line: usize, event_type: String },
    #[error("line {line} event {event_type} occurred after the terminal event")]
    EventAfterTerminal { line: usize, event_type: String },
    #[error("line {line} unknown terminal-like event {event_type}")]
    UnknownTerminalEvent { line: usize, event_type: String },
    #[error("terminal turn event is missing")]
    MissingTerminalEvent,
    #[error("line {line} usage payload is invalid")]
    InvalidUsage { line: usize },
    #[error("failed to construct the canonical stream digest")]
    InternalDigestConstruction,
    #[error("I/O error while reading JSONL: {0}")]
    Io(#[from] io::Error),
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use hepta_codex_protocol::TerminalEventKind;

    use super::{DecodeError, StreamLimits, decode_stream};

    fn success() -> Vec<u8> {
        [
            r#"{"type":"thread.started","thread_id":"thread-1"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.completed","item":{"id":"item-1"}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":4}}"#,
        ]
        .join("\n")
        .into_bytes()
    }

    #[test]
    fn decodes_complete_stream_and_hashes_exact_bytes() {
        let decoded = decode_stream(Cursor::new(success()), StreamLimits::default())
            .expect("valid stream");
        assert_eq!(decoded.thread_id, "thread-1");
        assert_eq!(decoded.terminal_event_kind, TerminalEventKind::TurnCompleted);
        assert_eq!(decoded.event_count, 4);
        assert_eq!(decoded.usage.expect("usage").input_tokens, 10);
        assert!(decoded.raw_stream_hash.as_str().starts_with("sha256:"));
    }

    #[test]
    fn preserves_unknown_nonterminal_events() {
        let input = [
            r#"{"type":"thread.started","thread_id":"thread-1"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"provider.telemetry","value":1}"#,
            r#"{"type":"turn.completed"}"#,
        ]
        .join("\n");
        let decoded = decode_stream(Cursor::new(input), StreamLimits::default())
            .expect("forward-compatible nonterminal event");
        assert_eq!(decoded.unknown_event_types, vec!["provider.telemetry"]);
    }

    #[test]
    fn rejects_unknown_terminal_like_events() {
        let input = [
            r#"{"type":"thread.started","thread_id":"thread-1"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"turn.cancelled"}"#,
        ]
        .join("\n");
        assert!(matches!(
            decode_stream(Cursor::new(input), StreamLimits::default()),
            Err(DecodeError::UnknownTerminalEvent { .. })
        ));
    }

    #[test]
    fn rejects_event_after_terminal() {
        let input = [
            r#"{"type":"thread.started","thread_id":"thread-1"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"turn.completed"}"#,
            r#"{"type":"error","message":"late"}"#,
        ]
        .join("\n");
        assert!(matches!(
            decode_stream(Cursor::new(input), StreamLimits::default()),
            Err(DecodeError::EventAfterTerminal { .. })
        ));
    }

    #[test]
    fn enforces_line_limit_before_json_parsing() {
        let limits = StreamLimits {
            maximum_total_bytes: 128,
            maximum_line_bytes: 16,
            maximum_event_count: 8,
        };
        assert!(matches!(
            decode_stream(Cursor::new(vec![b'x'; 17]), limits),
            Err(DecodeError::LineBytesExceeded { .. })
        ));
    }
}
