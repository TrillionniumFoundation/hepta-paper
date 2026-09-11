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

The auxiliary PR may merge into `codex/rust-plan-v4-rc1-20260831` only after all
current workflow families execute successfully on its exact head and an
independent latest-head reviewer approves ordinary integration. That merge
invalidates PR #42's previous packet; PR #42 must then run its complete matrix
and receive a new exact-head decision.

`GAP-GOV-003`, `LEGACY-REPLAY-001`, `GAP-HOST-001`, `GAP-HOST-002`,
`GAP-KEY-001`, `GAP-CODEX-001`, and `GAP-REL-001` are not closed by this source
change.
