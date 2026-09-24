# G0 Qualification Subject V3 closure acceptance

This change closes only the two repository-local G0 identity findings on PR #42.

## Required source evidence

- exact base repository ID/name/ref/commit/tree;
- exact head repository ID/name/ref/commit/tree;
- tested prospective merge commit/tree and ordered base/head parents;
- all producer workflow definitions bound by ID/path/Git blob/SHA-256;
- every eligible run and every visible attempt, including non-selected history;
- complete job, step, check-suite, and workflow-run artifact sets;
- canonical producer runs terminal, successful, and non-empty;
- rejection when a non-canonical run mutates at or after the canonical update;
- byte-stable immediate recollection and V2 artifact revalidation;
- regeneration after every producer workflow completion;
- capability-specific V1 effective status retained beneath the V3 subject;
- every production, provider, writer, release, submission, and external-authority
  flag fixed to false.

## Integration boundary

Use the retained Rust integration branch
`codex/full-rust-replacement-progress-20260916`. An ordinary PR may integrate
once the exact-current workflow families and applicable prospective-merge tests
succeed, using an expected-head guard. The single maintainer may make that
decision; no independent latest-push review or second-person signature is required.
Changed source/base/producer identity invalidates earlier evidence as before.

`GAP-GOV-003` and the human approval part `QUAL-005` are retired by owner policy,
not accepted external evidence. `LEGACY-REPLAY-001`, `GAP-HOST-001`,
`GAP-HOST-002`, `GAP-KEY-001`, `GAP-CODEX-001` and `GAP-REL-001` still describe
actual runtime, custody, historical or external-effect facts absent from source.
