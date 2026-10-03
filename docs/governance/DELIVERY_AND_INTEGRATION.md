# Delivery and integration discipline

## 1. Current workflow

Use one active development stream against the maintained Rust integration
branch, `codex/full-rust-replacement-progress-20260916`. Original Node `main`
remains the incumbent product until the actual migration is complete. Source
integration does not activate production or retire Node.

The sole current continuation is PR **#142**, head branch
`codex/native-product-recovery-20260924`, targeting the integration branch above.
The live PR head/base and their exact trees, not an old audit digest or a same-named
local branch, identify the source being integrated. Do not create another product
closure PR to bypass this continuation.

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

Temporary branches target the current Rust integration head. After integration,
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
and merge with the expected head SHA. Use the existing signed GitHub integration
path. No independent human approval or staff-availability ceremony is required.
A verified final squash signature does not make unsigned incoming commits satisfy
a signature-required branch. Produce GitHub-verified commits through the existing
authenticated commit API or a registered signing identity before integration.
Only when an incoming source line is actually unsigned, preserve its original
commits in an explicit archive/bundle, reconstruct the same reviewed source tree
on the current integration parent, verify the signed tree byte-for-byte, and
update only the existing unprotected PR head with an expected-old-head guard.
This is a one-time signed delivery reconstruction, not a second implementation
branch. Do not force-push the protected integration branch or relax its rules.
The reconstructed SHA requires fresh exact-head and prospective-merge evidence.
For the already verified canonical lineage, continue with append-only signed
commits and expected-head CAS; the historical repair procedure is not an
instruction to rewrite #142 again. Verify the actual incoming commit range and
protection settings rather than assuming an old signature defect still exists.
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
