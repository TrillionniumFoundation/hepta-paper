# Native full-production readiness

The Rust `full-production-readiness` route now verifies independent owner
acceptance and production operational receipts before applying the five-axis
readiness policy. The command remains `partial_local_source`: package recovery
helper execution, live automation aggregation and off-host WORM custody adapters
still block full production. A successful synthetic test is not external approval.

## Composition and inputs

The entry point is
`rust/crates/hepta-paper-service/src/full_production_readiness.rs`.
`inspect_full_production_readiness_v1` overlays the optional private deployment
environment, resolves the selected roots, pins the public owner references,
inspects their signatures and operational receipts, evaluates the policy, and
rechecks retained evidence before hashing its report. The command does not invoke
Node at runtime. Node is used only by differential tests.

The existing six mandatory reference arguments remain unchanged. Explicit roots
override the deployment-file and ambient environment defaults. Public owner
inputs must be the exact `OWNER_TRUST_STORE.json` and
`CAPABILITY_OWNER_ACCEPTANCE.json` pair in one `capabilities-public` directory;
both files and that directory must belong to UID 0 and must not be writable by
group or others. Production exposes no UID override. Test-only code permits
temporary synthetic fixtures owned by the test user.

## Owner acceptance boundary

`full_production_readiness/owner.rs` uses the descriptor-relative owner reader to
reject aliases, symbolic links, hard links, duplicate JSON members, oversized
inputs and changed snapshots. It binds each public document's bytes to the
declared SHA-256. It rebuilds the family manifest from the current migration
matrix, requires the pinned family-manifest hash and all 249 legacy entries, and
verifies the actual Ed25519 capability-owner signature through the authority
verifier. Accepted family IDs must be complete and unique before counting any
family. Local-administrator assurance never becomes independent acceptance.

The source matrix, manifest, protected public-directory identity and imported
files remain checked through final report creation. An observed replacement or
permission/identity change invalidates the observation. These checks describe a
current observation, not a future immutability guarantee.

## Operational proof boundary

`operational_status/production.rs` receives only the explicitly pinned public
trust store from this composition. Runtime-local trust is not a fallback. It
examines all 16 catalog capabilities against current source target hashes and
the actual Git provenance. Accepted production receipts require the existing
role, independent-subject, signature and external-assurance checks. Conformance
fixtures cannot qualify. Receipt hashes are unique and sorted; each capability's
accepted evidence is retained for the final currentness check. More than 4,096
JSON entries in one capability receipt directory produces an error, not a
verified prefix. Source target hashes and provenance are rechecked as well.

## Policy and output

`full_production_readiness/policy.rs` ports the Node package response protocol and
five-axis evaluator. It validates the exact recovery response fields and record
hash, typed booleans and counts, unique blockers, canonical timestamps, maximum
30-second response delay and five-minute authority window. Recovery freshness
is checked again at the aggregate observation. The remaining axes require live
automation readiness, unexpired WORM custody evidence, all 249 independent
acceptances and all 16 independent operational proofs.

The pure policy API takes JSON observations; callers must establish their
authenticity at the composition boundary. A supplied JSON value is not an
authority object. The CLI accepts no caller-supplied ready aggregate. The CLI's
three incomplete adapters supply explicit blocked observations. Missing or
malformed inputs produce `inspectionErrors` and blockers; no fabricated commit
identity is inserted. Final output includes a content-bound
`fullProductionReadinessStatusHash`, and `--require-full-production` exits with
status 2 while any required gate is blocked.

## Verification and remaining work

Tests use the pinned Node v22.23.1 oracle and Rust 1.98.0. Owner and operational
tests compare the real incumbent verification results, including changed
signatures, local/revoked trust, missing evidence and retained-file replacement.
The composition regression verifies synthetic 249/249 and 16/16 inputs, rejects
runtime-trust fallback and owner tampering, checks the final report hash, and
keeps package recovery, WORM and automation blocked. The pure policy suite
compares valid, expired and malformed observations with the Node evaluator.

```bash
cargo +1.98.0 test --manifest-path rust/Cargo.toml -p hepta-paper-service \
  --lib full_production_readiness --locked
cargo +1.98.0 test --manifest-path rust/Cargo.toml -p hepta-paper-service \
  --lib operational_status::production --locked
```

Next implementation work must preserve the incumbent protected-command path,
descriptor execution, restricted child environment, timeout/output bounds and
postflight identity checks for package recovery. WORM and automation adapters
must inspect their actual external evidence and target host. Full command parity,
independent acceptance, production activation and Node retirement remain separate
unfulfilled gates in the [command ledger](../migration/NODE_RUST_GAP_CLOSURE.md).
