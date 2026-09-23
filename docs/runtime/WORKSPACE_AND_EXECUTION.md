# Workspace, artifact, and execution boundary

## 1. Workspace ownership

Every mutable task runs in an attempt-owned isolated workspace. The canonical
source is read-only until the central integration step.

A workspace identity binds root descriptor, device/inode, owner/group/mode,
source snapshot, campaign/node/attempt, lease generation, mutation policy,
maximum tree size/count, and artifact roots.

## 2. Descriptor-bound traversal

All traversal remains relative to opened directory descriptors. The
implementation rejects:

- symbolic links;
- regular-file hard links where policy forbids them;
- special nodes;
- cross-device/nested mount entries;
- owner/mode/type drift;
- replacement between check and use;
- over-count/over-byte trees;
- in-place mutation between hash passes.

Regular files are hashed twice from the retained descriptor, copied from that
descriptor, and source/target bytes are reverified.

## 3. Mutation truth

Before and after inventories record path, kind, byte count/hash, mode, UID/GID,
link count, and approved metadata. Actual inventory differences determine
mutation truth; agent reports are advisory.

A versioned role policy classifies allowed create/modify/delete operations and
size/count limits. Unclassified changes reject the prepared result.

## 4. Artifacts and CAS

Large outputs move through content-addressed artifacts rather than protocol
payloads. Publication binds:

```text
logical role
content hash and byte count
complete tree inventory
producer execution and workspace
schema/format
retention and confidentiality class
```

A directory name or mutable tag is not artifact identity.

## 5. Prepared integration

Execution may prepare a result and optional workspace-integration descriptor.
The central verifier rechecks source preimages, attempt/lease/generation, policy,
and complete inventory before applying a no-clobber integration.

A stale, cancelled, expired, or replaced attempt cannot integrate. Crash after
prepare resumes integration without rerunning the producer.

## 6. Heterogeneous runtimes

Python, R, Julia, Lean, LaTeX, Node, and GPU tools run behind the qualified OS
runner with:

- exact executable/image identity;
- no caller-supplied unverified image digest;
- read-only inputs/datasets;
- explicit benchmark selector;
- PID/memory/CPU/GPU/deadline limits;
- bounded environment and mounts;
- artifact and raw-event recomputation;
- cancellation and descendant cleanup.

Generated code and LaTeX are executed and verified, never trusted from prose.

## 7. Reviewer isolation

Reviewer modules receive a separate private read-only clone and role principal.
They cannot access author credentials/session state or mutate the author
workspace. Review output binds the exact manuscript/source snapshot and reviewer
runtime identity.

## 8. Failure and cleanup

Partial copies, staging directories, published attempts, quarantines, and CAS
objects have explicit ownership and recovery states. Cleanup revalidates the
same descriptor-owned object before unlink/removal. Published or externally
referenced artifacts are never reclaimed from path/name inference alone.
