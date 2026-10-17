# Order-sensitive schema receipt wire fields

The incumbent Node schema contract compares reservation `instances` and
finalization `installations` with `JSON.stringify` equality. An object can have
an identical canonical signature but fail that comparison if its member order
changes. Actual original Node schema execution against the Rust server exposed
this difference; the fixture does not reorder its requests to work around it.

`CapturedEchoFields::capture` runs before the authority handler. It strictly
validates the complete JSON, borrows only these two named raw fields to measure
their size, then retains each field's `RawValue` and strictly parsed semantic
value. Duplicate keys at any depth and other unsupported JSON fail before any
state operation. The server checks its absolute deadline after capture and
before invoking the handler.

The handler still receives the normal validated `Value`, owns every signature
and transaction, and returns the actual receipt. The successful envelope binds
each captured field only if its normalized semantic value equals that actual
receipt field. A bound field is serialized using the original request syntax;
an absent or unequal field uses the actual receipt value. No other field,
especially signature, hash, identity or status, can be replaced from request
bytes. Canonical signing, stored data and receipt values are unchanged. This
projection grants no authority and cannot repair an invalid signature.

The existing 256 MiB aggregate/per-message wire-buffer budget is not raised.
Capture reserves the combined size of the two raw copies while the request
bytes still exist; output capacity subtracts raw echo bytes still retained
during serialization. Excess capture returns a pre-handler error. Excess
output or an expired deadline closes the peer; it cannot undo a committed
operation and the caller must use protocol resolution. These wire bounds are
not a total process-memory guarantee for parsed values and SQLite.

Error envelopes are unchanged. The client CLI uses its separately documented
strict raw JSON path so it does not destroy member order before or after the
server. The original `Value` library APIs remain semantic interfaces; member
order cannot be reconstructed after an earlier caller has discarded it.

Four wire tests cover both fields and nested member ordering, equivalent
integral numeric spelling, unchanged signature values, unequal/absent fallback,
duplicate-key rejection and capture/output limits. The independent complete
business fixture additionally uses the original Node schema executor and its
reservation/finalization validators against actual Rust-signed receipts.
No global serde `preserve_order` feature is enabled; only `raw_value` is needed.
