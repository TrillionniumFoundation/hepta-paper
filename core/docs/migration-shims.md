# Migration Shims

`src/migration-shims.mjs` is the compatibility layer for current product
surfaces.

It gives each business/channel line a small, explicit adapter into
`PlanOnlyDraft`:

- `buildZbjPlanOnlyMigration({ job, planSource, caseIndex })`
- `buildEpwkPlanOnlyMigration({ record, liveRules })`
- `buildHeptaPlanOnlyMigration({ order })`

These shims are intentionally thin. They translate existing local payloads into
the shared planning contract but do not modify the owning workflow.

## Boundary

Allowed:

- normalize channel task metadata
- call `routeProductLine`
- attach `workflowProfile`
- create `CreativeBrief`
- create `ProductionPlanEnvelope`
- return plan-only warnings and blockers
- keep source snapshots redacted by default

Not allowed:

- call providers or models
- fetch live pages
- upload files
- submit manuscripts
- apply for acceptance
- send buyer/customer messages
- change shop/profile/account/payment state
- mutate ZBJ/EPWK/Hepta execution state

## Migration Order

1. Keep ZBJ production and submit logic in `zbj-auto-intake`.
2. Keep EPWK radar/detail/prepare probes in `epwk-auto-intake`.
3. Keep Hepta buyer/order/delivery UX in the Hepta app.
4. Add one call to the relevant shim at each planning entry.
5. Surface `draft.status`, `draft.blockers`, and `draft.workflowProfile` in dashboards.
6. Only later, after parity evidence is stable, move product workflow execution behind the same contract.

## Expected Use

ZBJ:

```js
const migration = buildZbjPlanOnlyMigration({ job, planSource, caseIndex });
if (migration.draft.blockers.length) {
  // Hold before provider/model/import/live actions.
}
```

EPWK:

```js
const migration = buildEpwkPlanOnlyMigration({ record, liveRules });
```

Hepta:

```js
const migration = buildHeptaPlanOnlyMigration({ order });
```

The returned `PlanOnlyDraft` is a plan contract, not execution permission.

## Regression

Shim fixtures live in `fixtures/migration-shim-fixtures.json` and run through:

```bash
npm run selftest
```

The read-only sample exporter now uses these shims so sample output matches the
future migration path without touching any platform.
Migration summaries bucket draft `productLineId` after product-line
canonicalization, so legacy human-feedback aliases do not create separate
public product rows.
