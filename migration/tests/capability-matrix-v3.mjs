import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CAPABILITY_DECISIONS,
  LEGACY_CAPABILITY_MATRIX_V3,
} from '../legacy-capability-matrix-v3.mjs';

const matrix = LEGACY_CAPABILITY_MATRIX_V3;
const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(matrix.version, 3);
assert.equal(matrix.entries.length, 249);
assert.equal(new Set(matrix.entries.map((entry) => entry.legacyMatrixEntryId)).size, 249);
assert.deepEqual(matrix.summary.byDecision, {
  [CAPABILITY_DECISIONS.PERMANENT_RETIREMENT]: 88,
  [CAPABILITY_DECISIONS.SUPERSEDED_WITH_COVERAGE]: 40,
  [CAPABILITY_DECISIONS.CAPABILITY_REIMPLEMENTATION]: 121,
});
assert.equal(matrix.summary.uniqueCapabilityCount, 14);
assert.equal(matrix.summary.ownerAcceptancePending, 249);
assert.equal(matrix.summary.decisionMapped, 249);
assert.equal(matrix.summary.contractsDefined, 249);
assert.equal(matrix.summary.implementationVerified, 161);
assert.equal(matrix.summary.implementationNotApplicable, 88);
assert.equal(matrix.summary.ownerAccepted, 0);
for (const entry of matrix.entries) {
  assert.ok(entry.source.path);
  assert.ok(entry.source.sha256);
  assert.ok(entry.source.symbols.length > 0);
  assert.equal(Object.hasOwn(entry, 'coverageStatus'), false);
  assert.equal(entry.decision_mapped.satisfied, true);
  assert.equal(entry.contract_defined.satisfied, true);
  assert.equal(entry.owner_accepted.status, 'pending_owner_acceptance');
  assert.ok(entry.coverageTests.length > 0, entry.source.path);
  for (const coverageTest of entry.coverageTests) {
    assert.equal(coverageTest.sha256, sha256File(path.join(workspaceRoot, coverageTest.path)));
  }
  if (entry.businessDecision === CAPABILITY_DECISIONS.PERMANENT_RETIREMENT) {
    assert.deepEqual(entry.capabilityIds, []);
  } else {
    assert.ok(entry.capabilityIds.length > 0, entry.source.path);
    assert.equal(entry.implementation_verified.satisfied, true);
    assert.ok(entry.coverageTests.some((test) => test.coverageClass.startsWith('capability_specific_')));
    for (const capabilityId of entry.capabilityIds) {
      assert.ok(entry.coverageTests.some((test) => test.capabilityId === capabilityId), `${entry.source.path}:${capabilityId}`);
    }
    for (const target of entry.capabilityTargets) {
      assert.ok(target.sha256, target.target);
      assert.equal(target.sha256, sha256File(path.join(workspaceRoot, target.target)));
    }
  }
  if (entry.businessDecision === CAPABILITY_DECISIONS.SUPERSEDED_WITH_COVERAGE) {
    assert.ok(entry.coverageTests.some((test) => test.coverageClass === 'capability_specific_gap_or_differential'));
    assert.ok(entry.coverageTests.some((test) => test.coverageClass === 'legacy_disposition_or_differential'));
  }
}

process.stdout.write(JSON.stringify({
  ok: true,
  kind: 'LegacyCapabilityMigrationMatrixV3Test',
  ...matrix.summary,
}) + '\n');
