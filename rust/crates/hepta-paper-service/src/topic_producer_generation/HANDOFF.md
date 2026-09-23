# Recorded topic generation and capability contracts

## Scope and integration

`topic_producer_generation` ports pure data contracts from
`paper-domain/automation/autonomous-research-topic-producer-contract.mjs`:
materialization, planned generation, provider canary pair checks, capability
construction and full rebuild/equality verification. The sibling
[canary journal contract](../topic_producer_canary/HANDOFF.md) covers recorded
attempt/failure accounting and generation-row parsing. These are separately
callable prerequisites; actual topic SQLite status, production mutation,
admission V2, genesis/rotation authority and V2 health integration remain open.

A true result checks recorded claims and hashes only. Neither this module nor
its fixtures run models, allocate budgets, acquire producer/resident leases,
verify independent signatures, install a producer, or grant work authority.
The separately callable [actual profile loader](../topic_producer_profile/HANDOFF.md)
observes filesystem sources. These pure APIs accept plain JSON and make no
filesystem provenance claim. A future actual consumer must first observe and
recheck its real profile owner, clone the projection, and drop all profile/data
FDs before opening business SQLite or its source-copy ordinary descriptors.

## Interfaces and failures

- `materialize_topic_producer_intake_v1(profile, sequence, admitted_at)` returns
  the registered profile selection and its complete original production-run
  intake, including the original intake hash.
- `build_topic_producer_planned_generation_v1(profile, sequence, admitted_at,
  reservation_id)` returns the complete original plan and attached intake.
- `verify_provider_canary_pair_v1(receipt, expected_provider, now)` checks the
  original exact outer pair contract and both inner canary records.
- `build_topic_producer_capability_v1(options)` accepts the incumbent builder's
  named JSON fields and returns the complete recorded capability.
- `verify_topic_producer_capability_v1(value, profile, configuration, intake,
  now, require_fresh)` rebuilds all generation/intake/pair/capability bindings.

All return a typed `Result` with a stable `code()`. Ordinary builder errors use
original codes. Unsupported JSON/date/profile transports remain explicit errors;
verification does not silently convert them into a claimed original false
result. The pure APIs perform no I/O and have no implicit wall clock. Use
canonical UTC ISO strings for time inputs. Recursive values are bounded before coercion/hashing to depth 64, 100,000 nodes
and a conservative 2-MiB string/key/primitive accounting budget. Callers that
parse untrusted JSON must also bound their source bytes before construction.

## Exact generation behavior

The original full builtin profile verifier is reused internally. Selection is
`(generationSequence - 1) % registeredResearchProfiles.length`, with exact
ECMAScript positive safe integers. The original bounded-replication suffix,
paper/campaign/intake IDs, revision/referee counts, mounts and budgets are
retained. Objective UTF-16 and UTF-8 byte headroom are checked again after the
suffix. The production-run path does not invent recurring-golden closure gates.
All three public builders normalize their completed projection through production
JSON after hashing: `1e0`/`1.0` become `1` and negative zero becomes `0`, as at
the incumbent JSON boundary. This changes no record hash domain.
Provider-level `String([hash])` transport is retained: its original payload hash
is checked before a private scalar-shape probe invokes the existing intake
verifier. Optional mount-array transports retain the profile loader's explicit
unsupported boundary.

Reservation IDs preserve original `String(value || '')` coercion and its
48-byte ASCII grammar. UTC budget epochs include pre-1970, year zero, signed
six-digit years and both Date range endpoints. The planned-generation payload
hash excludes its attached intake, exactly as in the original; the separate
fingerprint binds profile, canonical topic, replication policy and epoch.

## Recorded pair and capability behavior

Pairs have the exact original 16 keys. Inner canary records intentionally allow
extra fields, which are covered by their production hash. Both inner statuses,
execution/scope claims, hash links, 900,000-ms windows and checked-time bounds
are required. The original final observed-time comparison is string UTF-16
order, including expanded-year behavior. The original pair contract does not
separately require pair.observedAt <= now; the port preserves that weaker
recorded-data predicate without presenting it as live execution evidence.

Capability construction first regenerates the planned hash and intake hash,
checks both positive safe-integer lease generations, their recorded hash shapes,
nonce grammar and pair validity at the provided time. Expiry is the minimum of
both canary expiries and pair.observedAt plus the profile validity interval.
Canonical ISO output supports negative/expanded years. Hash-shaped lease-token
and nonce arrays preserve the original String coercion and payload transport.

The original builder copies several supplied planned fields after checking the
planned hash. It does not separately reconstruct those copied fields. Native
preserves that behavior, including omission of missing JS-undefined fields.
The full verifier separately rebuilds the complete plan from profile, sequence,
admission time and reservation ID, then rebuilds the capability and compares the
entire equality-domain hash. Consequently rehashed changed/copied plan fields,
extra safety fields and stale bindings fail verification even if the builder
produces a document. An envelope hash check is not substituted for this rebuild.
Freshness optionally checks issuedAt <= checkedAt < expiresAt. A falsy supplied
checked-at value follows the original fallback to issuedAt; requireFresh=false
still checks the recorded pair at its issued time during reconstruction.

## Compatibility limits

The source profile supports five builtin families and inherits the actual
profile contract's plugin/local-golden and mount-hash transport limits. Plain
JSON cannot express JS shared object graphs, Dates, accessors, Symbols or
undefined values. Own `toString` keys, which can shadow JS coercion methods,
return an explicit native JSON-profile error. Supplied JSON missing fields retain omission where relevant;
null is not silently treated as undefined. Expected-object strict equality uses
reference identity rather than structural equality, and numeric equality uses
ECMAScript Number values.

Canary and checked-at times currently support canonical Date#toISOString
strings, including signed expanded years within TimeClip. Original Date.parse
also accepts full-second ISO, offsets, locale spellings, rollover dates and
certain primitive/array coercions. These return
`autonomous_research_topic_producer_date_parse_profile_unsupported`, even where
an original fixture is positive. This explicit remaining compatibility gap must
be resolved or independently accepted before broad status/activation parity.
Nonfinite JSON numbers and unpaired UTF-16 strings remain outside the existing
native JSON/hash profile. No Node process is called by production code.

## Verification

`tests/topic_producer_generation_parity.rs` has twelve differential groups and one native transport-bound group for
all five builtin selections, safe-integer limits, UTC/expanded date edges,
reservation coercions, objective byte headroom, both pair windows and hash links,
minimum expiry, complete rehashed capability mutations, weak builder versus
full verifier behavior, lease/nonce coercions, freshness/fallback, provider
array transport and explicit original-positive date-profile refusal.

`rust/oracle/topic-producer-generation-v1.mjs` imports the actual original pure
contracts and qualified production hash runtime. Canary records are fabricated
recorded-data fixtures tagged `fixtureEvidence: true`; the outer oracle labels
every result `pure_recorded_contract_fixture_no_canary_execution_or_authority`.
No canary adapter, authority hook, provider call or independent acceptance fixture
is imported. Rust invokes the oracle with the existing bounded 60-second,
2-MiB child runner. The transport limits arguments to 96 KiB.

Run from `rust` with the qualified Node runtime on PATH:

```sh
cargo test -p hepta-paper-service --test topic_producer_generation_parity --locked
```

Per-commit validation manifests record actual outcomes, hashes and amendments;
this document is a technical contract, not a successful execution receipt.
