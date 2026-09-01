# ADR-0013: bind exact base/head/merge and complete run history in qualification

Status: **accepted as the current target decision; implementation and qualification remain gated**

## Context

The current RC review identified two qualification identity defects: movement
of the PR base or synthetic merge can escape a head-only subject, and a rerun of
an older workflow run can be ignored after a newer run ID exists.

## Decision

Qualification Subject V3 binds repository, PR, exact base/head commits and
trees, tested synthetic merge commit/tree, producer definitions, complete
eligible run/attempt history, selected runs, jobs, steps, artifacts, review, and
policy snapshots. Both the complete eligible-run-set hash and selected-run-set
hash participate in the snapshot identity.

Any mutation of an eligible old or new run, base, merge, review, artifact, or
definition invalidates the retained artifact until fresh derivation succeeds.

## Consequences

Evidence is more expensive to collect but accurately represents the object being
reviewed and merged. Old green artifacts cannot remain apparently current after
base movement or noncanonical reruns.

## Adoption gates

The schemas, collector, derivation, live revalidation, workflows, adversarial
tests, producer digests, exact-head matrix, and independent latest-head review
must change as one qualification transaction.
