# Package Root Import Migration

`src/package-root-import-migration.mjs` is the stable facade for the local
package-root import migration report. It originally grouped channel imports from
sibling relative paths to the package root; after the rewrite it proves there
are no remaining migratable sibling relative imports or file plans.

Run:

```bash
npm run package-root:migration
```

The exporter writes `reports/package-root-import-migration-latest.json` and `reports/package-root-import-migration-latest.md`.
It reads the current channel import allowlist scan and the latest package
surface and package-root resolver reports. When migration is complete the report
stays green with `migratableRelativeImportCount=0` and `filePlanCount=0`.
Because the allowlist now blocks sibling relative core-src imports directly, any
new relative import first makes this report fail through the allowlist binding.
That binding is identity-strict: the migration report requires the upstream
allowlist to preserve `allowlistHash` beside the generic `hash`, and it does not
use generic `hash` as a substitute for a stripped allowlist alias.

The plan only covers imports that are already safe:

- `specifierKind=relative_core_src`
- `moduleStability=stable`
- `allowedByModule=true`
- no import-level allowlist blockers

Historical file plans proposed replacing the import source with:

```js
from 'design-production-core'
```

The report does not rewrite ZBJ, EPWK, or Hepta files. Real migration patches
must merge named imports carefully, check local binding collisions, rerun
channel import allowlist, package surface, selftest lanes, strict audit, strict
gate, and architecture checkpoint. Once the rewrite is complete, this report is
paired with `npm run package-root:regression`, the synthetic negative fixture
that proves new sibling `src/*.mjs` imports cannot silently return.

The separate `npm run package-root:resolver` report proves
`import('design-production-core')` from each channel's runtime root. A failed
resolver report does not make this migration plan invalid, but it sets
`rewriteReady=false` and emits rewrite blockers. Do not rewrite sibling relative
imports to the package root until every target channel can resolve the package
name from its own runtime directory.

The report blocks when:

- channel import allowlist is not ok
- channel import allowlist is missing `allowlistHash`, missing generic `hash`,
  or has mismatched semantic/generic hash bindings
- package surface report is missing or not ok
- package root import smoke is not ok
- deep `src/` package imports are not blocked
- any channel import is package deep, sibling relative core-src, internal,
  compatibility, or otherwise not migratable

## Boundary

This is a local report-only migration audit. It does not edit channel files,
call providers, run browser automation, upload, submit, send messages, pay,
accept delivery, deploy, fetch channel state, mutate lifecycle state, or grant
execution permission.
