import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  withSystemBenchmarkWallClockForTest,
} from './support/raw-event-recomputation-sandbox-test-seam.mjs';

const {
  finalizeSystemBenchmarkReceiptBeforeDeadline,
  writeSystemBenchmarkResults,
} = await import('../../paper-adapters/automation/system-benchmark-result-repository.mjs');

function resultPersistenceInput(outputDirectory, absoluteDeadlineEpochMs = 100) {
  return {
    outputDirectory,
    absoluteDeadlineEpochMs,
    resultDocument: { version: 1, kind: 'FixtureResult', value: 1 },
    csvDocument: 'value\n1\n',
    rawEventDocument: '{"value":1}\n',
  };
}

function resultReceiptPayload(persisted, absoluteDeadlineEpochMs = 100) {
  return {
    version: 5,
    kind: 'SystemBenchmarkHarnessExecutionReceipt',
    status: 'system_benchmark_harness_verified',
    integrityStatus: 'system_benchmark_integrity_verified',
    scientificVerdict: 'positive',
    scientificFindings: [],
    absoluteDeadlineEpochMs,
    resultPersistenceCompletedAtEpochMs: persisted.resultPersistenceCompletedAtEpochMs,
    resultDocument: { version: 1, kind: 'FixtureResult', value: 1 },
    csvDocument: 'value\n1\n',
    resultJsonHash: persisted.resultJsonHash,
    resultCsvHash: persisted.resultCsvHash,
    artifacts: persisted.artifacts,
    blockers: [],
  };
}

test('result repository stages, no-clobbers, and exact-rolls back deadline-bound publications', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-result-repository-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 0;
  const persisted = withSystemBenchmarkWallClockForTest(
    () => now,
    () => writeSystemBenchmarkResults(resultPersistenceInput(root)),
  );
  assert.equal(persisted.status, 'system_benchmark_results_persisted');
  assert.equal(persisted.resultPersistenceCompletedAtEpochMs, 0);
  for (const name of ['results.json', 'results.csv', 'raw-events.ndjson']) {
    const stat = fs.lstatSync(path.join(root, name));
    assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, name);
    assert.equal(stat.nlink, 1, name);
  }
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.startsWith('.hepta-')), []);
  now = 10;
  const receipt = withSystemBenchmarkWallClockForTest(
    () => now,
    () => finalizeSystemBenchmarkReceiptBeforeDeadline({
      payload: resultReceiptPayload(persisted),
      outputDirectory: root,
      rollbackAuthority: persisted.rollbackAuthority,
    }),
  );
  assert.equal(receipt.status, 'system_benchmark_harness_verified');
  assert.equal(receipt.receiptFinalizedAtEpochMs, 10);
  assert.match(receipt.systemBenchmarkHarnessExecutionReceiptHash, /^sha256:[0-9a-f]{64}$/);

  const lateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-result-repository-late-'));
  t.after(() => fs.rmSync(lateRoot, { recursive: true, force: true }));
  now = 0;
  const latePersistence = withSystemBenchmarkWallClockForTest(
    () => now,
    () => writeSystemBenchmarkResults(resultPersistenceInput(lateRoot)),
  );
  now = 100;
  const blocked = withSystemBenchmarkWallClockForTest(
    () => now,
    () => finalizeSystemBenchmarkReceiptBeforeDeadline({
      payload: resultReceiptPayload(latePersistence),
      outputDirectory: lateRoot,
      rollbackAuthority: latePersistence.rollbackAuthority,
    }),
  );
  assert.equal(blocked.status, 'system_benchmark_harness_blocked');
  assert.equal(blocked.resultDocument, null);
  assert.deepEqual(blocked.artifacts, []);
  assert.ok(blocked.blockers.includes('benchmark_harness_absolute_deadline_exhausted'));
  assert.deepEqual(fs.readdirSync(lateRoot), []);
});

test('result repository removes staging and preserves colliding or replaced entries', (t) => {
  const stagedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-result-stage-expiry-'));
  t.after(() => fs.rmSync(stagedRoot, { recursive: true, force: true }));
  let reads = 0;
  const expired = withSystemBenchmarkWallClockForTest(
    () => (reads++ === 0 ? 0 : 100),
    () => writeSystemBenchmarkResults(resultPersistenceInput(stagedRoot)),
  );
  assert.equal(expired.status, 'system_benchmark_results_blocked');
  assert.deepEqual(fs.readdirSync(stagedRoot), []);

  const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-result-symlink-'));
  t.after(() => fs.rmSync(symlinkRoot, { recursive: true, force: true }));
  const dangling = path.join(symlinkRoot, 'missing-target');
  fs.symlinkSync(dangling, path.join(symlinkRoot, 'results.json'));
  const occupied = withSystemBenchmarkWallClockForTest(
    () => 0,
    () => writeSystemBenchmarkResults(resultPersistenceInput(symlinkRoot)),
  );
  assert.ok(occupied.blockers.includes('benchmark_result_artifact_already_exists:results.json'));
  assert.equal(fs.readlinkSync(path.join(symlinkRoot, 'results.json')), dangling);

  const collisionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-result-collision-'));
  t.after(() => fs.rmSync(collisionRoot, { recursive: true, force: true }));
  reads = 0;
  const collision = withSystemBenchmarkWallClockForTest(
    () => {
      reads += 1;
      if (reads === 2) fs.writeFileSync(path.join(collisionRoot, 'results.csv'), 'contender\n');
      return 0;
    },
    () => writeSystemBenchmarkResults(resultPersistenceInput(collisionRoot)),
  );
  assert.ok(collision.blockers.includes('benchmark_result_artifact_publish_collision'));
  assert.equal(fs.existsSync(path.join(collisionRoot, 'results.json')), false);
  assert.equal(fs.readFileSync(path.join(collisionRoot, 'results.csv'), 'utf8'), 'contender\n');

  const replacementRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-result-replacement-'));
  t.after(() => fs.rmSync(replacementRoot, { recursive: true, force: true }));
  const replacementPersistence = withSystemBenchmarkWallClockForTest(
    () => 0,
    () => writeSystemBenchmarkResults(resultPersistenceInput(replacementRoot)),
  );
  fs.unlinkSync(path.join(replacementRoot, 'results.json'));
  fs.writeFileSync(path.join(replacementRoot, 'results.json'), 'replacement\n');
  const replacedReceipt = withSystemBenchmarkWallClockForTest(
    () => 10,
    () => finalizeSystemBenchmarkReceiptBeforeDeadline({
      payload: resultReceiptPayload(replacementPersistence),
      outputDirectory: replacementRoot,
      rollbackAuthority: replacementPersistence.rollbackAuthority,
    }),
  );
  assert.equal(replacedReceipt.status, 'system_benchmark_harness_blocked');
  assert.ok(replacedReceipt.blockers.includes('benchmark_result_finalization_identity_mismatch'));
  assert.equal(fs.readFileSync(path.join(replacementRoot, 'results.json'), 'utf8'), 'replacement\n');
  assert.equal(fs.existsSync(path.join(replacementRoot, 'results.csv')), false);
  assert.equal(fs.existsSync(path.join(replacementRoot, 'raw-events.ndjson')), false);

  const hardlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-result-hardlink-'));
  t.after(() => fs.rmSync(hardlinkRoot, { recursive: true, force: true }));
  const hardlinkPersistence = withSystemBenchmarkWallClockForTest(
    () => 0,
    () => writeSystemBenchmarkResults(resultPersistenceInput(hardlinkRoot)),
  );
  const linkedCopy = path.join(path.dirname(hardlinkRoot), `${path.basename(hardlinkRoot)}-copy`);
  t.after(() => fs.rmSync(linkedCopy, { force: true }));
  fs.linkSync(path.join(hardlinkRoot, 'results.json'), linkedCopy);
  const hardlinkReceipt = withSystemBenchmarkWallClockForTest(
    () => 10,
    () => finalizeSystemBenchmarkReceiptBeforeDeadline({
      payload: resultReceiptPayload(hardlinkPersistence),
      outputDirectory: hardlinkRoot,
      rollbackAuthority: hardlinkPersistence.rollbackAuthority,
    }),
  );
  assert.equal(hardlinkReceipt.status, 'system_benchmark_harness_blocked');
  assert.ok(hardlinkReceipt.blockers.includes('benchmark_result_finalization_identity_mismatch'));
  assert.equal(fs.existsSync(path.join(hardlinkRoot, 'results.json')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(linkedCopy, 'utf8')), {
    version: 1, kind: 'FixtureResult', value: 1,
  });

  const finalizationRaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-result-finalization-race-'));
  t.after(() => fs.rmSync(finalizationRaceRoot, { recursive: true, force: true }));
  const finalizationRacePersistence = withSystemBenchmarkWallClockForTest(
    () => 0,
    () => writeSystemBenchmarkResults(resultPersistenceInput(finalizationRaceRoot)),
  );
  const linkedDuringFinalization = path.join(
    path.dirname(finalizationRaceRoot), `${path.basename(finalizationRaceRoot)}-copy`,
  );
  t.after(() => fs.rmSync(linkedDuringFinalization, { force: true }));
  reads = 0;
  const finalizationRaceReceipt = withSystemBenchmarkWallClockForTest(
    () => {
      reads += 1;
      if (reads === 1) fs.linkSync(
        path.join(finalizationRaceRoot, 'results.json'), linkedDuringFinalization,
      );
      return 10;
    },
    () => finalizeSystemBenchmarkReceiptBeforeDeadline({
      payload: resultReceiptPayload(finalizationRacePersistence),
      outputDirectory: finalizationRaceRoot,
      rollbackAuthority: finalizationRacePersistence.rollbackAuthority,
    }),
  );
  assert.equal(finalizationRaceReceipt.status, 'system_benchmark_harness_blocked');
  assert.ok(finalizationRaceReceipt.blockers.includes(
    'benchmark_result_finalization_identity_mismatch',
  ));
  assert.deepEqual(fs.readdirSync(finalizationRaceRoot), []);
  assert.equal(fs.lstatSync(linkedDuringFinalization).nlink, 1);

  const unexpectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-result-unexpected-'));
  t.after(() => fs.rmSync(unexpectedRoot, { recursive: true, force: true }));
  reads = 0;
  assert.throws(() => withSystemBenchmarkWallClockForTest(
    () => {
      reads += 1;
      if (reads === 2) {
        const staging = fs.readdirSync(unexpectedRoot).find((name) => (
          name.startsWith('.hepta-system-results-')
        ));
        fs.writeFileSync(path.join(unexpectedRoot, staging, 'unowned.txt'), 'preserve\n');
      }
      return 0;
    },
    () => writeSystemBenchmarkResults(resultPersistenceInput(unexpectedRoot)),
  ), /system_benchmark_result_staging_identity_mismatch/);
  const preservedStaging = fs.readdirSync(unexpectedRoot).find((name) => (
    name.startsWith('.hepta-system-results-')
  ));
  assert.equal(fs.readFileSync(
    path.join(unexpectedRoot, preservedStaging, 'unowned.txt'), 'utf8',
  ), 'preserve\n');
});
