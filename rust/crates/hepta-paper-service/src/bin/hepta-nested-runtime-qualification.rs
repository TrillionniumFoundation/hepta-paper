use hepta_paper_service::nested_runtime_cli::{
    NestedRuntimeCliOutputV1, current_nested_runtime_clock_v1, nested_runtime_qualification_cli_v1,
};
use hepta_paper_service::nested_runtime_qualification::verify_nested_runtime_platform_qualification_file_v1;
use std::path::PathBuf;

fn run() -> Result<i32, String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let (report, blocked_code) = if args.len() == 2 && args[0] == "--request" {
        let path = PathBuf::from(&args[1]);
        if !path.is_absolute() {
            return Err("absolute request path required".into());
        }
        (
            verify_nested_runtime_platform_qualification_file_v1(&path)
                .map_err(|e| e.to_string())?,
            2,
        )
    } else {
        match nested_runtime_qualification_cli_v1(
            &args,
            &std::env::vars().collect(),
            &current_nested_runtime_clock_v1()?,
        )? {
            NestedRuntimeCliOutputV1::Help(text) => {
                println!("{text}");
                return Ok(0);
            }
            NestedRuntimeCliOutputV1::Report(report) => (report, 1),
        }
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    Ok(if report["ready"] == true {
        0
    } else {
        blocked_code
    })
}
fn main() {
    match run() {
        Ok(0) => (),
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
