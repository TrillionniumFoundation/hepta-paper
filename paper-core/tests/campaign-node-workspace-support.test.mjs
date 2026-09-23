import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { materializeAutomationArtifacts } from '../../paper-adapters/automation/campaign-node-workspace-support.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-campaign-artifact-support-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDirectory = path.join(root, 'output');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(outputDirectory);
  fs.mkdirSync(workspace);
  return { root, outputDirectory, workspace };
}

test('campaign artifact support materializes a scoped regular artifact with the compatible receipt', (t) => {
  const { outputDirectory, workspace } = fixture(t);
  fs.mkdirSync(path.join(outputDirectory, 'nested'));
  fs.writeFileSync(path.join(outputDirectory, 'nested', 'result.json'), '{"score":1}\n');
  const receipt = materializeAutomationArtifacts({
    result: { multiLanguageEmpiricalReceiptHash: 'sha256:execution', artifacts: [{ path: 'nested/result.json' }] },
    outputDirectory,
    workspace,
    nodeId: 'node/unsafe-id',
  });
  assert.deepEqual(receipt.materializedPaths, ['automation-results/node_unsafe-id/nested/result.json']);
  assert.equal(receipt.sourceExecutionReceiptHash, 'sha256:execution');
  assert.equal(receipt.status, 'automation_artifacts_materialized');
  assert.equal(fs.readFileSync(path.join(workspace, receipt.materializedPaths[0]), 'utf8'), '{"score":1}\n');
});

test('campaign artifact support rejects traversal and never copies an external source', (t) => {
  const { root, outputDirectory, workspace } = fixture(t);
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'outside\n');
  assert.throws(
    () => materializeAutomationArtifacts({
      result: { artifacts: [{ path: '../outside.txt' }] },
      outputDirectory,
      workspace,
      nodeId: 'node',
    }),
    /scoped_materialization_path_invalid/,
  );
  assert.equal(fs.existsSync(path.join(workspace, 'automation-results', 'outside.txt')), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n');
});

test('campaign artifact support rejects a symlink source and a symlink destination parent', (t) => {
  const { root, outputDirectory, workspace } = fixture(t);
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'outside\n');
  fs.symlinkSync(outside, path.join(outputDirectory, 'linked.txt'));
  assert.throws(
    () => materializeAutomationArtifacts({
      result: { artifacts: [{ path: 'linked.txt' }] },
      outputDirectory,
      workspace,
      nodeId: 'node',
    }),
    /scoped_materialization_(?:source|destination)_unsafe/,
  );

  fs.writeFileSync(path.join(outputDirectory, 'safe.txt'), 'safe\n');
  const outsideDirectory = path.join(root, 'outside-directory');
  fs.mkdirSync(outsideDirectory);
  fs.mkdirSync(path.join(workspace, 'automation-results'));
  fs.symlinkSync(outsideDirectory, path.join(workspace, 'automation-results', 'node'));
  assert.throws(
    () => materializeAutomationArtifacts({
      result: { artifacts: [{ path: 'safe.txt' }] },
      outputDirectory,
      workspace,
      nodeId: 'node',
    }),
    /scoped_materialization_destination_(?:unsafe|parent_unsafe)/,
  );
  assert.equal(fs.existsSync(path.join(outsideDirectory, 'safe.txt')), false);
});
