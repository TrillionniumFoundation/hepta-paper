use std::io::{self, Read, Write};

use hepta_compatibility::{parse_and_encode_production_v1, parse_and_encode_rust_draft_v1};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    io::stdin()
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut input)?;
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let output = match arguments.as_slice() {
        [] => parse_and_encode_production_v1(&input)?,
        [format] if format == "--rust-draft-v1" => parse_and_encode_rust_draft_v1(&input)?,
        _ => {
            return Err("usage: hepta-legacy-stable-json-v1 [--rust-draft-v1] < input.json".into());
        }
    };
    io::stdout().write_all(&output)?;
    Ok(())
}
