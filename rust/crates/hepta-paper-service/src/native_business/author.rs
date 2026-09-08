use super::{
    ManuscriptSectionV1, NativeBusinessError, NativeBusinessOutputV1, count_words, hash_bytes,
    validate_body_text, validate_identifier, validate_inline_text, MAX_TOTAL_TEXT_BYTES,
};
use serde_json::json;
use std::collections::BTreeSet;

const MAX_SECTIONS: usize = 256;
const MAX_REFERENCES: usize = 4096;

pub(super) fn author_draft(
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
    if reference_keys
        .windows(2)
        .any(|window| window[0] == window[1])
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
    let word_count =
        count_words(std::str::from_utf8(&bytes).map_err(|_| NativeBusinessError::Encoding)?);
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
