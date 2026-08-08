# Autonomous research supervisor deployment contract

The canonical resident command is:

```sh
hepta-paper operator autonomous-supervisor -- --require-fully-autonomous --machine-intake-config /etc/hepta-paper/intake/config.json --topic-producer-profile /etc/hepta-paper/intake/topic-producer-profile.json --root /srv/hepta-paper/assets --runtime-root /var/lib/hepta-paper/runtime
```

For deployment admission, `automation-status --require-fully-autonomous`
returns exit code 4 until full research qualification, current machine intake,
and the resident supervisor are all ready. It performs no provider canary unless
that separate live-canary flag is explicitly requested. It also performs no
sealed Mathlib copy or Lean kernel probe during an ordinary status read:
`--live-formal-sandbox-probe` is the explicit first-qualification/renewal
action, while passive reads require its current 24-hour hash-bound receipt.

An operator observing the service from outside systemd must pass the same
non-secret policy file explicitly:

```sh
automation-status \
  --deployment-environment-file /etc/hepta-paper/autonomous-research-supervisor.env \
  --require-fully-autonomous
```

The file must be absolute, regular, owner-private, and contain only the
allowlisted non-secret deployment keys. Its content hash and loaded key names
are included in `deploymentEnvironmentInspection`; values and credential
material are never copied into the report. CLI `--root` and `--runtime-root`
remain explicit overrides, so an operator can distinguish a production
deployment from a development runtime without relying on ambient shell state.
When `--handoff` is requested before the production SQLite store exists, status
uses a missing-store read-only adapter and returns a blocked machine-readable
dependency handoff instead of an infrastructure exception. Ordinary readiness
and strict acceptance retain the stronger missing-store failure behavior.

The resident independently repeats the passive autonomous-state safety
inspection when `--require-fully-autonomous` is present. This inspection runs
before the qualification-pointer repository, campaign execution context, or
supervisor state repositories are constructed. A blocked inventory, restore
drill, external authority head, or writer-coverage inspection terminates startup
with `autonomous_research_supervisor_state_safety_required`; it cannot fall
through to migration, reconciliation, or dispatch. Non-strict recovery mode is
not admitted as fully autonomous and does not apply this startup gate.

`npm run automation:autonomous-research-supervisor -- ...` is the equivalent
package surface. The command stays in the foreground: it does not fork, write a
PID file, or daemonize. `SIGTERM` and `SIGINT` stop new dispatch, abort the active
worker through its execution signal, return leased nodes to a resumable paused
campaign, release the supervisor lease, close SQLite, and exit normally. This is
the process contract expected by systemd and Kubernetes.

## Persistence and recovery

The supervisor runs atomic runtime reconciliation before its first dispatch. It
requeues expired campaign node leases, removes expired resource coordination
rows, clears expired supervisor leases, and clears expired external
qualification attempt leases. Before any read-only reproducibility status
inspection, startup also calls the runtime receipt authority's mutating
`reconcileMirror()` operation. SQLite remains authoritative and the JSON mirror
is repaired from it while locked; the status operation itself never writes or
repairs state. A restarted process discovers persisted
`autonomous-research:*` campaigns and resumes running, paused, or explicitly
supervisor-stopped campaigns. It never increases a campaign budget.

Before the resident process starts, the canonical systemd `ExecStartPre` holds
the state-backup renewal lock and runs the single fail-closed
`reconcile-and-renew` action. It resolves all ten canonical databases against
the pinned online-mutation authority, finalizes committed pending markers
without replaying their business DML, requires an unchanged exact scope and
zero remaining pending finalizations, and only then performs the atomic
backup-to-exact-restore-drill renewal. A reserve-only crash is automatically
aborted only when the absent marker and exact unchanged local database
sequence/hash/schema/state prove that no local commit occurred. Ambiguous
markers, tampering, unknown operations, local-head or scope drift, and
finalization failure prevent backup and resident startup. The periodic backup
timer continues to use ordinary `renew`.

The resident separates non-renewable infrastructure from renewable global
qualification. Invalid external-qualification configuration/trust/cost identity,
runtime-reproducibility configuration, or current code identity is a hard
infrastructure block: the cycle performs no intake, provider, qualification, or
campaign action. A missing, expired, or drifted global Golden qualification or
runtime receipt instead selects `bootstrap-only`. The resident stays live, but
admits and dispatches only provenance-bound recurring Golden campaigns;
production intake and the paid topic producer remain suppressed. Publication of
a current pointer automatically restores `full` mode on the next cycle. The
mode is re-read at each intake, runtime, provider-canary, qualification, and
campaign-dispatch boundary, so a mid-cycle downgrade stops before the next
action rather than relying on the cycle's initial observation.

Each mutating cycle revalidates the hash-bound machine-intake configuration,
loads immutable one-shot production intakes and the current fixed UTC recurring
Golden epoch, then runs the version-2 registered bounded topic producer when it
is due. The producer profile is independently hash-bound to the provider
configuration, exact implementation bytes, registered research profiles and
daily call/cost limits. It can append only through a single-use fenced
capability after two live provider canaries. The supervisor then acquires a
fenced intake lease before creating an enqueue-only campaign. Campaign execution
starts only after that durable enqueue commits. This automates bounded recurring
research; it does not claim open-domain novelty or universal scientific validity.
Enqueue admission does not call the general automation readiness query and does
not perform provider model canaries or live KMS probe/signature challenges.
Production admission uses only current cached qualification/runtime receipts
and a hash-verified static external-KMS descriptor; execution re-runs the live
fenced gates. The Codex configuration and local Docker manifest preflights
needed to materialize a deterministic plan run inside Bubblewrap with
`--unshare-net`, a read-only root, and an exact command allowlist. Docker is
forced to `unix:///var/run/docker.sock`; Docker contexts and remote Docker,
Ollama, or OpenClaw endpoints are rejected before any child process. The
canonical enqueue receipt separately records local-process and local-daemon
activity while keeping network and external action false.

The systemd unit may realize that fixed socket with a host-local daemon only on
a dedicated machine: possession of its Unix socket is root-equivalent even when
granted through a group. `PrivateTmp=yes` remains enabled, while
`TMPDIR=/run/hepta-paper-worker` names a service-owned `RuntimeDirectory`
visible to the host daemon for worker bind sources. The canonical Kubernetes
file does **not** claim an equivalent runtime. It never mounts a node
`docker.sock`, and its verifier init prevents the supervisor from starting
until a separately reviewed site overlay supplies an externally qualified
nested-container implementation and current-Pod conformance evidence.

The canonical deployment uses `--require-fully-autonomous`, so a missing intake
configuration fails closed. Without that flag, the supervisor may recover
existing campaigns, but reports `machineIntakeConfigured=false` and
`coldStartAutonomyReady=false` and makes no cold-start autonomy claim. Status
opens the intake SQLite database read-only and never loads or appends configured
intakes.

Supervisor lifecycle state is stored at
`runtimeRoot/autonomous-research/supervisor/supervisor-state.sqlite`.
Qualification state and its renewable attempt lease are keyed by canonical
`paper:<paperId>` scope rows in the fixed singleton database at
`runtimeRoot/autonomous-research/qualification/external-qualification-state.sqlite`.
Creating a new paper never creates or onboards another trust database. Both
state stores use SQLite transactions and generation fences; an expired owner
can be replaced, while a stale owner cannot commit or release the replacement
lease.

The resident process itself owns a separate fenced instance lease at
`runtimeRoot/autonomous-research/supervisor/resident-instance.sqlite`. Only the
foreground `run()` mode acquires and heartbeats this lease; `--once` and status
commands never impersonate a healthy resident. A graceful stop clears health
immediately. After a crash or hang, health fails when the bounded lease expires,
the deployment restarts the process, and the replacement generation takes over;
the prior process can no longer heartbeat or clear it. Fully-autonomous system
readiness therefore requires a current resident heartbeat in addition to full
research qualification and cold-start machine intake. The lightweight
`autonomous-research-supervisor-health.mjs` probe opens this database read-only
and performs no reconciliation or external action. Heartbeat health alone is
used for liveness. Startup additionally requires a fenced startup-reconciliation
receipt for the current instance generation. Readiness and the fully-autonomous
system claim also require a successful, current-configuration machine-intake
reconciliation receipt. Intake load errors or reconciliation failures clear
that marker until a later successful cycle. Both receipts are persisted before
campaign dispatch, so a long first research cycle cannot create a Kubernetes
cold-start kill loop or falsely report an unconsumed intake queue as ready.

Runtime-image reproducibility refresh coordination is global to the entire
`runtimeRoot`, not per paper. Its singleton lease, monotonically increasing
generation fence, fixed UTC 24-hour budget epochs, non-refundable attempt count,
and non-refundable worst-case cost reservations are stored at
`runtimeRoot/autonomous-research/supervisor/runtime-reproducibility-refresh.sqlite`.
Every external two-builder verification reserves the exact configured
`maximumVerificationCostUsd` and its declared cost authority atomically before
the process starts. A crash, cancellation, failed build, expired lease, new
campaign, or supervisor restart does not refund or reset that reservation.
Expired owners are fenced from publication and completion; bounded backoff and
startup lease recovery permit a new generation to continue.

The independently published full-research qualification pointer and runtime-image
reproducibility receipt also own monotonic SQLite publication state at
`runtimeRoot/autonomous-research/qualification/qualification-receipt.json.publication.sqlite`
and
`runtimeRoot/autonomous-research/runtime-image-reproducibility/receipt.json.publication.sqlite`.
They are trust-bearing databases and are included in whole-runtime backup scope;
copying only their JSON mirrors is not a recoverable substitute.

Dispatch count, provider-canary count, reserved canary cost, qualification
attempt count and reserved qualification cost, observed campaign cost, and the
absolute lifecycle deadline survive restarts. Unknown provider cost, an
over-budget cost envelope, attempt exhaustion, or deadline exhaustion blocks the
campaign closed. Cooldowns use bounded exponential backoff with jitter. A fresh
author plus independent-reviewer live model canary pair is required before
dispatch after its persisted 15-minute interval. Its provider-declared worst-case
pair cost is reserved durably before execution and a hash-bound pair receipt is
required before the interval can be reused. If only one role completes, or a
post-canary authority fence fails, the generation stores a hash-verified partial
side-effect inspection with the exact reservation and per-role outcome. A restart
revalidates that inspection; it never refunds the attempt or reserved cost and
never persists provider output or credentials. Separately, every external qualification attempt
reserves the qualifier-plus-verifier maximum declared by the exact qualification configuration;
caller retry options cannot lower it. A verified external qualification is renewed before expiry
when lifecycle budget remains.

Every machine dispatch reserves its version-3 dispatch authorization before a
live readiness or Golden release-attestor action. Production readiness and
Golden KMS probe/signature challenges use the same controlled child-process
ledger. A blocked gate, thrown probe, or later pre-execution failure carries the
hash-verified action inspection into the durable supervisor failure outcome;
the same authorization cannot repeat the action and is consumed only by the
subsequent campaign execution boundary. Passive `prepare` and `status` never
activate the external release-attestor challenge.

The release signer may use an external hardware KMS/HSM or the bundled
dedicated-UID Unix-socket backend. The dedicated-UID profile keeps both signer
and probe private keys outside the research process and requires a live
independent probe plus active-key challenge. It is bounded-production eligible
only for the declared `research-runtime-uid` threat boundary. Fully production
ready status requires the external hardware-protected, non-exportable KMS/HSM
profile. Reports remain explicit that the dedicated-UID key is exportable by
its owning service UID or root and does not resist root, hypervisor, or
host-snapshot rollback.

Supervisor cooldown timestamps are durable. A replacement process does not
require an operator or machine `resume` command: it waits until the persisted
timestamp, then dispatches the existing campaign through the bounded `resume`
action. Only a hash-verified initial `admitted-not-authorized` pause, or a pause
or stop explicitly caused by supervisor shutdown, transient failure, or lease
loss, is eligible. Operator pauses and stops,
scientific failures, exhausted campaign budgets, unknown cost, missing
credentials, and invalid qualification remain fail-closed and are never
reclassified by the resident lease.

Runtime readiness is evaluated before qualification. For a non-terminal
campaign, both the runtime receipt and the external qualification receipt must
cover the remaining persisted campaign wall-time budget plus a minimum 15-minute
action safety margin. The qualification receipt must bind the exact current
runtime reproducibility receipt hash. A stale hash, insufficient validity, or
missing receipt forces refresh/requalification; it cannot settle or defer as
ready. If the required coverage is at least either receipt format's maximum age,
the supervisor blocks closed. The next resident wake-up is the earliest of the
runtime renewal time, qualification renewal time, and supervisor lifecycle
deadline, and settlement is permitted only when both receipts cover that
lifecycle. The same wall-time-plus-margin checks are enforced by canonical
production launch, resume, and converge commands, so direct CLI execution cannot
bypass the resident gate.

## Offline v1-to-v2 intake-authority rotation

Changing the configured machine-intake hash or adding a version-2 producer
profile is never an ordinary resident restart. Normal startup remains
fail-closed on a durable authority mismatch. Rotate an existing persistent
runtime only through the offline maintenance command, with the resident service
stopped and automatic restart temporarily disabled.

Fresh production initialization does not require a synthetic external genesis
ceremony. It binds the exact root-owned, non-symlink configuration files
`/etc/hepta-paper/intake/config.json` and
`/etc/hepta-paper/intake/topic-producer-profile.json`; every path component
must be root-owned and must not be group- or world-writable. The service
identity receives read access only, and the resulting genesis row records the
two content hashes.

The external governance anchor is required only when rotating an existing
persistent runtime. Before rotation, an independent operator must provision
these public-only documents at the fixed root
`/etc/hepta-paper/authority-rotation`:

- `AUTHORITY_TRUST_STORE.json`
- `OWNER_TRUST_STORE.json`
- `AUTONOMOUS_RESEARCH_INTAKE_AUTHORITY_BOOTSTRAP.json`

Every path component from `/` through that directory must be root-owned and
must not be group- or world-writable. Each document must be a root-owned,
non-symlink regular file with link count one and no group/world write bit. The
service identity needs read access only. The resident never creates this root,
generates a key, signs a document, or copies the anchor into writable runtime
state. Bootstrap authorization requires distinct `capability_owner` and
`operational_observer` signatures; the rotation intent requires an
`autonomous_research_intake_authority_rotator` signature.

First generate a zero-write plan against the exact staged, immutable target
files. The maintenance environment must set the same canonical
`HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT` used by the resident:

```sh
hepta-paper operator autonomous-intake-authority-rotation -- \
  --action plan \
  --runtime-root /var/lib/hepta-paper/runtime \
  --next-machine-intake-config /etc/hepta-paper/intake/config.v2.json \
  --topic-producer-profile /etc/hepta-paper/intake/topic-producer-profile.v2.json
```

Review the previous and next configuration/profile/provider/implementation
hashes, `preStateHash`, quiescence findings, target identity conflicts, and the
legacy-machine quarantine list. Have external governance sign the exact intent
template emitted by the plan, without adding or removing fields. Apply only the
exact signed intent, `planHash`, and `expectedAuthorityGeneration` emitted by
that plan:

```sh
hepta-paper operator autonomous-intake-authority-rotation -- \
  --action apply --execute \
  --runtime-root /var/lib/hepta-paper/runtime \
  --next-machine-intake-config /etc/hepta-paper/intake/config.v2.json \
  --topic-producer-profile /etc/hepta-paper/intake/topic-producer-profile.v2.json \
  --rotation-intent /secure-offline-transfer/rotation-intent.signed.json \
  --expected-authority-generation 1 \
  --plan-hash sha256:REVIEWED_PLAN_HASH
```

Apply remeasures the target files and durable state, locks every existing
resident, intake and topic-producer SQLite authority with `BEGIN IMMEDIATE`, and
then performs one generation CAS. A healthy resident, an unexpired intake or
producer lease, a `planned`/`authorized` topic generation, a mismatched existing
producer database, a changed plan, or a current target intake identity conflict
aborts without a partial write. Do not delete the runtime PVC, edit SQLite, or
run this as an automatic init container.

The transaction preserves every intake/admission record, campaign binding,
daily admission budget, lease token and generation. A pending legacy
`source_kind=machine` admission cannot acquire version-2 producer authority; it
is retained with its immutable admission and lease history but is marked
`invalid` with the rotation-quarantine reason. The append-only journal records
the old and new authority tuple, pre/post state hashes, `planHash`, generation,
and receipt hash. Each receipt explicitly binds `previousRotationReceiptHash`
(`null` for the v1-to-v2 transition), while metadata points to the new receipt,
so an auditor can verify the chain. A crash before commit rolls back schema,
journal, quarantine and metadata together; replay of the old plan is rejected.

For systemd, use stop → stage real non-symlink files → plan/review → apply →
start. For Kubernetes, scale the Deployment to zero and wait past all durable
leases, then run an explicit one-off maintenance Job mounting the same runtime
PVC and the same authority PVC at the exact read-only path
`/etc/hepta-paper/authority-rotation`; remove the Job before scaling back to one
replica. The maintenance command performs no network, credential or provider
action.

The Kubernetes authority volume must be a preprovisioned immutable PVC or a CSI
volume that exposes the four documents as real regular files and does not apply
pod `fsGroup` permission rewrites. Do not use a projected ConfigMap or Secret:
their `..data` and per-key symlinks intentionally fail the production realpath
and symlink checks. The template therefore omits pod `fsGroup`. Provision the
writable submission-handoff PVC as `root:20001`, mode `3770`; both Pods receive
only that GID through `supplementalGroups`, while retaining distinct UIDs and
primary groups. Pre-provision `dispatcher-challenges` as `10001:20001` mode
`2750` and `dispatcher-cycles` as `10002:20001` mode `2750`. The dispatcher
mounts no native runtime PVC: it receives an empty read-only runtime base plus
the dedicated handoff PVC at the canonical nested path.

For systemd, first provision the referenced public configuration, private
provider/dispatcher environment files, authority roots, and immutable assets.
The release-attestor signer/probe files must both use strict daemon
configuration v2 with an explicit `socketPolicy`; v1 is intentionally rejected.
Follow the no-downtime v1→v2 staging and candidate pair-preflight sequence in
`paper-core/docs/operational-process-entrypoints.md` before invoking the
installer. The installer performs that read-only preflight before compilation,
target writes, unit reload, or service restart, so an old or incoherent pair
cannot partially deploy the candidate or stop the active daemons.
Then run the checked-in machine installer:

```sh
sudo paper-core/deploy/install-hepta-paper-systemd-host.sh
```

The installer clears the compiler environment, snapshots an exact regular-file
allowlist into a root-only build directory, builds the native C helper with the
checked hardening and warning-as-error flags, records source/compiler/binary
hashes, installs and re-hashes every fragment/unit/binary, verifies all units,
reloads systemd, and enables only the core authority, handoff-layout, and
backup chain. The research supervisor, submission dispatcher, and strict
acceptance service/timer remain disabled and stopped as the default production
hold. The explicit `--enable-full-auto` request currently fails before mutation
because no repository command can prove current accepted readiness without
acquiring a lease or launching verification processes. A non-mutating host
image test uses
`install-hepta-paper-systemd-host.sh --root DESTDIR --no-systemctl`; the
installed manifest can be verified from that root with `sha256sum -c`.

`hepta-paper-host-bootstrap.service` runs before every secret-bearing service.
With an empty environment, private network, bounded capabilities, and the
secret configuration root hidden, it explicitly applies the installed
sysusers/tmpfiles fragments and invokes the native identity verifier. The
declaration owns the named systemd principals and adds only the research and
dispatcher principals to the handoff group; the supervisor receives Docker
membership only through its systemd unit, never through a persistent
`/etc/group` edit. Exact passwd/group/shadow/gshadow names, IDs, primary
groups, homes, shells, locks, and exclusive handoff membership fail closed.
Tmpfiles creates `/var/lib/hepta-paper` as
`hepta-paper:hepta-runtime-handoff` mode `0710` and never pre-creates the
runtime root.

The state provisioner atomically installs the fresh runtime.
`autonomous-submission-handoff-layout-provision.path` observes the existing
offline handoff database and starts a separate root oneshot with no
`EnvironmentFile`. The native helper uses openat2/dirfd operations and
converges the handoff root to
`root:hepta-runtime-handoff` mode `3770`, the existing database to
`hepta-paper:hepta-runtime-handoff` mode `0660`, `dispatcher-challenges` to
`hepta-paper:hepta-runtime-handoff` mode `2750`, and `dispatcher-cycles` to
`hepta-submission-dispatcher:hepta-runtime-handoff` mode `2750`. It requires
the offline-provisioned database to exist, rejects
symlinks/hard links and unexpected owners, opens the database read-only, and
proves its pre/post SHA-256 is unchanged. It atomically publishes a
`root:hepta-paper` mode `0440` historical receipt below a root-owned `/run`
directory. Before state provisioning returns or online transition can begin,
the unprivileged native verifier reopens the full chain with openat2, validates
the root receipt and stable dev/inode/uid/gid/mode matrix, and requires the
database link count to remain one. Later legitimate SQLite or exchange-file
writes do not invalidate that historical no-content attestation. Residents
contain only unprivileged metadata preflights and restart until this oneshot
completes; they never inherit secrets into a privileged `ExecStartPre`.

The tmpfiles fragment creates only `/var/lib/hepta-paper` and the private
strict-acceptance control root. It deliberately does not create `runtime`, so
the fresh-state atomic-install precondition remains intact. Deployment
automation uses the installer to update both fragments, and the explicit
host-bootstrap unit reapplies those exact installed files on every boot or
upgrade before any secret-bearing consumer starts.

Keep `/var/lib/hepta-paper/runtime` non-setgid and native files in the
`hepta-paper` primary group. Both units verify the resulting matrix and use
`UMask=0007`. The dispatcher refuses to start unless native writes are
unavailable and the handoff database is writable, so it cannot silently create
a divergent private store.
`ProtectSystem=strict` and the explicit `ReadOnlyPaths` entry make the fixed
anchor read-only to the resident, so external governance must stage or replace
it before starting the service, not from inside the unit.

Fresh startup continuously revalidates the fixed root-owned intake
configuration/profile paths and their content hashes. After an external
rotation, startup also rereads the fixed governance documents. Persisted
bootstrap and intent signatures, key windows, and document lifetimes are
evaluated at the signed intent `validFrom`, which is the authority-effective
`rotatedAt`. Thus a sound historical rotation receipt remains verifiable after
a key or document's ordinary validity window has elapsed, while replacement,
removal, shape drift, or signature drift of the fixed external anchor still
fails closed.

The local append-only trigger and receipt hash detect ordinary corruption but
are not an external monotonic-head service: a database owner can replace the
database with an entire previously valid snapshot or an empty database that is
again eligible for a valid signed genesis. Exporting a receipt after commit, or
adding a static fifth `HEAD` file, does not close this boundary because either
ordering leaves a crash window between the external head and SQLite commit.

Accordingly, protecting against rollback by the `hepta-paper` research UID
requires a linearizable authority head controlled by a different security
identity. The bundled `hepta-paper-state-authority` service satisfies that
boundary when its private key and monotonic database are owned by the dedicated
authority UID and the research service can access only its restricted Unix
socket. A remotely administered broker implements the same protocol for a
stronger control-domain boundary.

The same-host profile remains **No-Go** when the threat model includes host
root, hypervisor, storage-controller, or whole-machine snapshot
rollback/replacement; that requires remote durable authority state and
optionally HSM/KMS-backed signing. Advancing only the machine-intake authority
generation is insufficient: an old snapshot from the same generation can also
roll back intake rows, leases, budgets and external action journals. Every
trust-bearing SQLite transaction across the runtime must therefore reserve the
next global and per-database mutation sequence before its durable commit. The
reservation must bind the schema identity, canonical pre/post logical-state
hashes, a replayable SQLite changeset and the exact domain
authorization/side-effect reservations; the same SQLite transaction records
that reservation before commit, and only then may the authority finalize it.
The authority must maintain an authoritative database-scope inventory and
validate mutations or require an authorization unavailable to the database
writer. A caller-controlled sequence service running as the research UID is
not an independent authority.

The operational backup surface is `automation:autonomous-research-state-backup`.
Its versioned database manifest is
`paper-core/config/autonomous-research-state-databases.v1.json`; unregistered
SQLite state below `runtimeRoot/autonomous-research` blocks backup. `status`
checks the main store, machine intake, topic producer, supervisor, resident,
runtime-refresh, both monotonic publication databases, and the singleton
external-qualification database. `backup` requires an independent authority process
configuration whose executable and Ed25519 public-key document are pinned by
SHA-256. There is no local `--force` or boolean substitute.

The authority must return a signed reservation over the exact database inventory
and scope, a linearizable authority head, and an expiring mutation fence. The
backup implementation re-inspects that inventory after reservation, uses the
SQLite backup API for every database, verifies quick-check, foreign keys,
schema and content hashes, then re-inspects every source before requesting a
signed finalization over the complete snapshot-content hash. Only that
finalization can publish an `autonomous_research_state_backup_recorded` bundle.
Partial staging after an authority-finalized publication failure is retained
for explicit recovery and is never reported as a successful backup.

`restore-drill` copies every bundle database into a temporary root and repeats
all integrity checks without mutating production state. It additionally
requires a fresh signed restore-validation fence. A missing signature,
incomplete scope, expired fence, tampered database, foreign-key violation, or a
live authority head newer or different from the bundle blocks the drill. A
stale bundle is therefore recoverable evidence, but cannot be presented as a
currently authorized full-state restore.

`offhost:worm-snapshot` consumes the newest restore-drill-passed whole-state
bundle and archives its bundle manifest, restore receipt (including the full
signed current-head response and its request), and every database object. A
newer pending or invalid directory cannot shadow an older valid bundle; skipped
candidates are reported with non-sensitive audit codes and hashed directory
names. It fails closed when no valid bundle exists; the former raw-main-store
source is not treated as a complete autonomous-system snapshot. Source
resolution requires the pinned authority configuration and re-verifies all
three authority signatures without calling the authority service; the WORM command accepts
`--authority-config` or
`HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG`.

This backup protocol does not by itself establish the transaction-time global
reserve/apply/finalize boundary described above. The strict production graph
now registers all ten trust-state roles through sixteen writer entries and
204 statically discovered mutation operations: 132 coordinator-integrated
online DML operations plus 72 explicitly offline schema/genesis or
cross-database maintenance operations. Production nevertheless
remains No-Go for same-UID whole-database anti-rollback until the deployed
databases have the signed schema-transition receipt, all ten roles reconcile
through the configured independent authority, runtime activation verifies the
current signed head and scope, and a current restore-drill receipt is present.
Signed backup fencing cannot be used as a local readiness bypass. Explicit
offline maintenance and non-strict compatibility factories remain outside this
claim and require quiescence/deployment isolation. A same-host authority remains
No-Go for the stronger host-root or full-machine rollback threat model.

Startup and crash recovery compare every locally bound database with the authority
and idempotently finalize an already committed, cryptographically bound local
marker. An authority reservation with no local marker is never replayed. It is
automatically aborted only under a database write lock after its signature and
manifest binding are verified and the exact local database
sequence/hash/schema/state still equal the signed pre-commit head. The signed
abort is then confirmed by a second unresolved-reservation observation. Any
head drift or commit ambiguity preserves the remote evidence and blocks
startup. Missing, old, or divergent local state against a finalized remote head
is also rejected. Provider or KMS actions may run only after their marker
transaction is authority-finalized. Code-level
strict-profile writer coverage is necessary but not sufficient: without
successful production activation and current authority evidence, do not
describe the deployment, this backup command, or fixed root files as same-UID
whole-database anti-rollback protection. A WORM export remains useful audit
evidence, but is not a substitute for the online monotonic-head gate.

The separately registered `autonomous-state-backup` operator command closes the
backup *scope* over the canonical trust-database inventory and can validate a
restore drill against a fresh signed head. It intentionally cannot mint that
head and does not weaken the No-Go statement above: the independent authority may
attest a write fence only after all registered writers participate in the
online protocol (or an equivalent external write freeze is active). See
[`autonomous-research-state-backup.md`](autonomous-research-state-backup.md).

## Filesystem and secret boundary

### Experimental public deployment identity inspection

The repository includes a passive, public-only deployment identity inspector
for configuration-rotation design. It is deliberately **not** part of resident
startup admission or the reactivation fence yet. The inspector reads only
regular public configuration files, executable bytes, and Ed25519 public keys;
it never opens credential roots, reads environment values, invokes a provider,
or opens a private key. Because the current process schemas do not classify
command arguments as public, every non-empty `args` array is rejected rather
than copied or hashed. Literal tokens and private-key material in argv therefore
cannot become an identity input.

External qualification, runtime reproducibility, and release-attestor transport
credentials currently have no independently signed public generation or public
fingerprint in their schemas. Their public identity inspections consequently
return explicit blockers, and the aggregate cannot produce an adoptable
resident deployment identity. A site must first provide a reviewed, signed
public credential-generation/fingerprint contract that binds the relevant
service principal without exposing credential contents. Only after that
contract and its verification tests exist may the aggregate identity be folded
into `AutonomousResearchResidentPrerequisiteIdentity` and used to trigger the
typed exit-75 resident reactivation path. Treating this experimental inspection
as ready, hashing secret values, or wiring its blocked result into startup would
be incorrect and would leave canonical startup permanently unavailable.

The passive diagnostic is reachable only through the explicitly experimental
architecture graph:

```sh
node paper-core/experimental/inspect-autonomous-research-public-deployment-identity.mjs \
  --external-qualification-config /etc/hepta-paper/qualification/config.json \
  --runtime-reproducibility-config /etc/hepta-paper/reproducibility/config.json \
  --release-attestor-config /etc/hepta-paper/release-attestor/config.json
```

Its report is evidence about public configuration only. It is not a readiness
receipt, mutation permit, credential proof, or authorization to adopt a rotated
identity.

The code/image, asset root, and dataset root are read-only. `runtimeRoot` is the
only writable persistent mount. Every `datasetMounts[].source` in the registered
topic-producer profile must be an exact absolute path below the deployment's
dataset root (`/srv/hepta-paper/datasets` for systemd and `/datasets` for the
Kubernetes template). The configured root and every source are resolved with
`realpath`; a missing root, lexical or resolved escape, leaf symlink, or symlink
in any parent component fails closed. The dataset path must already exist, remain immutable,
and match its hash-bound manifest, licence, split and operator authority; the
supervisor never downloads or silently substitutes research data. Provider credential roots, external qualification process
configuration, and release-attestor configuration are distinct read-only mounts
owned/protected by the service identity. Only their paths are provided through
environment variables; neither the deployment templates nor SQLite supervisor
state contains tokens, cookies, private keys, or credential file contents.

The external qualification mount must contain the exact version-3 public-key-only
configuration described in
[`external-research-qualification.md`](external-research-qualification.md).
The runtime reproducibility mount must contain the exact process configuration
described in
[`runtime-image-reproducibility.md`](runtime-image-reproducibility.md), including
the fixed maximum verification cost, its authority, receipt maximum age, and
minimum refresh lead.

Deployments must explicitly set all of the following (the example values are
templates, not permission to infer missing values):

- `HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE=agent-evidence-bound`
- `HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED=1`
- `HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG`
- `HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH`
- `HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG`
- `HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH`
- `HEPTA_PRIOR_ART_SERVICE_CONFIG`
- `HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH`
- `HEPTA_EXTERNAL_REPLAY_CONFIG`
- `HEPTA_EXTERNAL_REPLAY_CONFIG_HASH`
- `HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG`
- `HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG_HASH`
- `HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG`
- `HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH`
- `HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH`
- `HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG`
- `HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH`
- `HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG`
- `HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH`
- `HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG`
- `HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG`
- `HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG`
- `HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG`
- `HEPTA_AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_PROFILE`
- `HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT`
- `HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_REFRESH_ATTEMPTS_PER_EPOCH`
- `HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_REFRESH_COST_USD_PER_EPOCH`
- `HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_REFRESH_RENEWAL_LEAD_MS`
- `HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_REFRESH_ACTION_SAFETY_MARGIN_MS` (at least `900000`)
- `--qualification-action-safety-margin-ms` (at least `900000`)
- `--require-fully-autonomous`

The runtime reproducibility hash is not a self-asserted file checksum. It must
equal the independently reviewed `configurationIdentityHash` emitted by a
bounded `status` inspection for the exact resolved dual-verifier process, trust,
credential-root, and backend identities. Missing or drifted pins block status
before the receipt authority is read and block refresh before either external
builder is invoked.

By default the bounded author identity is content-addressed from the live provider
capability receipt, role ID, credential-root identity, inherited model
selection, and the mandatory fresh-ephemeral/no-resume policy. Author and
reviewer may share the same provider-auth root. Scientific review independence
comes from distinct role IDs, a new reviewer session for every review round,
forbidden author-context inheritance, read-only reviewer execution, and frozen
artifact hashes. This bounded autonomous-research profile requires no second
provider account or external reviewer trust domain.

`HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG`,
`HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH` are mandatory for fully production
ready status. Version 2 pins the stable provider account, principal,
credential-root, platform signer and authority trust policy. Its short-lived
host/process/challenge subject and signed envelope can rotate under that policy
without an operator changing the pin. Version 1 exact-envelope pins remain
bounded-only.
`HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG` remains an optional stronger compliance
override and retains its external signature and identity-separation checks.
Missing author attestation never causes the session-isolated bounded profile to
impersonate an external platform attestation.

`HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH` pins the resolved
release-attestor configuration identity out of band. That identity includes
the selected trust/probe keys, executable and credential-root identities,
restricted child environment, backend descriptor and stable v3 KMS
hardware-authority policy. Changing those dependencies breaks the pin even
when the JSON bytes are unchanged. A fresh control-plane-signed
hardware/non-exportability bundle is verified against that stable policy on
every read. Its path, trust policy and KMS identities remain stable, so the
bundle can be atomically replaced without rewriting the release configuration
or changing the out-of-band deployment pin. No external KMS probe, signer
challenge or signing call is allowed while the semantic pin is absent or
mismatched. Full production also requires that fresh attestation; the
self-declared version-2 profile remains bounded and performs no live KMS
action. Live commands are reopened, rehashed and invoked through a pinned file
descriptor to remove the pathname replacement window. Version-3 signer
requests bind the current authorization deadline, and returned signatures are
accepted only after the clock, configuration, key and KMS authority are
revalidated. The deployment must still independently pin or attest interpreter,
dynamic-library, module, certificate-store and credential-root content closure.
A production handoff accepts the release-attestor atom only from a
record-hash-valid live inspection no more than two minutes old and before the
control-plane subject expires.

`HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH` and
`HEPTA_EXTERNAL_REPLAY_CONFIG_HASH` are also mandatory out-of-band pins for
fully production ready status. The prior-art service must expose the signed
ranked/deduplicated v2 authority chain. External replay must use configuration
version 4, retain the signed off-host identity separation from v3, and provide
signed lookup/resume recovery outcomes for the exact operation and idempotency
identities. An unpinned configuration or replay version 3 remains bounded-only.

The venue and submission-metadata hashes are independent out-of-band pins over
signed configuration documents. Strong production accepts only venue registry
version 2 and metadata receipts carrying current Ed25519 authority proofs. The
venue selector derives scope and constraint fit locally from the signed
profiles, the verified proposal protocol/objective, and non-empty signed
metadata fields; it never accepts a provider- or model-reported fit flag.

The process configuration, qualification configuration, release-attestor
configuration, declared-capability configuration, and provider credential
roots are separate read-only mounts. Configuration readers require regular
files and reject projected symlinks. The research supervisor receives only the
public submission portal descriptor, its out-of-band configuration-hash pin,
and its independent descriptor-hash pin. That descriptor deliberately omits
the endpoint and token-variable name.
It never mounts the complete portal configuration or the portal-token Secret.

Live submission is owned by a second OS/Kubernetes principal running
`autonomous-submission-dispatcher`. Only that principal mounts the complete
portal configuration, loads the dedicated portal-token environment file or
Secret, and has the portal egress capability. Before creating the HTTP adapter,
it deterministically derives the public descriptor from the complete
configuration and requires an exact match with the descriptor and hash used by
research. Research composition explicitly disables private-configuration
fallback even if a private portal environment variable is accidentally
inherited. Research-only provider tokens and submission tokens must be kept in
different Secret objects/files. The runtime root is the shared durable handoff
boundary and must survive restarts; an ephemeral runtime root invalidates the
lease and outbox guarantees. The two principals share only the dedicated
runtime handoff group. The native runtime root is not setgid; only the handoff
root is setgid, so its SQLite, WAL and SHM files inherit the shared group and
remain inaccessible to all other users.

Full production dispatch additionally requires portal configuration v3,
current signed platform identity separation, and a no-side-effect canary whose
signing subject and Ed25519 SPKI differ from the dispatcher cycle signer. The
cycle binds the original local verification time and receipt hash so the
research-side readiness process can replay that verification and then perform
a fresh independent verification. Dispatchable handoffs remain blocked when no
fresh externally published challenge is pending.

The auditable templates are:

- `paper-core/deploy/autonomous-research-supervisor.service`
- `paper-core/deploy/autonomous-research-supervisor.env.example`
- `paper-core/deploy/autonomous-submission-dispatcher.service`
- `paper-core/deploy/autonomous-submission-dispatcher.env.example`
- `paper-core/deploy/hepta-paper.sysusers.conf`
- `paper-core/deploy/hepta-paper.tmpfiles.conf`
- `paper-core/deploy/hepta-paper-host-bootstrap.service`
- `paper-core/deploy/autonomous-submission-handoff-layout-provision.c`
- `paper-core/deploy/autonomous-submission-handoff-layout-provision.service`
- `paper-core/deploy/autonomous-submission-handoff-layout-provision.path`
- `paper-core/deploy/install-hepta-paper-systemd-host.sh`
- `paper-core/deploy/autonomous-research-supervisor.k8s.yaml`
- `paper-core/deploy/nested-runtime-platform-qualification.config.example.json`

The systemd unit uses `Restart=always`, `KillSignal=SIGTERM`, `KillMode=mixed`
so the foreground wrapper forwards one graceful stop before group-wide timeout
enforcement, a strict read-only system view, and an explicit `ReadWritePaths`
runtime root. The Kubernetes
template uses `restartPolicy: Always`, `terminationGracePeriodSeconds`, a
read-only root filesystem, a single SQLite writer with `Recreate`, separate
read-only asset, dataset, config and credential mounts, and one writable runtime
PVC. Replace image, PVC, model, and path placeholders in deployment automation; never place secret
values in the manifest or environment example.

The checked-in Kubernetes manifest is fail-closed. Its
`nested-runtime-platform-qualification-gate` init invokes the repository's
read-only verifier and cannot pass with the checked-in placeholders, a missing
PVC, a stale receipt, or a self-asserted RuntimeClass. It never creates,
repairs, or signs evidence. The manifest contains no rootless daemon and no
image-loader init. A deployable site overlay must supply the qualified
pod-local daemon and independently administered evidence volume.

The static qualification payload binds one exact platform profile: OS and
architecture, CRI name/version/endpoint identity, RuntimeClass name and handler,
nested runtime name/version/configuration hash, kernel release/security-policy
hash, node-image ID/content hash, cgroup-v2 driver/delegation policy, seccomp,
AppArmor, SELinux and user-namespace settings, non-privileged policy, GPU
driver/device-plugin/toolkit identities when GPU is declared, a fixed-digest
worker, worker uid/gid, shared scratch root, and parent Pod CPU/memory/PID
ceiling. A RuntimeClass name alone is only a CRI selector.

That overlay must provide a pod-local rootful daemon through the reserved
`qualified-runtime-run` `emptyDir` and mount the same `tmp` `emptyDir` as the
supervisor. It must not use a privileged or unconfined container, a node
`hostPath`/Docker socket, or a remote Docker endpoint. Before the supervisor is
allowed to start, an external conformance service must actually launch the
fixed-digest worker from the supervisor-visible namespace and publish a
separately signed, current-Pod receipt. The gate verifies all of:

- supervisor-created bind sources are visible and writable by the worker;
- a challenge read-back hash, result paths, exact uid/gid, and containment in
  the shared scratch root;
- `network=none` is effective;
- memory, CPU, and PID limits are effective inside the worker; and
- nested workloads remain bounded by the declared parent Pod resource ceiling.

The conformance payload additionally binds the qualification subject hash,
profile ID/hash, deployment plan hash, actual Kubernetes Pod UID, observation
time, and exact proof set. Its Ed25519 signer key, subject, public-key SPKI hash,
and normalized trust-store organization must be disjoint from the platform
qualifier.

Key separation alone is not control-domain independence. The evidence volume
must also contain `authority-independence.json`, a short-lived Ed25519-signed
attestation bound to the same qualification subject, conformance subject,
deployment plan, profile, and current Pod. It carries platform-attested
external principal identity subjects for the qualifier, conformance operator,
and deployment operator. Their provider, provider-account, credential-root,
host, process, signer-SPKI, principal, service, and trust-domain identities must
all be pairwise distinct. The three control-domain organizations and the
independent attestor's trust-store organization must also be distinct after
Unicode, case, and whitespace normalization. The qualifier and conformance
identity SPKI and principal bindings must match their actual trust-store keys;
the deployment operator identity must match the content-pinned configuration.
Missing, self-hashed-only, expired, re-sealed, or coordinated dual-key evidence
fails closed and cannot set `externallyQualified=true`.

All three canonical payload hashes, exact bundle bytes, trust-store
bytes/canonical identity, signature roles, signer identities, organizations,
and validity windows are checked. The short-lived conformance and independence
receipts therefore cannot be replayed into a replacement Pod.

Run the same gate directly with
`npm run automation:nested-runtime-platform-qualification -- --config ...`.
The complete command is
`hepta-paper operator nested-runtime-platform-qualification -- ...`.
`paper-core/deploy/nested-runtime-platform-qualification.config.example.json`
shows the external public trust configuration. The immutable evidence PVC must
contain `config.json`, `trust-store.json`, `qualification.json`, a current-Pod
`conformance.json`, and a current-Pod `authority-independence.json`; an external
controller must patch all three exact bundle content hashes into the Pod
annotations before the init can pass.
Admission must also bind the annotated plan/profile/RuntimeClass and parent
ceiling to the admitted Pod and site overlay. The mounted configuration and hash
annotations are not an independent root of trust: an immutable external
admission policy must pin the permitted qualifier, conformance, and
independence-attestor subjects, key IDs, organizations, and Ed25519 SPKI hashes,
plus the deployment-operator principal/provider/organization/trust-domain
identity, and reject coordinated replacement. Deleting the gate or trusting
annotations by themselves is not qualification. The verifier only validates
already produced evidence; it does not launch the worker, execute conformance,
or generate a receipt. Loading images or running `docker info` cannot
substitute for the signed conformance and control-domain-independence receipts.

Kubernetes startup, readiness, and liveness probes call only zero-write
inspectors. The startup probe requires startup reconciliation. The readiness
probe rereads the current machine-intake configuration, topic-producer profile,
provider binding and implementation identity, then requires their hash to match
the resident reconciliation receipt. Replacing or deleting a mounted authority
therefore clears readiness even while a prior heartbeat remains healthy. An
expired heartbeat makes liveness fail and lets the Deployment recreate the
process. systemd disables start-rate limiting so
`Restart=always` continues recovery after repeated transient crashes; lifecycle,
provider, qualification, and campaign budgets remain persisted across every
restart.

`bootstrap-only` intentionally fails the fully-autonomous readiness probe while
the heartbeat-only liveness probe stays healthy; Kubernetes must not restart a
resident merely because a renewable pointer is absent. Readiness performs
bounded local hashing of current configuration, dataset manifests, code
identity, and cached receipts. It performs no network/provider/KMS action, but
its local I/O and CPU cost is non-zero; the deployment therefore uses a
25-second probe timeout and a 30-second period rather than a tight polling loop.
With `--require-fully-autonomous`, the read-only health report embeds the
autonomous-state safety inspection and its blockers, and readiness also requires
that inspection to be ready. Heartbeat-only liveness remains independent, so a
blocked safety prerequisite makes the resident unready without representing it
as a crashed process.
This resident health probe is distinct from the operator-invoked
`automation:research-status` command, which explicitly opts into live provider
canaries and release-attestor backend/signature challenges.

The resident and campaign lifecycle leases default to fifteen minutes with a
30-second resident heartbeat. This covers the release-attestor's declared
five-minute backend probe plus five-minute active signer challenge with an
explicit five-minute margin. The supervisor also renews both fences
synchronously at startup, intake, runtime, provider-canary, qualification, and
campaign-dispatch boundaries; fence loss throws before the next synchronous
stage. A missed heartbeat still expires closed. For the systemd path,
`RuntimeMaxSec=8h` forces a periodic graceful roll; if a hung event loop cannot
handle `SIGTERM`, the fifteen-minute `TimeoutStopSec` ends it and
`Restart=always` creates the replacement. Thus systemd hang recovery is bounded
to at most 8 hours 15 minutes without relying on application event-loop
progress, while leaving headroom above the default six-hour campaign wall-time
budget.
