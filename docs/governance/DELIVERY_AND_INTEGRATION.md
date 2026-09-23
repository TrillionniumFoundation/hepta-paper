# Delivery and integration discipline

## 1. Current workflow

Use one active development stream against the maintained Rust integration
branch, `codex/full-rust-replacement-progress-20260916`. Original Node `main`
remains the incumbent product until the actual migration is complete. Source
integration does not activate production or retire Node.

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
