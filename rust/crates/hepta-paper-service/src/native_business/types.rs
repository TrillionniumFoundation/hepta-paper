use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One immutable manuscript section assembled by the native author capability.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManuscriptSectionV1 {
    /// Section heading without a Markdown heading marker.
    pub heading: String,
    /// Exact UTF-8 body text.
    pub body: String,
}

/// Deterministic structural review policy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewPolicyV1 {
    /// Inclusive minimum Unicode-whitespace-delimited word count.
    pub minimum_word_count: u64,
    /// Exact second-level headings that must appear.
    pub required_headings: Vec<String>,
    /// Literal markers that must not appear anywhere in the manuscript.
    pub forbidden_markers: Vec<String>,
}

/// Propositional formula accepted by the native formal checker.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PropositionV1 {
    /// Atomic proposition with a stable identifier.
    Atom { name: String },
    /// Conjunction.
    And { left: Box<PropositionV1>, right: Box<PropositionV1> },
    /// Material implication.
    Implies { antecedent: Box<PropositionV1>, consequent: Box<PropositionV1> },
}

/// One checked proof step. Every referenced index must be earlier than the step.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProofStepV1 {
    Assumption { proposition: PropositionV1 },
    AndIntroduction { left_step: usize, right_step: usize },
    AndEliminationLeft { source_step: usize },
    AndEliminationRight { source_step: usize },
    ModusPonens { implication_step: usize, antecedent_step: usize },
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

/// One immutable artifact descriptor carried by the native submission package.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmissionArtifactV1 {
    /// Stable package-local name. It is an identity, not an arbitrary filesystem path.
    pub name: String,
    /// Bounded media type.
    pub media_type: String,
    /// Canonical `sha256:<64 lowercase/uppercase hex>` content identity.
    pub sha256: String,
    /// Exact artifact byte length.
    pub byte_length: u64,
}

/// One bounded metadata field for a prepared submission package.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmissionMetadataV1 {
    /// Stable metadata key.
    pub key: String,
    /// Exact bounded value. Secrets and credentials are forbidden by caller policy.
    pub value: String,
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
    /// Prepare a deterministic submission envelope without performing an external action.
    SubmissionPackage {
        /// Bounded venue identifier/name.
        venue: String,
        /// Hash of the exact manuscript bytes bound to this package.
        manuscript_sha256: String,
        /// Immutable artifact descriptors.
        artifacts: Vec<SubmissionArtifactV1>,
        /// Sorted canonically by the implementation; duplicate keys are rejected.
        metadata: Vec<SubmissionMetadataV1>,
    },
}

/// Prepared artifacts and bounded evidence emitted by one native job.
#[derive(Clone, Debug, PartialEq)]
pub struct NativeBusinessOutputV1 {
    pub artifacts: Vec<Vec<u8>>,
    pub evidence: Value,
}
