use std::collections::BTreeMap;

use hepta_codex_protocol::Sha256Digest;
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
    Atom {
        /// Atom identifier.
        name: String,
    },
    /// Conjunction.
    And {
        /// Left conjunct.
        left: Box<PropositionV1>,
        /// Right conjunct.
        right: Box<PropositionV1>,
    },
    /// Material implication.
    Implies {
        /// Antecedent.
        antecedent: Box<PropositionV1>,
        /// Consequent.
        consequent: Box<PropositionV1>,
    },
}

/// One checked proof step. Every referenced index must be earlier than the step.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProofStepV1 {
    /// Introduce one declared assumption.
    Assumption {
        /// Proposition that must occur in the declared assumption set.
        proposition: PropositionV1,
    },
    /// Construct a conjunction from two earlier propositions.
    AndIntroduction {
        /// Earlier left proposition index.
        left_step: usize,
        /// Earlier right proposition index.
        right_step: usize,
    },
    /// Extract the left conjunct.
    AndEliminationLeft {
        /// Earlier conjunction index.
        source_step: usize,
    },
    /// Extract the right conjunct.
    AndEliminationRight {
        /// Earlier conjunction index.
        source_step: usize,
    },
    /// Apply an implication to its antecedent.
    ModusPonens {
        /// Earlier implication index.
        implication_step: usize,
        /// Earlier antecedent index.
        antecedent_step: usize,
    },
}

/// One labeled finite empirical observation.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservationV1 {
    /// Stable unique label.
    pub label: String,
    /// Finite observed value.
    pub value: f64,
}

/// One deterministic build input.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildEntryV1 {
    /// Canonical repository-relative package path.
    pub path: String,
    /// Exact UTF-8 file content.
    pub content: String,
    /// Bounded media type recorded in the manifest.
    pub media_type: String,
}

/// Closed Rust-native business job protocol.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeBusinessJobV1 {
    /// Assemble a deterministic Markdown manuscript.
    AuthorDraft {
        /// Manuscript title.
        title: String,
        /// Abstract body without heading marker.
        abstract_text: String,
        /// Ordered manuscript sections.
        sections: Vec<ManuscriptSectionV1>,
        /// Sorted unique citation keys rendered as a reference list.
        reference_keys: Vec<String>,
    },
    /// Perform deterministic structural manuscript review.
    ReviewerAssessment {
        /// Exact manuscript text under review.
        manuscript: String,
        /// Structural policy.
        policy: ReviewPolicyV1,
    },
    /// Check a propositional natural-deduction certificate.
    FormalCertificate {
        /// Declared assumption set.
        assumptions: Vec<PropositionV1>,
        /// Ordered proof steps.
        steps: Vec<ProofStepV1>,
        /// Required final proposition.
        goal: PropositionV1,
    },
    /// Compute stable descriptive statistics over finite observations.
    EmpiricalAggregate {
        /// Unique labeled observations.
        observations: Vec<ObservationV1>,
    },
    /// Solve a square linear system using deterministic partial pivoting.
    NumericalLinearSolve {
        /// Row-major square coefficient matrix.
        matrix: Vec<Vec<f64>>,
        /// Right-hand-side vector.
        rhs: Vec<f64>,
        /// Strictly positive singularity threshold.
        tolerance: f64,
    },
    /// Build a deterministic manifest and binary bundle.
    BuildPackage {
        /// Package entries, normalized and sorted by path.
        entries: Vec<BuildEntryV1>,
    },
    /// Prepare an immutable submission intent without performing an external action.
    SubmissionPackage {
        /// Stable venue/target identifier resolved by the separately qualified connector layer.
        venue: String,
        /// Exact immutable manuscript/package object hash.
        manuscript_hash: Sha256Digest,
        /// Optional immutable supplementary object hashes.
        supplementary_hashes: Vec<Sha256Digest>,
        /// Canonical bounded metadata passed to the external-authority layer.
        metadata: BTreeMap<String, String>,
        /// Stable operation identity; conflicting reuse must be rejected by the external port.
        idempotency_key: String,
    },
}

/// Prepared artifacts and bounded evidence emitted by one native job.
#[derive(Clone, Debug, PartialEq)]
pub struct NativeBusinessOutputV1 {
    /// One to eight immutable artifact byte strings.
    pub artifacts: Vec<Vec<u8>>,
    /// Closed, bounded evidence object.
    pub evidence: Value,
}
