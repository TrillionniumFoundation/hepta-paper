# Personal self-hosted local operation mapping

The `personal-self-hosted-v1` profile keeps the safety purpose of the
installation, canary, rollback, and target-host checks without importing
external distribution authority. The mapping is part of the hash-bound profile
payload as `localOperationMapping`; the Rust and Node readiness reports emit the
same value.

| Distribution gate name | Personal profile disposition | Existing local controls | Scope boundary |
|---|---|---|---|
| target-host cgroup/storage | `replaced_by_local_deterministic_controls` | `credential-and-runtime-boundary`, `database-inventory-and-schema` | No broker listener or destructive host soak is enabled. Runtime ownership, physical separation, SQLite/WAL/SHM inspection, and schema integrity remain required. |
| installed cutover | `local_source_bound` | `exact-code-provenance`, `credential-and-runtime-boundary` | The private invocation is bound to the clean source tree and owner-controlled runtime. This does not claim a portable installer, distribution package, or Node cutover. |
| live/provider canary | `local_deterministic_replay` | `formal-operational-zero-skipped`, `enabled-scientific-oracles` | Formal and enabled CPU/GPU replay are local observations. No provider credentials, live account, broker, or external action is used. |
| rollback/recovery | `local_restore_and_anti_rollback` | `database-restore-drill`, `online-anti-rollback` | The local backup/restore drill and monotonic database ledger cover private recovery. External writer transfer and distributed rollback remain outside this profile. |

A report is profile-scoped production readiness only when all seven required
local controls and every enabled scientific capability pass. The mapping does
not alter the distribution lane's external blocker ledger and does not grant
release, submission, provider, target-host, or Node-retirement authority.
