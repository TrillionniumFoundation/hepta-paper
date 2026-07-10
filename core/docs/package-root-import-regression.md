# Package Root Import Regression

`src/package-root-import-regression.mjs` is the local negative fixture for the
completed package-root import rewrite. It does not scan or edit real channel
files. Instead it builds synthetic ZBJ, EPWK, and Hepta files that import
`design-production-core/src/*.mjs` through sibling relative paths, then proves
the channel import allowlist and package-root migration report both reject them.
It also scans Markdown import examples so docs cannot reintroduce core-src
imports as recommended usage after the package-root rewrite.

Run:

```bash
npm run package-root:regression
```

The exporter writes `reports/package-root-import-regression-latest.json` and `reports/package-root-import-regression-latest.md`.
It passes only when all of these are true:

- the synthetic fixture contains three bad sibling relative core-src imports
- `channel:imports` would mark those imports as relative core-src blockers
- `package-root:migration` would fail through the allowlist binding
- the migration report records those imports as non-migratable blockers
- Markdown import examples contain zero `./src/*`,
  `design-production-core/src/*`, or sibling `design-production-core/src/*`
  specifiers

This report is part of the local architecture gate chain so the project keeps a
positive proof that the post-migration invariant is enforced: channel runtime
code should import the stable package root, not sibling core source files.

## Boundary

This is a synthetic local regression fixture plus a read-only docs scan. It does
not edit docs or channel files, call providers, run browser automation, upload,
submit, send messages, pay, accept delivery, deploy, fetch channel state, mutate
lifecycle state, or grant execution permission.
