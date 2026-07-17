import { assertRRuntimeSourceArchiveTransport } from '../../paper-ports/r-runtime-source-archive-transport-port.mjs';

const SNAPSHOT_ORIGIN = 'https://packagemanager.posit.co';
const SNAPSHOT_PATH = /^\/cran\/2024-11-01\/src\/contrib\/[A-Za-z][A-Za-z0-9.]{0,127}_[A-Za-z0-9][A-Za-z0-9.+-]{0,127}\.tar\.gz$/;

function canonicalSnapshotUrl(value) {
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw new Error('r_source_archive_url_invalid'); }
  if (parsed.origin !== SNAPSHOT_ORIGIN || !SNAPSHOT_PATH.test(parsed.pathname)
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('r_source_archive_url_outside_fixed_snapshot');
  }
  return parsed.href;
}

async function boundedResponseBytes(response, maximumBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error('r_source_archive_declared_size_exceeded');
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumBytes) throw new Error('r_source_archive_size_exceeded');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      length += chunk.length;
      if (length > maximumBytes) throw new Error('r_source_archive_size_exceeded');
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, length);
}

export function createPositSnapshotRSourceArchiveTransport({
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
  maximumArchiveBytes = 64 * 1024 * 1024,
} = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(maximumArchiveBytes) || maximumArchiveBytes < 100) {
    throw new Error('r_source_archive_transport_configuration_invalid');
  }
  return assertRRuntimeSourceArchiveTransport(Object.freeze({
    version: 1,
    kind: 'RRuntimeSourceArchiveTransport',
    async fetchArchive({ url, signal = null } = {}) {
      const canonicalUrl = canonicalSnapshotUrl(url);
      if (signal?.aborted) throw new Error('r_source_archive_fetch_aborted');
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
      try {
        const response = await fetchImpl(canonicalUrl, {
          method: 'GET',
          redirect: 'error',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
          headers: Object.freeze({ accept: 'application/gzip, application/octet-stream' }),
        });
        if (!response?.ok) throw new Error(`r_source_archive_http_${response?.status || 'invalid'}`);
        if (response.url && canonicalSnapshotUrl(response.url) !== canonicalUrl) {
          throw new Error('r_source_archive_response_url_mismatch');
        }
        return Object.freeze({
          url: canonicalUrl,
          bytes: await boundedResponseBytes(response, maximumArchiveBytes),
        });
      } catch (error) {
        if (controller.signal.aborted) throw new Error('r_source_archive_fetch_timeout_or_aborted');
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  }));
}
