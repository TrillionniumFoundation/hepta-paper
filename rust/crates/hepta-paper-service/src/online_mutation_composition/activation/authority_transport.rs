//! Closed product authority transports. Process is migration compatibility;
//! InstalledSocket is the native installed owner. Both feed the same state machine.
use crate::{
    local_state_authority_client::LocalStateAuthoritySocketTransportV1,
    sqlite_mutation_coordinator::{
        Result,
        authority::{MutationAuthorityTransportV1, ProcessMutationAuthorityTransportV1},
    },
    state_backup_authority::{
        ProcessStateBackupAuthorityTransportV1, StateBackupAuthorityTransportV1,
    },
};
use serde_json::Value;

pub(super) enum OnlineAuthorityTransportV1 {
    Process {
        inner: Box<ProcessMutationAuthorityTransportV1>,
        profile_hash: String,
    },
    InstalledSocket {
        inner: LocalStateAuthoritySocketTransportV1,
        profile_hash: String,
    },
}

impl OnlineAuthorityTransportV1 {
    pub(super) fn profile_hash(&self) -> &str {
        match self {
            Self::Process { profile_hash, .. } | Self::InstalledSocket { profile_hash, .. } => {
                profile_hash
            }
        }
    }
    pub(super) fn profile_field(&self) -> &'static str {
        match self {
            Self::Process { .. } => "onlineAuthorityProcessConfigurationHash",
            Self::InstalledSocket { .. } => "onlineAuthorityInstalledSocketProfileHash",
        }
    }
    pub(super) fn assert_current(&self) -> Result<()> {
        match self {
            Self::Process { inner, .. } => inner.current(),
            Self::InstalledSocket { inner, .. } => inner.assert_origin_current_v1(),
        }
    }
}

impl MutationAuthorityTransportV1 for OnlineAuthorityTransportV1 {
    fn invoke(&mut self, request: &Value) -> Result<Value> {
        match self {
            Self::Process { inner, .. } => inner.invoke(request),
            Self::InstalledSocket { inner, .. } => {
                MutationAuthorityTransportV1::invoke(inner, request)
            }
        }
    }
}

pub(super) enum BackupAuthorityTransportV1 {
    Process(Box<ProcessStateBackupAuthorityTransportV1>),
    InstalledSocket(LocalStateAuthoritySocketTransportV1),
}

impl BackupAuthorityTransportV1 {
    pub(super) fn assert_current(&self) -> Result<()> {
        match self {
            Self::Process(value) => value.current(),
            Self::InstalledSocket(value) => value.assert_origin_current_v1(),
        }
    }
}
impl StateBackupAuthorityTransportV1 for BackupAuthorityTransportV1 {
    fn invoke(&mut self, request: &Value) -> Result<Value> {
        match self {
            Self::Process(value) => value.invoke(request),
            Self::InstalledSocket(value) => StateBackupAuthorityTransportV1::invoke(value, request),
        }
    }
}
