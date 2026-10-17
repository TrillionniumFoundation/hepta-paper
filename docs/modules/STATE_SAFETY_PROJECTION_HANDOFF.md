# State safety diagnostic projection

## Scope and input contract

This module ports the report logic from `paper-domain/automation/autonomous-research-state-safety-contract.mjs`. `evaluate_state_safety_readiness_v1` receives inventory, restore-source and online inspection JSON plus an explicit millisecond clock. It returns a deterministic diagnostic report. These JSON inputs are claims: this function neither opens files nor verifies an Ed25519 signature. Its `ready` field must never be used to construct an activation or action capability.

Public helpers compute the legacy writer-coverage manifest hash, inspect writer coverage and produce the unavailable-online inspection. Blocker alias expansion is shared with the real authority-inspection module. Canonical and legacy coordinator blocker codes remain present together, deduplicated and sorted by JavaScript UTF-16 ordering.

## Report behavior

Inventory inspection recomputes scope/inventory hashes, validates the exact canonical inventory shape and all ten role coverage, and retains sorted instance/schema bindings. Restore inspection distinguishes legacy snapshot, timestamped snapshot and finalized-journal metadata; binds role/instance/scope/manifest identity; applies the inclusive 24-hour drill-age boundary; and checks journal recovery bindings when an inventory hash changes.

Online report inspection checks the normalized current/challenge head, exclusive expiry, common authority head, manifest coverage, static AST claim, broker scope claim and coordinator diagnostic status. The output preserves all counts, role lists, normalized subreports, read-only/external-action flags, compatibility aliases and accumulated blockers. Hashes use the incumbent record domains. Output numbers use JavaScript-compatible serialization, so a JSON numeric spelling such as `1.0` cannot produce a different report number from `1`.

The weaker legacy writer-coverage manifest checker is deliberately separate from the complete operation-manifest checker: an unavailable report with zero writers remains representable. A report can consequently describe incomplete deployment without claiming that a real native writer set is active.

## Temporal compatibility boundary

Native time fields currently accept canonical UTC strings. Original `Date.parse(String(value || ''))` accepts additional coercions and implementation-specific formats. A dedicated differential case proves that original numeric `restoreDrillPerformedAt:1` becomes an old date while native output leaves it invalid/null and blocks readiness. This is a **remaining exact-compatibility difference**, not a passing full-input parity claim. Numeric/coerced dates and additional date formats need an explicit compatibility decision or a native temporal compatibility implementation before complete original-input acceptance.

## Validation and integration

There are 394 complete report comparisons covering the canonical ready report, absent inputs, scalar-field corruption, hash/identity drift, exact freshness/expiry boundaries, explicit blockers and legacy blocker aliases. An additional case records the numeric-date difference. The online portion of the baseline uses the actual signature verifier; the restore metadata baseline is explicitly a projection fixture and does not manufacture `VerifiedStoredRestoreSourceV1`.

Production composition must obtain actual opaque inventory/source/authority proofs independently, validate the real coordinator and preserve currentness until action fencing. The passive state-safety composition, complete activation, CLI integration and independent command acceptance remain separate work. Pure report parity does not establish deployment readiness or Node retirement.
