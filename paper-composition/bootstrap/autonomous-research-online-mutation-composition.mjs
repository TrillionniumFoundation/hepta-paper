import path from 'node:path';

import {
  createAutonomousResearchOnlineMutationAuthorityProcessClient,
} from '../../paper-adapters/automation/autonomous-research-online-mutation-authority.mjs';
import {
  inspectAutonomousResearchOnlineFinalizedDatabaseHead,
} from '../../paper-adapters/automation/autonomous-research-online-finalized-head-inspection.mjs';
import {
  refreshAutonomousResearchOnlineMutationAuthorityEvidence,
} from '../../paper-adapters/automation/autonomous-research-online-mutation-active-refresh.mjs';
import {
  activateAutonomousResearchOnlineMutationRuntime,
} from '../../paper-adapters/automation/autonomous-research-online-runtime-activation.mjs';
import {
  createAutonomousResearchOnlineAuthorityEvidenceRenewalAdapter,
} from '../../paper-adapters/automation/autonomous-research-online-authority-evidence-renewal.mjs';
import {
  inspectAutonomousResearchOnlineSchemaTransitionReadiness,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition.mjs';
import { readRegularJsonFileSync } from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import {
  reconcileAutonomousResearchOnlineMutationDatabaseStartup,
} from '../../paper-adapters/automation/autonomous-research-online-mutation-startup-reconciliation.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  createExternallyFencedSqliteMutationCoordinator,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_OPERATION_PLANS,
} from './autonomous-research-online-mutation-operation-plans.mjs';

export function composeAutonomousResearchOnlineMutationCoordinator({
  inventory,
  authorityProcessConfigurationPath,
  clock = { now: () => new Date() },
  manifest = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  operationPlans = AUTONOMOUS_RESEARCH_ONLINE_MUTATION_OPERATION_PLANS,
  createAuthorityClient =
    createAutonomousResearchOnlineMutationAuthorityProcessClient,
  recoverabilityEpochFence = null,
} = {}) {
  if (inventory?.status !== 'autonomous_research_state_database_inventory_ready'
    || !Array.isArray(inventory.instances)
    || inventory.instances.length === 0
    || !authorityProcessConfigurationPath) {
    throw new Error('autonomous_research_online_mutation_composition_prerequisites_missing');
  }
  const authorityClient = createAuthorityClient({
    processConfigurationPath: authorityProcessConfigurationPath,
  });
  return createExternallyFencedSqliteMutationCoordinator({
    authorityClient,
    authorityTrust: authorityClient.trust,
    manifest,
    operationPlans,
    databaseInstances: Object.freeze(inventory.instances.map((instance) => Object.freeze({
      databaseRole: instance.role,
      databaseInstanceId: instance.instanceId,
      schemaHash: instance.schemaHash,
    })).sort((left, right) => (
      left.databaseInstanceId.localeCompare(right.databaseInstanceId)
    ))),
    clock,
    recoverabilityEpochFence,
  });
}

export function composeAutonomousResearchOnlineMutationDatabaseStartupReconciliation({
  database,
  databaseRole,
  databaseInstanceId,
  authorityProcessConfigurationPath,
  clock = { now: () => new Date() },
  manifest = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  createAuthorityClient =
    createAutonomousResearchOnlineMutationAuthorityProcessClient,
} = {}) {
  if (!authorityProcessConfigurationPath) {
    throw new Error('autonomous_research_online_mutation_composition_prerequisites_missing');
  }
  const authorityClient = createAuthorityClient({
    processConfigurationPath: authorityProcessConfigurationPath,
  });
  return reconcileAutonomousResearchOnlineMutationDatabaseStartup({
    database,
    databaseRole,
    databaseInstanceId,
    authorityClient,
    authorityTrust: authorityClient.trust,
    writerManifest: manifest,
    clock,
  });
}

export function composeAutonomousResearchOnlineFinalizedDatabaseHeadInspection({
  database,
  databaseInstanceId,
  inventory,
  authorityProcessConfigurationPath,
  clock = { now: () => new Date() },
  manifest = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  createAuthorityClient =
    createAutonomousResearchOnlineMutationAuthorityProcessClient,
} = {}) {
  if (!authorityProcessConfigurationPath) {
    throw new Error('autonomous_research_online_mutation_composition_prerequisites_missing');
  }
  const authorityClient = createAuthorityClient({
    processConfigurationPath: authorityProcessConfigurationPath,
  });
  return inspectAutonomousResearchOnlineFinalizedDatabaseHead({
    database,
    databaseInstanceId,
    inventory,
    authorityClient,
    authorityTrust: authorityClient.trust,
    writerManifest: manifest,
    clock,
  });
}

export function composeAutonomousResearchOnlineMutationRuntimeActivation({
  workspaceRoot,
  runtimeRoot,
  inventory,
  latestRestoreDrill,
  resolveInventory,
  authorityProcessConfigurationPath,
  authorityConfigurationPath,
  clock = { now: () => new Date() },
  manifest = AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  operationPlans = AUTONOMOUS_RESEARCH_ONLINE_MUTATION_OPERATION_PLANS,
  createAuthorityClient =
    createAutonomousResearchOnlineMutationAuthorityProcessClient,
  createAuthorityEvidenceRenewalAdapter =
    createAutonomousResearchOnlineAuthorityEvidenceRenewalAdapter,
  recoverabilityEpochFence = null,
} = {}) {
  if (!workspaceRoot || !runtimeRoot || typeof resolveInventory !== 'function'
    || !authorityProcessConfigurationPath || !authorityConfigurationPath) {
    throw new Error('autonomous_research_online_mutation_composition_prerequisites_missing');
  }
  const authorityClient = createAuthorityClient({
    processConfigurationPath: authorityProcessConfigurationPath,
  });
  const configuredCoordinator = composeAutonomousResearchOnlineMutationCoordinator({
    inventory,
    authorityProcessConfigurationPath,
    clock,
    manifest,
    operationPlans,
    createAuthorityClient: () => authorityClient,
    recoverabilityEpochFence,
  });
  const stateDatabaseManifest = readRegularJsonFileSync(path.join(
    path.resolve(workspaceRoot),
    'paper-core',
    'config',
    'autonomous-research-state-databases.v1.json',
  ));
  const schemaTransitionReadiness =
    inspectAutonomousResearchOnlineSchemaTransitionReadiness({
      runtimeRoot,
      stateDatabaseManifest,
      writerManifest: manifest,
      authorityProcessConfigurationPath,
      clock,
    });
  const activation = activateAutonomousResearchOnlineMutationRuntime({
    workspaceRoot,
    runtimeRoot,
    inventory,
    latestRestoreDrill,
    authorityProcessConfigurationPath,
    authorityConfigurationPath,
    configuredCoordinator,
    writerManifest: manifest,
    authorityClient,
    schemaTransitionReadiness,
    reconcileDatabaseStartup:
      reconcileAutonomousResearchOnlineMutationDatabaseStartup,
    inspectFinalizedDatabaseHead:
      inspectAutonomousResearchOnlineFinalizedDatabaseHead,
    refreshAuthorityEvidence:
      refreshAutonomousResearchOnlineMutationAuthorityEvidence,
    resolveInventory,
    clock,
  });
  const authorityEvidenceRenewalAdapter = createAuthorityEvidenceRenewalAdapter({
    workspaceRoot,
    runtimeRoot,
    activationReceipt: activation.receipt,
    activationInventory: activation.inventory,
    coordinator: activation.coordinator,
    authorityProcessConfigurationPath,
    authorityConfigurationPath,
    authorityClient,
    manifest,
    resolveInventory,
    clock,
  });
  return Object.freeze({ ...activation, authorityEvidenceRenewalAdapter });
}
