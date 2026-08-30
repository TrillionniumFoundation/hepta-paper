# Source qualification policy

A source-qualified status requires the same pull-request head commit and tree to pass formatting, locked compilation, all-target Clippy with warnings denied, all-feature tests, rustdoc with warnings denied, program-truth validation, differential compatibility checks, and every impacted installed-boundary workflow. Historical or merge-ref-only success is not sufficient.
