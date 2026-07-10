# Package Root Symbol Manifest

`src/package-root-symbol-manifest.mjs` is the local manifest for channel
package-root named imports. It keeps ZBJ, EPWK, and Hepta on
`from 'design-production-core'` while still preventing unrestricted access to
every root-exported symbol.

Run:

```bash
npm run package-root:symbols
```

The exporter writes `reports/package-root-symbol-manifest-latest.json` and `reports/package-root-symbol-manifest-latest.md`.
It scans runtime files for named imports from the package root and checks them
against `CHANNEL_PACKAGE_ROOT_SYMBOL_MANIFEST`. The report fails on:

- namespace imports such as `import * as Core from 'design-production-core'`
- default imports from `design-production-core`
- named imports not listed for that channel
- named imports that are not exported by the package root

The manifest is intentionally explicit. If a channel needs a new package-root
symbol, update the per-channel symbol list in the same patch as the channel code
change and rerun the full local architecture gate chain.

After the manifest passes, run the report-only minimization plan:

```bash
npm run package-root:symbol-minimize
```

That report lists allowed symbols that are not currently imported and proposes
an exact-current manifest for review. It does not edit channel files or shrink
`CHANNEL_PACKAGE_ROOT_SYMBOL_MANIFEST`.

Run the companion negative fixture after changing manifest parsing or channel
symbol policy:

```bash
npm run package-root:symbol-regression
```

That fixture does not edit real channel files. It proves namespace imports,
default imports, unlisted symbols, and missing package-root exports all become
symbol manifest blockers.

## Boundary

This is a local import scan only. It does not call providers, run browser
automation, upload, submit, send messages, pay, accept delivery, deploy, fetch
channel state, mutate lifecycle state, or grant execution permission.
