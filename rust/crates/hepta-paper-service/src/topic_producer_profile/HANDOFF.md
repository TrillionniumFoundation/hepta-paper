# Native topic-producer profile prerequisite

This module implements the separately callable actual-source profile loader. It
does **not** implement topic generation, provider canaries, producer status,
generation/admission V2, genesis/rotation authority, or enable intake V2 health.
An observed profile or its record hashes are diagnostic data, not an authority
grant, installed Rust identity, or independent production acceptance.

## Integration

The service crate exports `topic_producer_profile`. It reuses the existing intake contract through crate-private visibility only; no intake verification behavior or public arbitrary-report authority API is changed. The module remains separate from the V2 health consumer until its status/admission/authority dependencies are implemented.

The stable typed interface is:

```rust
pub struct TopicProducerProfileReadOptionsV1<'a> {
    pub profile_path: Option<&'a Path>,
    pub dataset_root: Option<&'a Path>,
    pub repository_root: &'a Path,
    pub working_directory: &'a Path,
    pub environment: &'a BTreeMap<String, String>,
    pub expected_profile_hash: Option<&'a str>,
    pub expected_provider_configuration_hash: Option<&'a str>,
}

pub fn read_autonomous_research_topic_producer_profile_v1(
    options: &TopicProducerProfileReadOptionsV1<'_>,
) -> Result<ObservedTopicProducerProfileV1, TopicProducerProfileError>;
```

The opaque owner exposes `identity() -> &Value` for the original four-field
loader projection and `assert_current() -> Result<()>` for explicit reobservation.
Errors implement `std::error::Error` and expose a stable `code() -> &str`.
No caller can construct an observed owner from JSON. It contains the real source
file and directory descriptors from this read. To compose with later status,
assert it current, clone only its plain diagnostic projection, and **drop the
owner before opening any caller-owned business SQLite connection or regular
database FD**. A configured profile or dataset path could alias a database;
closing its ordinary FD can affect POSIX process-scoped SQLite locks.

## Source contracts

The actual incumbent entry is
`paper-adapters/automation/autonomous-research-topic-producer-profile-loader.mjs`.
Selection preserves explicit truthy profile path before
`HEPTA_AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_PROFILE`; an empty explicit path falls
back, while a whitespace filename remains meaningful. Relative profile paths
resolve against the explicit absolute working directory. Explicit dataset root
similarly precedes `HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT`, but it must already
be absolute before lexical normalization, as in the original. Empty expected
hash strings are ignored; nonempty expected values use strict string equality.
The explicit environment is captured input, not a live ambient environment
subscription. Changes require construction of a new owner.

`contract.rs` checks the original exact 15 producer keys and 12 registered
profile keys, numeric constraints, safe IDs, interval/day limits, capability
window bounds, unique IDs/topics, replication policy and every rebuilt hash.
It privately constructs the same production-run probe used by the original
registered-profile builder, recomputes its actual production hash and uses the
existing native builtin intake verifier for canonical objective, ordinary mount,
budget, referee/revision, and provider-placeholder contracts. This cannot bypass
that verifier with a caller-ready object. The producer's full equality domain
compares the input to its rebuilt profile, including the independently computed
builtin policy hash. All five current builtin empirical families and the exact
original allowed-capability order are represented. Production-run profiles do
not invoke the separate recurring-golden resource-closure algorithm; this
loader does not invent that additional original gate.

Producer-level implementation/provider digest shape preserves original
`String([hash])` coercion where it can affect data equality. Original exact
implementation comparison still refuses a nonstring implementation digest.
The ordinary mount verifier has a narrower string-hash profile described below.
Production JSON normalization is applied to the final projection, including
`1e0`/`1.0` to `1` and negative zero to zero, without changing any hash domain.

The fixed implementation leaf is
`repository_root/paper-adapters/automation/autonomous-research-topic-producer-implementation.mjs`.
Its bytes are actually read and hashed; the profile's claim is compared to that
observed digest. This binds the selected repository's original JS source only.
The repository root is an explicit diagnostic input, not authenticated install
selection. The returned implementation ID is the incumbent scheduler's ID;
it does not assert that Rust executes this implementation or that its source,
installation, provider, or policy origin has been independently qualified.

## Dataset manifest and retained sources

Every source must be a real regular file or directory strictly below the
normalized real dataset root. The complete path is walked with retained
descriptor-relative `O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC` directory owners.
Files open with `O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC`. Profile files require
the original 2-byte through 1-MiB size and no group/other write bits. Dataset
regular files must have one link, matching the original scoped file reader.
Dataset mode/UID restrictions are not invented: actual readable objects may
have other owners/modes, which remain recorded and rechecked. Profile hardlinks
are not confused with the dataset reader's separate hardlink prohibition.

File mounts hash actual content with SHA-256. Directory mounts use a bounded
complete child listing before recursion: lexical order supplies the original
Linux scandir tie order, then stable production ICU `localeCompare` sorting
chooses depth-first traversal. Each file adds precisely
`relative_path + NUL + lowercase_file_digest`; LF joins records with **no final
LF**. Actual LF characters in supported filenames remain part of those bytes.
Empty directories add no digest record but are retained, so addition/removal
invalidates a retained owner even when the original content hash stays equal.
The complete original dataset-snapshot payload/hash and mount order are returned.

Rechecks compare held and named device/inode, mode, UID/GID, link count, size,
mtime/nanoseconds and ctime/nanoseconds for files, plus full bounded rereads of
their contents. All ancestor directory identities are retained. Enumerated
dataset directories additionally recheck their full metadata and child lists;
unrelated siblings of an unenumerated ancestor do not invalidate a read.
Directory listings are rechecked before and after file rereads. This is a
completed, bracketed observation, not a simultaneous cross-file snapshot or
ongoing prevention of noncooperating changes.

## Explicit native limits

- Configured empirical plugin bundle/trust environment overrides return
  `autonomous_research_topic_producer_plugin_registry_unsupported`. The five
  compiled builtin family contracts are not broadened to an external registry.
- Local-golden authority scopes remain
  `..._local_golden_dataset_scope_unsupported`; no authority is inferred from
  unsigned local fields.
- Hash-shaped nonstring arrays in ordinary mount hash fields return
  `..._dataset_mount_transport_unsupported`, preserving the existing intake
  verifier's bounded string profile. Ordinary invalid null/nonhash values stay
  invalid contracts. Original optional fields can retain a `String([hash])`
  transport; actual manifest hash equality is still stricter for the main hash.
- Backslashes in dataset source paths or enumerated names, and non-UTF8 names,
  return `..._dataset_relative_name_unsupported`. On POSIX the original replaces
  backslashes with slash **before reopening** a scoped file, potentially hashing
  a different existing in-root alias. Native explicitly refuses that profile;
  it never silently reads the replacement alias or claims equivalent behavior.
- All native source ancestors and implementation/profile leaves are no-follow.
  This is stricter than the original profile loader's leaf-only document check
  and implementation `readFileSync`. Unpaired UTF-16 JSON surrogate strings and
  nonfinite JSON number transports are outside the native JSON profile; raw
  non-UTF8 profile bytes return `..._profile_encoding_unsupported`.
- File/directory depth is bounded to 128 components, observed directory entries
  to 10,000, retained descriptors to 12,000, each dataset file to 256 MiB and the
  aggregate unique observed file lengths to 1 GiB. Implementation bytes are
  bounded to 1 MiB. These are native limits, not claims about an original total
  tree byte limit. Aggregate lengths and sibling entry slots are reserved before
  reads/recursion; reads consume at most observed length plus one growth byte.
  Growth, replacement or drift fails rather than switching the observation to
  a new object. Native bound/depth refusals have explicit stable error codes.

## Verification

Ten actual original integration groups cover file and Unicode directory manifests across all five builtin families, complete loader projection/identity, profile selection and expected hashes, relative versus absolute paths, rehashed policy/profile limits and exact keys, numeric JSON spelling, 1-MiB boundaries, permissions/FIFO/symlinks, actual dataset drift/hardlinks, implementation-byte binding and retained namespace changes. Collation fixtures include composed/decomposed ties and LF filenames. Actual original positive fixtures demonstrate the backslash alias-read and array hash transports before requiring explicit native refusals. No provider, canary, authority double, or producer execution establishes a ready result.

Eight private groups use real owned filesystem objects: same-inode byte changes, leaf/parent replacement, no-follow behavior, FIFO/mode/hardlink refusal, actual bounded growing streams, directory-entry budgets, empty-directory/list changes and explicit pathname profiles. Source bytes and full identity/mutation metadata are compared around native observation; access times are excluded because reading can update them.

Run from `rust` with the qualified Node runtime on PATH:

```sh
cargo test -p hepta-paper-service --test topic_producer_profile_parity --locked
cargo test -p hepta-paper-service --lib topic_producer_profile --locked
```

The oracle imports the actual original builder, strict dataset manifest and loader. It does not import the existing topic-producer fixture that installs authority resolution hooks. Per-commit validation archives record executed outcomes, selected source hashes and any amendments; this specification alone is not a passing test receipt or production acceptance.

## Separately callable recorded generation contracts

The sibling [generation/capability module](../topic_producer_generation/HANDOFF.md) now reuses this module's builtin serialized contract through a crate-private pure entry. It reconstructs recorded generation data without claiming this loader's actual source observation. The sibling [canary journal parser](../topic_producer_canary/HANDOFF.md) supplies the remaining recorded row-accounting predicates. Actual producer SQLite status and V2 health composition remain open; the loader itself does not execute generation, canaries or mutations.
