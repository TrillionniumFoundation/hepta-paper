# Operational process entrypoints

Four restricted production entrypoints sit outside the general operator
command registry. Three implement machine protocols and one is the root-only,
plan-hash-confirmed release deployment boundary:

- `codex-openclaw-managed` is a Codex-compatible executable selected through
  `codexBinary`;
- `hepta-paper-state-authority-client` carries one authority request over the
  fixed local Unix socket;
- `hepta-paper-release-attestor-client` carries one bounded signer or probe
  request to an explicitly selected local Unix socket;
- `immutable-release-deploy` plans, executes, or recovers an immutable host
  release deployment under the exclusive deployment lock.

They are deliberately absent from the npm and `hepta-paper operator` command
registries. Routing a raw signing or mutation protocol as a general operator
command would widen its authority surface and could corrupt its stdout
protocol. Exposing privileged host deployment through the unprivileged
operator router would likewise erase its deliberate root-only boundary. Their
supported invocation surface is a pinned executable path in a reviewed process
configuration or deployment procedure.

The installed `hepta-package-recovery-readiness` executable is a different,
bounded boundary: it forwards only to the campaign recovery-readiness action
through a fixed Node/application path so full-production readiness can pin and
open an executable descriptor. It is not an authority provider. The stock
campaign composition remains unavailable until a separately qualified launcher
injects the complete recovery authority, deletion-lease and independent
readiness-verifier set.

## Installation

The release application tree must first be installed read-only at
`/opt/hepta-paper`. For immutable deployment this is a strict bridge
prerequisite: the already sealed predecessor must contain
`paper-core/bin/immutable-release-deploy.mjs` and its complete production
module closure. The host installer does not put application code into that
live trust boundary. It only snapshots the launcher/unit templates, verifies
that they did not change during installation, and installs these root-owned
launcher and recovery-gate paths:

```text
/usr/libexec/hepta-paper/codex-openclaw-managed
/usr/libexec/hepta-paper/hepta-paper-state-authority-client
/usr/libexec/hepta-paper/hepta-paper-release-attestor-client
/usr/libexec/hepta-paper/hepta-paper-release-env
/usr/libexec/hepta-paper/hepta-package-recovery-readiness
/usr/libexec/hepta-paper/hepta-immutable-release-deploy
/etc/systemd/system/hepta-immutable-release-recovery.service
```

Run the existing installer from the exact release tree:

```bash
sudo /opt/hepta-paper/paper-core/deploy/install-hepta-paper-systemd-host.sh
```

The default installation is a production hold. It enables and starts the
immutable-release recovery gate before the host bootstrap, state authority,
release-attestor pair, handoff-layout watcher and state-backup timer. It
explicitly disables and stops the autonomous
research supervisor, submission dispatcher, strict-acceptance service, and
strict-acceptance timer. It also keeps the pre-resident runtime-adoption unit
disabled and stopped. Installing reviewed units therefore cannot implicitly
adopt a runtime, start research, or start submission.

`--enable-full-auto` is parsed as an explicit high-risk request, but currently
fails before any target or systemd mutation with
`hepta_full_auto_enable_blocked:non_mutating_accepted_readiness_preflight_unavailable`.
The strict `plan` action is non-mutating but does not prove live acceptance;
the `status` action proves live readiness only by acquiring a persistent lease
and running bound verification processes. Neither is a safe installer
preflight. Keep activation as a separate reviewed operation until a repository
command can prove current accepted readiness without mutation.

The installer is deliberately not a configuration provisioner. Before it
creates an installation target, compiles a helper, writes a unit, reloads
systemd, or stops/restarts a service, it uses the candidate daemon parser to
preflight this exact pair:

```text
/etc/hepta-paper/release-attestor/signer-daemon.json
/etc/hepta-paper/release-attestor/probe-daemon.json
```

The preflight opens and cryptographically checks both Ed25519 keys, verifies
their dedicated-UID ownership and mode, applies the runtime schema, and binds
the signer/probe backend, socket, key id/version, and public-key hash. Failure
exits before host installation mutation and leaves the currently running
services and installed artifacts untouched. The installer never adds a
fallback policy or restarts a daemon with an unchecked configuration.

The installed launchers are mode `0755` and are included in
`/usr/share/hepta-paper/deploy/hepta-paper-systemd-host.manifest.sha256`.
The `.mjs` source files and launcher templates remain non-executable mode
`0644` in the source tree. Executability is therefore a deployment decision,
not an accidental Git worktree bit. Every launcher uses absolute system
executables and does not resolve Node or application code through ambient
`PATH` or `eval`. The protocol and readiness launchers select exact
`/opt/hepta-paper` entrypoints. The deployment launcher instead selects a
sealed live or intent-pinned predecessor executor as described below.

The launcher content hash does not replace release-graph verification. The
read-only `/opt/hepta-paper` tree, launcher manifest, exact release commit, and
tracked production graph must all be frozen and verified together. Any
launcher or application-tree drift invalidates the candidate.

The checked-in strict-acceptance example pins the stock package-recovery
wrapper's exact SHA-256. After installation, compare it against both the host
manifest and:

```bash
sha256sum /usr/libexec/hepta-paper/hepta-package-recovery-readiness
```

If a separately qualified recovery launcher is installed, do not reuse that
stock hash. Pin the qualified executable independently in both the
`package-recovery-readiness-command` reference and the final full-production
arguments, and preserve its root ownership, single link, executable/non-writable
mode, canonical real path, and trusted parent directories.

## Immutable release deployment boundary

The immutable release deployment transaction is available only through the
root-owned `/usr/libexec/hepta-paper/hepta-immutable-release-deploy` launcher;
it is intentionally not a general `hepta-paper operator` command. Its contract
fixes the exclusive deployment lock, immutable candidate/closure,
consumer-unit inventory, host snapshot, cutover/postverification sequence,
durable intent phases and exact rollback verification. The launcher discards
the ambient environment and invokes an exact sealed executor with the absolute
`/usr/bin/node` interpreter. With no durable intent it uses the verified live
release. When an intent exists it selects the intent-pinned predecessor release
from `/opt/hepta-paper-releases`; recovery never loads the partially installed
target executor.

From an authenticated root shell, generate a plan against the exact clean
candidate worktree and persist the complete JSON response outside that tree:

```bash
/usr/libexec/hepta-paper/hepta-immutable-release-deploy \
  plan --workspace /absolute/clean/candidate \
  > /root/immutable-release-deployment-plan.json
```

Review the complete plan, including the predecessor closure, deployment-lock
identity, configuration identity, installed artifacts, consumer-unit state and
target release path. The plan, inspection and host snapshot all bind the
recovery gate through `recoveryGateIdentityHash`; progress at and after
`install_completed` also binds the installed artifact set through
`installedArtifactIdentityHash`. Then pass the exact `plan.planHash` back as
an explicit confirmation; execution re-inspects the host and rejects drift
before making a deployment change:

```bash
/usr/libexec/hepta-paper/hepta-immutable-release-deploy \
  execute --workspace /absolute/clean/candidate \
  --plan-file /root/immutable-release-deployment-plan.json \
  --confirm-plan-hash sha256:REVIEWED_64_HEX_DIGEST
```

After an interrupted process, recover the durable deployment intent under the
same lock before creating another plan:

```bash
/usr/libexec/hepta-paper/hepta-immutable-release-deploy \
  recover
```

Unknown, duplicate, relative-path or command-inapplicable arguments fail
closed. None of these actions can perform provider submission, release-tag
mutation or other general operator work. Do not substitute manual shell
cutover steps for the transaction or its verified rollback path.

`hepta-immutable-release-recovery.service` runs that `recover` operation with
no candidate or workspace arguments as an unconditional root oneshot on every
boot and remains active after a clean no-op result. Every allowlisted release
consumer and activator has both
`Requires=` and `After=` on this gate; a failed recovery therefore prevents
resident processes, timers and paths from starting against an unresolved
deployment. The gate waits for the live release mount, release store, durable
intent root, local filesystems and the system tmpfiles pass. Its launcher
requires no candidate workspace.

The recovery unit and launcher are deployment-bootstrap TCB, not ordinary
mid-transaction artifacts. They must already be installed, root-owned,
single-link, non-symlink files with mode `0644` and `0755` respectively. During
a deployment, the host adapter invokes the installer only as:

```text
--root / --no-systemctl --preserve-deployment-bootstrap
```

That mode compares the installed unit and launcher with the snapshotted
candidate bytes before any destination mutation, then preserves them and
records the installed hashes in the host manifest. Missing, changed or
mis-moded bootstrap files place the candidate on HOLD; they cannot first be
introduced or replaced by a partially completed cutover. Establish or upgrade
this TCB separately with the reviewed ordinary installer before admitting a
candidate that expects the exact same bytes. That one-time bootstrap must also
install the recovery dependency on every currently present allowlisted
consumer and activator. Before planning a deployment, production preflight
checks each loaded unit's semantic systemd `Requires` and `After` sets and
places the candidate on HOLD if either recovery edge is missing. It also
requires canonical `/etc/systemd/system` fragments, forbids drop-ins and
rejects a manager that still needs `daemon-reload`. An allowlisted unit which
is explicitly permitted to be absent may remain absent; an installed legacy
unit may differ byte-for-byte from the candidate but may not be ungated.

Consequently, a host upgrading from a predecessor without this recovery graph
cannot use candidate code to bootstrap itself. An externally reviewed,
one-time sealed-predecessor migration must first place the executor and its
closure in live `/opt/hepta-paper` trust with the required root ownership,
read-only modes, mount identity and release provenance. Only then may the
ordinary reviewed host installer, invoked from that exact predecessor, install
the launcher, recovery unit and gated consumer-unit graph and confirm the gate
is enabled and active. A current host missing any of these bridge artifacts is
explicitly on HOLD; the immutable `plan`, `execute` and `recover` paths are not
a migration shortcut.

After the bridge, all present consumers and activators must expose both
dependencies before an immutable plan is admitted. Preserve mode skips only
the two byte-identical TCB files; it still installs candidate consumer units,
whose recovery edges are verified again with the rest of the host manifest.

For an offline installation test without systemd mutation:

```bash
paper-core/deploy/install-hepta-paper-systemd-host.sh \
  --root /absolute/staging-root --no-systemctl
```

That staging root must already contain a valid configuration pair and its
referenced test keys. The preflight runs before the installer creates `usr/` or
`etc/systemd/` below the staging root.
`--preserve-deployment-bootstrap` is intentionally rejected for staging roots
or systemctl-managed installs; it is reserved for the lock-held immutable
deployment transaction with the exact `--root / --no-systemctl` pair.

## Release-attestor v1 to v2 migration

Daemon configuration v2 is an intentional breaking schema revision. It adds a
required, exact `socketPolicy`; v1 is rejected with
`local_release_attestor_configuration_v2_required` and is never silently
upgraded. The checked source tree and a completed installation expose:

```text
paper-core/deploy/local-release-attestor-daemon.schema.json
paper-core/deploy/local-release-attestor-signer.config.example.json
paper-core/deploy/local-release-attestor-probe.config.example.json
/usr/share/hepta-paper/deploy/local-release-attestor-daemon.schema.json
```

The examples contain public paths and zero-value pin placeholders, never key
material. Replace every placeholder and provision the real private keys as
mode `0600`, owned separately by `hepta-release-attestor` and
`hepta-release-probe`. The explicit deployment policy is 5 seconds idle, 10
seconds absolute request deadline, and 32 concurrent connections. Runtime
bounds are respectively 1–30 seconds, idle–30 seconds, and 2–128; unknown
fields and string-coerced numbers are rejected.

For an upgrade, keep both old daemons running while preparing regular,
non-symlink v2 files. Atomically replace the two configuration files only after
the candidate pair preflight succeeds; the running processes do not reread
them. Then run the host installer. It repeats the same candidate-code
preflight against the canonical files before any install or systemctl action,
and only then installs artifacts and restarts signer before probe. A failed
preflight requires correcting the staged configuration and rerunning; do not
restart either daemon manually.

On a fresh host, first apply the exact reviewed
`hepta-paper.sysusers.conf` declaration so the two dedicated identities exist,
then provision their keys and the v2 pair, and finally run the installer. Do
not invent numeric UIDs in configuration or bypass the ownership preflight.

## OpenClaw-managed Codex wrapper

Use the installed launcher as both the author and reviewer `codexBinary` when
that profile is selected. Provision each private Codex home separately:

```bash
/usr/libexec/hepta-paper/codex-openclaw-managed configure \
  --home /var/lib/hepta-paper/principals/research-author/codex-home \
  --agent research-author \
  --auth-profile-id production-author \
  --model openai/gpt-5 \
  --principal-role research-author
```

`configure` uses strict option parsing: unknown, duplicate, positional, or
missing-value input fails non-zero. `--help`, `configure --help`, `--version`,
and `exec --help` are side-effect-free. `login status` and `exec` use the
configured OpenClaw authentication/runtime and retain their existing credential,
session, workspace, usage, timeout, and stdout-isolation checks.

## State-authority client

The bundled authority client accepts no command-line options other than
`--help`. It always connects to:

```text
/run/hepta-paper-state-authority/authority.sock
```

The bundled daemon configuration must name that same absolute socket. A pinned
state-backup or online-mutation process configuration uses
`/usr/libexec/hepta-paper/hepta-paper-state-authority-client` as
`commandPath`, an empty `fixedArguments` array, and the independently measured
launcher hash. The client accepts exactly one JSON request on stdin and emits
exactly one JSON receipt on stdout. Malformed JSON, socket failure, timeout,
oversize response, or authority rejection exits non-zero and produces no
success receipt.

The dedicated authority UID owns its private key and monotonic database. The
research UID sees neither and can reach only the group-restricted Unix socket.
This same-host boundary does not protect against host root or the hypervisor.

## Release-attestor client

The release client requires one absolute `--socket` path and one JSON request
on stdin. Relative sockets, unknown/duplicate arguments, malformed JSON, and
transport failures fail non-zero. A bounded `dedicated-uid-command`
configuration may pin the installed client and use fixed `--socket` arguments
for the signer and probe daemons. Those commands must retain distinct service,
principal, credential-root, and command identities.

The bundled signer/probe deployment is a bounded, dedicated-UID, same-host
availability profile. Its keys remain exportable and host root can read them;
therefore it is not an external non-exportable KMS/HSM and cannot satisfy the
full-production release-authority requirement by itself.

This bundled profile is explicitly not an external KMS/HSM profile. Its key is
host-resident and exportable, and its assurance boundary is only the dedicated
host UID plus Unix socket. It cannot satisfy full-production hardware
protection, non-exportability, independent control-plane attestation, or the
version-3 signer protocol. Full production must supply separately pinned,
argument-free signer and probe executables backed by an independently operated
hardware KMS/HSM and distinct authorities.
