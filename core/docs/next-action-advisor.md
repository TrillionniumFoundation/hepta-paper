# Next-Action Advisor

`src/next-action-advisor.mjs` is the channel-neutral operator advice contract.
It converts a deterministic hard gate, blocker, and task context into a local
`commandBank`, a recommended repair path, and a validation result for any model
advisor response.

The module is intentionally control-plane only:

- it does not execute any command from the command bank
- it does not call providers or models
- it does not open a browser or fetch channel state
- it does not upload, submit, message, accept delivery, pay, deploy, or mutate
  local state
- it never lets model advice approve a submit command

Channel packages pass their own command templates. The core only owns the
gate-to-intent mapping, command id selection, prompt shape, JSON extraction, and
model-advice validation. That keeps route advice reusable while preserving
channel-specific CLI commands in the adapter package.

In the architecture workflow this node sits after `action_manifest` and before
`adapter_handoff`: it can explain the next repair or approval packet that should
be prepared, but it cannot grant execution permission. Any later runner still
must re-check approval, fresh evidence, replay guard, platform state, and the
channel adapter boundary.
