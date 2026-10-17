# Legacy schema-epoch history verification

`verify_schema_history_v1` is a private, read-only consumer of the owner's
`JournalRows`, exact current daemon configuration and actual Ed25519 public key.
It performs no SQL or file access and has no signing key, transport, clock,
deployment input or callback that could claim a signature passed. The owning
inspector must first pin the independent public-key configuration, hold the
actual main SQLite snapshot, inspect the exact Node source schema and collect
the bounded six-table SQL snapshot. This helper does not replace those steps.

The opaque result exposes a schema-epoch mutation replay starting point:

```text
{ globalSequence: 0, globalHash,
  databaseHeads: [{ databaseRole, databaseInstanceId, schemaContractId,
                   sequence: 0, hash, schemaHash, stateHash }] }
```

It also provides final-epoch trust, an initialized flag and a schema-history
report. None is migration permission, a process-stop certificate, native writer
admission or a production-ready claim. The owning inspector must replay every
mutation from this starting point and compare all actual terminal metadata and
database heads. In particular, this helper does not mistake the schema genesis
for the current head after subsequent business mutations.

For an uninitialized source, the deterministic original
`HeptaLocalStateAuthorityGenesisGlobalHead` is reconstructed from the current
authority/key/scope/database-scope/writer identities. No schema-transition or
rebind row may exist. The owner separately requires uninitialized metadata,
sequence zero, the matching global hash and no heads or other history. There is
no signature in this state; the independent actual public-key pin remains
essential and a textual key identifier cannot replace it.

For an initialized source, the single original schema transition must retain
complete reserve/finalize request and receipt pairs under SQL singleton/rowid 1.
Every JSON TEXT is parsed with the existing strict parser; only the semantic
verification view normalizes integral JSON number spellings. Original SQL TEXT
and rowids remain unchanged in `JournalRows`. Individual request/receipt
contracts are checked at their signed historical times, with actual Ed25519
verification and the existing Node base64 rules. The original schema finalizer
requires its signed finalization time to be strictly before reservation expiry.
No present-time lease freshness or invented cross-transition clock monotonicity
is imposed on retained historical receipts.

The verifier independently reconstructs every original database genesis hash
and state hash from the initial request, as well as the global genesis hash.
A valid signature over an arbitrary hash is insufficient. Initial finalization
must report exactly that sequence-zero global head.

Rebinds are followed as one unique chain linked by source writer, previous
global hash and all ten exact previous database heads. SQL ordering alone is
not accepted as continuity. For every successor the original pristine-rebind
builder must reproduce its complete signed genesis. Source and target
configuration fields other than the writer manifest remain fixed, and each
stored and signed target hash must equal the reconstructed complete target
configuration hash, including paths and lease settings. The final configuration
must be exactly the independently supplied current configuration. Histories
whose old configuration cannot be reconstructed this way are refused.

The request contract requires instances to be strictly sorted by
`databaseInstanceId`, matching the original SQL `databaseHeads` ordering. Role
order is not substituted. Rebind rowids must increase along the content-linked
chain, so the incumbent's latest-row inspection still identifies its terminal
epoch. Target configuration hashes must be unique across retained rebind rows:
the original restart activation requires exactly one matching historical target
candidate. Pending, partially finalized, unactivated, transplanted-key,
orphaned, forked or disconnected rebind rows fail closed. The owner refuses all
backup history in this first migration contract.

Bounds are at most one initial transition, 64 rebinds and 1 MiB per parsed
record, in addition to the owner's total SQL snapshot limits. Records retain
their actual SQL key and rowid bindings; no caller JSON constructor creates the
opaque result. This is still inspection of supplied retained evidence, not
independent authentication of arbitrary caller-created SQLite connection state.

`oracle.mjs` uses Node 22.23.1 and the original authority runtime with an isolated
fixture key. It actually reserves/finalizes initial schema transitions and
performs target-configuration restarts for one or two pristine rebinds. Expected
heads come from its signed receipts and actual inspection. It exports
`createSchemaHistoryFixture` for sibling mutation-history fixtures; its CLI is:

```text
node oracle.mjs <repository> <existing-canonical-/tmp/hepta-directory> <scenario>
```

Scenarios are `uninitialized`, `genesis`, `rebind`, `rebind2`,
`rebind-permuted`, `reserved-initial`, `reserved-rebind` and `finalized-rebind`.
Output includes configuration/path, public-key PEM, genesis, terminal
inspection, retained transitions and qualified Node profile. Private-key bytes
are never returned. These signatures authenticate fixture protocol records;
they do not qualify a deployment or claim that fixture business databases
underwent real production schema installation.

Tests compare real Node genesis and activated chains, including database IDs
whose sort order differs from role order. They reject pending stages and actual
SQL key, NULL-pair, rowid, orphan, signature and configuration mutations. Two
negative fixtures are re-signed with the actual isolated key and still pass
individual receipt contracts, proving that deterministic genesis and complete
chain checks—not merely a broken signature—reject them. Integral wire-number
and permitted base64 spellings retain their established protocol meaning.

Run from `rust` with the qualified Node on PATH:

```text
cargo test -p hepta-paper-service --lib local_state_authority::migration::schema_history::tests
```
