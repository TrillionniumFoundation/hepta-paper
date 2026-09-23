import path from 'node:path';

import {
  createAutonomousResearchStateBackupAuthorityProcessClient,
} from '../../paper-adapters/automation/autonomous-research-state-backup-authority.mjs';
import {
  createAutonomousResearchOnlineMutationAuthorityProcessClient,
} from '../../paper-adapters/automation/autonomous-research-online-mutation-authority.mjs';
import {
  reconcileAutonomousResearchOnlineMutationDatabaseStartup,
} from '../../paper-adapters/automation/autonomous-research-online-mutation-startup-reconciliation.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  createAutonomousResearchStateBackup,
  drillAutonomousResearchStateRestore,
  observeAutonomousResearchStateBackupCurrentHead,
  publishAutonomousResearchStateBackupRenewalReceipt,
  resolveLatestAutonomousResearchStateBackupSources,
} from '../../paper-adapters/automation/autonomous-research-state-backup-repository.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {
  inspectAutonomousResearchStatePendingFinalizations,
  openAutonomousResearchStateReconciliationDatabase,
} from '../../paper-adapters/automation/autonomous-research-state-reconciliation-database.mjs';
import { readRegularJsonFileSync } from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import {
  renewAutonomousResearchStateBackup,
} from '../../paper-application/automation/autonomous-research-state-backup-renewal.mjs';
import {
  reconcileAndRenewAutonomousResearchStateBackup,
  reconcileAutonomousResearchStatePendingMutations,
} from '../../paper-application/automation/autonomous-research-state-reconcile-and-renew.mjs';

export function composeAutonomousResearchStateBackupService({
  workspaceRoot,
  runtimeRoot,
  authorityConfigurationPath = null,
  onlineMutationAuthorityProcessConfigurationPath = null,
  clock = null,
} = {}) {
  const manifestPath = path.join(
    path.resolve(workspaceRoot),
    'paper-core',
    'config',
    'autonomous-research-state-databases.v1.json',
  );
  const stateDatabaseManifest = readRegularJsonFileSync(manifestPath);
  const authority = authorityConfigurationPath
    ? createAutonomousResearchStateBackupAuthorityProcessClient({
      configurationPath: path.resolve(authorityConfigurationPath),
    })
    : null;
  const onlineMutationAuthority = onlineMutationAuthorityProcessConfigurationPath
    ? createAutonomousResearchOnlineMutationAuthorityProcessClient({
      processConfigurationPath:
        path.resolve(onlineMutationAuthorityProcessConfigurationPath),
    })
    : null;
  const backupRoot = path.join(
    path.resolve(runtimeRoot),
    'backups',
    'autonomous-research-state',
  );
  const backup = () => createAutonomousResearchStateBackup({
    runtimeRoot,
    backupRoot,
    stateDatabaseManifest,
    authorityClient: authority?.client || null,
    authorityTrust: authority?.trust || null,
    onlineMutationVerifier: authority?.onlineMutationVerifier || null,
    clock,
  });
  const restoreDrill = ({ bundlePath }) => drillAutonomousResearchStateRestore({
    bundlePath,
    backupRoot,
    stateDatabaseManifest,
    authorityClient: authority?.client || null,
    authorityTrust: authority?.trust || null,
    onlineMutationVerifier: authority?.onlineMutationVerifier || null,
    clock,
  });
  const resolveInventory = () => resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const renew = () => renewAutonomousResearchStateBackup({
    createBackup: backup,
    drillExactBundle: restoreDrill,
    publishRenewalReceipt: ({ bundlePath, receipt }) => (
      publishAutonomousResearchStateBackupRenewalReceipt({
        backupRoot,
        bundlePath,
        receipt,
      })
    ),
    clock,
  });
  const withInventoryDatabase = ({ instance, action }) => {
    const database = openAutonomousResearchStateReconciliationDatabase({
      runtimeRoot,
      instance,
    });
    try { return action(database); }
    finally { database.close(); }
  };
  const reconciliationInput = () => ({
    resolveInventory,
    authorityTrust: onlineMutationAuthority?.trust || null,
    backupOnlineMutationTrust: authority?.onlineMutationVerifier?.trust || null,
    writerManifest: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    reconcileDatabaseStartup({ instance, writerManifest }) {
      return withInventoryDatabase({
        instance,
        action: (database) => (
          reconcileAutonomousResearchOnlineMutationDatabaseStartup({
            database,
            databaseRole: instance.role,
            databaseInstanceId: instance.instanceId,
            authorityClient: onlineMutationAuthority,
            authorityTrust: onlineMutationAuthority?.trust,
            writerManifest,
            clock: clock || { now: () => new Date() },
          })
        ),
      });
    },
    inspectPendingFinalizations({ instance }) {
      return withInventoryDatabase({
        instance,
        action: (database) => (
          inspectAutonomousResearchStatePendingFinalizations({
            database,
            databaseRole: instance.role,
            databaseInstanceId: instance.instanceId,
          })
        ),
      });
    },
    clock,
  });
  return Object.freeze({
    inventory() {
      return resolveInventory();
    },
    backup,
    restoreDrill,
    renew,
    reconcilePending() {
      return reconcileAutonomousResearchStatePendingMutations(
        reconciliationInput(),
      );
    },
    reconcileAndRenew() {
      return reconcileAndRenewAutonomousResearchStateBackup({
        ...reconciliationInput(),
        renewBackup: renew,
      });
    },
    observeBundleHead({ bundlePath }) {
      return observeAutonomousResearchStateBackupCurrentHead({
        bundlePath,
        backupRoot,
        stateDatabaseManifest,
        authorityClient: authority?.client || null,
        authorityTrust: authority?.trust || null,
        clock,
      });
    },
    offhostSources() {
      return resolveLatestAutonomousResearchStateBackupSources({
        runtimeRoot,
        backupRoot,
        stateDatabaseManifest,
        authorityTrust: authority?.trust || null,
        onlineMutationVerifier: authority?.onlineMutationVerifier || null,
      });
    },
    manifestPath,
    backupRoot,
    authorityConfigured: Boolean(authority),
    authorityConfigurationHash: authority?.configurationHash || null,
    onlineMutationAuthorityConfigured: Boolean(onlineMutationAuthority),
    onlineMutationAuthorityConfigurationHash:
      onlineMutationAuthority?.configurationHash || null,
  });
}
