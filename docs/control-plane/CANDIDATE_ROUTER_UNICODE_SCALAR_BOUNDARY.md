# Candidate Router V1 Unicode-scalar boundary

Candidate Router V1 orders canonical object keys by unsigned UTF-8 bytes. The
accepted JavaScript string domain is therefore restricted to Unicode scalar
values. Isolated high or low UTF-16 surrogate code units are rejected before
candidate capture or hashing, whether they occur in an object key or a string
value.

This rule prevents distinct JavaScript keys such as `\uD800` and `\uD801` from
both being replaced by U+FFFD during UTF-8 conversion and becoming comparator
equals while `JSON.stringify` emits distinct escaped spellings. Valid surrogate
pairs and the actual U+FFFD scalar remain legal. For the accepted domain, UTF-8
is injective, so comparator equality implies identical serialized key bytes.

The public entry module performs a bounded descriptor-based scalar scan and
then delegates to the frozen V1 routing core. It does not execute accessors.
JavaScript Proxy reflection remains within the already declared
`trusted_same_realm_plain_data` boundary; untrusted values must first cross a
bounded duplicate-key-safe serialized or isolated process boundary.

The dedicated test executes opposite insertion orders for lone high surrogates,
lone low surrogates, valid supplementary-plane pairs and U+FFFD. It binds this
compatibility rule without changing candidate authority, module qualification,
currentness, dominance, execution or production semantics.
