# Static production deployment V2

The V2 deployment producer adds the state-authority daemon to the complete
production topology. It observes bounded static installation inputs and computes
a separate deployment identity. It does not start services, connect to their
sockets, open state databases, read private keys or authorize a campaign writer.

## Version and API boundaries

`verify_production_deployment_v2` consumes a strict
`ProductionDeploymentManifestV2` and produces a non-deserializable
`VerifiedProductionDeploymentV2`. The V1 manifest, eight-role vocabulary,
digest and existing production consumers retain their original meanings.
Adding a daemon alongside an already verified V1 value cannot create V2 evidence.

The V2 identity uses the independent `HeptaProductionDeploymentV2` domain. It
binds the full manifest and the public authority facts actually derived from
the pinned files. PID, invocation ID, authorization signature and a future
native admission configuration are not stable deployment inputs. In particular,
the identity must not recursively include an authorization that signs it.

This opaque value records a completed static observation. A later owning
activation constructor must separately retain and recheck all installation
inputs before and during its own SQLite lifetime. Serialization of a diagnostic
manifest, report or digest cannot recreate the opaque value or its observation.

`RetainedProductionDeploymentV2::capture` now supplies the static resource
owner for that later integration. It runs the complete unchanged V2 validation
and retains the original public-file producers, executable descriptors, directory
descriptors and ancestor observations. `observation()` borrows the completed
value; `assert_current()` rechecks those same inputs without reopening regular
files, opening a socket or consulting a manager. The owner is neither cloneable
nor deserializable. Cloning its completed observation does not retain its
resources. The original `verify_production_deployment_v2` delegates to capture,
returns the same completed observation and drops the owner before returning.
V2 identity hashing and V1 behavior are unchanged.

Each private/IPC root is held with a Linux `O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC`
descriptor. Component-by-component `openat` refuses intermediate symlinks.
This retains the inode without reading or listing the final private directory
and avoids inode reuse while its identity is held. At most 128 private roots
plus the IPC root are retained. Revalidation compares held and named device,
inode, mode, UID and GID, while allowing ordinary child-count/mtime changes
inside mutable roots. Ancestor observations remain metadata observations.
These checks do not lock the namespace or form an atomic filesystem snapshot.

## Roles and principals

The closed role set contains control plane, author/reviewer/formal/repair Codex
brokers, evidence verifier, release broker, submission broker and state authority.
There are nine role types and 9–32 service instances, rather than
an assumption that every role has exactly one process. Control and authority are
unique. Different roles cannot share a declared UID. Each service binds its
systemd unit, executable, fixed arguments, environment names, primary and
supplementary groups and private writable roots.

The authority's primary GID is a dedicated IPC group. Control receives that
group as its primary or a supplementary group; the other seven role types cannot declare that
group as primary or supplementary. The existing shared `hepta-paper` group is
not sufficient to express exclusive control/authority access: other installed
roles can belong to it. V2 binds the declared group topology; actual account and
running-process membership still needs an independent installed-host observer.

## Public configuration and private state

Control must be able to inspect complete public configuration without acquiring
the daemon's signing key. The shared daemon syntax validator checks the original
closed configuration fields without I/O. Static deployment calls that validator,
not `LocalStateAuthorityRuntimeV1::open`, which would load the private key and
open the daemon state.

The authority installation binds the daemon configuration, online authority
configuration and backup Socket Configuration V1 by exact raw file hashes.
The backup profile also pins both public-key documents through the online and
backup readers. Their actual decoded Ed25519 keys, authority/key IDs, scope,
writer manifest and reservation/observation limits must agree. Comparing two
different public-document hashes is not a substitute for comparing their keys.
Daemon and backup configurations must select the same endpoint.
The socket must be a direct child of the declared IPC root; its basename comes
from the pinned configurations, and `UnixAddr::new` must accept its actual byte
length without opening a socket. The daemon has the fixed unit
`hepta-paper-state-authority.service`, binary basename
`hepta-paper-state-authority-daemon`, and exact two-argument vector
`--configuration <daemon-configuration-path>`. It admits no environment keys or
network use in this profile.

Each service admits at most 32 supplementary GIDs, 64 arguments, 128 environment
keys and 16 writable roots; all services together admit at most 128 private roots.
Supplementary GIDs must be distinct, nonzero and different from the primary GID.
Instances of the same role use the same declared UID and group set. Public-file
limits remain 1 MiB for the daemon configuration, 4 MiB for each online/backup
configuration and 64 KiB for each public-key document. Executables are limited
to 512 MiB and hashed through a fixed-size buffer.

An installable directory layout keeps distinct boundaries:

| Input | Ownership and purpose |
|---|---|
| Public daemon/online/backup configuration and public keys | `root:IPC`, mode `0440` or `0640`; their complete contents are not secret. |
| Public configuration ancestors | Root-owned directories with read/search access for that group, without group/other write access. |
| Daemon private state/key roots | Daemon UID and its primary GID, mode `0700`; remain private. |
| Signing key inside its private root | Loaded only by the daemon under its existing private-key ownership contract. |
| Separate IPC root and socket | Daemon UID and primary IPC GID, directory `0750` and declared socket `0660`. |

The control verifier checks private-root directory metadata and binds the
configured paths beneath those roots. It does not traverse the private root to
inspect the key or database. Their existence, key correspondence and exclusive
custody require the daemon/installation evidence. All private service roots keep
their original `0700` rule; permitting shared IPC does not relax that rule.
Key and database files may share a private root, but their paths must differ and
neither file can be an ancestor of the other file.

Public inputs and executables cannot be placed beneath service-writable roots.
The IPC root is a separate namespace, not a parent or descendant of a private
service root. Verification rejects symbolic links, component-path overlaps and
duplicate `(device, inode)` identities among all observed private roots and the
IPC root. These checks do not observe the complete mount topology or exclude
every possible bind-mount alias. Root permissions are verified as well.

## Actual observation and failure behavior

The producer validates manifest shape before filesystem observation. It checks
the actual bounded root-owned ELF bytes and their declared hashes and metadata,
the private-root metadata and the separate IPC namespace. Public files use
retained no-follow snapshots with strict JSON parsing and raw pins. Public
ancestor ownership and modes are also checked: a leaf file pin alone cannot
establish the directory authority.

Ancestors must be root-owned and mode `0555`, `0550`, `0755` or `0750`. Their
read/search bits must admit the declared service's primary or supplementary
groups; the public configuration and IPC paths must admit the dedicated IPC
group. An auditor's own root access cannot replace those checks. This observes
Unix mode/group metadata, not a complete mount, MAC or running-service profile.

The shared `ObservedSocketAuthorityInputsV1` performs the same actual public
configuration/key checks as the direct socket backup constructor, but sends no
connection probe. Only `load_socket_v1` adds that probe afterward. This keeps
static deployment independent of a running daemon and preserves the existing
backup constructor's fail-closed request and currentness contracts.

V2 excludes every declared service-private root and the IPC root before opening
public inputs. It first checks the three configuration paths and the daemon's
private-path containment. It retains pinned backup/online configuration snapshots,
checks the nested online reference against the manifest and excludes forbidden
namespaces from both public-key references before calling the shared loader.
That loader re-reads the same exact raw pins; changed configuration cannot supply
a new reference under the original pin. The two preflight snapshots remain
through final revalidation, adding at most 8 MiB of bounded raw configuration
buffers. This order also protects rejection paths; a final refusal alone would
not undo an earlier read of a configured private key or state file.

Previously captured public inputs are rechecked before the observation is
returned. Missing, changed, mismatched or inaccessible inputs return an error;
there is no optional partial deployment result or privileged-owner override.
Any future SQLite-owning integration must capture all relevant regular file
descriptors before opening SQLite and close every SQLite handle before releasing
them. Static deployment verification must not be called while owning database
locks as a substitute for that retained integration.

The retained API has the same ordering requirement on capture. A caller may
recheck the held owner without reopening regular files, but must close every
SQLite handle before dropping that owner on success and failure. This API does
not own a caller's SQLite handles and cannot enforce their drop order. A future
owning activation type must enforce it structurally; it is not yet wired.

## Qualification and activation integration still required

ELF magic, an expected filename and a matching hash establish a static byte
observation, not Rust compiler/source provenance or the executable currently
behind a socket. The manifest's service-manager, mount and legacy-scan digests
bind commitments; this producer does not inspect those inventories or prove
absence of unlisted processes. It does not establish peer pidfd/manager unit
association, actual supplemental group membership or no-proxy custody.

The complete V2 deployment identity must be bound by both the independently
verified host qualification's service identity and the independent cutover
subject's service identity. Existing signed containers can carry the new digest,
but native admission, signing preview and retained transaction consumers must
explicitly adopt the new version. The stable native configuration also needs its
own socket-installation domain; old process-configuration identity cannot be
silently reinterpreted.

See the [installation-owner design](../online_mutation_composition/activation/AUTHORITY_INSTALLATION_DESIGN.md)
for actual manager association and the
[authority maintenance design](../local_state_authority/migration/MAINTENANCE_OWNER_DESIGN.md)
for persistent shutdown/restart exclusion and migration. The current installed
Node service, existing credentials and live data are not changed by this API.

## Validation scope

Source tests must cover closed fields, complete roles, unique control/authority,
UID/group isolation, root overlap, public config/key/scope/lease disagreement,
changed retained files, V1 compatibility and the existing real socket constructor.
An internal public-input test may use temporary same-UID files to exercise actual
parsing and cryptography; it does not prove the complete root-owned deployment.
A complete positive installation test requires actual independently owned service
roots and public files on a suitable isolated host, without weakening production
ownership checks. External production qualification remains separate even after
such an installed test passes.

Additional actual-filesystem tests cover path-only close-on-exec descriptors on
an unreadable directory, leaf/intermediate symlinks and wrong file types,
ordinary child creation, root mode changes, real root replacement/deletion and
retention of the original inode. Lower input-owner tests replace each of the
five real public documents with byte-identical new inodes after capture returns;
the original descriptors remain held and revalidation refuses every replacement.
These lower tests do not manufacture a complete verified production deployment
or claim independently owned installation acceptance.
