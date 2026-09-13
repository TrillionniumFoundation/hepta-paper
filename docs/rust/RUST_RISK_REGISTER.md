# Rust rewrite risk register

Likelihood and impact are scored 1–5. Score 20 or higher blocks the next
dependent milestone unless the responsible external authority accepts a
bounded residual risk with an expiry. “Mitigated” requires negative evidence,
not prose.

| ID | Risk | L | I | State | Owner | Required evidence |
|---|---|---:|---:|---|---|---|
| RR-001 | Node baseline becomes a mutable permanent oracle | 3 | 5 | open | Compatibility | frozen commit/lock/image and offline corpus |
| RR-002 | Canonical hash drift invalidates history | 4 | 5 | open | Compatibility | dual verifier and adversarial corpus |
| RR-003 | Node and Rust write concurrently | 2 | 5 | mitigating | Database | signed cutover, ownership lease and production drill |
| RR-004 | Codex credential leaks into child command/process | 3 | 5 | mitigating | Security | environment, `/proc`, FD and path attack suite |
| RR-005 | Reviewer independence is only nominal | 4 | 4 | open | Evidence | separate UID/home/socket/account receipts |
| RR-006 | Post-release crash duplicates a paid provider call | 4 | 5 | mitigating | Broker | durable gate/journal and ambiguity tests |
| RR-007 | Protocol drift becomes false success | 3 | 5 | mitigating | Broker | unknown terminal-like fuzz corpus |
| RR-008 | Agent self-report bypasses mutation policy | 3 | 5 | mitigating | Workspace | descriptor-bound before/after inventory |
| RR-009 | Existing defect is copied as parity | 4 | 4 | open | Architecture | disposition ledger and V2 ADR |
| RR-010 | Generic provider framework delays usable system | 4 | 3 | controlled | Product | Codex-only production composition |
| RR-011 | Experimental App Server expands TCB | 3 | 4 | controlled | Broker | exec JSONL V1-only architecture check |
| RR-012 | Hidden session state causes campaign drift | 3 | 4 | controlled | Broker | fresh ephemeral session contract |
| RR-013 | Shared implementation defeats independent verification | 4 | 5 | open | Evidence | implementation-diversity matrix |
| RR-014 | Filesystem recovery is inferred from unit tests | 4 | 5 | mitigating | Workspace | descriptor race tests plus target kill/restore matrix |
| RR-015 | SQLite migration corrupts live state | 2 | 5 | open | Database | production-shaped copies and restore canary |
| RR-016 | CI is green but `main` is bypassable or checks the wrong ref | 4 | 5 | blocked_external | Governance | issue #25 policy export, denial probes and independent decision |
| RR-017 | Toolchain/dependency upgrade changes behavior | 3 | 4 | mitigating | SRE | lock, SBOM, audit and reproducible build |
| RR-018 | Model quality regresses while deterministic gates pass | 4 | 4 | blocked_external | Product/Evidence | live evaluation thresholds |
| RR-019 | Missing usage is treated as zero cost | 3 | 4 | mitigating | Campaign | conservative settlement and reconciliation |
| RR-020 | OpenClaw enters Rust indirectly | 3 | 3 | mitigating | Architecture | source/dependency/runtime graph ban |
| RR-021 | Oversized integration PR cannot be reviewed or rolled back | 3 | 4 | mitigating | Program | one RC, bounded follow-up PRs and exact-tree review |
| RR-022 | Logs/artifacts capture prompts or manuscripts | 3 | 5 | open | Security | redaction schema and artifact scan |
| RR-023 | Submission repeats after ambiguous response | 2 | 5 | blocked_external | Release | external action journal and portal reconcile |
| RR-024 | Gate status becomes ceremonial checklist | 4 | 4 | mitigating | Program | static/effective machine truth and expiry |
| RR-025 | Listener permissions reject authorized separate UID | 5 | 4 | open | Broker | target-host authorized success and denied peer test |
| RR-026 | Process escapes PGID using `setsid` or double fork | 4 | 5 | open | Runtime/SRE | target cgroup-v2 empty-after-kill proof |
| RR-027 | PID/PGID reuse causes signal to unrelated process | 2 | 5 | mitigating | Runtime | pidfd/start/boot/session identity tests |
| RR-028 | Hosted UID test is mislabeled target-host proof | 4 | 5 | mitigating | SRE/Security | tiered evidence schema and independent review |
| RR-029 | Stale status SHA misleads operators | 5 | 4 | mitigated | Program | no commit literal in static candidate and exact-head artifact |
| RR-030 | Trust-bundle key compromise cannot be stopped | 3 | 5 | blocked_external | Key owner | rotation, revocation and compromise drill |
| RR-031 | An external gap has no executable package or schema | 1 | 5 | mitigated | Program/Evidence | machine-checked external package map |
| RR-032 | Source self-asserts qualification before checks execute | 5 | 5 | mitigating | Program | Plan v4 static/effective split |
| RR-033 | `action_required`, zero-job or skipped run is counted as green | 5 | 5 | mitigating | CI | required-context collector and fail-closed derivation |
| RR-034 | Status/backlog and parity matrices contradict each other | 5 | 4 | mitigating | Program | stable parity IDs and semantic validator |
| RR-035 | Duplicate P0 PRs create competing authority candidates | 4 | 4 | mitigating | Program | single RC branch and supersession closure |
| RR-036 | Public minimal fixture is mistaken for 263-file replay | 4 | 5 | blocked_external | Compatibility | issue #28 hosted private replay receipt/index |
| RR-037 | Signed cutover permit is reused outside its exact subject | 2 | 5 | mitigating | Database/Security | subject, preimage, expiry and first-lease binding; production replay drill |
| RR-038 | Required path-filtered workflow never reports a protected context | 4 | 4 | open | CI/Governance | always-reporting required contexts or verified relevance router |
| RR-039 | Effective source artifact is treated as production activation | 3 | 5 | mitigating | Program/Security | artifact authority fields fixed false and separate external gates |
| RR-040 | A PR-controlled workflow impersonates a required context under the shared Actions App | 5 | 5 | mitigating | CI/Security | exact workflow ID/path/blob/digest plus PR/run/job/step binding and collision tests |
| RR-041 | Base/merge movement or an older-run rerun leaves a successful effective artifact apparently current | 5 | 5 | open | CI/Program | exact base/head/merge subject, complete eligible-run-set hash, V3 live revalidation and adversarial tests |
| RR-042 | Global CI success blanket-promotes an untested capability | 4 | 5 | mitigating | Program/Capability owners | complete non-empty capability-to-context mapping and dependency closure |
| RR-043 | Selected constant checks accept a malformed effective evidence object | 4 | 5 | mitigating | Evidence/CI | complete committed JSON Schema validation plus unsupported-keyword rejection |

## Automatic P0 incidents

Regardless of score, the following are P0:

- credential disclosure;
- duplicate external side effect;
- stale-generation write;
- historical hash drift;
- signal sent to an unproven process identity;
- unrecoverable state corruption;
- evidence tier inflation;
- unauthorized principal gaining listener or journal access;
- a production-relevant `main` update bypassing current-head checks or
  independent review;
- a zero-job or skipped-required-job run being accepted as qualification;
- a same-App workflow or colliding producer impersonating a required context;
- a stale artifact remaining valid after a newer producer run or attempt;
- a capability being promoted without capability-specific evidence;
- a source document granting itself effective or production authority;
- a second active release-candidate or writer authority;
- confidential legacy replay being claimed from the public minimal fixture.

## Review rule

Every milestone review updates state, owner, evidence link, expiry and residual
risk. A risk cannot become `accepted` without naming the authority allowed to
accept it and a review deadline.

`blocked_external` means repository-local contracts are available but the
separately controlled fact is absent. It is never equivalent to `mitigated`,
`accepted` or `qualified`.

Discovery of a new P0 automatically invalidates the affected effective
qualification and returns it to committed `source_implemented` state until a
fresh exact-head matrix and review are retained.
