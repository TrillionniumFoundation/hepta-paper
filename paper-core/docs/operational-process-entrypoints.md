# Operational process entrypoints

Three repository entrypoints implement machine protocols rather than human
operator commands:

- `codex-openclaw-managed` is a Codex-compatible executable selected through
  `codexBinary`;
- `hepta-paper-state-authority-client` carries one authority request over the
  fixed local Unix socket;
- `hepta-paper-release-attestor-client` carries one bounded signer or probe
  request to an explicitly selected local Unix socket.

They are deliberately absent from the npm and `hepta-paper operator` command
registries. Routing a raw signing or mutation protocol as a general operator
command would widen its authority surface and could corrupt its stdout
protocol. Their supported invocation surface is a pinned executable path in a
reviewed process configuration.

## Installation

The release application tree must first be installed read-only at
`/opt/hepta-paper`. The host installer then snapshots the launcher templates,
verifies that they did not change during installation, and installs these
root-owned executable paths:

```text
/usr/libexec/hepta-paper/codex-openclaw-managed
/usr/libexec/hepta-paper/hepta-paper-state-authority-client
/usr/libexec/hepta-paper/hepta-paper-release-attestor-client
```

Run the existing installer from the exact release tree:

```bash
sudo /opt/hepta-paper/paper-core/deploy/install-hepta-paper-systemd-host.sh
```

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
not an accidental Git worktree bit. Every launcher uses the absolute
`/usr/bin/node` interpreter and the exact `/opt/hepta-paper` entrypoint; it does
not resolve `node` or application code through `PATH`, use `eval`, or add
arguments. The caller's already restricted environment and exact argument list
are forwarded unchanged.

The launcher content hash does not replace release-graph verification. The
read-only `/opt/hepta-paper` tree, launcher manifest, exact release commit, and
tracked production graph must all be frozen and verified together. Any
launcher or application-tree drift invalidates the candidate.

For an offline installation test without systemd mutation:

```bash
paper-core/deploy/install-hepta-paper-systemd-host.sh \
  --root /absolute/staging-root --no-systemctl
```

That staging root must already contain a valid configuration pair and its
referenced test keys. The preflight runs before the installer creates `usr/` or
`etc/systemd/` below the staging root.

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
