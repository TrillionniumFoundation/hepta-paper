# Operations

Use `npm run hepta-paper -- <operator|verify|maintenance|retirement> <command>` as the
supported operator surface. `npm run scripts:surface` prints the complete
operator, verification, maintenance, retirement, compatibility, experimental
and internal classification. Maintenance commands rewrite accepted repository
evidence; compatibility and experimental scripts are not production operator
entrypoints.

Machine protocol executables are installed separately from this human command
surface. Before configuring `codexBinary`, a same-host state-authority client,
or the bounded local release-attestor client, follow
[`operational-process-entrypoints.md`](operational-process-entrypoints.md).
Their source files are non-executable; the reviewed host installer creates the
root-owned `/usr/libexec/hepta-paper` launchers and records their hashes.

## Before running campaigns

```bash
npm run store:migrate
npm run store:status
npm run automation:status
npm run safety:all
```

Inspect universal submission coverage without network or credential access:

```bash
npm run automation:journal-connector-coverage -- --summary
npm run automation:journal-connector-coverage -- \
  --summary --kind journal --require-family-prototype
npm run automation:journal-connector-coverage -- --venue <venue-id>
```

This is a source and target-registry inspection only. Do not interpret a
candidate-family prototype as portal authorization. Before enabling a target,
complete the portal-binding, terms, schema, sandbox, canary, credential,
independent-receipt and human commit-approval checklist in
[`universal-submission-system.md`](universal-submission-system.md).

## Local autonomous research

The default operating profile is local-only:

```bash
npm run hepta-paper -- operator autonomous-research -- \
  --action prepare --paper-id <paper-id>
```

This is equivalent to `--launch-mode local-run`. It uses the existing bounded
local execution path and local author/reviewer processes. It does not require
an external author attestation, HSM/KMS, off-host replay, runtime attestor,
submission portal or strict production acceptance. Dataset mounts are required
only when the selected protocol actually uses data. Cost, wall-time, process
and compute budgets remain enforced.

Use `--launch-mode production-run` only for a deployment that intentionally
needs external trust and unattended submission. The production machinery below
is optional and is not a prerequisite for local paper generation.

## Declared-capability autonomous research

The production composition can run without a runtime human checkpoint when all
machine trust and resource dependencies are provisioned before launch. Configure
the complete declared-capability path with:

For final deployment convergence, first let the independent machine authorities
materialize the public authority documents and opaque secret-reference files
named by `paper-core/deploy/strict-full-auto-acceptance.config.example.json`,
replace all hash/path/argument placeholders, then use the unattended atomic mode:

Strict convergence may bind author and reviewer to the same private
`research-author-credential-root`. Each review still runs in a new ephemeral,
non-resumable session against a frozen read-only artifact package. Full
production additionally requires the author principal to carry a pinned,
externally signed provider/platform identity attestation. A separate reviewer
account remains optional when fresh-session and frozen-artifact isolation hold.

```bash
npm run hepta-paper -- operator strict-full-auto-acceptance -- \
  --action converge --configuration /run/hepta/strict-full-auto-acceptance.json \
  --execute --require-accepted
```

`converge` performs the same side-effect-free complete preflight as `plan`, then
passes that exact in-memory plan hash to `execute`; no operator copies or approves
an intermediate hash. The separate `plan` and hash-confirmed `execute` actions
remain available for controlled deployments.

For reboot-persistent convergence, install
`paper-core/deploy/strict-full-auto-acceptance.service` and its
`strict-full-auto-acceptance.timer`, copy
`paper-core/deploy/strict-full-auto-acceptance.env.example` to
`/etc/hepta-paper/strict-full-auto-acceptance.env`. The reviewed host installer
leaves the timer, service, resident research supervisor, and submission
dispatcher disabled and stopped. Enable the timer only as a separate reviewed
activation after the strict operator has produced current accepted readiness;
`--enable-full-auto` on the installer remains fail-closed until that readiness
can be proven by a non-mutating repository preflight.
It starts the resident research and dispatcher units, retries failed preflight
or external authority checks subject to the units' five-start-per-15-minute
limit, and revalidates live acceptance every five minutes after each completed
run. Both research-side units require every secret-mask target to exist before
systemd admits a start; the non-optional `InaccessiblePaths` bind therefore
cannot be silently skipped and remains effective if the underlying secret is
later rotated. They do not receive the submission portal secret and cannot
manufacture a missing principal,
credential, signature or KMS/HSM response; external authority provisioning
remains a machine/deployment responsibility. Docker group access is
root-equivalent, so use this unit only on the dedicated research host.
The acceptance runner treats only exit code `2` plus a complete, plan-bound
assertion projection as semantic `not-ready`. Exit code `1` and every malformed,
partial or diagnostic failure are infrastructure failures and never trigger a
renewal action.

The systemd deployment binds four non-overlapping roots into the acceptance
plan: writable control and runtime roots under `/var/lib/hepta-paper`, plus
independent read-only `/srv/hepta-paper/assets` and
`/srv/hepta-paper/datasets` roots. Do not place the dataset root below the asset,
runtime, or control root. The unit sandbox lists both input roots in
`ReadOnlyPaths`; persistent writes remain confined to `/var/lib/hepta-paper`,
with only the declared `/run` handoff paths additionally writable.

The plan pass has no mutation or child-process side effect. Execute preflights
the same complete reference inventory before creating its first checkpoint,
uses only repository-owned allowlisted entrypoints, and emits a hash-bound
checkpoint receipt. That local file is never acceptance authority: execute and
status both rerun every external verify invocation and emit an ephemeral live
verification receipt before reporting `strictFullAutoAccepted=true`. Each
command, argument mode, authority path, environment reference and readiness
assertion is fixed by the repository contract. The state-provision child
`--plan-id` and online-transition `--transition-id` must exactly equal their
outer step `idempotencyKey`, so crash recovery cannot silently switch action
identity. Immediately after state provisioning, its verify phase runs the
read-only online-transition plan and requires that plan's transition ID to equal
the next step's exact `--transition-id`. Full database-inventory readiness is
asserted only after that transition executes, together with the anti-rollback
assertion. It does not read or generate private keys and cannot mint
an external identity, signature, golden receipt, portal credential, or KMS
challenge itself.

Do not prepare the complete strict-acceptance inventory while the first
external dependency is still missing. Check only the real author/KMS inputs in
one read-only command:

```bash
node paper-core/bin/hepta-paper.mjs operator external-authority-intake -- \
  --author-config /run/hepta/research-author-identity.json \
  --author-config-hash sha256:REPLACE_WITH_OUT_OF_BAND_CONFIGURATION_HASH \
  --release-attestor-config /run/hepta/research-execution-release-attestor.json \
  --release-attestor-config-hash sha256:REPLACE_WITH_OUT_OF_BAND_RESOLVED_IDENTITY_HASH \
  --require-ready
```

The command verifies the current author authority envelope and KMS
control-plane bundle but forcibly disables all child-process execution. It
prints candidate hashes for comparison when a pin is absent or wrong; those
observed values are diagnostics, not a replacement for an independently
delivered pin. Only after this command is ready should deployment run one live
provider binding plus release probe/signing challenge. The final convergence
gate remains a one-time action after all later external dependencies are
present.

```bash
export HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE=agent-evidence-bound
export HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED=1
export HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG=/run/hepta/research-author-identity.json
export HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH=sha256:REPLACE_WITH_CONFIGURATION_HASH
export HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG=/run/hepta/research-execution-release-attestor.json
export HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH=sha256:REPLACE_WITH_RESOLVED_CONFIGURATION_IDENTITY_HASH
export HEPTA_PRIOR_ART_SERVICE_CONFIG=/run/hepta/prior-art-service.json
export HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH=sha256:REPLACE_WITH_CONFIGURATION_HASH
export HEPTA_EXTERNAL_REPLAY_CONFIG=/run/hepta/external-replay-service.json
export HEPTA_EXTERNAL_REPLAY_CONFIG_HASH=sha256:REPLACE_WITH_CONFIGURATION_HASH
export HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG=/run/hepta/runtime-reproducibility.json
export HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH=sha256:REPLACE_WITH_CONFIGURATION_IDENTITY_HASH
export HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG=/run/hepta/venue-profiles.json
export HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG_HASH=sha256:REPLACE_WITH_CONFIGURATION_HASH
export HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG=/run/hepta/submission-portal-descriptor.json
export HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH=sha256:REPLACE_WITH_CONFIGURATION_HASH
export HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH=sha256:REPLACE_WITH_PUBLIC_DESCRIPTOR_HASH
export HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG=/run/hepta/submission-metadata.json
export HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH=sha256:REPLACE_WITH_CONFIGURATION_HASH
```

The research/supervisor process must receive only the public portal descriptor
and both out-of-band hashes.
Run `autonomous-submission-dispatcher` as a distinct OS/Kubernetes principal;
its environment alone contains
`HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIG=/run/hepta/submission-portal.json`
and the token variable named by that complete configuration. The dispatcher
also receives the public descriptor and both pins and refuses production
dispatch unless the private configuration deterministically derives that exact
descriptor. Portal configuration v3, independent platform identity
attestations, a portal canary signer distinct from the dispatcher cycle signer,
and a fresh externally published challenge are mandatory; without a pending
challenge no portal network action occurs. The checked-in systemd/Kubernetes
templates keep the portal-token Secret and egress capability out of the
research principal.

The bounded author identity and reviewer pool are derived from the live Codex
capability receipts, shared credential-root metadata, distinct role IDs, and
fresh-session policies. Full production must also set
`HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG`,
`HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH`; the signed subject must bind the
active provider account, platform, author principal, and credential root.
Production uses author configuration v2: its out-of-band hash pins the stable
account/platform/trust policy while the host, process, challenge, timestamps,
subject hash, and signed envelope may rotate. Every rotated envelope is still
verified at the current clock and rebound to the live author principal; v1
exact-envelope pins remain readable but are bounded-only.
`HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG` remains an optional stronger compliance
mode, and all configured signature and separation checks remain fail-closed.

The release-attestor hash is an out-of-band SHA-256 pin over the resolved
configuration identity, not merely the JSON bytes. It binds the trust keys,
probe key, executable content and inode identities, credential-root identity,
restricted child environment, backend descriptor, and the stable v3 KMS
authority policy: trust-store hash, signer IDs, and challenge binding. The
configuration pins the bundle path, not a short-lived bundle byte hash. The
bundle is read through a no-follow, single-link descriptor and its signature,
time window, trust store, signer set, challenge and KMS identities are verified
on every read. An independently signed refresh can therefore atomically replace
the bundle without rewriting the release configuration or changing the
out-of-band pin. Full production requires the current bundle to bind the
provider/account, key resource, credential generation, active key, descriptor,
hardware protection and non-exportability. Version 2 remains bounded and
performs no KMS action. Version 3 uses signer protocol v2: every request binds
the authorization deadline, caps the child timeout to that deadline, and
revalidates the clock, configuration, active key and KMS authority after the
signer returns. Signer and probe commands must use empty argument and
environment allowlists; credentials remain behind separately mounted roots.

The strict acceptance configuration uses
`expectedConfigurationIdentityHash` for both
`research-author-identity-config` and `release-attestor-config`; neither
semantic reference carries an `expectedSha256` pin. The author configuration
may rotate with its subject/envelope; the stable release configuration need not
change when its signed KMS bundle rotates. Other content references remain
byte-pinned. Each plan inspection still snapshots the current files through
no-follow descriptors, verifies their stable semantic identities without
executing a signer or probe, and leaves current signature, expiry and KMS
action-time verification fail-closed.

The venue registry must be a signed version-2 configuration. Each profile
declares normalized scope terms and hard format/submission constraints; local
selection emits a fixed-point, all-candidate ranking receipt under the pinned
`scope-fit-constraints-v1` policy. The submission metadata profile is signed
separately. Both `*_CONFIG_HASH` values are out-of-band pins over their exact
trust stores and signature envelopes. Production release and submission
reverify both signatures at the current time and bind the ranking, formatting,
citation, metadata, portal, and post-render compliance receipts. Version-1
hash selection remains bounded-only and cannot satisfy strong production.

`HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH` and
`HEPTA_EXTERNAL_REPLAY_CONFIG_HASH` are mandatory out-of-band pins for full
production. A self-hash inside either document does not authorize replacement
of the complete endpoint and trust-store configuration. Both readers require a
single regular file that is not group/world writable.

`HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH` is likewise mandatory for full
production, but pins the resolved `configurationIdentityHash`, not only the JSON
bytes. That identity includes both verifier processes, interpreters, arguments,
restricted environments, credential-root contents, backend identities, and
Ed25519 signer trust. Run read-only `runtime-image-reproducibility --action
status` without the hash only to obtain a bounded candidate identity for
independent review; then provision the accepted hash out of band. Until it
matches, the system does not read the receipt authority or invoke a builder.

`HEPTA_EXTERNAL_REPLAY_CONFIG` must use version 4 for strong production. It
pins the replay-result Ed25519 trust store, one signed remote replay platform
and account identity bundle, and one or more signed local-origin identity
bundles. Every identity must use
`pinned-provider-account-and-platform-attestation-v1`; the remote signer,
provider account, credential root, host, process, and trust domain must all be
distinct from every local origin. Version 4 additionally requires signed
lookup/resume recovery outcomes bound to one operation ID and idempotency key,
so a supervisor crash cannot silently duplicate the external action. Versions
1 through 3 remain bounded audit formats and cannot satisfy generic production
readiness. Persisted v3 receipt payloads are reverified against the current
version-4 configuration and current time at campaign verification and release
packaging.

The empirical family registry is resolved once, while the process module graph
is initialized. With no override it uses the repository's Ed25519-signed,
content-addressed five-family bundle. A deployment may replace that bundle with
a separately signed data-only package and public-key trust store:

```bash
export HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_BUNDLE=/run/hepta/empirical-plugin-bundle.json
export HEPTA_AUTONOMOUS_EMPIRICAL_PLUGIN_TRUST_STORE=/run/hepta/empirical-plugin-trust.json
```

Both variables are required together. The package authority must carry the
`empirical_plugin_authority` role, have a currently valid Ed25519 signature and
use the exact pinned plugin/evaluator ABI. Symlinks, tamper, duplicate family or
profile identities, executable payload fields, unknown operators, and unpinned
runtime languages fail startup. The loaded registry cannot be reloaded or
mutated inside the process. In addition to the five synthetic conformance
families, the reviewed evaluator ABI exposes
`registered_scalar_response_benchmark`. A signed package can activate that
family over any operator-authorized dataset harness whose cases provide JSON
inputs, redacted ablation inputs, a scalar reference response and the exact
`lowerBound`, `robustTarget`, `target`, and `upperBound` host-only oracle fields.
The host derives squared-error, robustness and interval-violation events, and a
separate implementation recomputes the fixtures, events and metrics. This is a
data-only extension point: arbitrary plugin code is still forbidden, and a new
response type or scoring semantics remains a reviewed code-and-runtime release.

Advanced numerical profiles are released through the configured external
Ed25519 authority; the repository template is not an authority and contains no
signature or private key. The following command generates the canonical ML
template, asks the configured signer to sign its exact canonical authority
payload, verifies the result against the public trust store, and atomically
renames a content-addressed release directory into place:

```bash
npm run automation:autonomous-empirical-plugin-release -- \
  --action publish \
  --package-version 1.0.0 \
  --benchmark-family ml_algorithm_benchmark \
  --signing-config /run/hepta/empirical-plugin-signer.json \
  --install-root /run/hepta/empirical-plugin-releases
```

Use `--benchmark-family registered_scalar_response_benchmark` to publish the
generic scalar profile. Repeat `--benchmark-family` to include it alongside the
five repository production families in one externally signed package.

The signer configuration is owner-only (`0600`) and contains only the external
command, public trust-store path, authority lifetime, key ID, and an explicit
environment-variable allowlist. It must not contain private-key material. The
external command receives one `AutonomousEmpiricalPluginSigningRequest` JSON
object on stdin with `payloadBase64` and `payloadHash`, and returns one
`AutonomousEmpiricalPluginSigningResponse` with the same hash and a canonical
64-byte Ed25519 signature. This supports unattended KMS/HSM or isolated signer
processes without loading their private key into Hepta.

The successful report contains `activationEnvironment`. Configure the next
research process with those exact content-addressed `BUNDLE` and `TRUST_STORE`
paths. `--action inspect --activation .../activation.json` reopens the installed
files and repeats signature, ABI, hash, time-window, and activation binding
checks. Full autonomous readiness requires the selected agenda family to be in
the signed package and to cover all four advanced numerical oracle kinds; a
core-only or partially covered signed package remains fail-closed.

Every activated profile is compiled into `VersionedExperimentIR` before its
numeric process can run. The IR binds the three-arm design, estimator and metric
specifications, fixed stopping schedule, dataset contract, execution adapter,
plugin authority and typed numeric-oracle ABI. A release plan may carry an
advanced IR while it is pending external signature, but that IR records
`productionAuthorized=false` and cannot authorize a production campaign.

Dynamic formal claims may use the Real no-division ordered-ring polynomial
fragment only when the theorem authority permits `Mathlib` and the trusted Lean
runtime is pinned to a complete Mathlib project closure. The bounded Real
counterexample search checks exact integer embedding points: a witness refutes
the claim, while no witness remains inconclusive. Kernel verification, axiom
audit, independent semantic review and fresh replay remain mandatory.

Generic and production readiness additionally require the deployed Mathlib
project itself to be provenance-bound, build-authorized and executable. The
code trust anchor for Lean 4.30 is the official Mathlib `v4.30.0` release at
commit `c5ea00351c28e24afc9f0f84379aa41082b1188f` and Git tree
`1fe688f4d9e84fb268a300f8ac33cbca883fbd28`. Its Lake manifest entry must
exactly match the pinned type, URL, tag/revision, scope, config file, manifest
file, inheritance and null subdirectory fields. The materialized repository
must have that HEAD/tree/remote, a clean tracked worktree and the matching
package toolchain. Configure the canonical project location and expectation:

```bash
HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT=/srv/hepta-paper/formal/mathlib-project
HEPTA_DYNAMIC_FORMAL_PROJECT_SCOPE_ROOT=/srv/hepta-paper/formal
HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH=sha256:64b07e1b11ec2f87168612b964d84e350ab9e6e88129397a21694689b24f8412
HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE=HeptaMathlibReadiness.lean
HEPTA_PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIG=/run/hepta-authority/production-mathlib-build-authority.json
HEPTA_PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIGURATION_HASH=sha256:<externally-pinned-configuration-hash>
```

The reviewed host deployment also sets `ELAN_HOME=/opt/hepta-paper/elan`.
The complete Lean distribution at that path is sealed `root:root`, with
directories/executables at `0555`, data files at `0444`, and no writable or
symlinked ancestor, special mode bit, ACL or extended attribute. The resolver
uses its code-pinned layout and full-tree Merkle directly and never executes an
ambient Elan launcher. The complete
Mathlib project remains owned by the `hepta-paper` service principal with no
write bits. The probe must be a regular closure member containing `import Mathlib`; status
recomputes the complete source, dependency, `.lake/build` and Lake-metadata
closure. The deployment-supplied expected hash must match the measurement, but
that equality is not build authority. The same full closure hash must also be
present in the code-reviewed
`PRODUCTION_MATHLIB_BUILD_CLOSURE_HASHES` allowlist or be named by the exact
closure-, official-release-, Lean-toolchain- and toolchain-Merkle-bound subject
of the independently signed build-authority configuration above. The external
configuration must be signed by the exact Ed25519 key set holding the
`production_mathlib_build_authority` role, remain inside its bounded validity
window, and match the separately pinned configuration hash. The allowlist
contains only the independently reviewed canonical closure above. That review
binds 119,871 files and the official release provenance, but does not assert a
second bit-for-bit rebuild. An operator-selected closure hash, an
unpinned or self-shaped configuration, an expired signature, key rotation,
subject drift or file tamper therefore remains blocked.

Once a build closure is independently reviewed and authorized by either path,
an explicit `automation-status --live-formal-sandbox-probe` qualification
verifies the production Lean toolchain content Merkle identity and executes the
exact probe in the configured digest-pinned Docker runtime from a sealed
snapshot mounted read-only at `/work`. The seal strips every write bit
and gives sources and compiled metadata deterministic ordered timestamps.
Missing configuration, the default Init-only project, dependency or build
drift, toolchain drift, sandbox write authority, or an unsuccessful probe keeps
both generic and production readiness false.
After the active probe exits, qualification remeasures the complete closure and its file-read
identities, rereads the probe bytes and `Mathlib` import, reinspects official
source provenance and build authority, and revalidates the toolchain Merkle and
content identity. A successful process exit therefore cannot conceal either
persistent mutation or mutate-and-restore drift during the readiness probe.
The resulting hash-bound receipt is valid for 24 hours. Ordinary
`automation-status`, capability-matrix reads, resident startup and formal
execution assertions recompute the current closure, release, build-authority,
toolchain and runtime identities and compare them with that receipt; they do
not copy the complete Mathlib tree or rerun the kernel probe. A missing,
expired or identity-mismatched receipt remains fail-closed. Formal-domain
qualification performs and publishes the same active probe automatically when
the receipt must be established or renewed.
Strict full-auto acceptance must supply the public reference
`production-mathlib-build-authority-config`; both build-authority environment
variables resolve to that same content-pinned reference.

The default reviewer pool uses fresh, non-resumable `codex exec --ephemeral`
sessions under a reviewer role distinct from the author role. It may share the
same provider-auth root and inherited model. Each session receives only the
frozen, hash-bound evidence workspace, never the author conversation, and every
revision round starts another session. Optional external compliance mode may
still supply signed account identities and recoverable HTTPS executors, but it
is not a production-readiness requirement for the standard autonomous profile.
Structured prior-art and external-replay services must return signed,
hash-bound receipts.
An externally submittable venue profile must use `inline-evidence-v1` bibliography
and `evidence-inline-v1` citation rendering. The host must provide executable
`unzip` and `pdfinfo`; readiness reports `venue-compliance-runtime` when either
tool is absent.

Before the portal call, the system reopens the immutable source archive, verifies
the manuscript IR and public submission metadata, checks the rendered author and
declaration surfaces, reads the compiled PDF page count, binds both compiled PDFs
to the release package, and includes the resulting compliance receipt in the
submission idempotency key. Missing metadata, unsupported rendering, archive or
PDF drift, or a page-limit violation blocks the external action.

Academic dataset runs also emit a `DatasetEvaluationDependencyReceipt`. It
binds the signed dataset manifest and hidden-harness authority to every cell's
challenge, oracle and raw-event hash and to the preregistered analysis result.
This proves that the reported evaluation is derived from the authorized hidden
harness. The same receipt deliberately records
`candidateTrainingUseProven=false`, `candidateAlgorithmDependencyProven=false`
and `causalModelDependencyProven=false`: observing positive dataset reads does
not by itself prove that candidate training or algorithm output causally used
those bytes.

Numeric residuals are recomputed by a repository-separate evaluator in a fresh
Node process. The parent binds the child PID, worker source hash, request hash,
recomputed manifest and child receipt into
`process-isolated-independent-implementation-v1` evidence. This is process
isolation on the same host, not an external trust domain, independent hardware
replication or a guarantee of floating-point portability across runtimes.

This is zero runtime human intervention inside the declared capability manifest,
not an open-world guarantee. The manifest explicitly leaves universal domain
coverage, objective novelty, exhaustive prior art, arbitrary theorem discovery,
scientific truth, external validity and venue acceptance false.

The current native-store schema is 25. Migrations 021–023 provide job lease
generations, campaign attempt/generation/revision fencing with recoverable
prepared results, and restore-qualified workspace retention plus atomic
workflow projections. Migration 024 makes submission delivery ownership
explicit and quarantines ambiguous legacy rows. Migration 025 provides the
immutable cutover authority that externalizes autonomous submission into its
dedicated handoff database.

These migrations require an offline worker cutover. Do not run a rolling
old/new-worker deployment across schema versions 20 and 25:

1. Stop every job, campaign, automation, and submission worker using the DB.
2. Let outstanding leases expire or clear them through the supported recovery
   command, checkpoint and close the old store, then verify there are no job,
   campaign, delivery-outbox, or response-consumption lease markers left.
3. Run `npm run store:migrate` while workers remain stopped. Its first pass is
   read-only: an outstanding lease or active WAL sidecar rejects the cutover
   before the database schema or bytes are changed.
4. Run `npm run store:status` and verify `schema_migrations` contains the
   hash-matched versions 21 through 25 (current native-store schema 25).
5. Restart only workers built from the new release.

Migration 023 intentionally does not invent ledger evidence for pre-existing
`workflow_states` rows. Those legacy rows have no `ledger_receipt_id` and fail
closed after upgrade. If an operator still needs the non-authoritative legacy
projection, rebuild it explicitly after the cutover with
`npm run compat:legacy-workflow-projection -- --mode <MODE> --paper <SLUG> --execute`;
do not backfill receipt ids or hashes with SQL. A rebuilt projection is usable
only when its canonical receipt and the registered `workflow-state-projector`
ledger row commit together.

Scoped automation, batch, and submission roots fail startup when any required
migration through 025 is absent or has a mismatched history hash. The explicit
legacy compatibility root remains available for offline compatibility work;
it is not a production worker escape hatch. Writable roots, including the
legacy facade, never run migrations implicitly: initialize or upgrade with
`npm run store:migrate` first.

Start or inspect automation with `paper:campaign`. The campaign SQLite DAG is
the sole execution authority. `final-compile` is followed by a formal `package`
node; successful automation produces an immutable `CampaignReleaseBundle` for
separate submission verification. The bundle is only prepared while its node
is running. The same fenced SQLite transaction that completes the integrated
package attempt writes its hash-bound current-release authority; submission
consumes that typed authority lookup, never a loose bundle. It never grants
live-submission authority.

For a signed local-golden dataset whose authority explicitly forbids academic
promotion, use `--mode local-review-loop --local-only`. Add
`--apply-manuscript` only when verified empirical outputs should be integrated
into the working manuscript. These options do not weaken the full-campaign
release gate: `full-campaign` still requires an academic-authorized dataset
selector, and every campaign keeps external submission disabled.

After a campaign completes, verify the handoff from an independent submission
root with an explicit campaign identity:

```bash
npm run paper:submission-handoff -- \
  --campaign-id <completed-campaign-id> \
  --root <submission-root> \
  --runtime-root <shared-runtime-root>
```

This command is always read-only and emits `CampaignReleaseSubmissionInput`.
It re-reads the immutable release bundle and package artifacts after authority
validation, does not consult the campaign attempt workspace, and performs no
provider dispatch or other external action.

## Safety behavior

- Planning and dry-run commands do not create a database or run migrations.
  They write no report unless the caller explicitly selects `--write-report`.
- `--write-report` writes only the scoped `reports`, `report-artifact-cas`, and
  `report-receipts` trees. Report receipts use descriptor-fenced immutable CAS
  materialization and are local provenance, not trusted business-ledger rows.
  The default immutable preview rejects an active SQLite WAL/SHM; checkpoint
  and close writable workers before running it.
- Cancellation propagates to the child process group. Fenced integration
  rejects late results after cancellation or lease loss.
- A snapshot remains protected until restore verification is persisted and
  retention qualification commits.
- Backup GC requires trusted backup and restore-drill ledger evidence, keeps at
  least two generations, and uses durable intent → delete → tombstone recovery.
- Scoped file materialization requires descriptor-relative filesystem access
  through Linux `/proc/self/fd` or an equivalent `/dev/fd`. Stale-lock recovery
  binds the PID to its process start time (from `/proc/<pid>/stat`) so PID reuse
  cannot inherit a lease. Platforms without an equivalent descriptor path, or
  without enough identity evidence to prove a stale owner, fail closed before
  source integration or lock reclamation.

## Verification

### Sealed production release environment

Keep production on hold while qualifying a release. Run production release,
formal, trust, restore and WORM status gates only through the installed sealed
entrypoint:

```bash
/usr/libexec/hepta-paper/hepta-paper-release-env --help
/usr/libexec/hepta-paper/hepta-paper-release-env release:state-gate
/usr/libexec/hepta-paper/hepta-paper-release-env formal:gate
/usr/libexec/hepta-paper/hepta-paper-release-env release:verify
/usr/libexec/hepta-paper/hepta-paper-release-env store:restore-drill
/usr/libexec/hepta-paper/hepta-paper-release-env offhost:worm-status
/usr/libexec/hepta-paper/hepta-paper-release-env \
  offhost:worm-restore-drill --manifest \
  /mnt/hepta-paper-external/<snapshot>/manifest.json
```

The sealed `offhost:worm-status` action always dispatches `status
--require-custody`. It exits nonzero unless the target is mounted safely on the
required distinct device **and** custody is verified from current typed
evidence. The contract's `offHostOrOffsiteCustodyQualified` boolean is only a
declaration and cannot qualify custody by itself. The gate requires an
exact match to the contract-pinned ext4 filesystem UUID and partition UUID,
then an
immutable typed current Object Lock receipt, a pinned-trust-store
Ed25519 attestation from a distinct custodian, and a live bounded validity
window. The receipt must match the currently observed findmnt UUID/PARTUUID
storage identity and the selected immutable snapshot manifest plus its exact
object-set hash; an expired receipt, replaced disk, changed manifest, or changed
object blocks. A past offline-detachment event is audit history only and cannot
qualify a device that is mounted again on this host. Missing evidence is
therefore a production-exit blocker, not an
advisory. A direct `npm run offhost:worm-status` remains available as a
same-host target diagnostic; even when that diagnostic reports the target
ready, it is not production-exit evidence. Run
`npm run offhost:worm-status -- --require-custody` for the source-tree form of
the custody gate.

Those artifacts are configured by absolute immutable paths and pins in the
sealed WORM contract: `custodyEvidencePath`, `custodyTrustStorePath`,
`custodyTrustStoreHash`, `custodySignerKeyIds`,
`custodyEvidenceMaximumLifetimeMs`, and `custodySnapshotManifestPath`. The
current contract intentionally supplies none of them and keeps
`offHostOrOffsiteCustodyQualified=false`, so the production gate remains
blocked while the connected disk provides same-host protection only.

The retired THUNDERO device is not a cold-volume dependency. The cold contract
binds the same exact TOSHIBA UUID/PARTUUID as the WORM target, using a separate
logical namespace on that single physical failure domain. Its three OpenNeuro
roots are raw-source availability only: never relink, rename, or promote them
as any of the 15 historical derived targets. Those targets are formally retired
from the 0.21 active release scope. The contract retains their prior six
rebuildable/nine missing dispositions as audit history, but active entry count
is zero; the cold sentinel, CAS import, and CAS restore drill therefore report
not-required. The three raw roots are non-release-blocking inventory. Treat the
disk as SMR: use sequential reads, permit at most one append-new-files writer,
and do not rewrite or compact files in place. Co-resident cold and WORM
namespaces do not establish independent custody, Object Lock, or a second
recovery failure domain.

The installed, root-owned launcher verifies and opens the deployment authority,
then runs `/usr/bin/env -i` and drops to the `hepta-paper` primary identity with
`NoNewPrivileges=yes` before Node imports the JavaScript entrypoint.
`formal:gate` receives only the host's exact Docker group, `store:trust-gate`
receives only the exact protected handoff group, and `release:verify` receives
both because it runs both Docker gates and production handoff-store inspection.
All other actions run without supplementary groups. The JavaScript boundary
independently anchors the handoff GID to the root-owned mode-03770 handoff root
and rejects missing, extra or colliding groups. The entrypoint accepts only its
documented action table and rebuilds the child environment again without
provider secrets. Non-help JavaScript actions also require the launcher's marker
and inherited deployment-lock descriptor; invoking
`node release-env.mjs <action>` directly fails closed. It fails before dispatch
unless `/opt/hepta-paper` is the exact root-owned, read-only sealed release tree.

The deployment-closure check does not trust the closure's self-hash alone. The
current `HeptaDeploymentToolClosure` v2 schema must be exact and its
`inheritedFromClosureHash` must be one of the code-pinned approved predecessor
hashes; legacy v1 is accepted only when its own closure hash equals the separate
exact v1 anchor. The gate
recomputes the sealed trees for `elan`, the current code-pinned
`codex-cli-0.144.1` directory, `core`, and
`runtime-images/r-scientific/source-cas`, and independently verifies each
submodule's `HEAD` commit and tree. Noncanonical JSON, extra fields, path or
content drift, any directory not mode `0555`, any executable regular file not
mode `0555`, any non-executable regular file not mode `0444`, and a
symlink-substituted closure/tool/submodule root fail closed.
Changing the Codex directory or lineage set therefore requires an explicit
reviewed source change rather than an ambient deployment setting. Before a
later v2-to-v2 source candidate is frozen, its pinned predecessor set must be
updated to include the closure hash of the actually deployed approved release;
the gate never learns or trusts that hash merely by observing whichever `/opt`
tree happens to be live.

State, formal, verification, trust, restore, cold-volume and WORM gates may run
from an exact sealed `development` tree to report their own blockers; each child
remains fail closed, and `release:verify` still enforces `release_ready`
internally. Credential-bearing conformance replay, capability refresh and
release attestation are deliberately outside this launcher because they require
separately reviewed operator identities and mutation transactions. The closed
`release:verify` action may read an already-provisioned release-integrity key and
publish its owner-bound isolated-verification receipt, but it cannot provision,
repair or rotate that key. The entrypoint cannot change the production hold,
create a tag, write a WORM snapshot or run a live submission. WORM capture
remains a separately authorized backup custody operation; the release entrypoint
can only inspect or restore-drill an existing manifest.

Membership in the Docker group is root-equivalent. The two Docker-dependent
actions are therefore qualified only on a dedicated trusted verification host;
this launcher is not a sandbox against malicious sealed test code. Cold-volume
and WORM paths must be traversable by the reduced `hepta-paper` principal at a
qualified mount point. An operator-home media mount or user-only ACL remains a
production provisioning blocker; the launcher never retains root to bypass it.

Invoke the installed path directly from a systemd-manager job or a verified
clean root execution context. The `npm run release:env -- <action>` alias points
to the same launcher for discovery, but npm has already started Node and is not
a pre-Node security boundary. In particular, an inherited `NODE_OPTIONS` can
affect npm before it reaches the package script.

The launcher removes `LD_PRELOAD`, `LD_LIBRARY_PATH` and loader audit variables
before it starts Node, but its initial `/bin/sh` is dynamically loaded before
`env -i` can run. Consequently, the release claim requires those variables to
be absent at the manager/root launch boundary. It does not claim immunity from
a hostile host root or a library injected before the launcher begins. The
JavaScript sanitizer and fixed child environment are a second boundary, not a
retroactive dynamic-loader cleanup.

The launcher also verifies `/run/hepta-paper-deployment/deployment.lock` as a root-owned,
single-link, mode `0600` regular file, verifies its opened descriptor identity,
and holds a nonblocking shared `flock` until the release action exits. All
candidate-build and cutover paths must take the same lock exclusively before
they inspect or replace `/opt/hepta-paper`. An exclusive holder makes the
release launcher fail with `release_environment_deployment_in_progress`; an
absent or malformed lock fails before Node starts. Do not create or repair the
lock from this read/verification entrypoint.

The native `store:restore-drill` action copies a qualified backup to a temporary
database and never replaces or migrates `hepta-paper.sqlite`. It does write the
restore receipt and administrative receipt-ledger row, and it may first create
a qualified backup if none exists. Use the isolated `release:verify` runner
when the required claim is that production database bytes remain unchanged by
the complete verification suite.

```bash
npm run reference:integrity
npm run reference:selftest
npm run reference:runtime-dry-run
npm run safety:p0
npm run safety:p1
npm run safety:p2
npm run safety:all
npm test
npm run release:verify
```

`reference:baseline:accept` rewrites the accepted vendored-reference baseline
and is never a routine verification command. Use it only for an explicitly
reviewed reference-package update.

## Recovery and retention

```bash
npm run automation:reconcile
npm run automation:workspace-backfill
npm run store:backup
npm run store:restore-drill
npm run store:logical-integrity
```

`automation:reconcile` is read-only unless its explicit execute script is used.
The one-time legacy terminal-active residue path is additionally campaign
scoped and requires an explicit policy-v0 terminal campaign:

```bash
# Plan only (default): no worker, provider, or external action is started.
npm run automation:reconcile -- \
  --legacy-terminal-active-residue --campaign-id <campaign-id>

# Apply the exact hash-bound plan atomically after operator review.
npm run automation:reconcile:execute -- \
  --legacy-terminal-active-residue --campaign-id <campaign-id>
```

This maintenance path preserves queued legacy nodes and binds their exact count
and deterministic sorted state hash into the plan and receipt. It accepts only
a missing legacy settlement-policy field or an explicit integer `0`; it refuses
text/boolean/noninteger encodings, policy v1, a non-terminal parent, any
unexpired active lease, any `integrating` or `integrated` prepared result, and
any campaign-scoped resource lease or waiter. A stale or partially matching
batch rolls back without settlement events or a receipt.

Operational-integrity status reports those preserved policy-v0 queued nodes in
`preservedLegacyTerminalCampaignQueuedNodeCount`, but does not classify them as
live stale work: campaign claiming independently requires a running parent and
the reconciler intentionally retains this immutable historical evidence.
Policy-v1 terminal queued nodes remain actionable reconciliation debt, and any
malformed settlement-policy encoding remains fail-closed degraded state.

The native-store commands above cover `hepta-paper.sqlite` only. For a fully
provisioned autonomous-research runtime, inspect and back up the complete
trust-bearing database inventory separately:

```bash
npm run automation:autonomous-research-state-backup -- --action status
npm run automation:autonomous-research-state-backup -- \
  --action backup --authority-config /run/hepta-authority/backup-client.json
npm run automation:autonomous-research-state-backup -- \
  --action restore-drill --authority-config /run/hepta-authority/backup-client.json \
  --bundle /srv/hepta-paper/runtime/backups/autonomous-research-state/<bundle-id>
```

These operations fail closed unless the external broker signs the exact scope
and live authority head. See
[`autonomous-research-state-backup.md`](autonomous-research-state-backup.md).

Before first enabling externally fenced online mutation, keep all registered
writers stopped, take and drill a complete state backup, then review the
read-only schema-transition plan:

```bash
npm run automation:autonomous-research-online-schema-transition -- \
  --action plan --runtime-root /srv/hepta-paper/runtime \
  --authority-process-config /run/hepta-authority/online-mutation-process.json
```

Execute only the exact reviewed transition ID:

```bash
npm run automation:autonomous-research-online-schema-transition -- \
  --action execute --execute --transition-id sha256:<reviewed-transition-id> \
  --runtime-root /srv/hepta-paper/runtime \
  --authority-process-config /run/hepta-authority/online-mutation-process.json
```

Status/readiness paths only verify the resulting signed receipt; they never
perform this transition. Crash/resume and receipt requirements are documented
in
[`autonomous-research-online-schema-transition.md`](autonomous-research-online-schema-transition.md).

Audit the existing runtime tree before or after a deployment with:

```bash
npm run runtime:permissions
```

This is read-only by default. It reports every planned owner-only permission
change, already-compliant entry, blocker, an inventory hash, and a hash-bound
receipt on stdout. Review that output before applying the same policy with:

```bash
npm run runtime:permissions -- --execute --writer-quiesced
```

The execute path requires the operator to stop or fence every runtime writer
before explicitly asserting `--writer-quiesced`. It then holds a runtime-root
scoped exclusive lock, repeats the complete inventory under that lock, and
requires the locked inventory hash to match the reviewed plan before setting
directories to `0700`, ordinary files to `0600`, and files that already
required execution to `0700`. Cooperative runtime writers must honor the same
lock; this is not a claim of a filesystem transaction against arbitrary
non-cooperating processes. The apply path uses descriptor-relative `fchmod`,
refuses symbolic links, special files, multiply linked files and path escapes,
and attempts a reverse-order permission rollback if a later mutation fails.
The descriptor-relative inventory recognizes the exact shared submission-handoff
layout (`0710` runtime/research roots, `03770` handoff root, `0660` database and
`02750` dispatcher directories with one common group) and preserves that whole
subtree, including special permission bits, while still scanning every entry.
At the production runtime root it additionally verifies the supervisor, root
and dispatcher ownership roles before protection applies. Descendants must use
the detected handoff group and a bounded non-executable file or setgid-capable
directory mode; setuid, world-accessible and unexpected executable entries
block the batch.
This preservation is not a substitute for the native signed layout-receipt
verifier. An incomplete or metadata-mismatched candidate layout blocks the
entire permission batch, and a symbolic link, special file or multiply linked
file below a protected path remains a blocker.
The receipt exposes mutation attempts, successful rollbacks, and incomplete
rollback explicitly; a blocked batch never reports committed applied rows. The
command never follows a link or writes a receipt into the tree it is auditing. Retain
the stdout receipt in the operator's normal protected evidence sink. Do not
substitute `runtime:hygiene`: that separate command classifies legacy database
evidence and is not a permission repair command.

Run the `:execute` automation variants only after reviewing their dry-run
output. Historical retirement modules are not operational entrypoints; their
supported checks are `migration:salvage-selftest` and
`migration:retirement-status`. The non-authoritative legacy workflow projection
is isolated behind `npm run compat:legacy-workflow-projection`; it is never
loaded by `paper-production-core` or the supported operator graph.
