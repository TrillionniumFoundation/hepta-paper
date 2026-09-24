# Ownership and review policy

## 1. Current single-maintainer decision

The repository owner selected single-maintainer development. `@ProfHepta` owns
integration and may author, test and merge a change without a second person's
approval. The owner may delegate implementation and integration to authorized
tools. Do not invent another reviewer, request a ceremonial self-approval, or
block development on unstaffed teams.

Both protected branches have pull-request review protection disabled. There is
no required approving-review count, Code Owner approval, stale-review ceremony,
or last-push approval. PRs remain the integration surface while the required
machine checks, exact-head merge guard, signed integration, administrator
enforcement, and force-push/deletion protections remain enabled. Optional review
is feedback, never a staffing prerequisite.

## 2. Responsibilities, not a fictitious organization

`docs/system/truth/modules.v1.json` retains stable `TEAM-*` responsibility IDs
for code navigation and module boundaries. Its ordered owner roles describe
primary, recovery and verification expertise, not three different people or
existing GitHub teams. `.github/CODEOWNERS` routes to the current maintainer.
Future multi-person staffing is optional and requires an explicit policy change.

## 3. Change classes select evidence

| Class | Changes | Applicable validation |
|---|---|---|
| C0 | comments and non-semantic generated projections | relevant documentation/format checks |
| C1 | private implementation | module tests and lint |
| C2 | public protocol or resource contract | affected consumer and compatibility tests |
| C3 | scheduling, policy or objectives | constraint, workload and decision regressions |
| C4 | schema, writer, recovery or migration | real transactions, crash/replay and data-preserving rollback |
| C5 | credentials, authority or external effects | wrong-principal, final-use, expiry and ambiguous-effect tests |
| C6 | release, cutover or retirement | exact artifacts, one-writer transfer and operational evidence |

The strongest actual effect determines scope. Splitting files or labelling a
change a refactor does not remove its applicable tests. State the affected
behavior, evidence, compatibility and remaining gaps in the existing PR; a new
approval checklist or parallel status board is not required.

## 4. Development acceptance versus runtime authority

Passing source checks permits maintainer integration; it does not prove a model
ran, a target host survived failure, or a remote operation completed. Scientific
author/reviewer role isolation, authenticated runtime evidence, credential
custody, unique-writer fencing and external-effect reconciliation remain actual
product contracts. Separate service principals do not require hiring separate
human PR approvers. Do not use this development policy to forge operational
facts or relabel a fixture signature as a real service receipt.

`EXT-GOV-MAIN-001` and its independent repository-review ceremony are historical
V1 compatibility, not required by the current V2 operational qualification set.
The live protected-branch settings plus applicable exact-source CI are the
development merge boundary. Emergency repairs use the same actual tests and recovery rules;
there is no extra independent-review prerequisite.
