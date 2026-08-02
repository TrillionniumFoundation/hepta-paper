import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const MAXIMUM_MESSAGE_BYTES = 1024 * 1024;
export const DEFAULT_LOCAL_RELEASE_ATTESTOR_SOCKET_POLICY = Object.freeze({
  idleTimeoutMs: 5_000,
  requestDeadlineMs: 10_000,
  maximumConcurrentConnections: 32,
});
const MINIMUM_IDLE_TIMEOUT_MS = 1_000;
const MAXIMUM_IDLE_TIMEOUT_MS = 30_000;
const MAXIMUM_REQUEST_DEADLINE_MS = 30_000;
const MINIMUM_CONCURRENT_CONNECTIONS = 2;
const MAXIMUM_CONCURRENT_CONNECTIONS = 128;

function parseResponse(source, errorCode) {
  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value;
  } catch {
    throw new Error(errorCode);
  }
}

export function normalizeLocalReleaseAttestorSocketPolicy(
  value = DEFAULT_LOCAL_RELEASE_ATTESTOR_SOCKET_POLICY,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('local_release_attestor_socket_policy_invalid');
  }
  const keys = Object.keys(value).sort();
  if (keys.join('\n') !== [
    'idleTimeoutMs',
    'maximumConcurrentConnections',
    'requestDeadlineMs',
  ].join('\n')) {
    throw new Error('local_release_attestor_socket_policy_invalid');
  }
  const { idleTimeoutMs, requestDeadlineMs, maximumConcurrentConnections } = value;
  if (typeof idleTimeoutMs !== 'number'
    || !Number.isSafeInteger(idleTimeoutMs)
    || idleTimeoutMs < MINIMUM_IDLE_TIMEOUT_MS
    || idleTimeoutMs > MAXIMUM_IDLE_TIMEOUT_MS
    || typeof requestDeadlineMs !== 'number'
    || !Number.isSafeInteger(requestDeadlineMs)
    || requestDeadlineMs < idleTimeoutMs
    || requestDeadlineMs > MAXIMUM_REQUEST_DEADLINE_MS
    || typeof maximumConcurrentConnections !== 'number'
    || !Number.isSafeInteger(maximumConcurrentConnections)
    || maximumConcurrentConnections < MINIMUM_CONCURRENT_CONNECTIONS
    || maximumConcurrentConnections > MAXIMUM_CONCURRENT_CONNECTIONS) {
    throw new Error('local_release_attestor_socket_policy_invalid');
  }
  return Object.freeze({
    idleTimeoutMs,
    requestDeadlineMs,
    maximumConcurrentConnections,
  });
}

export function requestLocalReleaseAttestor({
  socketPath,
  request,
  timeoutMs = 5000,
} = {}) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: path.resolve(String(socketPath || '')) });
    let settled = false;
    let response = '';
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      client.destroy();
      operation();
    };
    client.setTimeout(timeoutMs);
    client.once('connect', () => {
      client.write(`${JSON.stringify(request)}\n`);
    });
    client.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (Buffer.byteLength(response, 'utf8') > MAXIMUM_MESSAGE_BYTES) {
        finish(() => reject(new Error('local_release_attestor_response_too_large')));
      }
    });
    client.once('end', () => {
      finish(() => {
        try {
          resolve(parseResponse(
            response.trim(),
            'local_release_attestor_response_invalid',
          ));
        } catch (error) { reject(error); }
      });
    });
    client.once('timeout', () => {
      finish(() => reject(new Error('local_release_attestor_timeout')));
    });
    client.once('error', (error) => {
      finish(() => reject(new Error(
        `local_release_attestor_unavailable:${String(error?.code || 'socket_error')}`,
      )));
    });
  });
}

export async function startLocalReleaseAttestorServer({
  socketPath,
  handleRequest,
  socketPolicy,
} = {}) {
  const selectedSocketPath = path.resolve(String(socketPath || ''));
  const selectedSocketPolicy = normalizeLocalReleaseAttestorSocketPolicy(socketPolicy);
  if (typeof handleRequest !== 'function') {
    throw new Error('local_release_attestor_handler_required');
  }
  fs.mkdirSync(path.dirname(selectedSocketPath), { recursive: true, mode: 0o750 });
  try {
    const stat = fs.lstatSync(selectedSocketPath);
    if (!stat.isSocket()) throw new Error('not socket');
    fs.unlinkSync(selectedSocketPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('local_release_attestor_socket_invalid');
  }
  let activeConnections = 0;
  const server = net.createServer((connection) => {
    connection.on('error', () => {});
    if (activeConnections >= selectedSocketPolicy.maximumConcurrentConnections) {
      connection.destroy();
      return;
    }
    activeConnections += 1;
    let source = '';
    let receivedBytes = 0;
    let completed = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      connection.setTimeout(0);
      clearTimeout(requestDeadline);
      activeConnections -= 1;
    };
    const requestDeadline = setTimeout(() => {
      connection.destroy(new Error('local_release_attestor_request_deadline_exceeded'));
    }, selectedSocketPolicy.requestDeadlineMs);
    requestDeadline.unref();
    connection.setTimeout(selectedSocketPolicy.idleTimeoutMs, () => {
      connection.destroy(new Error('local_release_attestor_connection_idle_timeout'));
    });
    connection.once('close', release);
    const respond = async () => {
      if (completed) return;
      completed = true;
      connection.pause();
      try {
        const request = parseResponse(
          source.trim(),
          'local_release_attestor_request_invalid',
        );
        const response = await handleRequest(request);
        if (!connection.destroyed) connection.end(`${JSON.stringify(response)}\n`);
      } catch (error) {
        if (!connection.destroyed) {
          connection.destroy(new Error(String(error?.message || error)));
        }
      }
    };
    connection.on('data', (chunk) => {
      if (completed) return;
      receivedBytes += chunk.length;
      source += chunk.toString('utf8');
      if (receivedBytes > MAXIMUM_MESSAGE_BYTES) {
        connection.destroy(new Error('local_release_attestor_request_too_large'));
        return;
      }
      if (source.includes('\n')) void respond();
    });
    connection.once('end', () => void respond());
  });
  server.maxConnections = selectedSocketPolicy.maximumConcurrentConnections;
  server.dropMaxConnection = true;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(selectedSocketPath, resolve);
  });
  fs.chmodSync(selectedSocketPath, 0o660);
  return Object.freeze({
    socketPath: selectedSocketPath,
    socketPolicy: selectedSocketPolicy,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        try { fs.unlinkSync(selectedSocketPath); } catch {}
        if (error) reject(error);
        else resolve();
      });
    }),
  });
}
