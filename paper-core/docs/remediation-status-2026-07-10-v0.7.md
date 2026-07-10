# v0.7 isolation and archive-independent audit checkpoint

This checkpoint implements every internally actionable item from the v0.6
audit while preserving external and human authority boundaries.

## Completed engineering controls

- Test, CI, coverage, governance and release commands use disposable runtime
  roots. Direct selftest invocation rejects non-isolated state. Status and
  logical-integrity commands use a read-only StorePort.
- SQLite release evidence binds byte hashes and a canonical logical hash. A
  one-time administrative repair removes the duplicate historical pilot
  receipt whose key did not match its receipt hash; it does not promote the
  pilot to academic, owner or operational evidence.
- The 263-row source hash/symbol audit selectively restores the required files
  from the ext4-immutable archive using a tracked manifest. The live legacy
  working directory is not a release dependency.
- Cold-data recovery has deterministic content-addressed import, immutable
  manifests and a restore drill. Off-host WORM has a distinct-device,
  immutable-object and restore-drill contract.
- The whole-repository coverage gate is raised to 25% lines, 50% branches and
  30% functions. Paper contracts are split into bounded modules, and
  blocker-family aggregation is separated from batch summary.
- External packets bind the final code provenance for 13 owner families, 14
  capability proof families, four authority roles, the real-paper production
  chain and off-host WORM handoff.

## External blockers retained

- Owner acceptance: 0/249 until externally signed family documents arrive.
- Operational proof: 0/161 until production-bound, replayable receipts arrive.
- Required separated trust roles: 0/4 until real public keys and signed
  documents are onboarded.
- Cold-volume replay and CAS import remain blocked while `THUNDERO_EXT4` is
  absent.
- Off-host WORM remains blocked while the declared distinct device is absent.
- Production provider executor and live external actions remain absent.

The active legacy control plane remains retired. The complete legacy archive
is an immutable cold reference, not a functional-parity claim. Physical
deletion remains forbidden until the external acceptance and operational gates
are satisfied and a separately authorized destructive action is approved.
