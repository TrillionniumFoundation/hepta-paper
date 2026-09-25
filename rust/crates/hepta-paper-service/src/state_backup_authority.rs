//! Independently pinned snapshot authority. A verified authority receipt is not
//! a restore-source readiness claim; actual bundle, database bytes and replay
//! evidence must still be validated by the recoverability source layer.
mod contracts;
pub mod manifest;
use crate::sqlite_mutation_coordinator::authority::files as pinned_files;
mod process;
mod recovery_support;
pub mod restore_source;
pub(crate) mod socket;
use crate::sqlite_mutation_coordinator::authority::{
    MutationAuthorityTransportV1, PinnedMutationAuthorityV1,
};
use crate::sqlite_mutation_coordinator::{Result, error, hash, keys, sha, text};
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signature, VerifyingKey, pkcs8::DecodePublicKey};
use pinned_files::Snapshot;
pub use process::ProcessStateBackupAuthorityTransportV1;
use serde_json::{Value, json};
use std::path::Path;
pub const FINALIZED_JOURNAL_PROTOCOL: &str = "external-linearizable-finalized-mutation-journal-v1";
pub const MAXIMUM_JOURNAL_ENTRIES: i64 = 4096;

/// Raw JSON transport never constructs an authenticated receipt or readiness.
pub trait StateBackupAuthorityTransportV1 {
    fn invoke(&mut self, request: &Value) -> Result<Value>;
}
#[derive(Clone)]
pub struct VerifiedBackupAuthorityReceiptV1 {
    value: Value,
    configuration_hash: String,
}
impl VerifiedBackupAuthorityReceiptV1 {
    pub fn value(&self) -> &Value {
        &self.value
    }
}
struct NoOnlineTransport;
impl MutationAuthorityTransportV1 for NoOnlineTransport {
    fn invoke(&mut self, _: &Value) -> Result<Value> {
        Err(error(
            "autonomous_research_state_backup_online_authority_transport_unavailable",
        ))
    }
}
enum ConfigurationProfile {
    Process { command: Box<Snapshot> },
    Socket,
}
impl ConfigurationProfile {
    fn process_command(&self) -> Result<&Snapshot> {
        match self {
            Self::Process { command } => Ok(command),
            Self::Socket => Err(error(
                "autonomous_research_state_backup_authority_process_identity_mismatch",
            )),
        }
    }
}
pub struct PinnedStateBackupAuthorityV1<T> {
    configuration: Snapshot,
    public_document: Snapshot,
    profile: ConfigurationProfile,
    trust: Value,
    key: VerifyingKey,
    configuration_hash: String,
    online: Option<PinnedMutationAuthorityV1<NoOnlineTransport>>,
    online_configuration: Option<Snapshot>,
    transport: T,
}
fn safe_id(value: &Value) -> bool {
    value.as_str().is_some_and(|v| {
        (2..=128).contains(&v.len())
            && v.as_bytes()[0].is_ascii_alphanumeric()
            && v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    })
}
fn number(value: &Value) -> Option<i64> {
    value
        .as_f64()
        .filter(|v| v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0)
        .map(|v| v as i64)
}
fn instant(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(crate::journal_connector_coverage::qualification::canonical_instant_millis)
}
fn equal(a: &Value, b: &Value) -> bool {
    a == b || (a.is_number() && b.is_number() && a.as_f64() == b.as_f64())
}
pub fn state_backup_authority_signature_payload_v1(receipt: &Value) -> Result<String> {
    let mut unsigned = receipt
        .as_object()
        .cloned()
        .ok_or_else(|| error("autonomous_research_state_backup_authority_receipt_invalid"))?;
    unsigned.remove("signature");
    hash(
        "AutonomousResearchStateBackupAuthoritySignedPayload",
        &Value::Object(unsigned),
    )
}
pub fn state_backup_authority_receipt_hash_v1(receipt: &Value) -> Result<String> {
    hash(
        receipt["kind"]
            .as_str()
            .filter(|v| !v.is_empty())
            .unwrap_or("InvalidAuthorityReceipt"),
        receipt,
    )
}
fn valid_configuration(value: &Value) -> bool {
    let mut expected = vec![
        "version",
        "kind",
        "authorityId",
        "keyId",
        "commandPath",
        "commandSha256",
        "publicKeyPath",
        "publicKeySha256",
        "fixedArguments",
        "timeoutMs",
        "maximumReservationLeaseMs",
        "maximumHeadObservationAgeMs",
    ];
    if number(&value["version"]) == Some(2) {
        expected.extend([
            "onlineMutationAuthorityConfigurationPath",
            "onlineMutationAuthorityConfigurationSha256",
        ]);
    }
    keys(value, &expected)
        && matches!(number(&value["version"]), Some(1 | 2))
        && value["kind"] == "AutonomousResearchStateBackupAuthorityProcessConfiguration"
        && ["authorityId", "keyId"].iter().all(|k| safe_id(&value[k]))
        && ["commandPath", "publicKeyPath"].iter().all(|k| {
            value[k]
                .as_str()
                .is_some_and(|v| Path::new(v).is_absolute())
        })
        && ["commandSha256", "publicKeySha256"]
            .iter()
            .all(|k| sha(&value[k]))
        && value["fixedArguments"]
            .as_array()
            .is_some_and(Vec::is_empty)
        && number(&value["timeoutMs"]).is_some_and(|v| (1000..=120000).contains(&v))
        && ["maximumReservationLeaseMs", "maximumHeadObservationAgeMs"]
            .iter()
            .all(|k| number(&value[k]).is_some_and(|v| v >= 1000))
        && (number(&value["version"]) != Some(2)
            || (value["onlineMutationAuthorityConfigurationPath"]
                .as_str()
                .is_some_and(|v| Path::new(v).is_absolute())
                && sha(&value["onlineMutationAuthorityConfigurationSha256"])))
}
fn load_configuration(path: &Path, pin: &str) -> Result<(Snapshot, Value)> {
    let code = "autonomous_research_state_backup_authority_process_configuration_invalid";
    let file = Snapshot::load(path, pin, 4 * 1024 * 1024, code)?;
    let value = file.json(code)?;
    if !valid_configuration(&value) {
        return Err(error(code));
    }
    Ok((file, value))
}
fn parse_public_key(public_document: &Snapshot, value: &Value) -> Result<VerifyingKey> {
    let document =
        public_document.json("autonomous_research_state_backup_authority_public_key_invalid")?;
    if !keys(
        &document,
        &[
            "version",
            "kind",
            "authorityId",
            "keyId",
            "algorithm",
            "publicKeyPem",
        ],
    ) || number(&document["version"]) != Some(1)
        || document["kind"] != "AutonomousResearchStateBackupAuthorityPublicKey"
        || document["algorithm"] != "ed25519"
        || !safe_id(&document["authorityId"])
        || !safe_id(&document["keyId"])
    {
        return Err(error(
            "autonomous_research_state_backup_authority_public_key_invalid",
        ));
    }
    let pem = document["publicKeyPem"]
        .as_str()
        .filter(|v| v.contains("-----BEGIN PUBLIC KEY-----") && !v.contains("PRIVATE KEY-----"))
        .ok_or_else(|| error("autonomous_research_state_backup_authority_public_key_invalid"))?;
    let key = VerifyingKey::from_public_key_pem(pem)
        .map_err(|_| error("autonomous_research_state_backup_authority_public_key_invalid"))?;
    if document["authorityId"] != value["authorityId"] || document["keyId"] != value["keyId"] {
        return Err(error(
            "autonomous_research_state_backup_authority_public_key_identity_mismatch",
        ));
    }
    Ok(key)
}
impl<T: StateBackupAuthorityTransportV1> PinnedStateBackupAuthorityV1<T> {
    /// Requires a separately supplied raw-byte configuration pin. Version two
    /// also loads the independently pinned online mutation verifier for replay.
    pub fn load(path: &Path, pin: &str, transport: T) -> Result<Self> {
        let (configuration, value) = load_configuration(path, pin)?;
        let code = "autonomous_research_state_backup_authority_process_identity_mismatch";
        let public_document = Snapshot::load(
            Path::new(text(&value, "publicKeyPath")?),
            text(&value, "publicKeySha256")?,
            64 * 1024,
            code,
        )?;
        let command = Snapshot::load(
            Path::new(text(&value, "commandPath")?),
            text(&value, "commandSha256")?,
            256 * 1024 * 1024,
            code,
        )?;
        if !command.executable() {
            return Err(error(code));
        }
        let key = parse_public_key(&public_document, &value)?;
        let online_configuration = if number(&value["version"]) == Some(2) {
            Some(Snapshot::load(
                Path::new(text(&value, "onlineMutationAuthorityConfigurationPath")?),
                text(&value, "onlineMutationAuthorityConfigurationSha256")?,
                4 * 1024 * 1024,
                "autonomous_research_state_backup_online_authority_identity_mismatch",
            )?)
        } else {
            None
        };
        let online = if number(&value["version"]) == Some(2) {
            Some(PinnedMutationAuthorityV1::load(
                Path::new(text(&value, "onlineMutationAuthorityConfigurationPath")?),
                text(&value, "onlineMutationAuthorityConfigurationSha256")?,
                NoOnlineTransport,
            )?)
        } else {
            None
        };
        let trust = json!({"version":1,"kind":"AutonomousResearchStateBackupAuthorityTrust","authorityId":value["authorityId"],"keyId":value["keyId"],"maximumReservationLeaseMs":value["maximumReservationLeaseMs"],"maximumHeadObservationAgeMs":value["maximumHeadObservationAgeMs"]});
        let result = Self {
            configuration,
            public_document,
            profile: ConfigurationProfile::Process {
                command: Box::new(command),
            },
            trust,
            key,
            configuration_hash: hash(
                "AutonomousResearchStateBackupAuthorityProcessConfiguration",
                &value,
            )?,
            online,
            online_configuration,
            transport,
        };
        result.current()?;
        Ok(result)
    }
    pub fn trust(&self) -> &Value {
        &self.trust
    }
    pub fn configuration_hash(&self) -> &str {
        &self.configuration_hash
    }
    pub fn online_mutation_trust(&self) -> Option<&Value> {
        self.online.as_ref().map(|v| v.trust())
    }
    fn current(&self) -> Result<()> {
        let code = match self.profile {
            ConfigurationProfile::Process { .. } => {
                "autonomous_research_state_backup_authority_command_changed"
            }
            ConfigurationProfile::Socket => {
                "autonomous_research_state_backup_authority_socket_inputs_changed"
            }
        };
        self.configuration
            .assert_current()
            .map_err(|_| error(code))?;
        self.public_document
            .assert_current()
            .map_err(|_| error(code))?;
        if let ConfigurationProfile::Process { command } = &self.profile {
            command.assert_current().map_err(|_| error(code))?;
        }
        if let Some(configuration) = &self.online_configuration {
            configuration.assert_current().map_err(|_| error(code))?;
        }
        if matches!(self.profile, ConfigurationProfile::Socket) {
            self.online
                .as_ref()
                .ok_or_else(|| error(code))?
                .current()
                .map_err(|_| error(code))?;
        }
        Ok(())
    }
    /// Rewrap only the untrusted transport while retaining the exact pinned
    /// backup/public-key/online-configuration owner.
    pub(crate) fn assert_transport_current_v1(
        &self,
        check: impl FnOnce(&T) -> Result<()>,
    ) -> Result<()> {
        self.current()?;
        check(&self.transport)?;
        self.current()
    }
    pub(crate) fn map_transport<U: StateBackupAuthorityTransportV1>(
        self,
        map: impl FnOnce(T) -> U,
    ) -> PinnedStateBackupAuthorityV1<U> {
        PinnedStateBackupAuthorityV1 {
            configuration: self.configuration,
            public_document: self.public_document,
            profile: self.profile,
            trust: self.trust,
            key: self.key,
            configuration_hash: self.configuration_hash,
            online: self.online,
            online_configuration: self.online_configuration,
            transport: map(self.transport),
        }
    }
    fn signature(&self, receipt: &Value) -> bool {
        let Some(encoded) = receipt["signature"].as_str() else {
            return false;
        };
        let raw = encoded.trim_end_matches('=');
        if raw.len() != 86
            || encoded.len() - raw.len() > 2
            || !raw
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+/".contains(&b))
        {
            return false;
        }
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let Some(last) = raw
            .as_bytes()
            .last()
            .and_then(|b| ALPHABET.iter().position(|v| v == b))
        else {
            return false;
        };
        let mut bytes = raw.as_bytes().to_vec();
        if let Some(slot) = bytes.last_mut() {
            *slot = ALPHABET[last & 0b110000];
        }
        bytes.extend_from_slice(b"==");
        let Ok(normalized) = std::str::from_utf8(&bytes) else {
            return false;
        };
        let Ok(bytes) = Base64::decode_vec(normalized) else {
            return false;
        };
        let Ok(signature) = Signature::from_slice(&bytes) else {
            return false;
        };
        let Ok(payload) = state_backup_authority_signature_payload_v1(receipt) else {
            return false;
        };
        self.key
            .verify_strict(payload.as_bytes(), &signature)
            .is_ok()
    }
    fn checked(
        &self,
        receipt: &Value,
        valid: bool,
        code: &str,
    ) -> Result<VerifiedBackupAuthorityReceiptV1> {
        self.current()?;
        if !valid {
            return Err(error(code));
        }
        Ok(VerifiedBackupAuthorityReceiptV1 {
            value: receipt.clone(),
            configuration_hash: self.configuration_hash.clone(),
        })
    }
    fn reservation(&self, receipt: &VerifiedBackupAuthorityReceiptV1) -> Result<()> {
        self.current()?;
        if receipt.configuration_hash != self.configuration_hash
            || receipt.value["kind"] != "AutonomousResearchStateBackupAuthorityReservation"
        {
            return Err(error(
                "autonomous_research_state_backup_authority_reservation_invalid",
            ));
        }
        Ok(())
    }
    pub fn verify_reservation(
        &self,
        receipt: &Value,
        request: &Value,
        now: i64,
    ) -> Result<VerifiedBackupAuthorityReceiptV1> {
        socket::assert_request(self, request, socket::Operation::Reserve)?;
        self.checked(
            receipt,
            contracts::reservation(self, receipt, request, now)?,
            "autonomous_research_state_backup_authority_reservation_invalid",
        )
    }
    pub fn verify_finalization(
        &self,
        receipt: &Value,
        request: &Value,
        reservation: &VerifiedBackupAuthorityReceiptV1,
        now: i64,
    ) -> Result<VerifiedBackupAuthorityReceiptV1> {
        self.reservation(reservation)?;
        socket::assert_request(self, request, socket::Operation::Finalize)?;
        self.checked(
            receipt,
            contracts::finalization(self, receipt, request, reservation.value(), now)?,
            "autonomous_research_state_backup_authority_finalization_invalid",
        )
    }
    pub fn verify_current_head(
        &self,
        receipt: &Value,
        request: &Value,
        now: i64,
    ) -> Result<VerifiedBackupAuthorityReceiptV1> {
        socket::assert_request(self, request, socket::Operation::Head)?;
        self.checked(
            receipt,
            contracts::current_head(self, receipt, request, now)?,
            "autonomous_research_state_backup_authority_current_head_invalid",
        )
    }
    /// Authenticates the signed range envelope only. It does not claim entries
    /// are causally contiguous; verify_finalized_journal_chain performs that gate.
    pub fn verify_journal_range(
        &self,
        receipt: &Value,
        request: &Value,
        now: i64,
    ) -> Result<VerifiedBackupAuthorityReceiptV1> {
        socket::assert_request(self, request, socket::Operation::Journal)?;
        self.checked(
            receipt,
            contracts::journal_range(self, receipt, request, now)?,
            "autonomous_research_state_backup_authority_journal_range_invalid",
        )
    }
    pub fn reserve_snapshot(
        &mut self,
        request: &Value,
        now: i64,
    ) -> Result<VerifiedBackupAuthorityReceiptV1> {
        let preflight = self
            .current()
            .and_then(|()| socket::assert_request(self, request, socket::Operation::Reserve));
        socket::rpc_result(self, preflight, false)?;
        let receipt = self.transport.invoke(request)?;
        socket::rpc_result(self, self.verify_reservation(&receipt, request, now), true)
    }
    pub fn finalize_snapshot(
        &mut self,
        request: &Value,
        reservation: &VerifiedBackupAuthorityReceiptV1,
        now: i64,
    ) -> Result<VerifiedBackupAuthorityReceiptV1> {
        let preflight = self
            .reservation(reservation)
            .and_then(|()| socket::assert_request(self, request, socket::Operation::Finalize));
        socket::rpc_result(self, preflight, false)?;
        let receipt = self.transport.invoke(request)?;
        socket::rpc_result(
            self,
            self.verify_finalization(&receipt, request, reservation, now),
            true,
        )
    }
    pub fn observe_current_head(
        &mut self,
        request: &Value,
        now: i64,
    ) -> Result<VerifiedBackupAuthorityReceiptV1> {
        let preflight = self
            .current()
            .and_then(|()| socket::assert_request(self, request, socket::Operation::Head));
        socket::rpc_result(self, preflight, false)?;
        let receipt = self.transport.invoke(request)?;
        socket::rpc_result(self, self.verify_current_head(&receipt, request, now), true)
    }
    pub fn read_finalized_mutation_journal(
        &mut self,
        request: &Value,
        now: i64,
    ) -> Result<VerifiedBackupAuthorityReceiptV1> {
        let preflight = self
            .current()
            .and_then(|()| socket::assert_request(self, request, socket::Operation::Journal));
        socket::rpc_result(self, preflight, false)?;
        let receipt = self.transport.invoke(request)?;
        socket::rpc_result(
            self,
            self.verify_journal_range(&receipt, request, now),
            true,
        )
    }
}
impl PinnedStateBackupAuthorityV1<ProcessStateBackupAuthorityTransportV1> {
    /// Check every pinned verifier/process input without an authority RPC.
    pub(crate) fn assert_process_current_v1(&self) -> Result<()> {
        self.current()?;
        self.transport.current()
    }
    pub fn load_process(path: &Path, pin: &str) -> Result<Self> {
        Self::load(
            path,
            pin,
            ProcessStateBackupAuthorityTransportV1::load(path, pin)?,
        )
    }
}

/// Verified signatures and causal journal continuity. This remains evidence,
/// not a statement that any SQLite snapshot was restored or is recoverable.
pub struct VerifiedFinalizedJournalEvidenceV1 {
    range: Value,
    chain: crate::sqlite_mutation_coordinator::finalized_history::VerifiedFinalizedMutationChainV1,
}
impl VerifiedFinalizedJournalEvidenceV1 {
    pub(crate) fn chain(
        &self,
    ) -> &crate::sqlite_mutation_coordinator::finalized_history::VerifiedFinalizedMutationChainV1
    {
        &self.chain
    }
    pub fn value(&self) -> &Value {
        &self.range
    }
}
impl<T: StateBackupAuthorityTransportV1> PinnedStateBackupAuthorityV1<T> {
    pub fn verify_finalized_journal_chain(
        &self,
        range: &VerifiedBackupAuthorityReceiptV1,
    ) -> Result<VerifiedFinalizedJournalEvidenceV1> {
        self.current()?;
        let invalid = || error("autonomous_research_state_backup_restore_journal_entry_invalid");
        if range.configuration_hash != self.configuration_hash
            || range.value["kind"] != "AutonomousResearchStateBackupAuthorityJournalRange"
        {
            return Err(invalid());
        }
        let online = self.online.as_ref().ok_or_else(|| {
            error("autonomous_research_state_restore_online_authority_trust_required")
        })?;
        let receipt = range.value();
        if ["scopeId", "databaseScopeHash", "writerManifestHash"]
            .iter()
            .any(|k| receipt[k] != online.trust()[k])
            || receipt["onlineAuthorityId"] != online.trust()["authorityId"]
            || receipt["onlineKeyId"] != online.trust()["keyId"]
        {
            return Err(error(
                "autonomous_research_state_backup_restore_journal_binding_invalid",
            ));
        }
        let chain = crate::sqlite_mutation_coordinator::finalized_history::verify_backup_chain_v1(
            range, online,
        )?;
        self.current()?;
        Ok(VerifiedFinalizedJournalEvidenceV1 {
            range: receipt.clone(),
            chain,
        })
    }
}
