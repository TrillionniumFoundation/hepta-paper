//! Real migration-source projections. These local observations do not establish
//! maintenance authority, writer quiescence, a ready inventory or runtime activation.
pub mod maintenance;
pub mod plan;
use crate::{
    online_schema_transition::target_schema::SchemaTransitionTargetV1,
    sqlite_mutation_coordinator::Result, state_database_inventory::schema_source::SchemaSource,
};
use serde_json::Value;
use std::path::Path;

/// Created only from actual source files and SQLite work on an owned private
/// copy. The source remains byte-for-byte unchanged. No serialized claim can
/// construct this object or authorize a source write.
pub struct ObservedSchemaTransitionSourceV1 {
    source: SchemaSource,
    projection: Value,
}
impl ObservedSchemaTransitionSourceV1 {
    pub fn value(&self) -> &Value {
        &self.projection
    }
    /// Rehashes source DB, WAL, SHM and rollback journal and rechecks their held
    /// identities and parent directories. This is not a lease against future writes.
    pub fn assert_current(&self) -> Result<()> {
        self.source.assert_current()
    }
}
/// Observe a real pre-transition database, including databases that cannot yet
/// satisfy the ready-inventory schema. The role chooses fixed migration SQL;
/// it is not independently authenticated by this single-source observation.
pub fn observe_schema_transition_source_v1(
    runtime_root: &Path,
    source_relative_path: &Path,
    role: &str,
    applied_at: Option<&str>,
) -> Result<ObservedSchemaTransitionSourceV1> {
    let source = SchemaSource::observe(runtime_root, source_relative_path, role)?;
    let target = SchemaTransitionTargetV1::for_role(role, applied_at)?;
    let projection = source.project(&target)?;
    source.assert_current()?;
    Ok(ObservedSchemaTransitionSourceV1 { source, projection })
}
