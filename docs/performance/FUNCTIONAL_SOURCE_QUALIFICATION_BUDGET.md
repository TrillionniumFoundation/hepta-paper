# Functional source qualification job budget

The exact-head and prospective-merge functional source jobs have a 90-minute
outer budget and explicitly pass the same budget to the locked parent Node
oracle wrapper. The wrapper uses one monotonic deadline across npm qualification,
installation and the verifier child; it does not renew time between stages.
Other wrapper callers retain the 30-minute default. Only 30 and 90 minutes are
accepted, and ambient environment variables cannot expand this budget.

This is bounded qualification headroom. It is not a measured full-run duration,
a completed qualification receipt, an optimization of behavior tests, or Rust
replacement/activation authority.

## Observed hosted costs

Six functional lanes at the following immutable source heads reached the
30-minute job boundary without a recorded command failure. Counts below are
completed commands, not the zero-based ordinal of the last command.

| Source head | Lane | Job | Completed commands | Completed-command time |
| --- | --- | --- | ---: | ---: |
| `36354e76` | Exact | [111699469045](https://github.com/TrillionniumFoundation/hepta-paper/actions/runs/37290487453/job/111699469045) | 394 | 1756.635 s |
| `36354e76` | Prospective | [111699468558](https://github.com/TrillionniumFoundation/hepta-paper/actions/runs/37290487453/job/111699468558) | 492 | 1759.265 s |
| `b482c060` | Exact | [111704129988](https://github.com/TrillionniumFoundation/hepta-paper/actions/runs/37291795469/job/111704129988) | 648 | 1765.943 s |
| `b482c060` | Prospective | [111704130229](https://github.com/TrillionniumFoundation/hepta-paper/actions/runs/37291795469/job/111704130229) | 398 | 1755.234 s |
| `88bfc6aa` | Exact | [111705028586](https://github.com/TrillionniumFoundation/hepta-paper/actions/runs/37292218689/job/111705028586) | 437 | 1749.046 s |
| `88bfc6aa` | Prospective | [111705028880](https://github.com/TrillionniumFoundation/hepta-paper/actions/runs/37292218689/job/111705028880) | 394 | 1731.193 s |

Each progress command hash was recomputed from the manifest's exact program,
arguments, workdir, expected targets, timeout and expected exit. All matched.
Across these runs, 648 distinct commands completed with status zero. Summing the
slowest observed duration for each of those commands gives 2564.956 seconds,
or 42.75 minutes. This is a cross-run cost envelope, not an actual run or a
statistical upper bound. Sixty of the 708 commands remain unobserved in these
logs. Setup, the unfinished command, final revalidation and upload are additional.
The workload is nonuniform, so linear extrapolation from command counts is not
a complete-run estimate. Cancellation does not identify the running command as
faulty.

The route-acceptance suite took 261.543–445.448 seconds; replay-guard took
85.071–144.222 seconds. Their existing 1200- and 600-second command limits remain
unchanged. No local profiling result is represented as a hosted speedup.

## Scope and dependent budgets

- All 708 baseline verification commands, their expected outcomes, source pins,
  exact test inventory, and individual monotonic deadlines are unchanged.
- The verifier still charges runtime qualification, Cargo discovery, inventory,
  execution and postchecks to each command. Final artifact/source revalidation
  remains charged to the last command.
- All dependency, npm/runtime, current-source, immutable-subject and acceptance
  checks remain enabled. The wrapper still records actual terminal status and
  cannot turn a timeout into qualification success.
- The source collector retains its 8100-second (135-minute) observation window,
  leaving 45 minutes above the functional producer's 90-minute budget.
- Collector jobs remain 155 minutes. Fresh-collector revalidation retains its
  9900-second observation window and 175-minute outer job limit.
- Current workflow bindings are refreshed for the two functional contexts.
  Historical evidence and receipts are unchanged.

The wrapper previously had a separate hardcoded 30-minute cutoff. Explicitly
aligning that aggregate installation/verifier budget is necessary; changing only
the Actions job limit would still interrupt qualification. Other bounded host,
network, Git and per-command operations are not aggregate job cutoffs and have
not been extended.

A complete source-bound hosted run must still establish all 708 commands and
final revalidation before qualification can be claimed.
