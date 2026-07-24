# Autonomous-research state backup

The autonomous-research resident uses a closed, versioned inventory for every
SQLite database that carries workflow, lease, budget, qualification, or
publication authority. `paper-core/config/autonomous-research-state-databases.v1.json`
currently covers:

- the native `hepta-paper.sqlite` store;
- the isolated autonomous-submission handoff store;
- machine-intake and topic-producer state;
- supervisor, resident-instance, and runtime-reproducibility refresh state;
- the singleton external-qualification database whose rows are keyed by paper scope;
- the full-research qualification publication authority database; and
- the runtime-image reproducibility publication authority database.

Any unknown top-level `runtimeRoot/*.sqlite` or `.sqlite` file below
`runtimeRoot/autonomous-research` blocks the inventory. Missing mandatory
roles, symbolic links, path escapes, failed SQLite quick checks, or foreign-key
violations also block it. Each role additionally binds a versioned
`schemaContractId` and a sorted `requiredSchemaObjects` set; an instance missing
any required table, index, trigger, or view is not accepted as that role.
Backup/archive directories are not active database roots and are validated as
bundle content instead. Extend the manifest, schema contract, and domain role
set before introducing another autonomous trust database.

Legacy per-paper `external-qualification-state.sqlite` files are not silently
imported or excluded. They are unknown databases under the canonical singleton
manifest and block readiness until an externally authorized, quiesced scope
transition is completed. The resident never performs that transition online.

The existing optional `runtimeRoot/paper-automation.sqlite` is an explicitly
retired placeholder: it is zero bytes, has no schema, and no production source
references its name. The manifest excludes it only while it remains an empty
regular file with no WAL/SHM sidecars. Any content or sidecar blocks inventory,
so it cannot silently become a second automation authority. A fresh deployment
does not need to create it.

## Operator command

A fresh production runtime can build all ten canonical business schemas in one
atomic, fresh-root-only operation before the external online schema transition.
The plan binds the version-2 machine-intake configuration, topic-producer and
provider identities, runtime-refresh policy, writer manifest, and exact target
root. Execute stages every database on the target filesystem, validates all ten
roles, and renames the complete staged root atomically; a partial failure never
installs the target root:

```bash
npm run automation:autonomous-research-state-provision -- \
  --action plan \
  --runtime-root /var/lib/hepta-paper/runtime-next \
  --machine-intake-config /etc/hepta-paper/intake/config.json \
  --topic-producer-profile /etc/hepta-paper/intake/topic-producer-profile.json \
  --dataset-root /srv/hepta-paper/datasets \
  --provider-canary-pair-maximum-cost-usd 1 \
  --runtime-reproducibility-maximum-attempts-per-epoch 4 \
  --runtime-reproducibility-maximum-cost-usd-per-epoch 10
npm run automation:autonomous-research-state-provision -- \
  --action execute --execute --plan-id sha256:PLAN_ID \
  --runtime-root /var/lib/hepta-paper/runtime-next \
  --machine-intake-config /etc/hepta-paper/intake/config.json \
  --topic-producer-profile /etc/hepta-paper/intake/topic-producer-profile.json \
  --dataset-root /srv/hepta-paper/datasets \
  --provider-canary-pair-maximum-cost-usd 1 \
  --runtime-reproducibility-maximum-attempts-per-epoch 4 \
  --runtime-reproducibility-maximum-cost-usd-per-epoch 10
```

Execute requires the independently provisioned machine-intake genesis documents
and never creates or self-signs them. The resulting business-schema receipt is
not online anti-rollback readiness. Run the externally authorized ten-database
online schema transition next, followed by signed `renew` or
`reconcile-and-renew` backup/restore validation.

The supported production command is registered as
`automation:autonomous-research-state-backup` and as the `autonomous-state-backup`
operator route:

```bash
npm run automation:autonomous-research-state-backup -- --action status
npm run automation:autonomous-research-state-backup -- \
  --action backup --authority-config /run/hepta-authority/backup-client.json
npm run automation:autonomous-research-state-backup -- \
  --action restore-drill --authority-config /run/hepta-authority/backup-client.json \
  --bundle /srv/hepta-paper/runtime/backups/autonomous-research-state/<bundle-id>
npm run automation:autonomous-research-state-backup -- \
  --action renew --authority-config /run/hepta-authority/backup-client.json
npm run automation:autonomous-research-state-backup -- \
  --action reconcile-and-renew \
  --authority-config /run/hepta-authority/backup-client.json \
  --online-authority-process-config \
    /etc/hepta-paper/online-mutation-authority/process-config.json
```

`status` is read-only. `backup` writes a content-addressed bundle below
`runtimeRoot/backups/autonomous-research-state`. `restore-drill` copies every
bundle database into a temporary directory, runs integrity/schema checks, and
writes a drill receipt into the bundle; it never replaces production state.
`renew` is one atomic application flow: it creates a bundle, drills that exact
returned bundle, and publishes `RENEWAL_RECEIPT.json` only after both steps
pass. A successful backup followed by a failed drill never publishes renewal
success.
`reconcile-and-renew` is the resident startup action. Under the deployment's
same external `flock`, it resolves the exact canonical ten-database inventory,
uses the pinned online-mutation authority to finalize only committed local
pending markers, resolves the inventory again, requires the physical scope and
schema projection to remain unchanged, and proves that every database has zero
pending finalizations before calling `renew`. It never replays business DML.
A reserve-only crash is automatically aborted only while a write lock proves
that the marker is absent and the exact local database sequence, hash, schema,
and state hash still equal the signed reserve request's previous state. The
signed abort receipt is retained in the reconciliation receipt. An altered or
ambiguous marker, unknown operation, local-head drift, authority scope drift,
or finalize failure blocks before backup creation.
The receipt embeds both the exact current-head request and the complete signed
current-head response, plus a separately checked receipt hash. This preserves
the external signature and its bundle/scope binding for offline verification
after the bundle is transferred to WORM storage.

When the live authority head advanced after the snapshot, the drill requires
an externally signed complete finalized-mutation journal from snapshot head to
fresh current head. It verifies every original online reserve/finalize
signature, gap-free global and per-database continuity, exact scope/schema, and
changeset hashes. Only temporary restored copies receive the signed business
changesets; the drill then rebuilds their immutable marker/finalization rows and
requires every recovered database head to equal the signed target head.
Missing, duplicated, reordered, out-of-scope, or modified journal records block
the drill. Production databases are never replay targets.

WORM source resolution examines bundle directories from newest to oldest and
selects the newest complete, restore-drill-passed bundle. A newer pending,
undrilled, corrupt, or scope-mismatched candidate is recorded as skipped and
does not hide an older valid bundle. Skip records expose only fixed blocker
codes, modification time, and a hash of the directory name; they never copy
candidate paths, parsed payloads, signatures, or process errors. If every
candidate is invalid, resolution fails closed with no selected bundle.
Resolution also requires the pinned external authority trust and
cryptographically re-verifies the reservation, finalization, and embedded
current-head signatures at their recorded signing/restore times. Supply the
public-key-only process configuration explicitly when exporting to WORM:

```bash
npm run offhost:worm-snapshot -- --execute \
  --authority-config /run/hepta-authority/backup-client.json
```

`HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG` is the equivalent
deployment-only environment input. Loading it verifies the pinned executable
and public-key document but the resolver never invokes the broker. Missing or
incorrect trust blocks state-source selection and cannot be replaced by a
local success flag.

## External authority boundary

Backup and restore-drill fail closed without an external authority client.
There is deliberately no production implementation that signs or advances an
authority head locally. The configured command is only a JSON-over-stdio client
for an independently administered, linearizable broker. It must not contain or
have filesystem access to the broker's private signing key. The runtime config
contains only a pinned Ed25519 public-key document with this shape:

```json
{
  "version": 1,
  "kind": "AutonomousResearchStateBackupAuthorityPublicKey",
  "authorityId": "example-independent-authority",
  "keyId": "example-key-1",
  "algorithm": "ed25519",
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
}
```

The recovery-journal profile uses process-configuration version 2. It also
pins the public-only online-mutation authority verifier configuration, allowing
the restore process to verify each original reserve/finalize signature:

```json
{
  "version": 2,
  "kind": "AutonomousResearchStateBackupAuthorityProcessConfiguration",
  "authorityId": "example-independent-authority",
  "keyId": "example-key-1",
  "commandPath": "/opt/hepta-authority/bin/backup-head-client",
  "commandSha256": "sha256:<64 lowercase hex characters>",
  "publicKeyPath": "/run/hepta-authority/backup-public-key.json",
  "publicKeySha256": "sha256:<64 lowercase hex characters>",
  "fixedArguments": [],
  "timeoutMs": 30000,
  "maximumReservationLeaseMs": 60000,
  "maximumHeadObservationAgeMs": 30000,
  "onlineMutationAuthorityConfigurationPath": "/etc/hepta-paper/online-mutation-authority/authority-config.json",
  "onlineMutationAuthorityConfigurationSha256": "sha256:<64 lowercase hex characters>"
}
```

`commandPath` must be the dedicated pinned broker client, not a generic
interpreter followed by an unpinned script; fixed arguments are therefore
required to be empty. The client receives one request on stdin and returns one
signed receipt on stdout. The broker reservation must sign the exact database
inventory and attest that
all registered mutations are fenced through finalization. A restore drill also
requires a fresh, expiring signed observation of the same live authority head;
a locally recomputed hash or a caller flag cannot substitute for it.

This command does not by itself turn same-UID SQLite writers into an
anti-rollback boundary. The strict production code graph covers all ten
registered roles through sixteen writers and 202 coordinator-integrated online
DML operations, but the broker may issue fencing attestations only after the
exact deployed manifest has reconciled and activated against its current
signed head (or while an equivalent external write freeze is active). Explicit
offline maintenance and non-strict compatibility factories are outside that
online claim. Without live strict-profile activation and current external
evidence, backup remains blocked and whole-runtime anti-rollback readiness
remains No-Go.

`autonomous-research-state-backup-renew.timer` creates a fresh snapshot and
drill every 12 hours, with persistent scheduling, jitter, and 15-minute retry
after transient failure. Its `flock` prevents only same-host duplicate jobs;
the external reservation remains the cross-process fence. The timer is for
fresh-snapshot retention, not continuous resident admission.

The canonical systemd resident runs `reconcile-and-renew` under the same host
lock as `ExecStartPre`; the periodic timer remains the ordinary `renew` action.
A committed marker left by a prior resident is therefore finalized before the
new snapshot is attempted, avoiding the former startup ordering deadlock.
A restarted or identity-rotated resident cannot enter synchronous state-safety
activation with pending finalization or stale restore evidence. Failure to
acquire the lock, reconcile the exact scope, or complete the externally
authorized renewal keeps startup fail-closed; `Restart=always` retries without
weakening the authority or inventory binding.
The resident unit gives this bounded ten-database pre-start protocol an
explicit one-hour start timeout instead of inheriting a shorter host default;
the periodic renewal unit has a separate 30-minute bound.

At resident quiet points, the recoverability controller observes the fresh
signed backup-authority head. If it advanced, the controller re-drills the
latest valid baseline bundle through the complete journal and atomically
replaces its restore receipt. It falls back to a fresh backup only when no
baseline exists, the baseline enters the fresh-snapshot window, or the bounded
journal range is too long. Transient authority failures return a global
deferred result; scope, identity, signature, continuity, or journal tampering is
fatal and requires safe resident reactivation. The controller API is provided
for resident composition; a deployment must wire it to the active resident
lease and every final external-side-effect fence.
