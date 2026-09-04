# ADR-0016: bound observability by schema, privacy, and cardinality budgets

Status: **accepted as the current target decision; implementation and qualification remain gated**

## Context

Global optimization needs correlated plan, reservation, execution, verification,
commit, and outcome telemetry. Unbounded labels or payload logging can leak
manuscripts, prompts, credentials, private paths, or identities and can itself
cause availability failures.

## Decision

Telemetry schemas permit stable machine IDs, hashes, bounded enums, counters,
histograms, and approved low-cardinality dimensions. Prompt/manuscript/output
content, credential material, raw private paths, arbitrary error objects, and
unbounded module-provided labels are forbidden. Sensitive diagnostics use
separately retained, access-controlled, content-hash-bound artifacts.

Retention, sampling, cardinality, and redaction limits are versioned. Outcome
calibration joins by nonsecret plan/execution/result identifiers.

## Consequences

The planner receives usable feedback without making observability a new data
exfiltration or cost surface. Some debugging requires explicitly authorized
artifact access rather than logs.

## Adoption gates

Schema allowlist, redaction corpus, cardinality exhaustion test, artifact scan,
and retention policy must pass.
