import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { leanTypeIdentity } from './lean-type-identity.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_'.]{0,159}$/;
const SEED_KEYS = Object.freeze([
  'allowedImports', 'assumptions', 'capabilityScopeManifestHash', 'claimKey',
  'dynamicFormalClaimSeedHash', 'generatorReceiptHash', 'kind',
  'leanDeclarationName', 'leanNormalizedTypeHash', 'leanTypeSource', 'leanTypeSourceHash',
  'negativeBoundaries', 'proofObligations', 'quantifiers', 'statement',
  'status', 'version',
]);
const FORBIDDEN_LEAN = /\b(?:abbrev|admit|attribute|axiom|builtin_initialize|by|class|decreasing_by|def|deriving|elab|end|example|export|include|inductive|infix|initialize|instance|macro|mutual|namespace|notation|opaque|open|partial|private|protected|run_tac|section|set_option|sorry|structure|syntax|theorem|termination_by|universe|unsafe|variable|where)\b|:=|#[A-Za-z_]/i;

function normalizedText(value, maximum = 8_000) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return text && text.length <= maximum ? text : null;
}

function exactText(value, maximum = 16_000) {
  const text = String(value ?? '').trim();
  return text && text.length <= maximum && !text.includes('\u0000') ? text : null;
}

function balancedLeanTypeDelimiters(source) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const closing = new Set(Object.values(pairs));
  const stack = [];
  for (const character of source) {
    if (pairs[character]) stack.push(pairs[character]);
    else if (closing.has(character) && stack.pop() !== character) return false;
  }
  return stack.length === 0;
}

function leanTypeHasForbiddenControl(source) {
  return [...source].some((character) => {
    const codePoint = character.codePointAt(0);
    return (codePoint < 32 && codePoint !== 9) || codePoint === 127;
  });
}

export function dynamicFormalLeanTypeSourceValid(value) {
  const source = exactText(value);
  return Boolean(source
    && !/[\r\n\u2028\u2029]/u.test(source)
    && !leanTypeHasForbiddenControl(source)
    && !source.includes('--')
    && !source.includes('/-')
    && !source.includes('-/')
    && !/[;"`$]/u.test(source)
    && !FORBIDDEN_LEAN.test(source)
    && balancedLeanTypeDelimiters(source)
    && leanTypeIdentity(source).normalizedTypeHash);
}

function canonicalList(values, maximumItems = 64, maximumLength = 2_000) {
  if (!Array.isArray(values) || !values.length || values.length > maximumItems) return null;
  const result = values.map((value) => normalizedText(value, maximumLength));
  if (result.some((value) => !value) || new Set(result).size !== result.length) return null;
  return Object.freeze(result);
}

function canonicalImports(values) {
  const imports = canonicalList(values, 32, 200);
  if (!imports || imports.some((value) => !/^[A-Za-z][A-Za-z0-9_.]*$/.test(value))) return null;
  return Object.freeze([...imports].sort());
}

export function buildDynamicFormalClaimSeed({
  claimKey,
  statement,
  assumptions,
  quantifiers,
  negativeBoundaries,
  proofObligations,
  leanDeclarationName,
  leanTypeSource,
  allowedImports = ['Mathlib'],
  generatorReceiptHash,
  capabilityScopeManifestHash,
} = {}) {
  const selectedClaimKey = normalizedText(claimKey, 200);
  const selectedStatement = normalizedText(statement);
  const selectedAssumptions = canonicalList(assumptions);
  const selectedQuantifiers = canonicalList(quantifiers);
  const selectedBoundaries = canonicalList(negativeBoundaries);
  const selectedObligations = canonicalList(proofObligations);
  const declarationName = String(leanDeclarationName || '').trim();
  const typeSource = exactText(leanTypeSource);
  const imports = canonicalImports(allowedImports);
  const typeIdentity = leanTypeIdentity(typeSource);
  const generatorHash = String(generatorReceiptHash || '').toLowerCase();
  const scopeHash = String(capabilityScopeManifestHash || '').toLowerCase();
  if (!selectedClaimKey || !selectedStatement || !selectedAssumptions || !selectedQuantifiers
    || !selectedBoundaries || !selectedObligations || !SAFE_ID.test(declarationName)
    || !dynamicFormalLeanTypeSourceValid(typeSource) || !typeIdentity.normalizedTypeHash || !imports
    || !SHA256.test(generatorHash) || !SHA256.test(scopeHash)) {
    throw new Error('dynamic_formal_claim_seed_invalid');
  }
  const payload = {
    version: 1,
    kind: 'DynamicFormalClaimSeed',
    status: 'dynamic_formal_claim_seed_verified',
    claimKey: selectedClaimKey,
    statement: selectedStatement,
    assumptions: selectedAssumptions,
    quantifiers: selectedQuantifiers,
    negativeBoundaries: selectedBoundaries,
    proofObligations: selectedObligations,
    leanDeclarationName: declarationName,
    leanTypeSource: typeSource,
    leanTypeSourceHash: hashBytes(Buffer.from(typeSource, 'utf8')),
    leanNormalizedTypeHash: typeIdentity.normalizedTypeHash,
    allowedImports: imports,
    generatorReceiptHash: generatorHash,
    capabilityScopeManifestHash: scopeHash,
  };
  return Object.freeze({
    ...payload,
    dynamicFormalClaimSeedHash: hashRecord('DynamicFormalClaimSeed', payload),
  });
}

export function verifyDynamicFormalClaimSeed(seed, expected = {}) {
  const blockers = [];
  if (!hasExactObjectKeys(seed, SEED_KEYS)) {
    blockers.push('dynamic_formal_claim_seed_shape_invalid');
  }
  let rebuilt = null;
  try { rebuilt = buildDynamicFormalClaimSeed(seed); }
  catch { blockers.push('dynamic_formal_claim_seed_rebuild_failed'); }
  if (!rebuilt || JSON.stringify(rebuilt) !== JSON.stringify(seed)) {
    blockers.push('dynamic_formal_claim_seed_not_canonical');
  }
  for (const field of [
    'claimKey', 'generatorReceiptHash', 'capabilityScopeManifestHash', 'leanTypeSourceHash',
    'leanNormalizedTypeHash',
  ]) {
    if (expected[field] && seed?.[field] !== expected[field]) {
      blockers.push(`dynamic_formal_claim_seed_${field}_mismatch`);
    }
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    valid: uniqueBlockers.length === 0,
    status: uniqueBlockers.length
      ? 'dynamic_formal_claim_seed_verification_blocked'
      : 'dynamic_formal_claim_seed_verification_verified',
    dynamicFormalClaimSeedHash: seed?.dynamicFormalClaimSeedHash || null,
    blockers: uniqueBlockers,
  });
}
