import fs from 'node:fs';
import path from 'node:path';

import {
  validateAutonomousResearchOnlineSchemaTransitionInventory,
} from './autonomous-research-online-schema-transition-schema.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from './autonomous-research-state-database-inventory.mjs';
import {
  assertAutonomousResearchStateDatabaseManifest,
  autonomousResearchStateDatabaseManifestHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const IDENTITY_KEYS = Object.freeze([
  'machineIntakeConfigurationHash',
  'machineIntakeGenesisAuthorityMode',
  'providerCanaryPairMaximumCostUsd',
  'providerConfigurationHash',
  'runtimeReproducibilityRefreshPolicyHash',
  'topicProducerProfileHash',
  'writerManifestHash',
]);

function assertSecureParent(runtimeRoot) {
  const parent = path.dirname(runtimeRoot);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
    || fs.realpathSync(parent) !== parent) {
    throw new Error('autonomous_research_state_provisioning_parent_invalid');
  }
  return parent;
}

function assertProvisioningIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== IDENTITY_KEYS.join('\0')
    || !SHA256.test(String(value.machineIntakeConfigurationHash || ''))
    || !['external', 'root-owned-configuration'].includes(
      value.machineIntakeGenesisAuthorityMode,
    )
    || !SHA256.test(String(value.providerConfigurationHash || ''))
    || !SHA256.test(String(value.runtimeReproducibilityRefreshPolicyHash || ''))
    || !SHA256.test(String(value.topicProducerProfileHash || ''))
    || !SHA256.test(String(value.writerManifestHash || ''))
    || !Number.isFinite(Number(value.providerCanaryPairMaximumCostUsd))
    || Number(value.providerCanaryPairMaximumCostUsd) <= 0) {
    throw new Error('autonomous_research_state_provisioning_identity_invalid');
  }
  return Object.freeze({
    ...value,
    providerCanaryPairMaximumCostUsd:
      Number(value.providerCanaryPairMaximumCostUsd),
  });
}

function targetRuntimeRoot(value) {
  const selected = path.resolve(String(value || ''));
  if (!value || selected === path.parse(selected).root || path.basename(selected) === '.') {
    throw new Error('autonomous_research_state_provisioning_runtime_root_invalid');
  }
  assertSecureParent(selected);
  if (fs.existsSync(selected)) {
    throw new Error('autonomous_research_state_provisioning_fresh_runtime_required');
  }
  return selected;
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function businessSchemaProjection(inventory) {
  return Object.freeze(inventory.instances.map((instance) => Object.freeze({
    instanceId: instance.instanceId,
    role: instance.role,
    sourceRelativePath: instance.sourceRelativePath,
    schemaContractId: instance.schemaContractId,
    schemaHash: instance.schemaHash,
    sourceSha256: instance.sourceSha256,
  })).sort((left, right) => left.instanceId.localeCompare(right.instanceId)));
}

export function buildAutonomousResearchStateBusinessSchemaProvisioningPlan({
  runtimeRoot,
  stateDatabaseManifest,
  provisioningIdentity,
} = {}) {
  const resolvedRuntimeRoot = targetRuntimeRoot(runtimeRoot);
  const manifest = assertAutonomousResearchStateDatabaseManifest(stateDatabaseManifest);
  const identity = assertProvisioningIdentity(provisioningIdentity);
  const payload = {
    version: 1,
    kind: 'AutonomousResearchStateBusinessSchemaProvisioningPlan',
    status: 'autonomous_research_state_business_schema_provisioning_plan_ready',
    ready: true,
    runtimeRoot: resolvedRuntimeRoot,
    stateDatabaseManifestHash: autonomousResearchStateDatabaseManifestHash(manifest),
    databaseRoles: Object.freeze(manifest.databases.map((entry) => entry.role).sort()),
    provisioningIdentity: identity,
    freshRuntimeRequired: true,
    stagedAtomicInstallationRequired: true,
    onlineSchemaTransitionRequired: true,
  };
  return Object.freeze({
    ...payload,
    provisioningPlanId: hashRecord(
      'AutonomousResearchStateBusinessSchemaProvisioningPlan',
      payload,
    ),
  });
}

export function provisionAutonomousResearchStateBusinessSchemas({
  runtimeRoot,
  stateDatabaseManifest,
  provisioningIdentity,
  expectedProvisioningPlanId,
  provisionBusinessSchemas,
} = {}) {
  if (typeof provisionBusinessSchemas !== 'function'
    || !SHA256.test(String(expectedProvisioningPlanId || ''))) {
    throw new Error('autonomous_research_state_provisioning_execution_invalid');
  }
  const plan = buildAutonomousResearchStateBusinessSchemaProvisioningPlan({
    runtimeRoot,
    stateDatabaseManifest,
    provisioningIdentity,
  });
  if (plan.provisioningPlanId !== expectedProvisioningPlanId) {
    throw new Error('autonomous_research_state_provisioning_plan_mismatch');
  }
  const parent = path.dirname(plan.runtimeRoot);
  const stagingRoot = fs.mkdtempSync(path.join(
    parent,
    `.${path.basename(plan.runtimeRoot)}.provisioning-`,
  ));
  fs.chmodSync(stagingRoot, 0o700);
  let installationCommitted = false;
  try {
    provisionBusinessSchemas({ runtimeRoot: stagingRoot });
    const stagedInventory = resolveAutonomousResearchStateDatabaseInventory({
      runtimeRoot: stagingRoot,
      manifest: stateDatabaseManifest,
    });
    validateAutonomousResearchOnlineSchemaTransitionInventory({
      runtimeRoot: stagingRoot,
      inventory: stagedInventory,
      stateDatabaseManifest,
    });
    const stagedProjection = businessSchemaProjection(stagedInventory);
    syncDirectory(stagingRoot);
    if (fs.existsSync(plan.runtimeRoot)) {
      throw new Error('autonomous_research_state_provisioning_target_appeared');
    }
    fs.renameSync(stagingRoot, plan.runtimeRoot);
    installationCommitted = true;
    syncDirectory(parent);
    const installedInventory = resolveAutonomousResearchStateDatabaseInventory({
      runtimeRoot: plan.runtimeRoot,
      manifest: stateDatabaseManifest,
    });
    validateAutonomousResearchOnlineSchemaTransitionInventory({
      runtimeRoot: plan.runtimeRoot,
      inventory: installedInventory,
      stateDatabaseManifest,
    });
    const installedProjection = businessSchemaProjection(installedInventory);
    if (JSON.stringify(stagedProjection) !== JSON.stringify(installedProjection)) {
      throw new Error('autonomous_research_state_provisioning_installation_drift');
    }
    const payload = {
      version: 1,
      kind: 'AutonomousResearchStateBusinessSchemaProvisioningReceipt',
      status: 'autonomous_research_state_business_schemas_provisioned',
      ready: true,
      provisioningPlanId: plan.provisioningPlanId,
      stateDatabaseManifestHash: plan.stateDatabaseManifestHash,
      databaseScopeHash: installedInventory.databaseScopeHash,
      databaseRoles: plan.databaseRoles,
      databaseInstances: installedProjection,
      provisioningIdentity: plan.provisioningIdentity,
      freshRuntimeInstalled: true,
      onlineSchemaTransitionRequired: true,
      externalAuthoritySelfSigned: false,
    };
    return Object.freeze({
      ...payload,
      provisioningReceiptHash: hashRecord(
        'AutonomousResearchStateBusinessSchemaProvisioningReceipt',
        payload,
      ),
    });
  } finally {
    if (!installationCommitted) fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}
