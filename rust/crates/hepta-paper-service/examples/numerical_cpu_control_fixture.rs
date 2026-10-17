//! Test-only process owner for the ordinary numerical entry and its caller controls.
use hepta_paper_service::ordinary_advanced_numerical_plugin::run_ordinary_advanced_numerical_plugin_status_v1;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mode = args.next().ok_or("control mode required")?;
    let output_root = PathBuf::from(args.next().ok_or("observed fixture output required")?);
    let input: Vec<String> = args.collect();
    let c = Arc::new(AtomicBool::new(mode == "cancel-before"));
    let d = Instant::now() + Duration::from_secs(if mode == "deadline-before" { 1 } else { 120 });
    let thread = if mode == "cancel-after-start" {
        let flag = Arc::clone(&c);
        Some(std::thread::spawn(move || -> Result<bool, String> {
            let until = Instant::now() + Duration::from_secs(20);
            while Instant::now() < until {
                let entries = std::fs::read_dir(&output_root).map_err(|e| e.to_string())?;
                for entry in entries {
                    let path = entry.map_err(|e| e.to_string())?.path();
                    if path.file_name().is_some_and(|n| {
                        n.to_string_lossy().starts_with(".hepta-native-numerical-")
                    }) && path.join("output/started").is_file()
                    {
                        flag.store(true, Ordering::Release);
                        return Ok(true);
                    }
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            flag.store(true, Ordering::Release);
            Ok(false)
        }))
    } else {
        None
    };
    let result = run_ordinary_advanced_numerical_plugin_status_v1(&input, &c, d);
    let observed_started = match thread {
        Some(t) => t.join().map_err(|_| "fixture observer thread failed")??,
        None => false,
    };
    let output = match result {
        Ok(out) => {
            serde_json::json!({"ok":true,"exitCode":out.exit_code,"stdout":String::from_utf8(out.stdout)?,"observedStarted":observed_started})
        }
        Err(error) => {
            serde_json::json!({"ok":false,"error":error,"observedStarted":observed_started})
        }
    };
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}
