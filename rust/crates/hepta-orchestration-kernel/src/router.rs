use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use thiserror::Error;

const MAX_CANDIDATES: usize = 4_096;
const MAX_DISQUALIFIERS: usize = 32;
const MAX_WEIGHT: u64 = 1_000_000_000;

/// One bounded action candidate expressed only in deterministic integer units.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateV1 {
    pub candidate_id: String,
    pub capability_id: String,
    pub expected_utility_microunits: i64,
    pub evidence_score_ppm: u32,
    pub risk_microunits: u64,
    pub cost_microusd: u64,
    pub latency_ms: u64,
    pub feasible: bool,
    pub disqualifiers: Vec<String>,
}

/// Deterministic constraint and scoring policy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateRouterPolicyV1 {
    pub version: u16,
    pub policy_id: String,
    pub minimum_evidence_ppm: u32,
    pub maximum_risk_microunits: u64,
    pub maximum_cost_microusd: u64,
    pub maximum_latency_ms: u64,
    pub utility_weight: u64,
    pub evidence_weight: u64,
    pub risk_weight: u64,
    pub cost_weight: u64,
    pub latency_weight: u64,
}

/// Complete routing receipt with the Pareto frontier and deterministic winner.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandidateRouteReceiptV1 {
    pub version: u16,
    pub policy_id: String,
    pub policy_hash: String,
    pub eligible_candidate_ids: Vec<String>,
    pub pareto_frontier_ids: Vec<String>,
    pub selected_candidate_id: String,
    pub selected_score: i128,
    pub route_hash: String,
}

/// Filter, Pareto-reduce and score candidates without floating-point behavior or
/// collection-order dependence.
pub fn route_candidate_v1(
    policy: CandidateRouterPolicyV1,
    mut candidates: Vec<CandidateV1>,
) -> Result<CandidateRouteReceiptV1, CandidateRouterError> {
    validate_policy(&policy)?;
    if candidates.is_empty() || candidates.len() > MAX_CANDIDATES {
        return Err(CandidateRouterError::Contract);
    }
    candidates.sort_by(|left, right| left.candidate_id.cmp(&right.candidate_id));
    if candidates
        .windows(2)
        .any(|window| window[0].candidate_id == window[1].candidate_id)
    {
        return Err(CandidateRouterError::DuplicateCandidate);
    }
    for candidate in &candidates {
        validate_candidate(candidate)?;
    }
    let eligible = candidates
        .iter()
        .filter(|candidate| eligible(candidate, &policy))
        .collect::<Vec<_>>();
    if eligible.is_empty() {
        return Err(CandidateRouterError::NoEligibleCandidate);
    }
    let frontier = eligible
        .iter()
        .copied()
        .filter(|candidate| {
            !eligible.iter().any(|other| {
                other.candidate_id != candidate.candidate_id && dominates(other, candidate)
            })
        })
        .collect::<Vec<_>>();
    if frontier.is_empty() {
        return Err(CandidateRouterError::NoEligibleCandidate);
    }

    let mut selected = frontier[0];
    let mut selected_score = score(selected, &policy)?;
    for candidate in frontier.iter().skip(1) {
        let candidate_score = score(candidate, &policy)?;
        if candidate_score > selected_score
            || (candidate_score == selected_score && candidate.candidate_id < selected.candidate_id)
        {
            selected = candidate;
            selected_score = candidate_score;
        }
    }

    let policy_hash = canonical_hash("HeptaCandidateRouterPolicyV1", &policy)?;
    let eligible_candidate_ids = eligible
        .iter()
        .map(|candidate| candidate.candidate_id.clone())
        .collect::<Vec<_>>();
    let pareto_frontier_ids = frontier
        .iter()
        .map(|candidate| candidate.candidate_id.clone())
        .collect::<Vec<_>>();
    let body = CandidateRouteBodyV1 {
        version: 1,
        policy_id: &policy.policy_id,
        policy_hash: &policy_hash,
        eligible_candidate_ids: &eligible_candidate_ids,
        pareto_frontier_ids: &pareto_frontier_ids,
        selected_candidate_id: &selected.candidate_id,
        selected_score,
    };
    let route_hash = canonical_hash("HeptaCandidateRouteReceiptV1", &body)?;
    Ok(CandidateRouteReceiptV1 {
        version: 1,
        policy_id: policy.policy_id,
        policy_hash,
        eligible_candidate_ids,
        pareto_frontier_ids,
        selected_candidate_id: selected.candidate_id.clone(),
        selected_score,
        route_hash,
    })
}

fn eligible(candidate: &CandidateV1, policy: &CandidateRouterPolicyV1) -> bool {
    candidate.feasible
        && candidate.disqualifiers.is_empty()
        && candidate.evidence_score_ppm >= policy.minimum_evidence_ppm
        && candidate.risk_microunits <= policy.maximum_risk_microunits
        && candidate.cost_microusd <= policy.maximum_cost_microusd
        && candidate.latency_ms <= policy.maximum_latency_ms
}

fn dominates(left: &CandidateV1, right: &CandidateV1) -> bool {
    let never_worse = left.expected_utility_microunits >= right.expected_utility_microunits
        && left.evidence_score_ppm >= right.evidence_score_ppm
        && left.risk_microunits <= right.risk_microunits
        && left.cost_microusd <= right.cost_microusd
        && left.latency_ms <= right.latency_ms;
    let strictly_better = left.expected_utility_microunits > right.expected_utility_microunits
        || left.evidence_score_ppm > right.evidence_score_ppm
        || left.risk_microunits < right.risk_microunits
        || left.cost_microusd < right.cost_microusd
        || left.latency_ms < right.latency_ms;
    never_worse && strictly_better
}

fn score(
    candidate: &CandidateV1,
    policy: &CandidateRouterPolicyV1,
) -> Result<i128, CandidateRouterError> {
    let utility = i128::from(candidate.expected_utility_microunits)
        .checked_mul(i128::from(policy.utility_weight))
        .ok_or(CandidateRouterError::Arithmetic)?;
    let evidence = i128::from(candidate.evidence_score_ppm)
        .checked_mul(i128::from(policy.evidence_weight))
        .ok_or(CandidateRouterError::Arithmetic)?;
    let risk = i128::from(candidate.risk_microunits)
        .checked_mul(i128::from(policy.risk_weight))
        .ok_or(CandidateRouterError::Arithmetic)?;
    let cost = i128::from(candidate.cost_microusd)
        .checked_mul(i128::from(policy.cost_weight))
        .ok_or(CandidateRouterError::Arithmetic)?;
    let latency = i128::from(candidate.latency_ms)
        .checked_mul(i128::from(policy.latency_weight))
        .ok_or(CandidateRouterError::Arithmetic)?;
    utility
        .checked_add(evidence)
        .and_then(|value| value.checked_sub(risk))
        .and_then(|value| value.checked_sub(cost))
        .and_then(|value| value.checked_sub(latency))
        .ok_or(CandidateRouterError::Arithmetic)
}

fn validate_policy(policy: &CandidateRouterPolicyV1) -> Result<(), CandidateRouterError> {
    let weights = [
        policy.utility_weight,
        policy.evidence_weight,
        policy.risk_weight,
        policy.cost_weight,
        policy.latency_weight,
    ];
    if policy.version != 1
        || !valid_identifier(&policy.policy_id, 256)
        || policy.minimum_evidence_ppm > 1_000_000
        || weights
            .iter()
            .any(|weight| *weight == 0 || *weight > MAX_WEIGHT)
    {
        return Err(CandidateRouterError::Contract);
    }
    Ok(())
}

fn validate_candidate(candidate: &CandidateV1) -> Result<(), CandidateRouterError> {
    if !valid_identifier(&candidate.candidate_id, 256)
        || !valid_identifier(&candidate.capability_id, 256)
        || candidate.evidence_score_ppm > 1_000_000
        || candidate.disqualifiers.len() > MAX_DISQUALIFIERS
    {
        return Err(CandidateRouterError::Contract);
    }
    let mut unique = BTreeSet::new();
    for item in &candidate.disqualifiers {
        if !valid_identifier(item, 128) || !unique.insert(item) {
            return Err(CandidateRouterError::Contract);
        }
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

fn canonical_hash<T: Serialize>(domain: &str, value: &T) -> Result<String, CandidateRouterError> {
    let bytes = serde_json::to_vec(value).map_err(|_| CandidateRouterError::Encoding)?;
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
struct CandidateRouteBodyV1<'a> {
    version: u16,
    policy_id: &'a str,
    policy_hash: &'a str,
    eligible_candidate_ids: &'a [String],
    pareto_frontier_ids: &'a [String],
    selected_candidate_id: &'a str,
    selected_score: i128,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum CandidateRouterError {
    #[error("candidate routing contract is invalid")]
    Contract,
    #[error("candidate identity is duplicated")]
    DuplicateCandidate,
    #[error("no candidate satisfies the routing policy")]
    NoEligibleCandidate,
    #[error("candidate score overflowed")]
    Arithmetic,
    #[error("candidate routing encoding failed")]
    Encoding,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> CandidateRouterPolicyV1 {
        CandidateRouterPolicyV1 {
            version: 1,
            policy_id: "policy:test".to_owned(),
            minimum_evidence_ppm: 800_000,
            maximum_risk_microunits: 100,
            maximum_cost_microusd: 100,
            maximum_latency_ms: 1_000,
            utility_weight: 10,
            evidence_weight: 1,
            risk_weight: 1,
            cost_weight: 1,
            latency_weight: 1,
        }
    }

    fn candidate(id: &str, utility: i64, risk: u64) -> CandidateV1 {
        CandidateV1 {
            candidate_id: id.to_owned(),
            capability_id: "capability:author".to_owned(),
            expected_utility_microunits: utility,
            evidence_score_ppm: 900_000,
            risk_microunits: risk,
            cost_microusd: 10,
            latency_ms: 10,
            feasible: true,
            disqualifiers: Vec::new(),
        }
    }

    #[test]
    fn routing_is_order_independent() {
        let left = route_candidate_v1(
            policy(),
            vec![
                candidate("candidate:b", 20, 20),
                candidate("candidate:a", 20, 20),
            ],
        );
        let right = route_candidate_v1(
            policy(),
            vec![
                candidate("candidate:a", 20, 20),
                candidate("candidate:b", 20, 20),
            ],
        );
        match (left, right) {
            (Ok(left), Ok(right)) => {
                assert_eq!(left.selected_candidate_id, "candidate:a");
                assert_eq!(left.route_hash, right.route_hash);
            }
            other => panic!("unexpected result: {other:?}"),
        }
    }

    #[test]
    fn dominated_candidate_is_removed() {
        let result = route_candidate_v1(
            policy(),
            vec![
                candidate("candidate:strong", 30, 10),
                candidate("candidate:weak", 20, 20),
            ],
        );
        match result {
            Ok(receipt) => assert_eq!(receipt.pareto_frontier_ids, ["candidate:strong"]),
            other => panic!("unexpected result: {other:?}"),
        }
    }

    #[test]
    fn disqualified_candidates_fail_closed() {
        let mut value = candidate("candidate:no", 30, 10);
        value.disqualifiers.push("policy:denied".to_owned());
        assert_eq!(
            route_candidate_v1(policy(), vec![value]),
            Err(CandidateRouterError::NoEligibleCandidate)
        );
    }
}
