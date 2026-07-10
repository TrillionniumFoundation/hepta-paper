# Dispatch Readiness Operator Hints

`src/dispatch-readiness-operator-hints.mjs` owns the whitelist of operator hint
codes used by `AdapterDispatchReadinessReport`.

The catalog makes dashboard labels explicit instead of leaving ad hoc strings in
reports. Each hint records:

- stable `code`
- severity `level`
- `category`
- human title and notes
- allowed scope
- a hard `executesExternalAction=false` declaration

## Resolution

Use `resolveDispatchReadinessOperatorHints()` to verify that a report or compact
dashboard summary only uses cataloged hint codes. Unknown codes resolve to the
manual-review fallback and should fail selftests before they reach dashboards.

Use `summarizeDispatchReadinessOperatorHints()` for dashboard-level counts by
code, level, and category. `read-only-control-summary` includes this summary so
sample exports can report catalog resolution without running a channel adapter.

## Boundary

Operator hints are labels, not commands. They never execute adapters, upload,
submit, send messages, accept delivery, pay, deploy, fetch channel state, apply
lifecycle state, grant permission, or replace the external runner's current
approval/evidence/replay/duplicate/channel/current-chat checks.
