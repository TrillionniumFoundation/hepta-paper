# Route Contracts

Route contracts are the shared local policy for choosing the final delivery shape before generation or submit preparation.

- `ROUTE_CONTRACT_VERSION` tracks the contract shape.
- `ROUTE_CONTRACT_SAFETY` declares that the module is local-only and does not call providers, fetch channel state, mutate channel state, or grant execution permission.
- `buildRouteContract()` normalizes a semantic or workflow route into a stable contract.
- `applyRouteContractToPlan()` binds route fields into a production plan.
- `validateRouteContractAgainstLiveRules()` detects conflicts between a route contract and observed live-submit limits.
- `routeContractPackageChecks()` validates that a final package still matches the contract.

The module is intentionally deterministic. It can decide that a plan expects an image set, a single PDF, or a text form, but it cannot upload, submit, message, accept, pay, deploy, or authorize any external action.
