import {
  evidenceBoundManuscriptBlockBody,
  evidenceBoundManuscriptMarkerDeclarationValid,
} from '../../paper-domain/research/evidence-bound-manuscript-ir.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  manuscriptLineRecords,
  trimAsciiWhitespace,
} from './latex-manuscript-reader-support.mjs';

const BEGIN = /^\s*%\s*HEPTA_EVIDENCE_BOUND_PROSE_BEGIN\s+(\{.*\})\s*$/;
const END = /^\s*%\s*HEPTA_EVIDENCE_BOUND_PROSE_END\s+([A-Za-z0-9][A-Za-z0-9_.:-]{0,191})\s*$/;
const TOKEN = /HEPTA_EVIDENCE_BOUND_PROSE_(?:BEGIN|END)/;

export function extractEvidenceBoundManuscriptSurfaces({
  relative,
  read,
  trustedManuscriptIr,
  trustedPriorArtReceipt = null,
} = {}) {
  const latin1 = read.content.toString('latin1');
  const blockers = [];
  const surfaces = [];
  const blocks = new Map((trustedManuscriptIr?.sections || []).flatMap((section) => (
    section.blocks || []
  )).filter((block) => block.type !== 'slot').map((block) => [block.blockId, block]));
  let open = null;
  for (const line of manuscriptLineRecords(latin1)) {
    const begin = line.text.match(BEGIN);
    const end = line.text.match(END);
    if (TOKEN.test(line.text) && !begin && !end) {
      blockers.push(`evidence_bound_manuscript_marker_malformed:${relative}:${line.byteStart}`);
      continue;
    }
    if (begin) {
      if (open) {
        blockers.push(`evidence_bound_manuscript_marker_nested:${relative}:${line.byteStart}`);
        continue;
      }
      let declaration = null;
      try { declaration = JSON.parse(begin[1]); } catch { /* blocked below */ }
      if (!evidenceBoundManuscriptMarkerDeclarationValid(declaration, trustedManuscriptIr)) {
        blockers.push(`evidence_bound_manuscript_declaration_invalid:${relative}:${line.byteStart}`);
        continue;
      }
      open = {
        declaration: Object.freeze(declaration),
        markerByteStart: line.byteStart,
        bodyStart: line.byteEnd,
      };
      continue;
    }
    if (!end) continue;
    if (!open) {
      blockers.push(`evidence_bound_manuscript_marker_end_unpaired:${relative}:${line.byteStart}`);
      continue;
    }
    if (end[1] !== open.declaration.blockId) {
      blockers.push(`evidence_bound_manuscript_marker_id_mismatch:${relative}:${line.byteStart}`);
      open = null;
      continue;
    }
    const block = blocks.get(open.declaration.blockId);
    const range = trimAsciiWhitespace(latin1, open.bodyStart, line.byteStart);
    const bytes = read.content.subarray(range.byteStart, range.byteEnd);
    const text = bytes.toString('utf8');
    let expected = null;
    try {
      expected = evidenceBoundManuscriptBlockBody(block, {
        priorArtReceipt: trustedPriorArtReceipt,
      });
    } catch { /* blocked below */ }
    if (!bytes.length || !Buffer.from(text, 'utf8').equals(bytes) || text !== expected) {
      blockers.push(`evidence_bound_manuscript_body_mismatch:${relative}:${open.markerByteStart}`);
      open = null;
      continue;
    }
    const payload = Object.freeze({
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
    surfaces.push(Object.freeze({
      ...payload,
      evidenceBoundManuscriptSurfaceHash:
        hashRecord('EvidenceBoundManuscriptSurface', payload),
    }));
    open = null;
  }
  if (open) {
    blockers.push(`evidence_bound_manuscript_marker_unterminated:${relative}:${open.markerByteStart}`);
  }
  return Object.freeze({
    surfaces: Object.freeze(surfaces),
    blockers: Object.freeze(blockers),
  });
}

export function lineInsideEvidenceBoundManuscriptSurface(line, surfaces) {
  return surfaces.some((surface) => line.byteStart >= surface.markerByteStart
    && line.byteStart < surface.markerByteEnd);
}
