# Delivery and integration discipline

## 1. Current workflow

Continue on PR **#149**, head branch `codex/full-rust-production`, targeting
`main`. The earlier #142 integration stream is historical input to this
candidate. `main` currently retains the original Node product; merging source
does not itself stop an installed Node service or migrate its data.

The candidate and base are recorded in `docs/rust/current-status.v1.json` under
`qualificationCandidate`. The live PR head/base and their exact trees, not an
old audit digest or a same-named local branch, identify the source being
integrated. Keep directly related implementation on this continuation.

The [ownership policy](OWNERSHIP_AND_REVIEW.md) permits the single maintainer
to integrate their own work without independent, Code Owner or last-push
approval. Required tests are retained; review headcount is not a merge gate.

## 2. Change scope

Keep implementation, directly affected contracts, tests and useful operational
documentation together. Use the existing command map and PR to identify actual
behavior, compatibility, failure/recovery handling and remaining gaps. Do not
require a second ledger, a ceremonial RFC or changes to every module document
for a local implementation change.

Changes to public protocols or persistent state carry their real consumer and
migration tests. Changes to credentials, external effects or writer ownership
carry negative-authority, final-use and crash/reconciliation tests. These are
behavioral obligations, not cross-team approval assignments.

## 3. Branch discipline

Temporary branches target the current candidate head. After integration,
start subsequent work from the integrated tree, especially after a squash merge.
Do not merge older whole trees just to make commit counts match. Compare residual
behavior and files, record absorb/supersede/retain decisions in the existing
[consolidation record](../migration/BRANCH_CONSOLIDATION.md), and preserve useful
history without treating every retained ref as another product candidate.

## 4. CI and integration

Run applicable module, consumer, integration and fault tests. Unknown impact
requires investigation or broader validation, not silent omission. The required
source workflows must report on the exact candidate; previous green heads do not
qualify changed code. A static source-binding check is not a test execution.

Before integration, re-read the live base/head and check all required contexts,
inspect applicable exact-head/prospective-merge evidence, resolve real findings,
and merge with the expected head SHA through the authenticated GitHub connection.
No independent human approval, staff-availability check, extra signing identity
or historical commit reconstruction is a project prerequisite for this private
single-maintainer software. Preserve the existing lineage and append the tested
changes. GitHub-enforced repository rules are observed as live server state;
an old document is not evidence that a rule is still enabled. If a required
server rule rejects an operation, report that concrete rejection. Do not rewrite
history merely to satisfy a historical policy description, overwrite another
writer's branch update, or replace failed tests with a status assertion.
After integration, source artifacts keep their original subjects; the product
head obtains its own applicable validation.

## 5. Recovery and documentation

Rollback follows actual effects: source revert, configuration rollback, prepared
work drain, forward/reverse schema migration, or reconciliation of an external
operation. Never restore an old backup over newer commits, enable two writers,
or blindly repeat an operation whose outcome is unknown.

Document executable setup, inputs, failure categories and recovery steps where
they change. Common policy belongs in the canonical policy, not repeated across
32 runbooks. A documentation-only improvement may travel in the ordinary PR;
it does not require its own independent approval project.

## Canonical prospective source identity

`docs/tools/prepare-prospective-merge.mjs` is the single prospective-merge recipe
for repository-source, functional-source and product-target validation. It
consumes exact base and target commit IDs, requires HEAD at the target, uses the
actual merge tree, fixes both parents and normalizes identity/time from the
target commit. It writes only local Git objects: no ref, index or working-file
mutation, no signing-key access and no merge approval. Conflicts or absent
commits fail without a subject. Same-head push events have only one subject;
they do not fabricate a second merge parent. Branch delivery still requires
valid signed commits; an unsigned synthetic test object is never pushed as a
release or integration change.

All three PR lanes therefore validate the same prospective commit/tree, while
each retains its independent commands and receipts. Exact-head remains a separate
subject. Reusable build caches do not transfer execution evidence between heads.
Run the real Git fixture and caller checks with:

```sh
node --test paper-core/tests/prospective-merge-subject.test.mjs
node docs/tools/prepare-prospective-merge.mjs --base BASE_COMMIT --target HEAD_COMMIT
```

The canonical required-check manifest includes all six exact/prospective
repository-source, functional-source and product-target checks. Producer records
bind actual workflow IDs, paths and source digests; the metadata-only revalidator
observes all three workflows. Protected-branch settings must preserve the existing
checks and add these app-bound contexts, not accept skipped or older-head results.
The current number of checks is derived from the manifest and its exact producer
coverage rather than duplicated as a magic count in program-truth validation.
