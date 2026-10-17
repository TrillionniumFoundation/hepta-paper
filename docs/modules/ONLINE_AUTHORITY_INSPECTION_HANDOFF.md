# Online authority evidence inspection

## Scope and original behavior

This library slice ports `paper-adapters/automation/autonomous-research-online-mutation-passive-inspection.mjs`. It verifies the actual signatures behind active and cached authority evidence and produces the original normalized diagnostic report. It does not construct an activated coordinator, recoverability epoch, mutation permit, or production qualification.

The passive path uses the real bounded cache reader. It does not invoke an authority process or refresh an expired cache. The active path requires `VerifiedActiveAuthorityEvidenceV1` from the actual three-call authority protocol. It does not accept an arbitrary active-refresh JSON object as that proof.

## Inputs, trust, and ownership

Both paths require a pinned mutation authority, `ObservedStateDatabaseInventoryV1`, `VerifiedWriterStaticCoverageV1`, the writer manifest, and a clock. `OnlineAuthorityInspectionInputV1` groups the active path's inputs. `VerifiedOnlineAuthorityInspectionV1` has private fields, a report accessor, and an `assert_current` operation; it has no deserializer or caller-supplied success constructor.

The `coordinator`/`coordinator_status` input is a **diagnostic claim** used to preserve the report contract. Even when this claim makes the report say `ready`, it does not authenticate a configured coordinator or grant any action. Future runtime activation must independently own and validate the real coordinator and its concrete recoverability controller. Neither this report nor this retained signature-evidence type is a substitute for that construction.

## Verification chain

The verifier checks current live inventory and source files; complete inventory/manifest identity; pinned configuration, writer hash and database scope; current-head, challenge and writer-scope signatures; expected per-database identity/schema bindings; common authority/key/global head; static AST receipt, code provenance, operation IDs/count, and required/covered roles. It then checks inventory and source currentness again.

Current-head and active-challenge per-database head arrays must agree under the same canonical JSON number semantics as the signed hashes. The original only compares the global head at this boundary. A validly re-signed contradictory per-database challenge is therefore an explicit native rejection, not a signature-failure fixture disguised as an equivocation test.

Real signed integral-number spellings (for example `17.0`) are compared under JavaScript Number semantics in active challenge/scope/current-head evidence. Active refresh serializes the normalized receipt without changing its canonical signed payload. A real signed differential regression exercises this against Node; it does not accept numeric strings.

The retained proof binds configuration hash, exact inventory hash, AST inspection hash, manifest, checked signed evidence and initial clock observation. Passive proofs also bind the cache hash. Reuse reopens the actual cache and repeats all signature/currentness checks; changed cached bytes cannot silently replace an earlier observation. Final clock sampling rejects expiry during file/source verification, clock rollback, and observation age beyond the pinned maximum. Observation age is inclusive at its maximum while expiry is exclusive. A dedicated real-signature test uses a 1000 ms observation limit with a 60000 ms expiry, accepts exactly 1000 ms and rejects crossing to 1001 ms only at the final sample.

## Storage and failures

Storage safety and limits come from the evidence-cache, observed-inventory, static-source and pinned-authority implementations. Cache JSON remains untrusted until its embedded signatures pass. Verification does not write the runtime or invoke external transport. Failures return the existing typed coordinator error with specific scope, signature, binding, currentness or expiry codes.

These are observed file-currentness boundaries; they do not exclude arbitrary future same-user modifications after a completed check. A passive receipt says nothing about a newer head that has not been observed externally. Live action fencing remains the responsibility of the actual coordinator and recoverability controller.

## Tests and integration

The tests use ten actual SQLite files, a real native JavaScript AST/scope scan, independently pinned synthetic Ed25519 keys and actual signed authority replies. Original Node 22.23.1 active and passive full reports are compared for absent, configured and ready diagnostic coordinator status. Tests count transport calls, reject forged signatures despite valid cache hashes, check expiry/rollback and changed caches, and exercise a genuinely re-signed contradictory database head. The tests do not use production credentials.

Integration requires the concrete runtime activation constructor, complete original command composition and independent acceptance. This handoff and local differential tests do not close the project-wide Node retirement gate.
