# Global qualification model

## 1. Independent dimensions

Qualification does not collapse implementation, activation, operation, or
compatibility.

### Implementation

```text
not_started
design_ready
source_implemented
```

### Qualification evidence

```text
unqualified
source
hosted_installed
target_host
external_authority
```

Human prose may use “source-qualified” as a description, but machine truth uses
the exact tokens above.

### Activation

```text
disabled
shadow
canary
authoritative
retiring
retired
```

### Operation

```text
unknown
healthy
degraded
blocked
revoked
```

### Compatibility

```text
unassessed
exact
semantic
evaluation
retire
```

## 2. Evidence tiers

| Tier | Establishes | Does not establish |
|---|---|---|
| design | reviewed contract and acceptance | implementation or runtime behavior |
| source | deterministic behavior for exact source/workflow subject | target host, credentials, external custody |
| hosted installed | OS-object behavior on a disposable hosted runner | production topology/custody |
| target host | named host/service/storage behavior | unrelated credential or external authority |
| external authority | signed decision/receipt from the named independent authority | other capabilities or whole-system activation |
| production observation | bounded live operational history | correctness beyond observed scope or future behavior |

## 3. Static versus effective truth

Committed source records static implementation, planned activation,
qualification requirements, and known blockers. It cannot qualify itself. In
particular, `modules.v1.json` must not contain `qualificationState`; it stores a
`qualificationPolicy` whose effective source is `derived_only`.

Effective qualification is a retained artifact produced after the commit and
bound to an immutable subject. Production activation is a separate authority
decision that consumes current qualification but is not implied by it.

## 4. Canonical evidence binding

`docs/system/truth/evidence-bindings.v1.json` is the committed capability-level
map from contracts and source to validations, required workflow contexts,
canonical workloads, evidence tier, and external blockers. Its module, work-item,
tier, and blocker sets must exactly match the corresponding capability record.
The binding is a prerequisite map, not a successful qualification result.

## 5. Capability and module specificity

Qualification is not blanket repository status. Every promoted capability and
module has a non-empty mapping to:

```text
implementation dependencies
test/context IDs
schemas/golden vectors
fault cases
canonical workloads and thresholds
required evidence tier
reviewer/authority domain
expiry/revalidation rule
```

Global CI may be necessary but is never sufficient for an unmapped row.

## 6. Promotion

A module/capability may promote only when:

- all implementation dependencies are at the required state;
- exact source/runtime/configuration subject matches;
- every mapped check is non-empty and successful;
- full schemas validate;
- compatibility and performance requirements pass;
- required reviewers accept the latest unchanged subject;
- no current P0 or revocation affects it;
- live revalidation confirms no bound input/evidence changed.

External rows only promote from their mapped independent package.

## 7. Invalidation and demotion

Qualification invalidates when any bound item changes or becomes unavailable:

- base/head/merge/source tree;
- workflow/script/schema/manifest/dependency;
- complete eligible run/attempt/job/step state;
- artifact retention/digest;
- module binary/configuration/deployment generation;
- host/runtime identity;
- review or branch policy;
- external key/trust/evidence status;
- canonical workload/threshold;
- accepted P0 defect.

Static implementation remains; effective status falls to the strongest still
supported state.

## 8. Authority ceiling

A qualification artifact may report only what its producer can establish. It
cannot:

- acquire a writer lease;
- load provider credentials;
- sign/promote a release;
- establish KMS/HSM non-exportability;
- establish WORM custody;
- mutate a portal;
- authorize submission;
- approve its own independent review.

## 9. Reviews

Mechanical evidence and human/authority decisions are separate. The
implementation author may repair and explain results but cannot act as the
required independent host, credential, key, scientific, governance, release, or
submission authority.
