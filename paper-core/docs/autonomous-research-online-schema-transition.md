# Autonomous-research online schema transition

The online mutation runtime requires every database in the closed autonomous
state inventory to contain the externally fenced mutation marker schema. The
resident database additionally contains the append-only authority journal.
This one-time transition is an explicit maintenance operation; ordinary status,
readiness, supervisor startup, and runtime activation only inspect its signed
final receipt and never install schema.

The resident journal schema is retained for transition compatibility but has
no production online writer. Current active evidence is persisted only after
state-safety validation in the derived JSON cache outside the canonical
database inventory; it does not advance the external mutation head.

## Maintenance command

Create a read-only plan first. The command simulates each database migration in
a temporary copy, verifies the business schema and closed inventory, reads the
pinned public trust through the authority process configuration, and emits a
stable `transitionId`. It does not create transition control state or write a
database.

```bash
npm run automation:autonomous-research-online-schema-transition -- \
  --action plan \
  --runtime-root /srv/hepta-paper/runtime \
  --authority-process-config /run/hepta-authority/online-mutation-process.json
```

After independently quiescing every registered writer, execute exactly that
plan with both explicit confirmations:

```bash
npm run automation:autonomous-research-online-schema-transition -- \
  --action execute --execute \
  --transition-id sha256:<transition-id-from-plan> \
  --runtime-root /srv/hepta-paper/runtime \
  --authority-process-config /run/hepta-authority/online-mutation-process.json
```

The equivalent routed command is
`hepta-paper maintenance autonomous-online-schema-transition -- <arguments>`.
An execute request without `--action execute`, `--execute`, the current
transition ID, the closed state manifest, or the pinned authority process
configuration fails before database mutation. There is no local trust override.

## Authority, recovery, and receipt

The process configuration pins both the external authority client executable
and its public-key configuration by SHA-256. The client reserves the exact
database scope and writer manifest before any installation. The transition
then holds exclusive SQLite locks, commits one database at a time while the
lease remains safe, finalizes the complete post-inventory with the external
authority, and performs a fresh final-state observation.

Crash state is durably recorded below
`runtimeRoot/autonomous-research/online-schema-transition`. A retry with the
same transition ID resumes already committed instances only while the stored
signed reservation remains valid; an expired, incomplete, or unverifiable
reservation fails closed. Successful completion writes `FINAL.json`, whose
audit receipt binds the plan, reservation, every per-database installation,
post-inventory, finalization, and live observation. Runtime activation accepts
only a freshly re-observed, hash-valid final receipt.

The protocol does not claim cross-database atomicity. Operators must retain a
complete externally fenced state backup and a passed restore drill before the
transition, and must keep the resident supervisor and all other writers stopped
until execution and receipt verification complete.
