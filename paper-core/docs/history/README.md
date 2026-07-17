# Historical architecture and remediation records

Files in this directory are immutable decision history. They describe earlier
migration targets, phased remediation work, or release snapshots and are not
the current operating specification.

Current authority is intentionally small:

- `../CURRENT_STATUS.md` — current implementation and trust boundaries;
- `../OPERATIONS.md` — operator procedures;
- `../COMMAND_SURFACE.md` — supported command surface;
- `../ARCHITECTURE.md` — normative architecture and dependency taxonomy.

`architecture-v3.md` and `architecture-hardening-v4.md` are retained here as
versioned rationale only; they are not active specifications.

Historical documents may contain paths, counts, or status statements that are
no longer current. New code and release gates must not import or parse them.
