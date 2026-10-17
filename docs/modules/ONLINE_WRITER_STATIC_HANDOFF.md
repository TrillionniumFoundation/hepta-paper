# Native online writer static coverage

The native module implements the original JavaScript writer discovery, lexical
scope/callback analysis and repository coverage/provenance calculation. It is a
source inspection tool, not an online activation or external-service certificate.

## Source and entry points

Original source:

- `paper-adapters/automation/autonomous-research-online-writer-static-discovery.mjs`
- `paper-adapters/automation/autonomous-research-online-writer-static-callback-boundary.mjs`
- `paper-adapters/automation/autonomous-research-online-writer-static-inspection.mjs`
- `paper-adapters/automation/autonomous-research-online-writer-static-config.mjs`

Native source:
`rust/crates/hepta-paper-service/src/online_writer_static.rs`, with `ast.rs`,
`callback.rs`, `discovery.rs`, `inspection.rs`, and `config.json` children.

Public APIs:

- `discover_online_writer_mutation_entrypoints_v1(relative_path, source)` returns
  the actual discovered entrypoints, all function names, coordinator bindings,
  callback violations and classified exclusions.
- `inspect_online_writer_static_coverage_v1(workspace_root, manifest)` performs a
  real filesystem/source scan and returns the complete inspection, including
  blockers and computed source/inspection hashes.
- `verify_online_writer_static_coverage_v1(workspace_root, manifest)` returns
  `VerifiedWriterStaticCoverageV1` only when that actual scan completes without
  blockers. This type has private fields and no public constructor/deserializer.
  Its `value()` is read-only; `assert_current()` checks captured source identities
  and hashes plus the complete captured directory namespaces, so newly introduced
  files invalidate the proof without reparsing unchanged AST inputs.

No `ready` Boolean, static JSON inspection, caller-supplied signature callback or
frozen expected output can construct the opaque evidence.

## Parser and source semantics

The parser and scope resolver are **Oxc 0.148.0**, pinned exactly for allocator,
AST, parser, semantic analysis and span crates. The AST crate enables its actual
ESTree serialization. Parsing rejects diagnostics and semantic syntax errors.
Oxc provides real lexical symbols, references, declaration nodes and scope
ancestry; the native callback inspector uses those identities to distinguish
shadowed variables and track aliases. Source-selection and SQL-literal patterns
preserve the original gate's preliminary rules; they do not replace parsing.

The dependency has MSRV 1.96.0, below the workspace's Rust 1.98 requirement, and
uses the MIT license. The implementation follows the official
[parser example](https://github.com/oxc-project/oxc/blob/main/crates/oxc_parser/examples/parser.rs)
and [semantic API](https://docs.rs/oxc_semantic/0.148.0/oxc_semantic/).
The repository [license and source](https://github.com/oxc-project/oxc) are the
upstream reference. Exact transitive versions are committed in `rust/Cargo.lock`.
No production code invokes Espree, eslint-scope, Node or another JS runtime.

Discovery covers static strings/templates, direct/dynamic SQL, statement run,
known writable factories (including named import aliases), fenced mutations and
call propagation. Propagation retains original insertion order because that
order affects exclusion arrays and ultimately the inspection hash. JavaScript
parameterless string sort uses UTF-16; locale comparisons use the established
pinned production collation implementation.

Callback analysis resolves inline and named callbacks; treats only the actual
transaction parameter and its lexical aliases as trusted; tracks raw database,
store, persistence, coordinator-receiver and explicit database-input aliases;
and checks captured raw member access, dynamic methods and nested callbacks.
Declaration lookup builds a private index for one immutable parsed tree. It
uses the exact original recursive child order and retains the first matching
variable/function declaration for each source span. Callback alias analysis
reuses those borrowed nodes; no AST, source input or analysis result is cached
across parses. A direct unit comparison covers all spans and duplicate-span
first-match behavior; the four unchanged original-Node discovery suites cover
actual aliases, scopes, exclusions, every production writer and full hashes.
The fixed repository-factory-name expression is compiled once from its literal
source rule; input source selection and complete node traversal are unchanged.

The original authority/maintenance/private-copy/staged-provisioning exclusions
are represented as policy data in `config.json`, mechanically translated from
the source configuration. They are not precomputed scan results. Policy changes
require regenerating this data and rerunning the Node comparison.

## Filesystem and qualification boundary

The descriptive inspector enumerates all configured source roots, skips symlink
entries as the original scanner does, reads source through no-follow descriptors,
and checks named/held full identity before/after reading. Hashes use the bytes
that were read. It also covers provenance-only files and SQL migrations,
validates declared/discovered entrypoints and coordinator bindings, and checks
all callback violations. Final source snapshots are revalidated before return.
Sources are bounded to 16 MiB each and module discovery to 20,000 files; refusal
outside these limits is an explicit native supported-profile restriction.
Source descriptors are opened nonblocking before regular-file validation, so a
provenance FIFO or a regular file replaced by a FIFO cannot block waiting for a
writer. Directories and all other nonregular descriptor types are refused.

The opaque verified path applies the stricter
[complete input proof](ONLINE_WRITER_COMPLETE_INPUT_PROOF_HANDOFF.md): it captures
all source/migration inputs and exact namespaces before AST evaluation, derives
that evaluation's file enumeration from the captured set, and requires complete
byte/identity/namespace currentness before returning. Captured files cannot be
omitted by temporarily hiding them from a later live directory enumeration.
Later `assert_current()` checks the full captured input set again. Unchanged
inputs reuse the established AST result; changed or missing inputs fail.
The proof is a point-in-time source inspection, not a future filesystem lease.
It describes the scanned JavaScript writer manifest. It does not certify that
all Rust business adapters have been wired or that a deployment's external
linearizable authority is qualified. Native mutation plans must independently
match their implementation hashes before a configured coordinator is built.

## Verification

`tests/online_writer_static_parity.rs` has four passing tests:

1. `actual_ast_and_scope_discovery_matches_node_for_aliases_shadowing_callbacks_and_syntax`
   compares 24 real AST/scope cases, including factory import aliases, raw and
   trusted aliases, variable shadowing, nested/named callbacks, dynamic member
   access, destructuring, Unicode offsets and invalid syntax.
2. `every_production_writer_module_matches_live_node_discovery` enumerates every
   `.mjs` file in all four production scan roots and compares the complete native
   discovery result with the running original Node implementation.
3. `repository_static_inspection_hashes_and_opaque_complete_evidence_match_node`
   compares every field and derived hash of the complete repository inspection.
4. `synthetic_complete_source_scan_rejects_changed_and_unregistered_writer_evidence`
   constructs a real disposable source tree and complete manifest, compares the
   complete inspection, obtains opaque evidence from the actual scan, and proves
   that added undeclared writers or changed callbacks invalidate it.

The oracle is `rust/oracle/online-writer-static-v1.mjs` and executes the original
Node source using pinned Node 22.23.1. No expected Node output snapshot is used.
Only disposable synthetic source trees are mutated by tests.
The separate unit regression
`writer_source_fifos_and_directories_are_rejected_without_waiting_for_a_writer`
checks an actual FIFO, a discovered regular file replaced with a FIFO, and a
directory. Its two-second watchdog unblocks an old blocking implementation
before failing, making the denial-of-service regression itself bounded.

## Remaining integration

`online_runtime_activation::active_refresh` consumes the opaque static evidence
and rechecks it around actual signed authority calls. Full runtime activation
still requires the separate live inventory, startup recovery, full finalized
head inspection, schema-transition, restore-source, recoverability and safe cache
chains described in `ONLINE_RUNTIME_ACTIVATION_HANDOFF.md`. The static scanner
alone never mints an active runtime capability.


## Retained source scope for native-store transactions

A crate-private preconnection constructor borrows the actual opaque source,
inventory and active producers and retains one descriptor for every complete
input file. It preserves the existing 20,000-file, 4,096-directory and 512 MiB
aggregate limits; descriptor exhaustion fails before the target is opened. The
original low-descriptor public currentness method is unchanged. During a fixed
native-store transaction, only held `read_at`/metadata and directory enumeration
are used. Complete namespaces, absent roots, bytes, owner/group, permissions and
identities remain exact. No path is reopened even on rejection: a source name
substituted with a hardlink to SQLite must not release process-wide SQLite locks.

The scope requires exact original source/inventory/active pointer identities and
hashes plus the inventory guard's actual origin. Active receipt verification
uses this scope and the same original signature/head checks. Source retention is
not active authorization; all scopes must outlive the owning connection. Local
regressions exercise changed/missing/replaced/added inputs, bounds, actual signed
producers and independent-process lock retention after an alias is rejected.
