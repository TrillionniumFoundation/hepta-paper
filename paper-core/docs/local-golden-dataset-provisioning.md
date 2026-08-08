# Local golden dataset provisioning

`hepta-paper operator local-golden-dataset-provision` creates the signed,
host-hidden dataset harness needed by an isolated local golden campaign. It is
deliberately incapable of qualifying a production dataset or creating an
external academic trust claim.

The command emits a version-4 `LocalGoldenDatasetHarnessAuthority` whose
signed scope is fixed to:

```text
authorityScope=local-operator-golden-runtime-only-v1
evidenceClass=local_operator_dataset_authority
academicPromotionEligible=false
externalTrustClaimed=false
```

Version 4 uses the distinct `LocalGoldenDatasetHarnessAuthority` kind,
`local_golden_dataset_operator` signature role and
`local-golden-dataset-authority-v1` key purpose. The public trust record and
every key in it are scoped to that purpose and contain no generic
`dataset_harness_operator` capability. The reader rejects a v1-v3 authority
under this trust root even if the same private key is used to re-sign it, so
removing the local-only fields cannot restore academic eligibility.

The signature also binds an isolation ID and a hash of the exact canonical
runtime root. Copying the mount or private envelope to a different runtime
fails authority verification. Passing this authority to a non-local benchmark
execution fails with
`local_golden_dataset_authority_requires_local_only_execution`.

## Inputs

Create three physically disjoint directories: an existing mode-0700 runtime,
an existing mode-0700 control root, and an immutable dataset directory. The
dataset directory and every descendant must have all write bits removed. The
command rejects the workspace, configured native asset/runtime roots and all
paths below `/var/lib/hepta-paper`, `/srv/hepta-paper`, `/etc/hepta-paper`, or
`/opt/hepta-paper`.

The split-assignment input has this shape and must name every exposed dataset
file exactly once. A `test` split is never accepted:

```json
{
  "version": 1,
  "kind": "LocalGoldenDatasetSplitAssignments",
  "datasetName": "golden-example",
  "entries": [
    { "path": "train.csv", "split": "train" }
  ]
}
```

The other inputs are existing canonical contracts:

- a private mode-0600 `OperatorAuthorizedDatasetBenchmarkHarness` containing
  the host-only cases and oracle;
- an `AcademicAnalysisProtocol` for the same benchmark and family;
- `OperatorDatasetResearchSemantics` whose eligible splits cover the exposed
  files;
- a public-key-only, local-purpose `AuthorityTrustStore` whose active Ed25519
  keys carry only `local_golden_dataset_operator` and the matching signed key
  purpose/scope markers;
- the matching mode-0600 Ed25519 private key, stored outside the dataset,
  runtime, control and repository roots.

An ordinary CSV path is not a qualification input. Provisioning requires the
complete file manifest, explicit splits, hidden evaluation harness, power-valid
schedule, analysis protocol, research semantics, public trust record and
signature authority.

## Plan and execute

First run the non-mutating plan:

```bash
npm run hepta-paper -- operator local-golden-dataset-provision -- \
  --action plan \
  --runtime-root /var/tmp/hepta-golden/runtime/native-runtime \
  --control-root /var/tmp/hepta-golden/control \
  --isolation-id golden-ff-20260808 \
  --dataset-name golden-ff-monthly \
  --dataset-root /var/tmp/hepta-golden/datasets/ff-monthly-train \
  --dataset-license-id LicenseRef-Ken-French-Data-Library-Terms \
  --split-assignments /var/tmp/hepta-golden/control/splits.json \
  --harness-definition /var/tmp/hepta-golden/control/hidden-harness.json \
  --analysis-protocol /var/tmp/hepta-golden/control/analysis-protocol.json \
  --research-semantics /var/tmp/hepta-golden/control/research-semantics.json \
  --authority-trust-store /var/tmp/hepta-golden/control/public-trust.json \
  --authority-private-key /var/tmp/hepta-golden-secrets/dataset-authority.pem \
  --authority-key-id golden-dataset-operator \
  --signed-at 2026-08-08T08:00:00.000Z \
  --expires-at 2026-08-15T08:00:00.000Z \
  --mount-output /var/tmp/hepta-golden/control/dataset-mounts.json
```

After reviewing the returned plan ID, repeat the exact command with:

```text
--action execute --execute --plan-id sha256:...
```

Execution rereads every input and requires the exact current plan ID. It
derives the public key from the private key and compares it with the public
trust record before signing. It then installs the content-addressed private
envelope, the public-only runtime trust store, the mount array, and a separate
provisioning receipt. Publications are durable, atomic per file, no-clobber and
idempotent only when existing bytes are identical.

The mount array can be passed to local autonomous research with
`--dataset-mount-file`. Success remains local-model/runtime evidence; it does
not establish external replay, independent reviewer identity, dataset-owner
acceptance, scientific validity, production readiness, or submission
readiness.
