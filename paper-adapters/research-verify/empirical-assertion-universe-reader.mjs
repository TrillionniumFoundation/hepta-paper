import fs from 'node:fs';
import path from 'node:path';
import { verifyAutonomousFormalSupportSurfaceAuthority } from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import {
  TRUSTED_AUTONOMOUS_MANUSCRIPT_PROSE,
  TRUSTED_AUTONOMOUS_MANUSCRIPT_SECTIONS,
} from '../../paper-domain/automation/trusted-autonomous-manuscript-prose.mjs';
import { stripLatexComment } from '../../paper-domain/quality/latex-comment-syntax.mjs';
import { analyzeTheoremEnvironmentMacroDefinitions } from '../../paper-domain/quality/latex-theorem-environment-syntax.mjs';
import {
  assertionMarkerDeclarationValid,
  empiricalPresentationMarkerDeclarationValid,
} from '../../paper-domain/research/empirical-assertion-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { readEmpiricalClaimUniverse } from './empirical-claim-universe-reader.mjs';
import {
  includedPath,
  manuscriptLineRecords,
  safeManuscriptPath,
  trimAsciiWhitespace,
} from './latex-manuscript-reader-support.mjs';
import {
  extractFormalSupportSurfaces,
  lineInsideFormalSupportSurface,
} from './formal-support-surface-reader.mjs';

const INCLUDE_COMMAND = /\\(input|include)(?![A-Za-z@])/gi;
const BEGIN = /^\s*%\s*HEPTA_EMPIRICAL_ASSERTION_BEGIN\s+(\{.*\})\s*$/;
const END = /^\s*%\s*HEPTA_EMPIRICAL_ASSERTION_END\s+([A-Za-z0-9][A-Za-z0-9_.:-]{0,191})\s*$/;
const MARKER_TOKEN = /HEPTA_EMPIRICAL_ASSERTION_(?:BEGIN|END)/;
const PRESENTATION_BEGIN = /^\s*%\s*HEPTA_EMPIRICAL_PRESENTATION_BEGIN\s+(\{.*\})\s*$/;
const PRESENTATION_END = /^\s*%\s*HEPTA_EMPIRICAL_PRESENTATION_END\s+([A-Za-z0-9][A-Za-z0-9_.:-]{0,191})\s*$/;
const PRESENTATION_MARKER_TOKEN = /HEPTA_EMPIRICAL_PRESENTATION_(?:BEGIN|END)/;
const LEGACY_RESULT_MARKER = /^\s*%\s*HEPTA_RESULT\b/i;
const SECTION_COMMAND = /^\s*\\section\*?\s*\{([^{}]*)\}\s*(?:\\label\s*\{[^{}]+\}\s*)?$/i;
const UNSUPPORTED_RESULT_SURFACE = /\\(?:subsection|subsubsection|paragraph|subparagraph)\*?\s*\{|\\caption\*?\s*\{|\\begin\s*\{(?:table\*?|figure\*?)\}/i;
const ENVIRONMENT_BOUNDARY = /^\s*\\(begin|end)\s*\{([A-Za-z][A-Za-z0-9:_-]*\*?)\}\s*(?:\[[^\]\r\n]*\]\s*)?$/i;
const SAFE_DOCUMENT_CLASS = /^\s*\\documentclass\[11pt\]\{article\}\s*$/;
const SAFE_PACKAGE_SET = /^\s*\\usepackage\{amsmath,amssymb,amsthm(?:,graphicx)?\}\s*$/;
const SAFE_THEOREM_DECLARATION = /^\s*\\newtheorem\s*\{(?:theorem|lemma|proposition|corollary|definition|assumption)\}\s*\{(?:Theorem|Lemma|Proposition|Corollary|Definition|Assumption)\}\s*$/;
const SAFE_DOCUMENT_METADATA = /^\s*\\(?:title\{Autonomous bounded research report\}|author\{\}|date\{\})\s*$/;
const SAFE_STANDALONE_COMMAND = /^\s*\\(?:begin\s*\{document\}|end\s*\{document\}|maketitle|appendix|clearpage|newpage|pagebreak|noindent)\s*$/i;
const SAFE_LABEL_COMMAND = /^\s*\\label\s*\{[A-Za-z0-9_.:-]+\}\s*$/;
const SAFE_FIXED_PROSE = new Set([
  'This report is limited to the registered typed assertions and kernel-verified formal theorem.',
  ...Object.values(TRUSTED_AUTONOMOUS_MANUSCRIPT_PROSE),
]);
const FORBIDDEN_RENDER_SUPPORT_EXTENSION = /\.(?:sty|cls|bib|bst)$/i;
const SAFE_SECTION_TITLES = new Set([
  'introduction', 'background', 'related work', 'method', 'methods', 'methodology', 'model',
  'experimental setup', 'simulations', 'result', 'results', 'main result', 'main results',
  'empirical result', 'empirical results', 'discussion', 'results and discussion', 'conclusion',
  'limitations', 'reproducibility', 'preregistered hypothesis', 'formal source',
  'formal protocol invariant', 'proof sketch', 'references', 'appendix',
  ...TRUSTED_AUTONOMOUS_MANUSCRIPT_SECTIONS.map((title) => title.toLowerCase()),
]);

function literalIncludes(masked, relative) {
  const includes = [];
  const blockers = [];
  INCLUDE_COMMAND.lastIndex = 0;
  let match;
  while ((match = INCLUDE_COMMAND.exec(masked)) !== null) {
    let cursor = match.index + match[0].length;
    while (cursor < masked.length && /\s/.test(masked[cursor])) cursor += 1;
    if (masked[cursor] !== '{') {
      blockers.push(`empirical_assertion_universe_include_not_literal:${relative}:${match.index}`);
      continue;
    }
    const end = masked.indexOf('}', cursor + 1);
    const value = end < 0 ? '' : masked.slice(cursor + 1, end);
    if (end < 0 || value.includes('{')) {
      blockers.push(`empirical_assertion_universe_include_not_literal:${relative}:${match.index}`);
      continue;
    }
    const included = includedPath(relative, value);
    if (!included) blockers.push(`empirical_assertion_universe_include_path_invalid:${relative}:${String(value).trim()}`);
    else includes.push(Object.freeze({ path: included, offset: match.index, end: end + 1 }));
    INCLUDE_COMMAND.lastIndex = end + 1;
  }
  return { includes, blockers };
}

function extractAssertions(relative, read) {
  const latin1 = read.content.toString('latin1');
  const blockers = [];
  const assertions = [];
  let open = null;
  for (const line of manuscriptLineRecords(latin1)) {
    const begin = line.text.match(BEGIN);
    const end = line.text.match(END);
    if (MARKER_TOKEN.test(line.text) && !begin && !end) {
      blockers.push(`empirical_assertion_universe_marker_malformed:${relative}:${line.byteStart}`);
      continue;
    }
    if (begin) {
      if (open) {
        blockers.push(`empirical_assertion_universe_marker_nested:${relative}:${line.byteStart}`);
        continue;
      }
      let declaration = null;
      try { declaration = JSON.parse(begin[1]); } catch { /* blocked below */ }
      if (!assertionMarkerDeclarationValid(declaration)) {
        blockers.push(`empirical_assertion_universe_declaration_invalid:${relative}:${line.byteStart}`);
        continue;
      }
      open = { declaration: Object.freeze(declaration), markerByteStart: line.byteStart, bodyStart: line.byteEnd };
      continue;
    }
    if (!end) continue;
    if (!open) {
      blockers.push(`empirical_assertion_universe_marker_end_unpaired:${relative}:${line.byteStart}`);
      continue;
    }
    if (end[1] !== open.declaration.assertionId) {
      blockers.push(`empirical_assertion_universe_marker_id_mismatch:${relative}:${line.byteStart}`);
      open = null;
      continue;
    }
    const range = trimAsciiWhitespace(latin1, open.bodyStart, line.byteStart);
    const bytes = read.content.subarray(range.byteStart, range.byteEnd);
    const text = bytes.toString('utf8');
    if (!bytes.length || !text.trim() || !Buffer.from(text, 'utf8').equals(bytes)) {
      blockers.push(`empirical_assertion_universe_body_invalid:${relative}:${open.markerByteStart}`);
      open = null;
      continue;
    }
    assertions.push(Object.freeze({
      declaration: open.declaration,
      manuscriptPath: relative,
      manuscriptFileHash: read.hash,
      markerByteStart: open.markerByteStart,
      markerByteEnd: line.byteEnd,
      manuscriptByteStart: range.byteStart,
      manuscriptByteEnd: range.byteEnd,
      manuscriptContentHash: hashBytes(bytes),
      text,
    }));
    open = null;
  }
  if (open) blockers.push(`empirical_assertion_universe_marker_unterminated:${relative}:${open.markerByteStart}`);
  return { assertions, blockers };
}

function presentationArtifact(rootPath, declaration, blockers) {
  if (declaration.artifactPath === null) return null;
  const read = readScopedFileSync({
    scopeRoot: rootPath,
    candidate: path.join(rootPath, declaration.artifactPath),
    maximumBytes: 64 * 1024 * 1024,
  });
  if (read.status !== 'scoped_file_read_verified') {
    blockers.push(`empirical_presentation_artifact_unreadable:${declaration.surfaceId}`);
    return Object.freeze({
      status: 'empirical_presentation_artifact_blocked',
      path: declaration.artifactPath,
      hash: read.hash,
      bytes: read.bytes,
    });
  }
  if (read.hash !== declaration.artifactHash) {
    blockers.push(`empirical_presentation_artifact_hash_mismatch:${declaration.surfaceId}`);
  }
  return Object.freeze({
    status: read.hash === declaration.artifactHash
      ? 'empirical_presentation_artifact_verified'
      : 'empirical_presentation_artifact_blocked',
    path: declaration.artifactPath,
    hash: read.hash,
    bytes: read.bytes,
  });
}

function extractPresentations(relative, read, rootPath) {
  const latin1 = read.content.toString('latin1');
  const blockers = [];
  const presentations = [];
  let open = null;
  for (const line of manuscriptLineRecords(latin1)) {
    const begin = line.text.match(PRESENTATION_BEGIN);
    const end = line.text.match(PRESENTATION_END);
    if (PRESENTATION_MARKER_TOKEN.test(line.text) && !begin && !end) {
      blockers.push(`empirical_presentation_marker_malformed:${relative}:${line.byteStart}`);
      continue;
    }
    if (begin) {
      if (open) {
        blockers.push(`empirical_presentation_marker_nested:${relative}:${line.byteStart}`);
        continue;
      }
      let declaration = null;
      try { declaration = JSON.parse(begin[1]); } catch { /* blocked below */ }
      if (!empiricalPresentationMarkerDeclarationValid(declaration)) {
        blockers.push(`empirical_presentation_declaration_invalid:${relative}:${line.byteStart}`);
        continue;
      }
      open = { declaration: Object.freeze(declaration), markerByteStart: line.byteStart, bodyStart: line.byteEnd };
      continue;
    }
    if (!end) continue;
    if (!open) {
      blockers.push(`empirical_presentation_marker_end_unpaired:${relative}:${line.byteStart}`);
      continue;
    }
    if (end[1] !== open.declaration.surfaceId) {
      blockers.push(`empirical_presentation_marker_id_mismatch:${relative}:${line.byteStart}`);
      open = null;
      continue;
    }
    const range = trimAsciiWhitespace(latin1, open.bodyStart, line.byteStart);
    const bytes = read.content.subarray(range.byteStart, range.byteEnd);
    const text = bytes.toString('utf8');
    if (!bytes.length || !text.trim() || !Buffer.from(text, 'utf8').equals(bytes)) {
      blockers.push(`empirical_presentation_body_invalid:${relative}:${open.markerByteStart}`);
      open = null;
      continue;
    }
    presentations.push(Object.freeze({
      declaration: open.declaration,
      manuscriptPath: relative,
      manuscriptFileHash: read.hash,
      markerByteStart: open.markerByteStart,
      markerByteEnd: line.byteEnd,
      manuscriptByteStart: range.byteStart,
      manuscriptByteEnd: range.byteEnd,
      manuscriptContentHash: hashBytes(bytes),
      text,
      artifact: presentationArtifact(rootPath, open.declaration, blockers),
    }));
    open = null;
  }
  if (open) blockers.push(`empirical_presentation_marker_unterminated:${relative}:${open.markerByteStart}`);
  return { presentations, blockers };
}

function insideAssertion(line, assertions) {
  return assertions.some((assertion) => line.byteStart >= assertion.markerByteStart
    && line.byteStart < assertion.markerByteEnd);
}

function insidePresentation(line, presentations) {
  return presentations.some((presentation) => line.byteStart >= presentation.markerByteStart
    && line.byteStart < presentation.markerByteEnd);
}

function insideClaim(line, claims) {
  return claims.some((claim) => line.byteStart >= claim.markerByteStart
    && line.byteStart < claim.markerByteEnd);
}

function trustedClaimRanges({ sourceRoot, manuscriptPath, maximumFiles, trustedEmpiricalClaimUniverse, blockers }) {
  if (!trustedEmpiricalClaimUniverse) return Object.freeze([]);
  const current = readEmpiricalClaimUniverse({ sourceRoot, manuscriptPath, maximumFiles });
  if (trustedEmpiricalClaimUniverse?.status !== 'empirical_claim_universe_verified'
    || current.status !== 'empirical_claim_universe_verified'
    || current.empiricalClaimUniverseHash !== trustedEmpiricalClaimUniverse.empiricalClaimUniverseHash
    || current.manuscriptCorpusHash !== trustedEmpiricalClaimUniverse.manuscriptCorpusHash) {
    blockers.push('empirical_assertion_trusted_claim_universe_mismatch');
    return Object.freeze([]);
  }
  return Object.freeze(current.claims.map((claim) => Object.freeze({
    claimId: claim.claimId,
    manuscriptPath: claim.manuscriptPath,
    markerByteStart: claim.markerByteStart,
    markerByteEnd: claim.markerByteEnd,
    manuscriptContentHash: claim.manuscriptContentHash,
  })));
}

function inspectRenderSupportFiles(rootPath, blockers, maximumEntries = 2048) {
  const pending = [{ directory: rootPath, depth: 0 }];
  let entriesSeen = 0;
  while (pending.length) {
    const { directory, depth } = pending.pop();
    if (depth > 8) {
      blockers.push('empirical_assertion_render_support_depth_exceeded');
      continue;
    }
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch {
      blockers.push('empirical_assertion_render_support_unreadable');
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      entriesSeen += 1;
      if (entriesSeen > maximumEntries) {
        blockers.push('empirical_assertion_render_support_limit_exceeded');
        return;
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        blockers.push(`empirical_assertion_render_support_symlink_forbidden:${path.relative(rootPath, candidate)}`);
      } else if (entry.isDirectory()) pending.push({ directory: candidate, depth: depth + 1 });
      else if (entry.isFile() && FORBIDDEN_RENDER_SUPPORT_EXTENSION.test(entry.name)) {
        blockers.push(`empirical_assertion_render_support_file_forbidden:${path.relative(rootPath, candidate)}`);
      }
    }
  }
}

function safeSection(title) {
  const normalized = String(title || '').replace(/\\[A-Za-z@]+\s*/g, '').trim().toLowerCase();
  return SAFE_SECTION_TITLES.has(normalized);
}

function lineIncludes(line, includes) {
  return includes.filter((included) => included.offset >= line.byteStart && included.offset < line.byteEnd);
}

function untypedLineRemainder(source, includes) {
  let value = source;
  for (const included of [...includes].sort((left, right) => right.offset - left.offset)) {
    value = `${value.slice(0, included.offset)}${value.slice(included.end)}`;
  }
  return value
    .replace(/\\label\s*\{[^{}]+\}/g, '')
    .trim();
}

function environmentBoundary(line) {
  const match = String(line || '').match(ENVIRONMENT_BOUNDARY);
  if (!match) return null;
  return Object.freeze({ action: match[1].toLowerCase(), environment: match[2].toLowerCase() });
}

export function readEmpiricalAssertionUniverse({
  sourceRoot,
  manuscriptPath = 'main.tex',
  maximumFiles = 128,
  trustedEmpiricalClaimUniverse = null,
  trustedFormalSupportAuthority = null,
} = {}) {
  const rootPath = path.resolve(sourceRoot || '.');
  const rootManuscript = safeManuscriptPath(manuscriptPath);
  const blockers = [];
  if (trustedFormalSupportAuthority
    && !verifyAutonomousFormalSupportSurfaceAuthority(trustedFormalSupportAuthority)) {
    blockers.push('autonomous_formal_support_trusted_authority_invalid');
  }
  inspectRenderSupportFiles(rootPath, blockers);
  const claimRanges = trustedClaimRanges({
    sourceRoot: rootPath,
    manuscriptPath: rootManuscript,
    maximumFiles,
    trustedEmpiricalClaimUniverse,
    blockers,
  });
  const files = [];
  const extractedAssertions = [];
  const extractedPresentations = [];
  const extractedFormalSupports = [];
  const visited = new Set();
  const active = new Set();
  const visit = (relative, depth = 0) => {
    if (!relative) return;
    if (active.has(relative)) {
      blockers.push(`empirical_assertion_universe_include_cycle:${relative}`);
      return;
    }
    if (visited.has(relative)) {
      blockers.push(`empirical_assertion_universe_include_repeated:${relative}`);
      return;
    }
    if (visited.size >= maximumFiles || depth > 32) {
      blockers.push('empirical_assertion_universe_include_limit_exceeded');
      return;
    }
    visited.add(relative);
    active.add(relative);
    const read = readScopedFileSync({ scopeRoot: rootPath, candidate: path.join(rootPath, relative) });
    if (read.status !== 'scoped_file_read_verified') {
      blockers.push(`empirical_assertion_universe_manuscript_unreadable:${relative}`);
      active.delete(relative);
      return;
    }
    files.push(Object.freeze({ path: relative, hash: read.hash, bytes: read.bytes }));
    const latin1 = read.content.toString('latin1');
    const syntax = analyzeTheoremEnvironmentMacroDefinitions(latin1);
    for (const blocker of syntax.blockers) {
      blockers.push(`empirical_assertion_universe_dynamic_tex_unsupported:${relative}:${blocker.offset}`);
    }
    const includeResult = literalIncludes(syntax.maskedSource, relative);
    blockers.push(...includeResult.blockers);
    const extracted = extractAssertions(relative, read);
    blockers.push(...extracted.blockers);
    extractedAssertions.push(...extracted.assertions);
    const presentationResult = extractPresentations(relative, read, rootPath);
    blockers.push(...presentationResult.blockers);
    extractedPresentations.push(...presentationResult.presentations);
    const formalSupportResult = extractFormalSupportSurfaces({
      relative, read, trustedAuthority: trustedFormalSupportAuthority,
    });
    blockers.push(...formalSupportResult.blockers);
    extractedFormalSupports.push(...formalSupportResult.formalSupports);
    for (const line of manuscriptLineRecords(latin1)) {
      if (LEGACY_RESULT_MARKER.test(line.text)) {
        blockers.push(`legacy_empirical_result_marker_forbidden:${relative}:${line.byteStart}`);
      }
      const rawWithoutComment = stripLatexComment(line.text);
      const section = rawWithoutComment.match(SECTION_COMMAND);
      if (!insideAssertion(line, extracted.assertions)
        && !insidePresentation(line, presentationResult.presentations)
        && !lineInsideFormalSupportSurface(line, formalSupportResult.formalSupports)
        && UNSUPPORTED_RESULT_SURFACE.test(rawWithoutComment)) {
        blockers.push(`empirical_assertion_unsupported_result_surface:${relative}:${line.byteStart}`);
      }
      const includesOnLine = lineIncludes(line, includeResult.includes);
      for (const included of includesOnLine) visit(included.path, depth + 1);
      if (insideAssertion(line, extracted.assertions)
        || insidePresentation(line, presentationResult.presentations)
        || lineInsideFormalSupportSurface(line, formalSupportResult.formalSupports)
        || insideClaim(line, claimRanges.filter((claim) => claim.manuscriptPath === relative))) continue;
      const boundary = environmentBoundary(rawWithoutComment);
      if (boundary?.environment === 'document' && SAFE_STANDALONE_COMMAND.test(rawWithoutComment)) continue;
      if (boundary) {
        blockers.push(`empirical_assertion_unsupported_environment:${relative}:${line.byteStart}`);
        continue;
      }
      const lineRelativeIncludes = includesOnLine.map((included) => ({
        ...included,
        offset: included.offset - line.byteStart,
        end: included.end - line.byteStart,
      }));
      const remainder = untypedLineRemainder(rawWithoutComment, lineRelativeIncludes);
      if (!remainder) continue;
      if (section) {
        if (!safeSection(section[1])) blockers.push(`empirical_assertion_untrusted_section_surface:${relative}:${line.byteStart}`);
        continue;
      }
      if (SAFE_DOCUMENT_CLASS.test(remainder) || SAFE_PACKAGE_SET.test(remainder)
        || SAFE_THEOREM_DECLARATION.test(remainder)
        || SAFE_DOCUMENT_METADATA.test(remainder) || SAFE_STANDALONE_COMMAND.test(remainder)
        || SAFE_LABEL_COMMAND.test(remainder) || SAFE_FIXED_PROSE.has(remainder)) continue;
      blockers.push(`empirical_assertion_untyped_result_prose:${relative}:${line.byteStart}`);
    }
    active.delete(relative);
  };
  if (!rootManuscript) blockers.push('empirical_assertion_universe_manuscript_path_invalid');
  else visit(rootManuscript);
  const sortedFiles = files.sort((left, right) => left.path.localeCompare(right.path));
  const sourceCorpusHash = hashRecord('EmpiricalAssertionSourceCorpus', sortedFiles);
  const assertions = extractedAssertions.sort((left, right) => left.manuscriptPath.localeCompare(right.manuscriptPath)
    || left.markerByteStart - right.markerByteStart);
  const presentations = extractedPresentations.sort((left, right) => left.manuscriptPath.localeCompare(right.manuscriptPath)
    || left.markerByteStart - right.markerByteStart);
  const formalSupports = extractedFormalSupports.sort((left, right) => left.manuscriptPath.localeCompare(right.manuscriptPath)
    || left.markerByteStart - right.markerByteStart);
  const ids = new Set();
  for (const assertion of assertions) {
    if (ids.has(assertion.declaration.assertionId)) {
      blockers.push(`empirical_assertion_universe_assertion_id_duplicate:${assertion.declaration.assertionId}`);
    }
    ids.add(assertion.declaration.assertionId);
  }
  if (!assertions.length) blockers.push('empirical_assertion_universe_assertions_missing');
  const surfaceIds = new Set();
  for (const presentation of presentations) {
    if (surfaceIds.has(presentation.declaration.surfaceId)) {
      blockers.push(`empirical_presentation_surface_id_duplicate:${presentation.declaration.surfaceId}`);
    }
    surfaceIds.add(presentation.declaration.surfaceId);
  }
  const formalSurfaceIds = new Set();
  for (const formalSupport of formalSupports) {
    if (formalSurfaceIds.has(formalSupport.declaration.surfaceId)) {
      blockers.push(`autonomous_formal_support_surface_id_duplicate:${formalSupport.declaration.surfaceId}`);
    }
    formalSurfaceIds.add(formalSupport.declaration.surfaceId);
  }
  if (trustedFormalSupportAuthority && formalSupports.length !== 1) {
    blockers.push('autonomous_formal_support_surface_count_invalid');
  }
  const presentationArtifacts = Object.freeze(presentations
    .filter((presentation) => presentation.artifact)
    .map((presentation) => presentation.artifact)
    .sort((left, right) => left.path.localeCompare(right.path)));
  const manuscriptCorpusHash = hashRecord('EmpiricalAssertionManuscriptCorpus', {
    manuscriptPath: rootManuscript,
    trustedEmpiricalClaimUniverseHash:
      trustedEmpiricalClaimUniverse?.empiricalClaimUniverseHash || null,
    trustedFormalSupportAuthorityHash:
      trustedFormalSupportAuthority?.autonomousFormalSupportSurfaceAuthorityHash || null,
    sourceCorpusHash,
    assertions: assertions.map((assertion) => ({
      assertionId: assertion.declaration.assertionId,
      authorityEntryHash: assertion.declaration.authorityEntryHash,
      manuscriptPath: assertion.manuscriptPath,
      markerByteStart: assertion.markerByteStart,
      markerByteEnd: assertion.markerByteEnd,
      manuscriptByteStart: assertion.manuscriptByteStart,
      manuscriptByteEnd: assertion.manuscriptByteEnd,
      manuscriptContentHash: assertion.manuscriptContentHash,
    })),
    presentations: presentations.map((presentation) => ({
      surfaceId: presentation.declaration.surfaceId,
      surfaceKind: presentation.declaration.surfaceKind,
      surfaceAuthorityEntryHash: presentation.declaration.surfaceAuthorityEntryHash,
      artifactPath: presentation.declaration.artifactPath,
      artifactHash: presentation.artifact?.hash || null,
      artifactBytes: presentation.artifact?.bytes ?? null,
      manuscriptPath: presentation.manuscriptPath,
      markerByteStart: presentation.markerByteStart,
      markerByteEnd: presentation.markerByteEnd,
      manuscriptByteStart: presentation.manuscriptByteStart,
      manuscriptByteEnd: presentation.manuscriptByteEnd,
      manuscriptContentHash: presentation.manuscriptContentHash,
    })),
    formalSupports: formalSupports.map((formalSupport) => ({
      surfaceId: formalSupport.declaration.surfaceId,
      authorityHash: formalSupport.declaration.authorityHash,
      templateHash: formalSupport.declaration.templateHash,
      proposalClaimRecordHash: formalSupport.declaration.proposalClaimRecordHash,
      manuscriptPath: formalSupport.manuscriptPath,
      markerByteStart: formalSupport.markerByteStart,
      markerByteEnd: formalSupport.markerByteEnd,
      manuscriptByteStart: formalSupport.manuscriptByteStart,
      manuscriptByteEnd: formalSupport.manuscriptByteEnd,
      manuscriptContentHash: formalSupport.manuscriptContentHash,
      formalSupportSurfaceHash: formalSupport.formalSupportSurfaceHash,
    })),
  });
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 1,
    kind: 'EmpiricalAssertionUniverse',
    status: uniqueBlockers.length
      ? 'empirical_assertion_universe_blocked'
      : 'empirical_assertion_universe_verified',
    manuscriptPath: rootManuscript,
    trustedEmpiricalClaimUniverseHash:
      trustedEmpiricalClaimUniverse?.empiricalClaimUniverseHash || null,
    trustedFormalSupportAuthorityHash:
      trustedFormalSupportAuthority?.autonomousFormalSupportSurfaceAuthorityHash || null,
    manuscriptCorpusHash,
    sourceCorpusHash,
    files: Object.freeze(sortedFiles),
    assertions: Object.freeze(assertions),
    presentations: Object.freeze(presentations),
    formalSupports: Object.freeze(formalSupports),
    presentationArtifacts,
    blockers: uniqueBlockers,
  };
  return Object.freeze({
    ...payload,
    empiricalAssertionUniverseHash: hashRecord('EmpiricalAssertionUniverse', payload),
  });
}
