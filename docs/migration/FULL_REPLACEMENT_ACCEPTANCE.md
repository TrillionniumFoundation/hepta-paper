# Full Node-to-Rust replacement acceptance

This is an executable acceptance contract under the existing global plan, not a
new status authority. Registered implementation state, effective exact-subject
qualification, production activation and Node retirement are independent claims.
No inventory script, document, source commit or fixture can grant the latter
three. The [migration strategy](NODE_RUST_MIGRATION.md), global machine records
and independently verified evidence remain authoritative in their scopes.

## Priority 1: one reviewed source subject

Retain one integration branch/PR for the accepted product candidate. Development
may advance it with ordinary commits; each new head invalidates prior head/tree
qualification. Never force-push main, bypass protection, automatically merge all
branches, or close an unresolved branch merely because its name contains final.

On a clean full-history checkout of the candidate, capture every fetched public
branch's tip and compare its EXACT tree with the candidate:

```sh
python3 docs/tools/audit-branch-convergence.py --candidate HEAD
python3 -B docs/tools/test_branch_convergence.py
```

The report includes every local `origin` branch, all changed paths, ancestry,
merge bases and candidate-only/branch-only counts. It checks local ref stability
before and after. It does not fetch or mutate refs and is not a remote freshness
attestation; record the fetch time/source and compare the remote ref set again at
acceptance. Equal trees do not transfer CI or review. An ancestor's removed
feature may still need a retirement decision in the capability inventory.

For each divergent/descendant/unrelated tip record `absorb`, `supersede`,
`retain_reference`, or `reject`, with exact changed paths, rationale, owner and
independent review. Inspect exact two-tree changes; GitHub's merge-base compare
alone cannot prove another branch has no unique behavior. Retain disposition
records and bind their digest to the qualification subject.

Qualification CI must read the committed tree, never create a new commit, rewrite
work-item status, or push its own generated tree back to the candidate. Bind
base/head/prospective-merge, workflow blobs, lockfiles, compiler/runtime identities,
non-empty tests, raw receipts and review to one exact subject. Build predecessor
and candidate regressions into different fresh target directories; a cached
predecessor executable is not evidence about candidate source.

## Priority 2: complete command and business-capability chains

Generate the inventories from actual Node registries, not a hand-maintained count:

```sh
node docs/tools/audit-node-rust-coverage.mjs
node --test paper-core/tests/node-rust-coverage-audit.test.mjs
```

The report preserves all command groups, argv, forwarded argument schema,
unsupported modes, mutability and declared effects. It keeps command routes,
operator catalog capabilities, global capabilities, registered modules and native
kernel hints as separate denominators. Adding a command cannot silently disappear
from the inventory. The report's `unassessed` rows mean THIS inventory has not
consumed accepted per-command mappings; they do not claim existing Rust code or
previous scoped evidence is absent. `--require-complete` therefore exits 2.

For every command AND argument-dependent mode, and every catalog capability,
retain an acceptance record containing:

```text
stable Node route/capability and exact baseline source
all forwarded modes, state transitions and external effects
Rust entrypoint, full call chain, source digest and required runtime
exact / semantic / evaluation / reviewed retirement decision
positive, negative, malformed, limit and policy-denial test identities
historical differential corpus or independent quality evaluation
lease, cost, retry, crash, cancellation and ambiguity disposition
read/write schema migration and rollback/forward-recovery boundary
actual result-byte verification and independent scientific validation
exact candidate, test runs, artifact hashes, owner and independent review
remaining external evidence, writer transfer and Node retirement checks
```

Do not count Node invocation behind a Rust process bridge as a native rewrite.
Non-Node scientific runtimes may remain behind qualified typed boundaries when
an explicitly accepted parity decision permits them. Intentional retirement of a
legacy feature is a product-scope decision, not a hidden missing capability.

The [native-kernel handoff](../modules/NATIVE_BUSINESS_HANDOFF.md) documents seven
bounded kernels. Manuscript assembly is not model authorship; structural checks
are not independent review; aggregating observations is not executing experiments.
Implement a complete research-to-package vertical with real runtime interfaces,
then add the remaining modes and failure matrix. Live model behavior requires
versioned evaluation, not text-byte equality or a fixture masquerading as a call.

## Priority 3: executable module documentation

Keep one spec/manifest per registered module, but require more than headings:
real request/response examples, closed fields/limits, errors, owned state,
transaction/lease invariants, algorithm bounds, build/run/test commands,
observability and escalation, compatibility decisions, and rollback.

Examples must be imported by tests that execute real code. Bind examples, tests,
implementation, schemas and manifests to the same candidate. A source status
must agree throughout a document; source implementation is not effective
qualification. Missing production capacity measurements stay explicitly absent,
not replaced by invented SLO numbers. Shared role contracts may link a detailed
implementation handoff, but must distinguish Node, Rust kernel and full Rust
business-role scope.

## Priority 4: independently evidenced deployment and retirement

Start planning external collectors in parallel with source work, but run final
qualification against the frozen candidate. The existing collectors remain:
#25 governance, #28 private historical replay, #17 target host, #12 destructive
storage and 72-hour soak, #14 key custody/revocation, #21 separated real model
principals, and #22 release/immutable-storage/submission authorities.

Use disposable production-shaped state for shadow first. Bound canary admission,
resource budgets, stop conditions and owner responsibilities explicitly. No
repository workflow may run real provider, portal, KMS or production writer
operations merely to turn an acceptance indicator green.

Before transfer, stop admissions and drain known writers, prepared work, leases,
queues, submission waits and release locks. Bind the exact old database preimage
and new writer generation. Follow the [drain and forward-recovery contract](../rust/LEGACY_NODE_DRAIN_AND_FORWARD_CUTOVER.md):
after the first authoritative Rust commit, never overwrite current state with an
old Node backup. A reverse migration needs independent design and qualification.

Retirement evidence must show old Node processes/services/timers/sockets,
credentials, queues, executable entrypoints and writer leases cannot reacquire
authority, including after reboot, restore and failure. A grep result or
uninvoked Node binary is not sufficient. Keep immutable historical archives and
read-only verifiers without retaining execution authority.

## Exit decision

Full replacement requires ALL of: reviewed branch dispositions; complete accepted
command/mode and capability mappings; exact-head and prospective-merge non-empty
CI; executable consistent module docs; historical/live evaluation; target-host
and external packages; accepted shadow/canary and recovery; unique writer
transfer; and mechanically verified Node retirement. Until then report separate
source, documentation, parity, qualification and activation states. Never derive
an overall completion percentage from crate, document or fixture counts.
