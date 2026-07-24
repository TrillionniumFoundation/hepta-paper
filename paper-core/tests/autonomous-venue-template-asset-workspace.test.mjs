import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildAutonomousVenueTemplateAssetRecord,
} from '../../paper-domain/automation/autonomous-venue-template-asset-contract.mjs';
import {
  createAutonomousResearchWorkspaceRepository,
} from '../../paper-adapters/automation/autonomous-research-workspace-repository.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

function record(content, relativePath = 'venue-assets/registered-template.tex') {
  const bytes = Buffer.from(content, 'utf8');
  return buildAutonomousVenueTemplateAssetRecord({
    venueId: 'registered-venue',
    relativePath,
    applicationMode: 'latex-preamble-input-v1',
    bytesBase64: bytes.toString('base64'),
    sizeBytes: bytes.length,
    templateAssetHash: hashBytes(bytes),
  });
}

test('workspace repository materializes only exact verified venue template bytes', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-venue-asset-workspace-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchWorkspaceRepository({
    runtimeRoot,
    paperId: 'venue-asset-paper',
  });
  const asset = record('\\usepackage{microtype}\n');
  assert.equal(
    repository.writeVenueTemplateAssetOnce(asset),
    asset.templateAssetHash,
  );
  assert.equal(
    fs.readFileSync(path.join(repository.sourceWorkspace, asset.relativePath), 'utf8'),
    '\\usepackage{microtype}\n',
  );
  assert.equal(
    repository.writeVenueTemplateAssetOnce(asset),
    asset.templateAssetHash,
  );
  assert.throws(
    () => repository.writeVenueTemplateAssetOnce(record(
      '\\usepackage{booktabs}\n',
      asset.relativePath,
    )),
    /autonomous_research_workspace_venue_template_conflict/,
  );
});

test('workspace venue template materialization rejects a symlinked asset directory', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-venue-asset-symlink-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchWorkspaceRepository({
    runtimeRoot,
    paperId: 'venue-asset-symlink-paper',
  });
  const outside = path.join(runtimeRoot, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.symlinkSync(outside, path.join(repository.sourceWorkspace, 'venue-assets'));
  assert.throws(
    () => repository.writeVenueTemplateAssetOnce(record('\\usepackage{microtype}\n')),
    /autonomous_research_workspace_venue_template_path_unsafe/,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});
