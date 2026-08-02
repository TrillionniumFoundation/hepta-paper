import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeAutonomousSubmissionHandoffReceiptLedger,
} from './receipt-ledger-composition.mjs';
import {
  openAutonomousSubmissionHandoffStore,
} from '../../paper-adapters/persistence/autonomous-submission-handoff-store.mjs';
import {
  resolveAutonomousSubmissionHandoffStateDatabaseInventory,
} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import { readRegularJsonFileSync }
  from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import {
  composeAutonomousSubmissionDispatchContext,
  composeAutonomousSubmissionOutbox,
} from '../automation/autonomous-submission-runtime-composition.mjs';
import {
  composeAutonomousResearchOnlineMutationCoordinator,
} from './autonomous-research-online-mutation-composition.mjs';
import {
  AUTONOMOUS_SUBMISSION_HANDOFF_DATABASE_INSTANCE_ID,
  AUTONOMOUS_SUBMISSION_HANDOFF_DATABASE_ROLE,
} from '../../paper-adapters/persistence/autonomous-submission-handoff-mutation-plan.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..',
);

function configuredHandoffMutationCoordinator({ runtimeRoot, environment }) {
  const authorityProcessConfigurationPath = String(
    environment.HEPTA_AUTONOMOUS_SUBMISSION_HANDOFF_MUTATION_AUTHORITY_PROCESS_CONFIG || '',
  ).trim();
  if (!authorityProcessConfigurationPath) {
    throw new Error('autonomous_submission_handoff_external_mutation_coordinator_required');
  }
  const manifest = readRegularJsonFileSync(path.join(
    WORKSPACE_ROOT, 'paper-core', 'config',
    'autonomous-research-state-databases.v1.json',
  ));
  const inventory = resolveAutonomousSubmissionHandoffStateDatabaseInventory({
    runtimeRoot,
    manifest,
  });
  if (inventory.status !== 'autonomous_research_state_database_inventory_ready') {
    throw new Error('autonomous_submission_handoff_state_inventory_not_ready');
  }
  const configured = composeAutonomousResearchOnlineMutationCoordinator({
    inventory,
    authorityProcessConfigurationPath,
  });
  const status = configured.inspectStatus();
  const instance = inventory.instances[0];
  if (inventory.instances.length !== 1
    || instance.role !== AUTONOMOUS_SUBMISSION_HANDOFF_DATABASE_ROLE
    || instance.instanceId !== AUTONOMOUS_SUBMISSION_HANDOFF_DATABASE_INSTANCE_ID
    || status?.status !== 'externally_fenced_sqlite_mutation_coordinator_configured'
    || status?.implemented !== true
    || status.blockers?.join('\0')
      !== 'autonomous_research_online_mutation_runtime_activation_required') {
    throw new Error('autonomous_submission_handoff_external_mutation_coordinator_invalid');
  }
  const activationReceiptHash = hashRecord(
    'AutonomousSubmissionHandoffExternalMutationCoordinatorActivation',
    {
      databaseScopeHash: inventory.databaseScopeHash,
      databaseInstanceId: instance.instanceId,
      schemaHash: instance.schemaHash,
      inventoryHash: inventory.inventoryHash,
    },
  );
  const coveredDatabaseRoles = Object.freeze([
    AUTONOMOUS_SUBMISSION_HANDOFF_DATABASE_ROLE,
  ]);
  return Object.freeze({
    implemented: true,
    protocol: configured.protocol,
    coveredDatabaseRoles,
    executeMutation(input) {
      if (input?.databaseRole !== AUTONOMOUS_SUBMISSION_HANDOFF_DATABASE_ROLE
        || input?.databaseInstanceId
          !== AUTONOMOUS_SUBMISSION_HANDOFF_DATABASE_INSTANCE_ID) {
        throw new Error('autonomous_submission_handoff_mutation_scope_forbidden');
      }
      return configured.executeMutation(input);
    },
    recoverPendingMutations(input) {
      return configured.recoverPendingMutations(input);
    },
    inspectStatus() {
      return Object.freeze({
        version: 1,
        kind: 'ExternallyFencedSqliteMutationCoordinatorStatus',
        status: 'externally_fenced_sqlite_mutation_coordinator_ready',
        implemented: true,
        coveredDatabaseRoles,
        activationReceiptHash,
        activationPolicy:
          'dedicated-handoff-external-authority-verified-per-mutation-v1',
        blockers: Object.freeze([]),
      });
    },
  });
}

function missingReadOnlyHandoffOutbox() {
  const unavailable = () => {
    throw new Error('autonomous_submission_handoff_offline_provisioning_required');
  };
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionHandoffOutboxPort',
    durability: 'sqlite-transactional-outbox-v1',
    externallyFencedMutations: false,
    prepareAutonomousSubmission: unavailable,
    beginAutonomousSubmissionAttempt: unavailable,
    recordAutonomousSubmissionOutcome: unavailable,
    getAutonomousSubmission: () => null,
    listAutonomousSubmissionsForCampaign: () => Object.freeze([]),
    listDispatchableAutonomousSubmissions: () => Object.freeze([]),
  });
}

export function bootstrapAutonomousSubmissionHandoffContext({
  root,
  runtimeRoot,
  environment = process.env,
  clock = null,
  autonomousSubmissionDispatchAuthority = null,
  handoffOnly = true,
  outboxOverride = null,
  mutationCoordinator = null,
  readOnly = false,
  allowMissingReadOnlyStore = false,
  requireExternallyFenced = true,
} = {}) {
  const effectiveClock = clock || createSystemClock();
  const {
    autonomousSubmissionRequestVerifier,
    autonomousSubmissionDispatchAuthority: dispatchAuthority,
  } = composeAutonomousSubmissionDispatchContext({
    root,
    runtimeRoot,
    clock: effectiveClock,
    environment,
    autonomousSubmissionDispatchAuthority,
    handoffOnly,
  });
  let store = null;
  try {
    const coordinator = outboxOverride || readOnly ? null
      : mutationCoordinator || (requireExternallyFenced
        ? configuredHandoffMutationCoordinator({
          runtimeRoot,
          environment,
        })
        : null);
    if (!outboxOverride) {
      try {
        store = openAutonomousSubmissionHandoffStore({
          runtimeRoot,
          readOnly,
          mutationCoordinator: coordinator,
          requireExternallyFenced: requireExternallyFenced && !readOnly,
        });
      } catch (error) {
        if (!(readOnly && allowMissingReadOnlyStore
          && error?.message === 'autonomous_submission_handoff_offline_provisioning_required')) {
          throw error;
        }
      }
    }
    const receiptLedger = store ? composeAutonomousSubmissionHandoffReceiptLedger({
      store,
      clock: effectiveClock,
    }) : null;
    const autonomousSubmissionOutbox = outboxOverride
      || (!store ? missingReadOnlyHandoffOutbox() : null)
      || composeAutonomousSubmissionOutbox({
        store,
        receiptLedger,
        clock: effectiveClock,
        autonomousSubmissionRequestVerifier,
        autonomousSubmissionDispatchAuthority: dispatchAuthority,
        handoffOnly,
        dedicatedHandoffRequired: requireExternallyFenced,
      });
    return Object.freeze({
      version: 1,
      kind: handoffOnly
        ? 'AutonomousSubmissionHandoffContext'
        : 'AutonomousSubmissionDispatcherContext',
      services: Object.freeze({
        clock: effectiveClock,
        autonomousSubmissionRequestVerifier,
        autonomousSubmissionOutbox,
        persistenceSession: Object.freeze({
          version: 1,
          kind: 'AutonomousSubmissionHandoffPersistenceSession',
          close: () => store?.close?.(),
        }),
      }),
    });
  } catch (error) {
    store?.close?.();
    throw error;
  }
}
