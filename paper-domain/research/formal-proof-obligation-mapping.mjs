const LEAN_DECLARATION = /^[A-Za-z_][A-Za-z0-9_'.]*(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/;
const OBLIGATION_ID = /^obligation:[a-f0-9]{64}$/;

function uniqueTexts(values) {
  if (!Array.isArray(values)) return null;
  const result = values.map((value) => String(value ?? '').trim());
  return result.every(Boolean) && new Set(result).size === result.length ? result : null;
}

export function normalizeFormalProofObligationMappings({
  proofObligationContracts = null,
  proofObligations = [],
  proofObligationMappings = null,
  theoremName = null,
} = {}) {
  const blockers = [];
  const displays = uniqueTexts(proofObligations);
  if (!displays?.length) blockers.push('formal_proof_obligation_displays_invalid');
  let contracts = [];
  if (Array.isArray(proofObligationContracts) && proofObligationContracts.length) {
    contracts = proofObligationContracts.map((contract) => Object.freeze({
      obligationId: String(contract?.obligationId || '').trim(),
      displayText: String(contract?.displayText || '').trim(),
    }));
    const stableIds = contracts.every((contract) => OBLIGATION_ID.test(contract.obligationId));
    const legacyIds = contracts.every((contract) => contract.obligationId === contract.displayText);
    if ((!stableIds && !legacyIds) || contracts.some((contract) => !contract.displayText)
      || new Set(contracts.map((contract) => contract.obligationId)).size !== contracts.length
      || JSON.stringify(contracts.map((contract) => contract.displayText)) !== JSON.stringify(displays)) {
      blockers.push('formal_proof_obligation_contracts_invalid');
    }
  } else if (displays?.length) {
    contracts = displays.map((displayText) => Object.freeze({
      obligationId: displayText,
      displayText,
    }));
  }

  const legacyMigrated = !Array.isArray(proofObligationMappings);
  const stableContracts = contracts.length > 0
    && contracts.every((contract) => OBLIGATION_ID.test(contract.obligationId));
  if (legacyMigrated && stableContracts) {
    blockers.push('formal_proof_obligation_mappings_required');
  }
  const rawMappings = legacyMigrated && !stableContracts
    ? contracts.map((contract) => ({
      ...contract,
      leanDeclarations: theoremName ? [String(theoremName)] : [],
    }))
    : (proofObligationMappings || []);
  const mappings = (Array.isArray(rawMappings) ? rawMappings : []).map((mapping) => Object.freeze({
    obligationId: String(mapping?.obligationId || ''),
    displayText: String(mapping?.displayText || '').trim(),
    leanDeclarations: Object.freeze(uniqueTexts(mapping?.leanDeclarations) || []),
  }));
  const contractById = new Map(contracts.map((contract) => [contract.obligationId, contract]));
  if (mappings.length !== contracts.length
    || new Set(mappings.map((mapping) => mapping.obligationId)).size !== mappings.length
    || mappings.some((mapping) => {
      const contract = contractById.get(mapping.obligationId);
      return !contract || mapping.displayText !== contract.displayText
        || !mapping.leanDeclarations.length
        || mapping.leanDeclarations.some((name) => !LEAN_DECLARATION.test(name));
    })) {
    blockers.push('formal_proof_obligation_mappings_invalid');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length
      ? 'formal_proof_obligation_mapping_blocked'
      : 'formal_proof_obligation_mapping_verified',
    contracts: Object.freeze(contracts),
    mappings: Object.freeze(mappings),
    verificationTargets: Object.freeze([...new Set(mappings.flatMap((mapping) => mapping.leanDeclarations))].sort()),
    legacyMigrated,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
