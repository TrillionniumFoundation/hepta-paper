# Architecture P1/P2 review groups — 2026-07-14

This is the exhaustive review plan for the current uncommitted checkpoint. It
does not stage, commit, reset, publish, migrate, or mutate production data.

## Frozen boundary

- Base commit: `4712472a9a6569fa476f1830fd76b110a435cf35`
- File-level dirty entries: 475
  (`203 M / 42 D / 230 U`)
- Review metadata entries: 3
- Code, evidence, test, CI, and documentation entries: 472
- Exact content snapshot: `sha256:d84c6007fcc741ea6a4c38e39ac10a764676c27c31e8a635112b4175b3bfae7c`
- Index state: empty
- Production SQLite SHA-256:
  `e43668b36839fd59a3f97e83b63a71f408a5fea72df079b62c73b132597b4983`

The exact path, status, byte hash, move/retirement disposition, group, atomic
sets, and dependency order are frozen in
`architecture-p1p2-review-groups-2026-07-14.json`. Validate with:

```sh
node paper-core/verification/review-group-checkpoint.mjs
node paper-core/verification/review-group-checkpoint.mjs --details
```

Any new, missing, duplicated, staged, denied, status-drifted, or byte-drifted
path fails the checkpoint. Production-store or base-commit drift also fails.

## Review and commit order

| Group | Files | Scope | Depends on | Required evidence before committing |
| --- | ---: | --- | --- | --- |
| `RG00` | 3 | Review metadata | none | node paper-core/verification/review-group-checkpoint.mjs |
| `RG01` | 48 | Runtime primitives and receipt trust | none | focused runtime and receipt tests |
| `RG02` | 51 | SQLite 21-23, fencing, retention, and release authority | `RG01` | npm run safety:p0 |
| `RG03` | 15 | WorkerRunner v4, sandbox, executors, and runtime images | `RG01` | focused runner and executor tests |
| `RG04` | 22 | Campaign modes, alias identity, batch, and reporting | `RG01`, `RG02`, `RG03` | npm run automation:selftest:deduplicated |
| `RG05` | 35 | Adapter decomposition and hash-bound semantic matrix | `RG01`, `RG02`, `RG04` | npm run migration:p1-plugin-selftest |
| `RG06` | 19 | Governance ownership and capability verification | `RG01`, `RG02` | npm run paper:governance-contracts |
| `RG07` | 67 | Architecture, compatibility, command, and release toolchain | `RG03`, `RG04`, `RG05`, `RG06` | npm run static:check |
| `RG10` | 185 | Formal and empirical authority closure | `RG01`, `RG02`, `RG03`, `RG04`, `RG05`, `RG06`, `RG07` | npm run safety:all |
| `RG08` | 1 | Pinned CI integration | `RG07`, `RG10` | manual pinned-action and CI command parity review |
| `RG09` | 29 | Active and historical documentation | `RG02`, `RG03`, `RG04`, `RG05`, `RG06`, `RG07`, `RG08`, `RG10` | git diff --check |

`RG10` is the new atomic authority layer built on the earlier architecture
groups. It contains the production formal/replay/release closure, canonical
manuscript claims and independent review receipts, system-owned benchmark
harness, raw CAS/ledger observations, authoritative ExperimentRegistry,
source-lineage binding, and matching adversarial evidence.

CI and documentation are deliberately after RG10. Do not stage by directory and
do not split declared whole-file integration owners into unsupported
half-upgraded contracts.

## Atomic constraints

The manifest preserves and mechanically checks:

1. Schema 021–023, StoreProvider/schema gating, fencing/retention, and focused tests.
2. Semantic-matrix targets, immutable fixture, behavior hashes, and matrix evidence.
3. Package/toolchain/release-state markers as one unit.
4. WorkerRunner v4, sandbox identity, and runtime-image sources as one unit.
5. Query-only submission handoff and release-query authority as one unit.
6. All 20 migration pairs; each delete/add pair stays in one group.

The formal and empirical authority files added to `wholeFileIntegrationPaths`
must be reviewed hunk by hunk but staged as the reviewed final file. No temporary
matrix hash, weak receipt fallback, or partial port upgrade is acceptable.

## Runtime-image evidence

The earlier Docker-build evidence gap is closed. The configured images were
actually built and inspected locally:

- `hepta/python-scientific:0.13.0` —
  `sha256:9c02db63498c7229d11532aeda810d9728c4b31f3b0951688a186e93a2ac81c4`
- `hepta/python-gpu:0.13.0` —
  `sha256:dd8380ae35322355a5caa8103e436338932a67dfab45d0b194f4fe947f525452`
- `hepta/r-scientific:0.13.0` —
  `sha256:15c5d7e4e573a8fbec9e77e096d89e16bfa36de57786d5c238b6c3d28d4770a4`

Bubblewrap remains unavailable on this host because unprivileged namespaces are
blocked; Docker fallback was exercised by real sandbox and benchmark tests.

## Absolute exclusions

The manifest contains no SQLite database, WAL/SHM, `.env`, log, PEM/key,
symlink, local configuration, or high-confidence credential artifact. These
paths remain an absolute denylist even with `git add -f`:

```text
runtime/**
node_modules/**
core/reports/**
**/.lake/**
.env
.env.*
**/*.sqlite
**/*.sqlite-wal
**/*.sqlite-shm
**/*.pem
**/*.key
**/*.log
```

The final cross-group evidence is the complete isolated `npm test`,
retirement/capability matrices, unchanged production physical/logical hashes,
`git diff --check`, and a clean residual test/worker process check.
