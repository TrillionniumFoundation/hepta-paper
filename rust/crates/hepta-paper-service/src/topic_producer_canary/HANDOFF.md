# Recorded topic canary and generation contracts

This module ports the pure journal/side-effect verifiers from `paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs` and `parseGeneration` from `paper-adapters/automation/autonomous-research-topic-producer-repository-support.mjs:48–157`.

It performs no file, SQLite, clock, process, provider or RPC operation. A passing hash/data contract does not prove a canary ran, establish independent acceptance, create an authority grant, verify a capability's full reconstruction, or make a producer live. The original `parseGeneration` is deliberately weaker than the full latest-capability verifier. A later actual-source status owner must combine these functions with the separately implemented capability/profile contracts and bounded effective database observation.

## Public API and integration

```rust
pub fn verify_journal(value: &Value, provider: Option<&Value>, reservation: Option<&Value>) -> bool;
pub fn verify_side_effect(value: &Value, provider: Option<&Value>, reservation: Option<&Value>) -> bool;
pub fn parse_generation(row: &Value, provider: Option<&Value>, max_cost: Option<&Value>) -> Result<Value, Error>;
impl Error { pub fn code(&self) -> &'static str; }
```

The service crate exports `topic_producer_canary`. No Cargo dependency or feature change is required. Existing dependencies are `serde_json`, `thiserror`, `ryu_js`, and `hepta_legacy_compatibility`; crate-private reuse is `machine_intake::contract::{canonical_instant, exact_keys, integer}` plus `online_runtime_activation::ordered_json::{Json, parse_ordered}`. The sibling [generation/capability contracts](../topic_producer_generation/HANDOFF.md) rebuild the complete latest capability. These pure modules are not yet wired to actual topic status or V2 health.

The public functions accept recorded data because they are pure validators, not owning/live verification factories. The planned actual-source status API must not let callers substitute these returned records for a retained profile/source observation or a current V2 configuration. The sibling `topic_producer_generation` supplies full capability/planned-generation/pair logic; this module does not duplicate it.

## Semantics preserved

- Exact journal, inspection, reservation and action key sets; numeric safe-integer generation, numeric cost `[0,100]`, canonical reservation epoch, original role/action ordering, journal in-progress constraints, derived inspection counts/flags/scope/failure-code relation, and source-domain own hashes.
- Original lowercase SHA syntax. Shape predicates use JavaScript `String(value || '')`, including nested single-element arrays. Successful action receipt hashes can therefore have array transport. Failure receipt hashes need only be non-SHA-shaped, not necessarily null. Failure codes/phases may have original accepted array transport. The record's own claimed hash must ultimately be a string because original compares the generated hash using strict equality.
- Optional expected provider/reservation bindings use original truthiness. Object/array equality uses reference identity via `std::ptr::eq`, not structural `Value` equality. Passing `&record["reservation"]` preserves its array references; a separately cloned expected reservation with equal array values is unequal, as in Node. Independently parsed planned/journal JSON likewise does not gain shared array identity.
- The complete generation history parser binds the row to planned identifiers and the claimed planned hash but does not recompute that hash. Historical capability parsing binds only claimed hash/nonce. Complete newest-capability validation belongs to the separate full verifier.
- Started planned/authorized rows require a journal; started failed rows require a side-effect inspection; inspections require failed status and the exact failure code. Legacy produced-with-started/no-journal and failed-with-not-started/no-inspection combinations retain original behavior.
- `max_cost: None` or JSON null is original nullish fallback to each nested reservation's recorded cost. False/zero are supplied values, not nullish fallback. Standalone original status intentionally supplies no configured cost.
- Journal actions are compared with inspection prefix actions through raw parsed JSON's insertion-order-sensitive `JSON.stringify` representation. This occurs before converting the projection to canonical production JSON. No `serde_json` preserve-order feature is assumed or added.
- JSON row Number coercions include whitespace, decimal/exponent, radix strings, arrays, booleans and null. NaN/nonfinite lease-generation results project as JSON null; undefined output properties are omitted. The result is the original JSON boundary, not an in-memory JavaScript object that could retain NaN/undefined.

## Explicit bounded/native differences

Input traversal is bounded to 64 nested levels, 100,000 nodes, and 2 MiB accounted scalar/key bytes per input tree. Raw embedded JSON is additionally limited to 2 MiB; the outer row budget may reject it sooner because the row contains other fields. The existing production JSON parser's own grammar/depth limits remain in force. Nonfinite parsed JSON numbers and unpaired UTF-16 cannot be represented losslessly as serde `Value` and are rejected instead of being replaced before hashing. These are finite native transport restrictions, not original module limits.

The boolean verifiers return false for out-of-profile data. `parse_generation` returns `autonomous_research_topic_producer_state_json_profile_unsupported` for recognized bounds/lossless-JSON refusals. Original named validation errors use `autonomous_research_topic_producer_state_invalid`.

Two incidental original JavaScript property-access TypeErrors are explicitly profile refusals, not mislabeled exact error parity:

1. Truthy `capability_json` containing JSON null causes access to its hash property to throw.
2. A nonempty valid journal causes the original to dereference `inspection.actions[index]` before its inspection validator. A null inspection or absent/null actions therefore throws. The same null inspection with an empty or absent journal reaches ordinary `state_invalid`; this distinction is preserved.

Any own `toString` key anywhere in the supplied/parsed JSON is an explicit finite-profile refusal. This prevents original throwing String/Number coercions from being mistaken for an ordinary non-SHA failure hash or NaN lease number; pure verifiers return false and generation parsing returns unsupported. This conservatively also refuses unused such keys which original code might never coerce. Original oracle vectors cover failed-action hash String failure and all three row Number locations. Arbitrary callable/prototype behavior and engine TypeError text are not stable Rust API contracts.

No new schema, source-currentness, signature, clock, lease, or cost-authority check is invented here. A future source reader must complete/drop profile/dataset/implementation regular-file owners **before any business SQLite operation**, use private effective-WAL copies, and return only completed diagnostics. Neither this module nor sequential observations provide an atomic cross-file/DB snapshot.

## Original oracle and tests

`topic-producer-canary-v1.mjs` imports only the actual original pure contract/support modules plus production hash/profile qualification. It does not import the existing topic fixture that registers authority test-double hooks. The original builders construct journal and failure-inspection records; generation rows deliberately include a valid original weak-parser case whose planned record is not a full builder result. Those are clearly marked recorded fixture claims, not canary execution or independent acceptance.

The oracle takes one bounded JSON argument and imports fixed static source-relative module paths. It emits the actual `productionOracleProfile()` and an explicit recorded-data evidence scope. The integration runner invokes it through existing `machine_intake_support::run` (owned, bounded child/output), validates that profile, and caches this deterministic pure matrix within the test process. No actual credentials or service paths are involved.

Nine integration groups are implemented in the runner:

1. Actual original builder role/current-role transitions and complete/incomplete failure accounting.
2. Rehashed key/shape/derived-field tampering, wrong own hash, and exact header/value types.
3. Original truthiness, nested-array String coercions, and failed non-null non-hash data.
4. Provider and reservation same-reference versus cloned-array identity.
5. Generation/started/lease Number coercion, NaN/null projection, undefined omission.
6. Raw action member order, prefix accounting, nested cost fallback/mismatch, journal/inspection linkage.
7. Explicit native refusal of original incidental TypeErrors, distinguished from ordinary validation failures.
8. Legacy terminal combinations, missing/falsy rows, and weaker historical capability hash/nonce binding.
9. Native byte/depth/lossless UTF-16 profile bounds.

The qualified original Node matrix has 67 verifier and 53 generation vectors; nine original TypeErrors are explicitly classified profile refusals. Row/vector counts are subordinate to the nine meaningful test groups and are not independent acceptance tests. The original TypeError cases are not counted as full error-message parity. Per-commit validation manifests retain original preflight records, executed Rust results, source hashes and amendments. This specification alone is not a passing test or production acceptance receipt.

Run from `rust` with the qualified Node runtime on PATH:

```sh
cargo test -p hepta-paper-service --test topic_producer_canary_parity --locked
```
