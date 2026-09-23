# ADR-0014: single-maintainer integration and logical responsibility ownership

Status: **accepted; supersedes the earlier mandatory multi-team review target**

## Context

The project has one developer. Requiring primary, secondary and independent
human approvers created an impossible staffing gate without changing product
behavior. The owner explicitly removed that prerequisite.

## Decision

Use the [single-maintainer ownership policy](../governance/OWNERSHIP_AND_REVIEW.md).
The maintainer may author and integrate a PR after its applicable exact-source
checks pass. Required approval count is zero; Code Owner and last-push approvals
are disabled. CODEOWNERS and TEAM IDs route responsibility, not mandatory votes.

## Consequences

Real interface, runtime, state-recovery and scientific validation remain required.
Independent operational observations and service-principal separation are not
human repository approval requirements. Retain old signed evidence under its
original version; current operational qualification omits the repository-review
package. Source tests never manufacture production activation or external facts.

## Adoption

Apply the policy to both protected repository branches and current documentation.
Retire the obsolete independent repository-approval and mandatory team-provisioning
work items; do not report them as successfully executed external qualification.
