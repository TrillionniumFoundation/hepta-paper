use std::io::{self, Read, Write};

use hepta_compatibility::parse_and_encode_legacy_v1;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = Vec::new();
    io::stdin()
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut input)?;
    let output = parse_and_encode_legacy_v1(&input)?;
    io::stdout().write_all(&output)?;
    Ok(())
}
