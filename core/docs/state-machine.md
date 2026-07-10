# State Machine

`src/state-machine.mjs` is the local lifecycle guard for core contracts. It
does not run production, upload files, submit work, send messages, or deploy.
It only validates stage transitions and emits audit events.

## Stages

The module uses `CORE_STAGES` from `contracts.mjs`:

- `channel_discovered`
- `brief_normalized`
- `plan_ready`
- `generation_ready`
- `package_ready`
- `review_ready`
- `prepare_ready`
- `submit_ready`
- `submitted_verified`
- `delivery_ready`
- `blocked`

Normal forward progress is deliberately narrow. A task cannot jump from
`plan_ready` to `submitted_verified`, and a `blocked_plan_only` draft cannot
advance into generation.

## External Actions

External actions require an allowed `ExecutionGateDecision` before the state
machine will advance:

- `provider_spend`
- `model_spend`
- `live_prepare`
- `live_submit`
- `acceptance_apply`
- `customer_message`
- `deployment`

For example, `live_submit` may only move from `prepare_ready` or `submit_ready`
to `submitted_verified`, and only when the gate decision is `allow` for
`live_submit`. External-action transitions also require the gate snapshot to
carry the same `taskKey` plus concrete approval and evidence hashes; a stripped
or generic allowed gate cannot advance state.

Human-feedback message aliases such as `consumer-feedback-message` and
`buyer-feedback-message` are canonicalized before the transition action is
matched against the gate decision. The returned transition decision exposes the
canonical `customer_message` action even when a direct prebuilt gate decision
used an alias.

## Audit Events

`applyStateTransition()` returns a `StateTransitionResult` with a
`StateAuditEvent`. The event records:

- task key
- from/to stage
- external action intent
- blocker and warning codes
- approval/evidence hashes when a gate was involved

The event is audit-only and has `executesExternalAction: false`.
Audit summaries bucket events by the same canonical action ID. Direct audit
events that still carry `consumer-feedback-message` or
`buyer-feedback-message` are counted as `customer_message`, not as separate
summary actions.

## Regression Coverage

`fixtures/state-machine-fixtures.json` covers local progress, blocked
plan-only drafts, illegal jumps, external actions without gates, and external
actions with allowed gates.
