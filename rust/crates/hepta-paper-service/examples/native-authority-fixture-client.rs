//! Test-only process adapter for the native composition fixture. This is not an
//! installed authority adapter, production entry point, or qualification proof.
//! Its copied executable must live in an isolated private fixture directory;
//! the sole socket comes from that directory's fixed, private adapter.json.
use hepta_paper_service::local_state_authority_client::{
    LocalStateAuthorityClientOptionsV1, request_local_state_authority_json_v1,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::PathBuf,
};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    version: u16,
    kind: String,
    socket_path: PathBuf,
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args_os().len() != 1 {
        return Err("fixture adapter accepts no arguments".into());
    }
    let executable = std::env::current_exe()?;
    let root = executable.parent().ok_or("fixture root absent")?;
    if root.parent() != Some(std::path::Path::new("/tmp"))
        || !root
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("hepta-online-initial-composition-"))
        || fs::canonicalize(root)? != root
        || executable.file_name().and_then(|n| n.to_str()) != Some("native-fixture-client")
    {
        return Err("isolated fixture executable required".into());
    }
    let directory = fs::symlink_metadata(root)?;
    if !directory.is_dir()
        || directory.uid() != nix::unistd::geteuid().as_raw()
        || directory.mode() & 0o7777 != 0o700
    {
        return Err("private fixture root required".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC | nix::libc::O_NONBLOCK)
        .open(root.join("adapter.json"))?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.len() > 4096
        || metadata.mode() & 0o7777 != 0o600
        || metadata.uid() != directory.uid()
    {
        return Err("private fixture binding required".into());
    }
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    if bytes.len() > 4096 || bytes.len() as u64 != metadata.len() {
        return Err("fixture binding length changed".into());
    }
    let fixture: Fixture = serde_json::from_slice(&bytes)?;
    if fixture.version != 1
        || fixture.kind != "HeptaNativeAuthorityTestSocketBindingV1"
        || fixture.socket_path != root.join("authority.sock")
    {
        return Err("fixed fixture socket required".into());
    }
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut input)?;
    if input.len() > 16 * 1024 * 1024 {
        return Err("fixture request limit".into());
    }
    let request: Value = serde_json::from_slice(&input)?;
    let receipt = request_local_state_authority_json_v1(
        &input,
        &LocalStateAuthorityClientOptionsV1 {
            socket_path: fixture.socket_path,
            timeout_ms: 10000,
            ..Default::default()
        },
    )?;
    let mut log = OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(root.join("native-calls.jsonl"))?;
    // Parsed values serve diagnostic logging only. The actual transport and
    // stdout retain the strict-validated wire object, including nested order.
    let logged_receipt: Value = serde_json::from_str(receipt.get())?;
    writeln!(
        log,
        "{}",
        json!({"request":request,"receipt":logged_receipt,"receiptJson":receipt.get()})
    )?;
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(receipt.get().as_bytes())?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}
fn main() {
    if let Err(cause) = run() {
        eprintln!("native authority fixture adapter: {cause}");
        std::process::exit(1);
    }
}
