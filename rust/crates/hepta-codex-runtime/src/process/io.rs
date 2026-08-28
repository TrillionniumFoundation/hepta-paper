use std::{
    io::{self, Read, Write},
    str::FromStr,
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
    thread,
    time::Duration,
};

use hepta_codex_protocol::Sha256Digest;
use sha2::{Digest, Sha256};

use super::types::BoundedProcessError;

#[derive(Clone, Copy, Debug)]
pub(super) enum StreamKind {
    Stdout,
    Stderr,
}

pub(super) struct OutputObservation {
    pub(super) hash: Sha256Digest,
    pub(super) bytes: u64,
    pub(super) tail: Vec<u8>,
    pub(super) truncated: bool,
}

pub(super) fn spawn_stdin_writer<W>(
    stdin: Option<W>,
    input: Option<Vec<u8>>,
) -> Receiver<Result<(), io::ErrorKind>>
where
    W: Write + Send + 'static,
{
    let (sender, receiver) = mpsc::channel();
    let _writer_handle = thread::spawn(move || {
        let result = match (stdin, input) {
            (Some(mut stdin), Some(input)) => stdin
                .write_all(&input)
                .and_then(|()| stdin.flush())
                .map_err(|error| error.kind()),
            _ => Ok(()),
        };
        let _ = sender.send(result);
    });
    receiver
}

pub(super) fn spawn_output_reader<R: Read + Send + 'static>(
    mut reader: R,
    stream: StreamKind,
    maximum_bytes: u64,
    maximum_tail_bytes: usize,
    limit_sender: Sender<StreamKind>,
) -> Receiver<Result<OutputObservation, io::ErrorKind>> {
    let (sender, receiver) = mpsc::channel();
    let _reader_handle = thread::spawn(move || {
        let mut hasher = Sha256::new();
        let mut total = 0_u64;
        let mut tail = Vec::new();
        let mut limit_reported = false;
        let mut buffer = [0_u8; 64 * 1024];
        let result = loop {
            let read = match reader.read(&mut buffer) {
                Ok(0) => break digest_output(hasher, total, tail),
                Ok(read) => read,
                Err(error) => break Err(error.kind()),
            };
            hasher.update(&buffer[..read]);
            let read_bytes = match u64::try_from(read) {
                Ok(value) => value,
                Err(_) => break Err(io::ErrorKind::OutOfMemory),
            };
            let Some(next_total) = total.checked_add(read_bytes) else {
                break Err(io::ErrorKind::OutOfMemory);
            };
            total = next_total;
            append_tail(&mut tail, &buffer[..read], maximum_tail_bytes);
            if total > maximum_bytes && !limit_reported {
                limit_reported = true;
                let _ = limit_sender.send(stream);
            }
        };
        let _ = sender.send(result);
    });
    receiver
}

pub(super) fn receive_stdin_result(
    receiver: Receiver<Result<(), io::ErrorKind>>,
    timeout: Duration,
) -> Result<(), BoundedProcessError> {
    match receiver.recv_timeout(nonzero_timeout(timeout)) {
        Ok(Ok(())) | Ok(Err(io::ErrorKind::BrokenPipe)) => Ok(()),
        Ok(Err(kind)) => Err(BoundedProcessError::StdinWrite(kind)),
        Err(RecvTimeoutError::Timeout) => Err(BoundedProcessError::StdinWriterDidNotFinish),
        Err(RecvTimeoutError::Disconnected) => Err(BoundedProcessError::StdinWriterDisconnected),
    }
}

pub(super) fn receive_output(
    receiver: Receiver<Result<OutputObservation, io::ErrorKind>>,
    timeout: Duration,
    stream: &'static str,
) -> Result<OutputObservation, BoundedProcessError> {
    match receiver.recv_timeout(nonzero_timeout(timeout)) {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(kind)) => Err(BoundedProcessError::OutputRead(stream, kind)),
        Err(RecvTimeoutError::Timeout) => Err(BoundedProcessError::OutputReaderDidNotFinish(stream)),
        Err(RecvTimeoutError::Disconnected) => {
            Err(BoundedProcessError::OutputReaderDisconnected(stream))
        }
    }
}

fn append_tail(tail: &mut Vec<u8>, chunk: &[u8], maximum_tail_bytes: usize) {
    if chunk.len() >= maximum_tail_bytes {
        tail.clear();
        tail.extend_from_slice(&chunk[chunk.len() - maximum_tail_bytes..]);
        return;
    }
    let required = tail.len().saturating_add(chunk.len());
    if required > maximum_tail_bytes {
        drop(tail.drain(..required - maximum_tail_bytes));
    }
    tail.extend_from_slice(chunk);
}

fn digest_output(
    hasher: Sha256,
    bytes: u64,
    tail: Vec<u8>,
) -> Result<OutputObservation, io::ErrorKind> {
    let value = format!("sha256:{}", hex::encode(hasher.finalize()));
    let hash = Sha256Digest::from_str(&value).map_err(|_| io::ErrorKind::InvalidData)?;
    let truncated = match u64::try_from(tail.len()) {
        Ok(tail_bytes) => bytes > tail_bytes,
        Err(_) => true,
    };
    Ok(OutputObservation {
        hash,
        bytes,
        tail,
        truncated,
    })
}

fn nonzero_timeout(timeout: Duration) -> Duration {
    if timeout.is_zero() {
        Duration::from_millis(1)
    } else {
        timeout
    }
}
