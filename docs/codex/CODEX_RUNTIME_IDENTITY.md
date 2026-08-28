# Codex runtime identity and qualification

## Runtime identity v1

A runtime identity binds non-secret facts required to reproduce and authorize a
broker execution:

```text
absolute executable path and realpath
device, inode, type, mode, uid, gid, link count and size
executable SHA-256
`codex --version` output hash and normalized version
CODEX_HOME realpath and private owner/mode identity
config.toml content hash and qualified profile hash
non-secret credential-root filesystem identity
authentication mode identifier (not credential material)
model selector and selection source
transport/profile/sandbox/approval/network policy hashes
shell environment policy hash
output protocol qualification ID
```

Credential files are checked for safe type, ownership, permissions and links.
Their secret bytes are not logged or embedded in receipts. Authentication
success is a separate bounded preflight observation.

## Preflight and postflight

The broker checks identity immediately before spawn and immediately after child
cleanup. Any executable, config, home, model or policy identity drift blocks
prepared-result integration.

Identity lookup must reject:

- symlinked executable/home/config/auth material;
- non-regular executable/config/auth nodes;
- group/world-readable private roots/material;
- unexpected hard links;
- path aliasing or replacement between checks;
- unqualified version/flag/event behavior.

## Qualification record

```json
{
  "version": 1,
  "kind": "CodexRuntimeQualification",
  "codexVersion": "...",
  "binaryHash": "sha256:...",
  "runtimeIdentityHash": "sha256:...",
  "transport": "exec-jsonl-v1",
  "requiredFlags": ["--json", "--ephemeral", "--output-schema"],
  "requiredEvents": [
    "thread.started",
    "turn.started",
    "turn.completed",
    "turn.failed",
    "error"
  ],
  "roleProfileHashes": {"author-draft-v1": "sha256:..."},
  "fixtureSuiteHash": "sha256:...",
  "securitySuiteHash": "sha256:...",
  "qualificationReceiptHash": "sha256:..."
}
```

## Upgrade sequence

1. acquire candidate binary from the approved source;
2. verify source, content and executable metadata;
3. probe version and required command flags;
4. run JSONL golden/fault fixtures;
5. run sandbox/path/process escape suite;
6. run credential leakage suite;
7. run author/reviewer golden tasks;
8. run cost/usage and cancellation tests;
9. run a bounded canary;
10. sign a qualification record;
11. enable the version in a role profile.

A system-installed latest binary is never selected implicitly.
