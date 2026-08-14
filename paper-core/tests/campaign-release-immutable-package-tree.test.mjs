import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertImmutableCampaignPackageFilesSync,
  sealImmutableCampaignPackageDirectoriesSync,
} from '../../paper-adapters/automation/campaign-release-materialization.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

function restoreOwnerWriteSync(root) {
  if (!fs.existsSync(root)) return;
  const visit = (directory) => {
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  };
  visit(root);
}

function fixture(t) {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hepta-release-exact-tree-'),
  );
  t.after(() => {
    restoreOwnerWriteSync(runtimeRoot);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });
  const packageDir = path.join(runtimeRoot, 'packages', 'attempt');
  const evidenceDir = path.join(packageDir, 'evidence', 'gpu-scientific');
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const candidate = path.join(evidenceDir, 'model-spec.json');
  const content = Buffer.from('{"version":1}\n', 'utf8');
  fs.writeFileSync(candidate, content, { mode: 0o400 });
  const packageOutput = {
    releaseRoot: path.join(runtimeRoot, 'campaign-releases', 'attempt'),
    packageDir,
    files: [{
      role: 'research_evidence_capsule_file',
      path: candidate,
      hash: hashBytes(content),
      bytes: content.length,
    }],
  };
  fs.mkdirSync(packageOutput.releaseRoot, { recursive: true, mode: 0o700 });
  return { runtimeRoot, packageDir, evidenceDir, candidate, packageOutput };
}

test('immutable campaign package requires an exact physical tree', (t) => {
  const value = fixture(t);
  assert.doesNotThrow(() => assertImmutableCampaignPackageFilesSync(
    value.packageOutput,
    value.runtimeRoot,
  ));
  fs.writeFileSync(path.join(value.evidenceDir, 'UNBOUND.bin'), 'unbound');
  assert.throws(() => assertImmutableCampaignPackageFilesSync(
    value.packageOutput,
    value.runtimeRoot,
  ), /campaign_release_package_output_exact_tree_invalid/);
});

test('immutable campaign package rejects symlink, hardlink, and directory substitutions', (t) => {
  const symlink = fixture(t);
  fs.unlinkSync(symlink.candidate);
  fs.symlinkSync('/dev/null', symlink.candidate);
  assert.throws(() => assertImmutableCampaignPackageFilesSync(
    symlink.packageOutput,
    symlink.runtimeRoot,
  ), /campaign_release_package_output_(?:file_invalid|entry_unsafe)/);

  const hardlink = fixture(t);
  fs.linkSync(hardlink.candidate, path.join(hardlink.evidenceDir, 'alias.json'));
  assert.throws(() => assertImmutableCampaignPackageFilesSync(
    hardlink.packageOutput,
    hardlink.runtimeRoot,
  ), /campaign_release_package_output_(?:file_invalid|entry_unsafe)/);

  const directory = fixture(t);
  fs.unlinkSync(directory.candidate);
  fs.mkdirSync(directory.candidate);
  assert.throws(() => assertImmutableCampaignPackageFilesSync(
    directory.packageOutput,
    directory.runtimeRoot,
  ), /campaign_release_package_output_(?:file_invalid|exact_tree_invalid)/);
});

test('immutable campaign package sealing removes directory write permissions', (t) => {
  const value = fixture(t);
  assert.doesNotThrow(() => sealImmutableCampaignPackageDirectoriesSync(
    value.packageOutput,
    value.runtimeRoot,
  ));
  for (const directory of [
    value.packageDir,
    path.join(value.packageDir, 'evidence'),
    value.evidenceDir,
  ]) {
    assert.equal(fs.lstatSync(directory).mode & 0o222, 0);
  }
  assert.doesNotThrow(() => assertImmutableCampaignPackageFilesSync(
    value.packageOutput,
    value.runtimeRoot,
  ));
});
