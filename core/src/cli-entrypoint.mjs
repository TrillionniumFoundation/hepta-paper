import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function isCliEntrypoint(metaUrl, argv = process.argv) {
  if (typeof metaUrl !== 'string') {
    throw new TypeError('isCliEntrypoint requires an import.meta.url string.');
  }
  const entryPath = argv?.[1];
  if (!entryPath) return false;
  return metaUrl === pathToFileURL(path.resolve(entryPath)).href;
}
