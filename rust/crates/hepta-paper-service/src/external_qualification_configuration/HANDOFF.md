# External qualification configuration: native V3 read-only owner

## Scope and actual consumer

`read_external_research_qualification_process_configuration_v3` ports the owning
configuration reader in
`paper-adapters/automation/external-research-qualification-process-identity.mjs`.
`inspect_external_research_qualification_process_configuration_v1` consumes that
reader and ports the diagnostic projection in the original process adapter.
Neither function invokes the qualifier, verifier, provider or any subprocess.
No receipt is signed, no process protocol runs, and no qualification or recovery
capability is produced. This is a local configuration observation, not an
independent attestation or a production installation qualification.

The API takes an explicit environment map and absolute working directory. An
explicit nonempty configuration path takes precedence over
`HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG`. Relative configuration and
interpreter paths resolve against the supplied working directory; command,
credential, public-key and argument resource paths resolve against the actual
configuration directory. No ambient environment is silently substituted.

## Public API and lifecycle

The public opaque `Configuration` has no caller-supplied JSON constructor. Its
`identity()` exposes the original reader's JSON projection, omitting only the
top-level `publicKey`/`verifierPublicKey` JavaScript KeyObjects and each
`trustedSignerKeys[i].publicKey`. Every other original field is retained,
including each trust key's `publicKeyContentHash`. `inspection()` exposes the
original complete inspection projection and production hash. These are completed
diagnostic values, not authority tokens and not automatic live-currentness.

`assert_current()` explicitly rechecks the originally opened objects, their
names, raw content hashes, credential directory listings, missing/nonregular
argument resource observations and interpreter PATH selection. It fails on
observed drift without replacing the baseline. Changes between sequential
observations remain possible: there is no atomic cross-file snapshot, lock,
credential rotation protocol or exclusion of noncooperating same-UID writers.
The owner retains its supplied environment observation; a caller changing those
explicit inputs must reconstruct the configuration. It does not monitor ambient
process environment changes.

The two public PEM accessors expose only actual configured public signing keys.
The release-attestor role remains `research_execution_release_attestor`, and the
verifier role remains `external_qualification_independent_verifier`. Neither is
silently relabeled as a recovery authority. The original recovery adapter's
incompatible role/algorithm/key-version/KeyObject assumptions are a separate
unresolved contract and are not repaired by this reader.

All retained file and directory owners must be dropped **before opening any
business SQLite connection or long-lived database descriptor**. An arbitrary
argument resource may alias a database; later closing another regular descriptor
can release POSIX record locks held by the same process. No caller may retain
this owner through that SQLite lifecycle. The inspector closes its complete
owner before returning its plain diagnostic value. It does not open SQLite.

## Identity contracts preserved

`command.rs` validates exact command keys, protocol, IDs, arguments, allowlist and
timeout. It preserves JSON-data JavaScript String conversions for IDs and
allowlist keys, Number timeout conversions, UTF-16 argument length, Set semantics
for JSON allowlist entries, restricted child environment, shebang and `env` PATH
selection. A newly executable earlier PATH candidate invalidates an existing
owner even when its old interpreter still exists unchanged. It never executes
an interpreter to discover its identity.

`files.rs` hashes actual command, interpreter, argument and credential files.
Credential traversal preserves Node's UTF-16 filename order, depth-first entry
projection, root UID/per-entry mode checks, regular-file hardlink rejection,
10,000-file and 256 MiB per-root limits, content-hash set and domains:

- `ExternalQualificationCredentialRootContentsIdentity`
- `ExternalQualificationCredentialRootIdentity`
- `ExternalQualificationInterpreterIdentity`
- `ExternalQualificationChildEnvironmentIdentity`
- `ExternalQualificationProcessCommandIdentity`

This is the external-qualification identity contract, not the runtime-image
identity contract. Node's binary64 string projection of stat device/inode values
is preserved in JSON; retained descriptor comparisons use full kernel integers.
Credential bytes are hashed but never retained as plaintext or included in a
report. `privateSigningKeyLoaded: false` means no private key is parsed or loaded
for signing; it must not be interpreted as proof that the configured credential
tree contains no secrets or that hashing performs no credential-file reads.
Public-key documents must contain a public PEM and must not contain the original
forbidden private-key PEM markers.

`trust.rs` preserves exact key shapes, canonical Node ISO timestamps, the active
nonrevoked signer count, retiring/revoked historical entries, source-approved
Ed25519 SPKI public-key parsing, unique key/version tuples and SPKI identities,
qualified en-US trust-key sort, and signer/verifier identity and organization
independence. There is no invented current-time admission gate: the source reader
checks canonical ordered validity windows, not whether the current clock lies in
them. Organization normalization uses Unicode 17 NFKC; the admitted organization
alphabet is ASCII under the original regex.

Configuration/trust/client/verifier service identities and inspection hashes use
the original production hash domains through `hepta-legacy-compatibility`.
Completed projections use production JSON number encoding. Failure order follows
the reader: configuration, qualifier command, verifier command, process
independence, trust set, verifier attestor, signer identity independence and
organization independence. Original non-array falsy allowlists retain their
generic inspection failure rather than being silently replaced with empty lists.

## Real filesystem observation

Canonical target ancestry is opened from `/` using retained directory descriptors
and descriptor-relative `O_NOFOLLOW | O_CLOEXEC` operations. Regular files also
use `O_NONBLOCK`; a FIFO is refused without waiting for a writer. Configuration,
public-key and credential-root paths must already be canonical, as in Node.
Executable, interpreter and argument aliases are supported and their requested
path resolutions are explicitly rechecked. Ancestor mode/UID/GID/device/inode
and original file mode/UID/GID/link count/size/mtime/ctime/device/inode are retained
and checked; file content is hashed again through its original descriptor.
These checks do not certify root ownership, exclusive access or a Rust binary.
Writable unrelated ancestors are not upgraded into trusted production roots.

Credential enumeration opens `.` relative to the held directory and opens each
child without following symlinks. Siblings consume the shared entry budget before
sorting/recursion. Listings are reobserved, so additions, removal and rename are
not hidden by retaining the original file descriptors. Parent directory mtime and
link count are not treated as identity: unrelated siblings may change. Metadata
and name checks detect observed namespace changes but do not make those checks
atomic with an external actor's mutations.

Files are bounded before reading; the aggregate stat-byte reservation is made
before any content hash. Each read/hash consumes at most its observed size plus
one overrun byte, also enforcing the original per-file maximum. Failed reads do
not mutate source files. Resource exhaustion and I/O failures fail closed.

## Explicit native profile restrictions

This slice does not claim acceptance of every possible Node input:

- Original config/public/executable limits remain 256 KiB, 64 KiB and 1 GiB.
  Additional native limits are 1 GiB per interpreter/argument resource, 4 GiB
  aggregate observed file bytes (including repeated observations), 21,000
  retained regular files and 21,000 retained directories.
- Each credential tree additionally has at most 20,000 entries including
  directories; absolute directory ancestry is limited to 128 path components.
  The original Node reader has no corresponding directory/depth bound.
- The effective captured child environment is limited to 2 MiB of key/value
  bytes. Each interpreter search is limited to 4,096 nonempty PATH candidates.
- Filesystem paths/names must be valid UTF-8 and contain no NUL. JSON containing
  unpaired UTF-16 surrogate values or overflowing number literals is rejected
  by the native JSON parser. Distinct collation-equivalent JSON object keys
  unsupported by the production `Value` hash adapter fail closed. No arbitrary
  JavaScript object coercions, accessors or executable values are supported.
- Revalidation conservatively retains metadata for skipped nonregular argument
  resources: a changed directory argument can invalidate an old owner even
  though a fresh Node reader would continue omitting it from argument identities.
- Raw PEM decoding follows the bounded standard Ed25519 SubjectPublicKeyInfo
  representation, not every OpenSSL permissive encoding. Public key parsing
  does not add signature-point validation to the source configuration contract.

Native budget/profile refusals have explicit `external_qualification_*` codes.
I/O failures project the source's stable
`external_qualification_configuration_inspection_failed` blocker. A production
hash-profile failure never fabricates a hash or a ready inspection.

## Verification and remaining work

Private `files_tests.rs` uses only owned regular files, nonsecret credential
markers, symlinks and a FIFO. It covers exact config size/excess, mode, no-follow
paths, retained parent/leaf substitution, same-inode same-length modification,
credential add/remove/rename/content drift, actual bounded directory enumeration,
production count/byte budget boundaries and sparse oversized metadata rejection.
These are file-producer tests, not production UID installation or provider tests.

The root-owned `external_qualification_configuration_parity` integration target
and `rust/oracle/external-qualification-configuration-v3.mjs` compare the complete
native reader/inspection projections against the actual original Node reader on
the same owned fixture, including real Ed25519 public keys generated in memory.
Private keys are never written to disk and configured commands are never run.
Execution results are recorded by the root task after source freeze; this
handoff does not treat an unexecuted test as passed.

Remaining work includes actual resident-prerequisite consumption, the separately
versioned recovery trust decision, qualification pointer/per-paper state readers,
independent process protocol/receipt verification where applicable, installation
qualification and full autonomous health composition. This completed reader
alone does not close those gaps or establish Node replacement for those paths.
