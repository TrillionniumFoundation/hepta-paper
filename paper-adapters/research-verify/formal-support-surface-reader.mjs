import {
  autonomousFormalSupportMarkerDeclarationValid,
  autonomousFormalSupportSurfaceBody,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  manuscriptLineRecords,
  trimAsciiWhitespace,
} from './latex-manuscript-reader-support.mjs';

const FORMAL_SUPPORT_BEGIN = /^\s*%\s*HEPTA_FORMAL_SUPPORT_BEGIN\s+(\{.*\})\s*$/;
const FORMAL_SUPPORT_END = /^\s*%\s*HEPTA_FORMAL_SUPPORT_END\s+([A-Za-z0-9][A-Za-z0-9_.:-]{0,191})\s*$/;
const FORMAL_SUPPORT_MARKER_TOKEN = /HEPTA_FORMAL_SUPPORT_(?:BEGIN|END)/;

export function extractFormalSupportSurfaces({ relative, read, trustedAuthority } = {}) {
  const latin1 = read.content.toString('latin1');
  const blockers = [];
  const formalSupports = [];
  let open = null;
  for (const line of manuscriptLineRecords(latin1)) {
    const begin = line.text.match(FORMAL_SUPPORT_BEGIN);
    const end = line.text.match(FORMAL_SUPPORT_END);
    if (FORMAL_SUPPORT_MARKER_TOKEN.test(line.text) && !begin && !end) {
      blockers.push(`autonomous_formal_support_marker_malformed:${relative}:${line.byteStart}`);
      continue;
    }
    if (begin) {
      if (open) {
        blockers.push(`autonomous_formal_support_marker_nested:${relative}:${line.byteStart}`);
        continue;
      }
      let declaration = null;
      try { declaration = JSON.parse(begin[1]); } catch { /* blocked below */ }
      if (!autonomousFormalSupportMarkerDeclarationValid(declaration, trustedAuthority)) {
        blockers.push(`autonomous_formal_support_declaration_invalid:${relative}:${line.byteStart}`);
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
      blockers.push(`autonomous_formal_support_marker_end_unpaired:${relative}:${line.byteStart}`);
      continue;
    }
    if (end[1] !== open.declaration.surfaceId) {
      blockers.push(`autonomous_formal_support_marker_id_mismatch:${relative}:${line.byteStart}`);
      open = null;
      continue;
    }
    const range = trimAsciiWhitespace(latin1, open.bodyStart, line.byteStart);
    const bytes = read.content.subarray(range.byteStart, range.byteEnd);
    const text = bytes.toString('utf8');
    let expected = null;
    try { expected = autonomousFormalSupportSurfaceBody(trustedAuthority); }
    catch { /* blocked below */ }
    if (!bytes.length || !Buffer.from(text, 'utf8').equals(bytes) || text !== expected) {
      blockers.push(`autonomous_formal_support_body_mismatch:${relative}:${open.markerByteStart}`);
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
    formalSupports.push(Object.freeze({
      ...payload,
      formalSupportSurfaceHash: hashRecord('AutonomousFormalSupportSurface', payload),
    }));
    open = null;
  }
  if (open) {
    blockers.push(`autonomous_formal_support_marker_unterminated:${relative}:${open.markerByteStart}`);
  }
  return Object.freeze({ formalSupports: Object.freeze(formalSupports), blockers: Object.freeze(blockers) });
}

export function lineInsideFormalSupportSurface(line, formalSupports) {
  return formalSupports.some((surface) => line.byteStart >= surface.markerByteStart
    && line.byteStart < surface.markerByteEnd);
}
