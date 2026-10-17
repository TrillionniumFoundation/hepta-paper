use super::{
    BuildEntryV1, MAX_TOTAL_TEXT_BYTES, NativeBusinessError, NativeBusinessOutputV1, hash_bytes,
    validate_body_text, validate_inline_text,
};
use serde::Serialize;
use serde_json::json;
use std::collections::BTreeSet;

const MAX_PACKAGE_ENTRIES: usize = 4096;

pub(super) fn build_package(
    mut entries: Vec<BuildEntryV1>,
) -> Result<NativeBusinessOutputV1, NativeBusinessError> {
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    validate_entries(&entries)?;
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
        || value.chars().any(char::is_control)
        || value
            .split('/')
            .next()
            .is_some_and(|part| part.contains(':'))
        || value
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(NativeBusinessError::Contract);
    }
    Ok(())
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

/// Decodes a content-addressed native V1 bundle without writing any filesystem state.
/// The expected digest must come from an independently selected manifest/CAS record.
/// A matching digest establishes content identity, not release or submission authority.
pub fn verify_native_build_bundle_v1(
    bundle: &[u8],
    expected_sha256: &str,
) -> Result<Vec<BuildEntryV1>, NativeBusinessError> {
    const MAGIC: &[u8] = b"HEPTA-NATIVE-BUNDLE-V1\0";
    if bundle.len() > MAX_TOTAL_TEXT_BYTES
        || !bundle.starts_with(MAGIC)
        || hash_bytes(bundle) != expected_sha256
    {
        return Err(NativeBusinessError::Contract);
    }
    let mut remaining = &bundle[MAGIC.len()..];
    let count = take_length(&mut remaining)?;
    if count == 0 || count > MAX_PACKAGE_ENTRIES {
        return Err(NativeBusinessError::Contract);
    }
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        entries.push(BuildEntryV1 {
            path: take_text(&mut remaining, 1024)?,
            media_type: take_text(&mut remaining, 256)?,
            content: take_text(&mut remaining, super::MAX_TEXT_BYTES)?,
        });
    }
    if !remaining.is_empty() {
        return Err(NativeBusinessError::Contract);
    }
    validate_entries(&entries)?;
    Ok(entries)
}

fn take_length(input: &mut &[u8]) -> Result<usize, NativeBusinessError> {
    let prefix = input.get(..8).ok_or(NativeBusinessError::Contract)?;
    let bytes: [u8; 8] = prefix
        .try_into()
        .map_err(|_| NativeBusinessError::Contract)?;
    let length =
        usize::try_from(u64::from_be_bytes(bytes)).map_err(|_| NativeBusinessError::OutputLimit)?;
    *input = &input[8..];
    Ok(length)
}

fn take_text(input: &mut &[u8], maximum: usize) -> Result<String, NativeBusinessError> {
    let length = take_length(input)?;
    if length == 0 || length > maximum || length > input.len() {
        return Err(NativeBusinessError::Contract);
    }
    let text = std::str::from_utf8(&input[..length])
        .map_err(|_| NativeBusinessError::Encoding)?
        .to_owned();
    *input = &input[length..];
    Ok(text)
}

fn validate_entries(entries: &[BuildEntryV1]) -> Result<(), NativeBusinessError> {
    if entries.is_empty()
        || entries.len() > MAX_PACKAGE_ENTRIES
        || entries.windows(2).any(|pair| pair[0].path >= pair[1].path)
    {
        return Err(NativeBusinessError::Contract);
    }
    let paths: BTreeSet<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
    let mut total = 0usize;
    for entry in entries {
        validate_package_path(&entry.path)?;
        validate_inline_text(&entry.media_type, 256)?;
        validate_body_text(&entry.content)?;
        // A file and any of its descendants cannot coexist. Do not rely on
        // adjacency: e.g. a, a-b, a/c are lexicographically interleaved.
        if entry
            .path
            .match_indices('/')
            .any(|(end, _)| paths.contains(&entry.path[..end]))
        {
            return Err(NativeBusinessError::Contract);
        }
        total = total
            .saturating_add(entry.path.len())
            .saturating_add(entry.media_type.len())
            .saturating_add(entry.content.len());
    }
    if total > MAX_TOTAL_TEXT_BYTES {
        return Err(NativeBusinessError::Contract);
    }
    Ok(())
}
