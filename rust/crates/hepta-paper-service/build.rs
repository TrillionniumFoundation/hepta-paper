use std::{env, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = fs::canonicalize(PathBuf::from(
        env::var_os("OUT_DIR").ok_or("Cargo OUT_DIR unavailable")?,
    ))?;
    let profile = output
        .ancestors()
        .nth(3)
        .ok_or("Cargo profile layout unavailable")?;
    println!(
        "cargo:rustc-env=HEPTA_NATIVE_BUILD_PROFILE_ROOT_V1={}",
        profile
            .to_str()
            .ok_or("UTF-8 Cargo profile root required")?
    );
    println!("cargo:rerun-if-changed=build.rs");
    Ok(())
}
