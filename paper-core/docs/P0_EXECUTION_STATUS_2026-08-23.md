# P0 execution status — 2026-08-23

This is a **non-authoritative, read-only audit note** for the P0 execution
sequence.  It records observations made on 2026-08-23 (Asia/Shanghai) and
does not mint a signature, owner acceptance, production qualification, WORM
receipt, KMS/HSM key, or submission authorization.  A plan hash in this file
is only a reproducibility aid; it is not release evidence.

## Snapshot and freeze boundary

The development checkout inspected was `/data/home-data/hepta-paper`.

| item | observation |
| --- | --- |
| `HEAD` | `6fda01d6ec3e2fdfb702c1fa4a5f21fe8a0fb38a` |
| `HEAD^{tree}` | `5cd8dd69e30b7bc522649729c73b8fb8f6f9b1f5` |
| release state | development candidate; not `release_ready` |
| historical audit worktree count | 338 status entries (the prior audit context) |
| P0-A baseline count | 11 porcelain entries (8 tracked modifications + 3 untracked files), captured before later concurrent P0 edits |
| later live observation | 14 porcelain entries; the tree was still changing, so this is not a freeze |

The reduction from the historical 338-entry worktree to the 11-entry P0-A
baseline is real progress, but it is not a clean commit.  The number 338 is
not recomputed from this current checkout and must not be presented as the
current count.  Conversely, the number 11 is a timestamped baseline and must
not be presented as the current count after other agents continue editing.
The only release-grade count is a fresh `git status --porcelain=v1` result
taken after all changes are stopped, followed by a clean exact commit.

The P0-A baseline `release:plan` graph report was:

- 1,241 reachable production modules and 4,608 edges;
- 2 reachable modules untracked by Git;
- 3 reachable modules whose worktree bytes differed from the index;
- graph manifest hash
  `sha256:1c653b6eec9aa893831e7e3f09f6182213f4e6f8b1a099ba0ef219bee26f7614`.

After concurrent P0 additions, a later observation reported 1,243 modules,
4,618 edges, 4 untracked modules, 3 index mismatches, and graph hash
`sha256:042f10c0e700c1d1a97c5713530889e1f655031a4a38a78da3b732447abc2736`.
The changing graph is itself evidence that an exact-commit release run must
wait for a coordination freeze.

## Release-readiness plan result

`npm run release:plan` is observation-only.  The default development invocation
returned `release_readiness_blocked`.  With the intended production roots,

```text
ELAN_HOME=/opt/hepta-paper/elan
HEPTA_PAPER_RUNTIME_ROOT=/var/lib/hepta-paper/runtime
```

it still returned `release_readiness_blocked` (plan hash at that observation:
`sha256:390b3f62d374641904724742aba42ce5c07a8a951d38734b6d9da133171dc8c0`).
The sections were:

| section | observed status | evidence / blocker |
| --- | --- | --- |
| freeze | blocked | dirty worktree; reachable production modules untracked and not index-bound |
| external materials | ready | all 10 required source/config/docs materials were present |
| formal | blocked | no current zero-skipped receipt in the production runtime; the explicit `ELAN_HOME` resolves the pinned toolchain but does not create a receipt |
| authorities | blocked | production owner trust/acceptance documents were not available to the release plan; independent owner acceptance remains 0 |
| compute | blocked | RTX 4060 is visible, but protected NVIDIA CI is not provisioned and no independently signed GPU qualification exists |
| submission | blocked | single-venue file is an inert fail-closed template (`unconfigured_fail_closed`, disabled, live commit disabled); no verified binding/canary/live authorization |
| operations | blocked | production runtime database/integrity pin was unavailable; external WORM custody and restore attestor are absent |
| supply chain | blocked | SBOM/policy/workflow files exist, but independent OCI verifier and registry attestation are absent; bitwise rebuild is unverified |

The explicit production-root run had these release blockers (duplicates
removed):

```text
formal_release_plan_zero_skipped_receipt_required
production_graph_modules_not_index_bound
production_graph_modules_untracked
release_plan_clean_commit_required
release_plan_external_worm_custody_required
release_plan_independent_gpu_qualification_required
release_plan_independent_owner_acceptance_required
release_plan_nvidia_ci_not_provisioned
release_plan_oci_independent_verifier_required
release_plan_owner_acceptance_missing
release_plan_owner_trust_store_missing
release_plan_registry_attestation_required
release_plan_restore_attestor_required
release_plan_runtime_database_missing
release_plan_single_venue_sandbox_configuration_required
```

The development-root run can see a local SQLite database and local owner
documents under its migration/runtime area, but those are local evidence.  A
local file, local-admin signature, or local replay is not an external owner,
KMS/HSM, off-host WORM, independent observer, or production qualification.
The inspected local runtime receipts are also stale relative to this run: the
visible owner/conformance/release-evidence material was last modified on
2026-07-13 (the newest visible 0.20.x bundle was 0.20.4).  Their presence does
not satisfy the exact-HEAD refresh requirement.

## Legacy, formal, and runtime externalization

The source-side externalization inventory passed for the ten required files,
including the legacy salvage manifest, empirical-analysis deprecation receipt,
release dependency tree, WORM contract, current status, release notes, and
single-venue/production-integrity schemas.

Independent read-only checks also observed:

- `legacy-matrix-reference-status`: `immutable_legacy_matrix_reference_ready`,
  263 source files, archive hash
  `sha256:e431c4c7a51a15d64866b17a07c09dd17c15c32c8dddaccf1a769b1a5942cb9d`;
- `legacy:fixture-verify`: `legacy_differential_reference_verified`, 3 files,
  verification hash
  `sha256:3df9b9094de62be97754712fa9884c5fd0d8ebd025280056f4fb7944efa4ea35`;
- `migration:matrix-integrity`: exit 0 (only Node experimental-SQLite
  warnings were emitted).

These checks establish source/archive integrity only.  They do not constitute
external owner acceptance or production promotion.

The pinned formal resolver succeeds only with an explicit absolute
`ELAN_HOME=/opt/hepta-paper/elan`:

- toolchain: `leanprover/lean4:v4.30.0`;
- toolchain identity: `lean_toolchain_identity_verified`;
- Lake executable hash:
  `sha256:d3e1f322c08d87f0d5850132a0b0309c1edbe53d641276b344717da448c8bc8b`;
- formal sandbox configuration hash:
  `sha256:bbe9e358af5dc35ae18926b2242e51af91df74edfdcd02c54263a8dba656ebbf`.

The dynamic formal operational run did execute all 23 expected tests with
`23 pass / 0 fail / 0 skipped`, but it exited fail-closed with
`formal_operational_code_provenance_changed`: other P0 edits appeared while
the run was in progress.  No zero-skipped receipt was accepted.  The run must
be repeated after a coordination freeze, with the pre/post provenance hashes
identical, and its receipt must be written by the reviewed release path.

## Sealed read-only provenance policy

The development checkout has no `deployment-closure/TOOL-CLOSURE.json` and
therefore reports `sealed_readonly_submodules_not_configured`; this is expected
for a development tree and is not a production qualification.

The read-only deployment `/opt/hepta-paper` has a closure and the dedicated
sealed inspector verified both submodules without invoking ordinary
`git status`:

- closure hash:
  `sha256:3dde5272fd12414d5d5f59be348228f2f1b0ffae6e2152f125c0ca1d2c0766ca`;
- `core` commit `ff1779d38561e940e5e067006386ff00d8d09a7c`;
- R source-CAS commit `d13d857909525f4173063dbd6a7f1f48a089ae93`.

An ordinary `git status` in `/opt/hepta-paper` attempted the Git-LFS clean
filter and failed because the deployment is read-only.  This is why the
sealed policy must consistently use the closure-aware, no-status inspection
for a sealed deployment.  The source code currently contains that explicit
policy; release entrypoints must continue to require a verified closure and
must not silently downgrade a missing/changed closure.

## External-owner boundary and next gate

The local acceptance ledger reports 249/249 local-admin-delegated entries, but
independent external-owner acceptance is 0/249 and independent production
operational proof is 0/16 until distinct owner and observer signatures are
actually ingested.  No signature or credential was fabricated during this
audit.

Before calling this P0 complete, the operator sequence is:

1. stop concurrent edits and obtain a clean exact commit; stage/commit every
   reachable production module and regenerate the graph/index evidence;
2. run the formal operational gate once, without source/index/untracked drift,
   and retain its exact-code-bound zero-skipped receipt;
3. obtain independent author/reviewer/release-attestor/qualifier evidence via
   the reviewed KMS/HSM and off-host custody paths;
4. rerun the plan and require every blocker above to be closed by the
   corresponding external authority, not by changing a local boolean;
5. only then proceed to the single-venue canary and later P1/P2 supply-chain
   and database work.

Until those conditions are met, the correct status remains **release-readiness
blocked / not full production ready**.
