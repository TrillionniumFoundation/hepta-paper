# Strict machine-intake reconciliation diagnostics

The native reader consumes the incumbent receipt at
`strict-full-auto-acceptance/machine-intake-reconciliation.json`. It is a
read-only data-contract inspection. A record hash, this report, or a successful
health exit does not prove that a cycle ran, authenticate an external signer,
qualify an installation, authorize dispatch or transfer database ownership.

## API and actual composition

`inspect_strict_machine_intake_reconciliation_v1(runtime_root,
acceptance_plan_hash, acceptance_step_idempotency_key, machine_intake,
now_millis) -> Value` accepts explicit expected bindings and a supplied intake
observation. `None` represents an absent Node option, distinct from JSON null.
Relative roots resolve lexically against the process working directory. The
function reads no process environment and returns no retained file descriptor.
Its `Value` input is data, not an opaque authority capability.

The actual `inspect_supervisor_health_strict_intake_v1` composition reads base
resident health and current intake once each through their native snapshot
consumers, closes those owners, then inspects the strict receipt against that
actual intake result. The CLI reads the existing intake environment allowlist
and, only for strict mode, `HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_PLAN_HASH` and
`HEPTA_STRICT_FULL_AUTO_ACCEPTANCE_IDEMPOTENCY_KEY`.

The real `hepta-autonomous-supervisor-health
--require-strict-machine-intake-reconciliation` fills the incumbent
`strictMachineIntakeReconciliation` and
`strictMachineIntakeReconciliationReady` fields. Exit precedence is strict,
current intake, machine reconciliation, startup reconciliation, base healthy.
Fully autonomous mode is still explicitly unsupported. Just as in the original
command, strict mode uses strict receipt readiness alone: a valid strict
inspection can exit 0 while the independent resident/base readiness is false.
That is an observable diagnostic distinction, not an execution permission.

## Record and hash contract

The outer receipt has exactly the original 15 keys, version 1, kind/status,
ready=true, absolute runtime root, expected acceptance identities, cycle hash,
configuration/dataset identities, nested reconciliation, canonical observed
instant and two false effect flags. Its claimed hash must equal the real
production Node-compatible record hash of the remaining payload.

The inner reconciliation validates version/kind, configuration/dataset/cycle
result hashes, canonical reconciliation time and the false effect flags. It
allows additional inner fields, which must participate in its actual record
hash. Cross-record configuration and dataset identities use JavaScript strict
scalar equality; missing is distinct from null and separately parsed arrays
are not the same object. Shape checks accept the incumbent case-insensitive SHA
prefix/hex and singleton-array string coercion where the original applies
`String(value || '')`. A claimed record digest must still be a string exactly
equal to the computed digest. Numeric JSON versions such as `1.0` retain Node
number semantics in validation and projection.

The reader adds receipt, acceptance-binding, current-intake-identity and invalid
inspection-clock blockers in the incumbent order. The report exposes a receipt
only when all checks pass. Inspection time must be within the ECMAScript Date
range. The incumbent contract has no age limit or requirement that observedAt
precede inspectedAt; this port does not invent one. Those timestamps are not a
signed live-authority validity window.

## File ownership and bounded failure

The reader walks and retains actual directory descriptors with O_PATH/no-follow;
opens the leaf no-follow/nonblocking; requires a regular file, mode without
0022, and size from 2 bytes through 2 MiB inclusive. It rejects FIFOs before
reading. Reads are bounded to maximum+1. It captures leaf identity, owner/group,
mode, link count, size and modification/change timestamps and rechecks the held
and named inode after parsing, hashing and projection. Parent inode, mode and
owner/group must remain equal. A symlink anywhere in the actual walk is refused.

Missing, unsafe, malformed or drifted source yields the missing-or-invalid
blocker and no usable receipt. The native owner never creates directories,
rewrites a receipt, enters SQLite, or retains a grant. All its descriptors are
released before returning. Callers must keep these regular-file observations
outside lifetimes of their own live SQLite connections; process-scoped POSIX
locks are not protected by keeping a second regular-file descriptor open.

Repeated checks detect observed changes; they do not exclude an arbitrary
writer or make the configuration, intake/resident databases and receipt one
atomic snapshot. The result cannot authorize a later action without that
operation's separate authority and currentness checks.

## Deliberate compatibility boundaries

The incumbent's `if (receipt)` guards skip validation for parsed null, false,
zero and empty string, allowing false readiness with a valid inspection clock.
The native reader always marks these parsed values receipt-invalid. Actual
Node execution in the differential tests reproduces the defect; Rust tests
require refusal instead of reproducing it.

The parser uses bounded-depth UTF-8 `serde_json::Value`; unpaired UTF-16
surrogates, non-finite parsed numeric values and inputs incompatible with the
production hash serializer are refused. This is narrower than arbitrary Node
JSON values. The intake composition retains the V1 builtin restrictions in the
[current intake contract](../machine_intake/HANDOFF.md): V2 producer/authority,
external plugins and local-golden scoped datasets remain unported. This module
does not implement the publisher or supervisor lifecycle.

## Verification and recovery

The oracle imports the actual original publisher, inspector and record hash.
Its owned temporary runtime contains actual Node-provisioned V1 intake,
admission and configuration state. It then constructs cycle *data* for the
original publisher; no test claims a real autonomous cycle or independent
acceptance. Tests compare full native and Node reports, actual CLI exits and
flag precedence, nested/outer tampering with recomputed hashes, absent/wrong
expected bindings, actual provider mismatch, numeric versions, uppercase/array
hash fields, nullable identity, clock limits and the explicit falsy-JSON refusal.

Filesystem tests exercise actual bounded files, FIFO, leaf/ancestor symlinks,
mode violations, inode/parent replacement and same-length in-place change.
Read-only inspection leaves source bytes and metadata unchanged. Failure has
no write to roll back; correct the original source or expected bindings and
perform a new observation. Executed commands and results belong in the exact
commit's validation manifest, not in a fabricated acceptance receipt.
