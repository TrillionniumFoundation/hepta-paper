# Earlier workspace diagnostic wire

`workspace_wire_compat_v1` preserves the inventory, mutation and prepared-result
wire from `codex/rust-all-gap-closure-v2-20260830`, source blob
`137f658cc403e76a417dd2e9eac33425de2bbfcd`. Its pure functions project current typed
before/after inventories. They perform no filesystem I/O and cannot materialize,
write, publish or authorize an attempt. The current workspace owner, mutation
policy, bounded copying and publication checks remain unchanged.

The original domains are `HeptaWorkspaceInventoryV1`,
`HeptaWorkspaceMutationManifestV1`, and `HeptaPreparedWorkspaceResultV1`. Nodes
sort by path and retain path, kind, permission mode, byte count and content hash.
The earlier wire omits UID/GID/link count, attempt identity and workspace object
identity. A current ownership-only change therefore has no old mutation entry;
consumers must keep the current evidence for those facts. Old mutations use
`modified`, unlike the current `changed` variant. The prepared hash includes the
entire old mutation manifest. No current hash is reused as a legacy hash.

The projection retains the current 100,000-entry ceiling, rejects duplicate paths
and refuses backslashes (the old filesystem walker replaced them with slashes,
creating aliases). It rejects escaping/invalid relative paths through the current
validator. These explicit profile limits replace unsafe old behavior; the old
`write_file`, raw-path materialization and permissive policy APIs are not exposed.
Caller-supplied inventories remain claims: the result records a difference,
without asserting that a change was permitted, performed or durably committed.

`tests/workspace_wire_compat.rs` compares full inventories and a prepared result
containing additions, removals and a modification against frozen output from the
original pure builders. It covers metadata omission, mode binding and ambiguous
paths. The old source needed its missing `OpenOptionsExt` import to compile in the
isolated fixture generator; that oracle-only repair does not change the invoked
pure builders. No old path writer or materializer was executed. The frozen vector
is `tests/fixtures/workspace-wire-compat-v1.json`.
