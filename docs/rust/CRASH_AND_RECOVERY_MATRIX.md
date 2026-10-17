# Crash and recovery matrix

Every state-changing boundary has one durable precondition, one externally
observable effect classification and one restart disposition. “Retry” is not a
fallback for uncertainty.

All source-level rows require an exact-head test. Physical durability, reboot,
mount and storage claims remain issue #12/#17 evidence.

## Qualification and merge evidence

| Fault point | Allowed result | Recovery | Qualification |
|---|---|---|---|
| workflow creates zero jobs | no source evidence | correct trigger/approval and rerun | fail |
| required context absent | incomplete check set | rerun on unchanged head | fail |
| required job skipped | explicit skipped result | fix relevance routing; rerun | fail |
| head changes during checks | old evidence retained only for audit | collect complete new-head matrix | invalidated |
| worktree becomes dirty | diagnostic artifact only | identify mutating gate; clean and rerun | fail |
| later required rerun fails | prior success remains historical | repair and derive a new artifact | demoted |
| review requests changes | source artifact may remain diagnostic | repair and obtain latest-head review | merge blocked |

## Broker admission and journal

| Fault point | Durable state allowed | Restart action | Provider retry |
|---|---|---|---|
| before DB creation | absent | create only under initialization marker | n/a |
| after marker, before empty DB fsync | marker + absent/empty DB | complete exact initialization or reject | n/a |
| after reservation insert, before commit | pre-transaction or committed reservation | integrity audit | no duplicate reservation |
| after nonce insert, before commit | pre-transaction or committed reservation+nonce | integrity audit | no nonce reuse |
| after transition insert, before projection | pre-transaction or transition+projection atomically | replay audit | state-specific |
| during WAL checkpoint | valid WAL set or fail-closed residue | checkpoint/audit; disable admission on unknown residue | no |
| disk full/read-only remount | no partial accepted transition | disable admission; operator repair | no |
| corrupt DB/WAL/SHM | no admission | immutable evidence copy; restore only from qualified snapshot | no |

## Durable provider launch

| Observation after restart | Release record | Action | Journal disposition | Retry |
|---|---|---|---|---|
| exact blocked gate | no | terminate contained process set | failed-after-spawn/pre-provider | policy-controlled same attempt |
| exact blocked gate | yes | terminate contained process set | result ambiguous | new attempt |
| released/running target | yes | terminate contained process set | result ambiguous | new attempt |
| orphaned descendant set | yes/uncertain | terminate exact containment set | result ambiguous | new attempt |
| process absent | no | record absence | failed-after-spawn | policy-controlled |
| process absent | yes | record ambiguity | result ambiguous | new attempt |
| PID/start/boot/session mismatch | any | do not signal | manual recovery; listener not ready | none |

Process-group-only observation is sufficient for local fixtures, not production.
Production containment identifies all descendants after `setsid`, double fork
or leader exit.

## Descriptor-bound workspace operations

| Fault/race point | Allowed residue | Detection | Recovery |
|---|---|---|---|
| entry replaced between metadata and open | no trusted entry | snapshot/object mismatch | reject attempt |
| symlink encountered | no traversal | `O_NOFOLLOW` + type check | reject attempt |
| regular-file hard link encountered | no trusted inventory | link-count check | reject attempt |
| nested device/mount encountered | no cross-device traversal | device mismatch | reject attempt |
| file mutates between hash passes | no accepted hash | hash/metadata mismatch | reject and quarantine |
| file mutates after copy | no accepted copy | source and target re-hash mismatch | delete only exact descriptor-owned partial file |
| directory mutates during enumeration | no accepted tree | before/after snapshot mismatch | reject and recompute from fresh attempt |
| attempt directory replaced | no publication | final public-path/descriptor binding fails | quarantine descriptor-owned object |
| tree/file bound exceeded | no partial acceptance | hard byte/entry cap | discard private staging |
| crash before attempt publication | absent/private staging | ownership marker/inventory | discard exact owned staging |
| crash after marker fsync | marker + complete/partial staging | identity and inventory audit | resume or quarantine |
| prepared result before campaign commit | immutable prepared result | hash and attempt identity | integrate without provider rerun |

A cleanup path never deletes a public pathname unless it still identifies the
exact object owned by the failed operation.

## Campaign writer activation

| Fault point | Allowed state | Recovery |
|---|---|---|
| authorization invalid/expired/not-yet-valid | database unchanged or unopened | reject activation |
| runtime subject mismatch | database unchanged or unopened | obtain a new exact-subject permit |
| database preimage changes before open | no writer authority | reject and inspect replacement |
| SQLite sidecar exists at activation | no writer authority | reconcile/checkpoint under old authority first |
| second activation races | at most one successful exclusive opener | loser fails closed |
| first lease differs from signed binding | opened store without acquired writer | reject lease and close |
| crash before first lease commit | no authoritative Rust writer | rerun with fresh preimage-bound permit |
| crash after first lease commit | one generation-fenced writer record | startup audit and lease recovery |
| stale generation attempts mutation | no state change | reject and record stale writer |
| prepared result exists during turnover | immutable prepared result | new higher generation integrates exactly once |

Repository tests use fixture signing keys only. Production activation still
requires independently issued cutover evidence and issue #12/#14/#17 closure.

## Campaign state boundaries

| Fault point | Durable state allowed | Recovery |
|---|---|---|
| claim/lease transaction interrupted | old state or atomically committed claim | startup integrity audit |
| prepared result transaction interrupted | old claim or atomically prepared result | recover without provider rerun |
| integration transaction interrupted | prepared or atomically integrated | exact-idempotent integration |
| budget settlement interrupted | old reservation or atomic settlement | never partial refund |
| terminal state written | terminal state and event | never reopen |
| backup creation interrupted | absent or complete private destination | remove/quarantine exact partial |
| restore interrupted before rename | private temporary restore | verify and discard/resume |
| restore interrupted after rename | complete published DB | integrity and event-chain audit |

## External authority operations

| Fault point | Required disposition |
|---|---|
| KMS/HSM response lost after request | reconcile by durable idempotency identity; do not blindly repeat |
| WORM publication ambiguous | query authoritative custody receipt |
| portal response ambiguous | reconcile submission identity before any retry |
| key rotation interrupted | retain last accepted generation or fail closed |
| governance denial probe incomplete | issue #25 remains open |
| private legacy replay interrupted | delete secret material; retain failure receipt only; issue #28 remains open |

## Required target-host drills

- broker and campaign writer `SIGKILL` at every durable boundary;
- host reboot before and after fsync/checkpoint;
- disk full, quota exhaustion and real write/fsync failure;
- read-only remount, permission/ACL and mount replacement;
- truncated, stale, missing or replaced WAL/SHM/journal files;
- main database/page/event-chain corruption;
- concurrent writer activation and stale-generation races;
- PID reuse and boot change;
- cgroup descendant escape attempts;
- checkpointed and valid-WAL restore;
- service-manager restart storm;
- 72-hour bounded production-topology soak.

The drill harness emits evidence but cannot independently approve it.
