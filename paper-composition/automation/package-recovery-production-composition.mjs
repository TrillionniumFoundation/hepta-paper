import path from 'node:path';

import { createPackageRecoveryExactRestoreRepository }
  from '../../paper-adapters/automation/package-recovery-exact-restore-repository.mjs';
import { createPackageRecoveryDeletionLeasePort }
  from '../../paper-application/automation/package-recovery-deletion-lease-client.mjs';
import { assertPackageRecoveryAuthorityPort }
  from '../../paper-ports/package-recovery-authority-port.mjs';

const AUTHORITY_FACTORY_KIND = 'PackageRecoveryAuthorityFactory';
const EXACT_RESTORE_FACTORY_KIND = 'PackageRecoveryExactRestoreRepositoryFactory';

function canonicalAbsolutePath(candidate) {
  return typeof candidate === 'string'
    && path.isAbsolute(candidate)
    && path.resolve(candidate) === candidate
    && candidate !== path.parse(candidate).root;
}

function unavailableConfiguration() {
  return Object.freeze({
    packageRecoveryAuthority: null,
    packageRecoveryAuthorityReadinessVerifier: null,
    packageRecoveryDeletionLeasePort: null,
  });
}

function exactRestoreRepositoryFactory({ restoreRoot, runtimeRoot }) {
  return Object.freeze({
    version: 1,
    kind: EXACT_RESTORE_FACTORY_KIND,
    create({ storageObjectPath } = {}) {
      return createPackageRecoveryExactRestoreRepository({
        restoreRoot,
        runtimeRoot,
        storageObjectPath,
      });
    },
  });
}

function createRecoveryAuthority({
  factory,
  restoreFactory,
  runtimeRoot,
}) {
  if (factory?.version !== 1
    || factory.kind !== AUTHORITY_FACTORY_KIND
    || typeof factory.create !== 'function') {
    throw new Error('package_recovery_production_authority_factory_invalid');
  }
  const authority = factory.create(Object.freeze({
    version: 1,
    kind: 'PackageRecoveryAuthorityFactoryContext',
    runtimeRoot,
    exactRestoreRepositoryFactory: restoreFactory,
  }));
  if (authority && typeof authority.then === 'function') {
    throw new Error('package_recovery_production_async_authority_factory_forbidden');
  }
  const selected = assertPackageRecoveryAuthorityPort(authority);
  if (typeof selected.inspectAuthenticatedReadiness !== 'function') {
    throw new Error('package_recovery_production_authority_readiness_unavailable');
  }
  return selected;
}

export function composeProductionPackageRecoveryAuthorities({
  runtimeRoot,
  restoreRoot = null,
  packageRecoveryAuthorityFactory = null,
  packageRecoveryAuthorityReadinessVerifier = null,
  packageRecoveryDeletionLeaseAuthority = null,
  observeNow = () => new Date().toISOString(),
} = {}) {
  const configured = [
    restoreRoot,
    packageRecoveryAuthorityFactory,
    packageRecoveryAuthorityReadinessVerifier,
    packageRecoveryDeletionLeaseAuthority,
  ].filter((candidate) => candidate !== null && candidate !== undefined);
  if (configured.length === 0) return unavailableConfiguration();
  if (configured.length !== 4) {
    throw new Error('package_recovery_production_authorities_incomplete');
  }
  if (!canonicalAbsolutePath(runtimeRoot) || !canonicalAbsolutePath(restoreRoot)) {
    throw new Error('package_recovery_production_restore_boundary_invalid');
  }
  if (typeof packageRecoveryAuthorityReadinessVerifier
      ?.verifyAuthenticatedInspection !== 'function') {
    throw new Error('package_recovery_production_readiness_verifier_invalid');
  }
  const restoreFactory = exactRestoreRepositoryFactory({ restoreRoot, runtimeRoot });
  const packageRecoveryDeletionLeasePort = createPackageRecoveryDeletionLeasePort({
    authority: packageRecoveryDeletionLeaseAuthority,
    observeNow,
  });
  const packageRecoveryAuthority = createRecoveryAuthority({
    factory: packageRecoveryAuthorityFactory,
    restoreFactory,
    runtimeRoot,
  });
  return Object.freeze({
    packageRecoveryAuthority,
    packageRecoveryAuthorityReadinessVerifier,
    packageRecoveryDeletionLeasePort,
  });
}
