# Scientific runtime execution: Rust development handoff

This is an executable **trusted-local / shadow** adapter, not full Node business
parity or a production qualification. Rust owns dispatch, process supervision,
input/output verification and workflow integration. Python, R, Lean and TeX remain
external scientific tools; wrapping a Node business worker is not part of this
implementation. No global module state, accepted-parity count, production gate,
writer-cutover decision or Node-retirement permission is advanced here.

## Implementation and complete execution chain

The implementation is `rust/crates/hepta-paper-service/src/scientific_runtime.rs`.
The first-party Rust process entry point is `hepta-scientific-worker`; it is used
through the existing `WorkerBindingV1::Process`, not a second scheduler or writer.

```text
LocalWorkflowV1 -> immutable step input and candidate -> run_service_v1
-> registry / policy / reservation -> durable ServiceExecutorV1 dispatch intent
-> exact hepta-scientific-worker executable + profile file + job hash
-> fixed scientific-tool argv -> bounded process-group supervision
-> unchanged input/runtime checks -> regular output files -> named manifest
-> existing prepared-result journal + hash-verified CAS -> SQLite sequencer
-> next step resolves an explicit artifact name from that committed output set
```

The service remains the only owner of admission, leases, prepared-result replay,
commit and budget settlement. It conservatively charges the admitted upper bound,
not measured CPU or actual scientific cost. The new adapter opens no campaign
journal and contains no Node business-worker dispatch. Hash selection still
requires review of what the selected executable actually is; a hash alone cannot
prove its implementation language. No provider or submission integration is added.

## Runtime selections and actual guarantees

| Profile runtime | Capability | Required source | Fixed tool invocation | Evidence available |
|---|---|---|---|---|
| `python_empirical` | `CAP-EMPIRICAL` | `main.py` | Python `-I -B main.py` | Actual experiment/program execution and explicitly collected outputs. |
| `python_numerical` | `CAP-NUMERICAL` | `main.py` | Python `-I -B main.py` | Actual numerical program execution, not only the built-in linear solver. |
| `r_empirical` | `CAP-EMPIRICAL` | `main.R` | Rscript `--vanilla main.R` | Source adapter present; R execution is not covered by the local validation reported with this increment. |
| `r_numerical` | `CAP-NUMERICAL` | `main.R` | Rscript `--vanilla main.R` | Same source-only runtime qualification boundary as above. |
| `lean` | `CAP-FORMAL` | `main.lean` | Lean `-o proof.olean main.lean` | Source adapter present; no claim of kernel audit, axiom policy, Lake dependency closure or independent proof acceptance. |
| `pdf_latex` | `CAP-BUILD` | `main.tex` | Canonical pdftex executable, explicit pdflatex format/program, no first-line parsing, restricted input/output, no shell escape, halt on error, job name `paper`. | Actual one-to-three-pass PDF compilation. PDF output is checked for framing only, not parsed or scientifically accepted. |

For TeX, the exact argv additionally contains `-fmt=pdflatex`,
`-progname=pdflatex`, `-no-parse-first-line`, `-cnf-line=openin_any=p`,
`-cnf-line=openout_any=p`, `-no-shell-escape`, `-interaction=nonstopmode`,
`-halt-on-error`, `-file-line-error`, `-jobname=paper`, `main.tex`.
This handles installations where `pdflatex` is a symlink to `pdftex` without
executing a mutable symlink. It does not implement BibTeX, arbitrary shell tools,
format installation, package download, publishing or release signing.

## Closed job and profile contracts

`ScientificJobV1` uses camelCase fields, version one, a `files` map of relative
names to UTF-8 content and an `outputs` list of `{path, format}`. The formats are
`bytes`, `utf8`, `json`, `pdf`. Enum strings use snake_case. Unknown typed fields
are rejected; no request field may select an executable, argument vector or
environment variable. Maps are ordered before the typed job is hashed. This is
not a general-purpose raw-JSON canonicalization standard.

The [complete executable Python job](examples/scientific-python-job.v1.json)
reads four actual input observations and writes count, mean and sample variance.
Tests import this exact file with `include_str!`; they do not maintain a separate
copy of the documented program. Its result is count 4, mean 5 and sample variance
20/3. These are test data, not evidence of a real scientific discovery.

`ScientificRuntimeProfileV1` is closed camelCase JSON with these required fields:

| Field | Contract |
|---|---|
| `version` | Exactly 1. |
| `runtime` | One of the six profile runtime strings above; fixes capability and argv. |
| `executable`, `executableHash` | Canonical absolute regular tool path and exact SHA-256 of its bytes. |
| `runtimeFiles` | Map of up to 128 additional canonical absolute regular files to exact SHA-256. This is an explicit operator inventory, **not** automatic transitive library/environment closure. |
| `jobHash` | SHA-256 of the complete typed job, including all source/data and requested output names/formats. Changing any program/input/output requires a new admitted profile. |
| `scratchRoot` | Existing canonical private mode-0700 directory. Each dispatch creates a new child and never adopts an old attempt. |
| `timeoutMs` | 1–3600000, shared across compiler passes. Runtime identity checks within the pass loop consume this budget; setup/validation and termination cleanup are additional bounded work. |
| `maximumOutputBytes` | 1–524288, cumulative across requested output files. |
| `passes` | Exactly 1 except `pdf_latex`, which permits 1–3. |

Inputs contain 1–64 files and at most 524288 UTF-8 content bytes in total.
There are 1–32 outputs, each nonempty, within the cumulative profile output limit.
Names have 1–256 ASCII bytes; only alphanumeric characters, `_`, `-`, `.` and
relative `/` separators are allowed. Empty, dot-prefixed, `.`/`..` components,
absolute paths, backslashes, duplicates and file/directory-prefix conflicts are
rejected. Source and output paths cannot collide. Nested input directories are
created privately; the program must create any new output-only subdirectory.
`pdf_latex` must request `paper.pdf` in `pdf` format.

Each runtime file is limited to 256 MiB; the executable and additional inventory
are limited to 512 MiB combined. Files must be canonical, regular, singly linked
and not group/world writable. Reads use bounded no-follow, nonblocking descriptors
with before/after metadata and named-inode comparison. Outputs must retain the
attempt owner and remain inside the private attempt. FIFOs, links, directories,
changed input bytes and unsafe file identity fail without prepared success.

## Profile setup and service binding

Build from the repository root using the pinned toolchain and lockfile:

```sh
cargo build --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --bins
hepta-scientific-worker job-hash /canonical/scientific-python-job.v1.json
hepta-scientific-worker file-hash /canonical/python-executable
hepta-scientific-worker file-hash /canonical/profile.json
```

These setup commands print `sha256:...` identities and do not run the job. Paths
must be canonical; resolve installation symlinks before selecting the executable.
The job hash is a typed hash, while the profile/file hash binds exact file bytes.

Register the first-party worker executable as an isolated process, with its actual
binary SHA-256 and a configuration hash over the complete `WorkerBindingV1`.
Use fixed arguments `[/canonical/profile.json, sha256:<exact-profile-bytes>]`,
`implementationLanguage: "rust"`, `networkDeclared: false`, and include the profile
file in `codeFiles`. Select a private canonical working directory and an outer
worker timeout covering setup, all tool passes, verification and cleanup. The
runtime profile independently binds the selected scientific executable and its
explicit runtime inventory. Do not label an arbitrary Python/Node process as the
first-party Rust worker or omit its configuration file from the service binding.

The worker consumes the existing closed stdin envelope
`{version:1, execution:ExecutionRequestV1, input:ScientificJobV1}`. The service, not
a caller-authored pretend receipt, supplies the execution identities. The worker
checks the snapshot/candidate match, capability and zero provider/external/writer
requests before tool dispatch. Stdin and the encoded response are each capped at
1 MiB. The complete registry/template assembly is exercised in
`rust/crates/hepta-paper-service/tests/scientific_workflow.rs`.

## Named artifacts and downstream wiring

The worker returns the actual requested files plus one closed
`scientific_execution_manifest_v1` artifact. It records exact input hashes,
executable/job identity, output names/formats/hashes/byte counts and pass log
hashes/counts. It contains `scientificAcceptance:false` and
`productionQualified:false`. Raw stdout/stderr and scratch paths are not returned.
Manifest and file bytes use the existing base64 `WorkerResponseV1` transport and
are independently inserted/verified in CAS by the service.

Prepared results sort/deduplicate CAS hashes; array position is not a filename.
The optional `ArtifactBindingV1.artifactName` resolves a file from the committed
scientific manifest instead:

```json
{
  "fromStep": "experiment",
  "artifactIndex": 0,
  "artifactName": "result.json",
  "targetPointer": "/job/sections/0/body",
  "encoding": "utf8"
}
```

When `artifactName` is present, `artifactIndex` must be zero and is not used for
selection. The resolver requires exactly one closed manifest, the correct source
capability, unique safe names, valid declared formats, exact lengths/hashes and
complete membership of the manifest and its output set in the preceding committed
prepared result. Added unrelated artifacts, missing outputs, false membership,
changed CAS bytes and claimed production/scientific acceptance all fail closed.
This proves content membership, not independent execution or scientific merit.

Omitting `artifactName` preserves the existing index contract and exact serialized
bytes of old definitions: `None` is skipped rather than serialized as a new null
field. Encoding still controls whether the verified bytes become UTF-8 text,
parsed JSON or a digest. Prior-step and JSON-pointer restrictions remain in force.
A dynamic prior output changes the complete admitted job hash; callers must not
reuse an old fixed profile when bound scientific input has changed.

## Failure, replay, security and operational recovery

Errors are the bounded `ScientificRuntimeError` categories: `Contract`, `Identity`,
`Execution`, `Output`, `Filesystem`. The CLI emits one generic failure line and no
partial success response. Nonzero exit, timeout, log truncation, failed process
group cleanup, runtime/input drift, missing/invalid outputs and oversize content
cannot become a prepared success. Stdout/stderr each allow 64 KiB per pass; process
termination grace is 100 ms and cleanup timeout is 1000 ms.

The child starts from a fresh environment with `LANG=C.UTF-8`, fixed PATH and
attempt-local HOME/TMPDIR. No inherited credential variables, developer home or
shell command is forwarded. This **does not** prevent a same-UID trusted program
from reading other files, loading undeclared libraries, opening a network socket,
creating detached children or consuming unmetered host resources. Complete runtime
closure, hostile-code containment, live cancellation and target-host qualification
remain separate work. Only explicitly reviewed trusted local programs with no
external effects belong in this profile. A false external-effect flag is not an
independent proof that an external effect was impossible.

Successful and failed scratch directories are retained, not reused or silently
deleted. Operational cleanup is an explicit owner action after reconciliation;
this adapter does not implement production retention or garbage collection. The
service fsyncs intent before invoking the worker. An exact prepared/committed
attempt replays its recorded bytes without another launch or debit. Started work
without a durable prepared record remains ambiguous and is not automatically
rerun. This is at-most-once automatic dispatch with fail-closed ambiguity, not a
claim of exactly-once arbitrary external computation or automatic crash repair.

## Tests and acceptance boundary

```sh
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test scientific_runtime
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test scientific_workflow
cargo test --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --test scientific_runtime actual_latex_compilation_produces_pdf_not_a_json_bundle -- --exact --ignored
cargo clippy --manifest-path rust/Cargo.toml --locked -p hepta-paper-service --all-targets -- -D warnings
```

Python is required for the ordinary runtime tests. LaTeX is an explicitly selected
tool-equipped-host test; an ignored ordinary test does not count as a passing
compiler scenario. R/Lean runtime tests are not claimed by this increment. The
Python tests execute actual programs for empirical statistics and numerical ODE
integration. Hostile tests exercise hash/capability drift, paths/links/FIFOs,
unsafe files, changed source, timeout, nonzero exit, malformed/oversize output and
log overflow. CLI setup is exercised without dispatch. Workflow tests execute the
actual Rust worker, wire its real named result into a manuscript and bundle,
commit through SQLite, replay without reexecution/debit and refuse corrupt CAS or
ambiguous failed work.

Acceptance of this source requires the exact commit/tree, passing relevant tests
and independent review. Full scientific/runtime parity still needs representative
legacy workloads, dependency closure, runtime-specific proof/replication checks,
resource qualification and current external evidence. Live models, general author
and reviewer repair loops, in-flight cancellation, maintenance, full Node command
parity, production activation, writer handoff and Node retirement are not closed
by these tests or this document.
