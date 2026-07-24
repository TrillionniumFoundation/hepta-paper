# Automation Plane

The resident autonomous research process and its systemd/Kubernetes hosting
contract are documented in [autonomous-research-supervisor.md](./autonomous-research-supervisor.md).

## Product boundary

The default product is an automated research and paper factory, not a live
submission authority system. Local research, code generation, empirical
execution, manuscript writing, referee review, revision and validation must
continue without public keys or signatures. The separate submission plane may
require explicit authorization only when an external upload, email or portal
mutation is requested.

## Campaign DAG

Each paper campaign persists a dependency DAG in schema v5. The initial plan
runs research planning, then writer and coder nodes in parallel, followed by
empirical execution, manuscript integration and LaTeX compilation. Each review
round runs multiple independent referees, revision, impact-selected code,
empirical, compile, citation and table/figure validation, then a fresh set of
independent referees bound to the revised manuscript hash before convergence.
Campaigns may
run concurrently and use leases, bounded attempts, idempotent completion,
event records and expired-lease recovery. A final non-converged round stops
without packaging.

The autonomous research entrypoint adds a versioned machine agenda and a
separate machine-policy scientific authority. `prepare` is read-only;
`launch` materializes a conflict-detecting source workspace and executes the
persisted full DAG; `status` reads persisted state; `resume` continues only
unfinished fenced attempts. An empirical outcome hypothesis and a structural
Lean support theorem are separate claims: empirical observations are never
introduced as formal premises or axioms. Repeated launch is idempotent. After a
promotable release, an injected external qualification client may obtain a
signed receipt which is independently verified and cached by release hash; the
campaign process cannot qualify itself.

Batch modes select bounded campaign subgraphs. `research-verify` dispatches the
active evidence/contract verifier directly; it does not ask an agent to write a
research plan. `local-package`, `local-dry-run`, and `reviewed-submit` all gate
packaging on that verifier. `reviewed-submit` ends at an immutable local release
handoff (`externalSubmissionEnabled: false`) and does not perform an upload.

## Executors

- Draft `AgentExecutorPort` work may use an OpenClaw worker only after binding a version 2
  operator profile to the running Gateway's `config.get` hash and to a
  canonical security projection of the selected `agents.list[]` entry. The
  Gateway is re-read after the turn and relevant or whole-config drift makes
  the turn fail. Every mutable node works in a private, descriptor-verified
  copy; changed paths merge only if their source preimages still match. The
  implementation does not currently claim reflink/copy-on-write semantics.
  Structured local Ollama is a draft-only offline circuit breaker. A
  research-grade campaign selects an explicitly configured, authenticated
  Codex author with a private credential root and explicit model; it never
  silently promotes OpenClaw or Ollama output as research-grade authorship.
- `EmpiricalExecutorPort` maps Python, Node, R, Julia, Lean and LaTeX to the OS
  sandbox runner. Availability is reported honestly per installed runtime.
  WorkerRunner v4 accepts only the runner-issued, opaque `executionIdentity`
  capability for prepared execution. The former `containerImageIdentity` and
  caller-supplied `containerImageDigest` inputs are removed and fail closed
  before image resolution or execution; immutable image digest remains a
  receipt/output field.
- Generated Python and LaTeX are executed, not trusted. A failed command may
  invoke one bounded diagnostic repair step and must pass a fresh isolated run.
- LaTeX has a deterministic sanitizer for common model serialization defects
  before an agent repair is attempted.
- A global resource governor limits agent, CPU, GPU and memory slots across all
  papers. Campaign wall-time, agent-call, CPU/GPU-job, token and cost budgets,
  usage and stop reasons are persisted. For Codex/OpenClaw, the token budget is
  a prompt hint plus post-response accounting, not a provider-enforced hard
  ceiling; production safety instead requires an atomic call ceiling, a known
  configured maximum price per call, a total cost ceiling and wall-time limits.
  Named datasets mount read-only with a
  manifest hash. Successful empirical outputs may enter a source/runtime/data-
  bound cache; every replay rechecks artifact hashes. Executed outputs are
  materialized under `automation-results/` before a writer may consume them.
  An explicit benchmark id is accepted only when it resolves to a built-in
  suite or an authorized dataset mount; its hash-bound selector is forwarded to
  the sandbox worker as `HEPTA_BENCHMARK_ID` and recorded in the execution
  receipt. The canonical `venueTarget` is bound into package and submission-
  handoff records.
- Academic benchmark cells and their isolated deterministic rerun share the campaign's
  absolute deadline and are charged per spawned process for CPU/GPU jobs, CPU
  seconds, memory and PID limits. Repository-owned evaluators read raw events
  back and recompute cell metrics and residuals. Manuscript numbers must resolve
  through the accepted registry to trusted-ledger original and replay result
  hashes; an agent-created JSON file or matching comment is not evidence, and
  agent workspaces cannot mutate `automation-results/`.

### OpenClaw configuration boundary

The production resolver queries the actual running Gateway with the read-only
`config.get` RPC under a restricted environment. It does not trust a profile
or a local `openclaw config get` result as evidence of the Gateway's runtime
configuration. The selected agent must have an absolute, exact tool allowlist;
no additive, provider, sender, sandbox or subagent tool expansion; no skills or
delegation; workspace-only filesystem tools; sandbox-only exec; disabled
elevated and messaging authority; and a session-scoped Docker sandbox with no
network, read-only root, all capabilities dropped, no extra binds or injected
environment, a non-root user, and explicit PID, memory/swap and CPU bounds.

`openclaw agent` has no per-turn workspace override. Its process working
directory and the prompt text do not change the configured agent workspace.
Consequently, an OpenClaw turn is allowed only when the configured absolute
`agents.list[].workspace` canonicalizes to the exact per-attempt workspace.
The current campaign executor normally creates a new dynamic isolated
workspace for each attempt, so a fixed OpenClaw agent configuration cannot
prove that relationship and fails closed with
`openclaw_agent_dynamic_workspace_not_config_bound`. An ancestor workspace is
never accepted. Enabling this backend requires an OpenClaw mechanism that can
immutably bind the per-turn workspace, or a separately pre-provisioned agent
whose exact workspace is the attempt workspace; this repository does not
rewrite external OpenClaw configuration to achieve that.

Formal campaign review therefore defaults to a separate process-backed Codex
reviewer principal. Composition gives it a dedicated executor/principal id,
clones the current campaign attempt into a second private review tree, and
requires both the outer isolated executor and Codex itself to enforce
read-only workspace access. The review session is ephemeral and its receipt is
principal-bound. Explicit OpenClaw selection fails during composition instead
of weakening exact-workspace or per-attempt isolation. The primary author
backend remains independently selectable.

For an operator-signed or machine-policy-authorized formal paper, the system
copies each exact proposal claim id, UTF-8 text hash, whole claim-record hash,
scientific claim key, assumptions, quantifiers, negative boundaries and proof
obligations into the canonical theorem specification. Operator mode additionally
binds the approved-seed and seed-bundle hashes; machine mode carries its separate
policy/bundle hashes and cannot impersonate operator approval. The
mapping is a bijection: no proposal claim or theorem may be omitted, duplicated
or substituted. Only `formal_kernel` claims may enter this mapping. Stable
obligation ids map each natural-language obligation to one or more audited Lean
declarations. It becomes promotable only after the independent formal reviewer
attests semantic equivalence from that exact proposal claim to the manuscript
theorem, in addition to reviewing manuscript-to-Lean equivalence. The reviewer agent's
hash-bound structured output is re-parsed during formal receipt verification;
an envelope and its downstream receipts cannot replace or re-seal that
verdict. This remains a separated semantic attestation, not a kernel proof of
natural-language equivalence.

Codex configuration preflight proves only the selected executable identity,
private credential/config filesystem identity, authentication state and an
explicit model selection. It does not claim the selected model is available.
`automation:research-status` therefore opts into separate live, ephemeral model
canaries for both author and reviewer and an active production release-attestor
probe/challenge. Plain `automation:status` keeps both provider canaries and the
release-attestor backend passive unless their corresponding live flags are
supplied. The full readiness bit also requires a healthy campaign store and no
operational-integrity blockers.
Every campaign invocation repeats the local runtime/authentication preflight
and compares it with the capability receipt before launching the already
resolved executable; replacing the binary, config or credential root after
composition fails closed.

Successful receipts record the Gateway instance, full configuration hash,
canonical agent-security hash, and successful post-turn revalidation.
`externalActionPerformed` remains `null` with a `not_observed` verification:
configuration binding constrains authority but is not observation of every
provider-side invocation. A configuration change between the pre- and
post-turn reads fails the result; the two reads are not misrepresented as an
atomic Gateway transaction.

## Release evidence boundary

Academic empirical releases carry a self-contained evidence capsule with
original/replay results, raw events, environment BOMs, public authority
documents and a minimal public trust snapshot. Package hashes and the bundled
snapshot prove package-internal consistency only. Source authenticity is
reported as verified only when the offline caller supplies independently
trusted Ed25519 public roots whose key ids, canonical public keys, roles and
activation/revocation metadata exactly match every referenced snapshot key. A
package that verifies its own replaced key, rewrites key status and re-signs
authority therefore remains blocked without the external root pin.

The capsule execution lineage has a separate trust boundary. Every academic
empirical capsule must contain
`evidence/CAPSULE_MANIFEST.external-attestation.json`, an Ed25519 signature by
the `research_execution_release_attestor` role over the exact capsule-manifest
file hash and its campaign, research-report, registry, source-snapshot,
research-attempt/lease and experiment lineage. The signature is shipped and
included in `SHA256SUMS.txt`, but neither its public root nor its private key is
self-anchored in the package. Offline verification succeeds only when the
caller separately supplies `trustedReleaseRoots` with an exact subject,
organization, `keyId`/`keyVersion`, SPKI fingerprint, role and current
active-or-retiring key-state match. Operator
dataset authority roots and execution-release roots are intentionally distinct.
This proves that the external release root signed the manifest and its recorded
execution lineage. It does not independently witness the execution, prove
execution authenticity, provide a trusted timestamp or act as a transparency
log; those stronger assurances remain false unless a future external witness is
added.

Production signing reads a private, operator-provisioned version-2
`RESEARCH_EXECUTION_RELEASE_ATTESTOR.json` (by default under the runtime
`trust/` directory, or selected by
`HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG`). The configuration contains
only an Ed25519 public-key trust set and identities for external signer and
independent-probe commands. It must not contain a private key, private-key path,
token or inline credential. The main process sends only a hash-bound digest,
random request nonce, active `keyId` and `keyVersion` to the external KMS/HSM
signer. It verifies the response against the pinned active public key before
accepting a signature.

Exactly one non-revoked trust-set key is `active` and may sign. Non-revoked
`retiring` keys remain verification-only during their explicit
`effectiveFrom <= time < expiresAt` overlap window. Duplicate normalized
Ed25519 SPKI keys, including differently encoded PEM files under different
identities, are rejected. A revoked, expired, wrong-version or wrong-algorithm
key fails closed.

Production readiness additionally runs a fresh random-challenge probe through
a distinct executable, service principal and credential root. The response
must be a short-lived Ed25519 attestation by a separately pinned probe
authority and must bind the backend descriptor, active key tuple, SPKI hash,
hardware-protected/non-exportable assertions and challenge hash. A configured
backend is not reported production-ready when this independent probe is absent,
stale or invalid. The legacy version-1 PKCS#8 file signer remains available
only for Golden bootstrap, local development and tests. Its inspection reports
`local-file-private-key-main-process-degraded-v1`, and every `production-run`
gate rejects it even when the local signature self-verifies.

## TaskFlow boundary

TaskFlow is an experimental reviewed-submission coordinator and is not wired
into the campaign or any production composition root. Native campaign state,
resume, cancellation and child-session ownership remain in the automation
engine. The experimental coordinator stores only identity, checkpoints,
receipt hashes and blocker codes and never decides DAG readiness, referee
convergence, evidence validity or submission authorization.

## Operations

`paper:campaign -- --action list|status|events|pause|resume|cancel|cancel-node|retry`
provides native operations. `automation:dashboard` reports node states,
latest events, stop reasons and time/token/model-resource usage. Cancel is
immediate for child agents and cooperative/bounded for synchronous empirical
workers. Cancelling one node recursively skips only its dependency subtree;
if that subtree contains the required package path, the campaign stops with an
explicit operator-cancellation reason.

`hepta-paper operator autonomous-research -- --action prepare|launch|status|resume`
provides the bounded unattended path. Objective and protocol overrides are
optional during prepare/launch; when absent, a hash-bound machine agenda selects
them. Launch still requires an externally authorized academic dataset and
independent author/reviewer configurations. Those can be provisioned services;
they are deployment trust roots, not per-campaign human approvals.

The external qualifier/verifier uses the exact-shape version-3 configuration,
including its hash-bound combined worst-case qualification cost and cost
authority, plus the preprovisioned release-key rotation contract documented in
[`external-research-qualification.md`](external-research-qualification.md). Its
public-key status labels are not current signing authority; a fresh challenged
production release-attestor inspection decides which key may issue a new receipt.

## Readiness

`automation:status` reports Automation Plane readiness independently from Live
Submission readiness. Missing R, Julia or Lean blocks only campaigns that
request those runtimes. Missing cold data blocks only papers that depend on
that data. Authority keys, owner signatures, WORM custody and legacy deletion
do not block local automation.

`automation:research-status` is stricter: it requires the research author and
independent formal reviewer configuration preflights and live model canaries,
Lean, the academic empirical dataset backend, a readable campaign store and a
clean operational-integrity report. It also requires a current version-2
research-execution release-attestor configuration whose external KMS/HSM
backend has passed the independent challenge probe and fresh active-key
signature challenge. This route explicitly supplies both
`--live-provider-canary` and `--live-release-attestor`; the plain status route
does not. A locally loaded file key is reported usable for Golden/local
packaging but is not production-ready.
Full readiness also loads the path in
`HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT` and validates its attestor signature,
24-hour window, exact worktree/config/schema/image bindings, independently
attested provider-account separation, and pointer to a trusted current completed
release containing both verified formal evidence and academic empirical replay.
The signed qualification and independent verifier response must agree on an
opaque bounded prior-art review receipt hash. Search semantics and completeness
remain the external review service's responsibility; this is an attested review
reference, not a repository-validated proof of scientific novelty.
Missing or invalid qualification evidence is reported as a blocker and never
minted by this status surface. The canaries are real provider calls and
may consume a small amount of quota. It intentionally claims only the
registered analysis families, not universal scientific validity, and records
that natural-language to Lean equivalence is an independent semantic-review
attestation rather than a kernel theorem.
