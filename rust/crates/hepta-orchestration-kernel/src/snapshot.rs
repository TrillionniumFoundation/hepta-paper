use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use thiserror::Error;

const MAX_COMPONENTS: usize = 256;
const MAX_TOTAL_PAYLOAD_BYTES: u64 = 64 * 1024 * 1024 * 1024;

/// One immutable component observation collected under a shared read barrier.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningComponentObservationV1 {
    pub component_id: String,
    pub source_revision: u64,
    pub barrier_id: String,
    pub observed_at_unix_ms: u64,
    pub payload_hash: String,
    pub payload_bytes: u64,
}

/// Closed request for one transaction-consistent planning snapshot.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningSnapshotRequestV1 {
    pub version: u16,
    pub campaign_id: String,
    pub expected_revision: u64,
    pub barrier_id: String,
    pub observed_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub components: Vec<PlanningComponentObservationV1>,
}

/// Canonical snapshot consumed by the Rust scheduler and candidate router.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanningSnapshotV1 {
    pub version: u16,
    pub campaign_id: String,
    pub source_revision: u64,
    pub barrier_id: String,
    pub observed_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub total_payload_bytes: u64,
    pub components: BTreeMap<String, PlanningComponentObservationV1>,
    pub snapshot_hash: String,
}

/// Build a deterministic snapshot only when every component was observed under
/// the same barrier and exact source revision.
pub fn build_planning_snapshot_v1(
    mut request: PlanningSnapshotRequestV1,
) -> Result<PlanningSnapshotV1, PlanningSnapshotError> {
    validate_request(&request)?;
    let mut components = BTreeMap::new();
    let mut total_payload_bytes = 0_u64;
    for component in std::mem::take(&mut request.components) {
        validate_component(&component, &request)?;
        total_payload_bytes = total_payload_bytes
            .checked_add(component.payload_bytes)
            .ok_or(PlanningSnapshotError::PayloadLimit)?;
        if total_payload_bytes > MAX_TOTAL_PAYLOAD_BYTES {
            return Err(PlanningSnapshotError::PayloadLimit);
        }
        let component_id = component.component_id.clone();
        if components.insert(component_id.clone(), component).is_some() {
            return Err(PlanningSnapshotError::DuplicateComponent(component_id));
        }
    }
    let body = PlanningSnapshotBodyV1 {
        version: 1,
        campaign_id: &request.campaign_id,
        source_revision: request.expected_revision,
        barrier_id: &request.barrier_id,
        observed_at_unix_ms: request.observed_at_unix_ms,
        expires_at_unix_ms: request.expires_at_unix_ms,
        total_payload_bytes,
        components: &components,
    };
    let snapshot_hash = canonical_hash("HeptaPlanningSnapshotV1", &body)?;
    Ok(PlanningSnapshotV1 {
        version: 1,
        campaign_id: request.campaign_id,
        source_revision: request.expected_revision,
        barrier_id: request.barrier_id,
        observed_at_unix_ms: request.observed_at_unix_ms,
        expires_at_unix_ms: request.expires_at_unix_ms,
        total_payload_bytes,
        components,
        snapshot_hash,
    })
}

fn validate_request(request: &PlanningSnapshotRequestV1) -> Result<(), PlanningSnapshotError> {
    if request.version != 1
        || !valid_identifier(&request.campaign_id, 256)
        || !valid_identifier(&request.barrier_id, 256)
        || request.expected_revision == 0
        || request.observed_at_unix_ms == 0
        || request.expires_at_unix_ms <= request.observed_at_unix_ms
        || request.components.is_empty()
        || request.components.len() > MAX_COMPONENTS
    {
        return Err(PlanningSnapshotError::Contract);
    }
    Ok(())
}

fn validate_component(
    component: &PlanningComponentObservationV1,
    request: &PlanningSnapshotRequestV1,
) -> Result<(), PlanningSnapshotError> {
    if !valid_identifier(&component.component_id, 256)
        || !valid_digest(&component.payload_hash)
        || component.payload_bytes == 0
        || component.source_revision != request.expected_revision
        || component.barrier_id != request.barrier_id
        || component.observed_at_unix_ms == 0
        || component.observed_at_unix_ms > request.observed_at_unix_ms
    {
        return Err(PlanningSnapshotError::InconsistentComponent(
            component.component_id.clone(),
        ));
    }
    Ok(())
}

fn valid_identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn canonical_hash<T: Serialize>(domain: &str, value: &T) -> Result<String, PlanningSnapshotError> {
    let bytes = serde_json::to_vec(value).map_err(|_| PlanningSnapshotError::Encoding)?;
    let mut hasher = Sha256::new();
    update_hash(&mut hasher, domain.as_bytes());
    update_hash(&mut hasher, &bytes);
    Ok(format!("sha256:{}", hex::encode(hasher.finalize())))
}

fn update_hash(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanningSnapshotBodyV1<'a> {
    version: u16,
    campaign_id: &'a str,
    source_revision: u64,
    barrier_id: &'a str,
    observed_at_unix_ms: u64,
    expires_at_unix_ms: u64,
    total_payload_bytes: u64,
    components: &'a BTreeMap<String, PlanningComponentObservationV1>,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum PlanningSnapshotError {
    #[error("planning snapshot request is invalid")]
    Contract,
    #[error("planning component is inconsistent: {0}")]
    InconsistentComponent(String),
    #[error("planning component is duplicated: {0}")]
    DuplicateComponent(String),
    #[error("planning snapshot payload limit exceeded")]
    PayloadLimit,
    #[error("planning snapshot encoding failed")]
    Encoding,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(byte: char) -> String {
        format!("sha256:{}", byte.to_string().repeat(64))
    }

    fn request(order: &[&str]) -> PlanningSnapshotRequestV1 {
        PlanningSnapshotRequestV1 {
            version: 1,
            campaign_id: "campaign:test".to_owned(),
            expected_revision: 9,
            barrier_id: "barrier:9".to_owned(),
            observed_at_unix_ms: 1_000,
            expires_at_unix_ms: 2_000,
            components: order
                .iter()
                .enumerate()
                .map(|(index, name)| PlanningComponentObservationV1 {
                    component_id: (*name).to_owned(),
                    source_revision: 9,
                    barrier_id: "barrier:9".to_owned(),
                    observed_at_unix_ms: 900,
                    payload_hash: digest(if index == 0 { 'a' } else { 'b' }),
                    payload_bytes: 10,
                })
                .collect(),
        }
    }

    #[test]
    fn snapshot_hash_is_independent_of_collection_order() {
        let left = build_planning_snapshot_v1(request(&["alpha", "beta"]));
        let right = build_planning_snapshot_v1(request(&["beta", "alpha"]));
        match (left, right) {
            (Ok(left), Ok(right)) => assert_eq!(left.snapshot_hash, right.snapshot_hash),
            other => assert!(false, "unexpected result: {other:?}"),
        }
    }

    #[test]
    fn mixed_revision_fails_closed() {
        let mut value = request(&["alpha"]);
        value.components[0].source_revision = 8;
        assert!(matches!(
            build_planning_snapshot_v1(value),
            Err(PlanningSnapshotError::InconsistentComponent(_))
        ));
    }

    #[test]
    fn duplicate_component_fails_closed() {
        assert!(matches!(
            build_planning_snapshot_v1(request(&["alpha", "alpha"])),
            Err(PlanningSnapshotError::DuplicateComponent(_))
        ));
    }
}
