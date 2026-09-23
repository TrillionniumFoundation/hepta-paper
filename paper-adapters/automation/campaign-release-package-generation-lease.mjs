import path from 'node:path';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  acquireCampaignReleasePackageGenerationLockHandleSync,
  campaignReleasePackageTransactionError,
} from './campaign-release-package-transaction-repository.mjs';
import {
  acquireCampaignReleasePackageGenerationLeaseWithWait,
} from './campaign-release-package-generation-lease-wait.mjs';
import {
  campaignReleaseGenerationLeaseWaitBudgetMs,
} from './campaign-release-package-generation-budget.mjs';

export { campaignReleaseGenerationLeaseWaitBudgetMs };

const ACTIVE_LEASES = new WeakMap();

function normalizeLeaseScope({ runtimeRoot, releaseRoot } = {}) {
  const root = path.resolve(runtimeRoot || '.');
  const release = path.resolve(releaseRoot || '.');
  const nodeRoot = path.dirname(release);
  if (!isPathWithin(root, nodeRoot)) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_generation_lock_invalid',
    );
  }
  return Object.freeze({ root, release, nodeRoot });
}

function requireActiveLease(lease, scope) {
  const state = ACTIVE_LEASES.get(lease);
  if (!state || state.released) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_generation_lease_invalid',
    );
  }
  if (state.root !== scope.root || state.release !== scope.release
    || state.nodeRoot !== scope.nodeRoot) {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_generation_lease_scope_mismatch',
    );
  }
  return state;
}

export function assertCampaignReleasePackageGenerationLeaseHeldSync({
  lease,
  runtimeRoot,
  releaseRoot,
} = {}) {
  const scope = normalizeLeaseScope({ runtimeRoot, releaseRoot });
  const state = requireActiveLease(lease, scope);
  state.handle.assertHeld();
  return lease;
}

export function releaseCampaignReleasePackageGenerationLeaseSync(lease) {
  const state = ACTIVE_LEASES.get(lease);
  if (!state || state.released) return false;
  state.released = true;
  state.handle.release();
  return true;
}

export function acquireCampaignReleasePackageGenerationLeaseSync({
  runtimeRoot,
  releaseRoot,
  lockProbeTimeoutMs,
} = {}) {
  const scope = normalizeLeaseScope({ runtimeRoot, releaseRoot });
  const handle = acquireCampaignReleasePackageGenerationLockHandleSync({
    runtimeRoot: scope.root,
    releaseRoot: scope.release,
    lockProbeTimeoutMs,
  });
  let lease;
  try {
    lease = Object.freeze({
      version: 1,
      kind: 'CampaignReleasePackageGenerationLease',
      assertHeld: () => assertCampaignReleasePackageGenerationLeaseHeldSync({
        lease, runtimeRoot: scope.root, releaseRoot: scope.release,
      }),
      release: () => releaseCampaignReleasePackageGenerationLeaseSync(lease),
    });
    ACTIVE_LEASES.set(lease, {
      ...scope,
      handle,
      released: false,
    });
    lease.assertHeld();
    return lease;
  } catch (error) {
    if (lease) releaseCampaignReleasePackageGenerationLeaseSync(lease);
    else handle.release();
    throw error;
  }
}

export function withHeldCampaignReleasePackageGenerationLeaseSync({
  lease,
  runtimeRoot,
  releaseRoot,
} = {}, operation) {
  if (typeof operation !== 'function') {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_generation_lock_operation_required',
    );
  }
  assertCampaignReleasePackageGenerationLeaseHeldSync({
    lease, runtimeRoot, releaseRoot,
  });
  const value = operation(Object.freeze({ assertHeld: lease.assertHeld }));
  if (value && typeof value.then === 'function') {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_generation_lease_async_operation_forbidden',
    );
  }
  assertCampaignReleasePackageGenerationLeaseHeldSync({
    lease, runtimeRoot, releaseRoot,
  });
  return value;
}

export async function withCampaignReleasePackageGenerationLease({
  runtimeRoot,
  releaseRoot,
  signal = null,
  executionBudget = null,
  clock = null,
  maximumWaitMs,
  initialRetryDelayMs,
  maximumRetryDelayMs,
} = {}, operation) {
  if (typeof operation !== 'function') {
    throw campaignReleasePackageTransactionError(
      'campaign_release_package_generation_lock_operation_required',
    );
  }
  const lease = await acquireCampaignReleasePackageGenerationLeaseWithWait({
    acquire: (lockProbeTimeoutMs) => acquireCampaignReleasePackageGenerationLeaseSync({
      runtimeRoot, releaseRoot,
      lockProbeTimeoutMs,
    }),
    signal,
    maximumWaitMs: campaignReleaseGenerationLeaseWaitBudgetMs(
      executionBudget,
      clock,
      maximumWaitMs,
    ),
    initialRetryDelayMs,
    maximumRetryDelayMs,
  });
  try {
    campaignReleaseGenerationLeaseWaitBudgetMs(executionBudget, clock);
    lease.assertHeld();
    const value = await operation(lease);
    lease.assertHeld();
    return value;
  } finally {
    lease.release();
  }
}
