# Team topology for modular development

## 1. Goal

Scale to dozens of contributors while keeping ownership aligned with stable
module boundaries and preventing central architecture, qualification, or state
review from becoming a queue for every local implementation change.

## 2. Planned teams

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

## 3. Staffing rule

Each production module requires:

- at least two maintainers able to review and operate it;
- one primary team;
- one secondary team with recovery knowledge;
- an independent reviewer team for authority/protocol/state/quality changes;
- an escalation/on-call owner before production activation.

One engineer may have one primary home module and contribute elsewhere, but no
authority-bearing module may depend on a single person's availability.

## 4. Suggested organization size

A 36–54 person configuration:

```text
Kernel/Scheduler/State                 8–12
Runtime/Workspace/Protocol             8–12
Author/Review/Formal/Empirical/
Numerical/Build module groups         16–24
Evidence/Release/SRE/Performance       4–6
```

Actual staffing follows workload and risk rather than this example.

## 5. Interaction modes

- **X-as-a-service:** platform teams expose stable self-service contracts and
  conformance kits.
- **Collaboration:** temporary for new protocol/authority/state boundaries.
- **Facilitating:** platform team helps a module adopt a stable contract, then
  exits the day-to-day path.

Permanent broad collaboration across all teams is a sign that module contracts
are not sufficiently stable.

## 6. Current blocker

The repository currently routes high-risk paths to one explicit reviewer.
Before G7, real GitHub teams and CODEOWNER entries must be provisioned and tested
without weakening no-bypass governance. Until then, the static ownership registry
is a design mapping only.
