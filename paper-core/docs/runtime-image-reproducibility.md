# Runtime image reproducibility production contract

Production readiness never trusts a Docker command executed by the controller, a Docker image ID,
or an unsigned record hash. The local two-build command is retained only as a root-filesystem
repeatability diagnostic. It cannot publish a receipt or satisfy full research qualification.

The canonical command is:

```text
hepta-paper operator runtime-image-reproducibility -- --action status|request|verify|publish
```

`status` is the default and is strictly read-only. `request` emits the current request without
calling an external service. `verify` invokes both configured verifier commands but does not write.
`publish` invokes and verifies both commands, then atomically commits the receipt to a monotonic
SQLite authority only when all production checks pass. The JSON receipt path is a derived,
crash-recoverable mirror rather than a second authority. A resident supervisor explicitly
reconciles a missing or drifted mirror from SQLite during its mutating startup/reconcile path;
`status` remains read-only and fails closed on mirror drift.

Configuration is supplied with `--config` or
`HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG`. It has this exact shape:

```json
{
  "version": 1,
  "kind": "RuntimeImageReproducibilityProcessConfiguration",
  "status": "active",
  "platform": "linux/amd64",
  "sourceDateEpoch": 1733097600,
  "buildArgs": {},
  "maximumReceiptAgeMs": 86400000,
  "maximumVerificationCostUsd": 5,
  "verificationCostAuthority": "operator_declared_worst_case_usd",
  "verifiers": [
    {
      "command": {
        "serviceId": "runtime-builder-a",
        "principalId": "runtime-builder-principal-a",
        "protocol": "runtime-image-reproducibility-json-stdio-v1",
        "executable": "/opt/hepta/bin/runtime-builder-a",
        "args": [],
        "credentialRoot": "/run/credentials/runtime-builder-a",
        "environmentAllowlist": [],
        "timeoutMs": 7200000,
        "backend": {
          "backendId": "buildkit-a",
          "workerId": "worker-a",
          "buildkitVersion": "v0.16.0",
          "platform": "linux/amd64",
          "endpointTlsSpkiHash": "sha256:<64 lowercase hex>",
          "stateRootIdentityHash": "sha256:<64 lowercase hex>"
        }
      },
      "attestor": {
        "keyId": "runtime-builder-key-a",
        "keyVersion": "version-1",
        "subjectId": "runtime-builder-attestor-a",
        "organization": "example-build-office-a",
        "role": "runtime_image_reproducibility_external_verifier",
        "algorithm": "ed25519",
        "status": "active",
        "effectiveFrom": "2026-07-01T00:00:00.000Z",
        "expiresAt": "2027-07-01T00:00:00.000Z",
        "revokedAt": null,
        "publicKeyPath": "/etc/hepta/trust/runtime-builder-a.pub.pem"
      }
    },
    {
      "command": "same exact command object shape with independent values",
      "attestor": "same exact attestor object shape with an independent Ed25519 key"
    }
  ]
}
```

The example abbreviates the second object for readability; deployed JSON must use the exact object
shapes. The two services, principals, executables, credential roots, Ed25519 SPKI identities,
canonicalized signer organizations, backend endpoints, workers, and state roots must all be
different. Credential roots are exclusively for private principal material: their regular-file
content SHA-256 sets must be disjoint even when a copied secret is renamed or accompanied by other
files. Shared public CA material must live outside these roots. Docker and BuildKit environment
variables are forbidden. Executable, interpreter, argument resources, restricted environment,
credential material, UID and filesystem identities are rechecked before every invocation.
`platform`, `sourceDateEpoch`, and `buildArgs` are repository policy, not operator choices: they must
be exactly `linux/amd64`, `1733097600`, and `{}`. Any configured drift fails before an external
process is invoked. Each verifier must pass the fixed epoch through BuildKit's predefined
`SOURCE_DATE_EPOCH` build argument and attest `sourceDateEpochAppliedToBuildkit: true`; it is not an
operator-supplied entry in `buildArgs`.
The request and every response also bind the exact OCI exporter tuple
`{type:"oci",rewriteTimestamp:true,provenance:false,sbom:false}`. Passing
`SOURCE_DATE_EPOCH` without the exporter timestamp rewrite is insufficient because layer tar
directory metadata otherwise retains build time. Every Dockerfile frontend reference must include
an immutable `@sha256:` digest; a mutable syntax tag or implicit builder default is rejected.
The exhaustive context manifest preserves every entry's path, type, mode, content hash or symlink
target. Separately, the request, each signed profile result, and the receipt bind the exact canonical
context-tar metadata policy: POSIX ustar entries are lexicographically ordered, uid/gid are zero,
uname/gname are empty, mtime equals `SOURCE_DATE_EPOCH`, xattrs are omitted, and device entries are
forbidden. A verifier must attest that it applied that exact policy; a missing field, false applied
flag, metadata drift, or fully rehashed and re-signed substitute fails closed.

`maximumVerificationCostUsd` is the configured worst-case cost of one complete two-builder
verification attempt and is included in the configuration identity. It must be positive with
`operator_declared_worst_case_usd`. Genuinely non-billed external builders must instead declare
exactly `0` with `externally_operated_zero_cost`; an omitted, negative, mismatched, or unknown cost
authority fails closed. The resident supervisor reserves this entire amount before refreshing.
The hash-bound configuration inspection also reports `maximumVerifierTimeoutMs` and the derived
`minimumRefreshLeadMs` (maximum timeout plus the 60-second protocol margin). Configurations whose
minimum refresh lead is not shorter than the receipt lifetime fail closed.

Each signed response binds the request hash and nonce, code and release identity, the exhaustive
canonical Docker context (file type, mode, content, and symlink target), fixed platform, build args,
`SOURCE_DATE_EPOCH`, registered image digest, backend identity, and the OCI index, manifest, config,
and ordered layer blob digests. Both independent responses must report the same complete OCI digest
sets. A fresh receipt is revalidated against current code, release, contexts, configuration, trust
set, image registry and source-content policy on every status/readiness query.

The registered image digest is the single-platform OCI `manifestDigest`; it is never interpreted
as the image config digest or Docker `.Id`. Local production preflight accepts only
`Descriptor.digest` with media type `application/vnd.oci.image.manifest.v1+json` and platform
`linux/amd64`. Receipt issuance must remain inside the request window and occur no more than 60
seconds after the latest external response completed.

All three registered profiles (`python`, `pythonGpu`, and `r`) are mandatory. The R profile vendors
the exact 104-package `renv.lock` source closure under `runtime-images/r-scientific/source-cas`.
Every archive is bound by URL, package, version, byte length, and SHA-256, and the restore layer runs
with network disabled. Production/full-automatic readiness still fails closed until two genuinely
independent configured backends produce a fresh, matching, signed OCI receipt; no local Docker
diagnostic or checked-in source manifest can substitute for that receipt.

For one-time host installation, the Python profiles use
`npm run automation:runtime-bootstrap:python -- --profile python --build` and
`npm run automation:runtime-bootstrap:python -- --profile pythonGpu --build`; the R profile uses
`npm run automation:runtime-bootstrap:r -- --build`. These commands create fixed `linux/amd64` OCI
outputs with cache disabled, BuildKit `SOURCE_DATE_EPOCH`, timestamp rewrite, provenance disabled,
and SBOM disabled. Externally delivered archives can instead be installed by replacing `--build`
with `--archive PATH` while retaining the fixed profile where applicable. Every path validates the
registered single-platform OCI manifest digest, raw manifest bytes, platform, and tag before
`docker load`, then repeats local manifest inspection. The commands expose no digest override,
remote-Docker option, runtime fallback, or authority to rotate a registered digest; a locally
repeatable but non-matching build therefore remains blocked.

A separately qualified Kubernetes runtime overlay may install the complete
fixed runtime set with:

```text
npm run automation:runtime-image-bundle-load -- --bundle-root /hepta/runtime-image-bundle
```

The absolute bundle root can be a separately provisioned immutable, read-only
PVC containing `python-scientific.oci.tar`, `python-gpu.oci.tar`, and
`r-scientific.oci.tar`. Every member must be a non-symlink, nlink-1 regular file.
The loader exposes no image, digest, platform, Docker executable, or endpoint
override. It rejects Docker contexts and every endpoint except
`unix:///var/run/docker.sock`. It copies every source archive into a private
stable snapshot, rejects source metadata drift during the copy, records each
snapshot content hash, prevalidates all three snapshot OCI indexes and raw
manifest bytes before the first daemon mutation, and loads those same snapshots
with bounded local commands. It accepts an image only when Docker reports the
registered OCI descriptor digest, OCI manifest media type, and `linux/amd64`
platform. A missing or mismatched profile exits nonzero.

The loader is a local installation mechanism, not an attestor. Its receipt says
only that the three already registered images were installed and inspected in
the pod-local daemon. It cannot create, renew, or replace the fresh matching
signatures from the two independent runtime builders required above. It also
does not qualify a Kubernetes RuntimeClass, daemon isolation, bind visibility,
UID mapping, network isolation, cgroup enforcement, or the parent Pod resource
ceiling. The canonical Kubernetes manifest is intentionally blocked and does
not invoke this loader; only an externally qualified site overlay may wire it
into a startup graph. Daemon mutation is sequential and explicitly non-atomic:
a later failure can leave earlier images loaded. The receipt records
`daemonMutationAtomic=false` and requires partial mutations to be confined to a
pod-local ephemeral daemon that is discarded after failed startup. It makes no
rollback claim and is not safe to point at a persistent or shared daemon.
