import path from 'node:path';

const SAFE_LITERAL_INCLUDE_PATH = /^[A-Za-z0-9._/-]+$/;

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
