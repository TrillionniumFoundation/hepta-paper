export function assertRuntimeRetentionReachabilityProvider(port) {
  if (!port
    || port.version !== 1
    || port.kind !== 'RuntimeRetentionReachabilityProvider'
    || typeof port.createManifest !== 'function'
    || typeof port.loadManifest !== 'function') {
    throw new Error('runtime_retention_reachability_provider_port_invalid');
  }
  return port;
}
