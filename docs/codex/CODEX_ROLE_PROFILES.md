# Codex role profiles v1

Role profiles are versioned capability bundles. A role cannot request a broader
sandbox, network mode, session policy or mutation set at runtime.

## Common V1 policy

```text
transport: exec-jsonl-v1
session: ephemeral-new-thread
approval: never
workspace network: none
MCP: disabled
plugins: disabled
web search: disabled
project/user rules: ignored unless explicitly qualified
external messaging/submission: forbidden
credential access: forbidden
```

Every execution uses a dynamic attempt workspace and a fresh process. The model
selector, Codex binary/config identity, output schema, environment policy and
mutation policy are bound into the request.

## `author-draft-v1`

Purpose: create an initial manuscript and declared support artifacts.

Authority:

- workspace-write inside the attempt root;
- write only declared manuscript/bibliography/metadata paths;
- run qualified local build/check commands;
- no canonical integration or release authority.

Mandatory checks:

- actual mutation inventory is inside the allowlist;
- generated references are validated by separate evidence services;
- build/check receipts bind the exact attempt tree.

## `author-revise-v1`

Purpose: address a versioned reviewer issue set.

Authority:

- workspace-write only for paths declared by the revision plan;
- cannot remove accepted evidence/checks without an explicit regression
  disposition;
- cannot access reviewer credentials or hidden reviewer context.

Output binds issue IDs to changed paths and unresolved blockers. Agent claims do
not replace actual tree diff.

## `reviewer-v1`

Purpose: review a frozen artifact bundle.

Authority:

- read-only bundle;
- no source write, author home, author session or mutable campaign state;
- no resume from a previous reviewer or author session;
- structured verdict only.

The local profile establishes bounded process/session/artifact separation. It
does not claim provider-account or institutional independence unless separately
attested.

## `formal-reviewer-v1`

Purpose: inspect immutable formal evidence and verifier receipts.

Authority:

- read-only evidence bundle;
- optional isolated scratch directory whose content is non-authoritative;
- cannot edit formal source, theorem statements or canonical proof artifacts;
- cannot promote proof assurance.

## `code-repair-v1`

Purpose: repair one declared generated-code entrypoint after deterministic test
failure.

Authority:

- workspace-write for an exact file/path set;
- bounded process/time/output;
- no dependency or toolchain changes unless the mutation policy explicitly
  permits them;
- no network.

## `latex-repair-v1`

Purpose: repair deterministic typesetting failures.

Authority:

- `.tex`/`.bib` and explicitly listed support files only;
- cannot change scientific result data or evidence receipts;
- deterministic rebuild must pass before integration.

## Environment

Codex parent and model-launched command environments are distinct. The latter
uses an allowlist with a scratch `HOME`/`TMPDIR`. Provider credentials, role-peer
homes and hepta authority credentials are excluded.

## Qualification tests

Every role profile must demonstrate:

- attempted forbidden write is blocked or detected and discarded;
- attempted path escape, symlink/hardlink trick and special-file creation fails;
- `env`, `/proc`, shell startup files and known auth paths reveal no credentials;
- child/grandchild processes are terminated at deadline;
- output and event limits are enforced;
- runtime identity changes before/after execution block integration;
- session is new and ephemeral;
- campaign generation changes block prepared-result integration.

## Profile evolution

A profile is immutable after qualification. Any widened path, command,
environment, network, session or credential authority creates a new profile
version and invalidates previous qualification evidence for that deployment.
