# Policy Profiles

`src/policy-profiles.mjs` is the shared local policy matrix for operator
actions such as provider spend, semantic reviewer spend, local import, live-page
read, prepare upload, real submit, and external notification.

The module is intentionally control-plane only:

- it does not execute provider, model, browser, upload, submit, message,
  acceptance, payment, deployment, or notification actions
- it does not read channel state or mutate local workflow state
- it only maps requested action flags to blocked policy violations
- it exposes `localPolicyOnly: true`, `callsProviderOrModel: false`, and
  `grantsExecutionPermission: false`

The canonical profiles are:

- `safe-plan`: blocks every executable action
- `spend-allowed`: allows provider/semantic spend and local import only
- `prepare-allowed`: additionally allows live reads and prepare uploads
- `submit-allowed`: additionally allows real submit and external notification

Channels still own approval packets, fresh evidence, task locks, platform
state, duplicate checks, paid gates, and the actual runners. A profile match is
only one local precondition; it never replaces current user authorization or
runner-side gates.
