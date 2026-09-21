//! A distinct pinned socket profile; Process V1/V2 command pins are never waived.
//! Receipt signatures authenticate configured keys, not native installation or
//! service-manager membership. Construct before opening any owning SQLite handle.
use super::*;
use crate::local_state_authority_client::{
    LocalStateAuthorityClientOptionsV1, LocalStateAuthoritySocketTransportV1,
    MAXIMUM_MESSAGE_BYTES, MAXIMUM_TIMEOUT_MS,
};
use std::path::PathBuf;

const CONFIGURATION_KIND: &str = "AutonomousResearchStateBackupAuthoritySocketConfiguration";
const CONFIGURATION_INVALID: &str =
    "autonomous_research_state_backup_authority_socket_configuration_invalid";
const IDENTITY_MISMATCH: &str =
    "autonomous_research_state_backup_authority_socket_identity_mismatch";
const BINDING_MISMATCH: &str = "autonomous_research_state_backup_online_authority_binding_mismatch";
const CONFIGURATION_KEYS: &[&str] = &[
    "version",
    "kind",
    "authorityId",
    "keyId",
    "socketPath",
    "timeoutMs",
    "maximumMessageBytes",
    "publicKeyPath",
    "publicKeySha256",
    "maximumReservationLeaseMs",
    "maximumHeadObservationAgeMs",
    "onlineMutationAuthorityConfigurationPath",
    "onlineMutationAuthorityConfigurationSha256",
];

fn valid_path_text(path: &str) -> bool {
    path.starts_with('/')
        && path.len() > 1
        && !path.contains('\0')
        && path[1..]
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
fn absolute_path(value: &Value) -> bool {
    value.as_str().is_some_and(valid_path_text)
}
fn valid_configuration(value: &Value) -> bool {
    keys(value, CONFIGURATION_KEYS)
        && number(&value["version"]) == Some(1)
        && value["kind"] == CONFIGURATION_KIND
        && ["authorityId", "keyId"]
            .iter()
            .all(|key| safe_id(&value[key]))
        && [
            "socketPath",
            "publicKeyPath",
            "onlineMutationAuthorityConfigurationPath",
        ]
        .iter()
        .all(|key| absolute_path(&value[key]))
        && [
            "publicKeySha256",
            "onlineMutationAuthorityConfigurationSha256",
        ]
        .iter()
        .all(|key| sha(&value[key]))
        && number(&value["timeoutMs"])
            .is_some_and(|n| (1000..=MAXIMUM_TIMEOUT_MS as i64).contains(&n))
        && number(&value["maximumMessageBytes"])
            .is_some_and(|n| (1024..=MAXIMUM_MESSAGE_BYTES as i64).contains(&n))
        && ["maximumReservationLeaseMs", "maximumHeadObservationAgeMs"]
            .iter()
            .all(|key| number(&value[key]).is_some_and(|n| (1000..=900000).contains(&n)))
}

impl PinnedStateBackupAuthorityV1<LocalStateAuthoritySocketTransportV1> {
    /// Load the strict, separately pinned SocketConfiguration V1 profile and
    /// capture the actual socket origin before any protocol request is sent.
    /// All public files are pinned before the empty socket probe. This is an
    /// untrusted transport plus signature verifier, not installation authority.
    pub fn load_socket_v1(path: &Path, raw_file_pin: &str) -> Result<Self> {
        if !path.to_str().is_some_and(valid_path_text) {
            return Err(error(CONFIGURATION_INVALID));
        }
        let configuration =
            Snapshot::load(path, raw_file_pin, 4 * 1024 * 1024, CONFIGURATION_INVALID)?;
        let value = configuration.json(CONFIGURATION_INVALID)?;
        if !valid_configuration(&value) {
            return Err(error(CONFIGURATION_INVALID));
        }
        let public_document = Snapshot::load(
            Path::new(text(&value, "publicKeyPath")?),
            text(&value, "publicKeySha256")?,
            64 * 1024,
            IDENTITY_MISMATCH,
        )?;
        let key = parse_public_key(&public_document, &value)?;
        let online_path = Path::new(text(&value, "onlineMutationAuthorityConfigurationPath")?);
        let online_pin = text(&value, "onlineMutationAuthorityConfigurationSha256")?;
        let online_configuration =
            Snapshot::load(online_path, online_pin, 4 * 1024 * 1024, IDENTITY_MISMATCH)?;
        let online = PinnedMutationAuthorityV1::load(online_path, online_pin, NoOnlineTransport)?;
        let online_trust = online.trust();
        if value["authorityId"] != online_trust["authorityId"]
            || value["keyId"] != online_trust["keyId"]
            || key != *online.verification_key()
            || !equal(
                &value["maximumReservationLeaseMs"],
                &online_trust["maximumReservationLeaseMs"],
            )
            || !equal(
                &value["maximumHeadObservationAgeMs"],
                &online_trust["maximumObservationAgeMs"],
            )
        {
            return Err(error(BINDING_MISMATCH));
        }
        let trust = json!({"version":1,"kind":"AutonomousResearchStateBackupAuthorityTrust",
            "authorityId":value["authorityId"],"keyId":value["keyId"],
            "maximumReservationLeaseMs":value["maximumReservationLeaseMs"],
            "maximumHeadObservationAgeMs":value["maximumHeadObservationAgeMs"]});
        let configuration_hash = hash(CONFIGURATION_KIND, &value)?;
        let options = LocalStateAuthorityClientOptionsV1 {
            socket_path: PathBuf::from(text(&value, "socketPath")?),
            timeout_ms: u64::try_from(
                number(&value["timeoutMs"]).ok_or_else(|| error(CONFIGURATION_INVALID))?,
            )
            .map_err(|_| error(CONFIGURATION_INVALID))?,
            maximum_message_bytes: usize::try_from(
                number(&value["maximumMessageBytes"])
                    .ok_or_else(|| error(CONFIGURATION_INVALID))?,
            )
            .map_err(|_| error(CONFIGURATION_INVALID))?,
        };
        // No regular file is captured after the probe or any future invocation.
        configuration.assert_current()?;
        public_document.assert_current()?;
        online_configuration.assert_current()?;
        online.current()?;
        let transport = LocalStateAuthoritySocketTransportV1::connect(&options)?;
        let result = Self {
            configuration,
            public_document,
            profile: ConfigurationProfile::Socket,
            trust,
            key,
            configuration_hash,
            online: Some(online),
            online_configuration: Some(online_configuration),
            transport,
        };
        result.current()?;
        Ok(result)
    }
}

#[derive(Clone, Copy)]
pub(super) enum Operation {
    Reserve,
    Finalize,
    Head,
    Journal,
}
impl Operation {
    fn kind(self) -> &'static str {
        match self {
            Self::Reserve => "AutonomousResearchStateBackupAuthorityReserveRequest",
            Self::Finalize => "AutonomousResearchStateBackupAuthorityFinalizeRequest",
            Self::Head => "AutonomousResearchStateBackupAuthorityCurrentHeadRequest",
            Self::Journal => "AutonomousResearchStateBackupAuthorityJournalRangeRequest",
        }
    }
    fn keys(self) -> &'static [&'static str] {
        match self {
            Self::Reserve => &[
                "version",
                "kind",
                "inventoryHash",
                "databaseScopeHash",
                "databaseInstanceIds",
                "requestedAt",
                "maximumLeaseMs",
            ],
            Self::Finalize => &[
                "version",
                "kind",
                "reservationId",
                "inventoryHash",
                "databaseScopeHash",
                "snapshotContentHash",
                "requestedAt",
            ],
            Self::Head => &[
                "version",
                "kind",
                "reservationId",
                "databaseScopeHash",
                "snapshotContentHash",
                "requestedAt",
                "maximumLeaseMs",
            ],
            Self::Journal => &[
                "version",
                "kind",
                "reservationId",
                "databaseScopeHash",
                "snapshotContentHash",
                "onlineAuthorityId",
                "onlineKeyId",
                "scopeId",
                "writerManifestHash",
                "fromGlobalSequence",
                "fromGlobalHash",
                "toGlobalSequence",
                "toGlobalHash",
                "requestedAt",
                "maximumLeaseMs",
                "maximumEntries",
            ],
        }
    }
}

// Both pure verifiers and RPC methods use this gate. A caller's genuine signed
// off-scope receipt cannot acquire a socket-profile opaque receipt by bypassing
// the transport. Process V1/V2 retain their original validation and ordering.
pub(super) fn assert_request<T: StateBackupAuthorityTransportV1>(
    authority: &PinnedStateBackupAuthorityV1<T>,
    request: &Value,
    operation: Operation,
) -> Result<()> {
    if !matches!(authority.profile, ConfigurationProfile::Socket) {
        return Ok(());
    }
    if !keys(request, operation.keys())
        || number(&request["version"]) != Some(1)
        || request["kind"] != operation.kind()
    {
        return Err(error(
            "autonomous_research_state_backup_authority_socket_request_invalid",
        ));
    }
    let trust = authority
        .online
        .as_ref()
        .ok_or_else(|| error(BINDING_MISMATCH))?
        .trust();
    if request["databaseScopeHash"] != trust["databaseScopeHash"]
        || (matches!(operation, Operation::Journal)
            && (request["onlineAuthorityId"] != trust["authorityId"]
                || request["onlineKeyId"] != trust["keyId"]
                || request["scopeId"] != trust["scopeId"]
                || request["writerManifestHash"] != trust["writerManifestHash"]))
    {
        return Err(error(
            "autonomous_research_state_backup_authority_socket_request_scope_mismatch",
        ));
    }
    if !matches!(operation, Operation::Finalize)
        && !number(&request["maximumLeaseMs"]).is_some_and(|lease| {
            number(&authority.trust["maximumReservationLeaseMs"])
                .is_some_and(|maximum| (1000..=maximum).contains(&lease))
        })
    {
        return Err(error(
            "autonomous_research_state_backup_authority_socket_request_lease_invalid",
        ));
    }
    Ok(())
}

// Phase evidence belongs only to actual RPC methods. Pure verification neither
// sends requests nor makes claims about how a caller obtained a receipt.
pub(super) fn rpc_result<T: StateBackupAuthorityTransportV1, R>(
    authority: &PinnedStateBackupAuthorityV1<T>,
    result: Result<R>,
    sent: bool,
) -> Result<R> {
    if !matches!(authority.profile, ConfigurationProfile::Socket) {
        return result;
    }
    result.map_err(|mut failure| {
        if !failure.details.is_object() {
            failure.details = json!({"causeDetails":failure.details});
        }
        failure.details["transport"] = json!("local-state-authority-socket-v1");
        failure.details["requestDelivery"] = json!(if sent { "sent" } else { "not_sent" });
        failure.details["authorityOutcome"] = json!(if sent { "unknown" } else { "not_invoked" });
        failure.details["inspectionRequired"] = json!(sent);
        if !sent {
            failure.details["requestBytesSent"] = json!(0);
        }
        failure.retryable = false;
        failure
    })
}

#[cfg(test)]
mod tests;
