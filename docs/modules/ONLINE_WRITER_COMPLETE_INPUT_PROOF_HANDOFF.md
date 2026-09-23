# Complete source inputs for repeated static proof validation

The opaque writer source proof retains complete inputs from its initial AST scan. Component and consumer validation are tracked separately; neither grants production activation.

## Problem and behavior

The prior opaque `VerifiedWriterStaticCoverageV1` reruns the complete Oxc source/import/scope analysis every time a consumer asks whether its evidence is still current. A real passive inspection invokes that boundary repeatedly. On the complete source fixture, the unoptimized native passive operation took 343–361 seconds while the original Node report completed roughly two seconds later. This affects usability and the age of authority evidence during IO.

The initial native proof still performs the full original AST analysis. Before that analysis, a private `CompleteStaticInputs` observes the complete input set. The verified AST and SQL enumerations are derived directly from this captured set, including when a captured directory temporarily disappears. Every actual AST, migration, provenance, and declared-source read must match that set's file identity and SHA-256. A final complete revalidation is required before constructing the opaque proof. The original report, operation list, provenance subset, receipt hashing, import analysis, scope analysis, and pure descriptive inspection retain their behavior.

Later `assert_current()` calls re-open and hash all captured files through retained parent descriptors and compare exact file identity and contents, complete scanned directory namespaces, migration namespace, and directory identities. Unchanged bytes give the same AST result; reparsing unchanged inputs is unnecessary. This is a proof-owned input snapshot, not a global mutable source cache. No Node process runs inside the implementation.

## Retained scope and rejection boundaries

- Every regular file below every configured recursive scan root is retained in the private input set, including files with no writer, excluded sources, and non-module neighboring files. Every scanned directory has a complete sorted byte-name namespace.
- The complete direct migration namespace is retained, and all `.sql` inputs are observed even when their current SQL is non-mutating. Fixed provenance sources and manifest-declared sources outside the scan roots are included explicitly.
- Every named directory from `/` through the selected root, scan trees, migration root, and source parents is opened with no-follow semantics and held. Currentness compares device, inode, owner, group and mode. Directory child-count changes in unrelated ancestor directories do not invalidate identity; scanned namespace changes are checked separately.
- Source files are opened one at a time relative to held parents with no-follow and nonblocking flags. The entire bounded byte stream is hashed. Device, inode, mode, hardlink count, size, modification/change timestamps, owner and group are checked before and after reading and against the original observation. Named paths and held ancestors are checked again. No persistent descriptor is required for each of the 1,033 source files.
- New, deleted, renamed, replaced or modified input files and scan directories refuse the old proof. Missing optional roots are recorded as absent and cannot silently appear. Aliases, non-regular entries in scan trees and unreadable observations refuse the opaque proof. The public descriptive inspection is unchanged; this strict private observation does not convert a report into authority.
- Bounds are 20,000 files, 4,096 held directories, 20,000 entries per directory, scan depth 128, 256 absolute path components (including the root component), 16 MiB per file, and 512 MiB aggregate file bytes. Absolute paths are checked before recursive parent lookup or opening, and the descriptor budget is checked again after uncached ancestors are opened. Resource exhaustion and an exhausted file-descriptor budget return an error; no input is skipped.

Observation boundaries remain explicit. This does not claim a distributed or global filesystem lock. Callers must retain their existing source-currentness checks at authority and publication boundaries. The implementation does not authorize a write or extend the age of signed evidence.

## Integration

`online_writer_static/inspection.rs` owns the private `proof_inputs.rs` observer.
`tests/online_writer_complete_inputs.rs` exercises complete currentness; the
original Node parity target verifies unchanged receipt and discovery behavior.
No root-module or Cargo dependency change is needed. Fixed source-regex reuse
and the per-parse declaration index preserve the AST's original semantics.
The FD-budget regression invokes Linux `prlimit` only in isolated test children;
the library adds no production process or CLI dependency.

## Validation

The exact final source passed all six `online_writer_complete_inputs` integration tests in 15.10 seconds and the unchanged four original-Node `online_writer_static_parity` tests in 22.96 seconds; both binaries exited zero. The latter checks every actual production writer module and complete repository reports, provenance and receipt hashes against Node. All eight static unit tests passed in 1.33 seconds (zero exit), including six private-input tests, the non-regular read regression and the separate AST-index equivalence test. Strict Clippy over the library and both integration targets passed in 7.51 seconds.

The actual AST regression includes a complete ten-role fixture and an unregistered JS writer or SQL migration. It captures the full inputs, temporarily moves that source's parent directory out of the scan, and shows the original live enumeration would report complete. Restoring the directory preserves every file's bytes and identity, and all end-boundary currentness checks alone pass. The verified gate instead enumerates the captured paths and refuses the hidden source before an opaque proof can exist. This covers the initial enumeration window, in addition to later source-currentness checks.

With the separately validated immutable AST declaration index, the complete initial Oxc proof took 11.54 seconds in this run; five subsequent full-byte, identity and namespace checks took 645–678 milliseconds each. These are observed timings under the current shared host load, not a general throughput guarantee. The separate real passive-composition pipeline with the captured-enumeration fix and AST index passed all three groups in 327.41 seconds with exit zero (`/tmp/hepta-safety-proof-index-final.log`). It retains all real database, backup, signature, source and zero-RPC checks. This consumer run predates only the final path/descriptor-bound guard described below.

Reproducible log references for this run: `/tmp/hepta-static-proof-enumeration-final.log`, `/tmp/hepta-static-proof-enumeration-all-units.log`, and `/tmp/hepta-static-proof-enumeration-final-clippy.log`. The external handoff file list records each exact tested SHA-256. Earlier static-proof logs and the first consumer-combination run predate the captured-enumeration fix and are not evidence for this final revision.

The final bounded-path guard also rejects a 100,000-component input before recursion/open, covers exact component-boundary behavior and checks the directory-descriptor limit after recursive ancestor opening. Its final library run passed 81 tests in 55.48 seconds; one existing subprocess-helper test is intentionally ignored when run directly and is exercised by its parent lock tests. All six input integration tests passed in 14.36 seconds, and strict selected-target Clippy passed in 4.40 seconds; every command exited zero. These results are in `/tmp/hepta-static-proof-path-bound.log` and `/tmp/hepta-static-proof-path-bound-clippy.log`. The full passive suite was not repeated for this narrow guard; project-wide workspace verification is recorded separately during integration.
