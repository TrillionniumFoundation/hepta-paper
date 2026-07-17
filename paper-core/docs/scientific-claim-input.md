# Scientific claim input authority

The deterministic proposal generator produces planning language. Planning language
is not a theorem. A proposal using the `formal_theorem_or_proof` quality profile
therefore fails closed until an operator supplies `--scientific-claim-document`.

The input is deliberately narrow and exact-keyed:

```json
{
  "version": 1,
  "kind": "PaperScientificClaimInput",
  "claims": [
    {
      "claimKey": "bounded-convergence",
      "statement": "For every operator satisfying ..., the iterates converge ... .",
      "assumptions": ["The operator is a contraction on ... ."],
      "quantifiers": ["For every operator and initial point satisfying ... ."],
      "negativeBoundaries": ["No claim is made when ... ."],
      "proofObligations": ["Prove existence, uniqueness, and convergence."]
    }
  ]
}
```

Every list must be non-empty. Claim keys and statements must be unique. Placeholder
text such as `TODO` or `TBD`, extra keys, empty fields, oversized fields, more than
12 claims, or more than 16 projected proof obligations are rejected.

The adapter canonicalizes this input into the `PaperProposalEnvelope`. The envelope
hash covers the complete structured record, while the approval document also lists
the per-statement claim hashes. Consequently, changing an assumption, quantifier,
negative boundary, proof obligation, or statement after approval changes the
envelope hash and invalidates the approval.

Materialization writes the canonical `SCIENTIFIC_CLAIM_INPUT.json` and copies each
structured claim into the hash-bound proposal seed contract. The formal writer may
only express those approved claims, and theorem-spec finalization binds each theorem
one-to-one to its proposal claim. Independent semantic review accepts only exact
semantic equivalence; scope changes require a new proposal and approval.

This boundary records what an operator authorized. It does not claim that the input
is novel, scientifically correct, or formally proved. Those remain separate
literature, empirical, semantic-review, and Lean/Lake verification obligations.
