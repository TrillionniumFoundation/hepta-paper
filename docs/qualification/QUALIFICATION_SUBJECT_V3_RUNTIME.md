# Qualification Subject V3 runtime contract

Status: **source qualification identity contract**

## 1. Purpose

A source qualification result is valid only for one exact repository, pull
request, base, head, tested prospective merge, producer-definition set, complete
eligible workflow history, selected required-check set, and artifact set.
Head-only qualification is forbidden.

This contract is additive to package-specific external qualification. It does
not authorize provider calls, production writing, release, immutable storage,
portal mutation, or submission.

## 2. Exact source subject

The subject binds all of the following values:

```text
repository.id/fullName
pullRequest.number
base.repositoryId/fullName/ref/commit/tree
head.repositoryId/fullName/ref/commit/tree
testedMerge.commit/tree/parents
```

Base movement with an unchanged head, pull-request retargeting, repository
substitution, or regeneration of the prospective merge changes the subject and
invalidates every prior artifact.

## 3. Complete producer history

For every manifest-bound workflow the subject records every eligible visible run
and every current or historical attempt. Each normalized attempt binds:

```text
workflow ID/path
run ID/number/attempt
PR event and exact base/head binding
status/conclusion and creation/update timestamps
check-suite identity
complete job-set hash
complete step-set hash
complete artifact-set hash
```

The canonical run is the highest run number and run ID. It must be terminal
success and contain every context assigned to that workflow as one non-empty
successful job. A rerun of an older non-canonical run after the canonical run was
updated is rejected. Therefore an old-run success or failure cannot be ignored
merely because a newer run ID exists.

## 4. Snapshot components

```text
definitionSetHash
eligibleRunSetSha256
producerHistoryWatermark
selectedRunSetSha256
artifactSetHash
requiredCheckSnapshotIdentity
snapshotIdentity
```

`eligibleRunSetSha256` covers the complete producer history, not only selected
runs. `snapshotIdentity` covers the exact source subject and every component
above. Collection time is derived from the producer-history watermark so an
unchanged live recollection is byte-stable.

Independent review and unresolved-thread state remain a separate merge gate.
They cannot be manufactured by source qualification, and adding a legitimate
review does not silently mutate the source artifact.

## 5. Live revalidation

The canonical V3 workflow first derives the existing capability-specific,
non-activating effective status, then wraps it in an `HeptaEffectiveSourceStatusV2`
object containing the complete V3 subject. It immediately recollects the GitHub
state and requires byte-identical V3 identity.

A separate `workflow_run` revalidator executes after every producer or V3 run.
It downloads the newest exact-head V2 artifact, recollects both the required
check matrix and complete V3 producer history, and fails when any bound input has
moved.

## 6. Mandatory hostile cases

```text
base SHA/tree/repository/ref moves while head is unchanged
tested merge commit/tree or parent set changes
newer canonical run succeeds or fails after artifact creation
older non-canonical run reruns successfully after a newer run exists
older non-canonical run reruns unsuccessfully after a newer run exists
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
