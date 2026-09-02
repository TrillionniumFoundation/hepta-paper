# workflow-kernel

Status: normative module guide

## Purpose

`workflow-kernel` provides small domain-neutral primitives shared by the active layers. It owns deterministic record identity, exact-object checks, immutable JSON values, neutral runtime helpers, and implementation-manifest utilities. It does not know about papers, venues, claims, campaigns, submissions, adapters, or authority policy.

## Responsibilities

- canonical treatment of supported JSON-like values;
- exact key-set validation helpers;
- deterministic record hashing and identity primitives;
- neutral time/process/file runtime protocols under `runtime/`;
- benchmark-harness implementation identity where a cross-domain neutral value is required.

The kernel remains intentionally small. A utility belongs here only when its meaning is unchanged outside hepta-paper.

## Dependencies

Kernel code may use the Node.js standard library and explicitly reviewed neutral dependencies. It may not import `paper-domain`, `paper-ports`, `paper-application`, `paper-adapters`, `paper-composition`, `paper-core`, migration, or reference-package code.

Higher layers may depend on the kernel. The kernel never locates higher layers dynamically or reads composition configuration.

## Contracts

Hashing functions define their accepted value domain, canonical representation, algorithm, prefix/domain separation, and error behavior. Exact-object helpers reject absent required keys and unexpected keys when the caller requests an exact schema. Freeze helpers recursively protect supported value graphs and reject unsupported cyclic or host objects rather than implying deep immutability.

Runtime helpers expose values or narrow capabilities, not global mutable singletons. Platform-dependent behavior is surfaced in the result or fails closed.

## Failure and recovery

Kernel validation errors are deterministic and not retryable. The kernel does not own retries, persistence, leases, or workflow recovery. Callers must not catch a kernel identity failure and substitute a random or non-canonical value.

## Security

Identity-sensitive operations use approved cryptographic hashes and byte-exact encodings. Weak hashes, ambient secrets, shell evaluation, symlink-following policy, and network access do not belong here. A hash proves equality of encoded bytes, not trust, authority, or scientific truth.

## Testing

Tests cover canonicalization, key-order independence where promised, type rejection, collision-domain separation, immutability, platform boundaries, and deterministic replay. Architecture tests keep the kernel free of higher-layer imports.

## Change rules

Changing canonical bytes or hash semantics is a breaking schema change. It requires versioned consumers, migration analysis, updated receipts and fixtures, compatibility tests, and documentation. Do not add paper-specific convenience functions; place them in the owning domain module.
