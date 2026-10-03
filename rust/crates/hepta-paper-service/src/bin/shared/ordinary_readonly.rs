//! CLI-only signal adapter shared by ordinary read-only commands.
//! Resource owners clean up before restoring the incumbent termination status.
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

pub(super) fn with_node_termination_v1<T>(
    operation: impl FnOnce(Arc<AtomicBool>) -> Result<T, Box<dyn std::error::Error>>,
) -> Result<T, Box<dyn std::error::Error>> {
    let completed = Arc::new(AtomicBool::new(false));
    let observed_signal = Arc::new(AtomicUsize::new(0));
    let cancelled = Arc::new(AtomicBool::new(false));
    for signal in [signal_hook::consts::SIGINT, signal_hook::consts::SIGTERM] {
        signal_hook::flag::register_usize(signal, Arc::clone(&observed_signal), signal as usize)?;
        signal_hook::flag::register(signal, Arc::clone(&cancelled))?;
        // Signal-hook preserves registration order with sequentially consistent
        // stores. Record the signal before consulting completion, so a callback
        // crossing the completion boundary cannot silently lose termination.
        signal_hook::flag::register_conditional_default(signal, Arc::clone(&completed))?;
    }
    let result = operation(cancelled);
    // The callback has dropped its retained inputs and cleaned owned processes
    // on both success and failure. Future signals also terminate blocked stdout.
    completed.store(true, Ordering::SeqCst);
    let signal = observed_signal.load(Ordering::SeqCst);
    if signal == signal_hook::consts::SIGINT as usize
        || signal == signal_hook::consts::SIGTERM as usize
    {
        signal_hook::low_level::emulate_default_handler(signal as i32)?;
    }
    result
}
