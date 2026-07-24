import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildAutonomousVenueComplianceReceipt,
  buildVenueRequirementObservations,
} from '../../paper-domain/automation/autonomous-venue-compliance-contract.mjs';
import {
  verifyAutonomousSubmissionMetadataReceipt,
} from '../../paper-domain/automation/autonomous-submission-metadata-contract.mjs';
import {
  buildAutonomousVenueSourceEvidenceBundle,
  buildAutonomousVenueSourceInspectionReceipt,
  buildVenueReleaseArtifactEvidence,
  deriveVenueRequirementObservationsFromSourceEvidence,
} from '../../paper-domain/automation/autonomous-venue-source-evidence-contract.mjs';
import {
  buildDeterministicPdfPageInspectionReceipt,
} from '../../paper-domain/automation/deterministic-pdf-page-inspection-contract.mjs';
import { latexEscapeEvidenceBoundText } from '../../paper-domain/research/evidence-bound-manuscript-ir.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';
import {
  assertAutonomousVenueComplianceInspectorPort,
} from '../../paper-ports/autonomous-venue-compliance-inspector-port.mjs';

const MAXIMUM_SOURCE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_COMPILED_PDF_BYTES = 64 * 1024 * 1024;
const MAXIMUM_ZIP_LIST_BYTES = 8 * 1024 * 1024;

export function inspectLocalAutonomousVenueComplianceRuntime({
  spawnSyncImpl = spawnSync,
} = {}) {
  const tools = Object.freeze(['pdfinfo', 'unzip'].map((tool) => {
    const result = spawnSyncImpl('which', [tool], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024,
    });
    const discovered = result?.status === 0 ? String(result.stdout || '').trim() : '';
    let executable = null;
    try {
      executable = fs.realpathSync(discovered);
      fs.accessSync(executable, fs.constants.X_OK);
      if (!fs.statSync(executable).isFile()) executable = null;
    } catch { executable = null; }
    return Object.freeze({ tool, executable, ready: Boolean(executable) });
  }));
  const blockers = Object.freeze(tools.filter((tool) => !tool.ready)
    .map((tool) => `autonomous_venue_compliance_tool_unavailable:${tool.tool}`));
  const payload = {
    version: 1,
    kind: 'LocalAutonomousVenueComplianceRuntimeInspection',
    status: blockers.length
      ? 'local_autonomous_venue_compliance_runtime_blocked'
      : 'local_autonomous_venue_compliance_runtime_ready',
    ready: blockers.length === 0,
    tools,
    blockers,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    localAutonomousVenueComplianceRuntimeInspectionHash:
      hashRecord('LocalAutonomousVenueComplianceRuntimeInspection', payload),
  });
}

function recordHashValid(value, type, key) {
  const { [key]: claimedHash, ...payload } = value || {};
  return /^sha256:[0-9a-f]{64}$/.test(String(claimedHash || ''))
    && hashRecord(type, payload) === claimedHash;
}

function artifactForRole(packageOutput, role) {
  const matches = Array.isArray(packageOutput?.files)
    ? packageOutput.files.filter((artifact) => artifact?.role === role)
    : [];
  return matches.length === 1 ? matches[0] : null;
}

function artifactPath(runtimeRoot, packageOutput, artifact) {
  const base = path.resolve(String(packageOutput?.artifactBaseRoot || ''));
  const candidate = path.resolve(base, String(artifact?.path || ''));
  let stat = null;
  try { stat = fs.lstatSync(candidate); } catch { return null; }
  if (!isPathWithin(runtimeRoot, candidate) || candidate === path.resolve(runtimeRoot)
    || !stat.isFile() || stat.isSymbolicLink()
    || stat.size !== Number(artifact?.bytes)
    || sha256FileSync(candidate) !== artifact?.hash) return null;
  return candidate;
}

function zipEntries(zipPath, spawnSyncImpl) {
  const result = spawnSyncImpl('unzip', ['-Z1', zipPath], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: MAXIMUM_ZIP_LIST_BYTES,
  });
  if (result.status !== 0) throw new Error('autonomous_venue_source_archive_listing_failed');
  const entries = result.stdout.split(/\r?\n/).filter(Boolean);
  const canonical = (entry, directory) => {
    const candidate = directory ? entry.slice(0, -1) : entry;
    return candidate.length > 0 && candidate.length <= 512
      && !path.posix.isAbsolute(candidate) && !candidate.includes('\\')
      && !candidate.includes('//')
      && candidate.split('/').every((part) => part && part !== '.' && part !== '..');
  };
  const fileEntries = entries.filter((entry) => !entry.endsWith('/'));
  const directoryEntries = entries.filter((entry) => entry.endsWith('/'));
  if (!entries.length || !fileEntries.length || new Set(entries).size !== entries.length
    || fileEntries.some((entry) => !canonical(entry, false))
    || directoryEntries.some((entry) => !canonical(entry, true)
      || fileEntries.includes(entry.slice(0, -1))
      || !fileEntries.some((file) => file.startsWith(entry)))) {
    throw new Error('autonomous_venue_source_archive_entries_invalid');
  }
  return Object.freeze({
    entries: Object.freeze([...entries].sort()),
    fileEntries: Object.freeze(fileEntries.sort()),
  });
}

function readZipEntry(zipPath, entry, entries, spawnSyncImpl) {
  if (!entries.includes(entry)) throw new Error(`autonomous_venue_source_entry_missing:${entry}`);
  const result = spawnSyncImpl('unzip', ['-p', zipPath, entry], {
    encoding: null,
    timeout: 30_000,
    maxBuffer: MAXIMUM_SOURCE_BYTES,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)
    || result.stdout.length < 1 || result.stdout.length > MAXIMUM_SOURCE_BYTES) {
    throw new Error(`autonomous_venue_source_entry_invalid:${entry}`);
  }
  return result.stdout;
}

function json(buffer, blocker) {
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw new Error(blocker); }
}

function pdfInspection(pdfPath, spawnSyncImpl) {
  const command = spawnSyncImpl('which', ['pdfinfo'], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024,
  });
  const executable = command.status === 0 ? command.stdout.trim() : '';
  let realExecutable = null;
  try { realExecutable = fs.realpathSync(executable); } catch { /* blocked below */ }
  if (!realExecutable || !fs.statSync(realExecutable).isFile()) {
    throw new Error('autonomous_venue_pdfinfo_unavailable');
  }
  const result = spawnSyncImpl(realExecutable, [pdfPath], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  const pageMatch = result.status === 0 ? result.stdout.match(/^Pages:\s+(\d+)\s*$/mi) : null;
  const pageCount = Number(pageMatch?.[1]);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
    throw new Error('autonomous_venue_pdf_page_count_invalid');
  }
  const toolIdentityHash = hashRecord('AutonomousVenuePdfInfoToolIdentity', {
    executable: realExecutable,
    executableHash: sha256FileSync(realExecutable),
  });
  const receiptHash = hashRecord('AutonomousVenuePdfInfoReceipt', {
    toolIdentityHash,
    compiledPdfHash: sha256FileSync(pdfPath),
    pageCount,
    stdoutHash: hashBytes(Buffer.from(result.stdout, 'utf8')),
  });
  return Object.freeze({ pageCount, toolIdentityHash, receiptHash });
}

function metadataPresence({
  manuscriptIr,
  metadataReceipt,
  source,
  venueRequirementIr = null,
}) {
  const present = [];
  const title = latexEscapeEvidenceBoundText(manuscriptIr?.title || '');
  if (title && source.includes(`\\title{${title}}`)) present.push('title');
  const abstractSection = (manuscriptIr?.sections || []).find((section) => (
    section.sectionId === 'abstract'
      && (section.blocks || []).some((block) => block.type === 'prose'
        && String(block.text || '').trim())
  ));
  if (abstractSection && source.includes(
    `\\section{${latexEscapeEvidenceBoundText(abstractSection.heading)}}`,
  )) present.push('abstract');
  const authorLine = source.split(/\r?\n/).find((line) => line.startsWith('\\author{')) || '';
  if (metadataReceipt.profile.authors.length && (
    (venueRequirementIr?.anonymousReview === true
      && authorLine === '\\author{Anonymous submission}')
    || (venueRequirementIr?.anonymousReview !== true
      && metadataReceipt.profile.authors.every((author) => authorLine.includes(
        latexEscapeEvidenceBoundText(author.displayName),
      )))
  )) present.push('authors');
  if (metadataReceipt.keywords.length && source.includes('\\section*{Keywords}')
    && metadataReceipt.keywords.every((keyword) => source.includes(
      latexEscapeEvidenceBoundText(keyword),
    ))) present.push('keywords');
  const statement = (field, heading, metadataName) => {
    const value = metadataReceipt.profile[field];
    if (value && source.includes(`\\section*{${heading}}`)
      && source.includes(latexEscapeEvidenceBoundText(value))) present.push(metadataName);
  };
  statement('conflictOfInterestStatement', 'Conflict of interest', 'conflict_of_interest');
  statement('fundingStatement', 'Funding', 'funding');
  statement('dataAvailabilityStatement', 'Data availability', 'data_availability');
  statement('codeAvailabilityStatement', 'Code availability', 'code_availability');
  return Object.freeze(present.sort());
}

export function createLocalAutonomousVenueComplianceInspector({
  runtimeRoot,
  spawnSyncImpl = spawnSync,
} = {}) {
  const root = path.resolve(String(runtimeRoot || ''));
  if (!path.isAbsolute(root)) throw new Error('autonomous_venue_compliance_runtime_root_invalid');
  return assertAutonomousVenueComplianceInspectorPort(Object.freeze({
    version: 1,
    kind: 'AutonomousVenueComplianceInspector',
    inspectorId: 'local-source-archive-and-pdfinfo-v1',
    inspect({ campaignReleaseAuthority, venueProfileSelection } = {}) {
      const releaseBundle = campaignReleaseAuthority?.releaseBundle || null;
      const releaseBinding = releaseBundle?.autonomousResearchReleaseBinding || null;
      const packageOutput = releaseBundle?.packageOutput || null;
      if (!recordHashValid(
        releaseBundle,
        'CampaignReleaseBundle',
        'campaignReleaseBundleHash',
      ) || !recordHashValid(
        packageOutput,
        'ImmutableCampaignPackageOutput',
        'immutableCampaignPackageOutputHash',
      ) || releaseBundle.campaignReleaseBundleHash
        !== campaignReleaseAuthority?.campaignReleaseBundleHash) {
        throw new Error('autonomous_venue_compliance_release_authority_invalid');
      }
      const sourceZipRecord = artifactForRole(packageOutput, 'generated_source_zip');
      const compiledPdfRecord = artifactForRole(packageOutput, 'compiled_pdf');
      const independentPdfRecord = artifactForRole(packageOutput, 'independent_rebuilt_pdf');
      const sourceZipPath = artifactPath(root, packageOutput, sourceZipRecord);
      const compiledPdfPath = artifactPath(
        root,
        packageOutput,
        compiledPdfRecord,
      );
      const independentPdfPath = artifactPath(
        root,
        packageOutput,
        independentPdfRecord,
      );
      if (!sourceZipPath || !compiledPdfPath || !independentPdfPath) {
        throw new Error('autonomous_venue_compliance_release_artifacts_invalid');
      }
      const zipEntrySet = zipEntries(sourceZipPath, spawnSyncImpl);
      const entries = zipEntrySet.fileEntries;
      const sourceBuffer = readZipEntry(
        sourceZipPath,
        releaseBinding?.manuscriptPath || 'main.tex',
        entries,
        spawnSyncImpl,
      );
      const manuscriptIrBuffer = readZipEntry(
        sourceZipPath,
        'AUTONOMOUS_MANUSCRIPT_IR.json',
        entries,
        spawnSyncImpl,
      );
      const manuscriptIr = json(
        manuscriptIrBuffer,
        'autonomous_venue_manuscript_ir_invalid',
      );
      const priorArtReceipt = json(
        readZipEntry(
          sourceZipPath,
          'AUTONOMOUS_PRIOR_ART_EVIDENCE.json',
          entries,
          spawnSyncImpl,
        ),
        'autonomous_venue_prior_art_evidence_invalid',
      );
      const seedBundle = json(
        readZipEntry(
          sourceZipPath,
          'AUTONOMOUS_RESEARCH_SEED_CONTRACTS.json',
          entries,
          spawnSyncImpl,
        ),
        'autonomous_venue_seed_bundle_invalid',
      );
      const metadataReceipt = json(
        readZipEntry(
          sourceZipPath,
          'AUTONOMOUS_SUBMISSION_METADATA.json',
          entries,
          spawnSyncImpl,
        ),
        'autonomous_venue_submission_metadata_invalid',
      );
      const recursiveClosureSource = releaseBinding?.version === 4;
      const venueRequirementIrBuffer = recursiveClosureSource
        ? readZipEntry(
          sourceZipPath,
          'AUTONOMOUS_VENUE_REQUIREMENT_IR.json',
          entries,
          spawnSyncImpl,
        ) : null;
      const venueRequirementIr = recursiveClosureSource
        ? json(
          venueRequirementIrBuffer,
          'autonomous_venue_requirement_ir_invalid',
        ) : null;
      const venueRequirementIrFileHash = venueRequirementIrBuffer
        ? hashBytes(venueRequirementIrBuffer) : null;
      if (recursiveClosureSource && (
        JSON.stringify(venueRequirementIr) !== JSON.stringify(releaseBinding?.venueRequirementIr)
        || venueRequirementIr?.venueRequirementIrHash
          !== releaseBinding?.venueRequirementIrHash
        || venueRequirementIrFileHash
          !== releaseBinding?.trustedAutonomousManuscriptRenderReceipt
            ?.venueRequirementIrFileHash
      )) {
        throw new Error('autonomous_venue_requirement_ir_release_binding_mismatch');
      }
      if (!verifyAutonomousSubmissionMetadataReceipt(metadataReceipt, {
        paperId: venueProfileSelection?.paperId,
        protocolFamily: venueProfileSelection?.protocolFamily,
        authorityObservedAt: campaignReleaseAuthority?.releaseBundle?.createdAt,
      })) throw new Error('autonomous_venue_submission_metadata_verification_failed');
      const source = sourceBuffer.toString('utf8');
      const classMatch = source.match(/^\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/m);
      const bibliographyStyleMatch = source.match(
        /^% HEPTA_BIBLIOGRAPHY_STYLE ([A-Za-z][A-Za-z0-9_-]{0,63})$/m,
      );
      const citationStyleMatch = source.match(
        /^% HEPTA_CITATION_STYLE ([A-Za-z0-9][A-Za-z0-9_.:-]{0,191})$/m,
      );
      const sourceTreeManifest = releaseBundle?.promotionCandidate?.sourceTreeManifest || null;
      const pdf = pdfInspection(compiledPdfPath, spawnSyncImpl);
      if (recursiveClosureSource
        && fs.statSync(compiledPdfPath).size > MAXIMUM_COMPILED_PDF_BYTES) {
        throw new Error('autonomous_venue_compiled_pdf_too_large');
      }
      const pdfInspectionReceipt = recursiveClosureSource
        ? buildDeterministicPdfPageInspectionReceipt({
          compiledPdfBytesBase64: fs.readFileSync(compiledPdfPath).toString('base64'),
          campaignReleaseBundleHash: releaseBundle.campaignReleaseBundleHash,
        }) : null;
      if (recursiveClosureSource && pdf.pageCount !== pdfInspectionReceipt.pageCount) {
        throw new Error('autonomous_venue_pdf_page_inspections_disagree');
      }
      const sourceArchiveHash = sha256FileSync(sourceZipPath);
      const sourceEntryManifestHash = hashRecord('AutonomousVenueSourceEntries', entries);
      const sourceInspectionReceipt = recursiveClosureSource
        ? buildAutonomousVenueSourceInspectionReceipt({
          manuscriptPath: releaseBinding.manuscriptPath,
          manuscriptBytesBase64: sourceBuffer.toString('base64'),
          sourceArchiveHash,
          sourceEntryManifestHash,
          sourceTreeManifest,
          campaignReleaseBundleHash: releaseBundle.campaignReleaseBundleHash,
        }) : null;
      const releaseArtifactEvidence = recursiveClosureSource
        ? buildVenueReleaseArtifactEvidence({ releaseBundle }) : null;
      const sourceEvidenceBundle = recursiveClosureSource
        ? buildAutonomousVenueSourceEvidenceBundle({
          sourceInspectionReceipt,
          sourceTreeManifest,
          submissionMetadataReceipt: metadataReceipt,
          manuscriptIr,
          manuscriptIrFileHash: hashBytes(manuscriptIrBuffer),
          venueRequirementIrFileHash,
          pdfInspectionReceipt,
          releaseArtifactEvidence,
          venueRequirementIr,
          inspectedAt: releaseBundle.createdAt,
          releaseBinding,
          releaseBundle,
        }) : null;
      const derivedObservations = recursiveClosureSource
        ? deriveVenueRequirementObservationsFromSourceEvidence({
          sourceEvidenceBundle,
          venueRequirementIr,
          releaseBinding,
          releaseBundle,
        }) : null;
      const metadataPresent = recursiveClosureSource
        ? derivedObservations.metadataPresent
        : metadataPresence({ manuscriptIr, metadataReceipt, source, venueRequirementIr });
      const sourceInspectionReceiptHash = recursiveClosureSource
        ? sourceInspectionReceipt.sourceInspectionReceiptHash
        : hashRecord('AutonomousVenueSourceInspection', {
          sourceArchiveHash,
          sourceEntryManifestHash,
          manuscriptIrHash: manuscriptIr.evidenceBoundManuscriptIrHash || null,
          renderedSourceHash: hashBytes(sourceBuffer),
        });
      const venueRequirementObservations = recursiveClosureSource
        ? buildVenueRequirementObservations({
          venueRequirementIr,
          sourceEvidenceBundle,
          releaseBinding,
          releaseBundle,
        }) : null;
      return buildAutonomousVenueComplianceReceipt({
        venueProfileSelection,
        submissionMetadataReceipt: metadataReceipt,
        campaignReleaseAuthority,
        manuscriptIr,
        manuscriptIrFileHash: hashBytes(manuscriptIrBuffer),
        priorArtReceipt,
        seedBundle,
        agentExecutionReceipt:
          releaseBinding?.manuscriptRenderNodeResult?.agentExecutionReceipt || null,
        renderedSourceHash: hashBytes(sourceBuffer),
        sourceArchiveHash,
        compiledPdfHash: sha256FileSync(compiledPdfPath),
        independentRebuiltPdfHash: sha256FileSync(independentPdfPath),
        sourceInspectionReceiptHash,
        pdfInfoToolIdentityHash: recursiveClosureSource
          ? pdfInspectionReceipt.parserPolicyHash : pdf.toolIdentityHash,
        pdfInfoReceiptHash: recursiveClosureSource
          ? pdfInspectionReceipt.deterministicPdfPageInspectionReceiptHash : pdf.receiptHash,
        pageCount: recursiveClosureSource
          ? pdfInspectionReceipt.pageCount : pdf.pageCount,
        documentClass: classMatch?.[1] || '',
        bibliographyStyle: bibliographyStyleMatch?.[1] || '',
        citationStyle: citationStyleMatch?.[1] || '',
        metadataPresent,
        sourceEvidenceBundle,
        venueRequirementObservations,
        inspectedAt: campaignReleaseAuthority.releaseBundle.createdAt,
      });
    },
  }));
}
