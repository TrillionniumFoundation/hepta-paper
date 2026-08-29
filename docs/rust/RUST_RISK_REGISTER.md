# Rust rewrite risk register

Likelihood and impact are 1–5. Score 20 or higher blocks the next dependent
milestone unless the responsible external authority explicitly accepts a
bounded residual risk. “Mitigated” requires negative evidence, not prose.

| ID | Risk | L | I | State | Owner | Required evidence |
|---|---|---:|---:|---|---|---|
| RR-001 | Node baseline becomes a mutable permanent oracle | 3 | 5 | open | Compatibility | frozen commit/lock/image, offline corpus |
| RR-002 | Canonical hash drift invalidates history | 4 | 5 | open | Compatibility | dual verifier + adversarial corpus |
| RR-003 | Node and Rust write concurrently | 2 | 5 | open | Database | ownership lease + cutover drill |
| RR-004 | Codex credential leaks into child command/process | 3 | 5 | mitigating | Security | environment, `/proc`, FD and path attack suite |
| RR-005 | Reviewer independence is only nominal | 4 | 4 | open | Evidence | separate UID/home/socket/account receipts |
| RR-006 | Post-release crash duplicates a paid provider call | 4 | 5 | mitigating | Broker | durable gate/journal + ambiguity tests |
| RR-007 | Protocol drift becomes false success | 3 | 5 | mitigating | Broker | unknown terminal-like fuzz corpus |
| RR-008 | Agent self-report bypasses mutation policy | 3 | 5 | open | Workspace | authoritative before/after inventory |
| RR-009 | Existing defect is copied as parity | 4 | 4 | open | Architecture | disposition ledger + V2 ADR |
| RR-010 | Generic provider framework delays usable system | 4 | 3 | controlled | Product | Codex-only production composition |
| RR-011 | Experimental App Server expands TCB | 3 | 4 | controlled | Broker | exec JSONL V1-only architecture check |
| RR-012 | Hidden session state causes campaign drift | 3 | 4 | controlled | Broker | fresh ephemeral session contract |
| RR-013 | Shared implementation defeats independent verification | 4 | 5 | open | Evidence | implementation-diversity matrix |
| RR-014 | Filesystem recovery is inferred from unit tests | 4 | 5 | open | Workspace | kill/rename/fsync/restore matrix |
| RR-015 | SQLite migration corrupts live state | 2 | 5 | open | Database | production-shaped copies + restore canary |
| RR-016 | CI is green but unprotected or tests wrong ref | 4 | 5 | open | SRE | exact head/tree manifest + branch ruleset |
| RR-017 | Toolchain/dependency upgrade changes behavior | 3 | 4 | mitigating | SRE | lock, SBOM, vet/audit, reproducible build |
| RR-018 | Model quality regresses while deterministic gates pass | 4 | 4 | open | Product/Evidence | live evaluation thresholds |
| RR-019 | Missing usage is treated as zero cost | 3 | 4 | open | Campaign | conservative settlement/reconciliation |
| RR-020 | OpenClaw enters Rust indirectly | 3 | 3 | mitigating | Architecture | source/dependency/runtime graph ban |
| RR-021 | Oversized stacked PR cannot be reviewed/rolled back | 4 | 4 | open | Program | invariant-sized packages + integration branch |
| RR-022 | Logs/artifacts capture prompts or manuscripts | 3 | 5 | open | Security | redaction schema + artifact scan |
| RR-023 | Submission repeats after ambiguous response | 2 | 5 | open | Release | external action journal + portal reconcile |
| RR-024 | Gate status becomes ceremonial checklist | 4 | 4 | open | Program | machine status + evidence expiry |
| RR-025 | Listener permissions reject authorized separate UID | 5 | 4 | open | Broker | live authorized success + denied peer test |
| RR-026 | Process escapes PGID using `setsid`/double fork | 4 | 5 | open | Runtime/SRE | cgroup-v2 empty-after-kill proof |
| RR-027 | PID/PGID reuse causes signal to unrelated process | 2 | 5 | mitigating | Runtime | pidfd/start/boot/session identity tests |
| RR-028 | Hosted UID test is mislabeled target-host proof | 4 | 5 | open | SRE/Security | tiered evidence schema + independent review |
| RR-029 | Stale status SHA misleads operators | 5 | 4 | mitigating | Program | one canonical status + CI validator |
| RR-030 | Trust-bundle key compromise cannot be stopped | 3 | 5 | blocked_external | Key owner | rotation/revocation/rollback drill |

## Automatic P0 incidents

Regardless of score, these are P0:

- credential disclosure;
- duplicate external side effect;
- stale-generation write;
- historical hash drift;
- signal sent to an unproven process identity;
- unrecoverable state corruption;
- evidence tier inflation;
- unauthorized principal gaining listener or journal access.

## Review rule

Each milestone review must update state, owner, evidence link and residual risk.
A risk cannot move to `accepted` without naming the authority allowed to accept
it and an expiry/review date.
