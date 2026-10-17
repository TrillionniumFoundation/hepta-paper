use std::{
    fs, io,
    path::Path,
    process::{Child, Command, Output, Stdio},
    sync::Mutex,
};

// Keep executable writers and parent-process creation mutually exclusive.
// Both helpers release the guard before caller I/O, waits, or native work.
static EXECUTABLE_COPY_OR_SPAWN: Mutex<()> = Mutex::new(());

pub(super) fn copy_executable(from: &Path, to: &Path) -> io::Result<u64> {
    let _guard = EXECUTABLE_COPY_OR_SPAWN.lock().unwrap();
    fs::copy(from, to)
}

pub(super) fn spawn(command: &mut Command) -> io::Result<Child> {
    let _guard = EXECUTABLE_COPY_OR_SPAWN.lock().unwrap();
    command.spawn()
}

// Only for audited output call sites whose stdio was initially unset and whose
// later reuse does not depend on it remaining unset. This is not a general
// replacement for Command::output with arbitrary explicit stdio settings.
pub(super) fn output_default_stdio(command: &mut Command) -> io::Result<Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = spawn(command)?;
    child.wait_with_output()
}

// Only freshly copied, owned fixture executables can transiently retain a
// kernel text-busy state. Keep the existing one-second spawn-retry allowance;
// other spawn errors fail immediately and child failures are never retried.
// This allowance does not bound the successfully started child's runtime.
pub(super) fn copied_fixture_output(command: &mut Command) -> std::process::Output {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        match output_default_stdio(command) {
            Ok(output) => return output,
            Err(error)
                if error.raw_os_error() == Some(26) && std::time::Instant::now() < deadline =>
            {
                eprintln!(
                    "owned copied executable transient ETXTBSY; retrying within original owner"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(error) => panic!("owned copied executable spawn failed: {error}"),
        }
    }
}
