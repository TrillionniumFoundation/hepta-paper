# runtime-images

Status: normative module guide

## Purpose

`runtime-images` defines reproducible scientific execution environments for Python CPU, Python GPU, and R workloads. It supplies immutable runtime inputs to worker adapters; it does not decide whether a result is scientifically or operationally promotable.

## Responsibilities

- `python-scientific/`: pinned CPU scientific environment, lockfile, and dataset-access supervisor;
- `python-gpu/`: pinned GPU scientific environment and runtime controls;
- `r-scientific/`: pinned R environment and a separately pinned source-CAS submodule.

Each image definition records digest-pinned frontend/base identities, dependency locks, non-root/runtime permissions, dataset mount behavior, and the files needed by the source supply-chain gate.

## Dependencies

Dockerfiles use digest-pinned bases and locked package inputs. Runtime definitions may not depend on mutable tags, network-fetched unverified scripts, developer home directories, or repository runtime state. The R source CAS is referenced by exact submodule commit over HTTPS.

## Contracts

A runtime identity includes the Dockerfile and locked inputs, resolved image digest, architecture, entrypoint/supervisor bytes, user, working directory, environment allowlist, mounts, network policy, and supported resource controls. Worker receipts bind the exact resolved digest, never only a tag.

## Failure and recovery

Build, pull, digest, dependency, architecture, permission, supervisor, dataset mount, or sandbox failures block execution. A cached image is accepted only after identity inspection. Recovery may load an approved offline image bundle and revalidate its digest; it may not relabel an arbitrary local image.

## Security

Images run with least privilege, bounded mounts, no implicit credentials, and network policy selected by the worker contract. Dataset supervisors prevent undeclared data access. Base and workflow identities are pinned, but digest identity is not a CVE assessment; deployment qualification separately evaluates vulnerability and host controls.

## Testing

CI verifies Dockerfile pinning and source policy. Operational tests build or load images, inspect digests, run minimal scientific workloads, test dataset denial, resource limits, artifact export, deterministic replay, and GPU prerequisites where available.

## Change rules

Changing a Dockerfile, lockfile, supervisor, source-CAS pointer, base digest, or runtime policy changes runtime identity. Update the owning domain configuration, manifests, SBOM where applicable, tests, and reproducibility documentation in the same review.
