//! Bounded Unix EOF-envelope transport. One owning authority serializes every
//! state operation; socket access uses the installed Unix DAC boundary.
use super::*;
use std::{
    io::{Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

const MAX_BYTES: usize = 256 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(120);
const MAX_CONNECTIONS: usize = 64;
const IO_QUANTUM: usize = 64 * 1024;
// A shared wire-buffer budget, in addition to the per-message limit.
const MAX_BUFFERED_BYTES: usize = MAX_BYTES;
pub struct LocalStateAuthorityServerV1 {
    listener: UnixListener,
    runtime: LocalStateAuthorityRuntimeV1,
    socket: PublishedSocket,
}
mod publication;
mod wire;
use publication::PublishedSocket;
impl LocalStateAuthorityServerV1 {
    pub fn bind(runtime: LocalStateAuthorityRuntimeV1) -> Result<Self> {
        let (listener, socket) = publication::bind(runtime.socket_path()?)?;
        Ok(Self {
            listener,
            runtime,
            socket,
        })
    }
    pub fn socket_path(&self) -> &Path {
        self.socket.path()
    }
    pub fn serve(&mut self, stopped: &AtomicBool) -> Result<()> {
        let mut peers: Vec<Peer> = Vec::new();
        while !stopped.load(Ordering::Acquire) {
            self.socket.assert_current()?;
            // Bound acceptance work too, so a flood cannot starve existing
            // peers. Excess connections receive EOF without any state action.
            for _ in 0..MAX_CONNECTIONS {
                match self.listener.accept() {
                    Ok((stream, _)) if peers.len() < MAX_CONNECTIONS => {
                        if stream.set_nonblocking(true).is_ok() {
                            peers.push(Peer::new(stream));
                        }
                    }
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => return Err(error("local_state_authority_socket_accept_failed")),
                }
            }
            let mut buffered: usize = peers.iter().map(Peer::buffered).sum();
            let mut index = 0;
            while index < peers.len() && !stopped.load(Ordering::Acquire) {
                buffered -= peers[index].buffered();
                let available = MAX_BUFFERED_BYTES.saturating_sub(buffered);
                if peers[index].advance(self, available)? {
                    buffered += peers[index].buffered();
                    index += 1;
                } else {
                    peers.swap_remove(index);
                }
            }
            thread::sleep(Duration::from_millis(2));
        }
        Ok(())
    }
}

struct Peer {
    stream: UnixStream,
    input: Vec<u8>,
    output: Option<Vec<u8>>,
    written: usize,
    deadline: Instant,
}
impl Peer {
    fn new(stream: UnixStream) -> Self {
        Self {
            stream,
            input: Vec::new(),
            output: None,
            written: 0,
            deadline: Instant::now() + DEADLINE,
        }
    }
    fn buffered(&self) -> usize {
        self.input.len() + self.output.as_ref().map_or(0, Vec::len)
    }
    fn advance(
        &mut self,
        server: &mut LocalStateAuthorityServerV1,
        available: usize,
    ) -> Result<bool> {
        if Instant::now() >= self.deadline {
            return Ok(false);
        }
        if self.output.is_none() {
            let mut chunk = [0u8; 8192];
            let mut processed = 0;
            while processed < IO_QUANTUM {
                if Instant::now() >= self.deadline {
                    return Ok(false);
                }
                match self.stream.read(&mut chunk) {
                    Ok(0) => {
                        server.socket.assert_current()?;
                        let bytes = std::mem::take(&mut self.input);
                        let request = files::parse(&bytes, "local_state_authority_request_invalid")
                            .and_then(|value| {
                                let echo = wire::CapturedEchoFields::capture(
                                    &bytes,
                                    available.min(MAX_BYTES).saturating_sub(bytes.len()),
                                )?;
                                Ok((value, echo))
                            });
                        if Instant::now() >= self.deadline {
                            return Ok(false);
                        }
                        // Only complete requests enter the single SQLite owner.
                        // Waiting for EOF or socket output never owns its queue.
                        let result = request.and_then(|(value, echo)| {
                            server.runtime.handle(&value).map(|receipt| (receipt, echo))
                        });
                        drop(bytes);
                        if Instant::now() >= self.deadline {
                            return Ok(false);
                        }
                        let mut output = BoundedOutput {
                            bytes: Vec::new(),
                            maximum: available.min(MAX_BYTES),
                        };
                        // Response loss cannot undo an already committed state
                        // transition; the caller must use protocol resolution.
                        let encoded = match result {
                            Ok((receipt, echo)) => {
                                let envelope = echo.bind(&receipt);
                                output.maximum =
                                    output.maximum.saturating_sub(envelope.retained_bytes());
                                serde_json::to_writer(&mut output, &envelope)
                            }
                            Err(cause) => serde_json::to_writer(
                                &mut output,
                                &json!({"ok":false,"error":cause.code}),
                            ),
                        };
                        if encoded.is_err() || output.write_all(b"\n").is_err() {
                            return Ok(false);
                        }
                        self.output = Some(output.bytes);
                        break;
                    }
                    Ok(n) => {
                        if self.input.len().saturating_add(n) > available.min(MAX_BYTES) {
                            return Ok(false);
                        }
                        self.input.extend_from_slice(&chunk[..n]);
                        processed += n;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => break,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(true),
                    Err(_) => return Ok(false),
                }
            }
        }
        if let Some(output) = &self.output {
            let end = output.len().min(self.written.saturating_add(IO_QUANTUM));
            while self.written < end {
                if Instant::now() >= self.deadline {
                    return Ok(false);
                }
                match self.stream.write(&output[self.written..end]) {
                    Ok(0) => return Ok(false),
                    Ok(n) => self.written += n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => break,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(true),
                    Err(_) => return Ok(false),
                }
            }
            return Ok(self.written < output.len());
        }
        Ok(true)
    }
}
struct BoundedOutput {
    bytes: Vec<u8>,
    maximum: usize,
}
impl Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.maximum.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other(
                "authority response exceeds wire budget",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
