# Portal target qualification preflight

`portal-target-qualification --action preflight` is the operator-facing,
read-only lint for a bounded portal qualification overlay. It selects one or
two real venues from the repository's canonical discovery registry; it never
scans or prints the full venue catalog.

Run it against the active registry contract with:

```bash
npm run automation:portal-target-qualification -- --action preflight \
  --target tmlr --qualification-level production \
  --registry <active.json> --registry-hash sha256:... \
  --trust-store <trust.json> --trust-store-hash sha256:... --require-ready
```

Lint a proposed successor with the same files and pins accepted by
`--action import-plan`:

```bash
npm run automation:portal-target-qualification -- --action preflight \
  --target tmlr --candidate <candidate.json> --candidate-hash sha256:... \
  --registry <active.json> --trust-store <trust.json> \
  --trust-store-hash sha256:... --require-ready
```

Candidate mode is whole-overlay validation: the selected `--target` set must
exactly equal the candidate registry's one or two entries. Active-registry mode
remains a bounded target query and may inspect one selected entry from an
otherwise valid two-entry active overlay.

Optional repeatable exact-binding pins use `VENUE=sha256:...`:

```text
--expected-subject-hash tmlr=sha256:...
--expected-route-hash tmlr=sha256:...
--expected-schema-hash tmlr=sha256:...
```

The plan reports typed blockers for missing typed evidence, registry/target/
evidence expiry, subject/route/schema mismatch, issuer-role mismatch, signer
subject/organization/SPKI aliasing, generation/predecessor/revocation drift,
and registry/candidate/trust-store pin drift. Output includes target IDs and
boolean check results, but redacts filesystem paths, signatures, issuer and key
identities, public keys, SPKI values, and source evidence hashes.

With no external registry configured, this command safely closes on the
canonical TMLR discovery target:

```bash
env -u HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY \
  -u HEPTA_PORTAL_TARGET_QUALIFICATION_REGISTRY_HASH \
  -u HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE \
  -u HEPTA_PORTAL_TARGET_QUALIFICATION_TRUST_STORE_HASH \
  npm run automation:portal-target-qualification -- \
  --action preflight --target tmlr --qualification-level production
```

The result is blocked by `registry_missing` and the six required typed evidence
items. The safety section remains explicit: no mutation, registry or evidence
generation, network request, credential use, portal login, upload, signature,
authorization, or live-commit permit occurs. `liveCommitAuthorized` and
`liveSubmissionReady` remain false even when the qualification lint passes;
final commit still requires a separate human-reviewed single-use permit.
