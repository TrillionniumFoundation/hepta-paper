export const SYSTEM_ALLOWED_FORMAL_AXIOMS = Object.freeze([]);

export function formalAxiomPolicyBlockers(requested = []) {
  const allowed = new Set(SYSTEM_ALLOWED_FORMAL_AXIOMS);
  return [...new Set((Array.isArray(requested) ? requested : []).map(String))]
    .filter((axiom) => !allowed.has(axiom))
    .map((axiom) => `formal_caller_axiom_allowlist_forbidden:${axiom}`);
}
