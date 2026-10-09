# Native worker hardening validation

The commands below were run without installing dependencies or changing system permissions. The five static failures are environment or repository baseline failures; they are identical on the parent and candidate trees.

| tree | commit | command | result |
| --- | --- | --- | --- |
| parent | `7176fdad2d5fd8ae42b6e0b89c78783f938d8bc2` | `npm run static:check` | 57 passed, 5 failed |
| previous worker patch | `ef2c9ca7c47d8dee3038d19bbe1f496c2c50ec76` | `npm run static:check` | 57 passed, 5 failed |
| current hardening | `da09f879ab8b99f900bce9b87327eaebe316164a` | `npm run static:check` | 57 passed, 5 failed |

Each run failed these same tests:

- `operator-facing capability counts are derived from the live catalog size` (`release-state-consistency.test.mjs:221`): capability command output was empty instead of matching `16/16`.
- `clean invocation uses private ephemeral HOME/cache and removes both after npm` (`strict-npm-audit-launcher.test.mjs:49`): `strict_npm_audit_temporary_parent_invalid`.
- `empty inherited pollution values are accepted and stripped from the child` (`strict-npm-audit-launcher.test.mjs:78`): `strict_npm_audit_temporary_parent_invalid`.
- `the exact host IPv4 preference is accepted but never inherited by npm` (`strict-npm-audit-launcher.test.mjs:102`): `strict_npm_audit_temporary_parent_invalid`.
- `production audit composition preserves injected launcher authority` (`strict-npm-audit-launcher.test.mjs:170`): `strict_npm_audit_temporary_parent_invalid`.

The focused native worker command was:

```text
node --test --test-concurrency=1 --test-name-pattern='hostile plans|bounded concurrency|rejection waits|invalid native plan|formal workers remain|failed safe batch' paper-core/tests/native-receipt-hash-policy.test.mjs
```

It passed all six focused tests. The full native receipt file passed eight tests and retained five existing `runtime_retention_package_deletion_fence_lock_backend_unavailable` environment failures.
