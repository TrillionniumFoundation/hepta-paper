# Native generic-domain evidence inspection

This component belongs to `module.rust-control-plane-service`. It ports the
local repository inspection boundary, not the incumbent operator's strong
status or convergence workflow. Its command mapping remains
`partial_local_source`.

## Sources and call chain

| Source | Entry | Responsibility |
|---|---|---|
| `paper-adapters/automation/generic-domain-capability-evidence-repository.mjs` | `inspectGenericDomainCapabilityEvidence` | Incumbent local-file oracle. |
| `rust/crates/hepta-paper-service/src/generic_domain_capability_evidence.rs` | `inspect_generic_domain_capability_evidence_v1` | Inspect one explicit runtime evidence file and calculate its production record hash. |
| `rust/crates/hepta-paper-service/src/generic_domain_capability_evidence.rs` | `converge_generic_domain_capability_evidence_v1` | Describe the missing convergence implementation without writing or invoking external actors. |
| `rust/crates/hepta-paper-service/src/bin/hepta-paper-rust.rs` | `command` | Parse the bounded CLI, serialize the report and select the exit status. |

The CLI accepts
`hepta-paper-rust generic-domain-capability-evidence --action status|converge
--runtime-root ABSOLUTE_PATH`. The default action is `status`. It rejects unknown
or duplicate options, accepts `--help`, and requires an explicit runtime root
for inspection. It does not accept `--require-ready`, a paper ID, an asset root,
or an environment-selected evidence path.

## Input contract and hash

The runtime root must be an existing absolute canonical private directory.
The only candidate file is `generic-domain-capability-evidence.json` directly
inside it. A missing file is a blocked inspection. The file must be a private,
nonempty regular file owned by the current UID with one hard link, and must not
exceed 16 MiB. Symlinks are rejected. Reads are bounded and file identity is
checked across the read.

The JSON object must contain exactly the following fourteen fields:

- `dynamicFormalExecutionAuthority`
- `experimentHarnessExecutionReceipt`
- `experimentIrExecutionAuthorityReceipt`
- `experimentReplayReceipt`
- `externalResearchReplayReceipt`
- `externalResearchReplayRequest`
- `formalDomainCoverageReceipt`
- `formalDomainQualificationExternalEvidence`
- `independentFormalReviewReceipt`
- `priorArtClaimAlignmentReceipt`
- `priorArtEvidenceReceipt`
- `researchAgendaIr`
- `venueProfile`
- `venueRequirementIr`

Their nested values are retained for hashing; this adapter does not verify their
signatures, semantic contents or mutual bindings. The evidence hash uses the
existing production-compatible `GenericDomainCapabilityEvidence` record hash.
The Node differential fixture checks the complete inspection report, including
its hash, Unicode/numeric nested input and canonical path.

## Meaning of readiness and failures

`GenericDomainCapabilityEvidenceInspection.ready=true` means only that this
local file passed the repository's loading and top-level shape checks. Empty
nested objects can satisfy those checks, as in the original repository helper.
It is never a production-readiness or authority decision. The inspection returns
the loaded evidence; unlike the incumbent strong operator status, it does not
hide the evidence behind a semantic/authority verification result.

Missing, unreadable, unsafe or malformed files produce `ready=false` with
specific blockers. The native `status` CLI exits 2 for those reports. Valid local
inspection exits 0. Argument errors exit 1. `converge` always exits 2 with
`rust_generic_domain_capability_convergence_not_ported`, `published=false`,
`externalActionPerformed=false` and `serviceStateChanged=false`, even when the
local inspection succeeds.

There are no writes, publication transactions, retry state, authority calls,
replay/reviewer processes, private-key reads or network operations. The Node
oracle runs only in tests.

## Remaining implementation and acceptance

The original operator in `paper-core/bin/generic-domain-capability-evidence.mjs`
uses the strong composition in
`paper-composition/automation/generic-domain-capability-evidence-convergence.mjs`.
That chain rebuilds persisted production authorities, checks current authority
lineage and paper/campaign bindings, verifies semantic readiness and formal
qualification, obtains dedicated external replay and independently signed
review, and atomically publishes a verified aggregate. These functions and
their complete argument/environment modes remain to be ported. The bounded
reader cannot replace that chain.

Independent command acceptance, real external actor qualification, production
activation and Node retirement remain open. Repository inspection parity is
only one source-level building block for those requirements.

## Verification

Use the repository-pinned Node v22.23.1 for the test oracle and Rust 1.98.0:

```sh
cargo +1.98.0 test --manifest-path rust/Cargo.toml -p hepta-paper-service \
  --test generic_domain_capability_evidence_parity --locked
```

The tests compare Node missing/loaded reports and exercise unsafe file inputs,
shape rejection, unchanged bytes during blocked convergence, and CLI exit
behavior. Strong production status and convergence parity are not asserted.
