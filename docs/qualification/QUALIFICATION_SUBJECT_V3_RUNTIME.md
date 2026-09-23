# Qualification Subject V3 runtime contract

Status: **source qualification identity contract**

## Purpose

A source qualification result is valid only for one exact repository, pull
request, base, head, tested prospective merge, producer-definition set, complete
eligible workflow history, selected required-check set, and artifact set.
Head-only qualification is forbidden.

This contract is additive to package-specific external qualification. It does
not authorize provider calls, production writing, release, immutable storage,
portal mutation, or submission.

## Exact source subject

The subject binds all of the following values:

```text
repository.id/fullName
pullRequest.number
base.repositoryId/fullName/ref/commit/tree
head.repositoryId/fullName/ref/commit/tree
testedMerge.commit/tree/orderedParents
```

Base movement with an unchanged head, pull-request retargeting, repository
substitution, or regeneration of the prospective merge changes the subject and
invalidates every prior artifact.

## Complete producer history

For every manifest-bound workflow the subject records every eligible visible run
and every attempt. Each normalized attempt binds:

```text
workflow ID/path
run ID/number/attempt
PR event and exact base/head binding
status/conclusion and creation/update timestamps
check-suite identity
complete job-set hash
complete step-set hash
complete workflow-run artifact-set hash
```

The canonical run is the highest run number and run ID. Its latest attempt must
be terminal success and contain every context assigned to that workflow as one
non-empty successful job. A non-canonical run whose latest state is updated at or
after the canonical run is rejected. Therefore a later success, failure,
cancellation, or ambiguous same-second rerun of an older run cannot be ignored.

## Snapshot components

```text
definitionSetHash
eligibleRunSetSha256
producerHistoryWatermark
selectedRunSetSha256
artifactSetHash
requiredCheckSnapshotIdentity
snapshotIdentity
```

`eligibleRunSetSha256` covers complete producer history, not only selected runs.
`producerHistoryWatermark` is the maximum bound run-update timestamp.
`snapshotIdentity` covers the exact source subject and every component above.

Independent review and unresolved-thread state remain a separate merge gate.
They cannot be manufactured by source qualification, and a legitimate review
does not silently mutate a source artifact.

## Live derivation and revalidation

The canonical derivation first produces the existing capability-specific,
non-activating V1 effective status, then wraps it in an
`HeptaEffectiveSourceStatusV2` object containing the complete V3 subject. It
immediately recollects GitHub state and requires byte-identical subject identity.

A separate `workflow_run` pipeline repeats derivation after every producer
completion. A late producer rerun therefore either produces a fresh V3 artifact
or fails closed; no older artifact remains current by omission.

## Mandatory hostile cases

```text
base SHA/tree/repository/ref moves while head is unchanged
tested merge commit/tree or parent set changes
newer canonical run succeeds or fails after artifact creation
older non-canonical run reruns success or failure after a newer run exists
job or step set mutates
producer workflow/path/digest collision
artifact set changes or expires
required-check snapshot identity changes
production or external-authority flag becomes true
```

Schemas:

```text
docs/qualification/schemas/qualification-subject-runtime-v3.schema.json
docs/rust/qualification/effective-status-runtime-v2.schema.json
```
