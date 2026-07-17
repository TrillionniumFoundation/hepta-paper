import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashPaperRecord } from './primitives.mjs';

const INPUT_KIND = 'PaperScientificClaimInput';
const INPUT_KEYS = Object.freeze(['claims', 'kind', 'version']);
const CANONICAL_INPUT_KEYS = Object.freeze([
  'claims',
  'kind',
  'limitations',
  'paperScientificClaimInputHash',
  'status',
  'version',
]);
const CLAIM_KEYS = Object.freeze([
  'assumptions',
  'claimKey',
  'negativeBoundaries',
  'proofObligations',
  'quantifiers',
  'statement',
]);
const CLAIM_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLACEHOLDER = /\b(?:TODO|TBD|placeholder|fill[ -]?in)\b/i;

function requiredText(value, field, maximum = 8_000) {
  const text = normalizeText(value);
  if (!text || text.length > maximum || PLACEHOLDER.test(text)) {
    throw new Error(`proposal_scientific_claim_${field}_invalid`);
  }
  return text;
}

function requiredList(value, field, limit = 16) {
  if (!Array.isArray(value) || value.length === 0 || value.length > limit
    || value.some((item) => typeof item !== 'string')) {
    throw new Error(`proposal_scientific_claim_${field}_invalid`);
  }
  const normalized = uniqueStrings(value, limit);
  if (normalized.length !== value.length
    || normalized.some((item) => item.length > 2_000 || PLACEHOLDER.test(item))) {
    throw new Error(`proposal_scientific_claim_${field}_invalid`);
  }
  return normalized;
}

function validText(value, maximum = 8_000) {
  return typeof value === 'string'
    && value === normalizeText(value)
    && value.length > 0
    && value.length <= maximum
    && !PLACEHOLDER.test(value);
}

function validList(value, limit = 16) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= limit
    && value.every((item) => validText(item, 2_000))
    && new Set(value).size === value.length;
}

export function createPaperScientificClaimInput(document) {
  if (!exactKeys(document, INPUT_KEYS)
    || document.version !== 1
    || document.kind !== INPUT_KIND
    || !Array.isArray(document.claims)
    || document.claims.length === 0
    || document.claims.length > 12) {
    throw new Error('proposal_scientific_claim_input_invalid');
  }
  const claims = document.claims.map((claim) => {
    if (!exactKeys(claim, CLAIM_KEYS)) throw new Error('proposal_scientific_claim_schema_invalid');
    const claimKey = requiredText(claim.claimKey, 'key', 128);
    if (!CLAIM_KEY.test(claimKey)) throw new Error('proposal_scientific_claim_key_invalid');
    return Object.freeze({
      claimKey,
      statement: requiredText(claim.statement, 'statement'),
      assumptions: Object.freeze(requiredList(claim.assumptions, 'assumptions')),
      quantifiers: Object.freeze(requiredList(claim.quantifiers, 'quantifiers')),
      negativeBoundaries: Object.freeze(requiredList(claim.negativeBoundaries, 'negative_boundaries')),
      proofObligations: Object.freeze(requiredList(claim.proofObligations, 'proof_obligations')),
    });
  });
  if (new Set(claims.map((claim) => claim.claimKey)).size !== claims.length) {
    throw new Error('proposal_scientific_claim_keys_duplicate');
  }
  if (new Set(claims.map((claim) => claim.statement)).size !== claims.length) {
    throw new Error('proposal_scientific_claim_statements_duplicate');
  }
  if (uniqueStrings(claims.flatMap((claim) => claim.proofObligations), 17).length > 16) {
    throw new Error('proposal_scientific_claim_proof_obligations_exceed_limit');
  }
  const payload = {
    version: 1,
    kind: INPUT_KIND,
    status: 'operator_scientific_claim_input_recorded_for_signed_review',
    claims: Object.freeze(claims),
    limitations: Object.freeze({
      noveltyAutomaticallyVerified: false,
      scientificCorrectnessAutomaticallyVerified: false,
      formalProofVerified: false,
    }),
  };
  return Object.freeze({
    ...payload,
    paperScientificClaimInputHash: hashPaperRecord('PaperScientificClaimInput', payload),
  });
}

export function verifyPaperScientificClaimInput(value) {
  const blockers = [];
  if (!exactKeys(value, CANONICAL_INPUT_KEYS)
    || value?.version !== 1
    || value?.kind !== INPUT_KIND
    || value?.status !== 'operator_scientific_claim_input_recorded_for_signed_review') {
    blockers.push('proposal_scientific_claim_input_schema_invalid');
  }
  if (!Array.isArray(value?.claims) || value.claims.length === 0 || value.claims.length > 12) {
    blockers.push('proposal_scientific_claim_input_claim_count_invalid');
  }
  if (!exactKeys(value?.limitations, [
    'formalProofVerified',
    'noveltyAutomaticallyVerified',
    'scientificCorrectnessAutomaticallyVerified',
  ])
    || value?.limitations?.formalProofVerified !== false
    || value?.limitations?.noveltyAutomaticallyVerified !== false
    || value?.limitations?.scientificCorrectnessAutomaticallyVerified !== false) {
    blockers.push('proposal_scientific_claim_input_limitations_invalid');
  }
  const { paperScientificClaimInputHash: claimedHash, ...payload } = value || {};
  if (!claimedHash || hashPaperRecord('PaperScientificClaimInput', payload) !== claimedHash) {
    blockers.push('proposal_scientific_claim_input_hash_invalid');
  }
  const keys = new Set();
  const statements = new Set();
  for (const claim of value?.claims || []) {
    if (!exactKeys(claim, CLAIM_KEYS)
      || !CLAIM_KEY.test(String(claim?.claimKey || ''))
      || keys.has(claim.claimKey)
      || !validText(claim.statement)
      || statements.has(claim.statement)
      || !validList(claim.assumptions)
      || !validList(claim.quantifiers)
      || !validList(claim.negativeBoundaries)
      || !validList(claim.proofObligations)) {
      blockers.push('proposal_scientific_claim_input_claim_invalid');
      break;
    }
    keys.add(claim.claimKey);
    statements.add(claim.statement);
  }
  if (uniqueStrings((value?.claims || []).flatMap((claim) => claim?.proofObligations || []), 17).length > 16) {
    blockers.push('proposal_scientific_claim_input_proof_obligations_exceed_limit');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length
      ? 'paper_scientific_claim_input_blocked'
      : 'paper_scientific_claim_input_verified',
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
