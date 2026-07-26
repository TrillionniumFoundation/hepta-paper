# Operations

Use `npm run hepta-paper -- <operator|verify|maintenance|retirement> <command>` as the
supported operator surface. `npm run scripts:surface` prints the complete
operator, verification, maintenance, retirement, compatibility, experimental
and internal classification. Maintenance commands rewrite accepted repository
evidence; compatibility and experimental scripts are not production operator
entrypoints.

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

## Declared-capability autonomous research

The production composition can run without a runtime human checkpoint when all
machine trust and resource dependencies are provisioned before launch. Configure
the complete declared-capability path with:

For final deployment convergence, first let the independent machine authorities
materialize the public authority documents and opaque secret-reference files
named by `paper-core/deploy/strict-full-auto-acceptance.config.example.json`,
replace all hash/path/argument placeholders, then use the unattended atomic mode:

The version-2 reviewer pool is one of those hash-bound public documents.
Provision its unique signer and executor `_FILE` credentials beneath the
`formal-reviewer-service-credential-root` reference before convergence. The
runner validates only file metadata and derives `root/<variable-name>` paths;
it never reads secret bytes. The child reviewer adapters reopen those files
with no-follow, descriptor-pinned reads immediately before use.

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
`/etc/hepta-paper/strict-full-auto-acceptance.env`, and enable the timer.
It starts the resident research and dispatcher units, retries failed preflight
or external authority checks without a start-limit, and revalidates live
acceptance every five minutes after each completed run. It does not receive the
submission portal secret and cannot manufacture a missing principal,
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

```bash
export HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE=agent-evidence-bound
export HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED=1
export HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG=/run/hepta/research-author-identity.json
export HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH=sha256:REPLACE_WITH_CONFIGURATION_HASH
export HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG=/run/hepta/reviewer-principals.json
export HEPTA_PRIOR_ART_SERVICE_CONFIG=/run/hepta/prior-art-service.json
export HEPTA_EXTERNAL_REPLAY_CONFIG=/run/hepta/external-replay-service.json
export HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG=/run/hepta/venue-profiles.json
export HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG_HASH=sha256:REPLACE_WITH_CONFIGURATION_HASH
export HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG=/run/hepta/submission-portal-descriptor.json
export HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH=sha256:REPLACE_WITH_CONFIGURATION_HASH
export HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG=/run/hepta/submission-metadata.json
export HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH=sha256:REPLACE_WITH_CONFIGURATION_HASH
```

The research/supervisor process must receive only the public portal descriptor.
Run `autonomous-submission-dispatcher` as a distinct OS/Kubernetes principal;
its environment alone contains
`HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIG=/run/hepta/submission-portal.json`
and the token variable named by that complete configuration. The dispatcher
also receives the public descriptor and configuration-hash pin and refuses to
create a network adapter unless the private configuration deterministically
derives that exact descriptor. The checked-in systemd/Kubernetes templates keep
the portal-token Secret and egress capability out of the research principal.

`HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH` must equal the exact
`configurationHash` inside the regular-file author identity configuration. It
is an out-of-band deployment pin: replacing the configuration, its embedded
trust store, and its signed envelope together still fails before the first
model invocation. The signed subject must bind the active author principal,
provider and credential-root identity and carry provider-account plus platform
attestation. The same canonical subject and envelope are passed unchanged to
the reviewer-pool independence check and the prior-art retrieval authority.

The venue registry must be a signed version-2 configuration. Each profile
declares normalized scope terms and hard format/submission constraints; local
selection emits a fixed-point, all-candidate ranking receipt under the pinned
`scope-fit-constraints-v1` policy. The submission metadata profile is signed
separately. Both `*_CONFIG_HASH` values are out-of-band pins over their exact
trust stores and signature envelopes. Production release and submission
reverify both signatures at the current time and bind the ranking, formatting,
citation, metadata, portal, and post-render compliance receipts. Version-1
hash selection remains bounded-only and cannot satisfy strong production.

`HEPTA_EXTERNAL_REPLAY_CONFIG` must use version 3 for strong production. It
pins the replay-result Ed25519 trust store, one signed remote replay platform
and account identity bundle, and one or more signed local-origin identity
bundles. Every identity must use
`pinned-provider-account-and-platform-attestation-v1`; the remote signer,
provider account, credential root, host, process, and trust domain must all be
distinct from every local origin. Versions 1 and 2 remain bounded audit
formats and cannot satisfy generic production readiness. Persisted v3 replay
receipts are reverified against the current configuration and current time at
campaign verification and release packaging.

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

The reviewed host deployment also sets `ELAN_HOME=/opt/hepta-paper/elan` and
keeps the complete project owned by the `hepta-paper` service principal with no
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
status also verifies the production Lean toolchain content Merkle identity and
executes the exact probe in the configured digest-pinned Docker runtime from a
sealed snapshot mounted read-only at `/work`. The seal strips every write bit
and gives sources and compiled metadata deterministic ordered timestamps.
Missing configuration, the default Init-only project, dependency or build
drift, toolchain drift, sandbox write authority, or an unsuccessful probe keeps
both generic and production readiness false.
After the probe exits, status remeasures the complete closure and its file-read
identities, rereads the probe bytes and `Mathlib` import, reinspects official
source provenance and build authority, and revalidates the toolchain Merkle and
content identity. A successful process exit therefore cannot conceal either
persistent mutation or mutate-and-restore drift during the readiness probe.
Strict full-auto acceptance must supply the public reference
`production-mathlib-build-authority-config`; both build-authority environment
variables resolve to that same content-pinned reference.

The reviewer pool must provide the configured referee cardinality through
different signed account identities, credential roots, signer keys, hosts,
processes, and trust domains. Strong production accepts reviewer identities
only after pinned Ed25519 receipt verification and signed platform/account
attestation against the pinned author reference; configuration-only identity
hashes remain bounded evidence. A version-2 reviewer-pool principal must also
provide `recoverableExecutorConfiguration`: an HTTPS execute/lookup/resume
service whose completed, in-progress, and definitive-not-found outcomes are
signed by the pinned `reviewer_execution_attestor` trust set. The operation
request binds the exact role, instructions, structured context, checks,
resource bounds, principal descriptor, configuration and service identities,
plus a byte-complete immutable workspace snapshot hash. The external service
returns an `AgentExecutionReceipt` whose hash is bound into that signed
outcome. Local `codex exec --ephemeral` remains available only to the
bounded version-1 pool; it is never advertised as crash-recoverable.

Every version-2 signer and recoverable-executor
`tokenEnvironmentVariable` must end in `_FILE` and be unique across the whole
pool (at most 16 principals). The variable value is an absolute, owner-only
opaque credential file; it is not the token. Strict acceptance derives those
paths beneath its plan-bound reviewer-service credential root and passes only
the paths to the child. Missing, aliased, ambient, symlinked, shared-mode, or
wrong-owner credential files fail before any reviewer HTTP action.
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
npm run runtime:permissions -- --execute
```

The execute path sets directories to `0700`, ordinary files to `0600`, and
files that already required execution to `0700`. It uses descriptor-relative
`fchmod`, refuses symbolic links, special files, multiply linked files and path
escapes, and applies nothing when the initial audit has a blocker. The command
never follows a link or writes a receipt into the tree it is auditing. Retain
the stdout receipt in the operator's normal protected evidence sink. Do not
substitute `runtime:hygiene`: that separate command classifies legacy database
evidence and is not a permission repair command.

Run the `:execute` automation variants only after reviewing their dry-run
output. Historical retirement modules are not operational entrypoints; their
supported checks are `migration:salvage-selftest` and
`migration:retirement-status`. The non-authoritative legacy workflow projection
is isolated behind `npm run compat:legacy-workflow-projection`; it is never
loaded by `paper-production-core` or the supported operator graph.
