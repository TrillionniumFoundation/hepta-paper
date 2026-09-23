import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousSubmissionMetadataReceipt,
} from './autonomous-submission-metadata-contract.mjs';
import {
  verifyAutonomousVenueTemplateAssetRecord,
} from './autonomous-venue-template-asset-contract.mjs';
import {
  latexEscapeEvidenceBoundText,
} from '../research/evidence-bound-manuscript-ir.mjs';
import {
  verifyDeterministicPdfPageInspectionReceipt,
} from './deterministic-pdf-page-inspection-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const MAXIMUM_MANUSCRIPT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_MANIFEST_ROWS = 8_192;
const SOURCE_RECEIPT_KEYS = Object.freeze([
  'campaignReleaseBundleHash', 'contentEncoding', 'kind', 'manuscriptBytes',
  'manuscriptBytesBase64', 'manuscriptPath', 'renderedSourceHash',
  'sourceArchiveHash', 'sourceEntryManifestHash', 'sourceInspectionReceiptHash',
  'sourceTreeManifestHash', 'version',
]);
const ARTIFACT_EVIDENCE_KEYS = Object.freeze([
  'campaignReleaseBundleHash', 'immutableCampaignPackageOutputHash', 'kind',
  'packageFiles', 'packageVerificationReceiptHash',
  'researchEvidenceCapsuleManifestFileHash',
  'researchEvidenceCapsuleManifestHash', 'sourceTreeManifestHash',
  'venueReleaseArtifactEvidenceHash', 'version',
]);
const SOURCE_EVIDENCE_KEYS = Object.freeze([
  'autonomousVenueSourceEvidenceBundleHash', 'evidenceBoundManuscriptIrHash',
  'inspectedAt', 'kind', 'manuscriptIr', 'manuscriptIrFileHash',
  'pdfInspectionReceipt', 'pdfInspectionReceiptHash', 'releaseArtifactEvidence',
  'sourceInspectionReceipt', 'sourceInspectionReceiptHash',
  'sourceTreeManifest', 'sourceTreeManifestHash', 'submissionMetadataReceipt',
  'submissionMetadataReceiptHash', 'venueReleaseArtifactEvidenceHash',
  'venueRequirementIrFileHash', 'venueRequirementIrHash', 'version',
]);

function sha(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function recordHashValid(record, kind, hashField) {
  const { [hashField]: claimedHash, ...payload } = record || {};
  return Boolean(sha(claimedHash) && hashRecord(kind, payload) === claimedHash);
}

function safeRelativePath(value) {
  const candidate = String(value || '');
  return candidate.length > 0 && candidate.length <= 512
    && !candidate.startsWith('/') && !candidate.endsWith('/')
    && !candidate.includes('\\') && !candidate.includes('\0')
    && !candidate.includes('//')
    && candidate.split('/').every((part) => part && part !== '.' && part !== '..')
    ? candidate : null;
}

function canonicalBytes(value) {
  if (typeof value !== 'string' || value.length < 4
    || value.length > Math.ceil(MAXIMUM_MANUSCRIPT_BYTES / 3) * 4) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 1 || bytes.length > MAXIMUM_MANUSCRIPT_BYTES
    || bytes.toString('base64') !== value) return null;
  const source = bytes.toString('utf8');
  return Buffer.from(source, 'utf8').equals(bytes) ? bytes : null;
}

function validSourceTreeManifest(manifest) {
  const rows = manifest?.rows;
  return manifest?.version === 1
    && manifest?.kind === 'ScopedSourceTreeManifest'
    && manifest?.status === 'scoped_source_tree_verified'
    && recordHashValid(manifest, 'ScopedSourceTreeManifest', 'sourceTreeManifestHash')
    && Array.isArray(rows) && rows.length > 0 && rows.length <= MAXIMUM_MANIFEST_ROWS
    && manifest?.fileCount === rows.length
    && rows.every((row) => safeRelativePath(row?.path)
      && SAFE_ID.test(String(row?.role || ''))
      && typeof row?.required === 'boolean'
      && sha(row?.hash)
      && Number.isSafeInteger(row?.bytes) && row.bytes >= 0)
    && new Set(rows.map((row) => row.path)).size === rows.length
    && manifest?.totalBytes === rows.reduce((total, row) => total + row.bytes, 0)
    && Array.isArray(manifest?.blockers) && manifest.blockers.length === 0;
}

function uniqueRow(manifest, predicate) {
  const matches = (manifest?.rows || []).filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}

function validManuscriptIr(manuscriptIr) {
  const { evidenceBoundManuscriptIrHash: claimedHash, ...payload } = manuscriptIr || {};
  return Boolean(sha(claimedHash)
    && hashRecord('EvidenceBoundManuscriptIR', payload) === claimedHash
    && manuscriptIr?.status === 'evidence_bound_manuscript_ir_verified'
    && Array.isArray(manuscriptIr?.sections) && manuscriptIr.sections.length >= 3);
}

export function buildAutonomousVenueSourceInspectionReceipt({
  manuscriptPath = 'main.tex',
  manuscriptBytesBase64,
  sourceArchiveHash,
  sourceEntryManifestHash,
  sourceTreeManifest,
  campaignReleaseBundleHash,
} = {}) {
  const bytes = canonicalBytes(manuscriptBytesBase64);
  const selectedPath = safeRelativePath(manuscriptPath);
  const row = validSourceTreeManifest(sourceTreeManifest)
    ? uniqueRow(sourceTreeManifest, (candidate) => (
      candidate.path === selectedPath && candidate.role === 'main_tex'
    )) : null;
  const renderedSourceHash = bytes ? hashBytes(bytes) : null;
  const expectedEntryManifestHash = validSourceTreeManifest(sourceTreeManifest)
    ? hashRecord(
      'AutonomousVenueSourceEntries',
      sourceTreeManifest.rows.map((candidate) => candidate.path).sort(),
    ) : null;
  if (selectedPath !== 'main.tex' || !bytes || !row || row.required !== true
    || row.bytes !== bytes.length || row.hash !== renderedSourceHash
    || !sha(sourceArchiveHash) || sourceEntryManifestHash !== expectedEntryManifestHash
    || !sha(campaignReleaseBundleHash)) {
    throw new Error('autonomous_venue_source_inspection_receipt_invalid');
  }
  const payload = {
    version: 1,
    kind: 'AutonomousVenueSourceInspectionReceipt',
    manuscriptPath: selectedPath,
    contentEncoding: 'base64',
    manuscriptBytesBase64,
    manuscriptBytes: bytes.length,
    renderedSourceHash,
    sourceArchiveHash: sha(sourceArchiveHash),
    sourceEntryManifestHash: sha(sourceEntryManifestHash),
    sourceTreeManifestHash: sourceTreeManifest.sourceTreeManifestHash,
    campaignReleaseBundleHash: sha(campaignReleaseBundleHash),
  };
  return Object.freeze({
    ...payload,
    sourceInspectionReceiptHash:
      hashRecord('AutonomousVenueSourceInspectionReceipt', payload),
  });
}

export function verifyAutonomousVenueSourceInspectionReceipt(receipt, {
  sourceTreeManifest,
  releaseBinding = null,
  campaignReleaseBundleHash = null,
} = {}) {
  if (!hasExactObjectKeys(receipt, SOURCE_RECEIPT_KEYS)) return false;
  try {
    const rebuilt = buildAutonomousVenueSourceInspectionReceipt({
      ...receipt,
      sourceTreeManifest,
    });
    return JSON.stringify(rebuilt) === JSON.stringify(receipt)
      && (!releaseBinding || (
        releaseBinding.manuscriptPath === receipt.manuscriptPath
        && releaseBinding.renderedManuscriptHash === receipt.renderedSourceHash
        && releaseBinding.manuscriptPath === 'main.tex'
      ))
      && (!campaignReleaseBundleHash
        || campaignReleaseBundleHash === receipt.campaignReleaseBundleHash);
  } catch { return false; }
}

function canonicalPackagePath(file, packageOutput = null) {
  for (const direct of [file?.packagePath, file?.packageRelativePath, file?.path]) {
    const normalized = String(direct || '').replace(/\\/g, '/');
    if (safeRelativePath(normalized)) return normalized;
  }
  const absolute = String(file?.path || '').replace(/\\/g, '/');
  const packageDir = String(packageOutput?.packageDir || '').replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!absolute.startsWith('/') || !packageDir.startsWith('/')
    || !absolute.startsWith(`${packageDir}/`)) return null;
  const relative = absolute.slice(packageDir.length + 1);
  return safeRelativePath(relative) ? relative : null;
}

function canonicalPackageFiles(files, { packageOutput = null, evidence = false } = {}) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAXIMUM_MANIFEST_ROWS) {
    return null;
  }
  const selected = files.map((file) => Object.freeze({
    packagePath: canonicalPackagePath(file, packageOutput) || '',
    role: String(file?.role || ''),
    hash: String(file?.hash || '').toLowerCase(),
    bytes: Number(file?.bytes),
  })).sort((left, right) => (
    left.packagePath.localeCompare(right.packagePath)
      || left.role.localeCompare(right.role) || left.hash.localeCompare(right.hash)
  ));
  const sourceShapesValid = !evidence || files.every((file) => hasExactObjectKeys(file, [
    'bytes', 'hash', 'packagePath', 'role',
  ]));
  return selected.every((file) => safeRelativePath(file.packagePath)
    && SAFE_ID.test(file.role) && sha(file.hash)
    && Number.isSafeInteger(file.bytes) && file.bytes >= 0)
    && sourceShapesValid
    && new Set(selected.map((file) => `${file.packagePath}\0${file.role}`)).size
      === selected.length ? Object.freeze(selected) : null;
}

export function buildVenueReleaseArtifactEvidence({ releaseBundle } = {}) {
  const packageOutput = releaseBundle?.packageOutput || null;
  const sourceTreeManifest = releaseBundle?.promotionCandidate?.sourceTreeManifest || null;
  const packageFiles = canonicalPackageFiles(packageOutput?.files, { packageOutput });
  if (!recordHashValid(releaseBundle, 'CampaignReleaseBundle', 'campaignReleaseBundleHash')
    || !recordHashValid(
      packageOutput,
      'ImmutableCampaignPackageOutput',
      'immutableCampaignPackageOutputHash',
    )
    || !validSourceTreeManifest(sourceTreeManifest) || !packageFiles
    || releaseBundle.sourceTreeManifestHash !== sourceTreeManifest.sourceTreeManifestHash
    || !sha(releaseBundle.researchEvidenceCapsuleManifestHash)
    || !sha(releaseBundle.packageVerificationReceiptHash)
    || releaseBundle.packageVerificationReceiptHash
      !== packageOutput.packageVerificationReceiptHash
    || !sha(packageOutput.researchEvidenceCapsuleManifestFileHash)) {
    throw new Error('venue_release_artifact_evidence_invalid');
  }
  const payload = {
    version: 1,
    kind: 'VenueReleaseArtifactEvidence',
    campaignReleaseBundleHash: releaseBundle.campaignReleaseBundleHash,
    sourceTreeManifestHash: sourceTreeManifest.sourceTreeManifestHash,
    immutableCampaignPackageOutputHash:
      packageOutput.immutableCampaignPackageOutputHash,
    packageVerificationReceiptHash: releaseBundle.packageVerificationReceiptHash,
    researchEvidenceCapsuleManifestHash:
      releaseBundle.researchEvidenceCapsuleManifestHash,
    researchEvidenceCapsuleManifestFileHash:
      packageOutput.researchEvidenceCapsuleManifestFileHash,
    packageFiles,
  };
  return Object.freeze({
    ...payload,
    venueReleaseArtifactEvidenceHash:
      hashRecord('VenueReleaseArtifactEvidence', payload),
  });
}

export function verifyVenueReleaseArtifactEvidence(evidence, { releaseBundle = null } = {}) {
  const canonicalFiles = canonicalPackageFiles(evidence?.packageFiles, { evidence: true });
  if (!hasExactObjectKeys(evidence, ARTIFACT_EVIDENCE_KEYS)
    || !recordHashValid(
      evidence,
      'VenueReleaseArtifactEvidence',
      'venueReleaseArtifactEvidenceHash',
    ) || !canonicalFiles
    || JSON.stringify(canonicalFiles) !== JSON.stringify(evidence.packageFiles)) return false;
  if (!releaseBundle) return true;
  try {
    return JSON.stringify(buildVenueReleaseArtifactEvidence({ releaseBundle }))
      === JSON.stringify(evidence);
  } catch { return false; }
}

export function buildAutonomousVenueSourceEvidenceBundle({
  sourceInspectionReceipt,
  sourceTreeManifest,
  submissionMetadataReceipt,
  manuscriptIr,
  manuscriptIrFileHash,
  venueRequirementIrFileHash,
  pdfInspectionReceipt,
  releaseArtifactEvidence,
  venueRequirementIr,
  inspectedAt,
  releaseBinding = null,
  releaseBundle = null,
} = {}) {
  const irRow = validSourceTreeManifest(sourceTreeManifest)
    ? uniqueRow(sourceTreeManifest, (row) => row.path === 'AUTONOMOUS_MANUSCRIPT_IR.json')
    : null;
  const venueIrRow = validSourceTreeManifest(sourceTreeManifest)
    ? uniqueRow(
      sourceTreeManifest,
      (row) => row.path === 'AUTONOMOUS_VENUE_REQUIREMENT_IR.json',
    ) : null;
  const canonicalVenueRequirementIrFileHash = venueRequirementIr
    ? hashBytes(Buffer.from(JSON.stringify(venueRequirementIr), 'utf8')) : null;
  const sourceZipPath = String(releaseBundle?.packageOutput?.sourceZipPath || '')
    .replace(/\\/g, '/');
  const verifiedSourceArchives = releaseBundle
    ? (releaseBundle?.packageVerificationReceipt?.archives || []).filter((archive) => (
      archive?.sourceTreeManifestHash === sourceTreeManifest?.sourceTreeManifestHash
      && Number.isSafeInteger(archive?.entryCount)
      && archive.entryCount >= sourceTreeManifest?.rows?.length
      && safeRelativePath(archive?.path)
      && (archive.path === sourceZipPath || sourceZipPath.endsWith(`/${archive.path}`))
      && Array.isArray(archive?.issues) && archive.issues.length === 0
    )) : [];
  if (!verifyAutonomousVenueSourceInspectionReceipt(sourceInspectionReceipt, {
    sourceTreeManifest,
    releaseBinding,
    campaignReleaseBundleHash: releaseBundle?.campaignReleaseBundleHash || null,
  })
    || !verifyDeterministicPdfPageInspectionReceipt(pdfInspectionReceipt, {
      compiledPdfHash: releaseBundle?.packageOutput?.authoritativeCompiledPdfHash || null,
      campaignReleaseBundleHash: releaseBundle?.campaignReleaseBundleHash || null,
    })
    || !verifyVenueReleaseArtifactEvidence(releaseArtifactEvidence, { releaseBundle })
    || !verifyAutonomousSubmissionMetadataReceipt(submissionMetadataReceipt, {
      paperId: venueRequirementIr?.paperId,
      protocolFamily: venueRequirementIr?.sourceVenueProfileSelection?.protocolFamily,
      authorityObservedAt: inspectedAt,
    })
    || submissionMetadataReceipt?.version !== 2
    || !validManuscriptIr(manuscriptIr)
    || manuscriptIr?.paperId !== venueRequirementIr?.paperId
    || !sha(manuscriptIrFileHash) || irRow?.required !== true
    || irRow?.hash !== manuscriptIrFileHash
    || !sha(venueRequirementIrFileHash)
    || venueRequirementIrFileHash !== canonicalVenueRequirementIrFileHash
    || venueIrRow?.required !== true || venueIrRow?.hash !== venueRequirementIrFileHash
    || !sha(venueRequirementIr?.venueRequirementIrHash)
    || !Number.isFinite(Date.parse(String(inspectedAt || '')))
    || new Date(inspectedAt).toISOString() !== inspectedAt
    || releaseArtifactEvidence?.sourceTreeManifestHash
      !== sourceTreeManifest?.sourceTreeManifestHash
    || releaseArtifactEvidence?.campaignReleaseBundleHash
      !== sourceInspectionReceipt?.campaignReleaseBundleHash
    || pdfInspectionReceipt?.campaignReleaseBundleHash
      !== sourceInspectionReceipt?.campaignReleaseBundleHash
    || (releaseBinding && (
      releaseBinding.evidenceBoundManuscriptIrHash
        !== manuscriptIr.evidenceBoundManuscriptIrHash
      || releaseBinding.manuscriptIrFileHash !== manuscriptIrFileHash
      || releaseBinding.trustedAutonomousManuscriptRenderReceipt
        ?.venueRequirementIrFileHash !== venueRequirementIrFileHash
      || releaseBinding.submissionMetadataReceiptHash
        !== submissionMetadataReceipt.autonomousSubmissionMetadataReceiptHash
      || JSON.stringify(releaseBinding.submissionMetadataReceipt)
        !== JSON.stringify(submissionMetadataReceipt)
    ))
    || (releaseBundle && JSON.stringify(sourceTreeManifest)
      !== JSON.stringify(releaseBundle?.promotionCandidate?.sourceTreeManifest))
    || (releaseBundle && (
      sourceInspectionReceipt?.sourceArchiveHash
        !== releaseBundle?.packageOutput?.sourceZipHash
      || sourceInspectionReceipt?.sourceTreeManifestHash
        !== releaseBundle?.sourceTreeManifestHash
      || verifiedSourceArchives.length !== 1
    ))) {
    throw new Error('autonomous_venue_source_evidence_bundle_invalid');
  }
  const payload = {
    version: 1,
    kind: 'AutonomousVenueSourceEvidenceBundle',
    venueRequirementIrHash: venueRequirementIr.venueRequirementIrHash,
    sourceInspectionReceiptHash: sourceInspectionReceipt.sourceInspectionReceiptHash,
    sourceInspectionReceipt,
    pdfInspectionReceiptHash:
      pdfInspectionReceipt.deterministicPdfPageInspectionReceiptHash,
    pdfInspectionReceipt,
    sourceTreeManifestHash: sourceTreeManifest.sourceTreeManifestHash,
    sourceTreeManifest,
    submissionMetadataReceiptHash:
      submissionMetadataReceipt.autonomousSubmissionMetadataReceiptHash,
    submissionMetadataReceipt,
    evidenceBoundManuscriptIrHash: manuscriptIr.evidenceBoundManuscriptIrHash,
    manuscriptIrFileHash: sha(manuscriptIrFileHash),
    manuscriptIr,
    venueRequirementIrFileHash: sha(venueRequirementIrFileHash),
    venueReleaseArtifactEvidenceHash:
      releaseArtifactEvidence.venueReleaseArtifactEvidenceHash,
    releaseArtifactEvidence,
    inspectedAt,
  };
  return Object.freeze({
    ...payload,
    autonomousVenueSourceEvidenceBundleHash:
      hashRecord('AutonomousVenueSourceEvidenceBundle', payload),
  });
}

export function verifyAutonomousVenueSourceEvidenceBundle(bundle, {
  venueRequirementIr,
  releaseBinding = null,
  releaseBundle = null,
} = {}) {
  if (!hasExactObjectKeys(bundle, SOURCE_EVIDENCE_KEYS)) return false;
  try {
    return JSON.stringify(buildAutonomousVenueSourceEvidenceBundle({
      ...bundle,
      venueRequirementIr,
      releaseBinding,
      releaseBundle,
    })) === JSON.stringify(bundle);
  } catch { return false; }
}

function stripLatexComments(source) {
  return String(source || '').split(/\r?\n/).map((line) => {
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === '\\') escaped = !escaped;
      else {
        if (line[index] === '%' && !escaped) return line.slice(0, index);
        escaped = false;
      }
    }
    return line;
  }).join('\n');
}

function latexWordCount(source) {
  const visible = stripLatexComments(source)
    .replace(/\\begin\{(?:equation\*?|align\*?|gather\*?|multline\*?|theorem|proof)\}[\s\S]*?\\end\{(?:equation\*?|align\*?|gather\*?|multline\*?|theorem|proof)\}/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\$[^$\n]*\$/g, ' ')
    .replace(/\\\[[\s\S]*?\\\]/g, ' ').replace(/\\\([\s\S]*?\\\)/g, ' ')
    .replace(/\\(?:begin|end)\{[^{}]+\}/g, ' ')
    .replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?/g, ' ')
    .replace(/\\[^A-Za-z\s]/g, ' ').replace(/[{}]/g, ' ');
  return (visible.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) || []).length;
}

function sectionWordCounts(source, manuscriptIr, venueRequirementIr) {
  const located = (manuscriptIr?.sections || []).map((section) => ({
    section: String(section.sectionId || ''),
    marker: `\\section{${latexEscapeEvidenceBoundText(section.heading)}}`,
  })).map((entry) => ({ ...entry, offset: source.indexOf(entry.marker) }))
    .filter((entry) => entry.offset >= 0).sort((left, right) => left.offset - right.offset);
  const observed = new Map();
  for (let index = 0; index < located.length; index += 1) {
    const current = located[index];
    if (source.indexOf(current.marker, current.offset + current.marker.length) >= 0) continue;
    const bodyStart = current.offset + current.marker.length;
    const nextSection = source.slice(bodyStart).search(/\\section\*?\{/);
    const bodyEnd = nextSection < 0 ? source.length : bodyStart + nextSection;
    observed.set(current.section, latexWordCount(source.slice(bodyStart, bodyEnd)));
  }
  return Object.freeze((venueRequirementIr?.sectionLimits || []).flatMap((limit) => (
    observed.has(limit.section)
      ? [Object.freeze({ section: limit.section, wordCount: observed.get(limit.section) })]
      : []
  )).sort((left, right) => left.section.localeCompare(right.section)));
}

function metadataPresence({ manuscriptIr, metadataReceipt, source, venueRequirementIr }) {
  const present = [];
  const title = latexEscapeEvidenceBoundText(manuscriptIr?.title || '');
  if (title && source.includes(`\\title{${title}}`)) present.push('title');
  const abstract = (manuscriptIr?.sections || []).find((section) => (
    section.sectionId === 'abstract' && (section.blocks || []).some((block) => (
      block.type === 'prose' && String(block.text || '').trim()
    ))
  ));
  if (abstract && source.includes(
    `\\section{${latexEscapeEvidenceBoundText(abstract.heading)}}`,
  )) present.push('abstract');
  const authorLine = source.split(/\r?\n/).find((line) => line.startsWith('\\author{')) || '';
  if (metadataReceipt.profile.authors.length && (
    (venueRequirementIr.anonymousReview && authorLine === '\\author{Anonymous submission}')
    || (!venueRequirementIr.anonymousReview && metadataReceipt.profile.authors.every((author) => (
      authorLine.includes(latexEscapeEvidenceBoundText(author.displayName))
    )))
  )) present.push('authors');
  if (metadataReceipt.keywords.length && source.includes('\\section*{Keywords}')
    && metadataReceipt.keywords.every((keyword) => (
      source.includes(latexEscapeEvidenceBoundText(keyword))
    ))) present.push('keywords');
  for (const [field, heading, name] of [
    ['conflictOfInterestStatement', 'Conflict of interest', 'conflict_of_interest'],
    ['fundingStatement', 'Funding', 'funding'],
    ['dataAvailabilityStatement', 'Data availability', 'data_availability'],
    ['codeAvailabilityStatement', 'Code availability', 'code_availability'],
  ]) {
    const value = metadataReceipt.profile[field];
    if (value && source.includes(`\\section*{${heading}}`)
      && source.includes(latexEscapeEvidenceBoundText(value))) present.push(name);
  }
  return Object.freeze(present.sort());
}

function anonymousReviewSatisfied(source, metadataReceipt, venueRequirementIr) {
  if (venueRequirementIr?.anonymousReview !== true) return true;
  const authorLines = source.match(/^\\author\{[^\n]*\}$/gm) || [];
  const identities = (metadataReceipt?.profile?.authors || []).flatMap((author) => [
    author.displayName, ...(author.affiliations || []), author.orcid,
  ]).filter(Boolean);
  const normalizedSource = source.normalize('NFKC').toLocaleLowerCase('en-US');
  return authorLines.length === 1 && authorLines[0] === '\\author{Anonymous submission}'
    && identities.every((value) => [String(value), latexEscapeEvidenceBoundText(value)]
      .map((candidate) => candidate.normalize('NFKC').toLocaleLowerCase('en-US'))
      .every((candidate) => !normalizedSource.includes(candidate)));
}

export function inspectVenueManuscriptStyleMarkers(source) {
  const unique = (pattern) => {
    const matches = [...source.matchAll(pattern)];
    return matches.length === 1 ? matches[0][1] : null;
  };
  return Object.freeze({
    documentClass: unique(/^\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}\s*$/gm),
    bibliographyStyle: unique(
      /^% HEPTA_BIBLIOGRAPHY_STYLE ([A-Za-z][A-Za-z0-9_-]{0,63})\s*$/gm,
    ),
    citationStyle: unique(
      /^% HEPTA_CITATION_STYLE ([A-Za-z0-9][A-Za-z0-9_.:-]{0,191})\s*$/gm,
    ),
  });
}

function policyClassification(policy) {
  const normalized = String(policy || '').normalize('NFKC').toLowerCase();
  const states = {
    prohibited: /\b(?:prohibit(?:ed|s)?|forbid(?:den|s)?|not permitted|must not)\b/.test(normalized),
    required: /\b(?:required|mandatory|must include|must provide)\b/.test(normalized),
    optional: /\b(?:accepted|allowed|optional|permitted|may include|not required)\b/.test(normalized),
  };
  return Object.values(states).filter(Boolean).length === 1
    ? Object.entries(states).find(([, matched]) => matched)?.[0] || null : null;
}

function supplementPolicySatisfied(policy, sourceTreeManifest) {
  const rows = sourceTreeManifest.rows.filter((row) => (
    /(?:^|[_.\/-])supp(?:lement|lementary)?(?:[_.\/-]|$)/i.test(row.path)
      || /supplement/i.test(row.role)
  ));
  const classification = policyClassification(policy);
  if (classification === 'prohibited') return rows.length === 0;
  if (classification === 'required') return rows.length > 0;
  return classification === 'optional';
}

function artifactPresent(evidence) {
  return sha(evidence?.researchEvidenceCapsuleManifestHash)
    && evidence.packageFiles.filter((file) => (
      file.role === 'research_evidence_capsule_manifest'
        && file.hash === evidence.researchEvidenceCapsuleManifestFileHash
    )).length === 1
    && evidence.packageFiles.some((file) => (
      file.role === 'research_evidence_capsule_file'
    ));
}

function artifactPolicySatisfied(venueRequirementIr, present) {
  const classification = policyClassification(venueRequirementIr?.artifactPolicy);
  if (classification === 'prohibited') {
    return venueRequirementIr?.artifactRequired !== true && present !== true;
  }
  if (classification === 'required') {
    return venueRequirementIr?.artifactRequired === true && present === true;
  }
  return classification === 'optional' && venueRequirementIr?.artifactRequired !== true;
}

function templateAssetPresent(source, sourceTreeManifest, venueRequirementIr) {
  const asset = venueRequirementIr?.sourceVenueProfileSelection?.venueTemplateAsset || null;
  if (!verifyAutonomousVenueTemplateAssetRecord(asset)
    || asset.templateAssetHash !== venueRequirementIr?.templateAssetHash) return false;
  const row = uniqueRow(sourceTreeManifest, (candidate) => (
    candidate.path === asset.relativePath && candidate.hash === asset.templateAssetHash
  ));
  if (!row || row.required !== true || row.bytes !== asset.sizeBytes) return false;
  const lines = source.split(/\r?\n/);
  const input = `\\input{${asset.relativePath}}`;
  const inputIndexes = lines.flatMap((line, index) => line === input ? [index] : []);
  const classIndexes = lines.flatMap((line, index) => (
    /^\\documentclass(?:\[[^\]]*\])?\{[^}]+\}$/.test(line) ? [index] : []
  ));
  const beginIndexes = lines.flatMap((line, index) => (
    line === '\\begin{document}' ? [index] : []
  ));
  return inputIndexes.length === 1 && classIndexes.length === 1 && beginIndexes.length === 1
    && classIndexes[0] < inputIndexes[0] && inputIndexes[0] < beginIndexes[0];
}

function disclosureSatisfied(requirement, metadataPresent, source) {
  const normalized = String(requirement || '').normalize('NFKC').toLowerCase();
  const requiredMetadata = [];
  if (/\bfund(?:ing|ed)\b/.test(normalized)) requiredMetadata.push('funding');
  if (/\bconflict(?:s)?\b|competing interests?/.test(normalized)) {
    requiredMetadata.push('conflict_of_interest');
  }
  if (/\bdata\b/.test(normalized)) requiredMetadata.push('data_availability');
  if (/\bcode\b|software/.test(normalized)) requiredMetadata.push('code_availability');
  const authorshipRequired = /\b(?:automated|autonomous|machine|ai|model)\b/.test(normalized)
    && /\b(?:author(?:ship|ed)?|use|automation)\b/.test(normalized);
  const authorshipPresent = source.includes('\\section*{Automated authorship and model use}')
    && source.includes('This manuscript was produced by the registered autonomous research system and its bound model executions.');
  return (requiredMetadata.length > 0 || authorshipRequired)
    && requiredMetadata.every((field) => metadataPresent.includes(field))
    && (!authorshipRequired || authorshipPresent);
}

export function deriveVenueRequirementObservationsFromSourceEvidence({
  sourceEvidenceBundle,
  venueRequirementIr,
  releaseBinding = null,
  releaseBundle = null,
} = {}) {
  if (!verifyAutonomousVenueSourceEvidenceBundle(sourceEvidenceBundle, {
    venueRequirementIr,
    releaseBinding,
    releaseBundle,
  })) throw new Error('autonomous_venue_source_evidence_invalid');
  const source = Buffer.from(
    sourceEvidenceBundle.sourceInspectionReceipt.manuscriptBytesBase64,
    'base64',
  ).toString('utf8');
  const semanticSource = stripLatexComments(source);
  const styles = inspectVenueManuscriptStyleMarkers(source);
  const metadataPresent = metadataPresence({
    manuscriptIr: sourceEvidenceBundle.manuscriptIr,
    metadataReceipt: sourceEvidenceBundle.submissionMetadataReceipt,
    source: semanticSource,
    venueRequirementIr,
  });
  const artifactObserved = Boolean(artifactPresent(
    sourceEvidenceBundle.releaseArtifactEvidence,
  ));
  return Object.freeze({
    pageCount: sourceEvidenceBundle.pdfInspectionReceipt.pageCount,
    documentClass: styles.documentClass,
    bibliographyStyle: styles.bibliographyStyle,
    citationStyle: styles.citationStyle,
    totalWordCount: latexWordCount(source),
    sectionWordCounts: sectionWordCounts(
      semanticSource,
      sourceEvidenceBundle.manuscriptIr,
      venueRequirementIr,
    ),
    anonymousReviewSatisfied: anonymousReviewSatisfied(
      source,
      sourceEvidenceBundle.submissionMetadataReceipt,
      venueRequirementIr,
    ),
    reviewMode: venueRequirementIr.reviewMode,
    templateAssetPresent: templateAssetPresent(
      semanticSource,
      sourceEvidenceBundle.sourceTreeManifest,
      venueRequirementIr,
    ),
    supplementPolicySatisfied: supplementPolicySatisfied(
      venueRequirementIr.supplementPolicy,
      sourceEvidenceBundle.sourceTreeManifest,
    ),
    artifactPresent: artifactObserved,
    artifactPolicySatisfied: artifactPolicySatisfied(
      venueRequirementIr,
      artifactObserved,
    ),
    metadataPresent,
    satisfiedDisclosureRequirements: Object.freeze(
      venueRequirementIr.disclosureRequirements.filter((requirement) => (
        disclosureSatisfied(requirement, metadataPresent, semanticSource)
      )).sort(),
    ),
  });
}
