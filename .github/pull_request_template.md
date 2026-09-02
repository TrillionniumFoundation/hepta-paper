## Summary

Describe the canonical owner, behavior change, and evidence class established by this pull request.

## Validation

- [ ] Focused positive and negative tests
- [ ] `npm run static:check`
- [ ] `npm run security:npm-audit`
- [ ] Impacted test plan/suite
- [ ] Documentation integrity check
- [ ] Additional operational or release checks listed below

## Architecture and contracts

- [ ] The change is in the canonical owning layer.
- [ ] Dependency direction and execution-profile least authority are preserved.
- [ ] New or changed ports specify idempotency, ordering, cancellation, timeout, retry, fencing, durability, and errors.
- [ ] Adapter changes pass shared conformance and fault-injection cases.
- [ ] Compatibility/experimental code is not newly production-reachable.

## Documentation impact

- [ ] Root/module guides and documentation matrix are current.
- [ ] Architecture, contract, workflow, operations, and command docs are updated where affected.
- [ ] Local Markdown links pass the documentation integrity check.
- [ ] No behavior changed, with rationale: <!-- explain -->

## Data and migration impact

- [ ] No persisted-schema or legacy-matrix impact.
- [ ] A new append-only migration/backfill and upgrade/restore tests are included.
- [ ] Legacy disposition hashes/tests were refreshed by the canonical tool.
- [ ] Compatibility and retirement conditions are explicit.

## Security and authority impact

- [ ] Threat model and negative authority tests are current.
- [ ] Secrets, paths, processes, networks, images, keys, receipts, and remote actions remain bounded.
- [ ] Local evidence is not represented as independent external trust.
- [ ] Unknown remote outcomes use reconciliation rather than blind retry.

## Scientific impact

- [ ] No scientific claim, method, dataset, tolerance, proof, table, or figure impact.
- [ ] Claims are linked to assumptions, code/proof, data, runtime, protocol, tolerances, artifacts, and verification.
- [ ] Negative/null/failed outcomes remain traceable.
- [ ] Independent oracle/replay requirements are satisfied or remain explicitly blocked.

## Remaining blockers

List real external prerequisites or unresolved risks. Do not create nominal evidence to make this section empty.
