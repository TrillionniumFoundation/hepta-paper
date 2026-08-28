# Codex CLI execution surface V1

Status: source-reviewed contract; binary qualification not yet granted  
Upstream source baseline: `openai/codex@6be2a6ca952ac9f70676ce4dd07fda27175aa9dd`

## Purpose

This document freezes the only Codex CLI surface the Rust broker may construct
before a separately recorded binary qualification. The Rust contract is derived
from the upstream `codex exec` CLI and configuration source, not from guessed or
historical flags.

Source review establishes that the selected upstream source exposes:

```text
exec
--json
--output-last-message
--output-schema
--color
--model
--sandbox
--cd
--skip-git-repo-check
--ephemeral
--ignore-user-config
--ignore-rules
--strict-config
--config KEY=VALUE
```

The upstream source does not expose an `exec --ask-for-approval` flag. Approval
is therefore bound through a strict configuration override rather than a
fictional CLI switch.

## Exact V1 argv

The invocation builder constructs this ordered surface:

```text
codex exec
  --strict-config
  --skip-git-repo-check
  --ephemeral
  --ignore-user-config
  --ignore-rules
  --json
  --color never
  --sandbox <read-only|workspace-write>
  --cd <canonical-attempt-root>
  --model <qualified-model-selector>
  --output-schema <bound-read-only-schema-file>
  --output-last-message <bound-empty-output-file>
  --config approval_policy="never"
  --config sandbox_workspace_write.network_access=false
  --config web_search="disabled"
  --config shell_environment_policy.inherit="none"
  --config shell_environment_policy.ignore_default_excludes=false
  --config shell_environment_policy.set.<KEY>=<TOML-string>
  ...
  -
```

The prompt is nonempty bounded UTF-8 written to stdin. The exact ordered argv and
prompt bytes are independently SHA-256 bound into the invocation result.

## Parent and model-child environments

The parent Codex process receives the qualified Codex-parent environment. The
model-launched shell environment is rebuilt inside Codex configuration with:

```text
inherit = none
ignore_default_excludes = false
set = exact versioned allowlist
```

No `CODEX_HOME`, provider key, release credential, KMS, portal, submission,
backup, WORM, or generic secret-like variable enters the model-child `set` map.

## Control files

The current source binds two pre-created files:

- the output schema is content-hashed, single-link, private and owner-read-only;
- the output-last-message file is single-link, initially empty, private and
  owner-writable.

Their device, inode, mode, owner, group, link count and size limits are captured
before spawn and rechecked after process-group cleanup. The schema must retain
its exact hash; the output file may change content but may not be replaced,
relinked, re-owned or have its permissions changed.

This permission check is necessary but not yet sufficient for real Codex. If the
schema and Codex process share the same Unix owner, that owner can temporarily
`chmod`/rewrite/restore the file. Production qualification therefore remains
blocked until the schema is owned by a separate authority or supplied through an
OS-enforced sealed descriptor. That blocker is tracked separately and is not
waived by postflight hash equality.

## Explicitly forbidden V1 features

```text
OpenClaw
resume or persisted conversation state
web search
workspace network
MCP servers
plugins
interactive approval
dangerously-bypass-approvals-and-sandbox
danger-full-access
unqualified user configuration
unqualified repository rules
arbitrary config overrides
```

## Qualification boundary

Source review is not binary qualification. Before a real executable may be used,
the broker must bind and test:

1. exact executable content and filesystem identity;
2. exact `codex --version` output and required help surface;
3. successful strict-config parsing of every V1 override;
4. JSONL golden and fault transcripts;
5. authentication status without credential disclosure;
6. author/reviewer sandbox and environment attack suites;
7. process cleanup, output limits, cancellation and postflight identity;
8. schema authority separation or sealed-file enforcement;
9. a signed qualification record naming the executable, source baseline,
   runtime identity, role profile and fixture-suite hashes.

Until those gates pass, the invocation builder may be exercised only with local
fake executables and has no provider credential authority.
