use hepta_paper_service::runtime_image_reproducibility::runtime_image_reproducibility_cli_v1;
use std::collections::BTreeMap;
fn run() -> Result<i32, String> {
    let argv: Vec<_> = std::env::args().skip(1).collect();
    let environment = std::env::vars().collect::<BTreeMap<_, _>>();
    let output = runtime_image_reproducibility_cli_v1(&argv, &environment)
        .map_err(|error| error.to_string())?;
    if let Some(text) = output.text {
        println!("{text}");
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&output.value).map_err(|error| error.to_string())?
        );
    }
    Ok(output.exit_code)
}
fn main() {
    match run() {
        Ok(0) => (),
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1)
        }
    }
}
