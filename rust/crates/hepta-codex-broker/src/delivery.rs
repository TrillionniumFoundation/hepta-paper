//! Bounded transport of already-prepared bytes. This never dispatches a provider,
//! acknowledges a result, or grants campaign-write/scientific authority.
use crate::codex_dispatch::hash_bytes;
use crate::{BrokerJournalStoreV1, BrokerPreparedResultReceiptV1, CodexDispatchError};
use hepta_codex_journal::OperationState;
use hepta_codex_protocol::{CodexExecutionRequestV1, Sha256Digest};
use std::{
    io::{Read, Write},
    path::Path,
};

const DELIVERY_MAGIC: &[u8; 8] = b"HEPTAPX1";
const MAXIMUM_RECEIPT_BYTES: u64 = 64 * 1024 * 1024;
const MAXIMUM_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;

/// Content-checked provider output, not an execution or campaign-write grant.
/// Its provenance must still be authenticated by the connected consumer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BrokerPreparedDeliveryV1 {
    receipt: BrokerPreparedResultReceiptV1,
    output: Vec<u8>,
}
impl BrokerPreparedDeliveryV1 {
    #[must_use]
    pub fn receipt(&self) -> &BrokerPreparedResultReceiptV1 {
        &self.receipt
    }
    #[must_use]
    pub fn output(&self) -> &[u8] {
        &self.output
    }
}

/// Reads only a journal-committed prepared result, preserving the original
/// receipt and bytes. A sidecar alone cannot create a prepared operation.
pub fn load_codex_prepared_delivery(
    store: &BrokerJournalStoreV1,
    state_directory: &Path,
    operation_id: &str,
    owner_uid: u32,
) -> Result<BrokerPreparedDeliveryV1, CodexDispatchError> {
    let _lock = crate::dispatch_backup::acquire_dispatch_lock(state_directory, owner_uid, false)?;
    crate::dispatch_containment::validate_private_state(state_directory, owner_uid)?;
    let request = crate::load_persisted_request(store, operation_id)?;
    let journal = store.load_journal(operation_id)?;
    if !matches!(
        journal.current_state,
        OperationState::ResultPrepared | OperationState::Acknowledged
    ) {
        return Err(CodexDispatchError::InvalidBinding("result_not_prepared"));
    }
    let expected = journal
        .transitions
        .iter()
        .find(|row| row.to == OperationState::ResultPrepared)
        .and_then(|row| row.evidence_hash.as_ref())
        .ok_or(CodexDispatchError::InvalidBinding(
            "prepared_journal_evidence",
        ))?;
    let receipt =
        crate::prepared_result::read_prepared_receipt(state_directory, operation_id, owner_uid)?;
    let output = crate::read_codex_prepared_output(state_directory, &receipt, owner_uid)?;
    let delivery = BrokerPreparedDeliveryV1 { receipt, output };
    validate_delivery(&delivery, &request, expected)?;
    if journal.request_hash != delivery.receipt.request_hash {
        return Err(CodexDispatchError::InvalidBinding(
            "delivery_journal_request",
        ));
    }
    Ok(delivery)
}

fn validate_delivery(
    delivery: &BrokerPreparedDeliveryV1,
    request: &CodexExecutionRequestV1,
    expected_receipt_hash: &Sha256Digest,
) -> Result<(), CodexDispatchError> {
    request
        .validate()
        .map_err(|_| CodexDispatchError::InvalidBinding("delivery_request"))?;
    let receipt = &delivery.receipt;
    receipt.verify_hash()?;
    if receipt.prepared_receipt_hash != *expected_receipt_hash
        || receipt.request_hash != hash_bytes(&serde_json::to_vec(request)?)?
        || receipt.operation_id != request.operation_id
        || receipt.campaign_id != request.campaign_id
        || receipt.node_id != request.node_id
        || receipt.attempt_id != request.attempt_id
        || receipt.campaign_revision != request.campaign_revision
        || receipt.lease_generation != request.lease_generation
        || receipt.role != request.role
        || receipt.runtime_identity_hash != request.codex_runtime_identity_hash
        || receipt.output_schema_hash != request.output_schema_hash
        || receipt.workspace_identity_hash != request.workspace_identity_hash
        || receipt.mutation_policy_hash != request.mutation_policy_hash
        || delivery.output.is_empty()
        || delivery.output.len() as u64 > request.maximum_output_bytes.min(MAXIMUM_OUTPUT_BYTES)
        || receipt.output_hash != hash_bytes(&delivery.output)?
    {
        return Err(CodexDispatchError::InvalidBinding(
            "delivery_subject_or_bytes",
        ));
    }
    Ok(())
}

/// Writes one receipt and raw-output frame after a normal prepared/acknowledged
/// response. Callers own peer authentication and one cumulative I/O deadline.
pub fn write_prepared_delivery_frame<W: Write>(
    writer: &mut W,
    delivery: &BrokerPreparedDeliveryV1,
) -> Result<(), CodexDispatchError> {
    delivery.receipt.verify_hash()?;
    let receipt = serde_json::to_vec(&delivery.receipt)?;
    let receipt_len = receipt.len() as u64;
    let output_len = delivery.output.len() as u64;
    if receipt_len == 0
        || receipt_len > MAXIMUM_RECEIPT_BYTES
        || output_len == 0
        || output_len > MAXIMUM_OUTPUT_BYTES
        || hash_bytes(&delivery.output)? != delivery.receipt.output_hash
    {
        return Err(CodexDispatchError::InvalidBinding(
            "delivery_size_or_output",
        ));
    }
    writer.write_all(DELIVERY_MAGIC)?;
    writer.write_all(&receipt_len.to_be_bytes())?;
    writer.write_all(&output_len.to_be_bytes())?;
    // Bounded chunks permit the owning writer to revalidate a cumulative deadline.
    for chunk in receipt.chunks(64 * 1024) {
        writer.write_all(chunk)?;
    }
    for chunk in delivery.output.chunks(64 * 1024) {
        writer.write_all(chunk)?;
    }
    writer.flush()?;
    Ok(())
}

/// Verifies framing, canonical receipt bytes, exact original request and expected
/// prepared identity before returning output. No partial result is returned.
pub fn read_prepared_delivery_frame<R: Read>(
    reader: &mut R,
    request: &CodexExecutionRequestV1,
    expected_receipt_hash: &Sha256Digest,
) -> Result<BrokerPreparedDeliveryV1, CodexDispatchError> {
    request
        .validate()
        .map_err(|_| CodexDispatchError::InvalidBinding("delivery_request"))?;
    let mut header = [0_u8; 24];
    reader.read_exact(&mut header)?;
    if &header[..8] != DELIVERY_MAGIC {
        return Err(CodexDispatchError::InvalidBinding("delivery_magic"));
    }
    let mut receipt_length = [0_u8; 8];
    receipt_length.copy_from_slice(&header[8..16]);
    let mut output_length = [0_u8; 8];
    output_length.copy_from_slice(&header[16..24]);
    let receipt_length = u64::from_be_bytes(receipt_length);
    let output_length = u64::from_be_bytes(output_length);
    if receipt_length == 0
        || receipt_length > MAXIMUM_RECEIPT_BYTES
        || output_length == 0
        || output_length > request.maximum_output_bytes.min(MAXIMUM_OUTPUT_BYTES)
    {
        return Err(CodexDispatchError::InvalidBinding("delivery_size"));
    }
    let receipt_size = usize::try_from(receipt_length)
        .map_err(|_| CodexDispatchError::InvalidBinding("delivery_size"))?;
    let output_size = usize::try_from(output_length)
        .map_err(|_| CodexDispatchError::InvalidBinding("delivery_size"))?;
    let mut encoded = vec![0_u8; receipt_size];
    reader.read_exact(&mut encoded)?;
    let receipt: BrokerPreparedResultReceiptV1 = serde_json::from_slice(&encoded)?;
    if serde_json::to_vec(&receipt)? != encoded {
        return Err(CodexDispatchError::InvalidBinding(
            "delivery_noncanonical_receipt",
        ));
    }
    // Reject receipt substitution before accepting the potentially large output.
    receipt.verify_hash()?;
    if receipt.prepared_receipt_hash != *expected_receipt_hash
        || receipt.request_hash != hash_bytes(&serde_json::to_vec(request)?)?
    {
        return Err(CodexDispatchError::InvalidBinding(
            "delivery_receipt_binding",
        ));
    }
    let mut output = vec![0_u8; output_size];
    reader.read_exact(&mut output)?;
    let delivery = BrokerPreparedDeliveryV1 { receipt, output };
    validate_delivery(&delivery, request, expected_receipt_hash)?;
    Ok(delivery)
}
