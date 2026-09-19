# Fixed native online mutation composition

## Source registry

`BuiltinOnlineMutationPlansV1::load` loads the fixed native source registry corresponding to `paper-composition/bootstrap/autonomous-research-online-mutation-operation-plans.mjs`. It includes all 134 original operation plans and 486 statement definitions from the sixteen original plan modules. SQL text, statement IDs, modes and operation membership are retained exactly. The writer manifest is the same compiled source document already consumed by the native backup CLI.

Loading runs the native complete writer-manifest validator and restricted-statement plan validator. It recomputes every writer implementation hash from its operation plans and retains a private `ValidatedPlanRegistryV1`. The complete native plan projection and original Node registry are compared for every operation. This is executable statement-plan source, not a generated claim that the 134 business handlers or all their command callers have been ported.

## Actual configured stage

`compose_configured_online_mutation_coordinator_v1` accepts an opaque actual database inventory, a pinned authority client, and the clock owned by the configured coordinator. It validates the closed ten-role inventory against the fixed production writer manifest, checks pinned writer/scope identity, builds the original sorted database-instance projection, and constructs the actual existing coordinator with the original default lease and 1000 ms commit safety margin. The caller cannot supply an alternative SQL plan set through this entrypoint.

Actual inventory and pinned configuration/public-key snapshots are rechecked before returning. Crate-private currentness methods expose no new external mutation API and perform no authority transport. A configuration changed after initial loading is rejected even when its JSON meaning remains the same.

The return value is a private-field `ConfiguredOnlineMutationCompositionV1` wrapper with only public read-only `inspect_status`. It has no write method, inner accessor, extraction or dereference path. A compile-fail contract checks that mutation cannot be invoked on this configured high-level value. The existing low-level coordinator remains a separate API. The wrapper retains the `autonomous_research_online_mutation_runtime_activation_required` blocker. This factory does not call authority transport, repair pending writes, inspect schema-transition completion, obtain active authority evidence, construct a backup controller, or create an activation or recoverability epoch. The complete activation composition must independently own the concrete recoverability fence and all its current proof dependencies. A prior inventory observation does not freeze future database state. The crate-private currentness check validates public authority configuration and key bytes only; arbitrary transport state is not part of that claim. A composition consuming a process transport must independently retain and recheck its process configuration and executable pins before use. No activation extraction path exists in this slice.

## Fixed-predicate validation cost

The shared native statement-plan validator caches at most 16 compiled, source-owned literal regular expressions. SQL remains input to those rules and cannot create cache keys. Matching releases the cache mutex first. Dynamic trigger identifier patterns retain the existing uncached compilation path. Hashes, SQL validation rules, case folding and whitespace conversion are unchanged.

An isolated cold-process complete 134-operation/486-statement Node/Rust comparison took 10.54 seconds before and 1.70 seconds after this change on the same host. These are local observations, not a portable performance guarantee. All six existing statement-plan parity and SQLite restriction groups pass with the cache.

## Differential evidence

The isolated tests export the original full registry under pinned Node 22.23.1 and compare all definitions, normalized native plan projections and manifest hash. A separate case provisions ten real SQLite databases using the original signed schema fixture, loads actual pinned public trust files, and checks the configured status. Wrong writer hash, wrong database scope, modified trust bytes, and changed inventory are rejected. An explicit rejecting transport with a call counter verifies zero authority calls. The tests do not obtain production credentials or activation permission.

Results are recorded against the final integrated commit and its logs. This source slice remains separate from business-operation parity, complete live activation and independent command acceptance.
