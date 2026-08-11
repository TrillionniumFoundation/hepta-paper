import {
  exactAutonomousFormalSupportTemplateForTheoremClaim,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';

const FORMAL_LOSS_CAP_AXIOM_FREE_INSTRUCTION = `
For the exact loss_cap_upper_bound obligation, use this already kernel-audited declaration verbatim:
theorem loss_cap_upper_bound : ∀ (loss cap : Nat), Nat.min loss cap ≤ cap := by
  intro loss cap
  change (if loss ≤ cap then loss else cap) ≤ cap
  split
  · assumption
  · exact Nat.le_refl cap
Do not replace its change step with rw, simp, omega, or another library lemma. Expand Nat.min_def, split its branch condition, and close the branches from the comparison hypothesis and Nat.le_refl. This exact declaration elaborates under the pinned Lean toolchain with no axioms while preserving the authorized theorem type and source-statement identities.`;

const FORMAL_PANEL_RETENTION_AXIOM_FREE_INSTRUCTION = `
For the exact registry-bound panel_retention_accounting obligation, use this already kernel-audited declaration verbatim:
theorem panel_retention_accounting : ∀ (scheduledCells retainedCells : Nat), retainedCells ≤ scheduledCells → scheduledCells - retainedCells + retainedCells = scheduledCells := by
  intro scheduledCells retainedCells h
  induction retainedCells generalizing scheduledCells with
  | zero => exact Nat.add_zero scheduledCells
  | succ retainedCells ih =>
    cases scheduledCells with
    | zero => exact False.elim (Nat.not_succ_le_zero retainedCells h)
    | succ scheduledCells =>
      rw [Nat.succ_sub_succ_eq_sub]
      rw [Nat.add_succ]
      exact congrArg Nat.succ (ih scheduledCells (Nat.le_of_succ_le_succ h))
This exact declaration preserves the registry's explicit-∀ expectedType source identity and has been audited under the pinned Lean toolchain with no axioms.`;

const FORMAL_SCHEDULE_FILTER_AXIOM_FREE_INSTRUCTION = `
For the exact registry-bound length_filter_le obligation, use this already kernel-audited declaration verbatim:
theorem length_filter_le : ∀ {α : Type} (schedule : List α) (accept : α → Bool), (schedule.filter accept).length ≤ schedule.length := by
  intro α schedule accept
  induction schedule with
  | nil =>
      exact Nat.le_refl 0
  | cons head tail ih =>
      unfold List.filter
      cases h : accept head with
      | false =>
          change (List.filter accept tail).length ≤ Nat.succ tail.length
          exact Nat.le_succ_of_le ih
      | true =>
          change Nat.succ (List.filter accept tail).length ≤ Nat.succ tail.length
          exact Nat.succ_le_succ ih
Do not replace the unfold/case split with simp or rw. This exact declaration preserves the registry's explicit-∀ expectedType source identity and elaborates under the pinned Lean toolchain with no axioms.`;

const FORMAL_FEASIBLE_ALLOCATION_AXIOM_FREE_INSTRUCTION = `
For the exact registry-bound feasible_allocation_bounds obligation, use this already kernel-audited declaration verbatim:
theorem feasible_allocation_bounds : ∀ (demand capacity : Nat), Nat.min demand capacity ≤ demand ∧ Nat.min demand capacity ≤ capacity := by
  intro demand capacity
  rw [Nat.min_eq_min]
  rw [Nat.min_def]
  split
  case isTrue h => exact ⟨Nat.le_refl demand, h⟩
  case isFalse h =>
    exact ⟨Nat.le_of_lt (Nat.lt_of_not_ge h), Nat.le_refl capacity⟩
This exact declaration preserves the registry's explicit-∀ expectedType source identity and has been audited under the pinned Lean toolchain with no axioms.`;

const FORMAL_TRAJECTORY_PREFIX_AXIOM_FREE_INSTRUCTION = `
For the exact registry-bound trajectory_prefix_length_safety obligation, use this already kernel-audited declaration verbatim:
theorem trajectory_prefix_length_safety : ∀ {α : Type} (trajectory : List α) (horizon : Nat), (trajectory.take horizon).length ≤ trajectory.length := by
  intro α trajectory horizon
  induction horizon generalizing trajectory with
  | zero => exact Nat.zero_le trajectory.length
  | succ horizon ih =>
    cases trajectory with
    | nil => exact Nat.le_refl 0
    | cons head tail => exact Nat.succ_le_succ (ih tail)
This exact declaration preserves the registry's explicit-∀ expectedType source identity and has been audited under the pinned Lean toolchain with no axioms.`;

const FORMAL_REGISTRY_AXIOM_FREE_INSTRUCTIONS = Object.freeze({
  feasible_allocation_bounds: FORMAL_FEASIBLE_ALLOCATION_AXIOM_FREE_INSTRUCTION,
  length_filter_le: FORMAL_SCHEDULE_FILTER_AXIOM_FREE_INSTRUCTION,
  loss_cap_upper_bound: FORMAL_LOSS_CAP_AXIOM_FREE_INSTRUCTION,
  panel_retention_accounting: FORMAL_PANEL_RETENTION_AXIOM_FREE_INSTRUCTION,
  trajectory_prefix_length_safety: FORMAL_TRAJECTORY_PREFIX_AXIOM_FREE_INSTRUCTION,
});

export function formalProofSearchStrategyInstructions(candidate) {
  if (candidate?.strategy === 'direct_elaboration') {
    return 'Compile the exact authorized theorem type incrementally, inspect every remaining Lean proof state, and construct the smallest direct proof term or tactic proof. Do not guess that a tactic closed a goal: rerun Lean and retain only an elaborating candidate.';
  }
  if (candidate?.strategy === 'mathlib_retrieval') {
    return 'Reinspect the current Lean proof states, then search only the pinned local Mathlib environment for matching declarations and tactics (for example #check, exact?, apply?, library_search, source/symbol search). Use fully qualified declarations where ambiguity exists and rerun Lean after every material change. Network retrieval and new dependencies are forbidden.';
  }
  if (candidate?.strategy === 'bounded_refutation_or_synthesis') {
    return 'Before another proof attempt, use bounded examples or decidable finite instances where available to look for a counterexample to the exact authorized proposition. A found example is diagnostic and must never be repaired by weakening or changing the claim. Failure to find an example is not evidence of truth. If no counterexample is found, make one final proof-state-driven synthesis attempt using only the pinned imports; only kernel success establishes a proof.';
  }
  throw new Error('formal_proof_search_candidate_strategy_invalid');
}

export function formalObligationSpecificInstructions(theoremSpecification) {
  const exactTemplates = theoremSpecification?.claimAuthorityType
      === 'machine-policy-authorized'
    && theoremSpecification?.proposalClaimLineageRequired === true
    ? theoremSpecification?.claims?.map((claim) => (
      exactAutonomousFormalSupportTemplateForTheoremClaim({
        theoremSpecification,
        claim,
      })
    )).filter(Boolean) : [];
  if (!exactTemplates?.length) return '';
  return exactTemplates.map((template) => {
    const instructions = FORMAL_REGISTRY_AXIOM_FREE_INSTRUCTIONS[
      template.leanTypeContract.canonicalTheoremName
    ];
    if (!instructions) {
      const error = new Error(
        `formal_registry_template_execution_closure_unavailable:${
          template.leanTypeContract.canonicalTheoremName}`,
      );
      error.retryable = false;
      throw error;
    }
    return instructions;
  }).join('');
}
