//! Test-only selection of a real installed Rscript. This is not runtime
//! authority or a replacement for the scientific profile's executable hash.
use std::{fs, path::PathBuf};

pub fn selected_rscript() -> PathBuf {
    let selected = std::env::var_os("HEPTA_TEST_R_EXECUTABLE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/usr/bin/Rscript"));
    assert!(selected.is_absolute(), "Rscript selection must be absolute");
    let executable = fs::canonicalize(&selected)
        .expect("the explicitly selected real Rscript must exist; no fallback");
    assert!(executable.is_file(), "Rscript must be a regular executable");
    executable
}
