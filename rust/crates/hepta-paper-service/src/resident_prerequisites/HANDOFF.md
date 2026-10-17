# Actual-source resident prerequisite inspection

This separately callable module observes the actual resident prerequisites.
It adds no dependency and exposes only typed source selection and diagnostics.

## API and scope

Module: `resident_prerequisites`. The public API is:

```rust
pub struct ResidentPrerequisiteInspectionOptions<'a> {
    pub runtime_root: &'a Path,
    pub repository_root: &'a Path,
    pub working_directory: &'a Path,
    pub environment: &'a BTreeMap<String, String>,
    pub external_qualification_config: Option<&'a Path>,
    pub external_action_recovery_config: Option<&'a Path>,
    pub now_millis: i64,
}
pub fn inspect_autonomous_research_resident_prerequisites_v1(
    options: &ResidentPrerequisiteInspectionOptions<'_>,
) -> Result<serde_json::Value>;
```

`Error::code()` exposes a stable diagnostic. No caller ready JSON, trust object,
public key, stored-state claim or accepted-runtime report is an input. Collector,
evaluator, configuration-readiness predicate and signature verifier are private.
There is no verified/activation/dispatch token and no recovery permission.

The returned value is the original
`AutonomousResearchResidentPrerequisiteReceipt` diagnostic. This does **not** port
the broader fully-autonomous system readiness evaluator or generic full research
qualification envelope. The narrower original resident path does not independently
verify campaign release authority, manuscript/prior-art scope, or the provider
execution represented by a signed receipt. Source/cryptographic checks and signed
claims must not be described as independent execution acceptance.

The [full native health composition](../SUPERVISOR_FULL_HEALTH_HANDOFF.md) now
consumes this actual producer for `--require-fully-autonomous`. The actual V3/recovery-purpose trust and public
KeyObject/PEM incompatibility remains, so a real configured recovery inspection
still contributes its actual blocker. No role, version, algorithm, status or key
representation is relabeled to manufacture recovery readiness.

## Original contract and actual native dependencies

Original source:
`paper-composition/automation/autonomous-research-resident-prerequisite-inspection.mjs:44–399`.
The full private configuration readiness predicate follows
`paper-composition/automation/autonomous-research-readiness-inspections.mjs:185–233,276–496`.

The collector invokes these actual-source native producers:

1. `external_qualification_configuration::inspect_external_research_qualification_process_configuration_v1`,
   then `read_external_research_qualification_process_configuration_v3` in original
   inspection/read order. The actual owner supplies identity and the active public
   signing PEM. It is rechecked, then explicitly dropped before proceeding.
   Drift between the first diagnostic and second capture cannot replace the
   diagnostic's bindings: configuration readiness also compares actual config,
   trust, cost and cost-authority identities.
2. `qualification_stored_evidence::read_full_research_qualification_receipt_pointer_v1`
   reads actual authority SQLite plus raw-byte mirror through its private effective
   WAL snapshot, validates actual plugin/source scope and original manifest key
   order, and closes all observations before return.
3. Conditional `read_autonomous_external_qualification_state_v1` reads the actual
   paper scope from the stored pointer, with no provisioning, lease or repair.
4. `runtime_image_reproducibility::runtime_image_reproducibility_report_v2` is
   called with a fixed **status** action. The recently landed private publication
   reader provides effective-WAL observation; request/verify/publish/online paths
   are not selectable. Runtime config and receipt paths from the supplied
   environment are resolved against explicit cwd before invocation, because the
   existing producer otherwise uses process cwd. The environment itself is not
   rewritten (it participates in real command identities).
5. `operational_status::current_operational_code_provenance_v1` observes actual
   Git/byte-level code identity, with the explicit profile guard below.
6. `external_action_recovery_configuration::inspect_autonomous_research_supervisor_external_action_recovery_configuration_v1`
   observes actual recovery/V3 source and returns its completed diagnostic.

No source writer, qualifier/verifier, lookup/resume, provider canary, release
signer challenge or SQLite provisioning is invoked. Existing code provenance
does execute read-only Git subprocesses; this implementation does not add a global
deadline to that inherited implementation or claim all underlying IO has a fixed
wall-clock bound. V3 command and credential resource observation hashes real
files; it is not a public-data-only scanner. Preparation and tests must use owned
nonsecret credential markers, never real credentials or private signing files.

All regular V3 owners drop before **any** SQLite callback in the composition.
Pointer and state callbacks close their private connections before returning;
runtime status and code stages also complete before recovery source observation.
No file/SQLite owner is retained in the final report. Call this API before
acquiring caller-owned business SQLite connections or database descriptors:
source paths and arbitrary V3 argument resources can alias a DB, and closing
another regular descriptor can release process-scoped POSIX locks. Sequential
rechecking is not an atomic multi-file/database snapshot, continuing validity,
revocation monitoring or exclusion of noncooperating writers.

## Checks and output compatibility

`inspection.rs` actually checks the original configuration-readiness predicate:
exact eleven-field public signer entries, ICU strict tuple ordering and uniqueness,
one active unrevoked key, real hash grammar and source String coercions, safe
numeric credential UIDs, cost-authority bounds, independent command/credential/
principal/key/organization identities, canonical trust windows, all required
flags, the inspection own hash, both command inspection hashes, active-key
projection, trust hash, configuration hash and both service identity hashes.
An owner-generated `ready:true` is not sufficient on its own. No new live key
expiry gate is inserted into this configuration predicate; current signer time
validation belongs to the resident receipt check.

The stored pointer already validates actual raw manifest `Object.keys` ordering,
profile list, current plugin scope and complete own hash. Resident consumes only
that actual producer. It does not reject a valid source after serde sorts object
keys. It adds the original version/kind/status/externalActionPerformed checks,
state hash and positive safe generation. There is no arbitrary exact-key
restriction on the full qualification receipt.

Resident compares state/pointer generation and hashes, campaign/paper/release,
the stored receipt hash, recovery verified status and four actual service/config
identities. It reconstructs the six-field
`AutonomousExternalQualificationRecoveryConfigurationIdentity`, including cost
and cost authority. It validates canonical issue/expiry, maximum age 86,400,000
ms, inclusive issue/exclusive expiry, all nine code identity fields, and **only
the actual active signer**, with signedAt and now both in its trusted window.

Ed25519 signs UTF-8 bytes of the textual production hash in domain
`FullResearchQualificationSigningPayload`. Only `signature` and
`fullResearchQualificationReceiptHash` are removed: all additional receipt fields
remain signed. The public key comes only from the actual V3 owner. Base64 transport
uses Node's permissive alphabet, ignored bytes, padding stop and low bytes of each
UTF-16 code unit, including both surrogate code units of supplementary scalars.
The resulting signature must be exactly 64 bytes and pass Ed25519 verification.
This verifier is independent from the recovery-purpose contract; trust is never
shared across their roles.

Input errors precede derived blockers within their original infrastructure/global
categories. Duplicates are removed in insertion order, not lexically sorted.
Infrastructure blockers precede global qualification blockers in the combined
list. Modes are `blocked`, `bootstrap-only` and `full` using the original gates.

Both production-domain hashes are derived with original fields:

- `AutonomousResearchResidentPrerequisiteIdentity`: exactly nine infrastructure
  identity fields; does not include renewable receipt hashes, expiry, inspectedAt
  or blocker lists.
- `AutonomousResearchResidentPrerequisiteReceipt`: complete diagnostic payload,
  including time, expiry, blockers and the prerequisite identity hash.

Actual source-valid reports are intended to match original projection/order/hash.
Inherited V3, pointer/state and runtime-reader bounds, supported JSON/path profiles
and stable native error codes remain in effect. A source reader's error is not
turned into proof of absence, authority or successful qualification.

## Explicit native profile refusals

- Empty runtime root: original
  `autonomous_research_resident_prerequisite_runtime_root_required`.
- `now_millis` outside ECMAScript TimeClip (absolute value greater than
  8,640,000,000,000,000):
  `autonomous_research_resident_clock_profile_unsupported` before source IO.
  This first profile does not emulate invalid-Date's detailed blocked report;
  it never substitutes current wall-clock time.
- Nonempty `HEPTA_RELEASE_COMMIT` in either supplied or actual process environment:
  `autonomous_research_resident_release_commit_profile_unsupported`. The reused
  operational code producer intentionally ignores that override, whereas original
  resident provenance can honor it at the canonical workspace. Reject rather than
  claim equivalence or mutate process environment.
- Supplied versus actual ambient `HEPTA_RELEASE_ENV_LAUNCHER`,
  `HEPTA_EVIDENCE_ENVIRONMENT` or `HEPTA_EVIDENCE_CLASS` must agree (empty and absent
  are equivalent); non-UTF-8 ambient values are unsupported. Mismatch returns
  `autonomous_research_resident_provenance_environment_profile_unsupported`.
  The guard runs before collection and after it. It is a bracketed check, not an
  atomic ambient-environment snapshot or ongoing monitor. No global env/cwd is
  mutated.
- Paths must fit the existing explicit UTF-8, NUL-free, 4096-byte/128-component
  profile and cwd must be absolute; otherwise
  `autonomous_research_resident_path_profile_unsupported`. A truthy nonstring
  stored paper ID receives a global
  `autonomous_research_resident_paper_id_profile_unsupported` blocker instead of
  emulating original raw `path.join` TypeError text or coercing another DB scope.
- Production JSON/hash/collation failures return
  `autonomous_research_resident_json_profile_unsupported`; no empty/default hash
  is substituted.

## Focused verification

Five private unit groups cover genuine ephemeral signatures and extra
signed fields, UTF-16 signature transport, active-only scalar signer identity and
both time windows, canonical 24-hour lifetime and cost-inclusive state binding,
stable blocker ordering/identity versus diagnostic hash, and early clock/release
profile refusals. The signature keys exist only in memory. Pure private state and
report fixtures are explicitly contract tests; they are not original repositories,
actual-source proof, external qualification execution or independent acceptance.

The actual Node differential suite exercises the public producer separately using
real V3 configuration files, genuine synthetic active/retiring signatures, original
state builder/CAS and pointer publisher, actual code observation and original
resident inspection. Runtime/recovery blockers must remain honest where those
independent prerequisites are absent. In particular, a valid qualification
signature alone does not make overall resident prerequisites ready.

Run from `rust` with the qualified production Node runtime on PATH:

```sh
cargo test -p hepta-paper-service --lib resident_prerequisites --locked
cargo test -p hepta-paper-service --test resident_prerequisites_parity --locked
```

The eleven differential integration groups also check a second actual monotonic
signed publication, preservation of the nine-field infrastructure identity,
source metadata/content around native observation, blocked input error order and
explicit native profile refusals. The fixture Node child is bounded from setup
onward. Its code provenance observes the actual working tree, including retained
local drafts; those dynamic code identities are test bindings, not independently
accepted release provenance. Runtime-image and recovery authority remain absent
or blocked in these fixtures. No source fixture command marker is executed.
