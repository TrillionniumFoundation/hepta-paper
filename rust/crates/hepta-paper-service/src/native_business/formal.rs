use super::{
    NativeBusinessError, NativeBusinessOutputV1, ProofStepV1, PropositionV1, hash_bytes,
    hash_serialized, validate_identifier,
};
use serde::Serialize;
use serde_json::json;
use std::collections::BTreeSet;

const MAX_PROPOSITION_NODES: usize = 65_536;
const MAX_PROPOSITION_DEPTH: usize = 64;
const MAX_PROOF_STEPS: usize = 16_384;

pub(super) fn formal_certificate(
    assumptions: Vec<PropositionV1>,
    steps: Vec<ProofStepV1>,
    goal: PropositionV1,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    if assumptions.len() > MAX_PROOF_STEPS || steps.is_empty() || steps.len() > MAX_PROOF_STEPS {
        return Err(NativeBusinessError::Contract);
    }
    let mut node_budget = 0usize;
    for proposition in assumptions.iter().chain(std::iter::once(&goal)) {
        validate_proposition(proposition, 0, &mut node_budget)?;
    }
    for step in &steps {
        if let ProofStepV1::Assumption { proposition } = step {
            validate_proposition(proposition, 0, &mut node_budget)?;
        }
    }
    let assumption_set: BTreeSet<Vec<u8>> = assumptions
        .iter()
        .map(|value| serde_json::to_vec(value).map_err(|_| NativeBusinessError::Encoding))
        .collect::<Result<_, _>>()?;
    if assumption_set.len() != assumptions.len() {
        return Err(NativeBusinessError::Contract);
    }

    let mut derived = Vec::with_capacity(steps.len());
    for (index, step) in steps.iter().enumerate() {
        let proposition = derive_step(step, index, &derived, &assumption_set)?;
        validate_proposition(&proposition, 0, &mut node_budget)?;
        derived.push(proposition);
    }
    if derived.last() != Some(&goal) {
        return Err(NativeBusinessError::ProofInvalid);
    }
    let certificate = FormalReportV1 {
        kind: "NativeFormalCertificateV1",
        version: 1,
        accepted: true,
        assumption_count: assumptions.len(),
        step_count: steps.len(),
        goal,
        proof_hash: hash_serialized("HeptaNativeFormalProofV1", &(assumptions, steps))?,
    };
    let bytes = serde_json::to_vec(&certificate).map_err(|_| NativeBusinessError::Encoding)?;
    Ok(NativeBusinessOutputV1 {
        artifacts: vec![bytes.clone()],
        evidence: json!({
            "kind": "NativeFormalEvidenceV1",
            "version": 1,
            "certificateHash": hash_bytes(&bytes),
            "accepted": true,
            "trustedKernel": "hepta_propositional_kernel_v1",
            "externalActionMayHaveStarted": false
        }),
    })
}

fn derive_step(
    step: &ProofStepV1,
    index: usize,
    derived: &[PropositionV1],
    assumptions: &BTreeSet<Vec<u8>>,
) -> Result<PropositionV1, NativeBusinessError> {
    match step {
        ProofStepV1::Assumption { proposition } => {
            let encoded =
                serde_json::to_vec(proposition).map_err(|_| NativeBusinessError::Encoding)?;
            if !assumptions.contains(&encoded) {
                return Err(NativeBusinessError::ProofInvalid);
            }
            Ok(proposition.clone())
        }
        ProofStepV1::AndIntroduction {
            left_step,
            right_step,
        } => Ok(PropositionV1::And {
            left: Box::new(previous(derived, *left_step, index)?.clone()),
            right: Box::new(previous(derived, *right_step, index)?.clone()),
        }),
        ProofStepV1::AndEliminationLeft { source_step } => {
            match previous(derived, *source_step, index)? {
                PropositionV1::And { left, .. } => Ok(left.as_ref().clone()),
                _ => Err(NativeBusinessError::ProofInvalid),
            }
        }
        ProofStepV1::AndEliminationRight { source_step } => {
            match previous(derived, *source_step, index)? {
                PropositionV1::And { right, .. } => Ok(right.as_ref().clone()),
                _ => Err(NativeBusinessError::ProofInvalid),
            }
        }
        ProofStepV1::ModusPonens {
            implication_step,
            antecedent_step,
        } => {
            let antecedent = previous(derived, *antecedent_step, index)?;
            match previous(derived, *implication_step, index)? {
                PropositionV1::Implies {
                    antecedent: required,
                    consequent,
                } if required.as_ref() == antecedent => Ok(consequent.as_ref().clone()),
                _ => Err(NativeBusinessError::ProofInvalid),
            }
        }
    }
}

fn previous(
    derived: &[PropositionV1],
    requested: usize,
    current: usize,
) -> Result<&PropositionV1, NativeBusinessError> {
    if requested >= current {
        return Err(NativeBusinessError::ProofInvalid);
    }
    derived
        .get(requested)
        .ok_or(NativeBusinessError::ProofInvalid)
}

fn validate_proposition(
    value: &PropositionV1,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), NativeBusinessError> {
    if depth > MAX_PROPOSITION_DEPTH {
        return Err(NativeBusinessError::ProofLimit);
    }
    *nodes = nodes.saturating_add(1);
    if *nodes > MAX_PROPOSITION_NODES {
        return Err(NativeBusinessError::ProofLimit);
    }
    match value {
        PropositionV1::Atom { name } => validate_identifier(name, 256),
        PropositionV1::And { left, right } => {
            validate_proposition(left, depth + 1, nodes)?;
            validate_proposition(right, depth + 1, nodes)
        }
        PropositionV1::Implies {
            antecedent,
            consequent,
        } => {
            validate_proposition(antecedent, depth + 1, nodes)?;
            validate_proposition(consequent, depth + 1, nodes)
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FormalReportV1 {
    kind: &'static str,
    version: u16,
    accepted: bool,
    assumption_count: usize,
    step_count: usize,
    goal: PropositionV1,
    proof_hash: String,
}
