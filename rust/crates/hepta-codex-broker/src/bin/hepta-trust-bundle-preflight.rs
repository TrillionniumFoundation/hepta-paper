use std::{path::Path, process};

use hepta_codex_broker::trust_bundle_file::{
    TrustBundleFilePolicyV1, load_authority_owned_trust_bundle,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("hepta trust-bundle preflight failed: {error}");
        process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments.len() != 5 {
        return Err(
            "usage: hepta-trust-bundle-preflight <path> <authority-uid> <authority-gid|-> <broker-uid>"
                .to_owned(),
        );
    }
    let authority_uid = parse_u32(&arguments[2], "authority UID")?;
    let authority_gid = if arguments[3] == "-" {
        None
    } else {
        Some(parse_u32(&arguments[3], "authority GID")?)
    };
    let broker_uid = parse_u32(&arguments[4], "broker UID")?;
    let loaded = load_authority_owned_trust_bundle(
        Path::new(&arguments[1]),
        TrustBundleFilePolicyV1::production(authority_uid, authority_gid, broker_uid),
    )
    .map_err(|error| error.to_string())?;
    let _: serde_json::Value = loaded
        .decode_canonical_json()
        .map_err(|error| error.to_string())?;
    println!(
        "trust_bundle_file_verified path={} dev={} inode={} uid={} gid={} mode={:04o} bytes={}",
        loaded.identity.canonical_path.display(),
        loaded.identity.device,
        loaded.identity.inode,
        loaded.identity.uid,
        loaded.identity.gid,
        loaded.identity.mode,
        loaded.identity.bytes,
    );
    Ok(())
}

fn parse_u32(value: &str, label: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .map_err(|_| format!("{label} is not a valid unsigned integer"))
}
