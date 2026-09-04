use std::{
    collections::BTreeMap,
    env,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    os::{
        fd::{AsFd, AsRawFd},
        unix::{
            fs::MetadataExt,
            process::{CommandExt, ExitStatusExt},
        },
    },
    path::{Path, PathBuf},
    process::{Command, ExitCode, Stdio},
    str::FromStr,
};

use base64ct::{Base64UrlUnpadded, Encoding};
use hepta_codex_protocol::Sha256Digest;
use nix::{
    fcntl::{FcntlArg, FdFlag, fcntl},
    sys::signal::{Signal, raise},
    unistd::{close, setsid},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const PROTOCOL_VERSION: u16 = 1;
const MAXIMUM_ENVELOPE_BYTES: u64 = 96 * 1024 * 1024;
const MAXIMUM_EXECUTABLE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GateExecutableIdentityV1 {
    canonical_path: String,
    device: u64,
    inode: u64,
    mode: u32,
    uid: u32,
    gid: u32,
    link_count: u64,
    size: u64,
    content_hash: Sha256Digest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GateLaunchEnvelopeV1 {
    version: u16,
    target_executable: GateExecutableIdentityV1,
    arguments: Vec<String>,
    working_directory: String,
    environment: BTreeMap<String, String>,
    stdin_base64: Option<String>,
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(message) => {
            eprintln!("hepta pre-exec gate rejected launch: {message}");
            ExitCode::from(125)
        }
    }
}

fn run() -> Result<u8, String> {
    close_unexpected_file_descriptors()?;
    setsid().map_err(|error| format!("setsid failed: {error}"))?;
    raise(Signal::SIGSTOP).map_err(|error| format!("SIGSTOP failed: {error}"))?;

    let (envelope_path, expected_hash) = parse_arguments()?;
    let bytes = read_bound_envelope(&envelope_path)?;
    let observed_hash = hash_bytes(&bytes)?;
    if observed_hash != expected_hash {
        return Err("envelope hash mismatch".to_owned());
    }
    let envelope: GateLaunchEnvelopeV1 =
        serde_json::from_slice(&bytes).map_err(|_| "invalid envelope JSON".to_owned())?;
    if envelope.version != PROTOCOL_VERSION {
        return Err("unsupported envelope version".to_owned());
    }
    let mut target = open_verified_target(&envelope.target_executable)?;
    let working_directory = PathBuf::from(&envelope.working_directory);
    let canonical_working_directory = fs::canonicalize(&working_directory)
        .map_err(|error| format!("working directory lookup failed: {error}"))?;
    if canonical_working_directory != working_directory
        || !fs::metadata(&working_directory)
            .map_err(|error| format!("working directory metadata failed: {error}"))?
            .is_dir()
    {
        return Err("working directory is not canonical".to_owned());
    }
    fs::remove_file(&envelope_path).map_err(|error| format!("envelope unlink failed: {error}"))?;
    if let Some(parent) = envelope_path.parent() {
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("envelope parent sync failed: {error}"))?;
    }

    let stdin = envelope
        .stdin_base64
        .as_deref()
        .map(|value| {
            Base64UrlUnpadded::decode_vec(value)
                .map_err(|_| "stdin base64 is noncanonical".to_owned())
        })
        .transpose()?;
    clear_close_on_exec(&target)?;
    target
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("target seek failed: {error}"))?;
    let executable = PathBuf::from(format!("/proc/self/fd/{}", target.as_raw_fd()));
    let mut command = Command::new(executable);
    command
        .arg0(&envelope.target_executable.canonical_path)
        .args(&envelope.arguments)
        .current_dir(&working_directory)
        .env_clear()
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    for (key, value) in &envelope.environment {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("target spawn failed: {error}"))?;
    if let Some(bytes) = stdin {
        let mut pipe = child
            .stdin
            .take()
            .ok_or_else(|| "target stdin pipe missing".to_owned())?;
        pipe.write_all(&bytes)
            .map_err(|error| format!("target stdin write failed: {error}"))?;
    }
    let status = child
        .wait()
        .map_err(|error| format!("target wait failed: {error}"))?;
    if let Some(code) = status.code() {
        return Ok(u8::try_from(code.clamp(0, 255)).unwrap_or(125));
    }
    let signal = status.signal().unwrap_or(0).clamp(0, 127);
    Ok(u8::try_from(128 + signal).unwrap_or(125))
}

fn parse_arguments() -> Result<(PathBuf, Sha256Digest), String> {
    let mut values = env::args_os().skip(1);
    if values.next().as_deref() != Some(std::ffi::OsStr::new("--envelope")) {
        return Err("missing --envelope".to_owned());
    }
    let envelope = values
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "missing envelope path".to_owned())?;
    if values.next().as_deref() != Some(std::ffi::OsStr::new("--expected-hash")) {
        return Err("missing --expected-hash".to_owned());
    }
    let expected = values
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or_else(|| "missing expected hash".to_owned())?;
    if values.next().is_some() {
        return Err("unexpected gate arguments".to_owned());
    }
    let digest =
        Sha256Digest::from_str(&expected).map_err(|_| "expected hash is invalid".to_owned())?;
    Ok((envelope, digest))
}

fn read_bound_envelope(path: &Path) -> Result<Vec<u8>, String> {
    let canonical =
        fs::canonicalize(path).map_err(|error| format!("envelope lookup failed: {error}"))?;
    if canonical != path {
        return Err("envelope path is noncanonical".to_owned());
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("envelope metadata failed: {error}"))?;
    let self_uid = fs::metadata("/proc/self")
        .map_err(|error| format!("self uid lookup failed: {error}"))?
        .uid();
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != self_uid
        || metadata.mode() & 0o7777 != 0o600
        || metadata.size() == 0
        || metadata.size() > MAXIMUM_ENVELOPE_BYTES
    {
        return Err("envelope file identity is invalid".to_owned());
    }
    let mut file = File::open(path).map_err(|error| format!("envelope open failed: {error}"))?;
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.size()).unwrap_or(0));
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("envelope read failed: {error}"))?;
    let after = fs::metadata(path).map_err(|error| format!("envelope recheck failed: {error}"))?;
    if after.dev() != metadata.dev()
        || after.ino() != metadata.ino()
        || after.size() != metadata.size()
        || after.mode() != metadata.mode()
        || after.uid() != metadata.uid()
        || after.gid() != metadata.gid()
        || after.nlink() != metadata.nlink()
    {
        return Err("envelope changed while reading".to_owned());
    }
    Ok(bytes)
}

fn open_verified_target(expected: &GateExecutableIdentityV1) -> Result<File, String> {
    let path = Path::new(&expected.canonical_path);
    let canonical =
        fs::canonicalize(path).map_err(|error| format!("target lookup failed: {error}"))?;
    if canonical != path {
        return Err("target path is noncanonical".to_owned());
    }
    let path_metadata =
        fs::symlink_metadata(path).map_err(|error| format!("target metadata failed: {error}"))?;
    let mut file = File::open(path).map_err(|error| format!("target open failed: {error}"))?;
    let opened = file
        .metadata()
        .map_err(|error| format!("opened target metadata failed: {error}"))?;
    let mode = opened.mode() & 0o7777;
    if path_metadata.file_type().is_symlink()
        || !path_metadata.is_file()
        || !opened.is_file()
        || opened.nlink() != 1
        || mode & 0o7000 != 0
        || mode & 0o022 != 0
        || mode & 0o100 == 0
        || opened.size() == 0
        || opened.size() > MAXIMUM_EXECUTABLE_BYTES
    {
        return Err("target executable is unsafe".to_owned());
    }
    if opened.dev() != path_metadata.dev()
        || opened.ino() != path_metadata.ino()
        || opened.mode() != path_metadata.mode()
        || opened.uid() != path_metadata.uid()
        || opened.gid() != path_metadata.gid()
        || opened.nlink() != path_metadata.nlink()
        || opened.size() != path_metadata.size()
    {
        return Err("target changed while opening".to_owned());
    }
    let observed = GateExecutableIdentityV1 {
        canonical_path: expected.canonical_path.clone(),
        device: opened.dev(),
        inode: opened.ino(),
        mode,
        uid: opened.uid(),
        gid: opened.gid(),
        link_count: opened.nlink(),
        size: opened.size(),
        content_hash: hash_open_file(&mut file)?,
    };
    if &observed != expected {
        return Err("target executable identity changed before launch".to_owned());
    }
    Ok(file)
}

fn clear_close_on_exec(file: &File) -> Result<(), String> {
    let current = fcntl(file.as_fd(), FcntlArg::F_GETFD)
        .map_err(|error| format!("target descriptor inspection failed: {error}"))?;
    let mut flags = FdFlag::from_bits_truncate(current);
    flags.remove(FdFlag::FD_CLOEXEC);
    fcntl(file.as_fd(), FcntlArg::F_SETFD(flags))
        .map_err(|error| format!("target descriptor binding failed: {error}"))?;
    Ok(())
}

fn close_unexpected_file_descriptors() -> Result<(), String> {
    let mut descriptors = fs::read_dir("/proc/self/fd")
        .map_err(|error| format!("descriptor scan failed: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|value| value.parse::<i32>().ok())
        })
        .filter(|descriptor| *descriptor > 2)
        .collect::<Vec<_>>();
    descriptors.sort_unstable();
    descriptors.dedup();
    for descriptor in descriptors {
        match close(descriptor) {
            Ok(()) | Err(nix::errno::Errno::EBADF) => {}
            Err(error) => return Err(format!("descriptor close failed for {descriptor}: {error}")),
        }
    }
    Ok(())
}

fn hash_open_file(file: &mut File) -> Result<Sha256Digest, String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("target hash seek failed: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("target read failed: {error}"))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(read).map_err(|_| "target size overflow".to_owned())?)
            .ok_or_else(|| "target size overflow".to_owned())?;
        if total > MAXIMUM_EXECUTABLE_BYTES {
            return Err("target executable is too large".to_owned());
        }
        hasher.update(&buffer[..read]);
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("target hash rewind failed: {error}"))?;
    digest(hasher)
}

fn hash_bytes(bytes: &[u8]) -> Result<Sha256Digest, String> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    digest(hasher)
}

fn digest(hasher: Sha256) -> Result<Sha256Digest, String> {
    Sha256Digest::from_str(&format!("sha256:{}", hex::encode(hasher.finalize())))
        .map_err(|_| "digest construction failed".to_owned())
}
