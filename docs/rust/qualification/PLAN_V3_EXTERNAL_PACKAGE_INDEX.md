# Plan v3 external qualification package index

The machine-readable authority for this table is
`external-package-map.v1.json`. Every `external: true` gap in
`docs/rust/current-status.v1.json` must have at least one mapped package, and no
package may name an unknown gap or missing schema.

| Package | Gap | Repository deliverable | Required external executor | Acceptance record | Automatic activation |
|---|---|---|---|---|---|
| `EXT-GOV-MAIN-001` | `GAP-GOV-003` | CODEOWNERS, exact-head workflows, ruleset/denial evidence schema | repository administrator distinct from the implementation change plus independent reviewer | `protected-main-ruleset-evidence-v1.schema.json` | forbidden |
| `EXT-HOST-CGROUP-001` | `GAP-HOST-001` | cgroup-v2 stopped-child, `setsid`, double-fork and `cgroup.kill` harness | separately controlled target-host operator | `independent-linux-review-v1.schema.json` plus harness evidence | forbidden |
| `EXT-HOST-STORAGE-001` | `GAP-HOST-002` | WAL, SIGKILL, corruption, backup and restore harness | dedicated destructive-test-mount operator and observer | `hepta-broker-qualification-evidence-v1.schema.json` plus `independent-linux-review-v1.schema.json` | forbidden |
| `EXT-KEY-OWNER-001` | `GAP-KEY-001` | trust-bundle parser, rotation and rollback validators | external request/bundle signing authority | `external-key-owner-drill-v1.schema.json` | forbidden |
| `EXT-CODEX-ROLE-001` | `GAP-CODEX-001` | role-separated broker/runtime and canary contract | distinct author/reviewer service principals and provider authority | `authenticated-codex-role-canary-v1.schema.json` | forbidden |
| `EXT-CUTOVER-SOAK-001` | `GAP-REL-001` | writer, backup, restore, parity and cutover contracts | production-shaped database operator plus independent observer | `production-cutover-soak-v1.schema.json` | forbidden |
| `EXT-AUTHORITY-SET-001` | `GAP-REL-001` | narrow release/WORM/restore/dispatcher ports | four separately administered authority domains | `external-authority-set-v1.schema.json` | forbidden |

Every package is bound to one exact Git commit and tree. A later source change
invalidates earlier acceptance unless its evidence contract explicitly permits a
compatible, hash-bound carry-forward review. Repository administrators and
GitHub-hosted runners cannot sign the external executor or acceptance fields;
for `EXT-GOV-MAIN-001`, the configuring administrator additionally cannot act as
the sole independent reviewer.
