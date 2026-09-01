# Engineering glossary

| Term | Definition |
|---|---|
| capability | A stable system behavior or externally visible responsibility, independent of implementation language. |
| component | An internal code unit with no promise of independent ownership or versioning. |
| module | A registered, independently owned and versioned implementation of one or more capabilities. |
| crate/package | A language build unit; it is a module only when the module contract says so. |
| worker | A process or container executing one bounded module command. |
| service | A separately deployed and supervised process with an operational identity. |
| adapter | An implementation of a port to an external system, runtime, legacy surface, or storage backend. |
| composition root | The only location that chooses concrete implementations and assembles an executable object graph. |
| state snapshot | An immutable, hash-bound view of campaign, resource, module, qualification, and policy state used for planning. |
| candidate | One feasible module-proposed action with declared resources, predictions, preconditions, effects, and expiry. |
| Pareto frontier | Candidate set in which no candidate is strictly worse in all relevant objective/resource dimensions. |
| plan | A centrally selected, hash-bound set/order of candidates and reservations for one snapshot. |
| hard constraint | A rule that cannot be violated by changing objective weights. |
| soft objective | A value used to rank feasible plans after all hard constraints hold. |
| model-global optimum | Proven optimum for the bound finite candidate, objective, and constraint model. It is not a claim of real-world omniscience. |
| optimality gap | Difference between the best feasible objective and the solver's best bound. |
| prepared result | Durable, content-addressed module output that has not yet become authoritative state. |
| commit sequencer | The sole process/component authorized to make campaign-state transitions authoritative. |
| authority | Permission to create a trusted state or external effect, not merely to calculate or propose one. |
| evidence tier | The environment and independent authority from which evidence originates. |
| qualification | Acceptance of evidence for an exact subject; distinct from activation. |
| activation | Whether an implementation version is disabled, shadow, canary, authoritative, or retired. |
| shadow | Execution whose outputs are compared but cannot affect authoritative state. |
| canary | Bounded authoritative or external use under explicit scope and rollback. |
| exact parity | Byte/hash/state/decision equality under the versioned contract. |
| semantic parity | Different representation with the same approved invariant and effect class. |
| evaluation parity | Non-deterministic output assessed by metrics and independent review, not byte equality. |
| strangler migration | Capability-by-capability replacement while old and new implementations coexist under explicit authority fences. |
| DRF | Dominant Resource Fairness, which compares each workload by its largest share of a constrained resource. |
| aging | Increasing scheduling priority as waiting time grows to prevent starvation. |
| reconciliation | Resolving durable intent against authoritative state after failure or ambiguity. |
| TCB | Trusted computing base: every principal, process, file, key, or dependency whose compromise can violate a claimed property. |
