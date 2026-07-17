# Autonomous research supervisor deployment contract

The canonical resident command is:

```sh
hepta-paper operator autonomous-supervisor -- --require-fully-autonomous --machine-intake-config /etc/hepta-paper/intake/config.json --topic-producer-profile /etc/hepta-paper/intake/topic-producer-profile.json --root /srv/hepta-paper/assets --runtime-root /var/lib/hepta-paper/runtime
```

For deployment admission, `automation-status --require-fully-autonomous`
returns exit code 4 until full research qualification, current machine intake,
and the resident supervisor are all ready. It performs no provider canary unless
that separate live-canary flag is explicitly requested.

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
The canonical deployment uses `--require-fully-autonomous`, so a missing intake
configuration fails closed. Without that flag, the supervisor may recover
existing campaigns, but reports `machineIntakeConfigured=false` and
`coldStartAutonomyReady=false` and makes no cold-start autonomy claim. Status
opens the intake SQLite database read-only and never loads or appends configured
intakes.

Supervisor lifecycle state is stored at
`runtimeRoot/autonomous-research/supervisor/supervisor-state.sqlite`.
Qualification state and its renewable attempt lease are stored per paper at
`runtimeRoot/autonomous-research/<paperId>/system-state/external-qualification-state.sqlite`.
Both use SQLite transactions and generation fences; an expired owner can be
replaced, while a stale owner cannot commit or release the replacement lease.

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

The external governance anchor is a deployment prerequisite, not resident
state. Before fresh version-2 initialization or rotation, an independent
operator must provision these public-only documents at the fixed root
`/etc/hepta-paper/authority-rotation`:

- `AUTHORITY_TRUST_STORE.json`
- `OWNER_TRUST_STORE.json`
- `AUTONOMOUS_RESEARCH_INTAKE_AUTHORITY_BOOTSTRAP.json`
- `AUTONOMOUS_RESEARCH_INTAKE_AUTHORITY_GENESIS.json`

Every path component from `/` through that directory must be root-owned and
must not be group- or world-writable. Each document must be a root-owned,
non-symlink regular file with link count one and no group/world write bit. The
service identity needs read access only. The resident never creates this root,
generates a key, signs a document, or copies the anchor into writable runtime
state. Genesis and bootstrap authorization require distinct
`capability_owner` and `operational_observer` signatures; the rotation intent
requires an `autonomous_research_intake_authority_rotator` signature.

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
and symlink checks. The template therefore omits pod `fsGroup`; provision the
writable runtime PVC for uid/gid `10001` separately. With systemd,
`ProtectSystem=strict` and the explicit `ReadOnlyPaths` entry make the fixed
anchor read-only to the resident, so external governance must stage or replace
it before starting the service, not from inside the unit.

Startup continuously rereads the fixed documents. Persisted genesis signatures
are evaluated at their signed `validFrom`; persisted bootstrap and intent
signatures, key windows, and document lifetimes are evaluated at the signed
intent `validFrom`, which is the authority-effective `rotatedAt`. Thus a sound
historical receipt remains verifiable after a key or document's ordinary
validity window has elapsed, while replacement, removal, shape drift, or
signature drift of the fixed external anchor still fails closed.

The local append-only trigger and receipt hash detect ordinary corruption but
are not an external monotonic-head service: a database owner can replace the
database with an entire previously valid snapshot or an empty database that is
again eligible for a valid signed genesis. Exporting a receipt after commit, or
adding a static fifth `HEAD` file, does not close this boundary because either
ordering leaves a crash window between the external head and SQLite commit.

Accordingly, deployment is **No-Go** when the threat model requires protection
against writable-runtime snapshot rollback/replacement. Closing that threat
requires an independently administered, linearizable authority-head broker
that externally creates and binds a `databaseInstanceId`, reserves the exact
next generation/receipt before mutation, lets the single SQLite transaction
apply that reservation, then finalizes it. Startup and crash recovery must
compare SQLite with the broker and deterministically reconcile reserved versus
finalized states. Until that reserve → apply → finalize/startup-compare protocol
is integrated, do not describe this command or the fixed root files as
same-UID whole-database anti-rollback protection. A WORM export remains useful
audit evidence, but is not a substitute for that online monotonic-head gate.

## Filesystem and secret boundary

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

- `HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG`
- `HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG`
- `HEPTA_AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_PROFILE`
- `HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT`
- `HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_REFRESH_ATTEMPTS_PER_EPOCH`
- `HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_REFRESH_COST_USD_PER_EPOCH`
- `HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_REFRESH_RENEWAL_LEAD_MS`
- `HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_REFRESH_ACTION_SAFETY_MARGIN_MS` (at least `900000`)
- `--qualification-action-safety-margin-ms` (at least `900000`)
- `--require-fully-autonomous`

The process configuration, qualification configuration, release-attestor
configuration, and provider credential roots are separate read-only mounts. The
runtime root is the single writable persistent mount and must survive restarts;
an ephemeral runtime root invalidates the lease and budget guarantees.

The auditable templates are:

- `paper-core/deploy/autonomous-research-supervisor.service`
- `paper-core/deploy/autonomous-research-supervisor.env.example`
- `paper-core/deploy/autonomous-research-supervisor.k8s.yaml`

The systemd unit uses `Restart=always`, `KillSignal=SIGTERM`, `KillMode=mixed`
so the foreground wrapper forwards one graceful stop before group-wide timeout
enforcement, a strict read-only system view, and an explicit `ReadWritePaths`
runtime root. The Kubernetes
template uses `restartPolicy: Always`, `terminationGracePeriodSeconds`, a
read-only root filesystem, a single SQLite writer with `Recreate`, separate
read-only asset, dataset, config and credential mounts, and one writable runtime
PVC. Replace image, PVC, model, and path placeholders in deployment automation; never place secret
values in the manifest or environment example.

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
