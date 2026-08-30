# Crash and recovery matrix

Every state-changing boundary has one durable precondition, one externally
observable effect classification and one restart disposition. “Retry” is not a
fallback for uncertainty.

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
Production containment must identify all descendants even after `setsid`, double
fork or leader exit.

## Workspace and package boundaries

| Fault point | Allowed residue | Recovery |
|---|---|---|
| before COW attempt publication | absent/private staging | discard exact owned staging |
| after attempt marker fsync | marker + complete/partial private staging | verify inventory; resume or quarantine |
| during mutation inventory | unchanged canonical source | recompute attempt inventory |
| after prepared result, before campaign commit | immutable prepared result | integrate without provider rerun |
| after no-clobber package rename, before final receipt | sealed candidate without authority | reconcile transaction journal |
| during CAS write | absent or complete content-addressed object | hash and discard incomplete private temp |
| during retention deletion | durable prepared/deleting/deleted state | replay exact terminal action only |

## Campaign writer boundaries

The future writer must prove:

```text
claim and lease generation commit atomically
prepared result and campaign revision compare-and-swap atomically
budget reservation settles exactly once
terminal state never reopens
stale generation cannot heartbeat, fail or complete
backup generation and restore drill precede destructive retention
```

## Required target-host drills

- broker SIGKILL at every fault point;
- host reboot before and after fsync/checkpoint;
- disk full and quota exhaustion;
- read-only remount/permission drift;
- truncated/stale/replaced WAL and SHM;
- main database/page/transition corruption;
- concurrent broker writer race;
- PID reuse and boot change;
- cgroup descendant escape attempts;
- checkpointed and valid-WAL restore;
- service-manager restart storm.

The drill harness emits evidence but cannot independently approve it.
