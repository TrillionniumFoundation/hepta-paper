use super::{
    BuildEntryV1, MAX_TOTAL_TEXT_BYTES, NativeBusinessError, NativeBusinessOutputV1,
    hash_bytes, validate_body_text, validate_inline_text,
};
use serde::Serialize;
use serde_json::json;

const MAX_PACKAGE_ENTRIES: usize = 4096;

pub(super) fn build_package(
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
    if entries
        .windows(2)
        .any(|window| window[0].path == window[1].path)
    {
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
