import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { inspectTrackedProductionGraph } from './tracked-production-graph.mjs';
import {
  inspectSealedReadOnlySubmodules,
} from '../../paper-adapters/runtime/sealed-readonly-submodule-provenance.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { readTrustedWallClockEpochMs } from '../../paper-adapters/runtime/trusted-wall-clock.mjs';
import {
  verifyFormalOperationalReceipt,
} from '../bin/dynamic-formal-kernel-operational.mjs';
import {
  verifyProductionIntegrityPin,
} from '../../paper-domain/operations/production-integrity-contract.mjs';
import {
  verifySingleVenueSubmissionRolloutConfiguration,
} from '../../paper-domain/submission/single-venue-rollout-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

/**
 * This module is deliberately an observation-only release checklist.  It does
 * not mint authority, change release markers, contact a provider, or turn a
 * local replay into production evidence.  The output is intended to be stored
 * by an operator as a run-specific plan and compared with the signed release
 * bundle later in the process.
 */

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function safeError(error) {
  return String(error?.code || error?.message || error || 'unknown')
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 240);
}

function runGit(workspaceRoot, args) {
  const result = spawnSync('git', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15_000,
  });
  return Object.freeze({
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error ? safeError(result.error) : null,
  });
}

function requiredFile(workspaceRoot, relativePath) {
  const absolute = path.resolve(workspaceRoot, relativePath);
  try {
    const stat = fs.lstatSync(absolute);
    return Object.freeze({
      path: relativePath,
      present: stat.isFile() && !stat.isSymbolicLink(),
      bytes: stat.isFile() ? stat.size : null,
      mode: stat.mode & 0o7777,
    });
  } catch (error) {
    return Object.freeze({ path: relativePath, present: false, error: safeError(error) });
  }
}

function requiredDirectory(absolutePath) {
  try {
    const stat = fs.lstatSync(absolutePath);
    return Object.freeze({
      path: absolutePath,
      present: stat.isDirectory() && !stat.isSymbolicLink(),
      mode: stat.mode & 0o7777,
    });
  } catch (error) {
    return Object.freeze({ path: absolutePath, present: false, error: safeError(error) });
  }
}

function pathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function inspectFreeze(workspaceRoot, graph, environment = process.env) {
  const head = runGit(workspaceRoot, ['rev-parse', 'HEAD']);
  const tree = runGit(workspaceRoot, ['rev-parse', 'HEAD^{tree}']);
  const status = runGit(workspaceRoot, [
    'status', '--porcelain=v1', '--ignore-submodules=all', '--untracked-files=all',
  ]);
  const index = runGit(workspaceRoot, ['diff-index', '--cached', '--raw', '-z', 'HEAD']);
  const headValue = head.ok ? head.stdout.trim() : null;
  const treeValue = tree.ok ? tree.stdout.trim() : null;
  const clean = status.ok && status.stdout.length === 0 && index.ok && index.stdout.length === 0;
  const validObject = /^[0-9a-f]{40,64}$/.test(headValue || '')
    && /^[0-9a-f]{40,64}$/.test(treeValue || '');
  const blockers = [];
  if (!validObject) blockers.push('release_plan_git_identity_unavailable');
  if (!clean) blockers.push('release_plan_clean_commit_required');
  if (graph.status !== 'tracked_production_graph_ready') {
    blockers.push(...graph.blockers);
  }
  const sealedRequired = environment.HEPTA_RELEASE_ENV_LAUNCHER === 'sealed-v1'
    || environment.HEPTA_REQUIRE_SEALED_READONLY_CLOSURE === 'true';
  let sealedReadOnlySubmodules = Object.freeze({
    status: 'not_required',
  });
  if (sealedRequired) {
    try {
      sealedReadOnlySubmodules = inspectSealedReadOnlySubmodules({
        workspaceRoot,
      });
      if (sealedReadOnlySubmodules.status
        !== 'sealed_readonly_submodules_verified') {
        blockers.push('release_plan_sealed_readonly_submodule_closure_required');
      }
    } catch (error) {
      sealedReadOnlySubmodules = Object.freeze({
        status: 'inspection_failed',
        blocker: safeError(error),
      });
      blockers.push('release_plan_sealed_readonly_submodule_closure_invalid');
    }
  }
  return Object.freeze({
    status: blockers.length ? 'blocked' : 'ready',
    head: headValue,
    commitTree: treeValue,
    clean,
    graph: Object.freeze({
      status: graph.status,
      moduleCount: graph.moduleCount,
      edgeCount: graph.edgeCount,
      productionGraphManifestHash: graph.productionGraphManifestHash,
      untrackedModules: graph.untrackedModules,
      indexMismatchedModules: graph.indexMismatchedModules,
      blockers: graph.blockers,
    }),
    sealedReadOnlySubmodules,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function inspectFormal(workspaceRoot, environment, runtimeRoot) {
  const elanHome = environment.ELAN_HOME || null;
  const absolute = typeof elanHome === 'string' && path.isAbsolute(elanHome);
  const root = absolute ? requiredDirectory(elanHome) : { present: false, path: elanHome };
  const launcher = absolute ? requiredFile(elanHome, 'bin/elan') : { present: false };
  const receiptPath = path.resolve(
    environment.HEPTA_FORMAL_OPERATIONAL_RECEIPT
      || path.join(runtimeRoot, 'formal-operational', 'formal-operational-receipt.json'),
  );
  const receipt = requiredFile(path.dirname(receiptPath), path.basename(receiptPath));
  const blockers = [];
  if (!pathWithin(runtimeRoot, receiptPath)) {
    blockers.push('formal_release_plan_receipt_path_outside_runtime');
  }
  if (!absolute) blockers.push('formal_release_plan_elan_home_absolute_required');
  if (!root.present) blockers.push('formal_release_plan_elan_home_unavailable');
  if (!launcher.present) blockers.push('formal_release_plan_elan_launcher_unavailable');
  let zeroSkipped = false;
  if (receipt.present) {
    try {
      const value = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      let current = null;
      try {
        current = currentCodeProvenance({
          workspaceRoot,
          allowReleaseCommitEnvironment: false,
          requireSealedReadOnlySubmoduleClosure: environment
            .HEPTA_RELEASE_ENV_LAUNCHER === 'sealed-v1',
        });
      } catch (error) {
        blockers.push(`formal_release_plan_current_provenance_invalid:${safeError(error)}`);
      }
      zeroSkipped = verifyFormalOperationalReceipt(value, {
        expectedCodeProvenance: current,
      }) && value.codeProvenance?.treeDirty === false;
      if (!zeroSkipped) {
        blockers.push('formal_release_plan_receipt_provenance_or_hash_invalid');
      }
    } catch (error) {
      blockers.push(`formal_release_plan_receipt_invalid:${safeError(error)}`);
    }
  }
  if (!receipt.present) blockers.push('formal_release_plan_zero_skipped_receipt_required');
  else if (!zeroSkipped) blockers.push('formal_release_plan_zero_skipped_receipt_invalid');
  return Object.freeze({
    status: blockers.length ? 'blocked' : 'ready',
    elanHome,
    launcherPresent: launcher.present === true,
    receiptPath,
    receiptPresent: receipt.present === true,
    zeroSkipped,
    blockers: Object.freeze(blockers),
  });
}

function inspectExternalMaterials(workspaceRoot) {
  const required = [
    'paper-core/config/repository-asset-externalization.v1.json',
    'paper-core/config/release-dependency-tree.v1.json',
    'paper-core/config/offhost-worm-contract.v1.json',
    'paper-core/docs/CURRENT_STATUS.md',
    'RELEASE.md',
    'CHANGELOG.md',
    'migration/legacy-salvage-manifest.v1.json',
    'migration/legacy-empirical-analysis-deprecation-receipt.v1.json',
    'paper-core/config/single-venue-rollout-plan.schema.json',
    'paper-core/config/production-integrity-policy.schema.json',
  ].map((relativePath) => requiredFile(workspaceRoot, relativePath));
  const blockers = required.filter((item) => item.present !== true)
    .map((item) => `release_plan_required_material_missing:${item.path}`);
  return Object.freeze({
    status: blockers.length ? 'blocked' : 'ready',
    required,
    blockers: Object.freeze(blockers),
  });
}

function inspectAuthorities(runtimeRoot) {
  const root = path.resolve(runtimeRoot, 'owner-acceptance');
  const trust = requiredFile(root, 'OWNER_TRUST_STORE.json');
  const acceptance = requiredFile(root, 'CAPABILITY_OWNER_ACCEPTANCE.json');
  const blockers = [];
  if (!trust.present) blockers.push('release_plan_owner_trust_store_missing');
  if (!acceptance.present) blockers.push('release_plan_owner_acceptance_missing');
  let trustKeyCount = 0;
  let independentAcceptance = 0;
  for (const [item, field] of [[trust, 'trust'], [acceptance, 'acceptance']]) {
    if (!item.present) continue;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(root, path.basename(item.path)), 'utf8'));
      if (field === 'trust') trustKeyCount = Array.isArray(value.keys) ? value.keys.length : 0;
      else independentAcceptance = value.independentExternalAuthority === true
        ? Number(value.acceptedFamilies?.length || 0) : 0;
    } catch (error) {
      blockers.push(`release_plan_authority_document_invalid:${field}:${safeError(error)}`);
    }
  }
  // Presence of a local trust file is not independent external acceptance.
  if (independentAcceptance < 1) blockers.push('release_plan_independent_owner_acceptance_required');
  return Object.freeze({
    status: blockers.length ? 'blocked' : 'ready',
    trustStorePresent: trust.present,
    trustKeyCount,
    acceptancePresent: acceptance.present,
    independentAcceptance,
    blockers: Object.freeze(blockers),
  });
}

function inspectCompute(workspaceRoot, runtimeRoot, environment) {
  const cpuOracle = requiredFile(
    workspaceRoot,
    'paper-adapters/research-verify/independent-pde-poisson-2d-cpu-oracle-worker.mjs',
  );
  const gpuWorkflow = requiredFile(workspaceRoot, '.github/workflows/gpu-scientific.yml');
  const nvidia = spawnSync('nvidia-smi', [
    '--query-gpu=uuid,name,driver_version', '--format=csv,noheader,nounits',
  ], { encoding: 'utf8', timeout: 5_000 });
  const visibleGpu = nvidia.status === 0 && String(nvidia.stdout || '').trim().length > 0;
  const protectedCiOptIn = environment.HEPTA_ENABLE_GPU_CI === 'true';
  const blockers = [];
  if (!cpuOracle.present) blockers.push('release_plan_cpu_oracle_missing');
  if (!gpuWorkflow.present) blockers.push('release_plan_gpu_ci_workflow_missing');
  if (!visibleGpu) blockers.push('release_plan_nvidia_device_unavailable');
  if (!protectedCiOptIn) blockers.push('release_plan_nvidia_ci_not_provisioned');
  const qualificationPath = path.join(runtimeRoot, 'gpu-ci', 'GPU_PRODUCTION_QUALIFICATION.json');
  const qualification = requiredFile(path.dirname(qualificationPath), path.basename(qualificationPath));
  let independentlyQualified = false;
  if (qualification.present) {
    try {
      const value = JSON.parse(fs.readFileSync(qualificationPath, 'utf8'));
      independentlyQualified = value.status === 'gpu_production_qualification_verified'
        && value.independentAuthority === true
        && value.productionPromotionEligible === true;
    } catch (error) {
      blockers.push(`release_plan_gpu_qualification_invalid:${safeError(error)}`);
    }
  }
  if (!independentlyQualified) blockers.push('release_plan_independent_gpu_qualification_required');
  return Object.freeze({
    status: blockers.length ? 'blocked' : 'ready',
    cpuOraclePresent: cpuOracle.present,
    gpuWorkflowPresent: gpuWorkflow.present,
    visibleGpu,
    protectedCiOptIn,
    qualificationPresent: qualification.present,
    independentlyQualified,
    productionPromotionEligible: false,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function inspectSubmission(workspaceRoot) {
  const registry = requiredFile(
    workspaceRoot,
    'paper-domain/submission/journal-submission-target-registry.mjs',
  );
  const rollout = requiredFile(
    workspaceRoot,
    'paper-core/config/submission-single-venue-rollout.v1.json',
  );
  const blockers = [];
  if (!registry.present) blockers.push('release_plan_submission_registry_missing');
  if (!rollout.present) blockers.push('release_plan_single_venue_rollout_not_configured');
  let rolloutConfigured = false;
  if (rollout.present) {
    try {
      const value = JSON.parse(fs.readFileSync(
        path.resolve(workspaceRoot, 'paper-core/config/submission-single-venue-rollout.v1.json'),
        'utf8',
      ));
      const inertTemplateValid = verifySingleVenueSubmissionRolloutConfiguration(value);
      if (!inertTemplateValid) {
        blockers.push('release_plan_single_venue_rollout_invalid:configuration_contract');
      }
      rolloutConfigured = inertTemplateValid
        && value.status === 'configured_sandbox_only'
        && value.enabled === true
        && value.liveCommitEnabled === false
        && value.productionReady === false
        && value.externalActionPerformed === false
        && typeof value.venueId === 'string' && value.venueId.length > 0;
    } catch (error) {
      blockers.push(`release_plan_single_venue_rollout_invalid:${safeError(error)}`);
    }
  }
  if (!rolloutConfigured) blockers.push('release_plan_single_venue_sandbox_configuration_required');
  return Object.freeze({
    status: blockers.length ? 'blocked' : 'ready',
    registryPresent: registry.present,
    singleVenueRolloutPresent: rollout.present,
    rolloutConfigured,
    targetCount: 98,
    verifiedBindingCount: 0,
    sandboxQualifiedCount: 0,
    productionQualifiedCount: 0,
    liveAuthorizationCount: 0,
    externalActionPerformed: false,
    blockers: Object.freeze(blockers),
  });
}

function inspectOperations(workspaceRoot, runtimeRoot) {
  const db = requiredFile(runtimeRoot, 'hepta-paper.sqlite');
  const databaseContract = requiredFile(
    workspaceRoot,
    'paper-core/config/autonomous-research-state-databases.v1.json',
  );
  const wormContract = requiredFile(workspaceRoot, 'paper-core/config/offhost-worm-contract.v1.json');
  const blockers = [];
  if (!db.present) blockers.push('release_plan_runtime_database_missing');
  if (!databaseContract.present) blockers.push('release_plan_database_inventory_contract_missing');
  if (!wormContract.present) blockers.push('release_plan_worm_contract_missing');
  const integrityPath = path.join(runtimeRoot, 'deployment', 'production-integrity-pin.json');
  const integrity = requiredFile(path.dirname(integrityPath), path.basename(integrityPath));
  let integrityVerified = false;
  if (integrity.present) {
    try {
      const value = JSON.parse(fs.readFileSync(integrityPath, 'utf8'));
      const trustedNow = new Date(readTrustedWallClockEpochMs()).toISOString();
      integrityVerified = verifyProductionIntegrityPin(value, { now: trustedNow })
        && value.kind === 'ProductionIntegrityPin'
        && value.status === 'production_integrity_pin_active'
        && value.externalActionPerformed === false;
    } catch (error) {
      blockers.push(`release_plan_integrity_pin_invalid:${safeError(error)}`);
    }
  }
  if (!integrityVerified) blockers.push('release_plan_external_worm_custody_required');
  if (!integrityVerified) blockers.push('release_plan_restore_attestor_required');
  return Object.freeze({
    status: blockers.length ? 'blocked' : 'ready',
    databasePresent: db.present,
    databaseContractPresent: databaseContract.present,
    wormContractPresent: wormContract.present,
    antiRollbackRequired: true,
    integrityPinPresent: integrity.present,
    integrityVerified,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function inspectSupplyChain(workspaceRoot) {
  const sbom = requiredFile(workspaceRoot, 'paper-core/config/source-supply-chain-sbom.cdx.json');
  const policy = requiredFile(workspaceRoot, 'paper-core/config/source-supply-chain-security-policy.v1.json');
  const workflow = requiredFile(workspaceRoot, '.github/workflows/gpu-scientific.yml');
  const blockers = [];
  if (!sbom.present) blockers.push('release_plan_sbom_missing');
  if (!policy.present) blockers.push('release_plan_supply_chain_policy_missing');
  if (!workflow.present) blockers.push('release_plan_oci_verifier_workflow_missing');
  blockers.push('release_plan_oci_independent_verifier_required');
  blockers.push('release_plan_registry_attestation_required');
  return Object.freeze({
    status: blockers.length ? 'blocked' : 'ready',
    sbomPresent: sbom.present,
    policyPresent: policy.present,
    workflowPresent: workflow.present,
    bitwiseRebuildVerified: false,
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function flattenBlockers(sections) {
  return [...new Set(Object.values(sections).flatMap((section) => section.blockers || []))]
    .sort();
}

export function buildReleaseReadinessPlan({
  workspaceRoot = process.cwd(),
  runtimeRoot = null,
  environment = process.env,
  graphInspector = inspectTrackedProductionGraph,
} = {}) {
  const root = path.resolve(workspaceRoot);
  const selectedRuntimeRoot = path.resolve(
    runtimeRoot || environment.HEPTA_PAPER_RUNTIME_ROOT || path.join(root, 'runtime'),
  );
  let graph;
  try {
    graph = graphInspector({ workspaceRoot: root });
  } catch (error) {
    graph = Object.freeze({
      status: 'tracked_production_graph_blocked',
      moduleCount: 0,
      edgeCount: 0,
      productionGraphManifestHash: null,
      untrackedModules: [],
      indexMismatchedModules: [],
      blockers: [`release_plan_graph_inspection_failed:${safeError(error)}`],
    });
  }
  const sections = Object.freeze({
    freeze: inspectFreeze(root, graph, environment),
    externalMaterials: inspectExternalMaterials(root),
    formal: inspectFormal(root, environment, selectedRuntimeRoot),
    authorities: inspectAuthorities(selectedRuntimeRoot),
    compute: inspectCompute(root, selectedRuntimeRoot, environment),
    submission: inspectSubmission(root),
    operations: inspectOperations(root, selectedRuntimeRoot),
    supplyChain: inspectSupplyChain(root),
  });
  const blockers = flattenBlockers(sections);
  const payload = {
    version: 1,
    kind: 'ReleaseReadinessPlan',
    status: blockers.length ? 'release_readiness_blocked' : 'release_readiness_ready',
    productionPromotionEligible: false,
    workspaceRoot: root,
    runtimeRoot: selectedRuntimeRoot,
    releaseCommit: sections.freeze.head,
    releaseCommitTree: sections.freeze.commitTree,
    productionGraphManifestHash: sections.freeze.graph.productionGraphManifestHash,
    sections,
    blockers,
    externalActionsPerformed: false,
  };
  return Object.freeze({
    ...payload,
    releaseReadinessPlanHash: sha256(Buffer.from(JSON.stringify(payload), 'utf8')),
  });
}

export function verifyReleaseReadinessPlan(value) {
  if (!value || value.kind !== 'ReleaseReadinessPlan'
    || value.version !== 1 || !Array.isArray(value.blockers)
    || value.externalActionsPerformed !== false
    || value.productionPromotionEligible !== false
    || !SHA256.test(String(value.releaseReadinessPlanHash || ''))) return false;
  const { releaseReadinessPlanHash, ...payload } = value;
  return sha256(Buffer.from(JSON.stringify(payload), 'utf8')) === releaseReadinessPlanHash;
}
