# Full supervisor health composition

Read-only native composition of actual incumbent source observations. It does not execute resident work, grant authority or establish independent acceptance.

## Actual chain and API

New additive API:

```rust
pub struct FullSupervisorHealthOptionsV1<'a> {
    pub runtime_root: &'a Path,
    pub repository_root: &'a Path,
    pub working_directory: &'a Path,
    pub environment: &'a BTreeMap<String, String>,
    pub external_qualification_config: Option<&'a Path>,
    pub now_millis: i64,
    pub strict_mode: bool,
}
pub fn inspect_supervisor_health_fully_autonomous_v1(
    options: &FullSupervisorHealthOptionsV1<'_>,
) -> Result<serde_json::Value, String>;
```

The actual-source sequence follows
`paper-core/bin/autonomous-research-supervisor-health.mjs:40–136`:

1. Base supervisor status from its private SQLite snapshot.
2. One actual current intake observation.
3. Actual resident prerequisites with selected external qualification config,
   actual source repository, captured environment and the same observation time.
4. Actual `state_recoverability::safety_inspection::inspect_autonomous_research_state_safety_v1`
   with explicit workspace/runtime/cwd/environment/time options.
5. Optional strict reconciliation using the **same** completed intake value.
6. Private report projection over those completed observations.

There is no public evaluator that accepts caller ready reports. Full readiness is
derived from current intake readiness, base fully-autonomous prerequisite status,
resident ready plus exact stored prerequisite identity, and state-safety ready.
No mode hardcodes a ready result. Current native V3/recovery contract refusal
continues to block actual full readiness; this patch does not relabel trust.

The intake and strict public APIs retain their existing signatures and use the
same private intake observation/projection helpers. Their extra resident/safety
fields remain null/false/empty as before. Base/startup/machine modes do not begin
reading the new producers. In full+strict mode the strict report is still included,
even though full mode determines the process exit result.

All producers return plain completed data. Each source/private-SQLite owner drops
before the next producer runs: status → intake → resident → state safety → strict.
No owner from the new composition is retained alongside the next stage's SQLite.
The inherited producers still require invocation before caller-owned business
SQLite/database descriptors, because observing arbitrary resource aliases can
close process-scoped POSIX locks. This ordering is not an atomic multi-source
snapshot or ongoing/current readiness guarantee. The inherited code-provenance
and source scans may invoke read-only Git queries; no provider, recovery,
qualifier/verifier, live system-manager operation or authority RPC is executed.

## State-safety failure behavior

Normal blocked state-safety diagnostics are retained in full. Only an actual
producer `Err` becomes the original CLI catch object, exactly:

```json
{"version":1,"kind":"AutonomousResearchStateSafetyInspectionUnavailable","status":"autonomous_research_state_safety_blocked","ready":false,"blockers":["autonomous_research_state_safety_inspection_failed"]}
```

No underlying error is treated as absence, successful inspection or an unknown
authority outcome. Resident inspection errors still propagate as CLI errors, as
the original resident call is outside that catch. A Rust panic is not caught or
reinterpreted as an ordinary state-safety error.

## CLI compatibility and environment

Strict parser, duplicate/value validation order, original `USAGE` literal and
formatted help remain unchanged. Help still runs after lexical parsing and before
mode work. `--external-qualification-config` now reaches the resident producer
when full mode is selected; other modes retain original ignore behavior for that
option. No recovery config flag is invented; that producer uses its original
environment selection.

Passing precedence is exactly:

`fully autonomous > strict reconciliation > current intake > machine reconciliation > startup reconciliation > healthy`.

After successful observation, the full JSON report is printed and the selected
readiness determines exit 0 or 2. Supported full mode no longer returns the old
`unsupported_supervisor_health_mode` error. Unsupported native subprofiles remain
explicit diagnostics/errors; enabling this mode does not claim intake V2, plugin,
local-golden or independent recovery/activation gaps are all closed.

Only full mode captures the whole actual process environment because the actual
V3 qualifier/verifier allowlists choose keys dynamically. A fixed intake-key list
would change command identities. Values are kept in memory and never logged or
printed directly; the report exposes the producers' intended identities/blockers.
The captured environment is limited to 4,096 entries and 1 MiB of UTF-8 key/value
bytes including two delimiter bytes per entry. Duplicate names and non-UTF-8
keys/values are refused with stable errors:

- `autonomous_research_supervisor_health_environment_encoding_invalid`
- `autonomous_research_supervisor_health_environment_bound_exceeded`
- `autonomous_research_supervisor_health_environment_duplicate_key`

These limits define this new CLI profile, not an assertion that Node applies
identical environment bounds. Existing non-full modes keep their fixed key set
and encoding-error behavior. No process environment or cwd is rewritten. The
resident producer separately rejects nonempty release-commit overrides and
unsupported provenance environment profiles; the CLI does not suppress those
refusals.

## Repository selection and relocation

Original Node health uses `HEPTA_WORKSPACE_ROOT` derived from installed module
location, not a health-specific CLI repository flag or an environment override.
The native CLI uses `CARGO_MANIFEST_DIR/../../..`, resolved by the existing lexical
`native_workspace::resolve_native_workspace_root_v1`. That helper validates and
normalizes a path only: it is not an authenticated installation/source resolver.
No suitable native installed-source identity resolver was found in this path.

Consequently, copying the binary away from its original build tree does not
relocate its source observation automatically. Missing/mismatched compiled source
remains blocked/error according to actual source readers; the patch does not
invent `HEPTA_WORKSPACE_ROOT`, `--repository-root` or a current-cwd fallback as new
Node-compatible health behavior. Embedders can select an explicit source root via
the typed API and are responsible for choosing the actual intended repository.
Runtime-root explicit/default behavior is unchanged.

## Committed WAL diagnostic fix

Base status now uses existing
`state_database_inventory::with_database_effective_snapshot_path_v1` in place of
the main-only helper, with the same runtime root, relative path, role and callback.
Source SQLite is never opened directly; the shared helper copies validated main
and committed WAL observations into a private snapshot and owns private SHM.
No mutation or UID policy changes are introduced in that shared helper.

The owned original fixture reproduced a distinct diagnostic gap: an actual original resident lease
released into committed WAL was reported by Node as stopped, while the main-only
native read failed closed as invalid with null instance. This change should
preserve that actual stopped state in all health modes. It is not a demonstrated
false-healthy exploit. The WAL regression uses an actual owned keeper and a separate original reader, then closes/reaps the keeper before removing owned source SHM. Native observation must preserve source bytes/metadata and must not recreate SHM. Static preparation does not substitute for execution.

## Verification

The final-tree validation covers:

- Actual current intake + actual resident + actual state-safety full report,
  including a genuine configured recovery refusal and unconfigured sources.
- Full flag precedence when strict/current/startup are also present; retain the
  optional strict diagnostic, and compare complete original report fields.
- Dynamic qualifier allowlist key observation and explicit environment errors
  without exposing the values; help/parser and old-mode report regressions.
- Actual committed-WAL resident release visibility, no source SHM recreation,
  no source modifications, and unchanged non-WAL status behavior.
- No marker/provider/recovery/verifier invocation or RPC. Private snapshots and
  completed diagnostics do not prove independent production readiness.

The full report intentionally preserves diagnostic fields even when overall
readiness is false. It should not be described as a blanket false stub, a generic
fully-autonomous system-readiness port, or a live production-authority grant.

Actual integration suites: `supervisor_full_health_parity`, `supervisor_health_wal_parity`, `supervisor_health_parity`, `machine_intake_parity` and `strict_machine_intake_parity`. Receipt hashes are verified before wall-clock normalization in whole-report CLI comparisons. Native environment boundary tests do not claim that Node enforces those limits. Per-commit validation archives record executed outcomes and selected source hashes; this contract does not imply full CI or independent acceptance for an unvalidated head.
