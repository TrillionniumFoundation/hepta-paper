//! Preserve the prior strict all-ancestor metadata policy where this Linux
//! kernel witness is unavailable. Never silently enable selective comparison.
use super::*;

pub(super) struct AncestorContinuity;
impl AncestorContinuity {
    pub(super) fn new(control: &ReadControl) -> Result<Self, ReadOnlyStoreError> {
        control.check()?;
        Ok(Self)
    }
    pub(super) fn watch(
        &mut self,
        _directory: &File,
        _selected_name: &std::ffi::OsStr,
    ) -> Result<bool, ReadOnlyStoreError> {
        Ok(false)
    }
    pub(super) fn verify(&self, control: &ReadControl) -> Result<(), ReadOnlyStoreError> {
        control.check()
    }
}
