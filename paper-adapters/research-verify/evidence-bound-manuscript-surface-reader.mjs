import {
  evidenceBoundManuscriptBlockBody,
  evidenceBoundManuscriptMarkerDeclarationValid,
} from '../../paper-domain/research/evidence-bound-manuscript-ir.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  extractMarkerDelimitedManuscriptSurfaces,
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
  const blocks = new Map((trustedManuscriptIr?.sections || []).flatMap((section) => (
    section.blocks || []
  )).filter((block) => block.type !== 'slot').map((block) => [block.blockId, block]));
  const extracted = extractMarkerDelimitedManuscriptSurfaces({
    relative,
    read,
    beginPattern: BEGIN,
    endPattern: END,
    markerToken: TOKEN,
    blockerPrefix: 'evidence_bound_manuscript',
    bodyInvalidSuffix: 'body_mismatch',
    declarationValid: (declaration) => (
      evidenceBoundManuscriptMarkerDeclarationValid(declaration, trustedManuscriptIr)
    ),
    declarationIdentity: (declaration) => declaration.blockId,
    declarationTransform: Object.freeze,
    bodyValid: ({ declaration, text }) => text === evidenceBoundManuscriptBlockBody(
      blocks.get(declaration.blockId),
      { priorArtReceipt: trustedPriorArtReceipt },
    ),
    mapSurface: (surface) => {
      const payload = Object.freeze(surface);
      return Object.freeze({
        ...payload,
        evidenceBoundManuscriptSurfaceHash:
          hashRecord('EvidenceBoundManuscriptSurface', payload),
      });
    },
  });
  return Object.freeze({
    surfaces: Object.freeze(extracted.surfaces),
    blockers: Object.freeze(extracted.blockers),
  });
}

export function lineInsideEvidenceBoundManuscriptSurface(line, surfaces) {
  return surfaces.some((surface) => line.byteStart >= surface.markerByteStart
    && line.byteStart < surface.markerByteEnd);
}
