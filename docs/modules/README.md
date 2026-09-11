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

## Structural coverage and implementation scope

The validator executes the committed registry, work-item, index and manifest
schemas against captured JSON bytes. It rejects duplicate keys, numeric values
masquerading as booleans, non-finite numbers, unknown properties, missing safety
limits, owner-role order changes, side effects beyond the authority ceiling,
and static activation inconsistent with the module registry. Required headings
must occur exactly once outside code fences and contain a body. Canonical input
paths cannot traverse symbolic links; individual documents are limited to 1 MiB.

For a deterministic, non-authorizing implementation-scope projection, run:

```bash
node docs/tools/validate-module-documentation.mjs --json
```

The report separates `codeRoots` from `contractRefs`, records every referenced
work item's current state, and explicitly retains pending source and external
work for all registered modules. The inputs are bound by byte digests. A code
root is a location, not proof that every declared operation is implemented; a
source-implemented module may still have design-ready work. A successful report
means structural documentation coverage, not semantic engineering acceptance,
source qualification, target-host qualification, or production activation.

Python 3 is required by both development-document validators. A missing,
malformed, timed-out or unsupported schema validator is a failure, never a skip.
The gate executes its own checked-in verifier, not a script supplied by a
candidate `--root`. This static source gate does not replace runtime filesystem
or external-authority verification.


## Schema-definition failure boundary

Schema definition validity is checked before instance branch selection. Unknown
assertions, malformed keyword values, invalid local references and unsupported
formats remain errors even in unused definitions, absent properties, and inactive
`anyOf`/`not`/`if` branches. A schema error is not an ordinary instance mismatch
and cannot be inverted into acceptance. The verifier limits schema traversal and
instance evaluation; exhausted budgets and recursive-reference failures deny.

The supported subset also accepts boolean schemas and treats an integral JSON
number such as `1.0` as an integer, never as a boolean. All direct Python API
instances must be finite JSON values, including values accepted by empty schemas.
Qualification `date-time` assertions require full calendar-valid timestamps with
seconds and an explicit UTC offset; leap-second values are not supported. This
is a bounded repository contract validator, not a claim of full Draft 2020-12
vocabulary support. Run the adversarial suite with:

```bash
python3 docs/rust/tools/test-plan-v4-qualification.py
python3 docs/rust/tools/test_strict_json_schema_contract.py
```
