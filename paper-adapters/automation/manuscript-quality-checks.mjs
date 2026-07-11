import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

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

function resultMarkers(source) {
  return [...source.matchAll(/^\s*%\s*HEPTA_RESULT\s+([^#\s]+)#([^=\s]+)=([^\s%]+)\s*$/gim)].map((match) => ({ artifact: match[1], key: match[2], expected: match[3] }));
}

function scalarAt(value, dottedKey) {
  let current = value;
  for (const part of String(dottedKey).split('.').filter(Boolean)) {
    if (current === null || typeof current !== 'object' || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function firstCsvValue(source, column) {
  const lines = String(source).trim().split(/\r?\n/);
  if (lines.length < 2) return undefined;
  const headers = lines[0].split(',').map((value) => value.trim().replace(/^"|"$/g, ''));
  const values = lines[1].split(',').map((value) => value.trim().replace(/^"|"$/g, ''));
  const index = headers.indexOf(column);
  return index >= 0 ? values[index] : undefined;
}

function verifyResultMarker(workspace, marker) {
  const candidate = path.resolve(workspace, marker.artifact);
  if (!candidate.startsWith(`${workspace}${path.sep}`) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return { ...marker, actual: null, valid: false, reason: 'artifact_missing' };
  let actual;
  try {
    if (/\.json$/i.test(candidate)) actual = scalarAt(JSON.parse(fs.readFileSync(candidate, 'utf8')), marker.key);
    else if (/\.csv$/i.test(candidate)) actual = firstCsvValue(fs.readFileSync(candidate, 'utf8'), marker.key);
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
  return { ...marker, actual, valid, reason: valid ? null : 'artifact_value_mismatch' };
}

function findEmpiricalArtifacts(workspace) {
  const found = [];
  const roots = ['automation-results', 'results.json', 'results.csv', 'experiments/results.json', 'experiments/results.csv'];
  const walk = (candidate) => {
    if (!fs.existsSync(candidate)) return;
    const stat = fs.statSync(candidate);
    if (stat.isFile()) { if (/results\.(?:json|csv)$/i.test(candidate)) found.push(path.relative(workspace, candidate).replace(/\\/g, '/')); return; }
    for (const entry of fs.readdirSync(candidate)) walk(path.join(candidate, entry));
  };
  roots.forEach((relative) => walk(path.join(workspace, relative)));
  return [...new Set(found)].sort();
}

function resolveGraphic(workspace, reference) {
  const exact = path.resolve(workspace, reference);
  if (fs.existsSync(exact)) return exact;
  return ['.pdf', '.png', '.jpg', '.jpeg', '.eps'].map((suffix) => `${exact}${suffix}`).find(fs.existsSync) || null;
}

export function runManuscriptQualityChecks({ workspacePath, manuscriptPath = 'main.tex', mode = 'all' } = {}) {
  const workspace = path.resolve(workspacePath || '');
  const manuscript = path.resolve(workspace, manuscriptPath);
  if (!manuscript.startsWith(`${workspace}${path.sep}`) || !fs.existsSync(manuscript)) throw new Error('existing manuscript inside workspace is required');
  const source = fs.readFileSync(manuscript, 'utf8');
  const blockers = [];
  const details = {};
  if (['all', 'citations'].includes(mode)) {
    const declared = bibKeys(workspace, source);
    const cited = citedKeys(source);
    details.citedKeyCount = cited.size;
    details.bibliographyKeyCount = declared.size;
    details.missingCitationKeys = [...cited].filter((key) => !declared.has(key)).sort();
    if (details.missingCitationKeys.length) blockers.push('missing_bibliography_entries');
  }
  if (['all', 'artifacts'].includes(mode)) {
    const graphics = referencedGraphics(source);
    const inputs = referencedInputs(source);
    const provenance = resultMarkers(source).map((marker) => verifyResultMarker(workspace, marker));
    details.referencedGraphicCount = graphics.length;
    details.missingGraphics = graphics.filter((reference) => !resolveGraphic(workspace, reference));
    details.referencedInputCount = inputs.length;
    details.missingInputs = inputs.filter((reference) => {
      const exact = path.resolve(workspace, reference);
      return ![exact, `${exact}.tex`].some((candidate) => candidate.startsWith(`${workspace}${path.sep}`) && fs.existsSync(candidate));
    });
    details.resultProvenanceMarkerCount = provenance.length;
    details.invalidResultProvenance = provenance.filter((marker) => !marker.valid);
    details.unresolvedMarkers = [...source.matchAll(/\b(?:TODO|TBD|FIXME|INSERT RESULT)\b/gi)].map((match) => match[0]);
    const empiricalFiles = findEmpiricalArtifacts(workspace);
    details.empiricalArtifactCount = empiricalFiles.length;
    if (details.missingGraphics.length) blockers.push('missing_figure_artifacts');
    if (details.missingInputs.length) blockers.push('missing_table_or_input_artifacts');
    if (details.invalidResultProvenance.length) blockers.push('claim_result_provenance_mismatch');
    if (empiricalFiles.length && provenance.length === 0) blockers.push('empirical_claim_provenance_missing');
    if (details.unresolvedMarkers.length) blockers.push('unresolved_manuscript_markers');
    if (/\\begin\{(?:table|figure)\}/.test(source) && empiricalFiles.length === 0) blockers.push('table_or_figure_without_empirical_artifact');
  }
  const payload = {
    version: 1,
    kind: 'ManuscriptQualityCheckReceipt',
    mode,
    manuscriptPath,
    manuscriptHash: `sha256:${crypto.createHash('sha256').update(source).digest('hex')}`,
    passed: blockers.length === 0,
    status: blockers.length ? 'manuscript_quality_check_failed' : 'manuscript_quality_check_passed',
    blockers,
    details,
    externalActionPerformed: false,
  };
  return Object.freeze({ ...payload, manuscriptQualityCheckReceiptHash: hashRecord('ManuscriptQualityCheckReceipt', payload) });
}
