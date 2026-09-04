# Module specifications

This directory is the canonical development entry point for registered modules.

- [`MODULE_MODEL.md`](MODULE_MODEL.md) defines what a module is.
- [`MODULE_PROTOCOL.md`](MODULE_PROTOCOL.md) defines planning, execution, prepared-result, cancellation, verification, and commit semantics.
- [`MODULE_REGISTRY.md`](MODULE_REGISTRY.md) defines static and deployment registry authority.
- [`MODULE_LIFECYCLE.md`](MODULE_LIFECYCLE.md) defines registration through retirement.
- [`MODULE_CONFORMANCE.md`](MODULE_CONFORMANCE.md) defines source, host, security, compatibility, and performance suites.
- [`MODULE_TEMPLATE.md`](MODULE_TEMPLATE.md) is the mandatory specification structure.
- [`MODULE_DOCUMENTATION_MATRIX.md`](MODULE_DOCUMENTATION_MATRIX.md) links every registered module to its specification and manifest.
- [`module-documentation.v1.json`](module-documentation.v1.json) is the machine-readable one-to-one coverage index.
- `specs/` contains one normative specification per registered module.
- `manifests/` contains one documentation/engineering manifest per registered module.
- `schemas/` contains the common protocol and documentation schemas.

A complete module document does not imply effective qualification or production activation. Those remain exact-subject deployment and external-authority decisions.

Validate from the repository root:

```bash
node docs/tools/validate-module-documentation.mjs
node --test --test-concurrency=1 paper-core/tests/module-documentation-integrity.test.mjs
```

The validator rejects registry/spec/manifest drift, missing sections, placeholders, missing implementation roots, duplicate or orphan files, inconsistent authority/ownership/capability/work mappings, and missing authority-specific safety contracts.
