use hepta_paper_service::local_state_authority::{
    LocalStateAuthorityRuntimeV1, LocalStateAuthorityServerV1,
};
use nix::sys::signal::{SigSet, SigmaskHow, Signal, pthread_sigmask};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

fn run() -> Result<(), String> {
    let arguments = std::env::args_os()
        .skip(1)
        .map(|v| v.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    let mut help = false;
    let mut configuration = None;
    let mut index = 0;
    while index < arguments.len() {
        let argument = &arguments[index];
        if argument == "--" {
            return Err("unexpected_cli_argument_separator".into());
        }
        let Some(option) = argument.strip_prefix("--") else {
            return Err(format!("unexpected_cli_positional:{argument}"));
        };
        let (key, inline) = option
            .split_once('=')
            .map_or((option, None), |(k, v)| (k, Some(v)));
        match key {
            "" => return Err("empty_cli_option".into()),
            "help" => {
                if inline.is_some() {
                    return Err("boolean_cli_option_does_not_take_value:--help".into());
                }
                if help {
                    return Err("duplicate_cli_option:--help".into());
                }
                help = true;
            }
            "configuration" => {
                let value = match inline {
                    Some(value) => value,
                    None => {
                        index += 1;
                        arguments
                            .get(index)
                            .filter(|v| !v.starts_with("--"))
                            .map(String::as_str)
                            .ok_or("missing_cli_option_value:--configuration")?
                    }
                };
                if value.is_empty() {
                    return Err("empty_cli_option_value:--configuration".into());
                }
                if configuration.is_some() {
                    return Err("duplicate_cli_option:--configuration".into());
                }
                configuration = Some(value.to_owned());
            }
            _ => return Err(format!("unknown_cli_option:--{key}")),
        }
        index += 1;
    }
    if help {
        println!("Usage: hepta-paper-state-authority-daemon [--configuration PATH]");
        return Ok(());
    }
    let path = PathBuf::from(
        configuration
            .as_deref()
            .unwrap_or("/etc/hepta-paper/state-authority/daemon-config.json"),
    );
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(path)
    };
    // Match path.resolve's lexical normalization before opening the configured
    // path. Actual snapshots still reject symlinks and changed identities.
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            value => normalized.push(value.as_os_str()),
        }
    }
    let path = normalized;
    let mut signals = SigSet::empty();
    signals.add(Signal::SIGINT);
    signals.add(Signal::SIGTERM);
    pthread_sigmask(SigmaskHow::SIG_BLOCK, Some(&signals), None).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let shutdown = stop.clone();
    std::thread::spawn(move || {
        if signals.wait().is_ok() {
            shutdown.store(true, Ordering::Release);
        }
    });
    let runtime = LocalStateAuthorityRuntimeV1::open(&path).map_err(|e| e.code)?;
    let mut server = LocalStateAuthorityServerV1::bind(runtime).map_err(|e| e.code)?;
    server.serve(&stop).map_err(|e| e.code)
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
