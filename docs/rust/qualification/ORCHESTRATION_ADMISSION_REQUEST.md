# Orchestration source-admission request

This request binds the new deterministic Rust orchestration kernel to the canonical direct-to-main release-candidate review surface.

Admission requires, on one unchanged exact head:

- the `hepta-orchestration-kernel` workspace member and `hepta-control-plane` facade compile under pinned Rust 1.98;
- full-workspace tests pass with all features and the committed dependency lock;
- full-workspace Clippy passes for all targets and features with warnings denied;
- rustdoc passes with warnings denied;
- planning snapshots reject mixed revisions or barriers;
- candidate routing is collection-order independent and overflow checked;
- resource prepare/commit/finalize and recovery preserve parent limits and committed ambiguity;
- telemetry exposes no free-form identity or credential-bearing fields;
- performance qualification rejects incomplete or regressed canonical workload sets;
- documentation and machine program truth validators pass;
- production authority remains false unless the independently controlled external qualification closure is accepted.

This file is a review request and normal-subject CI trigger. It is not an acceptance receipt and does not change static or effective status by itself.
