# Direct socket backup authority

This profile constructs an in-process backup verifier and transport. It does
not identify a qualified Rust installation, establish a service-manager unit,
stop the old authority, migrate its journal, activate a business writer, or
retire Node. The existing backup CLI and owning activation still use their
process configuration profiles.

## Configuration and construction

`PinnedStateBackupAuthorityV1<LocalStateAuthoritySocketTransportV1>::load_socket_v1`
takes the configuration path and an independently supplied raw file SHA-256.
The constructor accepts a closed `AutonomousResearchStateBackupAuthoritySocketConfiguration`
version 1 document. Its fields are:

| Fields | Meaning |
|---|---|
| `version`, `kind` | This socket profile's version and exact kind |
| `authorityId`, `keyId` | Expected signing authority and key identities |
| `socketPath` | Actual Unix endpoint used by the constructor |
| `timeoutMs`, `maximumMessageBytes` | Bounded protocol exchange limits |
| `publicKeyPath`, `publicKeySha256` | Independently pinned backup public-key document |
| `maximumReservationLeaseMs`, `maximumHeadObservationAgeMs` | Receipt lease and observation limits |
| `onlineMutationAuthorityConfigurationPath`, `onlineMutationAuthorityConfigurationSha256` | Independently pinned online verifier configuration for scope and complete history verification |

There are thirteen required fields. Process command fields are not optional
socket settings: `commandPath`, `commandSha256` and `fixedArguments` are rejected.
Timeout is 1,000–120,000 ms; the message limit is 1,024–268,435,456 bytes. Both
receipt limits are 1,000–900,000 ms and must match the corresponding online
limits. Numeric fields must be safe integral values. The constructor's
configuration path and the three path fields above are absolute UTF-8 spellings
without empty, `.` or `..` components, trailing slashes or NUL; `/` alone is not a file or endpoint. Regular-file snapshots also
reject symlinks, hardlinks and unsafe file ownership or write permissions.
The existing Process Configuration V1/V2 parser, `load` and `load_process` keep
their required command snapshots and original configuration hash domain. A new
socket configuration uses its own hash domain, so a verified reservation from
a different configuration cannot authorize finalization under this one.

The socket constructor creates its own concrete transport from the verified
configuration. It accepts no separate transport or options that could select a
different endpoint. All configuration and public-key files are captured before
the empty socket probe. No private key is read and no command is executed.

## Pinned identity and request scope

Backup and online authority IDs, key IDs, actual Ed25519 public-key bytes,
maximum reservation lease and maximum observation age must agree. The two
public documents use different kinds; equality of their raw document hashes
would be an incorrect key comparison. Scope, database scope and writer manifest
come from the loaded online verifier.

Every socket-profile operation checks its request before dispatch, including
the operation kind, closed shape, database scope and any requested lease. Journal
requests also bind the online authority/key, scope and writer manifest. The same
profile checks apply to public pure receipt verification methods, so providing a
valid signature directly cannot bypass the configured scope.

Currentness retains the configuration, backup public document, online
configuration and the online verifier's actual public-key snapshot. Replacement
or mutation invalidates the observation. Existing signature, request-hash,
timing, opaque reservation and complete finalized journal checks still apply;
a signed journal envelope alone is not a verified causal history.

## Peer lifetime and uncertain outcomes

The concrete transport uses the existing kernel peer credentials and retained
peer pidfd described by the [client transport](../../local_state_authority_client/HANDOFF.md).
It requires the same living socket origin for each exchange, performs no
subprocess invocation and never silently adopts a replacement daemon.

Transport errors retain their actual request-byte and unknown-outcome details.
If an exchange returned a response but receipt verification or a retained pin
then fails, the RPC result is still uncertain: a rejected response cannot prove
that the authority did not commit. That failure requires inspection and cannot
be automatically retried. Pure verification methods perform no RPC and do not
claim one occurred.

All regular-file scopes must be acquired before an owning SQLite transaction
and kept until its connections are closed. Currentness checks use retained
descriptors and namespace metadata; opening and closing a new alias of a live
database can release process-wide SQLite locks. The direct transport itself
does not acquire database handles or confer a transaction permit.

## Integration boundary

The generic backup recovery service can consume the verifier; it already checks
the embedded online configuration against its online verifier. The concrete
production fence, native transaction binding and owning preparation still need
a versioned socket composition and one shared verified authority origin.
Separately constructed transports with matching JSON are not evidence of one
installed invocation.

The [installation design](../../online_mutation_composition/activation/AUTHORITY_INSTALLATION_DESIGN.md)
requires the complete additional daemon role to be part of the independently
signed topology, plus actual manager association. Socket continuity can also
hold for a Node process using the configured key; it does not prove Rust
provenance. The [journal maintenance owner](../../local_state_authority/migration/MAINTENANCE_OWNER_DESIGN.md)
remains necessary before live migration.

## Verification

`tests/state_backup_socket_authority.rs` exercises the actual Rust daemon with
a supplied fixture signing key: schema initialization, signed backup
reserve/finalize/head, one actual finalized authority mutation and a nonempty
journal verified through the existing causal-chain verifier. The fixture's
business fields are protocol inputs; this test does not perform a business
database backup, changeset replay or production qualification.

The same target checks Process V1/V2 and Socket V1 mutual rejection, malformed
or mismatched pins/keys/limits before even the empty probe, RPC scope and lease
refusal before request bytes, and cross-configuration opaque reservations.
Two real daemons using the same key and IDs but different database scopes
produce valid signatures to test all four pure verifier scope checks. A real
authority runtime also commits a backup reservation and drops the response;
after all its SQLite handles close, the test observes the one committed row
while the client preserves an unknown result without retry.

`socket/tests.rs` checks numeric/path bounds, all four retained file identities,
post-response pin drift, and twelve main/SHM alias combinations under real
DELETE/WAL transactions. Independent processes remain blocked until rollback;
the original snapshots remain owned until SQLite closes. Existing
`state_backup_authority_parity` and `local_state_authority_socket_transport`
targets continue to cover the original Node process contracts and kernel
origin lifetime, listener replacement, forged signatures and transport limits.
