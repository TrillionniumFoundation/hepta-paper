from __future__ import annotations

import json
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new)


payload_path = Path("rust/crates/hepta-qualification-ingest/src/package_payload.rs")
payload = payload_path.read_text(encoding="utf-8")

payload = replace_once(
    payload,
    """const REQUIRED_GOVERNANCE_DENIALS: [&str; 7] = [
    "direct_push",
    "stale_approval",
    "missing_check",
    "failed_check",
    "force_push",
    "branch_deletion",
    "administrator_bypass",
];
const REQUIRED_HOST_CGROUP_DRILLS: [&str; 9] = [
""",
    """const REQUIRED_GOVERNANCE_DENIALS: [&str; 7] = [
    "direct_push",
    "stale_approval",
    "missing_check",
    "failed_check",
    "force_push",
    "branch_deletion",
    "administrator_bypass",
];
const REQUIRED_GOVERNANCE_CHECK_FAMILIES: [&str; 10] = [
    "hepta-paper-ci",
    "exact-head-source-validation",
    "rust-foundation",
    "workflow-lint",
    "rust-program-truth",
    "rust-plan-v3-external-contracts",
    "rust-supply-chain",
    "rust-qualification-artifacts",
    "rust-broker-installed-qualification",
    "rust-broker-installed-qualification-v2",
];
const REQUIRED_HOST_CGROUP_DRILLS: [&str; 9] = [
""",
    "governance check-family constants",
)

payload = replace_once(
    payload,
    """    let checks = array(root, "requiredChecks")?;
    if checks.len() < 10 {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    unique_strings(checks, valid_check_name)?;
""",
    """    let checks = array(root, "requiredChecks")?;
    if checks.len() < REQUIRED_GOVERNANCE_CHECK_FAMILIES.len() {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    unique_strings(checks, valid_check_name)?;
    if REQUIRED_GOVERNANCE_CHECK_FAMILIES
        .iter()
        .any(|required| !checks.iter().any(|value| value.as_str() == Some(required)))
    {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
""",
    "governance required-check semantics",
)

payload = replace_once(
    payload,
    """fn time_window(root: &Map<String, Value>) -> Result<(), QualificationPayloadError> {
    let issued = timestamp(root, "issuedAt")?;
    let expires = timestamp(root, "expiresAt")?;
    if issued >= expires {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    Ok(())
}
""",
    """fn time_window(root: &Map<String, Value>) -> Result<(), QualificationPayloadError> {
    let issued = timestamp(root, "issuedAt")?;
    let expires = timestamp(root, "expiresAt")?;
    if !timestamp_is_strictly_before(issued, expires) {
        return Err(QualificationPayloadError::SemanticInvalid);
    }
    Ok(())
}

fn timestamp_is_strictly_before(left: &str, right: &str) -> bool {
    let left_bytes = left.as_bytes();
    let right_bytes = right.as_bytes();
    match left_bytes[..19].cmp(&right_bytes[..19]) {
        std::cmp::Ordering::Less => return true,
        std::cmp::Ordering::Greater => return false,
        std::cmp::Ordering::Equal => {}
    }

    let left_fraction = timestamp_fraction(left_bytes);
    let right_fraction = timestamp_fraction(right_bytes);
    let width = left_fraction.len().max(right_fraction.len());
    for index in 0..width {
        let left_digit = left_fraction.get(index).copied().unwrap_or(b'0');
        let right_digit = right_fraction.get(index).copied().unwrap_or(b'0');
        match left_digit.cmp(&right_digit) {
            std::cmp::Ordering::Less => return true,
            std::cmp::Ordering::Greater => return false,
            std::cmp::Ordering::Equal => {}
        }
    }
    false
}

fn timestamp_fraction(bytes: &[u8]) -> &[u8] {
    if bytes.get(19) == Some(&b'.') {
        &bytes[20..bytes.len() - 1]
    } else {
        &[]
    }
}
""",
    "fraction-aware timestamp ordering",
)

payload = replace_once(
    payload,
    """fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}
""",
    """fn valid_identifier(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(first) if first.is_ascii_alphanumeric())
        && value.len() <= 128
        && bytes.all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
        })
}
""",
    "schema-aligned identifier validator",
)

payload = replace_once(
    payload,
    """fn valid_check_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b" ._()/-".contains(&byte))
}
""",
    """fn valid_check_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(first) if first.is_ascii_alphanumeric())
        && value.len() <= 256
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || b" ._()/-".contains(&byte))
}
""",
    "schema-aligned check-name validator",
)

payload = replace_once(
    payload,
    """fn valid_utc_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    (20..=40).contains(&bytes.len())
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':')
        && bytes.last() == Some(&b'Z')
        && [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18]
            .into_iter()
            .all(|index| bytes.get(index).is_some_and(u8::is_ascii_digit))
}
""",
    """fn valid_utc_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !(20..=40).contains(&bytes.len())
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
        || bytes.last() != Some(&b'Z')
        || ![0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18]
            .into_iter()
            .all(|index| bytes.get(index).is_some_and(u8::is_ascii_digit))
    {
        return false;
    }

    match bytes.get(19) {
        Some(b'Z') => bytes.len() == 20,
        Some(b'.') => {
            bytes.len() > 21
                && bytes[20..bytes.len() - 1]
                    .iter()
                    .all(u8::is_ascii_digit)
        }
        _ => false,
    }
}
""",
    "strict UTC timestamp syntax",
)

payload = replace_once(
    payload,
    """            "requiredChecks": [
                "check-1", "check-2", "check-3", "check-4", "check-5",
                "check-6", "check-7", "check-8", "check-9", "check-10"
            ],
""",
    """            "requiredChecks": REQUIRED_GOVERNANCE_CHECK_FAMILIES,
""",
    "governance test fixture",
)

test_marker = """    #[test]
    fn canonical_compact_json_is_required() {
"""
new_tests = r"""    #[test]
    fn schema_aligned_identifiers_checks_and_timestamps_are_enforced() {
        for value in ["a", "A0", "review:key-1", "authority_domain.v1"] {
            assert!(
                valid_identifier(value),
                "valid identifier rejected: {value}"
            );
        }
        for value in ["", "-leading", "_leading", ".leading", ":leading", "é"] {
            assert!(
                !valid_identifier(value),
                "invalid identifier accepted: {value}"
            );
        }
        assert!(!valid_identifier(&"a".repeat(129)));

        assert!(valid_check_name("hepta-paper-ci"));
        assert!(valid_check_name("format lint test docs"));
        assert!(!valid_check_name("format, lint"));
        assert!(!valid_check_name("-leading-check"));
        assert!(!valid_check_name(" check"));

        assert!(valid_utc_timestamp("2026-08-30T00:00:00Z"));
        assert!(valid_utc_timestamp("2026-08-30T00:00:00.123456789Z"));
        assert!(!valid_utc_timestamp("2026-08-30T00:00:00.Z"));
        assert!(!valid_utc_timestamp("2026-08-30T00:00:00x123Z"));
        assert!(!valid_utc_timestamp("2026-08-30T00:00:00.12xZ"));
    }

    #[test]
    fn governance_requires_every_named_workflow_family() {
        let mut value = governance();
        value["requiredChecks"][0] = json!("unrelated-check");
        assert!(matches!(
            validate_external_package_payload_v1(
                &encoded(value),
                &subject(QualificationPackageIdV1::ExtGovMain001),
                REVIEWER,
                REVIEWER_KEY,
            ),
            Err(QualificationPayloadError::SemanticInvalid)
        ));
    }

    #[test]
    fn payload_authority_identifiers_reject_leading_punctuation() {
        let mut value = governance();
        value["reviewerAuthorityDomain"] = json!("-reviewer");
        assert!(matches!(
            validate_external_package_payload_v1(
                &encoded(value),
                &subject(QualificationPackageIdV1::ExtGovMain001),
                REVIEWER,
                REVIEWER_KEY,
            ),
            Err(QualificationPayloadError::SchemaInvalid)
        ));
    }

    #[test]
    fn fractional_timestamp_order_is_numeric_and_strict() {
        let mut reversed = governance();
        reversed["issuedAt"] = json!("2026-08-30T00:00:00.9Z");
        reversed["expiresAt"] = json!("2026-08-30T00:00:00.10Z");
        assert!(matches!(
            time_window(object(&reversed).expect("governance object")),
            Err(QualificationPayloadError::SemanticInvalid)
        ));

        let mut equal = governance();
        equal["issuedAt"] = json!("2026-08-30T00:00:00.1Z");
        equal["expiresAt"] = json!("2026-08-30T00:00:00.100Z");
        assert!(matches!(
            time_window(object(&equal).expect("governance object")),
            Err(QualificationPayloadError::SemanticInvalid)
        ));

        let mut ordered = governance();
        ordered["issuedAt"] = json!("2026-08-30T00:00:00Z");
        ordered["expiresAt"] = json!("2026-08-30T00:00:00.0001Z");
        assert!(time_window(object(&ordered).expect("governance object")).is_ok());
    }

""" + test_marker
payload = replace_once(payload, test_marker, new_tests, "package payload regression tests")
payload_path.write_text(payload, encoding="utf-8")

broker_path = Path("rust/crates/hepta-codex-broker/tests/durable_process_journal.rs")
broker = broker_path.read_text(encoding="utf-8")
broker = replace_once(
    broker,
    """        let target_dir = std::env::var_os("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target"));
        let built = if target_dir.is_absolute() {
            target_dir.join("debug/hepta-codex-preexec-gate")
        } else {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join(target_dir)
                .join("debug/hepta-codex-preexec-gate")
        };
""",
    """        let current_test = std::env::current_exe().expect("current test executable");
        let deps_dir = current_test.parent().expect("test executable parent");
        let profile_dir = deps_dir.parent().expect("target profile directory");
        let built = profile_dir.join("hepta-codex-preexec-gate");
""",
    "profile-aware durable gate lookup",
)
broker_path.write_text(broker, encoding="utf-8")

foundation_path = Path(".github/workflows/rust-foundation.yml")
foundation = foundation_path.read_text(encoding="utf-8")
foundation = replace_once(
    foundation,
    r"""      - name: Build documentation
        env:
          RUSTDOCFLAGS: -D warnings
""",
    r"""      - name: Run release-profile durable broker regression
        env:
          RUSTFLAGS: -Dunsafe-code -C overflow-checks=yes
        shell: bash
        run: |
          set -euo pipefail
          cargo build \
            --manifest-path rust/Cargo.toml \
            -p hepta-codex-runtime \
            --bin hepta-codex-preexec-gate \
            --release \
            --locked
          cargo test \
            --manifest-path rust/Cargo.toml \
            -p hepta-codex-broker \
            --test durable_process_journal \
            --release \
            --locked \
            -- \
            --test-threads=1 \
            2>&1 | tee /tmp/hepta-rust-validation/release-durable-process-journal.log

      - name: Build documentation
        env:
          RUSTDOCFLAGS: -D warnings
""",
    "permanent release-profile regression gate",
)
foundation_path.write_text(foundation, encoding="utf-8")

schema_path = Path(
    "docs/rust/qualification/protected-main-ruleset-evidence-v1.schema.json"
)
schema = json.loads(schema_path.read_text(encoding="utf-8"))
required_families = [
    "hepta-paper-ci",
    "exact-head-source-validation",
    "rust-foundation",
    "workflow-lint",
    "rust-program-truth",
    "rust-plan-v3-external-contracts",
    "rust-supply-chain",
    "rust-qualification-artifacts",
    "rust-broker-installed-qualification",
    "rust-broker-installed-qualification-v2",
]
checks = schema["properties"]["requiredChecks"]
checks["allOf"] = [
    {
        "contains": {"const": family},
        "minContains": 1,
        "maxContains": 1,
    }
    for family in required_families
]
schema_path.write_text(
    json.dumps(schema, indent=2, ensure_ascii=True) + "\n",
    encoding="utf-8",
)
