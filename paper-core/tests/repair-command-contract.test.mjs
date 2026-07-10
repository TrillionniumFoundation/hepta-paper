import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSafeApplyPlanContract, parseSafeApplyPlanContract } from '../../paper-domain/repair/command-contract.mjs';

test('repair safe-apply contract is native, plan-only and rejects shell strings', () => {
  const contract = buildSafeApplyPlanContract(42);
  assert.equal(contract, 'hepta-paper://repair.safe-apply/v1?patch_id=42');
  assert.deepEqual(parseSafeApplyPlanContract(contract), {
    version: 1,
    kind: 'RepairSafeApplyPlanContract',
    patchId: 42,
    executeAuthority: false,
  });
  assert.equal(parseSafeApplyPlanContract('./bin/paperctl merge-queue --patch-id 42 --json'), null);
  assert.equal(parseSafeApplyPlanContract('hepta-paper://repair.safe-apply/v1?patch_id=42;rm'), null);
});
