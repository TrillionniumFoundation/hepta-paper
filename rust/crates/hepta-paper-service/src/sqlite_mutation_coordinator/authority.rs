//! Independently pinned public authority verification. Raw transport responses
//! acquire no authority until exact contract and Ed25519 validation succeed.
mod activation;
pub(crate) mod files;
mod process;
mod schema_transition;
use super::{contracts::*, *};
use base64ct::{Base64, Encoding};
use ed25519_dalek::{Signature, VerifyingKey, pkcs8::DecodePublicKey};
use files::Snapshot;
pub use process::ProcessMutationAuthorityTransportV1;
use std::path::Path;

/// Transport is untrusted: implementations can only provide raw JSON, never an
/// opaque verified receipt. This trait does not claim external linearizability.
pub trait MutationAuthorityTransportV1 {
    fn invoke(&mut self, request: &Value) -> Result<Value>;
}
/// No Deserialize, public constructor or mutable access. The verifier identity
/// prevents a receipt verified against one trust configuration being reused by
/// a different authority client during finalization or recovery.
#[derive(Clone)]
pub struct VerifiedMutationReceiptV1 {
    value: Value,
    verifier_identity: String,
}
impl VerifiedMutationReceiptV1 {
    pub fn value(&self) -> &Value {
        &self.value
    }
}
pub struct PinnedMutationAuthorityV1<T> {
    trust: Value,
    configuration_hash: String,
    configuration: Snapshot,
    public_key_document: Snapshot,
    public_key: VerifyingKey,
    transport: T,
}
const CONFIGURATION_KEYS: &[&str] = &[
    "version",
    "kind",
    "authorityId",
    "keyId",
    "scopeId",
    "databaseScopeHash",
    "writerManifestHash",
    "publicKeyPath",
    "publicKeySha256",
    "maximumReservationLeaseMs",
    "maximumObservationAgeMs",
];
fn configuration_valid(value: &Value) -> bool {
    keys(value, CONFIGURATION_KEYS)
        && value["version"] == 1
        && value["kind"] == "AutonomousResearchOnlineMutationAuthorityConfiguration"
        && ["authorityId", "keyId", "scopeId"]
            .iter()
            .all(|key| safe(&value[key]))
        && ["databaseScopeHash", "writerManifestHash", "publicKeySha256"]
            .iter()
            .all(|key| sha(&value[key]))
        && value["publicKeyPath"]
            .as_str()
            .is_some_and(|p| Path::new(p).is_absolute())
        && ["maximumReservationLeaseMs", "maximumObservationAgeMs"]
            .iter()
            .all(|key| {
                value[key]
                    .as_i64()
                    .is_some_and(|v| (1000..=900000).contains(&v))
            })
}
impl<T: MutationAuthorityTransportV1> PinnedMutationAuthorityV1<T> {
    /// Both the configuration bytes and its referenced public-key bytes are
    /// pinned. No caller-supplied JSON can directly construct the trust object.
    pub fn load(
        configuration_path: &Path,
        expected_configuration_file_hash: &str,
        transport: T,
    ) -> Result<Self> {
        let configuration = Snapshot::load(
            configuration_path,
            expected_configuration_file_hash,
            4 * 1024 * 1024,
            "autonomous_research_online_mutation_authority_configuration_invalid",
        )?;
        let value = configuration
            .json("autonomous_research_online_mutation_authority_configuration_invalid")?;
        if !configuration_valid(&value) {
            return Err(error(
                "autonomous_research_online_mutation_authority_configuration_invalid",
            ));
        }
        let public_key_document = Snapshot::load(
            Path::new(text(&value, "publicKeyPath")?),
            text(&value, "publicKeySha256")?,
            64 * 1024,
            "autonomous_research_online_mutation_authority_public_key_identity_mismatch",
        )?;
        let document = public_key_document
            .json("autonomous_research_online_mutation_authority_public_key_invalid")?;
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
        ) || document["version"] != 1
            || document["kind"] != "AutonomousResearchOnlineMutationAuthorityPublicKey"
            || !safe(&document["authorityId"])
            || !safe(&document["keyId"])
            || document["algorithm"] != "ed25519"
        {
            return Err(error(
                "autonomous_research_online_mutation_authority_public_key_invalid",
            ));
        }
        let pem = document["publicKeyPem"]
            .as_str()
            .filter(|v| {
                v.contains("-----BEGIN PUBLIC KEY-----")
                    && !v.contains("-----BEGIN PRIVATE KEY-----")
                    && !v.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----")
            })
            .ok_or_else(|| {
                error("autonomous_research_online_mutation_authority_public_key_invalid")
            })?;
        let public_key = VerifyingKey::from_public_key_pem(pem).map_err(|_| {
            error("autonomous_research_online_mutation_authority_public_key_invalid")
        })?;
        if document["authorityId"] != value["authorityId"] || document["keyId"] != value["keyId"] {
            return Err(error(
                "autonomous_research_online_mutation_authority_public_key_identity_mismatch",
            ));
        }
        let trust = json!({"version":1,"kind":"AutonomousResearchOnlineMutationAuthorityTrust","authorityId":value["authorityId"],"keyId":value["keyId"],"scopeId":value["scopeId"],"databaseScopeHash":value["databaseScopeHash"],"writerManifestHash":value["writerManifestHash"],"maximumReservationLeaseMs":value["maximumReservationLeaseMs"],"maximumObservationAgeMs":value["maximumObservationAgeMs"]});
        assert_authority_trust_v1(&trust)?;
        configuration.assert_current()?;
        public_key_document.assert_current()?;
        Ok(Self {
            trust,
            configuration_hash: hash(
                "AutonomousResearchOnlineMutationAuthorityConfiguration",
                &value,
            )?,
            configuration,
            public_key_document,
            public_key,
            transport,
        })
    }
    pub fn trust(&self) -> &Value {
        &self.trust
    }
    pub fn configuration_hash(&self) -> &str {
        &self.configuration_hash
    }
    pub(crate) fn current(&self) -> Result<()> {
        self.configuration.assert_current()?;
        self.public_key_document.assert_current()
    }
    fn signature(&self, receipt: &Value) -> bool {
        let Some(encoded) = receipt["signature"].as_str() else {
            return false;
        };
        // Node permits missing padding, but forbids whitespace, URL-safe alphabet,
        // junk and more than two trailing '=' via its pre-decoding signature regex.
        let raw = encoded.trim_end_matches('=');
        let padding = encoded.len() - raw.len();
        if raw.is_empty()
            || padding > 2
            || !raw
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
        {
            return false;
        }
        // Buffer.from(..., 'base64') ignores unused low bits of the final
        // sextet. A 64-byte Ed25519 signature always has 86 data characters.
        if raw.len() != 86 {
            return false;
        }
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let Some(last) = raw
            .as_bytes()
            .last()
            .and_then(|last| ALPHABET.iter().position(|v| v == last))
        else {
            return false;
        };
        let mut normalized = raw.as_bytes().to_vec();
        if let Some(slot) = normalized.last_mut() {
            *slot = ALPHABET[last & 0b110000];
        }
        normalized.extend_from_slice(b"==");
        let Ok(normalized) = std::str::from_utf8(&normalized) else {
            return false;
        };
        let Ok(bytes) = Base64::decode_vec(normalized) else {
            return false;
        };
        let Ok(signature) = Signature::from_slice(&bytes) else {
            return false;
        };
        let Ok(payload) = online_mutation_signed_payload_v1(receipt) else {
            return false;
        };
        self.public_key
            .verify_strict(payload.as_bytes(), &signature)
            .is_ok()
    }
    fn checked(
        &self,
        receipt: Value,
        valid: bool,
        code: &str,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.current()?;
        if !valid {
            return Err(error(code));
        }
        Ok(VerifiedMutationReceiptV1 {
            value: receipt,
            verifier_identity: self.configuration_hash.clone(),
        })
    }
    fn same_authority(&self, receipt: &VerifiedMutationReceiptV1) -> Result<()> {
        self.current()?;
        if receipt.verifier_identity != self.configuration_hash
            || receipt.value["kind"] != "AutonomousResearchOnlineMutationReservationReceipt"
        {
            return Err(error(
                "autonomous_research_online_mutation_reservation_receipt_invalid",
            ));
        }
        Ok(())
    }
    pub fn observe_current_head(
        &mut self,
        request: &Value,
        expected_instances: Option<&Value>,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.current()?;
        // Validate the nonce/scope request before invoking an external transport.
        verify_current_head_v1(
            &Value::Null,
            request,
            &self.trust,
            now,
            expected_instances,
            &|_| false,
        )?;
        let receipt = self.transport.invoke(request)?;
        let valid = verify_current_head_v1(
            &receipt,
            request,
            &self.trust,
            now,
            expected_instances,
            &|value| self.signature(value),
        )?;
        self.checked(
            receipt,
            valid,
            "autonomous_research_online_mutation_current_head_receipt_invalid",
        )
    }
    pub fn reserve_mutation(
        &mut self,
        request: &Value,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.current()?;
        assert_reserve_request_v1(request, &self.trust)?;
        let receipt = self.transport.invoke(request)?;
        let valid = verify_reservation_v1(&receipt, request, &self.trust, now, &|value| {
            self.signature(value)
        })?;
        self.checked(
            receipt,
            valid,
            "autonomous_research_online_mutation_reservation_receipt_invalid",
        )
    }
    pub fn verify_stored_reservation(
        &self,
        receipt: &Value,
        request: &Value,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.current()?;
        let now = timestamp(&receipt["issuedAt"]).ok_or_else(|| {
            error("autonomous_research_online_mutation_reservation_receipt_invalid")
        })?;
        let valid = verify_reservation_v1(receipt, request, &self.trust, now, &|value| {
            self.signature(value)
        })?;
        self.checked(
            receipt.clone(),
            valid,
            "autonomous_research_online_mutation_reservation_receipt_invalid",
        )
    }
    pub fn verify_stored_finalization(
        &self,
        receipt: &Value,
        request: &Value,
        reservation: &VerifiedMutationReceiptV1,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.same_authority(reservation)?;
        let now = timestamp(&receipt["finalizedAt"]).ok_or_else(|| {
            error("autonomous_research_online_mutation_finalization_receipt_invalid")
        })?;
        let valid = verify_finalization_v1(
            receipt,
            request,
            reservation.value(),
            &self.trust,
            now,
            &|value| self.signature(value),
        )?;
        self.checked(
            receipt.clone(),
            valid,
            "autonomous_research_online_mutation_finalization_receipt_invalid",
        )
    }
    pub fn finalize_mutation(
        &mut self,
        request: &Value,
        reservation: &VerifiedMutationReceiptV1,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.same_authority(reservation)?;
        assert_finalize_request_v1(request, reservation.value())?;
        let receipt = self.transport.invoke(request)?;
        let valid = verify_finalization_v1(
            &receipt,
            request,
            reservation.value(),
            &self.trust,
            now,
            &|value| self.signature(value),
        )?;
        self.checked(
            receipt,
            valid,
            "autonomous_research_online_mutation_finalization_receipt_invalid",
        )
    }
    pub fn abort_mutation(
        &mut self,
        request: &Value,
        reservation: &VerifiedMutationReceiptV1,
        now: i64,
    ) -> Result<VerifiedMutationReceiptV1> {
        self.same_authority(reservation)?;
        assert_abort_request_v1(request, reservation.value())?;
        let receipt = self.transport.invoke(request)?;
        let valid = verify_abort_v1(
            &receipt,
            request,
            reservation.value(),
            &self.trust,
            now,
            &|value| self.signature(value),
        )?;
        self.checked(
            receipt,
            valid,
            "autonomous_research_online_mutation_abort_receipt_invalid",
        )
    }
    pub fn resolve_mutation_attempt(
        &mut self,
        request: &Value,
        reserve_request: &Value,
        now: i64,
    ) -> Result<Option<VerifiedMutationReceiptV1>> {
        self.current()?;
        assert_reserve_request_v1(reserve_request, &self.trust)?;
        assert_resolution_request_v1(request, reserve_request)?;
        let receipt = self.transport.invoke(request)?;
        let valid = verify_resolution_v1(
            &receipt,
            request,
            reserve_request,
            &self.trust,
            now,
            &|value| self.signature(value),
        )?;
        let verified = self.checked(
            receipt,
            valid,
            "autonomous_research_online_mutation_resolution_receipt_invalid",
        )?;
        if verified.value()["resolution"] == "not-found" {
            return Ok(None);
        }
        // verify_resolution checked both the outer receipt and nested reservation.
        Ok(Some(VerifiedMutationReceiptV1 {
            value: verified.value()["reservation"].clone(),
            verifier_identity: self.configuration_hash.clone(),
        }))
    }
}
impl PinnedMutationAuthorityV1<ProcessMutationAuthorityTransportV1> {
    pub fn load_process(
        path: &Path,
        expected_process_configuration_file_hash: &str,
    ) -> Result<Self> {
        let transport = ProcessMutationAuthorityTransportV1::load(
            path,
            expected_process_configuration_file_hash,
        )?;
        let configuration_path = transport.authority_configuration_path.clone();
        let configuration_hash = transport.authority_configuration_pin.clone();
        Self::load(&configuration_path, &configuration_hash, transport)
    }
    pub fn operation_timeout_ms(&self) -> u64 {
        self.transport.timeout_ms
    }
    pub fn process_configuration_hash(&self) -> &str {
        &self.transport.configuration_hash
    }
}
