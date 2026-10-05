use std::process::Command;

// Only freshly copied, owned fixture executables can transiently retain a
// kernel text-busy state. Keep the existing one-second spawn-retry allowance;
// other spawn errors fail immediately and child failures are never retried.
// This allowance does not bound the successfully started child's runtime.
pub(super) fn copied_fixture_output(command: &mut Command) -> std::process::Output {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        match command.output() {
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
