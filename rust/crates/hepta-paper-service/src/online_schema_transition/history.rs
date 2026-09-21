//! Authenticated historical starting points. These do not establish current
//! business-state equivalence, runtime readiness, or permission to mutate.
pub mod checkpoint;

// Sealed until the owning native activation composition consumes this proof.
#[allow(dead_code)]
pub(crate) mod current;
