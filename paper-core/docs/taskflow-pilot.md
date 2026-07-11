# OpenClaw TaskFlow pilot

The optional TaskFlow integration coordinates long-lived external waits for one
reviewed-submission attempt. It is not a paper-domain workflow engine and does
not grant academic, owner, referee, operator, executor, or provider authority.

The pilot is disabled unless `HEPTA_TASKFLOW_PILOT=1`. Its first and only
allowlisted paper is `A_Theory_of__Expectations`. An OpenClaw binding layer must
obtain the canonical runtime from `api.runtime.tasks.flow`, bind it to trusted
tool/session context, and pass the bound port to
`startReviewedSubmitTaskFlow` or `advanceReviewedSubmitTaskFlow`.

TaskFlow state contains only the paper id, release commit, package hash, current
domain snapshot hash, verified receipt hashes, and blocker codes. Private keys,
credentials, evidence bodies, manuscripts, provider tokens, and authorization
documents are forbidden. Every resume must rebuild a
`ReviewedSubmitDomainSnapshot` from hepta SQLite and verified receipts. TaskFlow
state must never be used to unlock the native submission release lock.

Cancellation stops future coordination only. It does not roll back or mutate
paper-domain state. Provider work may be linked only after the hepta-native
dispatch authorization reports `submission_dispatch_authorization_ready`; the
external executor still owns provider credentials and must return a receipt
for native reconciliation. The final native release lock may unlock only after
that receipt and reconciliation verify.
