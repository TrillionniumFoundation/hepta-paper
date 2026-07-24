import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyFormalReadableProofExplanationBundle,
} from '../research/formal-readable-proof-contract.mjs';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const FAMILY_IDS = Object.freeze([
  'econometrics_panel_benchmark',
  'finance_asset_pricing_benchmark',
  'ml_algorithm_benchmark',
  'operations_optimization_benchmark',
  'registered_scalar_response_benchmark',
  'rl_stochastic_control_benchmark',
]);

export const AUTONOMOUS_FORMAL_MANUSCRIPT_PROOF =
  'This proof exposition is a human-readable projection of the named obligation and Lean declaration; the kernel-checked artifact remains the proof authority.';

const SHARED_NEGATIVE_BOUNDARIES = Object.freeze([
  'This theorem proves only the stated protocol or numerical safety invariant, not the empirical outcome hypothesis.',
  'No observed metric, treatment effect, statistical verdict, or replay result is introduced as an axiom.',
  'Kernel verification of the Lean statement does not prove natural-language-to-Lean semantic equivalence, scientific novelty, or external validity.',
]);

const PROOF_EXPOSITION_STEPS = Object.freeze({
  panel_retention_accounting: Object.freeze([
    Object.freeze({
      stepId: 'base-retained-zero',
      statement: 'When the retained count is zero, natural-number subtraction leaves the scheduled count unchanged and adding zero preserves it.',
      leanReferences: Object.freeze(['Nat.add_zero']),
    }),
    Object.freeze({
      stepId: 'successor-reduction',
      statement: 'For positive retained and scheduled counts, remove one successor from both sides; the retention bound supplies the smaller induction hypothesis.',
      leanReferences: Object.freeze(['Nat.succ_sub_succ_eq_sub', 'Nat.le_of_succ_le_succ']),
    }),
    Object.freeze({
      stepId: 'induction-close',
      statement: 'Apply the induction hypothesis to the reduced counts and restore the successor to obtain the original accounting identity.',
      leanReferences: Object.freeze(['congrArg', 'Nat.add_succ']),
    }),
  ]),
  loss_cap_upper_bound: Object.freeze([
    Object.freeze({
      stepId: 'minimum-case-split',
      statement: 'Split on whether the observed loss is no greater than the cap, which determines which argument is returned by the natural-number minimum.',
      leanReferences: Object.freeze(['Nat.min_def']),
    }),
    Object.freeze({
      stepId: 'bounded-branches',
      statement: 'In the loss branch the comparison is the required bound; in the cap branch the result is bounded by reflexivity.',
      leanReferences: Object.freeze(['Nat.le_refl']),
    }),
  ]),
  length_filter_le: Object.freeze([
    Object.freeze({
      stepId: 'schedule-induction',
      statement: 'Induct on the finite schedule; the empty schedule has equal original and filtered lengths.',
      leanReferences: Object.freeze(['List.filter', 'Nat.le_refl']),
    }),
    Object.freeze({
      stepId: 'rejected-head',
      statement: 'If the head is rejected, the filtered length is the filtered tail length, which is at most the successor of the original tail length.',
      leanReferences: Object.freeze(['Nat.le_succ_of_le']),
    }),
    Object.freeze({
      stepId: 'accepted-head',
      statement: 'If the head is accepted, both lengths gain one and successor monotonicity lifts the induction hypothesis.',
      leanReferences: Object.freeze(['Nat.succ_le_succ']),
    }),
  ]),
  feasible_allocation_bounds: Object.freeze([
    Object.freeze({
      stepId: 'allocation-case-split',
      statement: 'Split on whether demand is no greater than capacity, which fixes the value of the minimum allocation.',
      leanReferences: Object.freeze(['Nat.min_def']),
    }),
    Object.freeze({
      stepId: 'joint-bounds',
      statement: 'Whichever input is selected, reflexivity gives one bound and the branch comparison gives the other, establishing the conjunction.',
      leanReferences: Object.freeze(['Nat.le_refl', 'Nat.le_of_lt', 'Nat.lt_of_not_ge']),
    }),
  ]),
  registered_scalar_interval_preservation: Object.freeze([
    Object.freeze({
      stepId: 'registered-lower-bound',
      statement: 'Use the preregistered lower-bound premise for the scalar response without weakening or estimating it.',
      leanReferences: Object.freeze(['And.intro']),
    }),
    Object.freeze({
      stepId: 'registered-upper-bound',
      statement: 'Use the preregistered upper-bound premise and combine both premises into the required interval conjunction.',
      leanReferences: Object.freeze(['And.intro']),
    }),
  ]),
  trajectory_prefix_length_safety: Object.freeze([
    Object.freeze({
      stepId: 'horizon-induction',
      statement: 'Induct on the horizon; a zero-length prefix is bounded by every trajectory length.',
      leanReferences: Object.freeze(['Nat.zero_le']),
    }),
    Object.freeze({
      stepId: 'trajectory-cases',
      statement: 'For a successor horizon, the empty trajectory is immediate; a nonempty trajectory reduces to the tail at the smaller horizon.',
      leanReferences: Object.freeze(['List.take']),
    }),
    Object.freeze({
      stepId: 'successor-close',
      statement: 'Successor monotonicity lifts the induction hypothesis from the tail to the full trajectory.',
      leanReferences: Object.freeze(['Nat.succ_le_succ']),
    }),
  ]),
});

function rawTemplate({
  protocolFamily,
  templateId,
  canonicalTheoremName,
  statement,
  assumptions,
  quantifiers,
  proofObligation,
  leanType,
}) {
  const scope = Object.freeze({
    statement,
    assumptions: Object.freeze(assumptions),
    quantifiers: Object.freeze(quantifiers),
    negativeBoundaries: SHARED_NEGATIVE_BOUNDARIES,
    proofObligations: Object.freeze([proofObligation]),
  });
  const leanTypeContractPayload = Object.freeze({
    version: 1,
    language: 'lean4',
    canonicalTheoremName,
    proofObligation,
    expectedType: leanType,
    assuranceScope: 'system-owned-exact-type-compilation-audit-v1',
  });
  const leanTypeContract = Object.freeze({
    ...leanTypeContractPayload,
    autonomousFormalLeanTypeContractHash:
      hashRecord('AutonomousFormalLeanTypeContract', leanTypeContractPayload),
  });
  const proofSteps = PROOF_EXPOSITION_STEPS[proofObligation];
  if (!proofSteps?.length) throw new Error('autonomous_formal_proof_exposition_missing');
  const proofExpositionPayload = Object.freeze({
    version: 1,
    kind: 'AutonomousFormalProofExposition',
    obligationId: proofObligation,
    leanDeclaration: canonicalTheoremName,
    leanTypeContractHash: leanTypeContract.autonomousFormalLeanTypeContractHash,
    steps: proofSteps,
    assuranceScope: 'human-readable-obligation-projection-kernel-artifact-authoritative-v1',
  });
  const proofExposition = Object.freeze({
    ...proofExpositionPayload,
    autonomousFormalProofExpositionHash:
      hashRecord('AutonomousFormalProofExposition', proofExpositionPayload),
  });
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousFormalSupportTemplate',
    protocolFamily,
    templateId,
    scope,
    scopeHash: hashRecord('AutonomousFormalSupportTemplateScope', scope),
    leanTypeContract,
    proofExposition,
    empiricalOutcomeClaimed: false,
    naturalLanguageToLeanEquivalenceMachineProven: false,
  });
  return Object.freeze({
    ...payload,
    autonomousFormalSupportTemplateHash:
      hashRecord('AutonomousFormalSupportTemplate', payload),
  });
}

const TEMPLATES = Object.freeze({
  econometrics_panel_benchmark: rawTemplate({
    protocolFamily: 'econometrics_panel_benchmark',
    templateId: 'hepta.formal.panel-retention-accounting.v1',
    canonicalTheoremName: 'panel_retention_accounting',
    statement: 'For every scheduled panel-cell count and retained panel-cell count, if the retained count does not exceed the scheduled count, then the dropped-cell count plus the retained-cell count equals the scheduled-cell count.',
    assumptions: [
      'Scheduled and retained panel-cell counts are represented by natural numbers.',
      'The retained panel-cell count is no greater than the scheduled panel-cell count.',
      'The dropped-cell count is defined by natural-number subtraction of retained cells from scheduled cells.',
    ],
    quantifiers: ['For every pair of natural numbers representing scheduled and retained panel-cell counts.'],
    proofObligation: 'panel_retention_accounting',
    leanType: '∀ (scheduledCells retainedCells : Nat), retainedCells ≤ scheduledCells → scheduledCells - retainedCells + retainedCells = scheduledCells',
  }),
  finance_asset_pricing_benchmark: rawTemplate({
    protocolFamily: 'finance_asset_pricing_benchmark',
    templateId: 'hepta.formal.loss-cap-upper-bound.v1',
    canonicalTheoremName: 'loss_cap_upper_bound',
    statement: 'For every nonnegative integer loss and preregistered nonnegative integer loss cap, clipping the loss at the cap produces a value no greater than the cap.',
    assumptions: [
      'The loss and preregistered cap are represented by natural numbers.',
      'Clipping is defined as the minimum of the observed loss and the preregistered cap.',
    ],
    quantifiers: ['For every pair of natural numbers representing an observed loss and a preregistered loss cap.'],
    proofObligation: 'loss_cap_upper_bound',
    leanType: '∀ (loss cap : Nat), Nat.min loss cap ≤ cap',
  }),
  ml_algorithm_benchmark: rawTemplate({
    protocolFamily: 'ml_algorithm_benchmark',
    templateId: 'hepta.formal.schedule-filter-length-safety.v1',
    canonicalTheoremName: 'length_filter_le',
    statement: 'For every finite evaluation schedule and Boolean acceptance predicate, filtering the schedule to accepted entries produces a sublist whose length is at most the length of the original schedule.',
    assumptions: [
      'The evaluation schedule is represented by a finite list.',
      'Accepted schedule entries are defined by filtering that list with the Boolean acceptance predicate.',
    ],
    quantifiers: ['For every element type, finite schedule list, and Boolean acceptance predicate over its elements.'],
    proofObligation: 'length_filter_le',
    leanType: '∀ {α : Type} (schedule : List α) (accept : α → Bool), (schedule.filter accept).length ≤ schedule.length',
  }),
  operations_optimization_benchmark: rawTemplate({
    protocolFamily: 'operations_optimization_benchmark',
    templateId: 'hepta.formal.feasible-allocation-bounds.v1',
    canonicalTheoremName: 'feasible_allocation_bounds',
    statement: 'For every nonnegative integer demand and capacity, the feasible allocation defined as their minimum does not exceed either demand or capacity.',
    assumptions: [
      'Demand and capacity are represented by natural numbers.',
      'The feasible allocation is defined as the minimum of demand and capacity.',
    ],
    quantifiers: ['For every pair of natural numbers representing demand and capacity.'],
    proofObligation: 'feasible_allocation_bounds',
    leanType: '∀ (demand capacity : Nat), Nat.min demand capacity ≤ demand ∧ Nat.min demand capacity ≤ capacity',
  }),
  registered_scalar_response_benchmark: rawTemplate({
    protocolFamily: 'registered_scalar_response_benchmark',
    templateId: 'hepta.formal.registered-scalar-interval-preservation.v1',
    canonicalTheoremName: 'registered_scalar_interval_preservation',
    statement: 'For every preregistered lower bound, scalar response, and preregistered upper bound, the two verified bound premises imply that the response belongs to the registered interval.',
    assumptions: [
      'The scalar response and preregistered interval endpoints are represented by real numbers.',
      'The lower-bound and upper-bound premises are supplied as explicit proof obligations rather than inferred from empirical outcomes.',
    ],
    quantifiers: ['For every real-valued lower endpoint, scalar response, and upper endpoint.'],
    proofObligation: 'registered_scalar_interval_preservation',
    leanType: '∀ (lower response upper : Real), lower ≤ response → response ≤ upper → lower ≤ response ∧ response ≤ upper',
  }),
  rl_stochastic_control_benchmark: rawTemplate({
    protocolFamily: 'rl_stochastic_control_benchmark',
    templateId: 'hepta.formal.trajectory-prefix-length-safety.v1',
    canonicalTheoremName: 'trajectory_prefix_length_safety',
    statement: 'For every finite trajectory and natural-number evaluation horizon, the length of the trajectory prefix truncated at that horizon is at most the length of the original trajectory.',
    assumptions: [
      'The trajectory is represented by a finite list.',
      'Horizon truncation is represented by taking a prefix of the trajectory list.',
    ],
    quantifiers: ['For every state type, finite trajectory list, and natural-number evaluation horizon.'],
    proofObligation: 'trajectory_prefix_length_safety',
    leanType: '∀ {α : Type} (trajectory : List α) (horizon : Nat), (trajectory.take horizon).length ≤ trajectory.length',
  }),
});

const registryPayload = Object.freeze({
  version: 1,
  kind: 'AutonomousFormalSupportTemplateRegistry',
  status: 'autonomous_formal_support_registry_ready',
  protocolFamilies: FAMILY_IDS,
  entries: Object.freeze(FAMILY_IDS.map((family) => TEMPLATES[family])),
  selectionPolicy: 'exact-analysis-protocol-family-v1',
  empiricalOutcomeTheoremsPermitted: false,
  naturalLanguageToLeanEquivalenceMachineProven: false,
});

export const AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE_REGISTRY = Object.freeze({
  ...registryPayload,
  autonomousFormalSupportTemplateRegistryHash:
    hashRecord('AutonomousFormalSupportTemplateRegistry', registryPayload),
});

export function selectAutonomousFormalSupportTemplate(protocolFamily) {
  const template = TEMPLATES[String(protocolFamily || '')];
  if (!template) throw new Error('autonomous_formal_support_protocol_family_unsupported');
  return template;
}

export function resolveAutonomousFormalSupportTemplateForClaim(claim) {
  const matches = FAMILY_IDS.map((family) => TEMPLATES[family]).filter((template) => (
    hashRecord('AutonomousFormalSupportTemplateScope', claim)
      === template.scopeHash
  ));
  if (matches.length !== 1) {
    throw new Error('autonomous_formal_support_claim_not_registry_bound');
  }
  return matches[0];
}

export function verifyAutonomousFormalSupportTemplate(value, { protocolFamily = null } = {}) {
  let expected = null;
  try { expected = selectAutonomousFormalSupportTemplate(protocolFamily || value?.protocolFamily); }
  catch { return false; }
  return exactKeys(value, Object.keys(expected))
    && JSON.stringify(value) === JSON.stringify(expected);
}

export function autonomousFormalLeanTypeContractForObligation(proofObligation) {
  const obligation = String(proofObligation || '');
  if (!IDENTIFIER.test(obligation)) return null;
  const matches = FAMILY_IDS.map((family) => TEMPLATES[family]).filter(
    (template) => template.leanTypeContract.proofObligation === obligation,
  );
  if (matches.length !== 1) return null;
  return matches[0].leanTypeContract;
}

export function autonomousFormalTypeAuditForObligation({ proofObligation, theoremName } = {}) {
  const name = String(theoremName || '');
  const contract = autonomousFormalLeanTypeContractForObligation(proofObligation);
  if (!contract
    || !/^[A-Za-z_][A-Za-z0-9_'.]*(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/.test(name)) return null;
  return `#check (${name} : ${contract.expectedType})`;
}

function seedBundleHashValid(seedBundle) {
  const { autonomousResearchSeedContractBundleHash: claimedHash, ...payload } = seedBundle || {};
  return Boolean(claimedHash
    && hashRecord('AutonomousResearchSeedContractBundle', payload) === claimedHash);
}

function proposalHashValid(proposal) {
  const { machineProposedScientificClaimSetHash: claimedHash, ...payload } = proposal || {};
  return Boolean(claimedHash
    && hashRecord('MachineProposedScientificClaimSet', payload) === claimedHash);
}

function latexEscape(value) {
  return String(value || '').replace(/\\/g, '\\textbackslash{}').replace(/([#$%&_{}])/g, '\\$1');
}

function renderAutonomousFormalProofExposition(template) {
  const exposition = template.proofExposition;
  return [
    AUTONOMOUS_FORMAL_MANUSCRIPT_PROOF,
    `\\paragraph{Bound formal obligation.} Obligation \\texttt{${latexEscape(exposition.obligationId)}} is discharged by Lean declaration \\texttt{${latexEscape(exposition.leanDeclaration)}} under exact type-contract hash \\texttt{${latexEscape(exposition.leanTypeContractHash)}}.`,
    '\\begin{enumerate}',
    ...exposition.steps.map((step) => (
      `\\item[\\texttt{${latexEscape(step.stepId)}}] ${latexEscape(step.statement)} Lean references: ${step.leanReferences.map((reference) => `\\texttt{${latexEscape(reference)}}`).join(', ')}.`
    )),
    '\\end{enumerate}',
    'These paragraphs explain the registered proof structure; acceptance still requires the separately hash-bound Lean source, exact declaration-type audit, axiom audit, and fresh kernel replay.',
  ].join('\n');
}

function dynamicFormalProofBody({ seed, claimBinding } = {}) {
  return [
    AUTONOMOUS_FORMAL_MANUSCRIPT_PROOF,
    `\\paragraph{Bound dynamic formal obligation.} The machine-declared Lean type is bound by dynamic seed hash \\texttt{${latexEscape(seed.dynamicFormalClaimSeedHash)}} and normalized type hash \\texttt{${latexEscape(seed.leanNormalizedTypeHash)}}.`,
    `The exact declaration \\texttt{${latexEscape(seed.leanDeclarationName)}} is bound to formal claim contract \\texttt{${latexEscape(claimBinding.formalClaimContract.formalClaimContractHash)}}.`,
    'Admission requires an exact-type kernel check, axiom audit, and fresh replay. Their content-addressed certificates remain in the release evidence bundle instead of being copied into proof prose, so a post-render verification does not make the exposition self-referential. The natural-language/Lean equivalence remains an independently reviewed semantic assertion rather than a kernel theorem.',
  ].join('\n');
}

function readableDynamicFormalProofBody({ seed, claimBinding, explanation } = {}) {
  const proofPrint = latexEscape(explanation.proofPrintText)
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\r?\n/g, '\\\\\n');
  return [
    AUTONOMOUS_FORMAL_MANUSCRIPT_PROOF,
    `\\paragraph{Exact dynamic formal goal.} Declaration \\texttt{${latexEscape(seed.leanDeclarationName)}} was checked against the exact Lean goal \\texttt{${latexEscape(explanation.theoremTypeSource)}}.`,
    '\\begin{enumerate}',
    ...explanation.readableSteps.map((step) => `\\item ${latexEscape(step)}`),
    '\\end{enumerate}',
    '\\paragraph{Kernel-elaborated declaration projection.}',
    `\\begin{flushleft}\\ttfamily ${proofPrint}\\end{flushleft}`,
    `The explanation DAG is bound to formal claim contract \\texttt{${latexEscape(claimBinding.formalClaimContract.formalClaimContractHash)}} and dynamic seed \\texttt{${latexEscape(seed.dynamicFormalClaimSeedHash)}}. It is a deterministic projection of Lean's elaborated declaration printout, not a machine proof that this prose is mathematically equivalent to the proof term or to the natural-language theorem.`,
  ].join('\n');
}

function buildDynamicFormalSupportSurfaceAuthority({
  proposal,
  seedBundle,
  formalVerificationReceipt,
} = {}) {
  const formalSeedClaims = (seedBundle?.claims || []).filter(
    (claim) => claim?.verificationMode === 'formal_kernel',
  );
  const seedClaim = formalSeedClaims[0];
  const seed = seedBundle?.dynamicFormalClaimSeed;
  const formalWorkerReceipts = formalVerificationReceipt?.nativeResearchWorkerExecution
    ?.workerReceipts?.filter((receipt) => receipt?.workerType === 'formal_verifier_lake') || [];
  const certificateBundle = formalWorkerReceipts.length === 1
    ? formalWorkerReceipts[0].result : null;
  const claimBindings = certificateBundle?.claimBindings || [];
  const claimBinding = claimBindings.find((binding) => (
    binding?.formalClaimContract?.dynamicFormalClaimAuthority?.dynamicFormalClaimSeedHash
      === seed?.dynamicFormalClaimSeedHash
  )) || null;
  const replayReceipt = certificateBundle?.replayReceipt || null;
  const readableProofBundle = certificateBundle?.readableProofExplanationBundle || null;
  const readableProofVerification = readableProofBundle
    ? verifyFormalReadableProofExplanationBundle(readableProofBundle) : null;
  const readableProofExplanation = readableProofVerification?.valid
    ? readableProofBundle.explanations.find((item) => (
      item?.claimId === claimBinding?.claimId
      && item?.theoremName === seed?.leanDeclarationName
      && item?.theoremTypeHash === seed?.leanNormalizedTypeHash
    )) || null : null;
  if (!proposalHashValid(proposal) || proposal?.version !== 2
    || proposal?.formalSupportMode !== 'dynamic-lean-type-v1'
    || !seedBundleHashValid(seedBundle) || seedBundle?.version !== 2
    || seedBundle?.formalSupportMode !== 'dynamic-lean-type-v1'
    || formalSeedClaims.length !== 1
    || seedBundle?.dynamicFormalClaimSeedHash !== seed?.dynamicFormalClaimSeedHash
    || seedClaim?.dynamicFormalClaimSeedHash !== seed?.dynamicFormalClaimSeedHash
    || seedClaim?.leanDeclarationName !== seed?.leanDeclarationName
    || seedClaim?.leanNormalizedTypeHash !== seed?.leanNormalizedTypeHash
    || formalVerificationReceipt?.status !== 'campaign_formal_verification_completed'
    || (formalVerificationReceipt?.blockers || []).length !== 0
    || formalWorkerReceipts.length !== 1
    || certificateBundle?.status !== 'formal_claim_verified'
    || !claimBinding
    || claimBinding.theoremName !== seed?.leanDeclarationName
    || claimBinding.expectedTypeHash !== seed?.leanNormalizedTypeHash
    || claimBinding.formalClaimContract?.status !== 'formal_claim_contract_verified'
    || replayReceipt?.status !== 'formal_claim_replay_verified'
    || !replayReceipt?.formalCertificateReplayReceiptHash) {
    throw new Error('autonomous_dynamic_formal_support_surface_authority_invalid');
  }
  const theoremBody = latexEscape(seedClaim.text);
  const proofBody = readableProofExplanation
    ? readableDynamicFormalProofBody({ seed, claimBinding, explanation: readableProofExplanation })
    : dynamicFormalProofBody({ seed, claimBinding });
  const proofExpositionHash = hashBytes(Buffer.from(proofBody, 'utf8'));
  const payload = Object.freeze({
    version: readableProofExplanation ? 3 : 2,
    kind: 'AutonomousFormalSupportSurfaceAuthority',
    status: 'autonomous_formal_support_surface_authorized',
    paperId: proposal.paperId,
    protocolFamily: proposal.protocolFamily,
    formalSupportMode: 'dynamic-lean-type-v1',
    formalSupportRegistryHash: null,
    formalSupportTemplateId: null,
    formalSupportTemplateHash: null,
    leanTypeContractHash: seed.leanNormalizedTypeHash,
    proofExpositionHash,
    dynamicFormalClaimSeedHash: seed.dynamicFormalClaimSeedHash,
    formalClaimContractHash: claimBinding.formalClaimContract.formalClaimContractHash,
    kernelCertificateBundleHash: certificateBundle.certificateBundleHash,
    kernelReplayReceiptHash: replayReceipt.formalCertificateReplayReceiptHash,
    ...(readableProofExplanation ? {
      readableProofExplanationBundleHash:
        readableProofBundle.formalReadableProofExplanationBundleHash,
      readableProofExplanationHash:
        readableProofExplanation.formalReadableProofExplanationHash,
      readableProofExplanationDagHash: readableProofExplanation.explanationDagHash,
      readableProofScope: readableProofExplanation.machineVerificationScope,
      productionReadableProofReady: true,
    } : {
      productionReadableProofReady: false,
    }),
    proposalHash: proposal.machineProposedScientificClaimSetHash,
    seedBundleHash: seedBundle.autonomousResearchSeedContractBundleHash,
    proposalClaimId: seedClaim.id,
    proposalClaimRecordHash: hashRecord('AutonomousResearchClaimRecord', seedClaim),
    theoremBody,
    theoremBodyHash: hashBytes(Buffer.from(theoremBody, 'utf8')),
    proofBody,
    proofBodyHash: hashBytes(Buffer.from(proofBody, 'utf8')),
    empiricalOutcomeClaimed: false,
    naturalLanguageToLeanEquivalenceMachineProven: false,
  });
  return Object.freeze({
    ...payload,
    autonomousFormalSupportSurfaceAuthorityHash:
      hashRecord('AutonomousFormalSupportSurfaceAuthority', payload),
  });
}

export function buildAutonomousFormalSupportSurfaceAuthority({
  proposal,
  seedBundle,
  formalVerificationReceipt = null,
} = {}) {
  if (proposal?.version === 2) {
    return buildDynamicFormalSupportSurfaceAuthority({
      proposal,
      seedBundle,
      formalVerificationReceipt,
    });
  }
  const template = selectAutonomousFormalSupportTemplate(proposal?.protocolFamily);
  const formalProposalClaims = (proposal?.claims || []).filter(
    (claim) => claim?.verificationMode === 'formal_kernel',
  );
  const formalSeedClaims = (seedBundle?.claims || []).filter(
    (claim) => claim?.verificationMode === 'formal_kernel',
  );
  const proposalClaim = formalProposalClaims[0];
  const seedClaim = formalSeedClaims[0];
  const expectedSeedClaim = proposalClaim ? {
    id: `${proposal.paperId}:autonomous_claim:${proposal.claims.indexOf(proposalClaim) + 1}`,
    kind: 'machine_proposed_claim_seed',
    status: 'machine_proposed_policy_authorized_for_bounded_execution',
    text: proposalClaim.statement,
    scientificClaimKey: proposalClaim.claimKey,
    verificationMode: proposalClaim.verificationMode,
    assumptions: proposalClaim.assumptions,
    quantifiers: proposalClaim.quantifiers,
    negativeBoundaries: proposalClaim.negativeBoundaries,
    proofObligations: proposalClaim.proofObligations,
    empiricalObligations: proposalClaim.empiricalObligations,
    machineProposedScientificClaimSetHash: proposal.machineProposedScientificClaimSetHash,
  } : null;
  if (!proposalHashValid(proposal)
    || formalProposalClaims.length !== 1 || formalSeedClaims.length !== 1
    || proposal?.claims?.length !== 2 || seedBundle?.claims?.length !== 2
    || !seedBundleHashValid(seedBundle)
    || seedBundle?.kind !== 'AutonomousResearchSeedContractBundle'
    || seedBundle?.status !== 'autonomous_research_seed_contracts_ready'
    || seedBundle?.claimAuthorityType !== 'machine-policy-authorized'
    || seedBundle?.paperId !== proposal?.paperId
    || seedBundle?.proposalHash !== proposal?.machineProposedScientificClaimSetHash
    || seedBundle?.scientificClaimInputHash !== proposal?.machineProposedScientificClaimSetHash
    || (seedBundle?.blockers || []).length !== 0
    || proposal?.formalSupportTemplateId !== template.templateId
    || proposal?.formalSupportTemplateHash !== template.autonomousFormalSupportTemplateHash
    || proposal?.formalSupportRegistryHash
      !== AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE_REGISTRY.autonomousFormalSupportTemplateRegistryHash
    || seedBundle?.protocolFamily !== proposal?.protocolFamily
    || seedBundle?.formalSupportTemplateId !== proposal?.formalSupportTemplateId
    || seedBundle?.formalSupportTemplateHash !== proposal?.formalSupportTemplateHash
    || seedBundle?.formalSupportRegistryHash !== proposal?.formalSupportRegistryHash
    || JSON.stringify(seedClaim) !== JSON.stringify(expectedSeedClaim)
    || hashRecord('AutonomousFormalSupportTemplateScope', {
      statement: proposalClaim?.statement,
      assumptions: proposalClaim?.assumptions,
      quantifiers: proposalClaim?.quantifiers,
      negativeBoundaries: proposalClaim?.negativeBoundaries,
      proofObligations: proposalClaim?.proofObligations,
    }) !== template.scopeHash) {
    throw new Error('autonomous_formal_support_surface_authority_invalid');
  }
  const theoremBody = latexEscape(seedClaim.text);
  const proofBody = renderAutonomousFormalProofExposition(template);
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousFormalSupportSurfaceAuthority',
    status: 'autonomous_formal_support_surface_authorized',
    paperId: proposal.paperId,
    protocolFamily: proposal.protocolFamily,
    formalSupportRegistryHash: proposal.formalSupportRegistryHash,
    formalSupportTemplateId: template.templateId,
    formalSupportTemplateHash: template.autonomousFormalSupportTemplateHash,
    leanTypeContractHash: template.leanTypeContract.autonomousFormalLeanTypeContractHash,
    proofExpositionHash: template.proofExposition.autonomousFormalProofExpositionHash,
    proposalHash: proposal.machineProposedScientificClaimSetHash,
    seedBundleHash: seedBundle.autonomousResearchSeedContractBundleHash,
    proposalClaimId: seedClaim.id,
    proposalClaimRecordHash: hashRecord('AutonomousResearchClaimRecord', seedClaim),
    theoremBody,
    theoremBodyHash: hashBytes(Buffer.from(theoremBody, 'utf8')),
    proofBody,
    proofBodyHash: hashBytes(Buffer.from(proofBody, 'utf8')),
    empiricalOutcomeClaimed: false,
    naturalLanguageToLeanEquivalenceMachineProven: false,
  });
  return Object.freeze({
    ...payload,
    autonomousFormalSupportSurfaceAuthorityHash:
      hashRecord('AutonomousFormalSupportSurfaceAuthority', payload),
  });
}

export function autonomousFormalSupportMarkerDeclaration(authority) {
  if (!verifyAutonomousFormalSupportSurfaceAuthority(authority)) {
    throw new Error('autonomous_formal_support_surface_authority_invalid');
  }
  return Object.freeze({
    version: 1,
    surfaceId: [2, 3].includes(authority.version)
      ? `formal-support:dynamic:${authority.dynamicFormalClaimSeedHash.slice('sha256:'.length)}`
      : `formal-support:${authority.formalSupportTemplateId}`,
    authorityHash: authority.autonomousFormalSupportSurfaceAuthorityHash,
    templateHash: authority.formalSupportTemplateHash,
    proofExpositionHash: authority.proofExpositionHash,
    proposalClaimRecordHash: authority.proposalClaimRecordHash,
    theoremBodyHash: authority.theoremBodyHash,
    proofBodyHash: authority.proofBodyHash,
    ...([2, 3].includes(authority.version) ? {
      dynamicFormalClaimSeedHash: authority.dynamicFormalClaimSeedHash,
      formalClaimContractHash: authority.formalClaimContractHash,
      kernelReplayReceiptHash: authority.kernelReplayReceiptHash,
      ...(authority.version === 3 ? {
        readableProofExplanationHash: authority.readableProofExplanationHash,
        readableProofExplanationDagHash: authority.readableProofExplanationDagHash,
      } : {}),
    } : {}),
  });
}

export function verifyAutonomousFormalSupportSurfaceAuthority(value) {
  if (!value || ![1, 2, 3].includes(value.version) || value.kind !== 'AutonomousFormalSupportSurfaceAuthority'
    || value.status !== 'autonomous_formal_support_surface_authorized'
    || value.empiricalOutcomeClaimed !== false
    || value.naturalLanguageToLeanEquivalenceMachineProven !== false) return false;
  if ([2, 3].includes(value.version)) {
    const { autonomousFormalSupportSurfaceAuthorityHash: claimedHash, ...payload } = value;
    return value.formalSupportMode === 'dynamic-lean-type-v1'
      && value.formalSupportRegistryHash === null
      && value.formalSupportTemplateId === null
      && value.formalSupportTemplateHash === null
      && value.productionReadableProofReady === (value.version === 3)
      && [
        value.leanTypeContractHash,
        value.proofExpositionHash,
        value.dynamicFormalClaimSeedHash,
        value.formalClaimContractHash,
        value.kernelCertificateBundleHash,
        value.kernelReplayReceiptHash,
        value.proposalHash,
        value.seedBundleHash,
        value.proposalClaimRecordHash,
        value.theoremBodyHash,
        value.proofBodyHash,
        ...(value.version === 3 ? [
          value.readableProofExplanationBundleHash,
          value.readableProofExplanationHash,
          value.readableProofExplanationDagHash,
        ] : []),
      ].every((hash) => /^sha256:[0-9a-f]{64}$/.test(String(hash || '')))
      && (value.version !== 3 || value.readableProofScope
        === 'exact-type-source-and-kernel-elaborated-declaration-reference-dag-v1')
      && value.theoremBodyHash === hashBytes(Buffer.from(value.theoremBody, 'utf8'))
      && value.proofExpositionHash === hashBytes(Buffer.from(value.proofBody, 'utf8'))
      && value.proofBodyHash === hashBytes(Buffer.from(value.proofBody, 'utf8'))
      && claimedHash === hashRecord('AutonomousFormalSupportSurfaceAuthority', payload);
  }
  let template;
  try { template = selectAutonomousFormalSupportTemplate(value.protocolFamily); }
  catch { return false; }
  const { autonomousFormalSupportSurfaceAuthorityHash: claimedHash, ...payload } = value;
  return value.formalSupportRegistryHash
      === AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE_REGISTRY.autonomousFormalSupportTemplateRegistryHash
    && value.formalSupportTemplateId === template.templateId
    && value.formalSupportTemplateHash === template.autonomousFormalSupportTemplateHash
    && value.leanTypeContractHash === template.leanTypeContract.autonomousFormalLeanTypeContractHash
    && value.proofExpositionHash
      === template.proofExposition.autonomousFormalProofExpositionHash
    && value.theoremBody === latexEscape(template.scope.statement)
    && value.theoremBodyHash === hashBytes(Buffer.from(value.theoremBody, 'utf8'))
    && value.proofBody === renderAutonomousFormalProofExposition(template)
    && value.proofBodyHash === hashBytes(Buffer.from(value.proofBody, 'utf8'))
    && claimedHash === hashRecord('AutonomousFormalSupportSurfaceAuthority', payload);
}

export function autonomousFormalSupportMarkerDeclarationValid(declaration, authority) {
  if (!verifyAutonomousFormalSupportSurfaceAuthority(authority)
    || !exactKeys(declaration, [
      'version', 'surfaceId', 'authorityHash', 'templateHash', 'proposalClaimRecordHash',
      'proofExpositionHash', 'theoremBodyHash', 'proofBodyHash',
      ...([2, 3].includes(authority?.version) ? [
        'dynamicFormalClaimSeedHash', 'formalClaimContractHash', 'kernelReplayReceiptHash',
        ...(authority.version === 3 ? [
          'readableProofExplanationHash', 'readableProofExplanationDagHash',
        ] : []),
      ] : []),
    ])) return false;
  try {
    return JSON.stringify(declaration)
      === JSON.stringify(autonomousFormalSupportMarkerDeclaration(authority));
  } catch { return false; }
}

export function autonomousFormalSupportSurfaceBody(authority) {
  if (!verifyAutonomousFormalSupportSurfaceAuthority(authority)) {
    throw new Error('autonomous_formal_support_surface_authority_invalid');
  }
  return [
    '\\begin{theorem}',
    authority.theoremBody,
    '\\end{theorem}',
    '\\begin{proof}',
    authority.proofBody,
    '\\end{proof}',
  ].join('\n');
}
