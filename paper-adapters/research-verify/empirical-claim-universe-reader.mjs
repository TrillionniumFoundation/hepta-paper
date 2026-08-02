import path from 'node:path';
import { analyzeTheoremEnvironmentMacroDefinitions } from '../../paper-domain/quality/latex-theorem-environment-syntax.mjs';
import {
  deriveEmpiricalClaimUniverseIdentity,
} from '../../paper-domain/research/empirical-claim-contract.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { includedPath, safeManuscriptPath, trimAsciiWhitespace } from './latex-manuscript-reader-support.mjs';

const INCLUDE_COMMAND = /\\(input|include)(?![A-Za-z@])/gi;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const BEGIN = /^\s*%\s*HEPTA_EMPIRICAL_CLAIM_BEGIN\s+(\{.*\})\s*$/;
const END = /^\s*%\s*HEPTA_EMPIRICAL_CLAIM_END\s+([A-Za-z0-9][A-Za-z0-9_.:-]{0,159})\s*$/;
const MARKER_TOKEN = /HEPTA_EMPIRICAL_CLAIM_(?:BEGIN|END)/;

function literalIncludes(masked, relative) {
  const includes = [];
  const blockers = [];
  INCLUDE_COMMAND.lastIndex = 0;
  let match;
  while ((match = INCLUDE_COMMAND.exec(masked)) !== null) {
    let cursor = match.index + match[0].length;
    while (cursor < masked.length && /\s/.test(masked[cursor])) cursor += 1;
    if (masked[cursor] !== '{') {
      blockers.push(`empirical_claim_universe_include_not_literal:${relative}:${match.index}`);
      continue;
    }
    const end = masked.indexOf('}', cursor + 1);
    const value = end < 0 ? '' : masked.slice(cursor + 1, end);
    if (end < 0 || value.includes('{')) {
      blockers.push(`empirical_claim_universe_include_not_literal:${relative}:${match.index}`);
      continue;
    }
    const included = includedPath(relative, value);
    if (!included) blockers.push(`empirical_claim_universe_include_path_invalid:${relative}:${String(value).trim()}`);
    else includes.push(Object.freeze({ path: included, offset: match.index }));
    INCLUDE_COMMAND.lastIndex = end + 1;
  }
  return { includes, blockers };
}

function lineRecords(latin1) {
  const records = [];
  let start = 0;
  for (let cursor = 0; cursor <= latin1.length; cursor += 1) {
    if (cursor !== latin1.length && latin1[cursor] !== '\n') continue;
    const contentEnd = cursor > start && latin1[cursor - 1] === '\r' ? cursor - 1 : cursor;
    records.push({ text: latin1.slice(start, contentEnd), byteStart: start, byteEnd: cursor < latin1.length ? cursor + 1 : cursor });
    start = cursor + 1;
  }
  return records;
}

function validDeclaration(value) {
  return exactKeys(value, [
    'claimId', 'metric', 'comparator', 'alternative', 'minimumEffect', 'acceptanceRequired',
    'proposalClaimRecordHash',
  ]) && IDENTIFIER.test(String(value.claimId || '')) && IDENTIFIER.test(String(value.metric || ''))
    && ['baseline', 'ablation'].includes(value.comparator) && ['greater', 'less'].includes(value.alternative)
    && Number.isFinite(Number(value.minimumEffect)) && Number(value.minimumEffect) >= 0
    && typeof value.acceptanceRequired === 'boolean'
    && (value.proposalClaimRecordHash === null || /^sha256:[0-9a-f]{64}$/i.test(String(value.proposalClaimRecordHash || '')));
}

function extractClaims(relative, read) {
  const latin1 = read.content.toString('latin1');
  const blockers = [];
  const claims = [];
  let open = null;
  for (const line of lineRecords(latin1)) {
    const begin = line.text.match(BEGIN);
    const end = line.text.match(END);
    if (MARKER_TOKEN.test(line.text) && !begin && !end) {
      blockers.push(`empirical_claim_universe_marker_malformed:${relative}:${line.byteStart}`);
      continue;
    }
    if (begin) {
      if (open) {
        blockers.push(`empirical_claim_universe_marker_nested:${relative}:${line.byteStart}`);
        continue;
      }
      let declaration = null;
      try { declaration = JSON.parse(begin[1]); } catch { /* blocked below */ }
      if (!validDeclaration(declaration)) {
        blockers.push(`empirical_claim_universe_declaration_invalid:${relative}:${line.byteStart}`);
        continue;
      }
      open = { declaration, markerByteStart: line.byteStart, bodyStart: line.byteEnd };
      continue;
    }
    if (!end) continue;
    if (!open) {
      blockers.push(`empirical_claim_universe_marker_end_unpaired:${relative}:${line.byteStart}`);
      continue;
    }
    if (end[1] !== open.declaration.claimId) {
      blockers.push(`empirical_claim_universe_marker_id_mismatch:${relative}:${line.byteStart}`);
      open = null;
      continue;
    }
    const range = trimAsciiWhitespace(latin1, open.bodyStart, line.byteStart);
    const bytes = read.content.subarray(range.byteStart, range.byteEnd);
    const text = bytes.toString('utf8');
    if (!bytes.length || !text.trim() || !Buffer.from(text, 'utf8').equals(bytes)) {
      blockers.push(`empirical_claim_universe_claim_body_invalid:${relative}:${open.markerByteStart}`);
      open = null;
      continue;
    }
    claims.push({
      declaration: open.declaration,
      manuscriptPath: relative,
      manuscriptFileHash: read.hash,
      markerByteStart: open.markerByteStart,
      markerByteEnd: line.byteEnd,
      manuscriptByteStart: range.byteStart,
      manuscriptByteEnd: range.byteEnd,
      manuscriptContentHash: hashBytes(bytes),
      text,
    });
    open = null;
  }
  if (open) blockers.push(`empirical_claim_universe_marker_unterminated:${relative}:${open.markerByteStart}`);
  return { claims, blockers };
}

export function readEmpiricalClaimUniverse({ sourceRoot, manuscriptPath = 'main.tex', maximumFiles = 128 } = {}) {
  const rootPath = path.resolve(sourceRoot || '.');
  const rootManuscript = safeManuscriptPath(manuscriptPath);
  const blockers = [];
  const files = [];
  const extractedClaims = [];
  const visited = new Set();
  const visit = (relative, depth = 0) => {
    if (!relative || visited.has(relative)) return;
    if (visited.size >= maximumFiles || depth > 32) {
      blockers.push('empirical_claim_universe_include_limit_exceeded');
      return;
    }
    visited.add(relative);
    const read = readScopedFileSync({ scopeRoot: rootPath, candidate: path.join(rootPath, relative) });
    if (read.status !== 'scoped_file_read_verified') {
      blockers.push(`empirical_claim_universe_manuscript_unreadable:${relative}`);
      return;
    }
    files.push(Object.freeze({ path: relative, hash: read.hash, bytes: read.bytes }));
    const syntax = analyzeTheoremEnvironmentMacroDefinitions(read.content.toString('latin1'));
    for (const blocker of syntax.blockers) {
      blockers.push(`empirical_claim_universe_dynamic_tex_unsupported:${relative}:${blocker.offset}`);
    }
    const includes = literalIncludes(syntax.maskedSource, relative);
    blockers.push(...includes.blockers);
    const extracted = extractClaims(relative, read);
    blockers.push(...extracted.blockers);
    const events = [
      ...extracted.claims.map((claim) => ({ type: 'claim', offset: claim.markerByteStart, claim })),
      ...includes.includes.map((included) => ({ type: 'include', offset: included.offset, included })),
    ].sort((left, right) => left.offset - right.offset || left.type.localeCompare(right.type));
    for (const event of events) {
      if (event.type === 'claim') extractedClaims.push(event.claim);
      else visit(event.included.path, depth + 1);
    }
  };
  if (!rootManuscript) blockers.push('empirical_claim_universe_manuscript_path_invalid');
  else visit(rootManuscript);
  const sortedFiles = files.sort((left, right) => left.path.localeCompare(right.path));
  const sourceCorpusHash = hashRecord('EmpiricalManuscriptSourceCorpus', sortedFiles);
  const orderedCandidates = extractedClaims;
  const empiricalClaimIdentity = deriveEmpiricalClaimUniverseIdentity({
    manuscriptPath: rootManuscript,
    claims: orderedCandidates.map((candidate) => ({
    claimId: candidate.declaration.claimId,
    metric: candidate.declaration.metric,
    comparator: candidate.declaration.comparator,
    alternative: candidate.declaration.alternative,
    minimumEffect: Number(candidate.declaration.minimumEffect),
    acceptanceRequired: candidate.declaration.acceptanceRequired,
    proposalClaimRecordHash: candidate.declaration.proposalClaimRecordHash,
    manuscriptPath: candidate.manuscriptPath,
    manuscriptContentHash: candidate.manuscriptContentHash,
    })),
  });
  const manuscriptCorpusHash = empiricalClaimIdentity.manuscriptCorpusHash;
  const ids = new Set();
  const claims = orderedCandidates.map((candidate, index) => {
    const { declaration, ...source } = candidate;
    if (ids.has(declaration.claimId)) blockers.push(`empirical_claim_universe_claim_id_duplicate:${declaration.claimId}`);
    ids.add(declaration.claimId);
    const payload = {
      version: 1,
      kind: 'EmpiricalClaimUniverseEntry',
      ...declaration,
      minimumEffect: Number(declaration.minimumEffect),
      ...source,
      manuscriptClaimHash:
        empiricalClaimIdentity.claimIdentities[index].manuscriptClaimHash,
    };
    return Object.freeze({
      ...payload,
      empiricalClaimUniverseEntryHash: hashRecord('EmpiricalClaimUniverseEntry', payload),
    });
  });
  if (!claims.length) blockers.push('empirical_claim_universe_claims_missing');
  const empiricalClaimUniverseHash = empiricalClaimIdentity.empiricalClaimUniverseHash;
  const payload = {
    version: 1,
    kind: 'EmpiricalClaimUniverse',
    status: blockers.length ? 'empirical_claim_universe_blocked' : 'empirical_claim_universe_verified',
    manuscriptPath: rootManuscript,
    manuscriptCorpusHash,
    sourceCorpusHash,
    files: sortedFiles,
    claims,
    blockers: [...new Set(blockers)],
  };
  const authority = Object.freeze({ ...payload, empiricalClaimUniverseHash });
  return Object.freeze({
    ...authority,
    empiricalClaimUniverseReceiptHash: hashRecord('EmpiricalClaimUniverseReceipt', authority),
  });
}

export function canonicalEmpiricalClaimsFromUniverse(universe) {
  if (universe?.status !== 'empirical_claim_universe_verified') return Object.freeze([]);
  return Object.freeze(universe.claims.map((claim) => Object.freeze({
    id: claim.claimId,
    claimId: claim.claimId,
    text: claim.text,
    sourceLocator: `${claim.manuscriptPath}#bytes=${claim.manuscriptByteStart}-${claim.manuscriptByteEnd}`,
    manuscriptPath: claim.manuscriptPath,
    manuscriptByteStart: claim.manuscriptByteStart,
    manuscriptByteEnd: claim.manuscriptByteEnd,
    manuscriptContentHash: claim.manuscriptContentHash,
    manuscriptFileHash: claim.manuscriptFileHash,
    manuscriptClaimHash: claim.manuscriptClaimHash,
    empiricalClaimUniverseEntryHash: claim.empiricalClaimUniverseEntryHash,
    empiricalClaimUniverseHash: universe.empiricalClaimUniverseHash,
    manuscriptCorpusHash: universe.manuscriptCorpusHash,
    proposalClaimRecordHash: claim.proposalClaimRecordHash,
    status: 'candidate',
    kind: 'empirical_claim',
    verificationPlan: Object.freeze({
      kind: 'empirical_claim_bound_academic_experiment',
      requiresWorker: false,
      requiresEvidence: false,
      verifier: 'system-owned-claim-bound-analysis-protocol-v2',
    }),
    proofObligations: Object.freeze([]),
  })));
}
