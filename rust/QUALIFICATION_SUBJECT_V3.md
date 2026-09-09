# Rust G0 Qualification Subject V3

The executable G0 identity is defined by:

- `docs/qualification/QUALIFICATION_SUBJECT_V3_RUNTIME.md`;
- `docs/qualification/schemas/qualification-subject-runtime-v3.schema.json`;
- `docs/rust/qualification/effective-status-runtime-v2.schema.json`;
- `docs/rust/tools/qualification_subject_v3.py`;
- `docs/rust/tools/derive_effective_status_v2.py`;
- `docs/rust/tools/verify_effective_status_v2_current.py`;
- `.github/workflows/rust-qualification-subject-v3.yml`;
- `.github/workflows/rust-qualification-subject-v3-revalidation.yml`.

This marker deliberately lives under `rust/` so every existing Rust source,
installed-principal, qualification, supply-chain, and exact-head producer is
exercised for the candidate. It grants no runtime, provider, writer, release,
submission, or external authority.
