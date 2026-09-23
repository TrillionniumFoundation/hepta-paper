# Native actual-source topic producer status diagnostic

This module implements the read-only calculation in
`paper-adapters/automation/autonomous-research-topic-producer-status.mjs`.
The module is separately callable; there is no CLI registration or V2
machine-intake/health enablement in this slice.

## API

```rust
pub struct TopicProducerStatusOptionsV1<'a> {
    pub runtime_root: &'a Path,
    pub profile: TopicProducerProfileReadOptionsV1<'a>,
    pub expected_machine_intake_configuration_hash: &'a str,
    pub now: &'a str,
}
pub fn inspect_autonomous_research_topic_producer_status_v1(
    options: &TopicProducerStatusOptionsV1<'_>,
) -> Result<Value, TopicProducerStatusError>;
```

`TopicProducerStatusError::code()` is stable. Profile observation and option
failures return `Err`; database/source failures return the original five-field
empty diagnostic with their stable `blocker`. Supported successful database
observations return the original full report fields. Profile errors keep the
actual owning profile producer's code. The expected configuration hash is only
an equality input, bounded to 4096 bytes; this API does not read or prove a
current V2 machine-intake configuration. It accepts no caller profile JSON,
ready flag, capability object, authority or trust report.

Dependencies are actual `topic_producer_profile` ownership, the exact weaker
`topic_producer_canary::parse_generation` history contract, the full
`topic_producer_generation::verify_topic_producer_capability_v1` rebuild, the
canonical instant parser, and the existing effective private SQLite snapshot
helper. Existing pure verifier finite profiles remain in force.

## Actual observations and resource lifetime

`mod.rs` bounds the supplied runtime/cwd spellings before normalization or IO:
UTF-8, no NUL, at most 4096 bytes and 128 components individually and combined.
The cwd must be absolute. Relative runtime paths resolve against the explicitly
supplied profile working directory. Actual source ancestor/no-follow and safe
file validation comes from the shared snapshot producer; the early lstat only
preserves the original missing/invalid ordinary-file distinction.

The actual profile loader reads and verifies profile, mounted dataset and fixed
original implementation bytes. This module explicitly rechecks and drops that
entire owner before the snapshot helper begins any copying or SQLite access.
This matters because an arbitrary mounted file could alias a business database.
Call this API before opening caller-owned business SQLite connections.

Only the helper's private effective main/WAL copy is opened by SQLite. Its
ordinary source descriptors remain in the helper's bounded observation scope,
then are rechecked and closed after the callback. The callback's connection,
statements and rows have all dropped before those original source rechecks.
No source connection, SHM creation, migration, provisioning, journal repair,
lease acquisition or state write occurs. This helper intentionally retains its
existing source owner policy: original topic status did not require real-UID
ownership, so the separate current-real-UID snapshot helper is not substituted.

The observations are sequential and completed, not an atomic cross-file or
cross-database snapshot, persistent watch, live-currentness proof, independent
provider/canary acceptance or installed Rust provenance. In particular the
implementation digest is the real incumbent JavaScript source identity.

## Calculation and error order

After ordinary schema validation, the original order is retained for supported
data: three canary columns, singleton metadata/four identity bindings,
`MAX(generation_sequence)` versus high watermark, every historical generation,
clock/liveness and UTC-day budgets, production interval/retry time, then the
latest non-NULL capability's full verification. High watermark is neither a
count nor a contiguity requirement. The latest non-NULL capability is selected
regardless of generation status, with no fallback to an older passing receipt.
An empty capability string, which the historical parser skips but the original
latest-row JSON parse throws on, is an explicit JSON-profile refusal.

`ready` and `live` preserve the original metadata-observation semantics: no
clock rollback and last observation younger than 15 minutes. The lease table
is not consulted; no new lease gate is invented. `currentlyProducible` combines
that live diagnostic with strictly available daily budgets, the interval,
retry eligibility and latest full capability freshness. It never grants an
action; `providerMutationRequiresNewLiveCanary` remains true.

## Explicit finite profiles and limits

- `now` and every nonempty persisted last-observed/last-produced/next-attempt
  timestamp must be canonical ECMAScript UTC ISO, including canonical expanded
  years within TimeClip. NULL and empty TEXT keep the original falsy semantics.
  Other spellings, whether accepted by Date.parse or clearly invalid, return
  `autonomous_research_topic_producer_date_parse_profile_unsupported`; this
  module does not guess local timezone or claim full Date.parse compatibility.
  An invalid `now` is an outer option error; persisted time refusal is an empty
  database diagnostic. The diagnostic does not add timestamp gates to fields
  the original status calculation does not interpret.
- The three queried state tables must be ordinary CREATE TABLE objects with
  their consumed columns, no hidden/generated columns. Views and virtual
  tables are rejected before querying their data. Schema metadata is at most
  128 objects, each SQL definition 64 KiB, each table 64 columns. Unusual SQL
  comment spelling, duplicate schema names across kinds and malformed key
  duplicates are explicitly outside this finite ordinary-schema profile.
- Required counters/sequences use SQLite INTEGER in the safe JavaScript Number
  range; reserved cost may be finite INTEGER or REAL. Text must be UTF-8 and
  have the original ordinary storage type. Deliberately altered schemas that
  depend on coercing BLOB, NULL counters or numeric timestamp storage are not
  silently accepted. The module does not claim complete DDL identity checking.
- At most 10,000 historical rows, 2 MiB per embedded JSON cell, 4096 bytes per
  other text cell, and 32 MiB aggregate projected cell accounting. SQL guards
  prevent oversized/untyped cells from being copied into owned Rust strings.
  SQLite row length is bounded to 8 MiB + 64 KiB, SQL text 512 KiB, expression
  depth 100, attachments/workers zero, busy wait one second and approximately
  ten million VM instructions across this private connection. Source file and
  sidecar byte limits are inherited unchanged from the effective snapshot
  helper (256 MiB each, 1 GiB aggregate observation budget).
- Schema, storage, path and bound refusals have explicit `_unsupported` or
  `_bound_exceeded` codes. Generic malformed SQLite errors map to the stable
  original `autonomous_research_topic_producer_state_invalid` rather than
  attempting SQLite-version-specific error-message parity. Existing shared
  source-observation errors remain visible as the empty report's blocker.

## Actual-source validation

`tests/topic_producer_status_parity.rs` compares complete reports against
`rust/oracle/topic-producer-status-v1.mjs`. Fixtures use the real original
profile loader, offline repository provisioning, `tryAcquireLease`, and
`prepareGeneration`. Live-authority callbacks throw if called; their observed
count is zero. Eleven groups cover original empty/acquired/planned lifecycle,
absent lease, four metadata bindings, high watermark mismatch versus allowed
sequence gaps, all-history validation, exact liveness/rate/retry and daily
budget boundaries, negative/expanded UTC years, full capability rebuild and
expiry, newest non-NULL selection, dataset drift, missing/unsafe leaf,
legacy upgrade, and explicit schema/storage/JSON/date profile refusals.

Recorded capability inputs contain fabricated canary claims and pass through
the original builder/verifier. Their positive diagnostic cannot be used as
provider execution, authorization, independent acceptance or activation proof.
Original-positive noncanonical timestamp/view/generated/duplicate-row inputs
and bounded data refusals are labeled narrower native profiles, not universal
successful-input parity. Schema/cell boundaries are exercised; not every
aggregate/VM/history limit is individually saturated by these eleven groups.

Two groups use an owned bounded child retaining an old read transaction while
the original repository renews its lease in committed WAL. They compare the
new effective status, prove uncheckpointed frames remain, and then separately
crash/reap the child and remove only owned SHM. Native reads preserve every
source byte, identity, owner, mode, link count, length and mutation timestamp
and never recreate source SHM. Access time is excluded because the observation
itself reads the source. Child startup and output are bounded and RAII kills
and reaps only that child. These are completed sequential observations, not
an atomic concurrent-source proof.
