# Installed-fixture source checkpoint — 2026-08-29

This human-authored checkpoint triggers protected exact-head validation after the
installed qualification fixtures were added.

Portable source now includes:

- a service-owned-listener systemd reference profile with AF_UNIX-only,
  network-denied fake/local authority and explicit sandbox/resource limits;
- a root-only installed preflight that requires distinct broker and authority
  UIDs, canonical single-link gate/schema/trust objects, private journal/socket
  parents and hardened systemd properties, then emits canonical JSON identity
  evidence;
- an explicit-acknowledgement SIGKILL/restart drill for the network-denied
  fake/local service, including SQLite integrity, foreign-key, WAL and FULL
  durability evidence;
- documentation that host reboot, quota, remount and deliberate corruption remain
  destructive operator qualification extensions rather than portable CI actions.

These fixtures provide executable qualification procedures but do not assert that
any target host, credential, provider, KMS/HSM, WORM or submission authority has
passed them. The PR remains Draft and fake/local-only.
