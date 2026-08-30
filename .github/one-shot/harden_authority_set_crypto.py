#!/usr/bin/env python3
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


package_path = Path("rust/crates/hepta-qualification-ingest/src/package_payload.rs")
package = package_path.read_text(encoding="utf-8")

package = replace_once(
    package,
    "use std::collections::BTreeSet;\n\n"
    "use serde_json::{Map, Value};\n"
    "use thiserror::Error;\n\n"
    "use crate::{QualificationPackageIdV1, QualificationSubjectV1};\n",
    "use std::{cmp::Ordering, collections::BTreeSet};\n\n"
    "use base64ct::{Base64UrlUnpadded, Encoding};\n"
    "use ed25519_dalek::Signature;\n"
    "use serde_json::{Map, Value};\n"
    "use sha2::{Digest, Sha256};\n"
    "use thiserror::Error;\n\n"
    "use crate::{\n"
    "    QualificationPackageIdV1, QualificationSubjectV1, QualificationTrustStoreV1,\n"
    "};\n",
    "package imports",
)

package = replace_once(
    package,
    "    /// A mandatory package-specific success invariant is absent.\n"
    "    #[error(\"external qualification payload semantic invariant is invalid\")]\n"
    "    SemanticInvalid,\n",
    "    /// A nested external authority signature is malformed, unknown, or invalid.\n"
    "    #[error(\"external qualification payload authority signature is invalid\")]\n"
    "    SignatureInvalid,\n"
    "    /// A mandatory package-specific success invariant is absent.\n"
    "    #[error(\"external qualification payload semantic invariant is invalid\")]\n"
    "    SemanticInvalid,\n",
    "payload error variants",
)

package = replace_once(
    package,
    "pub fn validate_external_package_payload_v1(\n",
    "pub fn validate_external_package_payload_v1(\n"
    "    bytes: &[u8],\n"
    "    subject: &QualificationSubjectV1,\n"
    "    envelope_authority_domain: &str,\n"
    "    envelope_signer_key_id: &str,\n"
    "    verifier_now_unix_ms: u64,\n"
    "    trust_generation: u64,\n"
    "    trust_store: &QualificationTrustStoreV1,\n"
    ") -> Result<(), QualificationPayloadError> {\n"
    "    validate_external_package_payload_shape_v1(\n"
    "        bytes,\n"
    "        subject,\n"
    "        envelope_authority_domain,\n"
    "        envelope_signer_key_id,\n"
    "    )?;\n"
    "    let value: Value =\n"
    "        serde_json::from_slice(bytes).map_err(|_| QualificationPayloadError::EncodingInvalid)?;\n"
    "    let root = object(&value)?;\n"
    "    current_time_window(root, verifier_now_unix_ms)?;\n"
    "    if subject.package_id == QualificationPackageIdV1::ExtAuthoritySet001 {\n"
    "        validate_authority_set_crypto_v1(\n"
    "            root,\n"
    "            subject,\n"
    "            envelope_authority_domain,\n"
    "            envelope_signer_key_id,\n"
    "            verifier_now_unix_ms,\n"
    "            trust_generation,\n"
    "            trust_store,\n"
    "        )?;\n"
    "    }\n"
    "    Ok(())\n"
    "}\n\n"
    "fn validate_external_package_payload_shape_v1(\n",
    "strict payload validator",
)

crypto_helpers = r'''
fn validate_authority_set_crypto_v1(
    root: &Map<String, Value>,
    subject: &QualificationSubjectV1,
    envelope_domain: &str,
    envelope_key: &str,
    verifier_now_unix_ms: u64,
    trust_generation: u64,
    trust_store: &QualificationTrustStoreV1,
) -> Result<(), QualificationPayloadError> {
    if trust_generation == 0 {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    let expected_subject_hash = authority_set_subject_hash_v1(subject)?;
    let subject_hash = sha256(root, "subjectHash")?;
    if subject_hash != expected_subject_hash {
        return Err(QualificationPayloadError::SubjectMismatch);
    }
    let (set_issued, _) = current_time_window(root, verifier_now_unix_ms)?;

    for receipt_value in array(root, "receipts")? {
        let receipt = object(receipt_value)?;
        if unsigned(receipt, "trustGeneration")? != trust_generation {
            return Err(QualificationPayloadError::SemanticInvalid);
        }
        let (receipt_issued, receipt_expires) =
            current_time_window(receipt, verifier_now_unix_ms)?;
        if compare_timestamps(&receipt_issued, &set_issued) == Ordering::Greater
            || compare_timestamps(&set_issued, &receipt_expires) != Ordering::Less
        {
            return Err(QualificationPayloadError::SemanticInvalid);
        }
        let authority_domain = identifier(receipt, "authorityDomainId")?;
        let signer_key = identifier(receipt, "signerKeyId")?;
        let message = authority_receipt_signing_bytes_v1(subject_hash, receipt_value)?;
        verify_authority_signature_v1(
            trust_store,
            authority_domain,
            signer_key,
            &message,
            signature_field(receipt, "signatureBase64")?,
        )?;
    }

    let payload = Value::Object(root.clone());
    let message = authority_set_signing_bytes_v1(subject_hash, &payload)?;
    verify_authority_signature_v1(
        trust_store,
        envelope_domain,
        envelope_key,
        &message,
        signature_field(root, "setSignatureBase64")?,
    )
}

/// Computes the exact candidate hash bound into `EXT-AUTHORITY-SET-001`.
pub fn authority_set_subject_hash_v1(
    subject: &QualificationSubjectV1,
) -> Result<String, QualificationPayloadError> {
    if subject.package_id != QualificationPackageIdV1::ExtAuthoritySet001
        || subject.repository != "TrillionniumFoundation/hepta-paper"
        || !valid_git_hash(&subject.commit)
        || !valid_git_hash(&subject.tree)
    {
        return Err(QualificationPayloadError::SubjectMismatch);
    }
    let message = domain_separated_message_v1(
        "HeptaExternalAuthoritySetSubjectV1",
        &[
            subject.repository.as_bytes(),
            subject.commit.as_bytes(),
            subject.tree.as_bytes(),
            subject.package_id.as_str().as_bytes(),
        ],
    )?;
    Ok(hash_bytes_v1(&message))
}

/// Returns the deterministic Ed25519 message for one inner authority receipt.
pub fn authority_receipt_signing_bytes_v1(
    subject_hash: &str,
    receipt: &Value,
) -> Result<Vec<u8>, QualificationPayloadError> {
    if !valid_sha256(subject_hash) {
        return Err(QualificationPayloadError::SchemaInvalid);
    }
    let canonical = canonical_without_signature_v1(receipt, "signatureBase64")?;
    domain_separated_message_v1(
        "HeptaExternalAuthorityReceiptV1",
        &[subject_hash.as_bytes(), &canonical],
    )
}

/// Returns the deterministic reviewer message for the complete authority set.
pub fn authority_set_signing_bytes_v1(
    subject_hash: &str,
    payload: &Value,
) -> Result<Vec<u8>, QualificationPayloadError> {
    if !valid_sha256(subject_hash) {
        return Err(QualificationPayloadError::SchemaInvalid);
    }
    let canonical = canonical_without_signature_v1(payload, "setSignatureBase64")?;
    domain_separated_message_v1(
        "HeptaExternalAuthoritySetReviewV1",
        &[subject_hash.as_bytes(), &canonical],
    )
}

fn canonical_without_signature_v1(
    value: &Value,
    signature_name: &str,
) -> Result<Vec<u8>, QualificationPayloadError> {
    let mut unsigned = object(value)?.clone();
    if !unsigned
        .remove(signature_name)
        .is_some_and(|signature| signature.is_string())
    {
        return Err(QualificationPayloadError::SchemaInvalid);
    }
    serde_json::to_vec(&Value::Object(unsigned))
        .map_err(|_| QualificationPayloadError::EncodingInvalid)
}

fn domain_separated_message_v1(
    domain: &str,
    fields: &[&[u8]],
) -> Result<Vec<u8>, QualificationPayloadError> {
    let mut output = Vec::new();
    append_length_prefixed_v1(&mut output, domain.as_bytes())?;
    for field in fields {
        append_length_prefixed_v1(&mut output, field)?;
    }
    Ok(output)
}

fn append_length_prefixed_v1(
    output: &mut Vec<u8>,
    value: &[u8],
) -> Result<(), QualificationPayloadError> {
    let length = u64::try_from(value.len()).map_err(|_| QualificationPayloadError::EncodingInvalid)?;
    output.extend_from_slice(&length.to_be_bytes());
    output.extend_from_slice(value);
    Ok(())
}

fn verify_authority_signature_v1(
    trust_store: &QualificationTrustStoreV1,
    authority_domain: &str,
    signer_key_id: &str,
    message: &[u8],
    signature_base64: &str,
) -> Result<(), QualificationPayloadError> {
    let key = trust_store
        .key(authority_domain, signer_key_id)
        .map_err(|_| QualificationPayloadError::AuthorityMismatch)?;
    let signature_bytes = Base64UrlUnpadded::decode_vec(signature_base64)
        .map_err(|_| QualificationPayloadError::SignatureInvalid)?;
    if Base64UrlUnpadded::encode_string(&signature_bytes) != signature_base64 {
        return Err(QualificationPayloadError::SignatureInvalid);
    }
    let signature = Signature::try_from(signature_bytes.as_slice())
        .map_err(|_| QualificationPayloadError::SignatureInvalid)?;
    key.verify_strict(message, &signature)
        .map_err(|_| QualificationPayloadError::SignatureInvalid)
}

#[derive(Clone, Debug)]
struct ParsedUtcTimestamp {
    epoch_seconds: i64,
    fraction: Vec<u8>,
}

fn parsed_time_window(
    root: &Map<String, Value>,
) -> Result<(ParsedUtcTimestamp, ParsedUtcTimestamp), QualificationPayloadError> {
    let issued = parse_utc_timestamp(string(root, "issuedAt")?)?;
    let expires = parse_utc_timestamp(string(root, "expiresAt")?)?;
    if compare_timestamps(&issued, &expires) != Ordering::Less {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    Ok((issued, expires))
}

fn current_time_window(
    root: &Map<String, Value>,
    verifier_now_unix_ms: u64,
) -> Result<(ParsedUtcTimestamp, ParsedUtcTimestamp), QualificationPayloadError> {
    if verifier_now_unix_ms == 0 {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    let (issued, expires) = parsed_time_window(root)?;
    let now_seconds = i64::try_from(verifier_now_unix_ms / 1_000)
        .map_err(|_| QualificationPayloadError::SemanticInvalid)?;
    let now_fraction = format!("{:03}", verifier_now_unix_ms % 1_000).into_bytes();
    let now = ParsedUtcTimestamp {
        epoch_seconds: now_seconds,
        fraction: now_fraction,
    };
    if compare_timestamps(&issued, &now) == Ordering::Greater
        || compare_timestamps(&now, &expires) != Ordering::Less
    {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    Ok((issued, expires))
}

fn compare_timestamps(left: &ParsedUtcTimestamp, right: &ParsedUtcTimestamp) -> Ordering {
    left.epoch_seconds
        .cmp(&right.epoch_seconds)
        .then_with(|| compare_decimal_fractions(&left.fraction, &right.fraction))
}

fn compare_decimal_fractions(left: &[u8], right: &[u8]) -> Ordering {
    let length = left.len().max(right.len());
    for index in 0..length {
        let left_digit = left.get(index).copied().unwrap_or(b'0');
        let right_digit = right.get(index).copied().unwrap_or(b'0');
        match left_digit.cmp(&right_digit) {
            Ordering::Equal => {}
            ordering => return ordering,
        }
    }
    Ordering::Equal
}

fn parse_utc_timestamp(value: &str) -> Result<ParsedUtcTimestamp, QualificationPayloadError> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return Err(QualificationPayloadError::SchemaInvalid);
    }
    let fraction = if bytes.len() == 20 {
        if bytes.get(19) != Some(&b'Z') {
            return Err(QualificationPayloadError::SchemaInvalid);
        }
        Vec::new()
    } else {
        if bytes.get(19) != Some(&b'.') || bytes.last() != Some(&b'Z') {
            return Err(QualificationPayloadError::SchemaInvalid);
        }
        let digits = bytes
            .get(20..bytes.len().saturating_sub(1))
            .ok_or(QualificationPayloadError::SchemaInvalid)?;
        if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
            return Err(QualificationPayloadError::SchemaInvalid);
        }
        digits.to_vec()
    };

    let year = parse_decimal_v1(bytes, 0, 4)?;
    let month = parse_decimal_v1(bytes, 5, 2)?;
    let day = parse_decimal_v1(bytes, 8, 2)?;
    let hour = parse_decimal_v1(bytes, 11, 2)?;
    let minute = parse_decimal_v1(bytes, 14, 2)?;
    let second = parse_decimal_v1(bytes, 17, 2)?;
    if year == 0
        || year > 9_999
        || !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month_v1(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(QualificationPayloadError::SchemaInvalid);
    }
    let days = days_from_civil_v1(i64::from(year), month, day);
    let epoch_seconds = days
        .saturating_mul(86_400)
        .saturating_add(i64::from(hour) * 3_600)
        .saturating_add(i64::from(minute) * 60)
        .saturating_add(i64::from(second));
    Ok(ParsedUtcTimestamp {
        epoch_seconds,
        fraction,
    })
}

fn parse_decimal_v1(
    bytes: &[u8],
    start: usize,
    length: usize,
) -> Result<u32, QualificationPayloadError> {
    let end = start
        .checked_add(length)
        .ok_or(QualificationPayloadError::SchemaInvalid)?;
    let digits = bytes
        .get(start..end)
        .ok_or(QualificationPayloadError::SchemaInvalid)?;
    let mut value = 0_u32;
    for digit in digits {
        if !digit.is_ascii_digit() {
            return Err(QualificationPayloadError::SchemaInvalid);
        }
        value = value * 10 + u32::from(*digit - b'0');
    }
    Ok(value)
}

fn days_in_month_v1(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year_v1(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year_v1(year: u32) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

fn days_from_civil_v1(year: i64, month: u32, day: u32) -> i64 {
    let adjusted_year = year - i64::from(month <= 2);
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let month_prime = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn hash_bytes_v1(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

'''
package = replace_once(
    package,
    "fn common_subject(\n",
    crypto_helpers + "fn common_subject(\n",
    "authority-set crypto helpers",
)

package = replace_once(
    package,
    "fn time_window(root: &Map<String, Value>) -> Result<(), QualificationPayloadError> {\n"
    "    let issued = timestamp(root, \"issuedAt\")?;\n"
    "    let expires = timestamp(root, \"expiresAt\")?;\n"
    "    if issued >= expires {\n"
    "        return Err(QualificationPayloadError::SemanticInvalid);\n"
    "    }\n"
    "    Ok(())\n"
    "}\n",
    "fn time_window(root: &Map<String, Value>) -> Result<(), QualificationPayloadError> {\n"
    "    parsed_time_window(root).map(|_| ())\n"
    "}\n",
    "semantic time window",
)

package = replace_once(
    package,
    "fn valid_identifier(value: &str) -> bool {\n"
    "    !value.is_empty()\n"
    "        && value.len() <= 128\n"
    "        && value\n"
    "            .bytes()\n"
    "            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))\n"
    "}\n",
    "fn valid_identifier(value: &str) -> bool {\n"
    "    let mut bytes = value.bytes();\n"
    "    matches!(bytes.next(), Some(first) if first.is_ascii_alphanumeric())\n"
    "        && value.len() <= 128\n"
    "        && bytes\n"
    "            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))\n"
    "}\n",
    "payload identifier schema",
)

package = replace_once(
    package,
    "fn valid_utc_timestamp(value: &str) -> bool {\n"
    "    let bytes = value.as_bytes();\n"
    "    (20..=40).contains(&bytes.len())\n"
    "        && bytes.get(4) == Some(&b'-')\n"
    "        && bytes.get(7) == Some(&b'-')\n"
    "        && bytes.get(10) == Some(&b'T')\n"
    "        && bytes.get(13) == Some(&b':')\n"
    "        && bytes.get(16) == Some(&b':')\n"
    "        && bytes.last() == Some(&b'Z')\n"
    "        && [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18]\n"
    "            .into_iter()\n"
    "            .all(|index| bytes.get(index).is_some_and(u8::is_ascii_digit))\n"
    "}\n",
    "fn valid_utc_timestamp(value: &str) -> bool {\n"
    "    parse_utc_timestamp(value).is_ok()\n"
    "}\n",
    "UTC timestamp schema",
)

# Existing shape-only tests are routed through the strict verifier with a stable test context.
test_marker = "#[cfg(test)]\nmod tests {\n"
prefix, tests = package.split(test_marker, 1)
tests = tests.replace("validate_external_package_payload_v1(", "validate_payload(")
package = prefix + test_marker + tests

package = replace_once(
    package,
    "mod tests {\n"
    "    use serde_json::json;\n\n"
    "    use super::*;\n",
    "mod tests {\n"
    "    use base64ct::{Base64UrlUnpadded, Encoding};\n"
    "    use ed25519_dalek::{Signer, SigningKey};\n"
    "    use serde_json::json;\n\n"
    "    use super::*;\n",
    "test imports",
)

package = replace_once(
    package,
    "    const REVIEWER_KEY: &str = \"reviewer-key\";\n\n"
    "    fn subject(package_id: QualificationPackageIdV1) -> QualificationSubjectV1 {\n",
    "    const REVIEWER_KEY: &str = \"reviewer-key\";\n"
    "    const NOW_UNIX_MS: u64 = 1_788_091_200_000;\n\n"
    "    fn reviewer_signing_key() -> SigningKey {\n"
    "        SigningKey::from_bytes(&[91_u8; 32])\n"
    "    }\n\n"
    "    fn reviewer_trust_store() -> QualificationTrustStoreV1 {\n"
    "        let signing = reviewer_signing_key();\n"
    "        QualificationTrustStoreV1::new(\n"
    "            [(\n"
    "                REVIEWER.to_owned(),\n"
    "                REVIEWER_KEY.to_owned(),\n"
    "                signing.verifying_key(),\n"
    "            )],\n"
    "            [\n"
    "                \"implementation-author\".to_owned(),\n"
    "                \"repository-admin\".to_owned(),\n"
    "                \"github-hosted-ci\".to_owned(),\n"
    "            ],\n"
    "        )\n"
    "        .expect(\"reviewer trust store\")\n"
    "    }\n\n"
    "    fn validate_payload(\n"
    "        bytes: &[u8],\n"
    "        subject: &QualificationSubjectV1,\n"
    "        envelope_domain: &str,\n"
    "        envelope_key: &str,\n"
    "    ) -> Result<(), QualificationPayloadError> {\n"
    "        let trust = reviewer_trust_store();\n"
    "        validate_external_package_payload_v1(\n"
    "            bytes,\n"
    "            subject,\n"
    "            envelope_domain,\n"
    "            envelope_key,\n"
    "            NOW_UNIX_MS,\n"
    "            1,\n"
    "            &trust,\n"
    "        )\n"
    "    }\n\n"
    "    fn subject(package_id: QualificationPackageIdV1) -> QualificationSubjectV1 {\n",
    "strict test context",
)

authority_test_start = package.index(
    "    #[test]\n    fn authority_set_requires_four_distinct_kinds_and_domains() {"
)
authority_test_end = package.index(
    "    #[test]\n    fn canonical_compact_json_is_required() {",
    authority_test_start,
)
new_authority_tests = r'''    fn signed_authority_set() -> (Value, QualificationTrustStoreV1) {
        let authority_subject = subject(QualificationPackageIdV1::ExtAuthoritySet001);
        let subject_hash = authority_set_subject_hash_v1(&authority_subject)
            .expect("authority subject hash");
        let authorities = [
            ("release_signer", "release-domain", "release-key", 31_u8),
            ("worm_custody", "worm-domain", "worm-key", 32_u8),
            ("backup_restore", "backup-domain", "backup-key", 33_u8),
            (
                "submission_dispatcher",
                "submission-domain",
                "submission-key",
                34_u8,
            ),
        ];
        let mut trust_entries = Vec::new();
        let mut receipts = Vec::new();
        for (index, (kind, domain, key_id, marker)) in authorities.into_iter().enumerate() {
            let signing = SigningKey::from_bytes(&[marker; 32]);
            let mut receipt = json!({
                "authorityKind": kind,
                "authorityDomainId": domain,
                "operationId": format!("operation-{}", index + 1),
                "requestHash": hash(100 + index as u8),
                "resultHash": hash(110 + index as u8),
                "outcome": "succeeded",
                "nonce": format!("nonce-{}", index + 1),
                "issuedAt": "2026-08-30T00:00:00Z",
                "expiresAt": "2026-09-30T00:00:00Z",
                "signerKeyId": key_id,
                "trustGeneration": 1,
                "externalActionMayHaveStarted": true,
                "signatureBase64": ""
            });
            let message = authority_receipt_signing_bytes_v1(&subject_hash, &receipt)
                .expect("receipt signing bytes");
            receipt["signatureBase64"] = json!(Base64UrlUnpadded::encode_string(
                &signing.sign(&message).to_bytes()
            ));
            trust_entries.push((domain.to_owned(), key_id.to_owned(), signing.verifying_key()));
            receipts.push(receipt);
        }

        let reviewer = reviewer_signing_key();
        trust_entries.push((
            REVIEWER.to_owned(),
            REVIEWER_KEY.to_owned(),
            reviewer.verifying_key(),
        ));
        let mut value = json!({
            "schemaVersion": 1,
            "packageId": "EXT-AUTHORITY-SET-001",
            "repository": "TrillionniumFoundation/hepta-paper",
            "commit": COMMIT,
            "tree": TREE,
            "subjectHash": subject_hash,
            "receipts": receipts,
            "authorityDomainsDistinct": true,
            "repositoryOrLocalFixtureAuthorityCount": 0,
            "reviewerAuthorityDomain": REVIEWER,
            "reviewerKeyId": REVIEWER_KEY,
            "decision": "approved",
            "issuedAt": "2026-08-30T01:00:00Z",
            "expiresAt": "2026-09-15T00:00:00Z",
            "setSignatureBase64": ""
        });
        let message = authority_set_signing_bytes_v1(
            value["subjectHash"].as_str().expect("subject hash"),
            &value,
        )
        .expect("set signing bytes");
        value["setSignatureBase64"] = json!(Base64UrlUnpadded::encode_string(
            &reviewer.sign(&message).to_bytes()
        ));
        let trust_store = QualificationTrustStoreV1::new(
            trust_entries,
            [
                "implementation-author".to_owned(),
                "repository-admin".to_owned(),
                "github-hosted-ci".to_owned(),
            ],
        )
        .expect("authority trust store");
        (value, trust_store)
    }

    #[test]
    fn authority_set_requires_four_valid_independent_signatures() {
        let (value, trust) = signed_authority_set();
        validate_external_package_payload_v1(
            &encoded(value),
            &subject(QualificationPackageIdV1::ExtAuthoritySet001),
            REVIEWER,
            REVIEWER_KEY,
            NOW_UNIX_MS,
            1,
            &trust,
        )
        .expect("cryptographically valid authority set");
    }

    #[test]
    fn authority_set_rejects_nested_or_set_signature_tampering() {
        let (mut nested, trust) = signed_authority_set();
        nested["receipts"][0]["resultHash"] = json!(hash(120));
        assert!(matches!(
            validate_external_package_payload_v1(
                &encoded(nested),
                &subject(QualificationPackageIdV1::ExtAuthoritySet001),
                REVIEWER,
                REVIEWER_KEY,
                NOW_UNIX_MS,
                1,
                &trust,
            ),
            Err(QualificationPayloadError::SignatureInvalid)
        ));

        let (mut set, trust) = signed_authority_set();
        set["setSignatureBase64"] = json!("A".repeat(86));
        assert!(matches!(
            validate_external_package_payload_v1(
                &encoded(set),
                &subject(QualificationPackageIdV1::ExtAuthoritySet001),
                REVIEWER,
                REVIEWER_KEY,
                NOW_UNIX_MS,
                1,
                &trust,
            ),
            Err(QualificationPayloadError::SignatureInvalid)
        ));
    }

    #[test]
    fn authority_set_rejects_subject_or_trust_generation_substitution() {
        let (mut subject_substitution, trust) = signed_authority_set();
        subject_substitution["subjectHash"] = json!(SHA);
        assert!(matches!(
            validate_external_package_payload_v1(
                &encoded(subject_substitution),
                &subject(QualificationPackageIdV1::ExtAuthoritySet001),
                REVIEWER,
                REVIEWER_KEY,
                NOW_UNIX_MS,
                1,
                &trust,
            ),
            Err(QualificationPayloadError::SubjectMismatch)
        ));

        let (generation_substitution, trust) = signed_authority_set();
        assert!(matches!(
            validate_external_package_payload_v1(
                &encoded(generation_substitution),
                &subject(QualificationPackageIdV1::ExtAuthoritySet001),
                REVIEWER,
                REVIEWER_KEY,
                NOW_UNIX_MS,
                2,
                &trust,
            ),
            Err(QualificationPayloadError::SemanticInvalid)
        ));
    }

    #[test]
    fn identifiers_and_utc_windows_match_the_schema_semantics() {
        for valid in ["a", "A0", "review:key-1", "authority_domain.v1"] {
            assert!(valid_identifier(valid), "{valid}");
        }
        for invalid in ["", "-leading", "_leading", ".leading", ":leading", "é"] {
            assert!(!valid_identifier(invalid), "{invalid}");
        }
        for invalid in [
            "2026-08-30T00:00:00abcZ",
            "2026-08-30T00:00:00.Z",
            "2026-13-30T00:00:00Z",
            "2026-02-30T00:00:00Z",
            "2026-08-30T24:00:00Z",
        ] {
            assert!(!valid_utc_timestamp(invalid), "{invalid}");
        }
        let valid_fraction = json!({
            "issuedAt": "2026-08-30T00:00:00Z",
            "expiresAt": "2026-08-30T00:00:00.1Z"
        });
        assert!(time_window(valid_fraction.as_object().expect("window")).is_ok());
        let reversed_fraction = json!({
            "issuedAt": "2026-08-30T00:00:00.10Z",
            "expiresAt": "2026-08-30T00:00:00.099Z"
        });
        assert!(matches!(
            time_window(reversed_fraction.as_object().expect("window")),
            Err(QualificationPayloadError::SemanticInvalid)
        ));
    }

'''
package = package[:authority_test_start] + new_authority_tests + package[authority_test_end:]
package_path.write_text(package, encoding="utf-8")

lib_path = Path("rust/crates/hepta-qualification-ingest/src/lib.rs")
lib = lib_path.read_text(encoding="utf-8")
lib = replace_once(
    lib,
    "pub use package_payload::{QualificationPayloadError, validate_external_package_payload_v1};\n",
    "pub use package_payload::{\n"
    "    QualificationPayloadError, authority_receipt_signing_bytes_v1,\n"
    "    authority_set_signing_bytes_v1, authority_set_subject_hash_v1,\n"
    "    validate_external_package_payload_v1,\n"
    "};\n",
    "package exports",
)
lib = replace_once(
    lib,
    "    fn key(&self, domain: &str, key_id: &str) -> Result<&VerifyingKey, QualificationIngestError> {\n",
    "    pub(crate) fn key(\n"
    "        &self,\n"
    "        domain: &str,\n"
    "        key_id: &str,\n"
    "    ) -> Result<&VerifyingKey, QualificationIngestError> {\n",
    "trust key visibility",
)
lib_path.write_text(lib, encoding="utf-8")

closure_path = Path(
    "rust/crates/hepta-qualification-ingest/src/bin/hepta-qualification-closure.rs"
)
closure = closure_path.read_text(encoding="utf-8")
closure = replace_once(
    closure,
    "        validate_external_package_payload_v1(\n"
    "            &payload_bytes,\n"
    "            &subject,\n"
    "            &record.authority_domain_id,\n"
    "            &record.signer_key_id,\n"
    "        )?;\n",
    "        validate_external_package_payload_v1(\n"
    "            &payload_bytes,\n"
    "            &subject,\n"
    "            &record.authority_domain_id,\n"
    "            &record.signer_key_id,\n"
    "            now_unix_ms,\n"
    "            trust_generation,\n"
    "            &trust_store,\n"
    "        )?;\n",
    "closure strict payload call",
)
closure_path.write_text(closure, encoding="utf-8")

schema_path = Path("docs/rust/qualification/external-authority-set-v1.schema.json")
schema = schema_path.read_text(encoding="utf-8")
schema = replace_once(
    schema,
    '    "signature": {\n'
    '      "type": "string",\n'
    '      "minLength": 40,\n'
    '      "maxLength": 512\n'
    '    }\n',
    '    "signature": {\n'
    '      "type": "string",\n'
    '      "pattern": "^[A-Za-z0-9_-]{86}$"\n'
    '    }\n',
    "authority signature schema",
)
schema_path.write_text(schema, encoding="utf-8")

protocol_path = Path("docs/rust/qualification/PLAN_V3_EXTERNAL_GAP_EXECUTION.md")
protocol = protocol_path.read_text(encoding="utf-8")
protocol = replace_once(
    protocol,
    "No fixture, repository key, local admin delegation or shared authority domain\n"
    "can satisfy this package.\n",
    "No fixture, repository key, local admin delegation or shared authority domain\n"
    "can satisfy this package. The repository verifier recomputes `subjectHash`,\n"
    "requires every inner receipt `trustGeneration` to equal the active qualification\n"
    "trust generation, checks every receipt and set deadline against verifier time,\n"
    "and cryptographically verifies all four inner signatures plus the independent\n"
    "set-review signature.\n\n"
    "Signing material is deterministic. Each field is encoded as an unsigned 64-bit\n"
    "big-endian byte length followed by its exact bytes. `subjectHash` is SHA-256 of\n"
    "the sequence `HeptaExternalAuthoritySetSubjectV1`, repository, commit, tree and\n"
    "package ID. An inner receipt signs the sequence\n"
    "`HeptaExternalAuthorityReceiptV1`, `subjectHash`, and canonical compact JSON of\n"
    "the receipt with `signatureBase64` removed. The set reviewer signs the sequence\n"
    "`HeptaExternalAuthoritySetReviewV1`, `subjectHash`, and canonical compact JSON\n"
    "of the complete set with `setSignatureBase64` removed. Signatures are canonical\n"
    "URL-safe unpadded Ed25519 encodings (86 ASCII characters).\n",
    "authority signing protocol",
)
protocol_path.write_text(protocol, encoding="utf-8")

closure_doc_path = Path("docs/rust/qualification/EXTERNAL_QUALIFICATION_CLOSURE.md")
closure_doc = closure_doc_path.read_text(encoding="utf-8")
if "HeptaExternalAuthorityReceiptV1" not in closure_doc:
    closure_doc += (
        "\n## Nested irreversible-authority verification\n\n"
        "`EXT-AUTHORITY-SET-001` is not accepted from field vocabulary alone. The\n"
        "verifier recomputes the exact-candidate subject hash, checks the active trust\n"
        "generation and verifier-time windows, verifies the four independently keyed\n"
        "`HeptaExternalAuthorityReceiptV1` signatures, and verifies the separate\n"
        "`HeptaExternalAuthoritySetReviewV1` signature before replay-ledger commit.\n"
    )
closure_doc_path.write_text(closure_doc, encoding="utf-8")

workflow_path = Path(".github/workflows/rust-plan-v3-external-contracts.yml")
workflow = workflow_path.read_text(encoding="utf-8")
workflow = replace_once(
    workflow,
    "              'reviewer_matches(',\n"
    "          ]:\n",
    "              'reviewer_matches(',\n"
    "              'authority_set_subject_hash_v1',\n"
    "              'HeptaExternalAuthorityReceiptV1',\n"
    "              'HeptaExternalAuthoritySetReviewV1',\n"
    "              'verify_authority_signature_v1',\n"
    "              'current_time_window(',\n"
    "              'SignatureInvalid',\n"
    "          ]:\n",
    "external-contract source assertions",
)
workflow = replace_once(
    workflow,
    "          request = schemas['external-qualification-closure-request-v1.schema.json']\n",
    "          authority_set_schema = schemas['external-authority-set-v1.schema.json']\n"
    "          assert authority_set_schema['$defs']['signature'] == {\n"
    "              'type': 'string',\n"
    "              'pattern': '^[A-Za-z0-9_-]{86}$',\n"
    "          }\n\n"
    "          request = schemas['external-qualification-closure-request-v1.schema.json']\n",
    "authority signature contract assertion",
)
workflow_path.write_text(workflow, encoding="utf-8")

print("nested authority cryptographic hardening staged")
