//! Versioned source contracts retained during branch consolidation.
//!
//! These supplied-data algorithms preserve earlier wire/hash formats alongside
//! the current planner, optimizer and telemetry contracts. They perform no
//! process/provider/database actions and confer no authority or deployment.
pub mod calibration;
pub mod model_selection;
pub mod observability;
