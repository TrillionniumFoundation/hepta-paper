import path from 'node:path';
import {
  analyzeTheoremEnvironmentMacroDefinitions,
  parseNewTheoremDeclarations,
  STANDARD_THEOREM_ENVIRONMENTS,
} from '../../paper-domain/quality/latex-theorem-environment-syntax.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { includedPath, safeManuscriptPath, trimAsciiWhitespace } from './latex-manuscript-reader-support.mjs';

const ENVIRONMENT_TOKEN = /\\(begin|end)\s*\{([^{}\r\n]+)\}(?:\s*\[[^\]\r\n]*\])?/g;
const INCLUDE_COMMAND = /\\(input|include)(?![A-Za-z@])/gi;

function literalIncludes(masked, relative) {
  const includes = [];
  const blockers = [];
  INCLUDE_COMMAND.lastIndex = 0;
  let match;
  while ((match = INCLUDE_COMMAND.exec(masked)) !== null) {
    let cursor = match.index + match[0].length;
    while (cursor < masked.length && /\s/.test(masked[cursor])) cursor += 1;
    if (masked[cursor] !== '{') {
      blockers.push(`formal_claim_universe_include_not_literal:${relative}:${match.index}`);
      continue;
    }
    const end = masked.indexOf('}', cursor + 1);
    const value = end < 0 ? '' : masked.slice(cursor + 1, end);
    if (end < 0 || value.includes('{')) {
      blockers.push(`formal_claim_universe_include_not_literal:${relative}:${match.index}`);
      continue;
    }
    const included = includedPath(relative, value);
    if (!included) {
      blockers.push(`formal_claim_universe_include_path_invalid:${relative}:${String(value || '').trim()}`);
    } else {
      includes.push(included);
    }
    INCLUDE_COMMAND.lastIndex = end + 1;
  }
  return Object.freeze({ includes: Object.freeze(includes), blockers: Object.freeze(blockers) });
}

function environmentTokens(masked, formalEnvironmentSet) {
  return [...masked.matchAll(ENVIRONMENT_TOKEN)]
    .map((match) => Object.freeze({
      action: match[1],
      environment: match[2].trim(),
      byteStart: match.index,
      byteEnd: match.index + match[0].length,
    }))
    .filter((token) => token.environment === 'proof' || formalEnvironmentSet.has(token.environment));
}

function extractFileUniverse({ relative, read, formalEnvironmentSet } = {}) {
  const blockers = [];
  const buffer = read.content;
  const latin1 = buffer.toString('latin1');
  const macroSyntax = analyzeTheoremEnvironmentMacroDefinitions(latin1, {
    theoremEnvironments: formalEnvironmentSet,
  });
  const masked = macroSyntax.maskedSource;
  for (const blocker of macroSyntax.blockers) {
    blockers.push(`formal_claim_universe_${blocker.code}:${relative}:${blocker.offset}`);
  }
  const tokens = environmentTokens(masked, formalEnvironmentSet);
  const usedProofStarts = new Set();
  const theorems = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const begin = tokens[index];
    if (begin.action !== 'begin' || !formalEnvironmentSet.has(begin.environment)) continue;
    const nested = tokens.slice(index + 1).findIndex((token) => (
      (token.action === 'end' && token.environment === begin.environment)
      || (token.action === 'begin' && formalEnvironmentSet.has(token.environment))
    ));
    if (nested < 0) {
      blockers.push(`formal_claim_universe_theorem_unterminated:${relative}:${begin.byteStart}`);
      continue;
    }
    const theoremEndIndex = index + 1 + nested;
    const theoremEnd = tokens[theoremEndIndex];
    if (theoremEnd.action !== 'end' || theoremEnd.environment !== begin.environment) {
      blockers.push(`formal_claim_universe_theorem_nested_or_malformed:${relative}:${begin.byteStart}`);
      continue;
    }
    const bodyRange = trimAsciiWhitespace(masked, begin.byteEnd, theoremEnd.byteStart);
    const body = buffer.subarray(bodyRange.byteStart, bodyRange.byteEnd);
    let theoremText = '';
    try {
      theoremText = body.toString('utf8');
      if (!body.length || !Buffer.from(theoremText, 'utf8').equals(body) || !theoremText.trim()) {
        blockers.push(`formal_claim_universe_theorem_body_invalid:${relative}:${begin.byteStart}`);
      }
    } catch {
      blockers.push(`formal_claim_universe_theorem_body_invalid:${relative}:${begin.byteStart}`);
    }

    const next = tokens[theoremEndIndex + 1] || null;
    const interstitial = masked.slice(theoremEnd.byteEnd, next?.byteStart ?? masked.length);
    let proof = null;
    if (next?.action === 'begin' && next.environment === 'proof' && !interstitial.trim()) {
      const proofEndRelativeIndex = tokens.slice(theoremEndIndex + 2)
        .findIndex((token) => token.action === 'end' && token.environment === 'proof');
      if (proofEndRelativeIndex >= 0) {
        const proofEndIndex = theoremEndIndex + 2 + proofEndRelativeIndex;
        const proofEnd = tokens[proofEndIndex];
        const interveningProofToken = tokens.slice(theoremEndIndex + 2, proofEndIndex)
          .some((token) => token.environment === 'proof');
        if (!interveningProofToken) {
          const proofBodyRange = trimAsciiWhitespace(masked, next.byteEnd, proofEnd.byteStart);
          const proofBytes = buffer.subarray(proofBodyRange.byteStart, proofBodyRange.byteEnd);
          proof = Object.freeze({
            byteStart: proofBodyRange.byteStart,
            byteEnd: proofBodyRange.byteEnd,
            contentHash: hashBytes(proofBytes),
          });
          usedProofStarts.add(next.byteStart);
        }
      }
    }
    if (!proof) blockers.push(`formal_claim_universe_proof_missing_or_not_adjacent:${relative}:${begin.byteStart}`);

    const ordinal = theorems.length + 1;
    const theoremPayload = {
      version: 1,
      kind: 'FormalClaimUniverseEntry',
      theoremId: `${relative}#formal-theorem=${ordinal}`,
      ordinal,
      environment: begin.environment,
      manuscriptPath: relative,
      manuscriptFileHash: read.hash,
      environmentByteStart: begin.byteStart,
      environmentByteEnd: theoremEnd.byteEnd,
      manuscriptByteStart: bodyRange.byteStart,
      manuscriptByteEnd: bodyRange.byteEnd,
      manuscriptContentHash: body.length ? hashBytes(body) : null,
      text: theoremText,
      proof,
    };
    theorems.push(Object.freeze({
      ...theoremPayload,
      formalClaimUniverseEntryHash: hashRecord('FormalClaimUniverseEntry', theoremPayload),
    }));
    index = theoremEndIndex;
  }

  for (const token of tokens) {
    if (token.action === 'begin' && token.environment === 'proof' && !usedProofStarts.has(token.byteStart)) {
      blockers.push(`formal_claim_universe_unpaired_proof:${relative}:${token.byteStart}`);
    }
  }
  return Object.freeze({ theorems: Object.freeze(theorems), blockers: Object.freeze([...new Set(blockers)]) });
}

export function readFormalClaimUniverse({ sourceRoot, manuscriptPath = 'main.tex', maximumFiles = 128 } = {}) {
  const rootPath = path.resolve(sourceRoot || '.');
  const rootManuscript = safeManuscriptPath(manuscriptPath);
  const blockers = [];
  const files = [];
  const fileReads = [];
  const theorems = [];
  const visited = new Set();

  const visit = (relative, depth = 0) => {
    if (!relative || visited.has(relative)) return;
    if (visited.size >= maximumFiles || depth > 32) {
      blockers.push('formal_claim_universe_include_limit_exceeded');
      return;
    }
    visited.add(relative);
    const read = readScopedFileSync({ scopeRoot: rootPath, candidate: path.join(rootPath, relative) });
    if (read.status !== 'scoped_file_read_verified') {
      blockers.push(`formal_claim_universe_manuscript_unreadable:${relative}`);
      return;
    }
    files.push(Object.freeze({ path: relative, hash: read.hash, bytes: read.bytes }));
    fileReads.push(Object.freeze({ relative, read }));
    const macroSyntax = analyzeTheoremEnvironmentMacroDefinitions(read.content.toString('latin1'));
    const includeSyntax = literalIncludes(macroSyntax.maskedSource, relative);
    blockers.push(...includeSyntax.blockers);
    for (const included of includeSyntax.includes) visit(included, depth + 1);
  };

  if (!rootManuscript) blockers.push('formal_claim_universe_manuscript_path_invalid');
  else visit(rootManuscript);

  const environmentDeclarations = [];
  const declarationByEnvironment = new Map();
  for (const { relative, read } of fileReads) {
    const parsed = parseNewTheoremDeclarations(read.content.toString('latin1'));
    for (const blocker of parsed.blockers) {
      blockers.push(`formal_claim_universe_${blocker.code}:${relative}:${blocker.offset}`);
    }
    for (const declaration of parsed.declarations) {
      const declarationPayload = {
        version: 1,
        kind: 'FormalTheoremEnvironmentDeclaration',
        environment: declaration.environment,
        starred: declaration.starred,
        aliasOf: declaration.aliasOf,
        within: declaration.within,
        manuscriptPath: relative,
        byteStart: declaration.offsetStart,
        byteEnd: declaration.offsetEnd,
        declarationContentHash: hashBytes(read.content.subarray(declaration.offsetStart, declaration.offsetEnd)),
      };
      const entry = Object.freeze({
        ...declarationPayload,
        formalTheoremEnvironmentDeclarationHash: hashRecord('FormalTheoremEnvironmentDeclaration', declarationPayload),
      });
      environmentDeclarations.push(entry);
      if (declaration.environment === 'proof') {
        blockers.push(`formal_claim_universe_theorem_environment_reserved:${relative}:${declaration.offsetStart}`);
      } else if (declarationByEnvironment.has(declaration.environment)) {
        blockers.push(`formal_claim_universe_theorem_environment_duplicate:${declaration.environment}`);
      } else {
        declarationByEnvironment.set(declaration.environment, entry);
      }
    }
  }

  const standardEnvironmentSet = new Set(STANDARD_THEOREM_ENVIRONMENTS);
  for (const declaration of declarationByEnvironment.values()) {
    if (!declaration.aliasOf) continue;
    const aliasTarget = declarationByEnvironment.get(declaration.aliasOf);
    if (!aliasTarget && !standardEnvironmentSet.has(declaration.aliasOf)) {
      blockers.push(`formal_claim_universe_theorem_environment_alias_unknown:${declaration.environment}:${declaration.aliasOf}`);
      continue;
    }
    if (aliasTarget?.starred) {
      blockers.push(`formal_claim_universe_theorem_environment_alias_unnumbered:${declaration.environment}:${declaration.aliasOf}`);
    }
    const seen = new Set([declaration.environment]);
    let cursor = aliasTarget;
    while (cursor?.aliasOf && declarationByEnvironment.has(cursor.aliasOf)) {
      if (seen.has(cursor.environment)) {
        blockers.push(`formal_claim_universe_theorem_environment_alias_cycle:${declaration.environment}`);
        break;
      }
      seen.add(cursor.environment);
      cursor = declarationByEnvironment.get(cursor.aliasOf);
    }
    if (cursor && seen.has(cursor.aliasOf)) {
      blockers.push(`formal_claim_universe_theorem_environment_alias_cycle:${declaration.environment}`);
    }
  }

  const formalEnvironmentSet = new Set([
    ...STANDARD_THEOREM_ENVIRONMENTS,
    ...declarationByEnvironment.keys(),
  ]);
  for (const { relative, read } of fileReads) {
    const extracted = extractFileUniverse({ relative, read, formalEnvironmentSet });
    theorems.push(...extracted.theorems);
    blockers.push(...extracted.blockers);
  }
  const sortedFiles = files.sort((left, right) => left.path.localeCompare(right.path));
  const sortedEnvironmentDeclarations = environmentDeclarations.sort((left, right) => (
    left.manuscriptPath.localeCompare(right.manuscriptPath) || left.byteStart - right.byteStart
  ));
  const sortedTheorems = theorems.sort((left, right) => left.manuscriptPath.localeCompare(right.manuscriptPath)
    || left.environmentByteStart - right.environmentByteStart);
  const manuscriptHash = hashRecord('FormalManuscriptCorpus', sortedFiles);
  const payload = {
    version: 1,
    kind: 'FormalClaimUniverse',
    status: blockers.length ? 'formal_claim_universe_blocked' : 'formal_claim_universe_verified',
    manuscriptPath: rootManuscript,
    manuscriptHash,
    files: sortedFiles,
    environmentDeclarations: sortedEnvironmentDeclarations,
    theorems: sortedTheorems,
    blockers: [...new Set(blockers)],
  };
  return Object.freeze({ ...payload, formalClaimUniverseHash: hashRecord('FormalClaimUniverse', payload) });
}
