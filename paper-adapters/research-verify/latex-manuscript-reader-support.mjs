import path from 'node:path';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

const SAFE_LITERAL_INCLUDE_PATH = /^[A-Za-z0-9._/-]+$/;
const INCLUDE_COMMAND = /\\(input|include)(?![A-Za-z@])/giu;

function escapedAt(source, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

export function safeManuscriptPath(value) {
  const relative = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!relative || relative.startsWith('/') || relative.split('/').includes('..')) return null;
  return relative.endsWith('.tex') ? relative : `${relative}.tex`;
}

export function includedPath(currentPath, value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('/') || !SAFE_LITERAL_INCLUDE_PATH.test(raw)) return null;
  return safeManuscriptPath(path.posix.normalize(path.posix.join(path.posix.dirname(currentPath), raw)));
}

export function literalManuscriptIncludes({
  masked,
  relative,
  blockerPrefix,
  mapInclude = ({ path: included, byteStart, byteEnd }) => ({
    path: included,
    byteStart,
    byteEnd,
  }),
} = {}) {
  const source = String(masked || '');
  const includes = [];
  const blockers = [];
  INCLUDE_COMMAND.lastIndex = 0;
  let match;
  while ((match = INCLUDE_COMMAND.exec(source)) !== null) {
    if (escapedAt(source, match.index)) continue;
    let cursor = match.index + match[0].length;
    while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1;
    if (source[cursor] !== '{') {
      blockers.push(`${blockerPrefix}_include_not_literal:${relative}:${match.index}`);
      continue;
    }
    const end = source.indexOf('}', cursor + 1);
    const value = end < 0 ? '' : source.slice(cursor + 1, end);
    if (end < 0 || value.includes('{')) {
      blockers.push(`${blockerPrefix}_include_not_literal:${relative}:${match.index}`);
      continue;
    }
    const included = includedPath(relative, value);
    if (!included) {
      blockers.push(`${blockerPrefix}_include_path_invalid:${relative}:${String(value).trim()}`);
    } else {
      includes.push(Object.freeze(mapInclude({
        path: included,
        byteStart: match.index,
        byteEnd: end + 1,
      })));
    }
    INCLUDE_COMMAND.lastIndex = end + 1;
  }
  return Object.freeze({
    includes: Object.freeze(includes),
    blockers: Object.freeze(blockers),
  });
}

export function trimAsciiWhitespace(latin1, start, end) {
  let byteStart = start;
  let byteEnd = end;
  while (byteStart < byteEnd && /\s/.test(latin1[byteStart])) byteStart += 1;
  while (byteEnd > byteStart && /\s/.test(latin1[byteEnd - 1])) byteEnd -= 1;
  return { byteStart, byteEnd };
}

export function manuscriptLineRecords(latin1) {
  const records = [];
  let start = 0;
  for (let cursor = 0; cursor <= latin1.length; cursor += 1) {
    if (cursor !== latin1.length && latin1[cursor] !== '\n') continue;
    const contentEnd = cursor > start && latin1[cursor - 1] === '\r' ? cursor - 1 : cursor;
    records.push(Object.freeze({
      text: latin1.slice(start, contentEnd),
      byteStart: start,
      contentByteEnd: contentEnd,
      byteEnd: cursor < latin1.length ? cursor + 1 : cursor,
    }));
    start = cursor + 1;
  }
  return records;
}

export function extractMarkerDelimitedManuscriptSurfaces({
  relative,
  read,
  beginPattern,
  endPattern,
  markerToken,
  blockerPrefix,
  bodyInvalidSuffix,
  declarationValid,
  declarationIdentity,
  declarationTransform = (declaration) => declaration,
  bodyValid,
  mapSurface = (surface) => surface,
} = {}) {
  const latin1 = read.content.toString('latin1');
  const blockers = [];
  const surfaces = [];
  let open = null;
  for (const line of manuscriptLineRecords(latin1)) {
    const begin = line.text.match(beginPattern);
    const end = line.text.match(endPattern);
    if (markerToken.test(line.text) && !begin && !end) {
      blockers.push(`${blockerPrefix}_marker_malformed:${relative}:${line.byteStart}`);
      continue;
    }
    if (begin) {
      if (open) {
        blockers.push(`${blockerPrefix}_marker_nested:${relative}:${line.byteStart}`);
        continue;
      }
      let declaration = null;
      try { declaration = JSON.parse(begin[1]); } catch { /* blocked below */ }
      if (!declarationValid(declaration)) {
        blockers.push(`${blockerPrefix}_declaration_invalid:${relative}:${line.byteStart}`);
        continue;
      }
      open = {
        declaration: declarationTransform(declaration),
        markerByteStart: line.byteStart,
        bodyStart: line.byteEnd,
      };
      continue;
    }
    if (!end) continue;
    if (!open) {
      blockers.push(`${blockerPrefix}_marker_end_unpaired:${relative}:${line.byteStart}`);
      continue;
    }
    if (end[1] !== declarationIdentity(open.declaration)) {
      blockers.push(`${blockerPrefix}_marker_id_mismatch:${relative}:${line.byteStart}`);
      open = null;
      continue;
    }
    const range = trimAsciiWhitespace(latin1, open.bodyStart, line.byteStart);
    const bytes = read.content.subarray(range.byteStart, range.byteEnd);
    const text = bytes.toString('utf8');
    let accepted = false;
    try {
      accepted = bodyValid({
        bytes,
        text,
        declaration: open.declaration,
      }) === true;
    } catch { /* blocked below */ }
    if (!bytes.length || !Buffer.from(text, 'utf8').equals(bytes) || !accepted) {
      blockers.push(`${blockerPrefix}_${bodyInvalidSuffix}:${relative}:${open.markerByteStart}`);
      open = null;
      continue;
    }
    const surface = {
      declaration: open.declaration,
      manuscriptPath: relative,
      manuscriptFileHash: read.hash,
      markerByteStart: open.markerByteStart,
      markerByteEnd: line.byteEnd,
      manuscriptByteStart: range.byteStart,
      manuscriptByteEnd: range.byteEnd,
      manuscriptContentHash: hashBytes(bytes),
      text,
    };
    surfaces.push(mapSurface(surface));
    open = null;
  }
  if (open) {
    blockers.push(`${blockerPrefix}_marker_unterminated:${relative}:${open.markerByteStart}`);
  }
  return { surfaces, blockers };
}
