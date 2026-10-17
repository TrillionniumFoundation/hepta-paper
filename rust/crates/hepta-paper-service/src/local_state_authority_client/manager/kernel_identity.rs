//! A bounded observation of the original peer process leader's kernel groups.
//! All proc descriptors close on return. This is not per-thread custody or a
//! continued identity claim and must run before any caller-owned SQLite.
use super::*;
use nix::{
    fcntl::{OFlag, open, openat, readlinkat},
    sys::{
        stat::Mode,
        statfs::{PROC_SUPER_MAGIC, fstatfs},
    },
};
use std::{
    collections::BTreeMap,
    os::{fd::AsFd, unix::fs::MetadataExt},
    path::Path,
};

const MAXIMUM_STATUS_BYTES: usize = 1024 * 1024;
const MAXIMUM_FDINFO_BYTES: usize = 4096;
const MAXIMUM_STATUS_FIELDS: usize = 256;
const MAXIMUM_SUPPLEMENTARY_GIDS: usize = 65_536;
const MAXIMUM_NAMESPACE_PIDS: usize = 32;
const INVALID: &str = "local_state_authority_manager_kernel_identity_invalid";
const UNAVAILABLE: &str = "local_state_authority_manager_kernel_identity_unavailable";
const NAMESPACE: &str = "local_state_authority_manager_proc_namespace_mismatch";

#[derive(Debug, Eq, PartialEq)]
pub(super) struct KernelIdentity {
    pid: u32,
    tgid: u32,
    uids: [u32; 4],
    gids: [u32; 4],
    supplementary_gids: Vec<u32>,
    namespace_pids: Vec<u32>,
}

impl KernelIdentity {
    pub(super) fn report(&self) -> Value {
        json!({
            "source":"original_socket_peer_process_leader_proc_status",
            "pid":self.pid,"tgid":self.tgid,
            "uid":{"real":self.uids[0],"effective":self.uids[1],
                "saved":self.uids[2],"filesystem":self.uids[3]},
            "gid":{"real":self.gids[0],"effective":self.gids[1],
                "saved":self.gids[2],"filesystem":self.gids[3]},
            "supplementaryGids":self.supplementary_gids,
            "namespacePids":self.namespace_pids,
            "observation":"status_reads_bracket_manager_not_atomic_or_continuous",
            "maximumStatusBytes":MAXIMUM_STATUS_BYTES,
            "maximumSupplementaryGids":MAXIMUM_SUPPLEMENTARY_GIDS,
            "procDescriptorsClosedBeforeReturn":true
        })
    }
}

#[derive(Debug, Eq, PartialEq)]
struct PidfdBinding {
    pid: u32,
    namespace_pids: Vec<u32>,
}

pub(super) fn observe(origin: &peer::SocketPeer, deadline: Instant) -> Result<KernelIdentity> {
    origin.assert_alive(deadline)?;
    let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
    let proc =
        File::from(open(Path::new("/proc"), flags, Mode::empty()).map_err(|_| fail(UNAVAILABLE))?);
    verify_procfs(&proc)?;
    let device = proc.metadata().map_err(|_| fail(UNAVAILABLE))?.dev();
    // "self" is the sole permitted magic link, read rather than followed, and
    // only inside the actual procfs. Its numeric result selects our fd table in
    // this mount's namespace, which need not be the caller's PID namespace.
    let own_pid = readlinkat(&proc, Path::new("self")).map_err(|_| fail(UNAVAILABLE))?;
    positive_pid(own_pid.as_bytes())?;
    let own = open_proc_child(&proc, Path::new(&own_pid), true, device)?;
    let fdinfo = open_proc_child(&own, Path::new("fdinfo"), true, device)?;
    let original_pidfd = origin.origin_pidfd();
    let descriptor_name = original_pidfd.as_raw_fd().to_string();
    let binding_file = open_proc_child(&fdinfo, Path::new(&descriptor_name), false, device)?;
    let binding = parse_fdinfo(&read_bounded(
        &binding_file,
        MAXIMUM_FDINFO_BYTES,
        deadline,
    )?)?;
    let (pid, uid, gid) = origin.origin_credentials();
    let pid = u32::try_from(pid).map_err(|_| fail(NAMESPACE))?;
    if binding.pid != pid {
        return Err(fail(NAMESPACE));
    }
    origin.assert_alive(deadline)?;
    let subject = open_proc_child(&proc, Path::new(&pid.to_string()), true, device)?;
    let status = open_proc_child(&subject, Path::new("status"), false, device)?;
    let identity = parse_status(&read_bounded(&status, MAXIMUM_STATUS_BYTES, deadline)?)?;
    assert_status_binding(&binding, &identity, pid, uid, gid)?;
    // Kernel pidfd fdinfo identifies the ORIGINAL held pidfd's subject in this
    // proc mount. Numeric status Pid equality alone is insufficient.
    let terminal = parse_fdinfo(&read_bounded(
        &binding_file,
        MAXIMUM_FDINFO_BYTES,
        deadline,
    )?)?;
    if terminal != binding {
        return Err(fail(NAMESPACE));
    }
    origin.assert_alive(deadline)?;
    Ok(identity)
}

fn assert_status_binding(
    binding: &PidfdBinding,
    identity: &KernelIdentity,
    pid: u32,
    uid: u32,
    gid: u32,
) -> Result<()> {
    if binding.pid != pid
        || identity.pid != pid
        || identity.tgid != pid
        || identity.namespace_pids != binding.namespace_pids
        || identity.uids[1] != uid
        || identity.gids[1] != gid
    {
        return Err(fail(INVALID));
    }
    Ok(())
}

fn verify_procfs(file: &File) -> Result<()> {
    if fstatfs(file)
        .map_err(|_| fail(UNAVAILABLE))?
        .filesystem_type()
        != PROC_SUPER_MAGIC
    {
        return Err(fail(NAMESPACE));
    }
    Ok(())
}

fn open_proc_child(parent: &File, name: &Path, directory: bool, device: u64) -> Result<File> {
    let flags = OFlag::O_RDONLY
        | OFlag::O_NOFOLLOW
        | OFlag::O_CLOEXEC
        | OFlag::O_NONBLOCK
        | if directory {
            OFlag::O_DIRECTORY
        } else {
            OFlag::empty()
        };
    let file = File::from(
        openat(parent.as_fd(), name, flags, Mode::empty()).map_err(|_| fail(UNAVAILABLE))?,
    );
    verify_procfs(&file)?;
    let metadata = file.metadata().map_err(|_| fail(UNAVAILABLE))?;
    if metadata.dev() != device
        || (if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        })
    {
        return Err(fail(NAMESPACE));
    }
    Ok(file)
}

fn read_bounded(file: &File, maximum: usize, deadline: Instant) -> Result<Vec<u8>> {
    let limit = maximum.checked_add(1).ok_or_else(|| fail(INVALID))?;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    while bytes.len() < limit {
        deadline_current(deadline)?;
        let count = (limit - bytes.len()).min(buffer.len());
        let offset = u64::try_from(bytes.len()).map_err(|_| fail(INVALID))?;
        let read = match file.read_at(&mut buffer[..count], offset) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(fail(UNAVAILABLE)),
        };
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    deadline_current(deadline)?;
    if bytes.len() > maximum {
        return Err(fail(INVALID));
    }
    Ok(bytes)
}

fn records(bytes: &[u8], maximum: usize) -> Result<BTreeMap<&[u8], &[u8]>> {
    if bytes.is_empty() || bytes.len() > maximum || bytes.contains(&0) {
        return Err(fail(INVALID));
    }
    let body = bytes.strip_suffix(b"\n").ok_or_else(|| fail(INVALID))?;
    let mut result = BTreeMap::new();
    for line in body.split(|byte| *byte == b'\n') {
        if result.len() == MAXIMUM_STATUS_FIELDS {
            return Err(fail(INVALID));
        }
        let separator = line
            .iter()
            .position(|byte| *byte == b':')
            .ok_or_else(|| fail(INVALID))?;
        let (name, value) = line.split_at(separator);
        if name.is_empty()
            || name.len() > 64
            || !name
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || result.insert(name, &value[1..]).is_some()
        {
            return Err(fail(INVALID));
        }
    }
    Ok(result)
}

fn numbers(fields: &BTreeMap<&[u8], &[u8]>, key: &[u8], maximum: usize) -> Result<Vec<u32>> {
    let value = fields.get(key).ok_or_else(|| fail(INVALID))?;
    let mut result = Vec::new();
    for token in value
        .split(|byte| matches!(byte, b' ' | b'\t'))
        .filter(|token| !token.is_empty())
    {
        if result.len() == maximum {
            return Err(fail(INVALID));
        }
        result.push(decimal(token)?);
    }
    Ok(result)
}

fn decimal(token: &[u8]) -> Result<u32> {
    if token.is_empty()
        || token.len() > 10
        || (token.len() > 1 && token[0] == b'0')
        || !token.iter().all(u8::is_ascii_digit)
    {
        return Err(fail(INVALID));
    }
    token.iter().try_fold(0_u32, |value, digit| {
        value
            .checked_mul(10)
            .and_then(|value| value.checked_add(u32::from(*digit - b'0')))
            .ok_or_else(|| fail(INVALID))
    })
}

fn positive_pid(token: &[u8]) -> Result<u32> {
    let value = decimal(token)?;
    if value == 0 || value > i32::MAX as u32 {
        return Err(fail(NAMESPACE));
    }
    Ok(value)
}

fn single_pid(fields: &BTreeMap<&[u8], &[u8]>, key: &[u8]) -> Result<u32> {
    let values = numbers(fields, key, 1)?;
    let [value] = values.as_slice() else {
        return Err(fail(INVALID));
    };
    if *value == 0 || *value > i32::MAX as u32 {
        return Err(fail(NAMESPACE));
    }
    Ok(*value)
}

fn namespace_pids(fields: &BTreeMap<&[u8], &[u8]>, pid: u32) -> Result<Vec<u32>> {
    let values = numbers(fields, b"NSpid", MAXIMUM_NAMESPACE_PIDS)?;
    if values.first() != Some(&pid)
        || values
            .iter()
            .any(|value| *value == 0 || *value > i32::MAX as u32)
    {
        return Err(fail(NAMESPACE));
    }
    Ok(values)
}

fn parse_fdinfo(bytes: &[u8]) -> Result<PidfdBinding> {
    let fields = records(bytes, MAXIMUM_FDINFO_BYTES)?;
    let pid = single_pid(&fields, b"Pid")?;
    Ok(PidfdBinding {
        pid,
        namespace_pids: namespace_pids(&fields, pid)?,
    })
}

fn parse_status(bytes: &[u8]) -> Result<KernelIdentity> {
    let fields = records(bytes, MAXIMUM_STATUS_BYTES)?;
    let pid = single_pid(&fields, b"Pid")?;
    Ok(KernelIdentity {
        pid,
        tgid: single_pid(&fields, b"Tgid")?,
        uids: numbers(&fields, b"Uid", 4)?
            .try_into()
            .map_err(|_| fail(INVALID))?,
        gids: numbers(&fields, b"Gid", 4)?
            .try_into()
            .map_err(|_| fail(INVALID))?,
        supplementary_gids: numbers(&fields, b"Groups", MAXIMUM_SUPPLEMENTARY_GIDS)?,
        namespace_pids: namespace_pids(&fields, pid)?,
    })
}

#[cfg(test)]
mod tests;
