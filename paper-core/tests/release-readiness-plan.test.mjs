import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReleaseReadinessPlan, verifyReleaseReadinessPlan } from '../verification/release-readiness-plan.mjs';

test('release readiness plan is observation-only and reports every external blocker', () => {
  const plan = buildReleaseReadinessPlan({
    workspaceRoot: process.cwd(),
    runtimeRoot: '/tmp/hepta-paper-nonexistent-runtime',
    environment: {},
    graphInspector: () => ({
      status: 'tracked_production_graph_ready',
      moduleCount: 2,
      edgeCount: 1,
      productionGraphManifestHash: 'sha256:' + 'a'.repeat(64),
      untrackedModules: [],
      indexMismatchedModules: [],
      blockers: [],
    }),
  });
  assert.equal(plan.kind, 'ReleaseReadinessPlan');
  assert.equal(plan.externalActionsPerformed, false);
  assert.equal(plan.productionPromotionEligible, false);
  assert.equal(plan.status, 'release_readiness_blocked');
  assert.ok(plan.blockers.includes('formal_release_plan_elan_home_absolute_required'));
  assert.ok(plan.blockers.includes('release_plan_independent_owner_acceptance_required'));
  assert.ok(plan.blockers.includes('release_plan_nvidia_ci_not_provisioned'));
  assert.ok(plan.blockers.includes('release_plan_external_worm_custody_required'));
  assert.equal(verifyReleaseReadinessPlan(plan), true);
});
test('release readiness plan hash detects mutation', () => {
  const plan = buildReleaseReadinessPlan({
    workspaceRoot: process.cwd(),
    runtimeRoot: '/tmp/hepta-paper-nonexistent-runtime',
    environment: {},
    graphInspector: () => ({
      status: 'tracked_production_graph_ready',
      moduleCount: 0,
      edgeCount: 0,
      productionGraphManifestHash: null,
      untrackedModules: [],
      indexMismatchedModules: [],
      blockers: [],
    }),
  });
  assert.equal(verifyReleaseReadinessPlan({ ...plan, status: 'release_readiness_ready' }), false);
});
