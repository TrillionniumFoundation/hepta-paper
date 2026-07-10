# Package Root Resolver

`src/package-root-resolver.mjs` is the stable facade for proving that sibling
channel runtimes can resolve the `design-production-core` package root by name.
It is the precondition for rewriting channel imports away from sibling
`../../design-production-core/src/*.mjs` paths.

Run:

```bash
npm run package-root:resolver
```

The exporter writes `reports/package-root-resolver-latest.json` and `reports/package-root-resolver-latest.md`. It checks
the local workspace link:

```text
node_modules/design-production-core -> ../design-production-core
```

Then it probes each channel runtime root and verifies:

- `import('design-production-core')` succeeds
- the root import exposes the expected public module count
- the root import exposes zero compatibility modules
- `zeroCompatibilityInvariant=true`
- `import('design-production-core/src/index.mjs')` is blocked with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`

The resolver report must pass before an actual package-root import rewrite is
safe. The package-root migration plan consumes this report and only marks
`rewriteReady=true` when every channel resolver probe is ready.

## Boundary

This is a local Node resolver smoke test. It does not edit channel files, call
providers, run browser automation, upload, submit, send messages, pay, accept
delivery, deploy, fetch channel state, mutate lifecycle state, or grant
execution permission.
