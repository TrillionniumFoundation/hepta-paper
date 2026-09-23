import fs from 'node:fs';
import path from 'node:path';
import { stripLatexComment } from '../../paper-domain/quality/latex-comment-syntax.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { verifyExperimentRegistry } from '../../paper-domain/research/experiment-registry-verifier.mjs';
import { bindEmpiricalAssertionUniverse } from '../../paper-domain/research/empirical-assertion-contract.mjs';
import { readEmpiricalAssertionUniverse } from '../research-verify/empirical-assertion-universe-reader.mjs';
import {
  buildEmpiricalAssertionAuthorityFromRegistry,
  empiricalAssertionAuthorityEntriesMatch,
  readMaterializedEmpiricalAssertionAuthority,
} from './empirical-assertion-authority.mjs';
import {
  revalidateTrustedAutonomousManuscriptWorkspace,
} from './trusted-autonomous-manuscript-revalidation.mjs';

function bibKeys(workspace, manuscriptSource = '') {
  const keys = new Set();
  for (const name of fs.readdirSync(workspace).filter((value) => value.endsWith('.bib'))) {
    const source = fs.readFileSync(path.join(workspace, name), 'utf8');
    for (const match of source.matchAll(/@\w+\s*\{\s*([^,\s]+)/g)) keys.add(match[1]);
  }
  for (const match of String(manuscriptSource).matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)) keys.add(match[1].trim());
  return keys;
}

function citedKeys(source) {
  const keys = new Set();
  for (const match of source.matchAll(/\\cite\w*\s*\{([^}]+)\}/g)) {
    for (const key of match[1].split(',').map((value) => value.trim()).filter(Boolean)) keys.add(key);
  }
  return keys;
}

function referencedGraphics(source) {
  return [...source.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)].map((match) => match[1]);
}

function referencedInputs(source) {
  return [...source.matchAll(/\\(?:input|include)\{([^}]+)\}/g)].map((match) => match[1]);
}

function resultMarkers(source, sourcePath) {
  return String(source).split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/^\s*%\s*HEPTA_RESULT\s+(?:CLAIM\s+([A-Za-z0-9][A-Za-z0-9_.:-]{0,159})\s+)?([^#\s]+)#([^=\s]+)=([^\s%]+)\s*$/i);
    return match ? [{ claimId: match[1] || null, artifact: match[2], key: match[3], expected: match[4], sourcePath, line: index + 1 }] : [];
  });
}

function scalarAt(value, dottedKey) {
  let current = value;
  for (const part of String(dottedKey).split('.').filter(Boolean)) {
    if (current === null || typeof current !== 'object' || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function csvScalarAt(source, key) {
  const lines = String(source).trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return undefined;
  const headers = lines[0].split(',').map((value) => value.trim().replace(/^"|"$/g, ''));
  const rows = lines.slice(1).map((line) => line.split(',').map((value) => value.trim().replace(/^"|"$/g, '')));
  const metricIndex = headers.indexOf('metric');
  const valueIndex = headers.indexOf('value');
  if (metricIndex >= 0 && valueIndex >= 0) {
    const matching = rows.filter((row) => row[metricIndex] === key);
    return matching.length === 1 ? matching[0][valueIndex] : undefined;
  }
  const columnIndex = headers.indexOf(key);
  return rows.length === 1 && columnIndex >= 0 ? rows[0][columnIndex] : undefined;
}

function verifyResultMarker(workspace, marker) {
  const candidate = path.resolve(workspace, marker.artifact);
  let artifactStat = null;
  let realCandidate = null;
  try {
    artifactStat = fs.lstatSync(candidate);
    realCandidate = fs.realpathSync(candidate);
  } catch { /* invalid below */ }
  if (candidate === workspace || !isPathWithin(workspace, candidate)
    || !realCandidate || !isPathWithin(workspace, realCandidate)
    || artifactStat?.isSymbolicLink() || !artifactStat?.isFile()) {
    return { ...marker, actual: null, valid: false, reason: 'artifact_missing' };
  }
  let actual;
  let content = null;
  try {
    content = fs.readFileSync(candidate);
    if (/\.json$/i.test(candidate)) actual = scalarAt(JSON.parse(content.toString('utf8')), marker.key);
    else if (/\.csv$/i.test(candidate)) actual = csvScalarAt(content.toString('utf8'), marker.key);
    else return { ...marker, actual: null, valid: false, reason: 'artifact_type_unsupported' };
  } catch {
    return { ...marker, actual: null, valid: false, reason: 'artifact_parse_failed' };
  }
  let parsedExpected;
  try { parsedExpected = JSON.parse(marker.expected); } catch { parsedExpected = marker.expected; }
  const expectedNumber = Number(parsedExpected);
  const actualNumber = Number(actual);
  const structured = parsedExpected !== null && typeof parsedExpected === 'object';
  const valid = structured
    ? JSON.stringify(actual) === JSON.stringify(parsedExpected)
    : Number.isFinite(expectedNumber) && Number.isFinite(actualNumber)
      ? Math.abs(expectedNumber - actualNumber) <= Math.max(1e-12, Math.abs(actualNumber) * 1e-9)
      : String(actual) === String(parsedExpected);
  return { ...marker, actual, artifactHash: hashBytes(content), valid, reason: valid ? null : 'artifact_value_mismatch' };
}

function findEmpiricalArtifacts(workspace) {
  const found = [];
  const roots = ['automation-results', 'results.json', 'results.csv', 'experiments/results.json', 'experiments/results.csv'];
  const walk = (candidate) => {
    let stat;
    let real;
    try {
      stat = fs.lstatSync(candidate);
      real = fs.realpathSync(candidate);
    } catch { return; }
    if (stat.isSymbolicLink() || !isPathWithin(workspace, real)) return;
    if (stat.isFile()) { if (/results\.(?:json|csv)$/i.test(candidate)) found.push(path.relative(workspace, candidate).replace(/\\/g, '/')); return; }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(candidate)) walk(path.join(candidate, entry));
  };
  roots.forEach((relative) => walk(path.join(workspace, relative)));
  return [...new Set(found)].sort();
}

function resolveTexInput(workspace, sourceFile, reference) {
  const exact = path.resolve(path.dirname(sourceFile), reference);
  const candidates = [exact, `${exact}.tex`];
  return candidates.find((candidate) => {
    if (candidate === workspace || !isPathWithin(workspace, candidate)) return false;
    try {
      const stat = fs.lstatSync(candidate);
      const real = fs.realpathSync(candidate);
      return stat.isFile() && !stat.isSymbolicLink() && isPathWithin(workspace, real);
    } catch { return false; }
  }) || null;
}

function readTexCorpus(workspace, manuscript) {
  const pending = [manuscript];
  const visited = new Set();
  const documents = [];
  const missingInputs = [];
  while (pending.length) {
    const file = pending.pop();
    const real = fs.realpathSync(file);
    if (visited.has(real)) continue;
    visited.add(real);
    const source = fs.readFileSync(file, 'utf8');
    const sourcePath = path.relative(workspace, file).replace(/\\/g, '/');
    documents.push({ file, sourcePath, source });
    for (const reference of referencedInputs(source)) {
      const resolved = resolveTexInput(workspace, file, reference);
      if (resolved) pending.push(resolved);
      else missingInputs.push(`${sourcePath}:${reference}`);
    }
  }
  documents.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  return Object.freeze({ documents, missingInputs: [...new Set(missingInputs)].sort() });
}

const EMPIRICAL_LANGUAGE = /\b(?:experiment|empirical|observed|result|accuracy|precision|recall|f1|auc|loss|error|latency|runtime|throughput|speedup|memory|sample|mean|median|average|standard deviation|confidence|p[- ]?value|baseline|ablation|treatment)\b/i;
const EMPIRICAL_ASSERTION = /\b(?:is|are|was|were|shows?|showed|finds?|found|demonstrates?|demonstrated|achieves?|achieved|reaches?|reached|improves?|improved|outperforms?|outperformed|dominates?|dominated|reduces?|reduced|increases?|increased|decreases?|decreased|exceeds?|exceeded|beats?|beat|supports?|supported|confirms?|confirmed|rejects?|rejected)\b/i;
const NUMERIC_TOKEN = /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g;

function numericValues(value) {
  if (Array.isArray(value)) return value.flatMap(numericValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(numericValues);
  const number = Number(value);
  return Number.isFinite(number) ? [number] : [];
}

function markerNumbers(marker) {
  let parsed = marker.expected;
  try { parsed = JSON.parse(marker.expected); } catch { /* string value */ }
  return numericValues(parsed);
}

function approximatelyEqual(left, right) {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(right) * 1e-9)
    || Math.abs(left - (right * 100)) <= Math.max(1e-10, Math.abs(right * 100) * 1e-9)
    || Math.abs((left * 100) - right) <= Math.max(1e-10, Math.abs(right) * 1e-9);
}

function markersBindClaim(markers, numbers) {
  const boundNumbers = markers.filter((marker) => marker.valid).flatMap(markerNumbers);
  return numbers.length > 0 && boundNumbers.length > 0
    && numbers.every((number) => boundNumbers.some((expected) => approximatelyEqual(number, expected)));
}

function numericClaimSource(line) {
  return String(line || '')
    .replace(/\\(?:cite\w*|ref|eqref|pageref|label|url)\s*\{[^}]*\}/g, '')
    .replace(/\\href\s*\{[^}]*\}\s*\{[^}]*\}/g, '')
    .replace(/\\(?:begin|end)\{[^}]+\}/g, '')
    .replace(/^\s*\\(?:documentclass|usepackage|newtheorem|title|author|date|section|subsection|subsubsection|paragraph)\b.*$/, '');
}

function findUnboundEmpiricalNumericClaims(corpus, provenance, { strict = false } = {}) {
  const markersBySource = new Map();
  for (const marker of provenance) {
    const entries = markersBySource.get(marker.sourcePath) || [];
    entries.push(marker);
    markersBySource.set(marker.sourcePath, entries);
  }
  const unbound = [];
  for (const document of corpus.documents) {
    let empiricalEnvironmentDepth = 0;
    let bibliographyDepth = 0;
    const lines = document.source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const sourceLine = stripLatexComment(lines[index]);
      const opens = [...sourceLine.matchAll(/\\begin\{(?:table\*?|tabular\*?|figure\*?)\}/g)].length;
      const closes = [...sourceLine.matchAll(/\\end\{(?:table\*?|tabular\*?|figure\*?)\}/g)].length;
      const bibliographyOpens = [...sourceLine.matchAll(/\\begin\{thebibliography\}/g)].length;
      const bibliographyCloses = [...sourceLine.matchAll(/\\end\{thebibliography\}/g)].length;
      const inEmpiricalEnvironment = empiricalEnvironmentDepth > 0 || opens > 0;
      const inBibliography = bibliographyDepth > 0 || bibliographyOpens > 0;
      const numericSource = numericClaimSource(sourceLine);
      const numbers = [...numericSource.matchAll(NUMERIC_TOKEN)]
        .map((match) => Number(match[0])).filter(Number.isFinite);
      if (!inBibliography && numbers.length
        && (strict || inEmpiricalEnvironment || EMPIRICAL_LANGUAGE.test(sourceLine))) {
        const nearby = (markersBySource.get(document.sourcePath) || [])
          .filter((marker) => Math.abs(marker.line - (index + 1)) <= 3);
        if (!markersBindClaim(nearby, numbers)) {
          unbound.push(Object.freeze({
            sourcePath: document.sourcePath,
            line: index + 1,
            sourceHash: hashBytes(sourceLine),
            numericValues: numbers,
          }));
        }
      }
      empiricalEnvironmentDepth = Math.max(0, empiricalEnvironmentDepth + opens - closes);
      bibliographyDepth = Math.max(0, bibliographyDepth + bibliographyOpens - bibliographyCloses);
    }
  }
  return unbound;
}

function findUnboundEmpiricalAssertions(corpus, provenance) {
  const markersBySource = new Map();
  for (const marker of provenance) {
    const entries = markersBySource.get(marker.sourcePath) || [];
    entries.push(marker);
    markersBySource.set(marker.sourcePath, entries);
  }
  const unbound = [];
  for (const document of corpus.documents) {
    let declaredClaimDepth = 0;
    const lines = document.source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (/^\s*%\s*HEPTA_EMPIRICAL_CLAIM_BEGIN\b/.test(lines[index])) {
        declaredClaimDepth += 1;
        continue;
      }
      if (/^\s*%\s*HEPTA_EMPIRICAL_CLAIM_END\b/.test(lines[index])) {
        declaredClaimDepth = Math.max(0, declaredClaimDepth - 1);
        continue;
      }
      if (declaredClaimDepth > 0) continue;
      const sourceLine = stripLatexComment(lines[index]);
      if (!EMPIRICAL_LANGUAGE.test(sourceLine) || !EMPIRICAL_ASSERTION.test(sourceLine)) continue;
      const nearby = (markersBySource.get(document.sourcePath) || [])
        .filter((marker) => marker.valid && Math.abs(marker.line - (index + 1)) <= 3);
      if (!nearby.length) unbound.push(Object.freeze({
        sourcePath: document.sourcePath,
        line: index + 1,
        sourceHash: hashBytes(sourceLine),
      }));
    }
  }
  return unbound;
}

function resolveGraphic(base, reference, workspace) {
  const exact = path.resolve(base, reference);
  const candidates = [exact, ...['.pdf', '.png', '.jpg', '.jpeg', '.eps'].map((suffix) => `${exact}${suffix}`)];
  return candidates.find((candidate) => {
    if (!isPathWithin(workspace, candidate)) return false;
    try {
      const stat = fs.lstatSync(candidate);
      return stat.isFile() && !stat.isSymbolicLink() && isPathWithin(workspace, fs.realpathSync(candidate));
    } catch { return false; }
  }) || null;
}

function graphicContentValid(content) {
  if (content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return true;
  const prefix = content.subarray(0, 16).toString('latin1');
  return prefix.startsWith('%PDF-') || prefix.startsWith('%!PS-Adobe');
}

function inspectGraphic({ document, reference }, workspace) {
  const candidate = resolveGraphic(path.dirname(document.file), reference, workspace)
    || resolveGraphic(workspace, reference, workspace);
  if (!candidate) return Object.freeze({ sourcePath: document.sourcePath, reference, path: null, hash: null, valid: false, reason: 'missing' });
  const relative = path.relative(workspace, candidate).replace(/\\/g, '/');
  const content = fs.readFileSync(candidate);
  const valid = graphicContentValid(content);
  return Object.freeze({
    sourcePath: document.sourcePath,
    reference,
    path: relative,
    hash: hashBytes(content),
    valid,
    reason: valid ? null : 'content_signature_invalid',
  });
}

export function runManuscriptQualityChecks({
  workspacePath,
  manuscriptPath = 'main.tex',
  mode = 'all',
  requiresEmpiricalArtifacts = false,
  requiresTrustedEmpiricalAuthority = false,
  experimentRegistry = null,
  experimentRegistryAuthorityVerifier = null,
  expectedPaperId = null,
  expectedCampaignId = null,
  expectedEmpiricalAssertionAuthority = null,
  expectedEmpiricalAssertionUniverse = null,
  expectedEmpiricalAssertionUniverseBinding = null,
  trustedAutonomousManuscriptRenderReceipt = null,
  trustedAutonomousManuscriptAgentExecutionReceipt = null,
  trustedAutonomousManuscriptCampaignNodes = null,
} = {}) {
  const workspace = path.resolve(workspacePath || '');
  const manuscript = path.resolve(workspace, manuscriptPath);
  let manuscriptStat = null;
  let realManuscript = null;
  try {
    manuscriptStat = fs.lstatSync(manuscript);
    realManuscript = fs.realpathSync(manuscript);
  } catch { /* invalid below */ }
  if (manuscript === workspace || !isPathWithin(workspace, manuscript)
    || manuscriptStat?.isSymbolicLink() || !manuscriptStat?.isFile()
    || !realManuscript || !isPathWithin(workspace, realManuscript)) {
    throw new Error('existing manuscript inside workspace is required');
  }
  const source = fs.readFileSync(manuscript, 'utf8');
  const corpus = readTexCorpus(workspace, manuscript);
  const corpusSource = corpus.documents.map((document) => document.source).join('\n');
  const blockers = [];
  const details = {};
  if (['all', 'citations'].includes(mode)) {
    const declared = bibKeys(workspace, corpusSource);
    const cited = citedKeys(corpusSource);
    details.citedKeyCount = cited.size;
    details.bibliographyKeyCount = declared.size;
    details.missingCitationKeys = [...cited].filter((key) => !declared.has(key)).sort();
    if (details.missingCitationKeys.length) blockers.push('missing_bibliography_entries');
  }
  if (['all', 'artifacts'].includes(mode)) {
    const graphics = corpus.documents.flatMap((document) => referencedGraphics(document.source)
      .map((reference) => ({ document, reference })));
    const inputs = corpus.documents.flatMap((document) => referencedInputs(document.source));
    const legacyMarkerTokens = corpus.documents.flatMap((document) => document.source.split(/\r?\n/)
      .flatMap((line, index) => /HEPTA_RESULT\b/i.test(line)
        ? [`${document.sourcePath}:${index + 1}`] : []));
    const requiresTrustedAutonomousManuscriptAuthority = Boolean(
      trustedAutonomousManuscriptRenderReceipt,
    );
    const trustedAutonomousManuscriptRevalidation =
      requiresTrustedAutonomousManuscriptAuthority
        ? revalidateTrustedAutonomousManuscriptWorkspace({
          workspacePath: workspace,
          manuscriptPath,
          paperId: expectedPaperId,
          campaignId: expectedCampaignId,
          campaignNodes: trustedAutonomousManuscriptCampaignNodes || [],
          trustedAutonomousManuscriptRenderReceipt,
          agentExecutionReceipt: trustedAutonomousManuscriptAgentExecutionReceipt,
        }) : null;
    let provenance = corpus.documents.flatMap((document) => resultMarkers(document.source, document.sourcePath))
      .map((marker) => verifyResultMarker(workspace, marker));
    let experimentRegistryVerification = null;
    let empiricalAssertionAuthority = null;
    let empiricalAssertionUniverse = null;
    let empiricalAssertionUniverseBinding = null;
    let materializedEmpiricalAssertionAuthority = null;
    const empiricalAssertionBlockers = [];
    if (requiresTrustedEmpiricalAuthority) {
      experimentRegistryVerification = verifyExperimentRegistry(experimentRegistry, {
        expectedPaperId,
        expectedCampaignId,
        authorityVerifier: experimentRegistryAuthorityVerifier,
        empiricalClaimUniverse: experimentRegistry?.empiricalClaimUniverse || null,
      });
      if (experimentRegistryVerification.valid) {
        try {
          empiricalAssertionAuthority = buildEmpiricalAssertionAuthorityFromRegistry({
            registry: experimentRegistry,
            paperId: expectedPaperId,
            campaignId: expectedCampaignId,
            registryVerified: true,
          });
          empiricalAssertionUniverse = readEmpiricalAssertionUniverse({
            sourceRoot: workspace,
            manuscriptPath,
            trustedEmpiricalClaimUniverse: experimentRegistry.empiricalClaimUniverse,
          });
          empiricalAssertionUniverseBinding = bindEmpiricalAssertionUniverse({
            authority: empiricalAssertionAuthority,
            universe: empiricalAssertionUniverse,
            expectedPaperId,
            expectedCampaignId,
            expectedExperimentRegistryHash: experimentRegistry.experimentRegistryHash,
          });
          empiricalAssertionBlockers.push(...empiricalAssertionUniverseBinding.blockers);
          materializedEmpiricalAssertionAuthority = readMaterializedEmpiricalAssertionAuthority({
            workspace,
            expectedPaperId,
            expectedCampaignId,
          });
          empiricalAssertionBlockers.push(...materializedEmpiricalAssertionAuthority.blockers);
          if (materializedEmpiricalAssertionAuthority.valid
            && !empiricalAssertionAuthorityEntriesMatch(
              materializedEmpiricalAssertionAuthority.authority,
              empiricalAssertionAuthority,
            )) empiricalAssertionBlockers.push('empirical_assertion_materialized_authority_mismatch');
          if (!expectedEmpiricalAssertionAuthority || !expectedEmpiricalAssertionUniverse
            || !expectedEmpiricalAssertionUniverseBinding) {
            empiricalAssertionBlockers.push('empirical_assertion_research_report_binding_missing');
          } else {
            if (expectedEmpiricalAssertionAuthority.empiricalAssertionAuthorityHash
              !== empiricalAssertionAuthority.empiricalAssertionAuthorityHash) {
              empiricalAssertionBlockers.push('empirical_assertion_research_report_authority_mismatch');
            }
            if (expectedEmpiricalAssertionUniverse.empiricalAssertionUniverseHash
                !== empiricalAssertionUniverse.empiricalAssertionUniverseHash
              || expectedEmpiricalAssertionUniverse.manuscriptCorpusHash
                !== empiricalAssertionUniverse.manuscriptCorpusHash) {
              empiricalAssertionBlockers.push('empirical_assertion_research_report_corpus_mismatch');
            }
            if (expectedEmpiricalAssertionUniverseBinding.empiricalAssertionUniverseBindingHash
              !== empiricalAssertionUniverseBinding.empiricalAssertionUniverseBindingHash) {
              empiricalAssertionBlockers.push('empirical_assertion_research_report_binding_mismatch');
            }
          }
        } catch (error) {
          empiricalAssertionBlockers.push(`empirical_assertion_final_verification_failed:${error?.message || 'unknown'}`);
        }
      }
    }
    const graphicInspections = graphics.map((graphic) => inspectGraphic(graphic, workspace));
    const boundPresentationArtifacts = new Map([
      ...(empiricalAssertionUniverseBinding?.presentationBindings || [])
        .filter((binding) => binding.artifactPath && binding.artifactHash)
        .map((binding) => [binding.artifactPath, binding.artifactHash]),
      ...(trustedAutonomousManuscriptRevalidation?.passed
        ? trustedAutonomousManuscriptRevalidation.presentationArtifacts
          .map((artifact) => [artifact.path, artifact.hash])
        : []),
    ]);
    details.referencedGraphicCount = graphics.length;
    details.missingGraphics = graphicInspections.filter((graphic) => !graphic.path)
      .map((graphic) => `${graphic.sourcePath}:${graphic.reference}`);
    details.invalidGraphics = (requiresEmpiricalArtifacts || requiresTrustedEmpiricalAuthority
      || requiresTrustedAutonomousManuscriptAuthority)
      ? graphicInspections.filter((graphic) => graphic.path && !graphic.valid)
      : [];
    details.unsupportedEmpiricalGraphics = (requiresEmpiricalArtifacts
      || requiresTrustedEmpiricalAuthority || requiresTrustedAutonomousManuscriptAuthority)
      ? graphicInspections.filter((graphic) => graphic.path
        && boundPresentationArtifacts.get(graphic.path) !== graphic.hash)
      : [];
    details.referencedInputCount = inputs.length;
    details.missingInputs = corpus.missingInputs;
    details.resultProvenanceMarkerCount = provenance.length;
    details.invalidResultProvenance = requiresTrustedEmpiricalAuthority
      || requiresTrustedAutonomousManuscriptAuthority
      ? provenance : provenance.filter((marker) => !marker.valid);
    details.legacyEmpiricalResultMarkers = legacyMarkerTokens;
    details.trustedResultAuthorityRequired = Boolean(
      requiresTrustedEmpiricalAuthority || requiresTrustedAutonomousManuscriptAuthority,
    );
    details.trustedAutonomousManuscriptAuthorityRequired =
      requiresTrustedAutonomousManuscriptAuthority;
    details.trustedAutonomousManuscriptRevalidation =
      trustedAutonomousManuscriptRevalidation;
    details.experimentRegistryVerification = experimentRegistryVerification;
    details.empiricalAssertionAuthority = empiricalAssertionAuthority;
    details.empiricalAssertionUniverse = empiricalAssertionUniverse;
    details.empiricalAssertionUniverseBinding = empiricalAssertionUniverseBinding;
    details.materializedEmpiricalAssertionAuthority = materializedEmpiricalAssertionAuthority;
    details.empiricalAssertionBlockers = [...new Set(empiricalAssertionBlockers)];
    details.unsupportedTypedEmpiricalSurfaces = requiresTrustedEmpiricalAuthority
      ? (empiricalAssertionUniverse?.blockers || [])
        .filter((blocker) => blocker.startsWith('empirical_assertion_unsupported_result_surface:'))
      : [];
    details.unresolvedMarkers = [...corpusSource.matchAll(/\b(?:TODO|TBD|FIXME|INSERT RESULT)\b/gi)].map((match) => match[0]);
    const empiricalFiles = findEmpiricalArtifacts(workspace);
    details.empiricalArtifactCount = empiricalFiles.length;
    details.trustedPresentationArtifactCount = boundPresentationArtifacts.size;
    details.manuscriptCorpusFiles = corpus.documents.map((document) => document.sourcePath);
    details.unboundEmpiricalNumericClaims = requiresTrustedEmpiricalAuthority
      || requiresTrustedAutonomousManuscriptAuthority ? []
      : findUnboundEmpiricalNumericClaims(corpus, provenance, {
        strict: Boolean(requiresEmpiricalArtifacts),
      });
    details.unboundEmpiricalAssertions = requiresTrustedEmpiricalAuthority
      || requiresTrustedAutonomousManuscriptAuthority ? []
      : findUnboundEmpiricalAssertions(corpus, provenance);
    if (details.missingGraphics.length) blockers.push('missing_figure_artifacts');
    if (details.invalidGraphics.length) blockers.push('invalid_figure_artifacts');
    if (details.unsupportedEmpiricalGraphics.length) blockers.push('empirical_figure_artifacts_unsupported');
    if (details.missingInputs.length) blockers.push('missing_table_or_input_artifacts');
    if (!requiresTrustedEmpiricalAuthority && !requiresTrustedAutonomousManuscriptAuthority
      && details.invalidResultProvenance.length) blockers.push('claim_result_provenance_mismatch');
    if (requiresTrustedEmpiricalAuthority && experimentRegistryVerification?.valid !== true) blockers.push('empirical_result_registry_authority_invalid');
    if ((requiresTrustedEmpiricalAuthority || requiresTrustedAutonomousManuscriptAuthority)
      && legacyMarkerTokens.length) blockers.push('legacy_empirical_result_marker_forbidden');
    if ((requiresTrustedEmpiricalAuthority || requiresTrustedAutonomousManuscriptAuthority)
      && provenance.length) {
      blockers.push('claim_result_provenance_mismatch', 'empirical_result_artifact_authority_missing');
    }
    if (requiresTrustedEmpiricalAuthority && details.unsupportedTypedEmpiricalSurfaces.length) {
      blockers.push('empirical_structured_result_surface_unsupported');
    }
    if (requiresTrustedEmpiricalAuthority && empiricalAssertionBlockers.length) {
      blockers.push('empirical_assertion_authority_binding_invalid', ...empiricalAssertionBlockers);
    }
    if (requiresTrustedAutonomousManuscriptAuthority
      && trustedAutonomousManuscriptRevalidation?.passed !== true) {
      blockers.push(
        'trusted_autonomous_manuscript_revalidation_invalid',
        ...(trustedAutonomousManuscriptRevalidation?.blockers || []),
      );
    }
    if (!requiresTrustedEmpiricalAuthority && !requiresTrustedAutonomousManuscriptAuthority
      && empiricalFiles.length && provenance.length === 0) {
      blockers.push('empirical_claim_provenance_missing');
    }
    if ((requiresEmpiricalArtifacts || empiricalFiles.length > 0) && details.unboundEmpiricalNumericClaims.length) {
      blockers.push('empirical_numeric_claim_provenance_missing');
    }
    if ((requiresEmpiricalArtifacts || requiresTrustedEmpiricalAuthority)
      && details.unboundEmpiricalAssertions.length) blockers.push('empirical_assertion_provenance_missing');
    if (details.unresolvedMarkers.length) blockers.push('unresolved_manuscript_markers');
    if (requiresEmpiricalArtifacts && /\\begin\{(?:table|figure)\}/.test(source)
      && empiricalFiles.length === 0 && boundPresentationArtifacts.size === 0) {
      blockers.push('table_or_figure_without_empirical_artifact');
    }
  }
  const payload = {
    version: 1,
    kind: 'ManuscriptQualityCheckReceipt',
    mode,
    requiresEmpiricalArtifacts: Boolean(requiresEmpiricalArtifacts),
    requiresTrustedEmpiricalAuthority: Boolean(requiresTrustedEmpiricalAuthority),
    requiresTrustedAutonomousManuscriptAuthority: Boolean(
      trustedAutonomousManuscriptRenderReceipt,
    ),
    experimentRegistryHash: requiresTrustedEmpiricalAuthority ? experimentRegistry?.experimentRegistryHash || null : null,
    trustedAutonomousManuscriptRenderReceiptHash:
      trustedAutonomousManuscriptRenderReceipt
        ?.trustedAutonomousManuscriptRenderReceiptHash || null,
    manuscriptPath,
    manuscriptHash: hashBytes(source),
    manuscriptCorpusHash: hashRecord('ManuscriptTexCorpus', corpus.documents.map((document) => ({
      sourcePath: document.sourcePath,
      sourceHash: hashBytes(document.source),
    }))),
    passed: blockers.length === 0,
    status: blockers.length ? 'manuscript_quality_check_failed' : 'manuscript_quality_check_passed',
    blockers,
    details,
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, manuscriptQualityCheckReceiptHash: hashRecord('ManuscriptQualityCheckReceipt', payload) });
}
