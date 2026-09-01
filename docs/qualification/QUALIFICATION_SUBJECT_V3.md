# Exact qualification subject V3

## 1. Soundness boundary

Source qualification is valid only for one exact repository, pull request, base,
head, tested prospective merge, producer-definition set, and complete eligible
workflow-run state. A head-only result is not a qualification subject.

The latest-head independent review and protected-branch decision remain separate
merge gates. They are deliberately not folded into the source artifact, avoiding
a review/qualification recursion in which an approval would invalidate the
artifact it approves.

## 2. Exact source and merge identity

```text
repository.id/fullName
pullRequestNumber
base.repositoryId/repository/ref/commit/tree
head.repositoryId/repository/ref/commit/tree
testedMerge.commit/tree
```

Base movement with an unchanged head, retargeting, head-repository substitution,
or regeneration of the prospective merge invalidates all prior evidence.

## 3. Complete producer history

For every manifest-bound workflow, the subject records every eligible visible
pull-request run and its current attempt, timestamps, status, conclusion, check
suite, complete job-set hash, complete step-set hash, and artifact-set hash. One
canonical run supplies required contexts, but non-selected run mutations remain
part of the subject.

An older run rerun after a newer run therefore changes
`eligibleRunSetSha256`. A late failure or cancellation fails closed; a late
success requires fresh derivation and live revalidation.

## 4. Snapshot components

```text
definitionSetSha256
eligibleRunSetSha256
producerHistoryWatermark
selectedRunSetSha256
artifactSetSha256
snapshotIdentity
```

The snapshot identity hashes the complete canonical subject excluding only the
`snapshotIdentity` field itself.

## 5. Live revalidation

The collector fetches the current PR/base/head/tested-merge subject and complete
producer history from GitHub. The effective artifact embeds the full V3 subject.
Live revalidation reconstructs and compares that subject, not only selected run
IDs or a head SHA.

## 6. Mandatory hostile cases

```text
base repository/ref/SHA/tree moves while head is unchanged
tested merge commit/tree changes
newer run succeeds or fails after artifact creation
older run reruns success or failure after a newer run exists
job, step, or artifact set mutates
producer workflow/path/digest collision
wrong app, event, pull request, base, or head binding
```

Schema: `docs/qualification/schemas/qualification-subject-v3.schema.json`.
