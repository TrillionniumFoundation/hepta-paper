# Principal and filesystem authority matrix

This document is normative for production-shaped deployment. UID/GID values are
installation-specific; relationships and permissions are not.

## Principals

| Principal | May hold | Must never hold |
|---|---|---|
| `hepta-core` | campaign request signer/client capability | Codex credential files, broker journal, release keys |
| `hepta-broker-<role>` | one listener, one broker journal, role runtime identity | campaign DB writer, role-peer home, release/submission authority |
| `hepta-codex-<role>` | one role Codex home and attempt/bundle access | broker journal, trust signing key, campaign/release authority |
| `hepta-trust-owner` | capability trust-bundle publication/signing authority | broker or Codex execution identity |
| `hepta-schema-owner` | output-schema publication authority | Codex execution identity |
| `hepta-release` | release input and narrow signing invocation | Codex credential or mutable campaign workspace |
| `hepta-submit` | single-use permit and portal credential | Codex credential or general campaign writer |
| `hepta-backup` | backup/restore authority | model execution or submission authority |

Author, reviewer, formal-reviewer and repairer roles use separate broker and
Codex principals in production. Shared UID deployment cannot claim role
isolation.

## Listener access modes

### `service_principal_only`

For in-process/local fixtures only:

```text
listener parent owner  broker UID:GID
listener parent mode   0700
socket owner           broker UID:GID
socket mode            0600
allowed SO_PEERCRED     broker UID:GID only
```

### `shared_role_group`

Required when a separate campaign/client UID connects:

```text
access group            hepta-broker-<role>-access
broker membership       yes
allowed client membership yes
unrelated role membership no
listener parent owner   broker UID:access GID (or root:access GID)
listener parent mode    0750 (0710 permitted only by an explicit policy)
socket owner            broker UID:access GID
socket mode             0660
marker owner/mode        broker UID:GID, 0600
```

Filesystem membership permits pathname access; it does not authorize a
request. The broker must still verify exact `SO_PEERCRED` UID/GID and a
role/audience-bound, short-lived signed capability.

A qualification is invalid unless it proves both:

1. at least one intended separate client UID completes a live request; and
2. an unrelated role UID fails while the same listener is alive.

## Canonical paths

| Object | Example | Owner | Mode | Writer |
|---|---|---|---:|---|
| Author listener root | `/run/hepta/codex-author` | broker:access | 0750 | broker only |
| Author socket | `broker.sock` | broker:access | 0660 | kernel/broker |
| Listener marker | `broker.sock.listener.json` | broker:broker | 0600 | broker only |
| Broker state root | `/var/lib/hepta/broker-author` | broker:broker | 0700 | broker only |
| Broker SQLite | `journal.sqlite` | broker:broker | 0600 | broker only |
| Trust root | `/etc/hepta/trust/author` | trust-owner:trust-read | 0750 | trust owner |
| Trust bundle | `bundle.json` | trust-owner:trust-read | 0440 | trust owner |
| Schema root | `/etc/hepta/schema/author` | schema-owner:schema-read | 0750 | schema owner |
| Output schema | `output.schema.json` | schema-owner:schema-read | 0440 | schema owner |
| Pre-exec gate | `/usr/local/libexec/hepta/hepta-codex-preexec-gate` | root:root | 0555 | deployment owner |
| Role Codex home | `/var/lib/hepta/codex-author/home` | codex-author:codex-author | 0700 | codex-author |
| Attempt workspace | deployment-specific COW root | workspace owner | policy-specific | author/repair role only |
| Frozen review bundle | immutable review root | workspace owner:review-read | 0550/0440 | no reviewer write |

Every ancestor from `/` to the leaf is inspected for canonical path, real
object type, owner and write permissions. A trusted leaf under a writable or
replaceable ancestor is not qualified.

## Systemd boundary

Each role service unit must bind exact:

```text
User=
Group=
SupplementaryGroups=
RuntimeDirectory=
StateDirectory=
ReadOnlyPaths=
ReadWritePaths=
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
RestrictAddressFamilies=AF_UNIX
```

Additional containment requirements are defined by `RUST-BRK-020`; a unit that
permits descendant escape cannot become production eligible.

## Root and same-UID assumptions

Root and the host deployment authority are inside the trusted computing base.
The current filesystem design is not a boundary against malicious root. A
non-cooperating process sharing a writable UID with a broker, campaign writer or
workspace owner is also part of that principal's TCB.
