# Plan v3 external qualification package index

| Package | Gap owner | Repository deliverable | Required external executor | Acceptance record | Automatic activation |
|---|---|---|---|---|---|
| `EXT-HOST-CGROUP-001` | Linux/SRE | cgroup-v2 stopped-child, `setsid`, double-fork and `cgroup.kill` harness | separately controlled target-host operator | `independent-linux-review-v1.schema.json` plus harness evidence | forbidden |
| `EXT-HOST-STORAGE-001` | Storage/SRE | WAL, SIGKILL, corruption, backup and restore harness | dedicated destructive-test-mount operator and observer | broker host evidence plus independent review | forbidden |
| `EXT-KEY-OWNER-001` | Capability key owner | trust-bundle parser, rotation and rollback validators | external request/bundle signing authority | `external-key-owner-drill-v1.schema.json` | forbidden |
| `EXT-CODEX-ROLE-001` | Codex runtime/account owner | role-separated broker/runtime and canary contract | distinct author/reviewer service principals and provider authority | `authenticated-codex-role-canary-v1.schema.json` | forbidden |
| `EXT-CUTOVER-SOAK-001` | Campaign database owner | writer, backup, restore, parity and cutover contracts | production-shaped database operator plus independent observer | `production-cutover-soak-v1.schema.json` | forbidden |
| `EXT-AUTHORITY-SET-001` | Release governance | narrow release/WORM/restore/dispatcher ports | four separately administered authority domains | `external-authority-set-v1.schema.json` | forbidden |

Every package is bound to one exact Git commit and tree. A later source change
invalidates earlier acceptance unless its evidence contract explicitly permits a
compatible, hash-bound carry-forward review. Repository administrators and
GitHub-hosted runners cannot sign the external executor or acceptance fields.
