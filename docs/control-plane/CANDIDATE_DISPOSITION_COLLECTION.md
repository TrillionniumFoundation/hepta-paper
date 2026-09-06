# Candidate disposition collection

Status: source-level control-plane boundary  
Authority: non-authorizing  
Related work: `MOD-002`, `CTL-004`, candidate-producer lifecycle

## Purpose

`paper-application/orchestration/candidate-disposition-collector.mjs` separates
producer execution from candidate-frontier construction.

The collector does **not** start a producer, race arbitrary promises, kill a
process, reclaim a lease, or infer that timed-out work stopped. It accepts
explicit `ModuleCandidateDispositionV1` records produced by a separate bounded
execution layer. A missing, failed, cancelled, unavailable, or timed-out
producer makes the collection incomplete and prevents any partial candidate set
from being published to routing or selection.

## Producer completion bytes

A producer that completes uses `sealCandidateBatchJsonV1` at its completion
boundary. The sealer:

- accepts only the explicit `trusted_same_realm_plain_data` boundary;
- captures plain/null-prototype records and dense arrays without invoking
  accessor properties;
- rejects symbols, unsupported prototypes, sparse arrays, cycles, non-finite
  numbers, isolated UTF-16 surrogate code units, excessive depth/nodes/counts,
  and oversized UTF-8 strings or batches;
- preserves `__proto__`, `constructor`, and `prototype` as ordinary own data
  keys by capturing into null-prototype records;
- orders keys and candidate identities by unsigned UTF-8 bytes;
- emits one canonical JSON string and its SHA-256 byte hash.

The byte string, not a retained candidate object reference, is the producer
completion payload. Mutating the producer's original objects after sealing
cannot change the disposition bytes.

Same-realm Proxy reflection can execute traps before rejection. Untrusted
producer output must cross a duplicate-key-safe, bounded serialized or
isolated-process adapter before entering this API.

## Complete-only aggregation

`collectCandidateDispositionBytesV1` receives:

- one exact planning request ID/hash, snapshot hash, capability and module
  qualification-metadata-set hash;
- the exact expected `(moduleId,moduleVersion,qualificationMetadataHash)` set;
- one explicit disposition per observed producer;
- one observation/deadline interval and hard producer/candidate/byte/node
  ceilings.

A collection is complete only when every expected producer has exactly one
`candidate_batch_complete` disposition. On an incomplete path the collector:

- records deterministic producer summaries and reasons;
- leaves `candidates`, `candidateSetInputHash`, and `candidateBatchSetHash`
  `null`;
- sets `readyForRouting:false` and `executionEligible:false`;
- enforces aggregate retained-byte and declared-candidate ceilings, but does
  not parse, hash, semantically validate, or credit successful-peer candidate
  contents.

On a complete path the collector verifies each canonical byte hash, checks JSON
depth before parsing, parses and recaptures the value, requires byte-for-byte
canonical re-encoding, validates candidate owner/request/snapshot/capability
bindings, enforces aggregate node/count/byte limits, and returns an immutable
canonical candidate set with `readyForRouting:true`.

The collector intentionally does not recompute the full `ActionCandidateV1`
payload hash or create a `CandidateFrontierV1`; the current Candidate Router V1
remains the owning validator for those semantics. Trusted composition passes a
complete collection's immutable candidates to that router only after a
separately qualified live module-currentness gate succeeds.

## Failure and recovery semantics

`candidate_batch_timeout` means the execution layer observed its timeout
policy, not that arbitrary code or descendants stopped. Such a disposition is
incomplete. The execution layer retains resource ownership and reconciliation
responsibility until it can issue an independently supported terminal
disposition.

A complete disposition cannot smuggle a failure code. A failure disposition
cannot carry candidate bytes. Missing, duplicate, extra, qualification-
substituted, subject-spliced, future-completed, authority-bearing, or
external-effect-bearing dispositions fail closed.

Exact repeated input bytes yield the same result. The collector performs no I/O
and grants no writer, provider, release, submission, execution, or production
authority.

## Bounds

Compiled ceilings are:

- 1,024 expected/received producers;
- 4,096 total candidates;
- 4 MiB per canonical producer batch;
- 32 MiB total retained canonical batch bytes;
- 131,072 captured data nodes per complete collection;
- depth 48;
- 16,384 items per dense array;
- 64 KiB per string.

Caller values may narrow these ceilings but cannot widen them.

## Verification

`paper-core/tests/candidate-disposition-collector.test.mjs` covers deterministic
batch and producer ordering, explicit empty completion, every incomplete
disposition, missing/duplicate/extra producers, qualification substitution,
canonical bytes and hash mismatch, duplicate JSON keys, owner and subject
splicing, per-batch/aggregate/node/count bounds on both complete and incomplete
paths, authority and external-action claims, future completion, accessors,
sparse arrays, Unicode scalar handling, special keys, caller mutation,
failure-byte smuggling, no-credit partial paths, and deep JSON rejection.

These controls are source conformance. They do not authenticate module
qualification, prove producer isolation, perform live revocation readback,
certify timeout settlement, create an atomic snapshot, select a plan, or close
target-host and external-authority gates.
