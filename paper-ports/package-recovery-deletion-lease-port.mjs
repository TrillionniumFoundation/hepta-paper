const PACKAGE_RECOVERY_DELETION_LEASE_AUTHORITY_METHODS = Object.freeze([
  'acquire',
  'lookupTerminal',
  'assert',
  'renew',
  'commit',
  'abortRelease',
]);
const PACKAGE_RECOVERY_DELETION_LEASE_PORT_METHODS = Object.freeze([
  'acquire',
  'resumeTerminal',
  'assert',
  'renew',
  'commit',
  'abortRelease',
]);

function invalid(blocker) {
  throw new Error(blocker);
}

function hasLeaseMethods(candidate, methods) {
  return methods.every(
    (method) => typeof candidate?.[method] === 'function',
  );
}

export function assertPackageRecoveryDeletionLeaseAuthority(authority) {
  if (!authority || typeof authority !== 'object'
    || !hasLeaseMethods(
      authority,
      PACKAGE_RECOVERY_DELETION_LEASE_AUTHORITY_METHODS,
    )) {
    invalid('package_recovery_deletion_lease_authority_unavailable');
  }
  return authority;
}

export function assertPackageRecoveryDeletionLeasePort(port) {
  if (port?.version !== 1
    || port.kind !== 'PackageRecoveryDeletionLeasePort'
    || !hasLeaseMethods(port, PACKAGE_RECOVERY_DELETION_LEASE_PORT_METHODS)) {
    invalid('package_recovery_deletion_lease_port_invalid');
  }
  return port;
}
