//! Completed read-only observations of original stored qualification evidence.
//!
//! These readers validate storage/data contracts, not signatures or current
//! qualification. They never provision, repair, publish, lease or invoke an
//! external process. All source descriptors and private SQLite connections
//! close before return; callers must invoke them before opening business SQLite.

mod files;
mod json;
mod pointer;
mod sqlite;
mod state;

#[cfg(test)]
mod tests;

pub use pointer::read_full_research_qualification_receipt_pointer_v1;
pub use state::read_autonomous_external_qualification_state_v1;

/// A stable data-reader diagnostic without raw SQL, paths or stored payloads.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{code}")]
pub struct Error {
    code: String,
}

impl Error {
    fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }
    /// Original business error or a documented native profile refusal.
    #[must_use]
    pub fn code(&self) -> &str {
        &self.code
    }
}

/// Result of actual read-only filesystem/SQLite observation.
pub type Result<T> = std::result::Result<T, Error>;

fn ensure(valid: bool, code: &str) -> Result<()> {
    if valid { Ok(()) } else { Err(Error::new(code)) }
}
