import net from 'node:net';

import { listenOnAtomicUnixSocket } from '../runtime/atomic-unix-socket-publication.mjs';

const DEFAULT_MAXIMUM_MESSAGE_BYTES = 256 * 1024 * 1024;

function fail(code, cause) {
  throw new Error(code, cause ? { cause } : undefined);
}

function validSocketPath(socketPath) {
  return typeof socketPath === 'string'
    && socketPath.startsWith('/')
    && !socketPath.includes('\0');
}

export function requestLocalAutonomousResearchStateAuthority({
  request,
  socketPath,
  timeoutMs = 120000,
  maximumMessageBytes = DEFAULT_MAXIMUM_MESSAGE_BYTES,
} = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || !validSocketPath(socketPath)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000
    || !Number.isSafeInteger(maximumMessageBytes) || maximumMessageBytes < 1024) {
    return Promise.reject(new Error('local_state_authority_client_configuration_invalid'));
  }
  const payload = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8');
  if (payload.length > maximumMessageBytes) {
    return Promise.reject(new Error('local_state_authority_client_request_too_large'));
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const chunks = [];
    let byteLength = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => {
      finish(new Error('local_state_authority_client_timeout'));
    });
    socket.on('error', () => {
      finish(new Error('local_state_authority_client_connection_failed'));
    });
    socket.on('connect', () => socket.end(payload));
    socket.on('data', (chunk) => {
      byteLength += chunk.length;
      if (byteLength > maximumMessageBytes) {
        finish(new Error('local_state_authority_client_response_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    socket.on('end', () => {
      let envelope;
      try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8').trim()); }
      catch {
        finish(new Error('local_state_authority_client_response_invalid'));
        return;
      }
      if (envelope?.ok !== true || !envelope.receipt
        || typeof envelope.receipt !== 'object' || Array.isArray(envelope.receipt)) {
        finish(new Error(String(
          envelope?.error || 'local_state_authority_client_request_rejected',
        )));
        return;
      }
      finish(null, Object.freeze(envelope.receipt));
    });
  });
}

export async function startLocalAutonomousResearchStateAuthorityServer({
  authority,
  socketPath,
  socketMode = 0o660,
  maximumMessageBytes = DEFAULT_MAXIMUM_MESSAGE_BYTES,
} = {}) {
  if (!authority || typeof authority.handle !== 'function'
    || !validSocketPath(socketPath)
    || !Number.isSafeInteger(socketMode) || socketMode < 0 || socketMode > 0o777
    || !Number.isSafeInteger(maximumMessageBytes) || maximumMessageBytes < 1024) {
    fail('local_state_authority_server_configuration_invalid');
  }
  let queue = Promise.resolve();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const chunks = [];
    let byteLength = 0;
    socket.on('data', (chunk) => {
      byteLength += chunk.length;
      if (byteLength > maximumMessageBytes) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
    });
    socket.on('error', () => {});
    socket.on('end', () => {
      const operation = async () => {
        try {
          const request = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
          const receipt = authority.handle(request);
          socket.end(`${JSON.stringify({ ok: true, receipt })}\n`);
        } catch (error) {
          socket.end(`${JSON.stringify({
            ok: false,
            error: String(error?.message || error),
          })}\n`);
        }
      };
      queue = queue.then(operation, operation);
    });
  });
  let publication;
  try {
    publication = await listenOnAtomicUnixSocket({ server, socketPath, socketMode });
  } catch (error) {
    if (error?.message === 'atomic_unix_socket_path_conflict') {
      fail('local_state_authority_socket_path_conflict', error);
    }
    fail('local_state_authority_socket_publication_failed', error);
  }
  return Object.freeze({
    server,
    socketPath: publication.socketPath,
    close: () => publication.close(),
  });
}
