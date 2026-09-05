#!/usr/bin/env bash
set -euo pipefail

: "${EVIDENCE_ROOT:?EVIDENCE_ROOT is required}"
: "${EXPECTED_HEAD_SHA:?EXPECTED_HEAD_SHA is required}"
: "${HEAD_TREE:?HEAD_TREE is required}"
: "${EXPECTED_PR_NUMBER:?EXPECTED_PR_NUMBER is required}"
: "${EXPECTED_HEAD_BRANCH:?EXPECTED_HEAD_BRANCH is required}"
: "${EXPECTED_BASE_REF:?EXPECTED_BASE_REF is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_API_URL:?GITHUB_API_URL is required}"
: "${GITHUB_WORKFLOW:?GITHUB_WORKFLOW is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"

install -d -m 0700 \
  "$EVIDENCE_ROOT/raw/required" \
  "$EVIDENCE_ROOT/raw/subject" \
  "$EVIDENCE_ROOT/raw/current-required" \
  "$EVIDENCE_ROOT/raw/current-subject"

PYTHONPYCACHEPREFIX="${RUNNER_TEMP:-/tmp}/hepta-v3-pycache" python3 -m py_compile \
  docs/rust/tools/collect-required-checks.py \
  docs/rust/tools/derive-effective-status.py \
  docs/rust/tools/verify-effective-status-current.py \
  docs/rust/tools/qualification_subject_v3.py \
  docs/rust/tools/qualification_subject_integrity.py \
  docs/rust/tools/derive_effective_status_v2.py \
  docs/rust/tools/verify_effective_status_v2_current.py \
  docs/rust/tools/test-plan-v4-qualification.py \
  docs/rust/tools/test_qualification_subject_v3.py

bash -n docs/rust/tools/run-qualification-subject-v3.sh
python3 docs/rust/tools/validate-program-truth.py \
  | tee "$EVIDENCE_ROOT/program-truth.json"
python3 docs/rust/tools/test-plan-v4-qualification.py \
  2>&1 | tee "$EVIDENCE_ROOT/plan-v4-tests.log"
python3 docs/rust/tools/test_qualification_subject_v3.py \
  2>&1 | tee "$EVIDENCE_ROOT/subject-v3-tests.log"

python3 docs/rust/tools/collect-required-checks.py \
  --repository "$GITHUB_REPOSITORY" \
  --commit "$EXPECTED_HEAD_SHA" \
  --tree "$HEAD_TREE" \
  --head-branch "$EXPECTED_HEAD_BRANCH" \
  --base-ref "$EXPECTED_BASE_REF" \
  --pull-request "$EXPECTED_PR_NUMBER" \
  --token "$GH_TOKEN" \
  --api-url "$GITHUB_API_URL" \
  --raw-output-dir "$EVIDENCE_ROOT/raw/required" \
  --output "$EVIDENCE_ROOT/check-evidence.v2.json"

python3 docs/rust/tools/derive-effective-status.py \
  --check-runs "$EVIDENCE_ROOT/check-evidence.v2.json" \
  --repository "$GITHUB_REPOSITORY" \
  --commit "$EXPECTED_HEAD_SHA" \
  --tree "$HEAD_TREE" \
  --workflow "$GITHUB_WORKFLOW" \
  --run-id "$GITHUB_RUN_ID" \
  --run-attempt "$GITHUB_RUN_ATTEMPT" \
  --output "$EVIDENCE_ROOT/effective-status.v1.json" \
  | tee "$EVIDENCE_ROOT/legacy-derivation.json"
python3 docs/rust/tools/strict_json_schema.py \
  --schema docs/rust/qualification/effective-status-v1.schema.json \
  --instance "$EVIDENCE_ROOT/effective-status.v1.json" \
  | tee "$EVIDENCE_ROOT/legacy-schema-validation.json"

python3 docs/rust/tools/qualification_subject_v3.py \
  --repository "$GITHUB_REPOSITORY" \
  --pull-request "$EXPECTED_PR_NUMBER" \
  --head-commit "$EXPECTED_HEAD_SHA" \
  --head-tree "$HEAD_TREE" \
  --head-branch "$EXPECTED_HEAD_BRANCH" \
  --base-ref "$EXPECTED_BASE_REF" \
  --token "$GH_TOKEN" \
  --api-url "$GITHUB_API_URL" \
  --check-evidence "$EVIDENCE_ROOT/check-evidence.v2.json" \
  --raw-output-dir "$EVIDENCE_ROOT/raw/subject" \
  --output "$EVIDENCE_ROOT/qualification-subject.v3.json" \
  | tee "$EVIDENCE_ROOT/subject-collection.json"
python3 docs/rust/tools/strict_json_schema.py \
  --schema docs/qualification/schemas/qualification-subject-runtime-v3.schema.json \
  --instance "$EVIDENCE_ROOT/qualification-subject.v3.json" \
  | tee "$EVIDENCE_ROOT/subject-schema-validation.json"

python3 docs/rust/tools/derive_effective_status_v2.py \
  --legacy-effective "$EVIDENCE_ROOT/effective-status.v1.json" \
  --qualification-subject "$EVIDENCE_ROOT/qualification-subject.v3.json" \
  --output "$EVIDENCE_ROOT/effective-status.v2.json" \
  | tee "$EVIDENCE_ROOT/v2-derivation.json"
python3 docs/rust/tools/strict_json_schema.py \
  --schema docs/rust/qualification/effective-status-runtime-v2.schema.json \
  --instance "$EVIDENCE_ROOT/effective-status.v2.json" \
  | tee "$EVIDENCE_ROOT/v2-schema-validation.json"

python3 docs/rust/tools/collect-required-checks.py \
  --repository "$GITHUB_REPOSITORY" \
  --commit "$EXPECTED_HEAD_SHA" \
  --tree "$HEAD_TREE" \
  --head-branch "$EXPECTED_HEAD_BRANCH" \
  --base-ref "$EXPECTED_BASE_REF" \
  --pull-request "$EXPECTED_PR_NUMBER" \
  --token "$GH_TOKEN" \
  --api-url "$GITHUB_API_URL" \
  --raw-output-dir "$EVIDENCE_ROOT/raw/current-required" \
  --output "$EVIDENCE_ROOT/current-check-evidence.v2.json"
python3 docs/rust/tools/qualification_subject_v3.py \
  --repository "$GITHUB_REPOSITORY" \
  --pull-request "$EXPECTED_PR_NUMBER" \
  --head-commit "$EXPECTED_HEAD_SHA" \
  --head-tree "$HEAD_TREE" \
  --head-branch "$EXPECTED_HEAD_BRANCH" \
  --base-ref "$EXPECTED_BASE_REF" \
  --token "$GH_TOKEN" \
  --api-url "$GITHUB_API_URL" \
  --check-evidence "$EVIDENCE_ROOT/current-check-evidence.v2.json" \
  --raw-output-dir "$EVIDENCE_ROOT/raw/current-subject" \
  --output "$EVIDENCE_ROOT/current-qualification-subject.v3.json"
python3 docs/rust/tools/strict_json_schema.py \
  --schema docs/qualification/schemas/qualification-subject-runtime-v3.schema.json \
  --instance "$EVIDENCE_ROOT/current-qualification-subject.v3.json" \
  | tee "$EVIDENCE_ROOT/current-subject-schema-validation.json"
python3 docs/rust/tools/verify_effective_status_v2_current.py \
  --artifact "$EVIDENCE_ROOT/effective-status.v2.json" \
  --current-subject "$EVIDENCE_ROOT/current-qualification-subject.v3.json" \
  --current-check-runs "$EVIDENCE_ROOT/current-check-evidence.v2.json" \
  | tee "$EVIDENCE_ROOT/live-revalidation.json"

sha256sum \
  "$EVIDENCE_ROOT/check-evidence.v2.json" \
  "$EVIDENCE_ROOT/effective-status.v1.json" \
  "$EVIDENCE_ROOT/qualification-subject.v3.json" \
  "$EVIDENCE_ROOT/effective-status.v2.json" \
  > "$EVIDENCE_ROOT/canonical-artifacts.sha256"
