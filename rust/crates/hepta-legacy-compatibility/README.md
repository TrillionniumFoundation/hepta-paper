# Production Node record compatibility

This crate contains two **different, explicitly named formats**. Do not use a
Rust draft digest as evidence that a historical Node record is compatible.

| Operation | API | Bytes hashed |
|---|---|---|
| Historical production stable JSON | `production_stable_json_v1` / `parse_and_encode_production_v1` | Serialization only |
| Historical production `digest(value)` | `production_digest_v1` / `parse_and_digest_production_v1` | UTF-8 production stable JSON |
| Historical production `hashRecord(kind,value)` | `production_hash_record_v1` / `parse_and_hash_production_record_v1` | UTF-8 production stable JSON of `{kind,value}` |
| Retained Rust migration draft | `encode_rust_draft_stable_json_v1`, `hash_rust_draft_record_v1` | Lexicographic draft JSON inside the old length-prefixed `HeptaLegacyStableJsonV1` frame |

The old `encode_legacy_stable_json_v1` and `hash_legacy_record_v1` symbols remain
aliases for their existing draft behavior. This avoids silently changing stored
draft receipt identities. They do **not** describe the original Node algorithm.
The companion `hepta-compatibility` crate reexports the production APIs; its
`hepta-legacy-stable-json-v1` CLI emits production bytes by default, with
`--rust-draft-v1` for that crate's retained draft format. The two preexisting
draft crates differ in float normalization; their draft hashes are not
interchangeable. Production APIs now share this single implementation.

## Bounded Node observation adapter

`NodeLegacyObservationAdapterV1` is a separate, non-authorizing migration
primitive for observations that the incumbent Node runtime has already
produced. A request binds the exact attempt, legacy module/version, capability,
candidate, frozen input, Node entrypoint, state revision, record kind,
output-byte ceiling, and artifact-count ceiling. The observation must repeat
those identities exactly, contain sorted unique canonical artifact hashes,
remain within both request and absolute limits, and state that no external
action may have started.

The adapter reuses `parse_and_hash_production_record_v1`, computes a
length-framed observation digest, returns the original result for an exact
replay, and rejects conflicting reuse of an attempt identity. It never launches
Node, receives credentials, calls a provider, commits campaign state, or grants
writer authority. Durable callers must persist the attempt/fingerprint pair
across restart. This primitive therefore does not claim the complete Module
Protocol strangler adapter, production shadow/canary parity, cutover, or Node
retirement.

The dedicated integration tests are in `tests/node_legacy_adapter.rs`.

## Source contract

The executable oracle imports `stableStringify`, `digest`, and `hashRecord`
directly from `workflow-kernel/record-hash.mjs`. It does not reimplement any of
those functions. It returns its source SHA-256 and actual runtime/collator
metadata. The actual source SHA is pinned in the profile as well as checked
against the compiled-in source; editing the Node file requires explicit
requalification. Qualification rejects missing Node, failed oracle execution, source
mismatch, or runtime/collator mismatch; tests never silently skip.

The qualified profile is `node22.23.1-icu78.2-cldr48-en-US-v1`:

- Node v22.23.1, ICU 78.2, CLDR 48.0, Unicode 17.0.
- Default locale `en-US`; sorting, variant sensitivity, punctuation retained,
  default collation, numeric comparison disabled, case-first false.
- Native Rust ICU4X `icu_collator=2.1.1`, with the complete Unihan/Jamo/NFD
  data exported from official ICU78.2 and CLDR48 archives. Ordinary ICU4X
  compiled data has different extended-Han ordering and is not used.
- Ryu-JS `1.0.2` supplies ECMAScript Number formatting. A cached native blob
  provider validates its frozen SHA-256 before use; no Node runtime is needed.
- [Data provenance, licenses and regeneration](data/README.md) document the
  checked-in blob. Production-source differential tests remain required;
  matching version labels alone never establish compatibility.

The Node production code calls `localeCompare` without a locale, so old records
are inherently tied to the producer's default locale and ICU data. A Swedish,
Turkish, or differently versioned historic producer must be separately qualified
before migration. This adapter does not relabel such records as en-US.

## Serialization algorithm

1. The bounded raw parser reads JSON grammar and preserves UTF-16 string values,
   object insertion order, and duplicate-property behavior (last value, original
   insertion position). Numbers become IEEE-754 binary64 as in `JSON.parse`.
2. At each object, distinct non-index keys are stably sorted using the frozen
   en-US collator. Collation-equivalent keys retain their original insertion
   order; normalizing or lexicographically breaking these ties changes hashes.
3. Canonical array-index keys `0` through `4294967294` precede all other keys in
   ascending numeric order, matching `Object.fromEntries` / `JSON.stringify`
   enumeration. `01`, `-0`, and `4294967295` are ordinary string keys.
4. Arrays retain order. Ryu-JS emits Number bytes including `-0` to `0`, exponent
   thresholds, and binary64 rounding beyond the safe-integer range. Overflowing
   raw JSON numbers become `null`, matching JSON.parse followed by stringify.
5. Strings use JSON.stringify escaping, including lowercase escaped unpaired
   surrogate values; valid Unicode, `/`, U+2028 and U+2029 remain unescaped.
6. SHA-256 hashes exactly those UTF-8 bytes. A record hash includes the actual
   `{kind,value}` envelope and has no length-prefix or domain-separation frame.

## Resource and semantic boundaries

Input/output are limited to 16 MiB and nesting to 256 levels. Invalid UTF-8,
invalid JSON grammar, trailing content, and malformed object keys fail closed.
JavaScript object execution (`undefined`, accessors, symbols, functions, cycles,
custom prototypes and `toJSON`) is outside the JSON-data input contract.

An unpaired UTF-16 surrogate **object key** produces `UnpairedSurrogateKey`:
ICU4X replaces it during collation whereas Node ICU4C compares it differently.
Unpaired-surrogate **string values** are supported by the raw APIs. No hash is
returned for an unsupported key, so incompatible data cannot silently pass a
migration gate. The `&Value` APIs return `AmbiguousObjectKeyOrder` for collation-equivalent
distinct keys, because serde_json's default map has already lost their insertion
order. The raw APIs preserve those keys exactly. No global `preserve_order`
feature is enabled, so unrelated Rust receipt serialization stays unchanged.
Existing source bytes should use the raw APIs to retain all
JavaScript JSON parsing semantics.

## Verification

Run with the exact profile's Node executable on PATH:

```
cargo test --locked -p hepta-legacy-compatibility
cargo clippy --locked -p hepta-legacy-compatibility --all-targets -- -D warnings
```

The differential suite compares canonical bytes, plain digests, and kind/value
record hashes against the actual production exports. It covers numeric-index
keys, nesting, punctuation/case, composed and decomposed keys in both orders,
duplicate properties, unusual property names, Unicode/control strings, numeric
rounding/thresholds/overflow/subnormals, 4,096 deterministic binary64 samples,
and over 2,500 Unicode/collation keys in forward and reverse insertion order.
A separate profile test rejects Node/ICU/locale/source drift.

Database callers must independently preserve source SQLite type semantics.
For example, Node SQLite rejects unsafe 64-bit integer retrieval by default;
this JSON adapter's deliberate JSON.parse binary64 coercion does not authorize
rounding an unsafe SQLite integer or certify database-schema equivalence.
