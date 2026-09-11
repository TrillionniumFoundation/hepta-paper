use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One immutable manuscript section assembled by the native author capability.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManuscriptSectionV1 {
    pub heading: String,
    pub body: String,
}

/// Deterministic structural review policy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewPolicyV1 {
    pub minimum_word_count: u64,
    pub required_headings: Vec<String>,
    pub forbidden_markers: Vec<String>,
}

/// Propositional formula accepted by the native formal checker.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PropositionV1 {
    Atom {
        name: String,
    },
    And {
        left: Box<PropositionV1>,
        right: Box<PropositionV1>,
    },
    Implies {
        antecedent: Box<PropositionV1>,
        consequent: Box<PropositionV1>,
    },
}

/// One checked proof step. Every referenced index must be earlier than the step.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProofStepV1 {
    Assumption {
        proposition: PropositionV1,
    },
    AndIntroduction {
        left_step: usize,
        right_step: usize,
    },
    AndEliminationLeft {
        source_step: usize,
    },
    AndEliminationRight {
        source_step: usize,
    },
    ModusPonens {
        implication_step: usize,
        antecedent_step: usize,
    },
}

/// One labeled finite empirical observation.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservationV1 {
    pub label: String,
    pub value: f64,
}

/// One deterministic build input.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildEntryV1 {
    pub path: String,
    pub content: String,
    pub media_type: String,
}

/// Closed Rust-native business job protocol.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeBusinessJobV1 {
    AuthorDraft {
        title: String,
        abstract_text: String,
        sections: Vec<ManuscriptSectionV1>,
        reference_keys: Vec<String>,
    },
    ReviewerAssessment {
        manuscript: String,
        policy: ReviewPolicyV1,
    },
    FormalCertificate {
        assumptions: Vec<PropositionV1>,
        steps: Vec<ProofStepV1>,
        goal: PropositionV1,
    },
    EmpiricalAggregate {
        observations: Vec<ObservationV1>,
    },
    NumericalLinearSolve {
        matrix: Vec<Vec<f64>>,
        rhs: Vec<f64>,
        tolerance: f64,
    },
    BuildPackage {
        entries: Vec<BuildEntryV1>,
    },
    /// Prepare a deterministic submission package without external-effect authority.
    PrepareSubmission {
        venue_id: String,
        manuscript_artifact: String,
        cover_letter: String,
        supplementary_artifacts: Vec<String>,
        recipient_hint: Option<String>,
    },
}

/// Prepared artifacts and bounded evidence emitted by one native job.
#[derive(Clone, Debug, PartialEq)]
pub struct NativeBusinessOutputV1 {
    pub artifacts: Vec<Vec<u8>>,
    pub evidence: Value,
}
