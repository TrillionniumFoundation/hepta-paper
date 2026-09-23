# Module responsibility topology

## 1. Current development model

This is a single-maintainer repository, not a 36–54-person organization. The
maintainer can implement, validate and integrate all modules under the
[ownership policy](OWNERSHIP_AND_REVIEW.md). Missing secondary staff or GitHub
teams is not a development or module-completion blocker.

## 2. Logical responsibility IDs

| Team ID | Home responsibilities |
|---|---|
| TEAM-KERNEL | canonical protocol, global invariants, policy, composition boundaries |
| TEAM-SCHEDULER | candidates, planner, optimizer, explanation, calibration |
| TEAM-STATE | campaign state, writer, commit sequencer, backup/restore |
| TEAM-RUNTIME | broker, process, listener, cgroup, credential-safe execution |
| TEAM-WORKSPACE | COW workspaces, CAS, artifacts, mutation verification |
| TEAM-PROTOCOL | schemas, generated bindings, compatibility and golden vectors |
| TEAM-AUTHOR | research planning, author/draft/revision modules |
| TEAM-REVIEW | independent referee and revision-feedback modules |
| TEAM-FORMAL | theorem/Lean/formal evidence modules |
| TEAM-EMPIRICAL | datasets, experiment orchestration and empirical verification |
| TEAM-NUMERICAL | CPU/GPU numerical and scientific runtime modules |
| TEAM-BUILD | LaTeX, package, reproducibility and artifact production |
| TEAM-EVIDENCE | evidence graphs, qualification ingestion and independent verification |
| TEAM-RELEASE | release, immutable-storage and submission ports/runbooks |
| TEAM-SRE | deployment, observability, capacity, performance and incident response |

These are stable responsibility IDs, not claims that corresponding GitHub teams
already exist.

## 3. Optional future staffing

The IDs identify expertise and component responsibility, not exclusive people.
One person may cover all of them. Recovery knowledge belongs in actionable
runbooks and tested state transitions rather than mandatory reviewer rosters.
If contributors are added, responsibilities may be delegated without changing
runtime ownership, credential isolation, or the single-writer contract.

No automatic CODEOWNER team provisioning or minimum reviewer count is required.
Any future mandatory multi-person review is an explicit owner policy decision,
not a prerequisite inherited from an aspirational team chart.
