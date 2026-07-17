export function assertRRuntimeSourceArchiveTransport(transport) {
  if (!transport || transport.version !== 1
    || transport.kind !== 'RRuntimeSourceArchiveTransport'
    || typeof transport.fetchArchive !== 'function') {
    throw new Error('RRuntimeSourceArchiveTransportPort is required');
  }
  return transport;
}
