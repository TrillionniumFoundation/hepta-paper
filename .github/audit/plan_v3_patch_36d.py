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
    """            "requiredChecks": [
                "check-1", "check-2", "check-3", "check-4", "check-5",
                "check-6", "check-7", "check-8", "check-9", "check-10"
            ],
""",
    """            "requiredChecks": REQUIRED_GOVERNANCE_CHECK_FAMILIES,
""",
    "governance test fixture",
)

marker = """    #[test]
    fn canonical_compact_json_is_required() {
"""
tests = r"""    #[test]
    fn governance_requires_every_named_workflow_family() {
        let mut value = governance();
        value["requiredChecks"][0] = json!("unrelated-check");
        assert!(matches!(
            validate_payload(
                &encoded(value),
                &subject(QualificationPackageIdV1::ExtGovMain001),
                REVIEWER,
                REVIEWER_KEY,
            ),
            Err(QualificationPayloadError::SemanticInvalid)
        ));
    }

    #[test]
    fn governance_check_names_match_schema_first_character_rule() {
        assert!(valid_check_name("hepta-paper-ci"));
        assert!(valid_check_name("format lint test docs"));
        assert!(!valid_check_name("format, lint"));
        assert!(!valid_check_name("-leading-check"));
        assert!(!valid_check_name("_leading-check"));
        assert!(!valid_check_name(".leading-check"));
        assert!(!valid_check_name("/leading-check"));
        assert!(!valid_check_name(" leading-check"));

        let mut value = governance();
        value["requiredChecks"][0] = json!("-leading-check");
        assert!(matches!(
            validate_payload(
                &encoded(value),
                &subject(QualificationPackageIdV1::ExtGovMain001),
                REVIEWER,
                REVIEWER_KEY,
            ),
            Err(QualificationPayloadError::SemanticInvalid)
        ));
    }

""" + marker
payload = replace_once(payload, marker, tests, "governance regression tests")
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
