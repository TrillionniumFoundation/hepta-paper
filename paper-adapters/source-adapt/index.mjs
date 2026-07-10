import path from 'node:path';
import {
  buildSourceAdaptationPacket,
  buildSourceAdaptationOperatorPacket,
} from '../../paper-core/src/contracts/intake-resolution.mjs';
import { hashPaperRecord } from '../../paper-core/src/paper-contract-primitives.mjs';
import {
  fileRecord,
  relativePath,
  walkFiles,
} from '../../paper-core/src/runtime/file-utils.mjs';
import { normalizeText, uniqueStrings } from '../../paper-core/src/runtime/text-utils.mjs';

function repoPath(root, value) {
  const text = normalizeText(value);
  if (!text) return null;
  return path.isAbsolute(text) ? text : path.join(root, text);
}

function texScore(file) {
  const base = path.basename(file).toLowerCase();
  let score = 0;
  const reasons = [];
  if (base === 'main.tex') {
    score += 100;
    reasons.push('main_tex_filename');
  }
  if (/manuscript|paper|article|submission|camera|neurips|draft/.test(base)) {
    score += 60;
    reasons.push('manuscript_like_filename');
  }
  if (/sample|template|appendix|supplement|backup|old|bak/.test(base)) {
    score -= 40;
    reasons.push('deprioritized_filename');
  }
  if (base.endsWith('.tex')) {
    score += 20;
    reasons.push('tex_source');
  }
  return { score, reason: reasons.join(', ') || 'tex_candidate' };
}

async function candidateRecords(root, sourceRoot) {
  if (!sourceRoot) return { texCandidates: [], pdfCandidates: [], codeCandidates: [] };
  const files = await walkFiles(sourceRoot, {
    maxDepth: 5,
    maxFiles: 4000,
    match: (_full, name) => /\.(tex|pdf|py|ipynb|r|jl|md)$/i.test(name),
  });
  const texCandidates = [];
  const pdfCandidates = [];
  const codeCandidates = [];
  for (const file of files) {
    const lower = path.basename(file).toLowerCase();
    if (lower.endsWith('.tex')) {
      const record = await fileRecord(root, file, 'tex_candidate');
      if (record) {
        const scored = texScore(file);
        texCandidates.push({ ...record, ...scored });
      }
    } else if (lower.endsWith('.pdf')) {
      const record = await fileRecord(root, file, 'pdf_candidate');
      if (record) pdfCandidates.push(record);
    } else if (/\.(py|ipynb|r|jl)$/i.test(lower)) {
      const record = await fileRecord(root, file, 'code_candidate');
      if (record) codeCandidates.push(record);
    }
  }
  texCandidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  pdfCandidates.sort((left, right) => (right.sizeBytes || 0) - (left.sizeBytes || 0));
  return {
    texCandidates,
    pdfCandidates,
    codeCandidates,
  };
}

export async function runSourceAdaptAdapter({ root, row } = {}) {
  const submissionIntent = row.submissionIntent || row.task.registry?.submissionIntent || null;
  const sourceRoot = repoPath(root, row.task.sourceWorkspace);
  const candidates = await candidateRecords(root, sourceRoot);
  const packet = buildSourceAdaptationPacket({
    paperTask: row.task,
    submissionIntent,
    sourceWorkspace: sourceRoot ? relativePath(root, sourceRoot) : null,
    ...candidates,
  });
  const sourceAdaptationOperatorPacket = buildSourceAdaptationOperatorPacket({
    paperTask: row.task,
    sourceAdaptationPacket: packet,
  });
  const required = submissionIntent?.status === 'source_adapt_required';
  const report = {
    version: 1,
    kind: 'SourceAdaptAdapterReport',
    paperId: row.task.paperId,
    taskKey: row.task.taskKey,
    status: required ? packet.status : 'source_adaptation_not_required',
    sourceAdaptationRequired: required,
    packet,
    sourceAdaptationOperatorPacket,
    blockers: required ? uniqueStrings(packet.blockers || [], 32) : [],
    warnings: uniqueStrings([
      ...(required ? [] : ['source_adaptation_not_required_for_row']),
      ...(packet.warnings || []),
    ], 32),
    safety: {
      readsOnly: true,
      writesSource: false,
      synthesizesMainTex: false,
      operatorPacketOnly: true,
      externalActionPerformed: false,
    },
  };
  return { ...report, sourceAdaptAdapterReportHash: hashPaperRecord('SourceAdaptAdapterReport', report) };
}
