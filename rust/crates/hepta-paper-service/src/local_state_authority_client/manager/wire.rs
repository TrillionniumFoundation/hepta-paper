//! A bounded socket around the real zbus authentication and message codec.
//! No authentication is bypassed and no D-Bus frames are constructed by hand.
use super::*;
use async_io::Async;
use std::{
    io,
    os::fd::{BorrowedFd, OwnedFd},
    sync::{
        Arc, Weak,
        atomic::{AtomicUsize, Ordering},
    },
};
use zbus::connection::socket::{ReadHalf, Socket, Split, WriteHalf};

pub(super) const MAXIMUM_RECEIVED_BYTES: usize = 4 * 1024 * 1024;
const MAXIMUM_SENT_BYTES: usize = 1024 * 1024;
const READ_CHUNK: usize = 16 * 1024;

#[derive(Debug)]
struct Resources {
    socket: Arc<Async<UnixStream>>,
    deadline: Instant,
    received: AtomicUsize,
    sent: AtomicUsize,
}

impl Resources {
    fn credentials(&self) -> io::Result<zbus::fdo::ConnectionCredentials> {
        if Instant::now() >= self.deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        let credentials =
            getsockopt(self.socket.get_ref(), sockopt::PeerCredentials).map_err(io::Error::from)?;
        let pid = u32::try_from(credentials.pid())
            .map_err(|_| io::Error::other("manager_peer_pid_invalid"))?;
        if pid == 0 {
            return Err(io::Error::other("manager_peer_pid_invalid"));
        }
        // zbus's default Unix implementation spawns an NSS lookup thread.
        // Only actual kernel UID/PID are needed here; omit groups entirely.
        Ok(zbus::fdo::ConnectionCredentials::default()
            .set_unix_user_id(credentials.uid())
            .set_process_id(pid))
    }
}

/// This witness owns no descriptors. Its zero count proves the read and write
/// owners, including zbus's receiving task, have both been destroyed.
pub(super) struct ClosedWitness(Weak<Resources>);
impl ClosedWitness {
    pub(super) fn is_closed(&self) -> bool {
        self.0.strong_count() == 0
    }

    pub(super) fn shutdown(&self) {
        if let Some(resources) = self.0.upgrade() {
            // Interrupt both halves without waiting on zbus's async mutex.
            // The actual close and task destruction are checked separately.
            let _ = resources.socket.get_ref().shutdown(Shutdown::Both);
        }
    }
}

#[derive(Debug)]
pub(super) struct BoundedSocket(Arc<Resources>);
#[derive(Debug)]
pub(super) struct Reader {
    resources: Arc<Resources>,
    authentication_lines: u8,
    authentication_previous: Option<u8>,
}
#[derive(Debug)]
pub(super) struct Writer(Arc<Resources>);

impl BoundedSocket {
    pub(super) fn new(stream: UnixStream, deadline: Instant) -> io::Result<(Self, ClosedWitness)> {
        let resources = Arc::new(Resources {
            socket: Arc::new(Async::new(stream)?),
            deadline,
            received: AtomicUsize::new(0),
            sent: AtomicUsize::new(0),
        });
        let witness = ClosedWitness(Arc::downgrade(&resources));
        Ok((Self(resources), witness))
    }
}
impl Socket for BoundedSocket {
    type ReadHalf = Reader;
    type WriteHalf = Writer;
    fn split(self) -> Split<Reader, Writer> {
        Split::new(
            Reader {
                resources: Arc::clone(&self.0),
                authentication_lines: 0,
                authentication_previous: None,
            },
            Writer(self.0),
        )
    }
}

async fn bounded_io<T>(
    deadline: Instant,
    future: impl std::future::Future<Output = io::Result<T>>,
) -> io::Result<T> {
    if Instant::now() >= deadline {
        return Err(io::ErrorKind::TimedOut.into());
    }
    futures_lite::future::race(future, async {
        async_io::Timer::at(deadline).await;
        Err(io::ErrorKind::TimedOut.into())
    })
    .await
}

#[async_trait::async_trait]
impl ReadHalf for Reader {
    async fn recvmsg(&mut self, buffer: &mut [u8]) -> io::Result<(usize, Vec<OwnedFd>)> {
        let used = self.resources.received.load(Ordering::Relaxed);
        let available = MAXIMUM_RECEIVED_BYTES.saturating_sub(used);
        if available == 0 {
            return Err(io::Error::other("manager_receive_budget_exceeded"));
        }
        let limit = buffer.len().min(available).min(READ_CHUNK);
        let mut socket = Arc::clone(&self.resources.socket);
        let (read, fds) = bounded_io(
            self.resources.deadline,
            ReadHalf::recvmsg(&mut socket, &mut buffer[..limit]),
        )
        .await?;
        self.resources.received.fetch_add(read, Ordering::Relaxed);
        // None of the closed observation methods returns descriptors. This
        // rejection may close received regular-file aliases: the entire
        // producer MUST run before any SQLite connection is owned.
        if !fds.is_empty() {
            return Err(io::Error::other("manager_unexpected_descriptors"));
        }
        // The closed EXTERNAL + Unix-FD client has exactly two textual server
        // responses before binary Hello. zbus 5.19's text parser indexes LF-1;
        // reject a bare LF here rather than allowing an upstream panic. This
        // validates line boundaries only; zbus still authenticates/parses all
        // response contents. Never inspect binary message bytes as text.
        for byte in &buffer[..read] {
            if self.authentication_lines == 2 {
                break;
            }
            if *byte == b'\n' {
                if self.authentication_previous != Some(b'\r') {
                    return Err(io::Error::other("manager_authentication_line_invalid"));
                }
                self.authentication_lines += 1;
                self.authentication_previous = None;
            } else {
                self.authentication_previous = Some(*byte);
            }
        }
        Ok((read, fds))
    }
    fn can_pass_unix_fd(&self) -> bool {
        true
    }
    async fn peer_credentials(&mut self) -> io::Result<zbus::fdo::ConnectionCredentials> {
        self.resources.credentials()
    }
}

#[async_trait::async_trait]
impl WriteHalf for Writer {
    async fn sendmsg(&mut self, buffer: &[u8], fds: &[BorrowedFd<'_>]) -> io::Result<usize> {
        let used = self.0.sent.load(Ordering::Relaxed);
        if buffer.len() > MAXIMUM_SENT_BYTES.saturating_sub(used) || fds.len() > 1 {
            return Err(io::Error::other("manager_send_budget_exceeded"));
        }
        let mut socket = Arc::clone(&self.0.socket);
        let sent = bounded_io(
            self.0.deadline,
            WriteHalf::sendmsg(&mut socket, buffer, fds),
        )
        .await?;
        self.0.sent.fetch_add(sent, Ordering::Relaxed);
        Ok(sent)
    }
    fn can_pass_unix_fd(&self) -> bool {
        true
    }
    async fn peer_credentials(&mut self) -> io::Result<zbus::fdo::ConnectionCredentials> {
        self.0.credentials()
    }
    async fn close(&mut self) -> io::Result<()> {
        // shutdown is a local nonblocking operation even after the deadline.
        self.0.socket.get_ref().shutdown(Shutdown::Both)
    }
}
