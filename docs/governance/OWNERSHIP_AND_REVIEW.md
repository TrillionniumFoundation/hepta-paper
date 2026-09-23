# Ownership and review policy

## 1. Ownership record

`docs/system/truth/modules.v1.json` records planned owner team IDs. GitHub
CODEOWNERS is the enforcement projection after teams are provisioned.

For each module:

```text
primary owner
secondary owner
independent reviewer
security/state/release reviewer where applicable
operational escalation owner
```

## 2. Change classes

| Class | Examples | Required review |
|---|---|---|
| C0 | comments, typo, generated non-semantic projection | module owner; docs validator |
| C1 | compatible private implementation | primary or secondary owner; module CI |
| C2 | public module contract, resource/SLO envelope | module owner + protocol + consumers |
| C3 | scheduler objective/fairness/policy | scheduler + kernel + evidence/product |
| C4 | state schema, writer, recovery, migration | state + kernel + migration/recovery reviewer |
| C5 | authority, credentials, external effect, qualification | security/evidence + relevant external owner; independent latest-push review |
| C6 | release/cutover/retirement | release + state + governance + external authority as required |

A change is classified by its strongest effect. Splitting files does not lower
its class.

## 3. Self-review limits

The author may explain and test a change but cannot supply an independent review
required for:

- branch governance;
- target-host acceptance;
- credential/key custody;
- scientific/evidence independence;
- release/KMS/HSM/WORM/submission authority;
- latest-push approval where policy requires a distinct reviewer.

## 4. Review inputs

Every PR states:

```text
change class
module/capability/work-item IDs
exact base/head subject
authority and side-effect delta
protocol/state compatibility
resource/performance impact
failure/recovery/rollback
evidence and reviewer domains
manifest/document impact
```

Reviewers reject unbounded “refactor” or “no behavior change” statements when
public contracts, authority reachability, resource use, or failure behavior
changed.

## 5. Consumer review

A public protocol change identifies direct consumers from the module dependency
graph. Compatible additions may use generated tests; breaking or semantic
changes require named consumer review and migration.

## 6. Emergency changes

Emergency repair does not bypass evidence. It may shorten rollout scope but must
still bind exact source, authority, rollback, and independent review. Temporary
risk acceptance has an expiry and cleanup item.

## 7. CODEOWNER generation

When real team handles exist, CODEOWNERS should be generated from the ownership
registry and checked for drift. High-risk shared roots retain multiple owner
teams; ordinary module-private paths route to that module's teams.
