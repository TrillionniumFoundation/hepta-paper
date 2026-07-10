# Channel Import Allowlist

`src/channel-import-allowlist.mjs` is the stable facade for the local channel
runtime import policy. It protects the package export map from being bypassed by
relative filesystem imports from sibling channel repos.

Run:

```bash
npm run channel:imports
```

The exporter writes `reports/channel-import-allowlist-latest.json` and `reports/channel-import-allowlist-latest.md` and
scans runtime files for ZBJ, EPWK, and Hepta. It classifies every
`design-production-core` import as one of:

- package root import: `design-production-core`
- package metadata import: `design-production-core/package.json`
- package deep src import: `design-production-core/src/*.mjs`
- relative core src import: `../../design-production-core/src/*.mjs`

The current migration state expects channel runtimes to use the package root.
Sibling relative core-src imports are still classified so the report can show
the exact file/module, but they are now blockers. The gate fails on:

- package deep `design-production-core/src/*` imports
- sibling relative `../../design-production-core/src/*.mjs` imports
- relative imports to internal modules
- relative imports to compatibility modules
- stable modules that are not in that channel's allowlist
- a channel runtime with no core imports in its scanned roots

Changing a channel's core dependency should therefore be a small policy edit in
`CHANNEL_IMPORT_ALLOWLIST_TARGETS`, followed by:

```bash
npm run channel:imports
npm run package-root:resolver
npm run package-root:migration
npm run package-root:regression
npm run package-root:symbols
npm run package-root:symbol-regression
npm run gate:integration:strict
npm run checkpoint:architecture
```

The follow-on package-root migration report is intentionally separate. The
allowlist makes any sibling relative imports explicit and fails them; the
migration report then proves the real channel tree has zero remaining file
plans. The resolver report proves the package name is actually importable from
each channel runtime root, and `package-root:regression` proves a synthetic bad
relative import would be caught before it reaches a real channel file.
`package-root:symbols` adds the next policy layer by checking the named symbols
inside otherwise-valid package-root imports. `package-root:symbol-regression`
proves namespace/default/unlisted/missing-export package-root imports are still
rejected.

## Boundary

This is a local import scan only. It does not call providers, run browser
automation, upload, submit, send messages, pay, accept delivery, deploy, fetch
channel state, mutate lifecycle state, or grant execution permission.
