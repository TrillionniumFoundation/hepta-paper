# Package Root Symbol Regression

`src/package-root-symbol-regression.mjs` is the local negative fixture for the
package-root named import manifest. It does not scan or edit real channel files.
Instead it builds synthetic ZBJ, EPWK, and Hepta files with bad
`design-production-core` package-root imports, then proves the symbol manifest
rejects them.

Run:

```bash
npm run package-root:symbol-regression
```

The exporter writes `reports/package-root-symbol-regression-latest.json` and `reports/package-root-symbol-regression-latest.md`.
It passes only when all of these are true:

- a namespace import is rejected
- a default import is rejected
- a named symbol outside that channel's manifest is rejected
- a named symbol missing from the package root is rejected

This report is part of the local architecture gate chain so the package-root
rewrite keeps a positive proof that valid channel imports are explicit named
bindings from an approved per-channel symbol list.

## Boundary

This is a synthetic local regression fixture only. It does not edit channel
files, call providers, run browser automation, upload, submit, send messages,
pay, accept delivery, deploy, fetch channel state, mutate lifecycle state, or
grant execution permission.
