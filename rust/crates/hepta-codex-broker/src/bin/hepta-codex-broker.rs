use std::{
    path::Path,
    process::ExitCode,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

use hepta_codex_broker::run_product_codex_broker;
use nix::sys::signal::{SigSet, SigmaskHow, Signal, pthread_sigmask};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("hepta product Codex broker failed: {error}");
            ExitCode::from(2)
        }
    }
}

fn run() -> Result<(), String> {
    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments.len() == 2 && matches!(arguments[1].as_str(), "--help" | "-h") {
        println!("usage: hepta-codex-broker <absolute-config.json>");
        return Ok(());
    }
    if arguments.len() != 2 {
        return Err("usage: hepta-codex-broker <absolute-config.json>".to_owned());
    }
    let path = Path::new(&arguments[1]);
    if !path.is_absolute() {
        return Err("configuration path must be absolute".to_owned());
    }
    let shutdown = Arc::new(AtomicBool::new(false));
    install_signal_watcher(shutdown.clone()).map_err(|error| error.to_string())?;
    let summary = run_product_codex_broker(path, shutdown).map_err(|error| error.to_string())?;
    println!(
        "product_codex_broker_stopped accepted={} queued={} busy={} reconciled={} graceful={}",
        summary.accepted_connections,
        summary.queued_connections,
        summary.busy_connections,
        summary.reconciled_processes,
        summary.graceful_shutdown,
    );
    Ok(())
}

fn install_signal_watcher(shutdown: Arc<AtomicBool>) -> Result<(), nix::errno::Errno> {
    let mut set = SigSet::empty();
    set.add(Signal::SIGINT);
    set.add(Signal::SIGTERM);
    pthread_sigmask(SigmaskHow::SIG_BLOCK, Some(&set), None)?;
    let _ = thread::Builder::new()
        .name("hepta-broker-signal".to_owned())
        .spawn(move || {
            if set.wait().is_ok() {
                shutdown.store(true, Ordering::Release);
            }
        })
        .map_err(|_| nix::errno::Errno::EAGAIN)?;
    Ok(())
}
