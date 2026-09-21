//! Kernel observations of the socket's original peer, never installation or
//! native-language evidence. SO_PEERCRED records credentials at connect/listen;
//! inherited or passed sockets can be used by other processes. Keeping the
//! original pidfd detects its death, not which thread produced a reply.
use super::*;
use nix::{
    fcntl::{FcntlArg, FdFlag, fcntl},
    poll::{PollFd, PollFlags, PollTimeout, poll},
    sys::socket::{getsockopt, sockopt},
};
use std::os::fd::{AsFd, OwnedFd, RawFd};

#[derive(Debug, Eq, PartialEq)]
struct Credentials {
    pid: i32,
    uid: u32,
    gid: u32,
}
impl Credentials {
    fn observe(stream: &UnixStream) -> Result<Self> {
        let value = getsockopt(stream, sockopt::PeerCredentials)
            .map_err(|_| fail("local_state_authority_socket_peer_unavailable"))?;
        if value.pid() <= 0 {
            return Err(fail("local_state_authority_socket_peer_unavailable"));
        }
        Ok(Self {
            pid: value.pid(),
            uid: value.uid(),
            gid: value.gid(),
        })
    }
}

#[derive(Debug)]
pub(super) struct SocketPeer {
    credentials: Credentials,
    pidfd: OwnedFd,
    socket: RawFd,
}
impl SocketPeer {
    pub(super) fn observe(stream: &UnixStream, deadline: Instant) -> Result<Self> {
        deadline_current(deadline)?;
        let credentials = Credentials::observe(stream)?;
        // Obtain the pidfd directly from the socket's retained kernel peer pid.
        // Looking up its numeric PID with pidfd_open would introduce reuse.
        let pidfd = getsockopt(stream, sockopt::PeerPidfd)
            .map_err(|_| fail("local_state_authority_socket_peer_unavailable"))?;
        let flags = fcntl(&pidfd, FcntlArg::F_GETFD)
            .map_err(|_| fail("local_state_authority_socket_peer_unavailable"))?;
        if !FdFlag::from_bits_retain(flags).contains(FdFlag::FD_CLOEXEC) {
            return Err(fail("local_state_authority_socket_peer_unavailable"));
        }
        let result = Self {
            credentials,
            pidfd,
            socket: stream.as_raw_fd(),
        };
        result.assert_connection(stream, deadline)?;
        Ok(result)
    }

    pub(super) fn assert_alive(&self, deadline: Instant) -> Result<()> {
        let mut descriptors = [PollFd::new(self.pidfd.as_fd(), PollFlags::POLLIN)];
        loop {
            deadline_current(deadline)?;
            match poll(&mut descriptors, PollTimeout::ZERO) {
                Ok(0) if descriptors[0].revents() == Some(PollFlags::empty()) => return Ok(()),
                Ok(_) => return Err(fail("local_state_authority_socket_peer_exited")),
                Err(Errno::EINTR) => continue,
                Err(_) => return Err(fail("local_state_authority_socket_peer_unavailable")),
            }
        }
    }

    fn assert_connection(&self, stream: &UnixStream, deadline: Instant) -> Result<()> {
        self.assert_alive(deadline)?;
        if self.socket != stream.as_raw_fd() || Credentials::observe(stream)? != self.credentials {
            return Err(fail("local_state_authority_socket_peer_changed"));
        }
        self.assert_alive(deadline)
    }

    pub(super) fn assert_same_origin(
        &self,
        origin: &Self,
        stream: &UnixStream,
        deadline: Instant,
    ) -> Result<()> {
        origin.assert_alive(deadline)?;
        self.assert_connection(stream, deadline)?;
        if self.credentials != origin.credentials {
            return Err(fail("local_state_authority_socket_peer_changed"));
        }
        // A dead process cannot become live again through its original pidfd.
        // Both checks bracket numeric credential equality, so a recycled PID
        // cannot be mistaken for the original creator. No pidfd inode equality
        // or /proc permission assumptions are needed.
        origin.assert_alive(deadline)?;
        self.assert_connection(stream, deadline)
    }
}
