# Native recovery configuration inspection

This module implements the separately callable recovery configuration diagnostic.
No Cargo dependency is added. Required
existing modules/dependencies are the V3 external qualification owner, ordered
production JSON/hash/canonical clock utilities, nix, serde_json,
hepta-legacy-compatibility, base64ct and ed25519-dalek.

The one public API is:

```rust
pub fn inspect_autonomous_research_supervisor_external_action_recovery_configuration_v1(
    config_path: Option<&Path>,
    environment: &BTreeMap<String, String>,
    cwd: &Path,
    now_millis: i64,
) -> serde_json::Value;
```

It consumes actual source files and returns the full original
`AutonomousResearchSupervisorExternalActionRecoveryConfigurationInspection`
projection. It does not accept a caller-ready report, caller trust record or
caller public key, and creates no authorization/verified object. It never calls
lookup/resume, qualifier/verifier, provider, signer challenge, SQLite or a shell.
No private signing key is parsed. The referenced V3 owner hashes its configured
credential-root files: this is not a claim that production invocation reads only
public data. Development/test fixtures must contain only owned nonsecret marker
files; no real credentials or private keys were inspected for preparation.

## Actual source and identity contract

Source reference:
`paper-adapters/automation/autonomous-research-supervisor-external-action-recovery-process-adapter.mjs:20–174`.

Explicit nonempty path overrides nonempty
`HEPTA_AUTONOMOUS_RESEARCH_EXTERNAL_ACTION_RECOVERY_CONFIG`; whitespace is not
trimmed. Relative input resolves against explicit absolute cwd. The actual
configuration must be a canonical no-symlink regular file owned by the current
real UID, nlink 1, mode with no group/other bits, 2–256 KiB. Every ancestor is
walked no-follow and retained using O_PATH. File bytes are read with a 256 KiB
plus detecting-byte bound, then re-read and metadata/namespace checked. Original
ancestor permissions are not invented as an extra all-0700 requirement (normal
`/tmp` ancestry remains permitted). Regular file mode may be 0400/0600/0700 as
allowed by the original bitmask.

The exact seven configuration keys, version 1, original kind, qualifier command
role, three action-kind hashes and object-or-array capability input are checked.
Original array capability config input remains a loaded-but-not-verified
observation; arrays fail the capability exact-key contract later. The nested
process path resolves relative to the recovery config directory. The actual V3
owning reader validates that file and every referenced source/key/credential
input. Its computed configuration identity must strictly equal the recorded
recovery config field; singleton-array hash syntax can pass the original regex
but still fails this strict binding, as in Node.

The recovery identity uses the original domain
`AutonomousResearchSupervisorExternalActionRecoveryConfigurationIdentity` over
actual process configuration hash, actual qualifier command hash, actual trust
hash, the recorded truthy capability receipt hash (or null), and the configured
three action hashes. That recorded capability hash is not verified merely
because it contributes to a configuration identity. Loaded-but-unverified
inspections preserve those recorded/derived fields and the original
`..._capability_not_verified` blocker. Source/config/binding errors instead return
the original null-field error projection. The report has no invented self-hash
field: the original reports configurationIdentityHash, not an inspection hash.

After evaluating, both owners recheck their original inputs. All regular
configuration/V3 descriptors drop before the public function returns. Call this
before any caller-owned business SQLite connection or database descriptor:
V3 argument resources may alias DB files, and closing another regular descriptor
can release process-scoped POSIX locks. Rechecking does not establish atomic
multi-file observation, exclude arbitrary concurrent writers, continuously
monitor environment, or prove future/current authorization.

## Recovery trust conflict remains explicit

The original capability contract is
`paper-domain/automation/autonomous-research-supervisor-external-action-recovery-contract.mjs:14–21,32–91,132–184`.
The private verifier evaluates the actual original predicates in order:

- exact 17 capability keys, version/kind/status;
- exact three action kinds and supported lookup/resume booleans/stable key ID;
- actual process/config/trust identity binding and action-hash shape;
- canonical issue/expiry, ordered time window and observation time;
- exact six-key signer, recovery-purpose role, `Ed25519` algorithm, positive
  integer keyVersion, ID/organization grammar;
- exact nine-key trusted signer, exact field identity and signer-issued-time
  trust validity window with null revocation;
- public-key representation, production payload/receipt hash and real Ed25519
  signature verification for the private verifier's stated string-PEM input.

Actual V3 loaded trust instead has a `status` field, role
`research_execution_release_attestor`, algorithm `ed25519` and **string**
keyVersion. It cannot pass the recovery trusted-signer contract. Moreover, the
actual Node V3 reader returns a crypto.KeyObject which its recovery adapter
passes as publicKeyPem; the recovery verifier requires a string. This implementation
represents that actual non-string source as `None` in the private string-PEM
input, with an explicit call-site comment. It deliberately does not use the V3
public PEM getter to silently change that boundary. The original predicate
short-circuits before signature verification for current V3 trust; no test may
claim the production configuration cryptographically verifies a capability from
this path. There is no public verifier accepting replacement trust or PEM.

This is not a blanket false response: missing/file/config errors, nested V3
validation, identity drift and invalid capability stages are really evaluated;
the original configuration hashes/complete blocked projection are derived from
actual inputs. The private signature stage is implemented (Node-style bounded
base64 decoding, both original domains, Ed25519) without minting recovery trust.
Positive recovery requires a separate versioned trust/configuration decision
with an independently designated recovery-purpose key. Do not fix it by
stripping status, relabeling roles, changing algorithm case or parsing the V3
key version into a number. No resolution verifier or recovery executor has been
ported in this slice.

## Explicit bounded differences

- Configuration must be actual UTF-8 with representable paired UTF-16 JSON keys
  and values, finite JSON numbers, and the existing production parser depth
  bound. Invalid UTF-8/unpaired surrogates/nonfinite numeric input returns
  `..._json_profile_unsupported`. Numeric spelling is normalized using the same
  ordered production parser as other native readers; 1.0 has Node's numeric
  meaning and final JSON spelling. No lossy projection is silently hashed.
- Path input is UTF-8, NUL-free, at most 4096 bytes/128 components, and cwd is
  absolute. Nonstring nested paths or out-of-profile paths produce explicit
  `..._path_profile_unsupported`; Node's raw TypeError text is not synthesized.
- Filesystem open/canonicalization/read failures use stable
  `..._configuration_file_unavailable` rather than OS-specific Node exception
  messages containing paths. Actual unsafe file/shape policy retains
  `..._configuration_invalid`. Retained drift uses
  `..._configuration_changed`. Nested V3 stable errors are preserved.
- All SHA syntax in this recovery contract is lowercase, unlike the separate
  resident/qualification hash grammar; JSON-data String(value||'') coercion
  accepts singleton/nested arrays for shape fields. Strict bound fields still
  require actual equality. Original action-object insertion order is retained
  for its final JSON.stringify comparison; ordinary sorted serde maps do not
  substitute for that test.
- Invalid `now_millis` outside ECMAScript Date range yields original
  `Invalid time value` only when execution reaches the original now.toISOString
  stage, preserving earlier capability false short-circuits.

## Verification and evidence boundary

`external_action_recovery_configuration_parity` compares the full diagnostic
against the actual original Node V3/recovery reader and capability verifier on
owned temporary files. The qualified Node process is bounded from fixture setup
onward. Tests cover path precedence, exact keys, original JSON truthiness and
hash coercion, nested credential/environment/argument drift, private file modes,
hardlinks/symlinks/FIFO, byte limits, clock short-circuit order and explicit native
error-profile differences. Source metadata and content are compared before and
after each native observation; fixture command markers remain absent.

Private unit tests exercise retained source/namespace drift and the actual
Ed25519 capability stage using owned synthetic key material. Node base64
transport accepts URL alphabet, ignored characters and the low byte of each
UTF-16 code unit, including non-ASCII padding aliases. Valid transport variations
still require the exact original receipt hash and a valid signature. The genuine
recovery-purpose key in a contract fixture is synthetic data and is never
substituted for actual V3 source trust in the public inspector. No fixture
constitutes independent external acceptance.

Run from `rust` with the qualified production Node runtime on PATH:

```sh
cargo test -p hepta-paper-service --test external_action_recovery_configuration_parity --locked
cargo test -p hepta-paper-service --lib external_action_recovery_configuration --locked
```
