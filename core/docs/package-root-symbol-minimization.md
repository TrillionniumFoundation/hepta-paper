# Package Root Symbol Minimization

`src/package-root-symbol-minimization.mjs` is the report-only companion to the
package-root symbol manifest. It reuses the real symbol manifest scan, compares
each channel's allowed named imports with the symbols currently imported from
`design-production-core`, and writes an exact-current proposal without editing
channel files or the manifest.

Run:

```bash
npm run package-root:symbol-minimize
```

The exporter writes
`reports/package-root-symbol-minimization-latest.json` and `reports/package-root-symbol-minimization-latest.md`. The report shows:

- current allowed symbols per channel
- current imported symbols per channel
- allowed symbols that are not currently used
- an exact-current `proposedAllowedSymbols` list per channel
- shrinkable symbol counts and a `minimizationReady` flag

Unused allowances are not blockers by themselves. They are review data for a
future manifest shrink. The report fails only when the source symbol manifest is
not ok, because a blocked manifest cannot be used as a safe exact-current base.

## Boundary

This is a local report-only plan. It does not edit channel files, shrink the
symbol manifest, call providers, run browser automation, upload, submit, send
messages, pay, accept delivery, deploy, fetch channel state, mutate lifecycle
state, or grant execution permission.
