# Exact qualification subject V3

## 1. Problem closed by V3

A source qualification is unsound if it binds only the PR head while ignoring
the exact base/merge subject, or if it selects only one newest run and ignores a
later rerun of an older eligible workflow run.

V3 makes the complete source, merge, producer, run-history, artifact, and review
subject explicit.

## 2. Required source identity

```text
repository.id and fullName
pullRequest.number
base.repository.id/fullName/ref/commit/tree
head.repository.id/fullName/ref/commit/tree
testedMerge.commit/tree
```

A base movement with unchanged head changes the subject. A new synthetic merge
changes the subject. Both invalidate old producer runs and effective artifacts.

## 3. Producer identity

For every required context:

```text
workflowId
workflowPath
candidate-tree Git blob SHA
workflow SHA-256
event and PR number
runId/runAttempt
createdAt/updatedAt/status/conclusion
checkSuiteId
jobId/name/checkRunId
non-empty execution step identities/status/conclusion
```

Same-name results from another workflow/app/path/definition are rejected.

## 4. Complete eligible run history

The evidence records every eligible run/attempt visible under the subject, not
only the selected canonical success:

```text
completeEligibleRuns[]
eligibleRunSetSha256
producerHistoryWatermark
selectedRuns[]
selectedRunSetSha256
```

Any change to an old run attempt, updated timestamp, job set, step set, or
conclusion changes the eligible-run-set hash and invalidates the old artifact.

A policy may designate one canonical selected run per producer, but it cannot
ignore later mutations to non-selected eligible runs.

## 5. Artifact and review identity

```text
staticTruthSha256
requiredChecksSha256
producerManifestSha256
capabilityEvidenceSha256
schema/tool/workflow definition set hash
source snapshot artifact ID/digest
check evidence artifact ID/digest
effective artifact ID/digest
review snapshot: latest-push decisions and unresolved threads
branch protection/policy snapshot where required
```

## 6. Snapshot identity

The canonical snapshot hash covers all source, producer, complete run-history,
selected run, artifact, and review fields. Order is canonical and duplicates are
rejected.

## 7. Live revalidation

Revalidation fetches the live PR/base/head/merge, workflow definitions, complete
eligible run history, artifacts, and review state. It compares the full snapshot,
not merely the selected run IDs.

A newer success requires fresh derivation. A newer failure, cancellation, stale
review, base movement, or artifact loss demotes immediately.

## 8. Mandatory adversarial tests

```text
base SHA moves while head remains unchanged
base repository or ref changes
synthetic merge commit/tree changes
newer run succeeds after artifact
newer run fails after artifact
older run reruns success after a newer run exists
older run reruns failure/cancel after a newer run exists
job or step set mutates
producer collision or wrong workflow definition
artifact digest/retention changes
latest approval is dismissed or superseded by request changes
unresolved conversation appears
```

## 9. Schema

The proposed shape is defined in
`docs/qualification/schemas/qualification-subject-v3.schema.json`. Adoption
requires collector, effective-artifact, live-revalidation, tests, workflow
digests, and independent latest-head review to change atomically.
