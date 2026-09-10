use super::{
    NativeBusinessError, NativeBusinessOutputV1, ReviewPolicyV1, count_words, hash_bytes,
    validate_body_text, validate_inline_text,
};
use serde::Serialize;
use serde_json::json;
use std::collections::BTreeSet;

const MAX_REVIEW_RULES: usize = 4096;

pub(super) fn reviewer_assessment(
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
