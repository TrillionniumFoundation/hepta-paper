# Codex output-schema authority V1

## Problem

A schema file owned by the Codex execution UID is not immutable merely because
its mode is `0400`. The owner can chmod, rewrite, let Codex consume altered
bytes and restore the original bytes before postflight. End-state hash equality
would not detect the temporary authority violation.

## Production policy

Production qualification requires `SchemaAuthorityModeV1::SeparateOwner`:

```text
execution UID:     non-root Codex broker principal
execution GID:     role-specific schema-reader group
schema owner UID:  distinct schema authority
schema owner GID:  execution GID
schema file mode:  0440
schema parent:     schema authority owned, group r-x, no group/other write
```

The schema file must be a canonical, single-link regular file outside the
mutable workspace. The immediate parent directory and file object identities are
captured before execution and revalidated after process-group cleanup. The
parent rejects group/other write, requires the schema-reader group, and cannot be
owned by the execution UID in production. Deployment qualification must also
show that ancestors above the bound parent cannot be renamed by the execution
principal.

`LocalFixtureSameOwner` remains available only for source tests with fake
executables. It is explicitly not production eligible and cannot be used for
installed-binary or live-provider qualification.

## Other control files

`output-last-message` is intentionally writable by the execution principal, but
is pre-created, private, single-link, initially empty, outside the mutable
workspace and bound to the original inode. Replacement or permission drift is
rejected at postflight.

## Remaining deployment qualification

Source contracts do not prove the service unit, Unix users/groups, mount
permissions or host administrators enforce this topology. Production evidence
must include owner/group/mode listings, negative write probes by the execution
UID, pre/post object identities and a role-specific service configuration.
