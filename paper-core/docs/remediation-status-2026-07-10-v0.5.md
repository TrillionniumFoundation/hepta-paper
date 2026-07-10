# v0.5 evidence isolation and cold-archive retirement

This checkpoint separates technical verification from production evidence and
does not authorize live submission.

## Completed engineering controls

- Test, CI and release verification run against disposable SQLite, CAS and
  receipt-ledger roots. The wrapper fails if the production database hash
  changes.
- Schema v3 classifies verification, administrative, pilot, operational and
  owner evidence. Historical unclassified records are not promoted.
- Stale unbound `latest` reports are quarantined. New latest files are
  commit/version/report-hash/expiry-bound pointers.
- The release evidence bundle binds code provenance, isolated verification,
  capability manifest, migration matrix, legacy database, cold archive,
  deletion/restore drill and hygiene export hashes. Its local Ed25519 signature
  proves build/archive integrity only.
- External owner and authority intake packets have been generated without
  generating private keys, signatures, acceptances or academic decisions.
- A separate no-network provider sandbox exercises durable dispatch, response,
  provider receipt validation, reconciliation and release with zero external
  actions.
- The legacy control-plane reference is hash-bound, POSIX read-only and
  restorable. The direct legacy-to-hepta workspace symlink has been removed.

## Evidence hygiene execution

- 121 verification/runtime-unclassified receipts were exported to quarantine
  and removed from the production ledger.
- One unattempted legacy-unclassified queued research-gap job was exported and
  removed.
- Production selftest and migration-fixture runtime trees were moved to
  quarantine.
- A pre-hygiene SQLite backup and hashes are retained under
  `runtime/backups/v0.5.0-evidence-isolation`.

## Gates that remain externally blocked

- `owner_accepted`: 0/249.
- `operationally_proven`: 0/161.
- Real trust roles: 0/4.
- Production provider executor: absent.
- Live external actions: 0.
- Physical deletion of the legacy archive: prohibited until owner acceptance,
  production-bound operational evidence and a later deletion approval exist.

The old active control plane is retired. The old source and database are a cold
reference archive, not a functional-parity claim and not a deletion candidate.
