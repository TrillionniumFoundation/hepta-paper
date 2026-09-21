//! Bounded Unix transport for the local authority protocol. This client does
//! not verify receipts or confer authority; the existing pinned verifiers do.
//! See `local_state_authority_client/HANDOFF.md` for the strict JSON subset.
use crate::sqlite_mutation_coordinator::authority::files::parse;
use nix::{
    errno::Errno,
    sys::socket::{AddressFamily, SockFlag, SockType, UnixAddr, connect, socket},
};
use serde_json::{Value, json};
use std::{
    fmt,
    io::{Read, Write},
    net::Shutdown,
    os::{
        fd::AsRawFd,
        unix::{ffi::OsStrExt, net::UnixStream},
    },
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

pub const HEPTA_LOCAL_STATE_AUTHORITY_SOCKET: &str =
    "/run/hepta-paper-state-authority/authority.sock";
pub const MAXIMUM_MESSAGE_BYTES: usize = 256 * 1024 * 1024;
pub const MAXIMUM_TIMEOUT_MS: u64 = 120_000;
pub const USAGE: &str = "Usage: hepta-paper-state-authority-client < request.json";

/// Library transport settings. The installed binary always uses `default()`;
/// it has no socket, environment, timeout, or runtime override flags.
#[derive(Clone, Debug)]
pub struct LocalStateAuthorityClientOptionsV1 {
    pub socket_path: PathBuf,
    pub timeout_ms: u64,
    pub maximum_message_bytes: usize,
}
impl Default for LocalStateAuthorityClientOptionsV1 {
    fn default() -> Self {
        Self {
            socket_path: HEPTA_LOCAL_STATE_AUTHORITY_SOCKET.into(),
            timeout_ms: MAXIMUM_TIMEOUT_MS,
            maximum_message_bytes: MAXIMUM_MESSAGE_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalStateAuthorityClientError(String);
impl fmt::Display for LocalStateAuthorityClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for LocalStateAuthorityClientError {}
pub type Result<T> = std::result::Result<T, LocalStateAuthorityClientError>;
fn fail(code: &str) -> LocalStateAuthorityClientError {
    LocalStateAuthorityClientError(code.into())
}
fn configuration(options: &LocalStateAuthorityClientOptionsV1) -> Result<()> {
    if !options.socket_path.is_absolute()
        || options.socket_path.as_os_str().as_bytes().contains(&0)
        || !(1000..=MAXIMUM_TIMEOUT_MS).contains(&options.timeout_ms)
        || !(1024..=MAXIMUM_MESSAGE_BYTES).contains(&options.maximum_message_bytes)
    {
        return Err(fail("local_state_authority_client_configuration_invalid"));
    }
    Ok(())
}
fn deadline_current(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline {
        Err(fail("local_state_authority_client_timeout"))
    } else {
        Ok(())
    }
}
fn wait_ready(deadline: Instant) -> Result<()> {
    deadline_current(deadline)?;
    thread::sleep(Duration::from_millis(2).min(deadline.saturating_duration_since(Instant::now())));
    deadline_current(deadline)
}
fn open_socket(
    options: &LocalStateAuthorityClientOptionsV1,
    deadline: Instant,
) -> Result<UnixStream> {
    let address = UnixAddr::new(&options.socket_path)
        .map_err(|_| fail("local_state_authority_client_connection_failed"))?;
    let fd = socket(
        AddressFamily::Unix,
        SockType::Stream,
        SockFlag::SOCK_NONBLOCK | SockFlag::SOCK_CLOEXEC,
        None,
    )
    .map_err(|_| fail("local_state_authority_client_connection_failed"))?;
    let stream = UnixStream::from(fd);
    loop {
        deadline_current(deadline)?;
        match connect(stream.as_raw_fd(), &address) {
            Ok(()) | Err(Errno::EISCONN) => return Ok(stream),
            Err(Errno::EINTR) => continue,
            Err(Errno::EAGAIN | Errno::EINPROGRESS | Errno::EALREADY) => wait_ready(deadline)?,
            Err(_) => return Err(fail("local_state_authority_client_connection_failed")),
        }
    }
}

/// Send one object, half-close the write side, then read one envelope to EOF.
/// The deadline is absolute across connect/write/read, including active peers.
/// Returned JSON remains untrusted; no signature or authorization is minted.
pub fn request_local_state_authority_v1(
    request: &Value,
    options: &LocalStateAuthorityClientOptionsV1,
) -> Result<Value> {
    configuration(options)?;
    if !request.is_object() {
        return Err(fail("local_state_authority_client_configuration_invalid"));
    }
    let mut payload = serde_json::to_vec(request)
        .map_err(|_| fail("local_state_authority_client_request_invalid"))?;
    payload.push(b'\n');
    if payload.len() > options.maximum_message_bytes {
        return Err(fail("local_state_authority_client_request_too_large"));
    }
    let deadline = Instant::now() + Duration::from_millis(options.timeout_ms);
    let mut stream = open_socket(options, deadline)?;
    let mut sent = 0;
    while sent < payload.len() {
        deadline_current(deadline)?;
        match stream.write(&payload[sent..]) {
            Ok(0) => return Err(fail("local_state_authority_client_connection_failed")),
            Ok(count) => sent += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => wait_ready(deadline)?,
            Err(_) => return Err(fail("local_state_authority_client_connection_failed")),
        }
    }
    stream
        .shutdown(Shutdown::Write)
        .map_err(|_| fail("local_state_authority_client_connection_failed"))?;
    let mut response = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        deadline_current(deadline)?;
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                if count > options.maximum_message_bytes - response.len() {
                    return Err(fail("local_state_authority_client_response_too_large"));
                }
                response.extend_from_slice(&buffer[..count]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => wait_ready(deadline)?,
            Err(_) => return Err(fail("local_state_authority_client_connection_failed")),
        }
    }
    let envelope = parse(&response, "local_state_authority_client_response_invalid")
        .map_err(|_| fail("local_state_authority_client_response_invalid"))?;
    deadline_current(deadline)?;
    if envelope.get("ok") != Some(&Value::Bool(true))
        || !envelope.get("receipt").is_some_and(Value::is_object)
    {
        let error = envelope.get("error").filter(|value| truthy(value));
        return Err(fail(&match error {
            Some(value) => js_string(value)?,
            None => "local_state_authority_client_request_rejected".into(),
        }));
    }
    Ok(envelope["receipt"].clone())
}

/// Parse all arguments before help/input. Raw stdin is also byte bounded; its
/// blocking EOF read precedes the socket deadline, as in the incumbent CLI.
pub fn run_local_state_authority_client_v1(
    argv: &[String],
    input: impl Read,
    options: &LocalStateAuthorityClientOptionsV1,
) -> Result<Value> {
    let mut help = false;
    for argument in argv {
        if argument == "--" {
            return Err(fail("unexpected_cli_argument_separator"));
        }
        let Some(option) = argument.strip_prefix("--") else {
            return Err(fail(&format!("unexpected_cli_positional:{argument}")));
        };
        let key = option.split('=').next().unwrap_or_default();
        if key.is_empty() {
            return Err(fail("empty_cli_option"));
        }
        if key != "help" {
            return Err(fail(&format!("unknown_cli_option:--{key}")));
        }
        if option.contains('=') {
            return Err(fail("boolean_cli_option_does_not_take_value:--help"));
        }
        if help {
            return Err(fail("duplicate_cli_option:--help"));
        }
        help = true;
    }
    if help {
        return Ok(json!({"help": USAGE}));
    }
    configuration(options)?;
    let mut bytes = Vec::new();
    input
        .take(options.maximum_message_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| fail("local_state_authority_client_request_invalid"))?;
    if bytes.len() > options.maximum_message_bytes {
        return Err(fail("local_state_authority_client_request_too_large"));
    }
    let request = parse(&bytes, "local_state_authority_client_request_invalid")
        .map_err(|_| fail("local_state_authority_client_request_invalid"))?;
    request_local_state_authority_v1(&request, options)
}

/// Preserve the incumbent CLI's help response convention and trailing newline.
pub fn format_local_state_authority_client_output_v1(receipt: &Value) -> Result<String> {
    let output = match receipt.get("help").filter(|value| truthy(value)) {
        Some(value) => js_string(value)?,
        None => serde_json::to_string(receipt)
            .map_err(|_| fail("local_state_authority_client_response_invalid"))?,
    };
    Ok(format!("{output}\n"))
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|number| number != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}
fn js_string(value: &Value) -> Result<String> {
    Ok(match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Number(value) => ryu_js::Buffer::new()
            .format(value.as_f64().expect("JSON number"))
            .into(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    Ok(String::new())
                } else {
                    js_string(value)
                }
            })
            .collect::<Result<Vec<_>>>()?
            .join(","),
        Value::Object(value) => {
            if value.contains_key("toString") {
                return Err(fail("Cannot convert object to primitive value"));
            }
            "[object Object]".into()
        }
    })
}

#[cfg(test)]
mod tests;
