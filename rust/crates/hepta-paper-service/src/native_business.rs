//! Rust-native, bounded business capability workers for `hepta-paper`.
//!
//! The crate implements deterministic author assembly, structural review,
//! propositional proof checking, empirical aggregation, numerical linear solving,
//! and deterministic package construction. It emits prepared artifacts only; it
//! has no campaign-writer, provider, release, portal, or submission authority.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES: usize = 16 * 1024 * 1024;
const MAX_SECTIONS: usize = 256;
const MAX_REFERENCES: usize = 4096;
const MAX_REVIEW_RULES: usize = 4096;
const MAX_PROPOSITION_NODES: usize = 65_536;
const MAX_PROPOSITION_DEPTH: usize = 64;
const MAX_PROOF_STEPS: usize = 16_384;
const MAX_OBSERVATIONS: usize = 1_000_000;
const MAX_MATRIX_DIMENSION: usize = 128;
const MAX_PACKAGE_ENTRIES: usize = 4096;
const MAX_ARTIFACTS: usize = 8;

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
}

/// Prepared artifacts and bounded evidence emitted by one native job.
#[derive(Clone, Debug, PartialEq)]
pub struct NativeBusinessOutputV1 {
    /// One to eight immutable artifact byte strings.
    pub artifacts: Vec<Vec<u8>>,
    /// Closed, bounded evidence object.
    pub evidence: Value,
}

/// Stable implementation identity bound into deployment and process manifests.
pub fn native_business_implementation_hash_v1() -> String {
    hash_domain(
        "HeptaNativeBusinessImplementationV1",
        &[
            include_bytes!("native_business.rs"),
            include_bytes!("bin/hepta-native-business.rs"),
        ],
    )
}

/// Execute one bounded Rust-native business capability.
pub fn execute_native_business_v1(
    job: NativeBusinessJobV1,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    let output = match job {
        NativeBusinessJobV1::AuthorDraft {
            title,
            abstract_text,
            sections,
            reference_keys,
        } => author_draft(title, abstract_text, sections, reference_keys)?,
        NativeBusinessJobV1::ReviewerAssessment { manuscript, policy } => {
            reviewer_assessment(manuscript, policy)?
        }
        NativeBusinessJobV1::FormalCertificate {
            assumptions,
            steps,
            goal,
        } => formal_certificate(assumptions, steps, goal)?,
        NativeBusinessJobV1::EmpiricalAggregate { observations } => {
            empirical_aggregate(observations)?
        }
        NativeBusinessJobV1::NumericalLinearSolve {
            matrix,
            rhs,
            tolerance,
        } => numerical_linear_solve(matrix, rhs, tolerance)?,
        NativeBusinessJobV1::BuildPackage { entries } => build_package(entries)?,
    };
    if output.artifacts.is_empty()
        || output.artifacts.len() > MAX_ARTIFACTS
        || output
            .artifacts
            .iter()
            .any(|artifact| artifact.is_empty() || artifact.len() > MAX_TOTAL_TEXT_BYTES)
    {
        return Err(NativeBusinessError::OutputLimit);
    }
    Ok(output)
}

fn author_draft(
    title: String,
    abstract_text: String,
    sections: Vec<ManuscriptSectionV1>,
    mut reference_keys: Vec<String>,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    validate_inline_text(&title, 512)?;
    validate_body_text(&abstract_text)?;
    if sections.is_empty() || sections.len() > MAX_SECTIONS {
        return Err(NativeBusinessError::Contract);
    }
    let mut total = title.len().saturating_add(abstract_text.len());
    let mut headings = BTreeSet::new();
    for section in &sections {
        validate_inline_text(&section.heading, 512)?;
        validate_body_text(&section.body)?;
        total = total
            .saturating_add(section.heading.len())
            .saturating_add(section.body.len());
        if !headings.insert(section.heading.clone()) {
            return Err(NativeBusinessError::Contract);
        }
    }
    if reference_keys.len() > MAX_REFERENCES {
        return Err(NativeBusinessError::Contract);
    }
    for key in &reference_keys {
        validate_identifier(key, 256)?;
        total = total.saturating_add(key.len());
    }
    reference_keys.sort();
    if reference_keys.windows(2).any(|window| window[0] == window[1])
        || total > MAX_TOTAL_TEXT_BYTES
    {
        return Err(NativeBusinessError::Contract);
    }

    let mut manuscript = String::with_capacity(total.saturating_add(4096));
    manuscript.push_str("# ");
    manuscript.push_str(&title);
    manuscript.push_str("\n\n## Abstract\n\n");
    manuscript.push_str(&abstract_text);
    manuscript.push('\n');
    for section in &sections {
        manuscript.push_str("\n## ");
        manuscript.push_str(&section.heading);
        manuscript.push_str("\n\n");
        manuscript.push_str(&section.body);
        manuscript.push('\n');
    }
    if !reference_keys.is_empty() {
        manuscript.push_str("\n## References\n\n");
        for key in &reference_keys {
            manuscript.push_str("- [");
            manuscript.push_str(key);
            manuscript.push_str("]\n");
        }
    }
    let bytes = manuscript.into_bytes();
    let hash = hash_bytes(&bytes);
    let word_count = count_words(
        std::str::from_utf8(&bytes).map_err(|_| NativeBusinessError::Encoding)?,
    );
    Ok(NativeBusinessOutputV1 {
        artifacts: vec![bytes],
        evidence: json!({
            "kind": "NativeAuthorEvidenceV1",
            "version": 1,
            "artifactHash": hash,
            "wordCount": word_count,
            "sectionCount": sections.len(),
            "referenceCount": reference_keys.len(),
            "deterministic": true,
            "externalActionMayHaveStarted": false
        }),
    })
}

fn reviewer_assessment(
    manuscript: String,
    mut policy: ReviewPolicyV1,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    validate_body_text(&manuscript)?;
    if policy.required_headings.len() > MAX_REVIEW_RULES
        || policy.forbidden_markers.len() > MAX_REVIEW_RULES
    {
        return Err(NativeBusinessError::Contract);
    }
    for heading in &policy.required_headings {
        validate_inline_text(heading, 512)?;
    }
    for marker in &policy.forbidden_markers {
        validate_inline_text(marker, 512)?;
    }
    policy.required_headings.sort();
    policy.required_headings.dedup();
    policy.forbidden_markers.sort();
    policy.forbidden_markers.dedup();

    let actual_headings: BTreeSet<String> = manuscript
        .lines()
        .filter_map(|line| line.strip_prefix("## "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    let missing_headings: Vec<String> = policy
        .required_headings
        .iter()
        .filter(|heading| !actual_headings.contains(heading.as_str()))
        .cloned()
        .collect();
    let forbidden_matches: Vec<String> = policy
        .forbidden_markers
        .iter()
        .filter(|marker| manuscript.contains(marker.as_str()))
        .cloned()
        .collect();
    let word_count = count_words(&manuscript);
    let accepted = word_count >= policy.minimum_word_count
        && missing_headings.is_empty()
        && forbidden_matches.is_empty();
    let report = ReviewReportV1 {
        kind: "NativeReviewReportV1",
        version: 1,
        manuscript_hash: hash_bytes(manuscript.as_bytes()),
        accepted,
        word_count,
        minimum_word_count: policy.minimum_word_count,
        missing_headings,
        forbidden_matches,
    };
    let bytes = serde_json::to_vec(&report).map_err(|_| NativeBusinessError::Encoding)?;
    Ok(NativeBusinessOutputV1 {
        artifacts: vec![bytes.clone()],
        evidence: json!({
            "kind": "NativeReviewerEvidenceV1",
            "version": 1,
            "reportHash": hash_bytes(&bytes),
            "accepted": accepted,
            "wordCount": word_count,
            "deterministic": true,
            "externalActionMayHaveStarted": false
        }),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewReportV1 {
    kind: &'static str,
    version: u16,
    manuscript_hash: String,
    accepted: bool,
    word_count: u64,
    minimum_word_count: u64,
    missing_headings: Vec<String>,
    forbidden_matches: Vec<String>,
}

fn formal_certificate(
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
        let proposition = match step {
            ProofStepV1::Assumption { proposition } => {
                let encoded = serde_json::to_vec(proposition)
                    .map_err(|_| NativeBusinessError::Encoding)?;
                if !assumption_set.contains(&encoded) {
                    return Err(NativeBusinessError::ProofInvalid);
                }
                proposition.clone()
            }
            ProofStepV1::AndIntroduction {
                left_step,
                right_step,
            } => PropositionV1::And {
                left: Box::new(previous(&derived, *left_step, index)?.clone()),
                right: Box::new(previous(&derived, *right_step, index)?.clone()),
            },
            ProofStepV1::AndEliminationLeft { source_step } => {
                match previous(&derived, *source_step, index)? {
                    PropositionV1::And { left, .. } => left.as_ref().clone(),
                    _ => return Err(NativeBusinessError::ProofInvalid),
                }
            }
            ProofStepV1::AndEliminationRight { source_step } => {
                match previous(&derived, *source_step, index)? {
                    PropositionV1::And { right, .. } => right.as_ref().clone(),
                    _ => return Err(NativeBusinessError::ProofInvalid),
                }
            }
            ProofStepV1::ModusPonens {
                implication_step,
                antecedent_step,
            } => {
                let antecedent = previous(&derived, *antecedent_step, index)?;
                match previous(&derived, *implication_step, index)? {
                    PropositionV1::Implies {
                        antecedent: required,
                        consequent,
                    } if required.as_ref() == antecedent => consequent.as_ref().clone(),
                    _ => return Err(NativeBusinessError::ProofInvalid),
                }
            }
        };
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

fn empirical_aggregate(
    observations: Vec<ObservationV1>,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    if observations.is_empty() || observations.len() > MAX_OBSERVATIONS {
        return Err(NativeBusinessError::Contract);
    }
    let mut labels = BTreeSet::new();
    let mut mean = 0.0f64;
    let mut m2 = 0.0f64;
    let mut minimum = f64::INFINITY;
    let mut maximum = f64::NEG_INFINITY;
    for (index, observation) in observations.iter().enumerate() {
        validate_identifier(&observation.label, 256)?;
        if !labels.insert(observation.label.clone()) || !observation.value.is_finite() {
            return Err(NativeBusinessError::Numeric);
        }
        let count = (index + 1) as f64;
        let delta = observation.value - mean;
        mean += delta / count;
        let delta_after = observation.value - mean;
        m2 += delta * delta_after;
        minimum = minimum.min(observation.value);
        maximum = maximum.max(observation.value);
        if !mean.is_finite() || !m2.is_finite() {
            return Err(NativeBusinessError::Numeric);
        }
    }
    let count = observations.len();
    let variance_population = m2 / count as f64;
    let variance_sample = if count > 1 {
        Some(m2 / (count - 1) as f64)
    } else {
        None
    };
    if !variance_population.is_finite()
        || variance_sample.is_some_and(|value| !value.is_finite())
    {
        return Err(NativeBusinessError::Numeric);
    }
    let report = EmpiricalReportV1 {
        kind: "NativeEmpiricalAggregateV1",
        version: 1,
        count,
        mean,
        minimum,
        maximum,
        variance_population,
        variance_sample,
        observation_set_hash: hash_serialized(
            "HeptaNativeObservationSetV1",
            &observations,
        )?,
    };
    let bytes = serde_json::to_vec(&report).map_err(|_| NativeBusinessError::Encoding)?;
    Ok(NativeBusinessOutputV1 {
        artifacts: vec![bytes.clone()],
        evidence: json!({
            "kind": "NativeEmpiricalEvidenceV1",
            "version": 1,
            "reportHash": hash_bytes(&bytes),
            "observationCount": count,
            "finite": true,
            "externalActionMayHaveStarted": false
        }),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EmpiricalReportV1 {
    kind: &'static str,
    version: u16,
    count: usize,
    mean: f64,
    minimum: f64,
    maximum: f64,
    variance_population: f64,
    variance_sample: Option<f64>,
    observation_set_hash: String,
}

#[allow(clippy::needless_range_loop)]
fn numerical_linear_solve(
    matrix: Vec<Vec<f64>>,
    rhs: Vec<f64>,
    tolerance: f64,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    let dimension = matrix.len();
    if dimension == 0
        || dimension > MAX_MATRIX_DIMENSION
        || rhs.len() != dimension
        || !tolerance.is_finite()
        || tolerance <= 0.0
        || matrix.iter().any(|row| row.len() != dimension)
        || matrix
            .iter()
            .flatten()
            .chain(rhs.iter())
            .any(|value| !value.is_finite())
    {
        return Err(NativeBusinessError::Contract);
    }
    let original_matrix = matrix.clone();
    let original_rhs = rhs.clone();
    let mut coefficients = matrix;
    let mut values = rhs;
    for pivot in 0..dimension {
        let mut selected = pivot;
        let mut selected_abs = coefficients[pivot][pivot].abs();
        for row in (pivot + 1)..dimension {
            let candidate = coefficients[row][pivot].abs();
            if candidate > selected_abs {
                selected = row;
                selected_abs = candidate;
            }
        }
        if !selected_abs.is_finite() || selected_abs <= tolerance {
            return Err(NativeBusinessError::SingularMatrix);
        }
        if selected != pivot {
            coefficients.swap(selected, pivot);
            values.swap(selected, pivot);
        }
        for row in (pivot + 1)..dimension {
            let factor = coefficients[row][pivot] / coefficients[pivot][pivot];
            coefficients[row][pivot] = 0.0;
            for column in (pivot + 1)..dimension {
                coefficients[row][column] -= factor * coefficients[pivot][column];
            }
            values[row] -= factor * values[pivot];
            if !values[row].is_finite()
                || coefficients[row][(pivot + 1)..]
                    .iter()
                    .any(|value| !value.is_finite())
            {
                return Err(NativeBusinessError::Numeric);
            }
        }
    }
    let mut solution = vec![0.0f64; dimension];
    for row in (0..dimension).rev() {
        let mut remainder = values[row];
        for column in (row + 1)..dimension {
            remainder -= coefficients[row][column] * solution[column];
        }
        if coefficients[row][row].abs() <= tolerance {
            return Err(NativeBusinessError::SingularMatrix);
        }
        solution[row] = remainder / coefficients[row][row];
        if !solution[row].is_finite() {
            return Err(NativeBusinessError::Numeric);
        }
    }
    let mut residual_linf = 0.0f64;
    for row in 0..dimension {
        let computed = original_matrix[row]
            .iter()
            .zip(solution.iter())
            .map(|(coefficient, value)| coefficient * value)
            .sum::<f64>();
        residual_linf = residual_linf.max((computed - original_rhs[row]).abs());
    }
    if !residual_linf.is_finite() {
        return Err(NativeBusinessError::Numeric);
    }
    let report = NumericalReportV1 {
        kind: "NativeNumericalLinearSolutionV1",
        version: 1,
        dimension,
        solution,
        residual_linf,
        tolerance,
        input_hash: hash_serialized(
            "HeptaNativeLinearSystemV1",
            &(original_matrix, original_rhs),
        )?,
    };
    let bytes = serde_json::to_vec(&report).map_err(|_| NativeBusinessError::Encoding)?;
    Ok(NativeBusinessOutputV1 {
        artifacts: vec![bytes.clone()],
        evidence: json!({
            "kind": "NativeNumericalEvidenceV1",
            "version": 1,
            "reportHash": hash_bytes(&bytes),
            "dimension": dimension,
            "residualLinf": residual_linf,
            "externalActionMayHaveStarted": false
        }),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NumericalReportV1 {
    kind: &'static str,
    version: u16,
    dimension: usize,
    solution: Vec<f64>,
    residual_linf: f64,
    tolerance: f64,
    input_hash: String,
}

fn build_package(
    mut entries: Vec<BuildEntryV1>,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    if entries.is_empty() || entries.len() > MAX_PACKAGE_ENTRIES {
        return Err(NativeBusinessError::Contract);
    }
    let mut total = 0usize;
    for entry in &entries {
        validate_package_path(&entry.path)?;
        validate_inline_text(&entry.media_type, 256)?;
        validate_body_text(&entry.content)?;
        total = total
            .saturating_add(entry.path.len())
            .saturating_add(entry.media_type.len())
            .saturating_add(entry.content.len());
    }
    if total > MAX_TOTAL_TEXT_BYTES {
        return Err(NativeBusinessError::Contract);
    }
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    if entries.windows(2).any(|window| window[0].path == window[1].path) {
        return Err(NativeBusinessError::Contract);
    }
    let manifest_entries: Vec<BuildManifestEntryV1> = entries
        .iter()
        .map(|entry| BuildManifestEntryV1 {
            path: entry.path.clone(),
            media_type: entry.media_type.clone(),
            byte_length: entry.content.len(),
            sha256: hash_bytes(entry.content.as_bytes()),
        })
        .collect();
    let bundle = encode_bundle(&entries)?;
    let manifest = BuildManifestV1 {
        kind: "NativeBuildManifestV1",
        version: 1,
        entry_count: entries.len(),
        bundle_hash: hash_bytes(&bundle),
        entries: manifest_entries,
    };
    let manifest_bytes =
        serde_json::to_vec(&manifest).map_err(|_| NativeBusinessError::Encoding)?;
    Ok(NativeBusinessOutputV1 {
        artifacts: vec![manifest_bytes.clone(), bundle.clone()],
        evidence: json!({
            "kind": "NativeBuildEvidenceV1",
            "version": 1,
            "manifestHash": hash_bytes(&manifest_bytes),
            "bundleHash": hash_bytes(&bundle),
            "entryCount": entries.len(),
            "deterministic": true,
            "externalActionMayHaveStarted": false
        }),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildManifestV1 {
    kind: &'static str,
    version: u16,
    entry_count: usize,
    bundle_hash: String,
    entries: Vec<BuildManifestEntryV1>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildManifestEntryV1 {
    path: String,
    media_type: String,
    byte_length: usize,
    sha256: String,
}

fn encode_bundle(entries: &[BuildEntryV1]) -> Result<Vec<u8>, NativeBusinessError> {
    let mut bundle = Vec::new();
    bundle.extend_from_slice(b"HEPTA-NATIVE-BUNDLE-V1\0");
    append_length(&mut bundle, entries.len())?;
    for entry in entries {
        append_field(&mut bundle, entry.path.as_bytes())?;
        append_field(&mut bundle, entry.media_type.as_bytes())?;
        append_field(&mut bundle, entry.content.as_bytes())?;
    }
    if bundle.len() > MAX_TOTAL_TEXT_BYTES {
        return Err(NativeBusinessError::OutputLimit);
    }
    Ok(bundle)
}

fn append_length(output: &mut Vec<u8>, length: usize) -> Result<(), NativeBusinessError> {
    let value = u64::try_from(length).map_err(|_| NativeBusinessError::OutputLimit)?;
    output.extend_from_slice(&value.to_be_bytes());
    Ok(())
}

fn append_field(output: &mut Vec<u8>, value: &[u8]) -> Result<(), NativeBusinessError> {
    append_length(output, value.len())?;
    output.extend_from_slice(value);
    Ok(())
}

fn validate_package_path(value: &str) -> Result<(), NativeBusinessError> {
    if value.is_empty()
        || value.len() > 1024
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains('\\')
        || value.contains('\0')
        || value
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(NativeBusinessError::Contract);
    }
    Ok(())
}

fn validate_inline_text(value: &str, maximum: usize) -> Result<(), NativeBusinessError> {
    if value.is_empty()
        || value.len() > maximum
        || value.chars().any(|character| character.is_control())
    {
        return Err(NativeBusinessError::Contract);
    }
    Ok(())
}

fn validate_body_text(value: &str) -> Result<(), NativeBusinessError> {
    if value.is_empty()
        || value.len() > MAX_TEXT_BYTES
        || value.contains('\0')
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(NativeBusinessError::Contract);
    }
    Ok(())
}

fn validate_identifier(value: &str, maximum: usize) -> Result<(), NativeBusinessError> {
    if value.is_empty()
        || value.len() > maximum
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
    {
        return Err(NativeBusinessError::Contract);
    }
    Ok(())
}

fn count_words(value: &str) -> u64 {
    u64::try_from(value.split_whitespace().count()).unwrap_or(u64::MAX)
}

fn hash_bytes(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn hash_domain(domain: &str, values: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    update_hash(&mut hasher, domain.as_bytes());
    for value in values {
        update_hash(&mut hasher, value);
    }
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

fn hash_serialized<T: Serialize>(domain: &str, value: &T) -> Result<String, NativeBusinessError> {
    let bytes = serde_json::to_vec(value).map_err(|_| NativeBusinessError::Encoding)?;
    Ok(hash_domain(domain, &[&bytes]))
}

fn update_hash(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

/// Native capability contract, proof, numerical, or encoding failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum NativeBusinessError {
    /// Input shape, identity, path, or bound is invalid.
    #[error("native business contract is invalid")]
    Contract,
    /// Proof certificate is not valid for the supplied assumptions and goal.
    #[error("native formal proof is invalid")]
    ProofInvalid,
    /// Proof depth, node, or step budget is exceeded.
    #[error("native formal proof exceeds limits")]
    ProofLimit,
    /// A numeric value is non-finite or arithmetic overflowed.
    #[error("native numeric input or result is invalid")]
    Numeric,
    /// The supplied linear system is singular within the declared tolerance.
    #[error("native linear system is singular")]
    SingularMatrix,
    /// Canonical JSON or UTF-8 encoding failed.
    #[error("native business encoding failed")]
    Encoding,
    /// Produced artifacts exceed the prepared-result envelope.
    #[error("native business output exceeds limits")]
    OutputLimit,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atom(name: &str) -> PropositionV1 {
        PropositionV1::Atom { name: name.into() }
    }

    #[test]
    fn author_and_review_are_deterministic_and_bounded() {
        let author = NativeBusinessJobV1::AuthorDraft {
            title: "Native Rust Research".into(),
            abstract_text: "A bounded deterministic abstract.".into(),
            sections: vec![ManuscriptSectionV1 {
                heading: "Method".into(),
                body: "The method is implemented without a Node runtime.".into(),
            }],
            reference_keys: vec!["ref-b".into(), "ref-a".into()],
        };
        let first = execute_native_business_v1(author.clone()).expect("native author");
        let second = execute_native_business_v1(author).expect("deterministic author");
        assert_eq!(first, second);
        let manuscript =
            String::from_utf8(first.artifacts[0].clone()).expect("UTF-8 manuscript");
        assert!(manuscript.contains("## Method"));
        assert!(manuscript.find("[ref-a]") < manuscript.find("[ref-b]"));

        let review = execute_native_business_v1(NativeBusinessJobV1::ReviewerAssessment {
            manuscript,
            policy: ReviewPolicyV1 {
                minimum_word_count: 6,
                required_headings: vec!["Abstract".into(), "Method".into()],
                forbidden_markers: vec!["TODO".into()],
            },
        })
        .expect("native reviewer");
        assert_eq!(review.evidence["accepted"], true);
    }

    #[test]
    fn formal_kernel_checks_dependency_order_and_goal() {
        let a = atom("A");
        let b = atom("B");
        let implication = PropositionV1::Implies {
            antecedent: Box::new(a.clone()),
            consequent: Box::new(b.clone()),
        };
        let output = execute_native_business_v1(NativeBusinessJobV1::FormalCertificate {
            assumptions: vec![a.clone(), implication.clone()],
            steps: vec![
                ProofStepV1::Assumption {
                    proposition: implication,
                },
                ProofStepV1::Assumption { proposition: a },
                ProofStepV1::ModusPonens {
                    implication_step: 0,
                    antecedent_step: 1,
                },
            ],
            goal: b,
        })
        .expect("checked proof");
        assert_eq!(output.evidence["accepted"], true);
    }

    #[test]
    fn empirical_and_numerical_results_are_finite() {
        let empirical = execute_native_business_v1(NativeBusinessJobV1::EmpiricalAggregate {
            observations: vec![
                ObservationV1 {
                    label: "sample-1".into(),
                    value: 1.0,
                },
                ObservationV1 {
                    label: "sample-2".into(),
                    value: 3.0,
                },
            ],
        })
        .expect("empirical aggregate");
        assert_eq!(empirical.evidence["observationCount"], 2);

        let numerical = execute_native_business_v1(NativeBusinessJobV1::NumericalLinearSolve {
            matrix: vec![vec![2.0, 1.0], vec![1.0, 3.0]],
            rhs: vec![5.0, 6.0],
            tolerance: 1e-12,
        })
        .expect("linear solve");
        let report: Value =
            serde_json::from_slice(&numerical.artifacts[0]).expect("report");
        assert!((report["solution"][0].as_f64().expect("x") - 1.8).abs() < 1e-12);
        assert!((report["solution"][1].as_f64().expect("y") - 1.4).abs() < 1e-12);
    }

    #[test]
    fn build_package_is_order_independent_and_rejects_aliases() {
        let entries = vec![
            BuildEntryV1 {
                path: "paper/main.md".into(),
                content: "paper".into(),
                media_type: "text/markdown".into(),
            },
            BuildEntryV1 {
                path: "data/results.json".into(),
                content: "{}".into(),
                media_type: "application/json".into(),
            },
        ];
        let first = execute_native_business_v1(NativeBusinessJobV1::BuildPackage {
            entries: entries.clone(),
        })
        .expect("package");
        let second = execute_native_business_v1(NativeBusinessJobV1::BuildPackage {
            entries: entries.into_iter().rev().collect(),
        })
        .expect("order independent package");
        assert_eq!(first, second);
        assert_eq!(first.artifacts.len(), 2);
        assert!(
            execute_native_business_v1(NativeBusinessJobV1::BuildPackage {
                entries: vec![BuildEntryV1 {
                    path: "../escape".into(),
                    content: "bad".into(),
                    media_type: "text/plain".into(),
                }],
            })
            .is_err()
        );
    }
}
