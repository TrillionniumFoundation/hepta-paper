import {
  autonomousFormalSupportMarkerDeclarationValid,
  autonomousFormalSupportSurfaceBody,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  extractMarkerDelimitedManuscriptSurfaces,
} from './latex-manuscript-reader-support.mjs';

const FORMAL_SUPPORT_BEGIN = /^\s*%\s*HEPTA_FORMAL_SUPPORT_BEGIN\s+(\{.*\})\s*$/;
const FORMAL_SUPPORT_END = /^\s*%\s*HEPTA_FORMAL_SUPPORT_END\s+([A-Za-z0-9][A-Za-z0-9_.:-]{0,191})\s*$/;
const FORMAL_SUPPORT_MARKER_TOKEN = /HEPTA_FORMAL_SUPPORT_(?:BEGIN|END)/;

export function extractFormalSupportSurfaces({ relative, read, trustedAuthority } = {}) {
  const extracted = extractMarkerDelimitedManuscriptSurfaces({
    relative,
    read,
    beginPattern: FORMAL_SUPPORT_BEGIN,
    endPattern: FORMAL_SUPPORT_END,
    markerToken: FORMAL_SUPPORT_MARKER_TOKEN,
    blockerPrefix: 'autonomous_formal_support',
    bodyInvalidSuffix: 'body_mismatch',
    declarationValid: (declaration) => (
      autonomousFormalSupportMarkerDeclarationValid(declaration, trustedAuthority)
    ),
    declarationIdentity: (declaration) => declaration.surfaceId,
    declarationTransform: Object.freeze,
    bodyValid: ({ text }) => text === autonomousFormalSupportSurfaceBody(trustedAuthority),
    mapSurface: (surface) => {
      const payload = Object.freeze(surface);
      return Object.freeze({
        ...payload,
        formalSupportSurfaceHash: hashRecord('AutonomousFormalSupportSurface', payload),
      });
    },
  });
  return Object.freeze({
    formalSupports: Object.freeze(extracted.surfaces),
    blockers: Object.freeze(extracted.blockers),
  });
}

export function lineInsideFormalSupportSurface(line, formalSupports) {
  return formalSupports.some((surface) => line.byteStart >= surface.markerByteStart
    && line.byteStart < surface.markerByteEnd);
}
