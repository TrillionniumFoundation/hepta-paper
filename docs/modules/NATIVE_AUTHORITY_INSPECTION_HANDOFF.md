# Native authority inspection: implementation handoff

These Rust commands inspect imported evidence. They do not create independent
acceptance, sign real evidence, activate a writer, call a portal, or retire Node.
They are implementations within `module.rust-control-plane-service`, not new
registered modules. Complete command acceptance remains separately tracked in
[`../migration/NODE_RUST_GAP_CLOSURE.md`](../migration/NODE_RUST_GAP_CLOSURE.md).

## Entry points and data ownership

Build with the pinned Rust toolchain and committed lockfile:

```sh
cargo build --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --bins
```

| Binary | Required arguments | Public implementation |
|---|---|---|
| `hepta-operational-proof-status` | `--workspace-root ABSOLUTE_PATH --runtime-root ABSOLUTE_PATH --asset-root ABSOLUTE_PATH` | `operational_status::capability_operational_proof_status_v1` |
| `hepta-owner-acceptance-status` | `--workspace-root ABSOLUTE_PATH --runtime-root ABSOLUTE_PATH` | `owner_status::inspect_owner_acceptance_status_v1` |
| `hepta-nested-runtime-qualification` | the incumbent 18 flags/environment bindings, or `--request ABSOLUTE_JSON_PATH` | `nested_runtime_cli::nested_runtime_qualification_cli_v1` / `nested_runtime_qualification::verify_nested_runtime_platform_qualification_file_v1` |
| `hepta-journal-connector-coverage` | discovery filters and readiness flags corresponding to `paper-core/bin/journal-connector-coverage.mjs` | `journal_connector_coverage::journal_connector_coverage_cli_v2` |

All binaries reject unknown, repeated and missing options. Operational/owner roots
and the nested request-file extension require absolute paths. They emit formatted
JSON on stdout; input/source errors use stderr and exit 1. Pending operational/owner
acceptance is a valid status and exits 0. Nested qualification uses the incumbent
exit 1 for a blocked report in flag/environment mode; its explicit request-file
extension uses exit 2. Journal readiness gates preserve their incumbent exit-1
behavior. Independent acceptance still needs to review the explicit root interfaces
and remaining input-domain differences.

## Operational proof and source closure

`src/operational_status.rs` owns the 16-capability catalog and distinguishes
operational evidence from conformance replay. `operational_status/authority.rs`
verifies Ed25519 signatures against imported active public keys and their roles,
requiring distinct identities where applicable. `provenance.rs` binds Git commit,
tree, tracked/untracked source bytes and dirty state. Sealed and read-only modes
verify hydrated-submodule closure against the actual Git link identities and
content-tree snapshots. Related modules preserve original JSON member ordering
where the incumbent receipt comparison makes it significant.

The runtime root owns `owner-acceptance/OWNER_TRUST_STORE.json`, per-capability
`operational-proof/capabilities/` receipts and `conformance-proof/` replay evidence.
The independent asset root owns the manuscript source bound by conformance.
Missing or untrusted proof remains pending; replay success cannot substitute for
an operational observation. Source provenance failure aborts inspection. Reads
are bounded and check identity/permissions before and after use; no receipt,
trust-store, source, asset or workspace mutation is part of this command.

Differential tests cover valid evidence for all 16 capabilities, invalid signatures,
reused subjects, local assurance, revoked keys, source/result drift, historical
receipts, reordered fields, unsafe links/permissions and sealed-closure corruption.
They also execute the installed binary and compare complete JSON and exit behavior.

## Owner acceptance and source disposition

`src/owner_status.rs` reads the current
`migration/legacy-semantic-migration-matrix.json` and
`paper-domain/governance/legacy-owner-acceptance-family-manifest.v1.json`.
`build_owner_acceptance_families_v1` reconstructs all explicit-retirement family
members, dispositions, capability sets and production-compatible record hashes.
The stored family manifest must match this reconstruction before acceptance is
considered. Current source changes cannot reuse a stale signed manifest.

The runtime inputs are `owner-acceptance/CAPABILITY_OWNER_ACCEPTANCE.json` and
`owner-acceptance/OWNER_TRUST_STORE.json`. Version 1 acceptance binds individual
entry/source/disposition values; version 2 binds the full manifest and selected
family hashes. Both require actual authorized Ed25519 signatures. External,
local-administrator and unclassified assurances remain separate counts. The
status routine never upgrades local acceptance to independent acceptance.

Native file reads are capped at 16 MiB and reject path aliases, hard links,
duplicate JSON keys, nonregular files and observed identity/size drift. Runtime
trust/receipt files also reject group/world write permission; source files remain
bound to the captured workspace bytes. Descriptor-relative reads and a complete
postflight snapshot prevent a file change during inspection from retaining an
accepted result. These restrictions are
stricter than the legacy owner loader and require explicit compatibility review.
Missing/malformed acceptance files produce pending status; a missing, invalid or
drifted source matrix/manifest is an error. The Node matrix builder's unrelated
operational/conformance inspection is not implemented by this owner-only command.

## Nested runtime qualification request

The request file is bounded to 256 KiB and read through the same duplicate-key
rejecting descriptor reader as evidence. Its closed object accepts:

- `configPath`, `expectedConfigContentHash`;
- `expectedQualificationBundleContentHash`, `expectedConformanceBundleContentHash`,
  `expectedAuthorityIndependenceBundleContentHash`;
- `podUid`, `planHash`, `profileId`, `runtimeClassName`;
- `parentPodCpuMillis`, `parentPodMemoryBytes`, `parentPodPids`;
- `qualificationKeyId`, `qualificationSubjectId`, `qualificationPublicKeySpkiHash`;
- `conformanceKeyId`, `conformanceSubjectId`, `conformancePublicKeySpkiHash`;
- `now`, an explicit calendar-valid UTC timestamp with milliseconds.

The configuration binds public trust and three evidence bundles. Resource values
must convert to safe positive integers under the tested Node numeric rules.
CPU/GPU profile checks, parent Pod
ceilings, current Pod/plan, observed conformance, signature roles, SPKI hashes,
validity windows and independent organization/control-domain identities are
validated before `ready` can be true. The report hash is recomputed with the
production-compatible Rust encoder. Input ordering/duplicate rules, four-digit
timestamp years and canonical SPKI PEM support are explicit compatibility bounds.

`support.rs` rejects unsafe paths, symlinks, hard links, group/world-writable
evidence, unknown/duplicate fields and over-limit files. `subjects.rs` validates
the three typed subjects; `authority.rs` validates trust, bindings and signed
envelopes. No runtime, container, provider, Kubernetes, GPU or network operation
occurs. A valid supplied test package is not evidence that a real target host was
observed by an independent authority.

The flag interface mirrors all 18 Node options, including `--name=value`, strict
duplicate/missing/boolean checks, help output and `HEPTA_NESTED_RUNTIME_*`
fallbacks. Explicit arguments override environment values. The binary obtains its
clock from the operating system and formats UTC in Rust; it never takes a test
clock from an environment variable. Tests run the original Node executable under
an isolated injected test clock to compare complete reports and report hashes.
Missing-file OS error text is intentionally bounded to Rust error categories;
the full raw platform error strings are not claimed to be byte-identical.

## Journal discovery and signed qualification

`journal_connector_coverage.rs` constructs eight connector families and all 98
venue targets from the version-2 raw profile dataset in `src/data/`. Registry,
coverage and content hashes are calculated in Rust; generated outputs are not
frozen fixtures. Discovery, venue filters, summary, strict arguments and readiness
gates are tested against Node, including every venue and the executable binary.
Configured qualification registries pass a separate signed verification chain:
safe files, raw-content and semantic pins, canonical field order, recomputed
typed evidence hashes, registry/entry validity windows and authorized independent
Ed25519 subjects, organizations and SPKI identities. An opaque verified inspection
is required to apply qualification to discovery entries. Invalid supplied evidence
fails explicitly; it never silently falls back to discovery. Qualification cannot
create or consume a human single-use live-commit permit.

Standard Ed25519 SPKI PEM is supported, and invalid PEM Base64 is rejected.
Additional public-key containers accepted by Node/OpenSSL, such as certificates,
key-options objects and noncanonical DER encodings, remain outside the tested
compatibility domain. `journal_qualification_parity` exercises both sandbox and
production-shaped synthetic packages, signature/identity/pin/freshness attacks,
secure-file rejection and true executable behavior; synthetic packages do not
qualify a real portal.

## Validation and acceptance limits

Use Node **22.23.1** for the incumbent differential oracle and the Rust toolchain
declared by `rust/rust-toolchain.toml`:

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --test operational_status_parity --test owner_status_parity \
  --test nested_runtime_qualification_parity --test nested_runtime_cli \
  --test journal_connector_coverage_parity --test journal_qualification_parity
cargo clippy --manifest-path rust/Cargo.toml --locked -p hepta-paper-service \
  --all-targets -- -D warnings
node docs/tools/audit-node-rust-coverage.mjs
node docs/tools/generate-node-rust-gap-report.mjs --check
```

Oracle scripts under `rust/oracle/` are test-only. Synthetic keys, signatures,
files and package observations live in disposable test directories and are never
installed as production trust. Tests compare full reports/hashes, successful and
rejected inputs, actual binary behavior and absence of mutation. Passing local
tests does not satisfy hosted exact-candidate qualification, historical replay,
independent owner review, production host evidence or authority handoff.
