# External blocker closure runbook

Repository PR approvals are not part of this runbook. The owner-retired
`EXT-GOV-MAIN-001` package is historical V1 only; use the six-package explicit
V2 request for current operational qualification. Signing principals below are
runtime evidence owners, not mandatory human source-code approvers.

This runbook is the execution checklist for the blockers that cannot be closed
from the repository worktree alone. Every package is evidence-only until an
independent reviewer accepts the exact candidate. No step grants production,
writer, release, portal or submission authority automatically.

## Required package workflow

For every package:

1. Pin the candidate commit and tree from the exact pull-request head.
2. Run the listed preflight on infrastructure controlled by the named executor.
3. Write the result against the referenced schema and include the exact head,
   tool versions, timestamps, and artifact hashes.
4. Store the raw evidence and a signed closure receipt in the issue package.
5. Have the named independent reviewer verify the receipt, then re-run the
   repository currentness checks before any merge or activation decision.

## Blocker packages

| Blocker / issue | Executor | Preflight and evidence | Closure condition | Forbidden shortcut |
|---|---|---|---|---|
| `GAP-HOST-001` / #17 | Target-host operator plus independent Linux reviewer | On the dedicated host run `docs/rust/qualification/hepta-broker-host-qualification.sh` and `hepta-broker-cgroup-v2-target-host-qualification.sh`; retain listener, UID/GID, SO_PEERCRED, systemd, cgroup and schema receipts under `independent-linux-review-v1.schema.json`. | The receipts are bound to the exact binary/configuration identity and independently signed. | Hosted CI or a local fixture cannot qualify the target host. |
| `GAP-HOST-002` / #12 | Destructive test-mount operator plus independent reviewer | Run WAL/reboot, disk-full, corruption, restore, rollback and 72-hour production-topology soak on a disposable mount; package the result with `external-host-storage-package-v1.schema.json` and `production-cutover-soak-v1.schema.json`. | Every destructive drill completes, recovery is data-preserving, and the independent reviewer accepts the retained logs and hashes. | Do not run destructive drills against the live store or treat a short local test as the soak. |
| `GAP-KEY-001` / #14 | External capability-key owner plus independent reviewer | Perform key rotation, revocation, rollback and compromise drills using the external key-owner package; retain signed receipts under `external-key-owner-drill-v1.schema.json`. | The key owner confirms custody separation and the reviewer verifies that revoked material cannot authorize a run. | Repository-local test keys cannot close external key custody. |
| `GAP-CODEX-001` / #21 | Codex account owner and distinct author/reviewer principals | Pin the qualified Codex executable/CLI, authenticate separate homes, run author and reviewer canaries, and retain role receipts under `authenticated-codex-role-canary-v1.schema.json`. | Both canaries pass with no credential leakage and the reviewer verifies role separation. | Fake providers, an unauthenticated local binary or one shared home are insufficient. |
| `GAP-REL-001` / #22 | Campaign database operator, KMS/HSM/WORM, release, portal and submission owners | Collect the independent cutover-soak receipt (`production-cutover-soak-v1.schema.json`) and authority-set receipt (`external-authority-set-v1.schema.json`), including release, WORM, portal and single-use submission evidence. | Every authority issues a verifiable receipt; model and broker principals retain zero external-authority secret. | A local Ed25519 key, unsigned hash or source-only release report cannot promote this package. |
| `LEGACY-REPLAY-001` / #28 | Private companion operator plus independent archive/replay reviewer | Run the private 263-file replay against the exact public candidate and archive/matrix digests; retain the 263/263 receipt, artifact index, network-isolation and cleanup evidence under `legacy-matrix-replay-closure-v1.schema.json`. | The replay is complete and the independent archive/replay reviewer acknowledges the exact evidence. | The public repository cannot self-assert the private archive replay. |

## Final handoff gate

After all operational packages are accepted by their named authorities,
regenerate the exact-head qualification artifacts and run
`docs/rust/tools/verify-effective-status-current.py` against the current checkout.
No protected-main human-review ceremony is repeated. A package
whose head, tree, producer run, configuration or authority receipt changes is
invalid and must be regenerated. Only then may the repository owner decide
whether the separate parity, production-activation and Node-retirement gates
can change.
