import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = path.join(
  root,
  '.github/workflows/provider-external-acceptance.yml',
);
const workflow = fs.readFileSync(workflowPath, 'utf8');

test('provider external acceptance is dispatch-only and least-privilege', () => {
  assert.match(workflow, /^on:\s*\n  workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule|workflow_run):/mu);
  assert.match(workflow, /^permissions:\s*\n  contents: read\s*$/mu);
  assert.doesNotMatch(
    workflow,
    /^  (actions|checks|contents|deployments|id-token|packages|pull-requests|statuses): write$/mu,
  );
  for (const input of [
    'candidate_sha',
    'candidate_tree',
    'pull_request',
    'base_sha',
    'prospective_merge_sha',
    'source_manifest_path',
    'target_profile_path',
  ]) assert.match(workflow, new RegExp(`^      ${input}:$`, 'mu'), input);
});

test('provider acceptance executes only on the qualified self-hosted class', () => {
  for (const label of ['self-hosted', 'linux', 'x64', 'hepta-provider-sandbox']) {
    assert.match(workflow, new RegExp(`^      - ${label}$`, 'mu'), label);
  }
  assert.match(workflow, /timeout-minutes: 60/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /\/etc\/hepta-provider\/\*/u);
  assert.match(workflow, /provider_external_protected_path_invalid/u);
});

test('provider acceptance actions and executable paths are immutable', () => {
  assert.match(
    workflow,
    /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5/u,
  );
  assert.match(
    workflow,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u,
  );
  assert.match(
    workflow,
    /bash docs\/provider-sandbox\/tools\/run-external-provider-acceptance\.sh/u,
  );
  assert.match(workflow, /git rev-parse HEAD\^\{tree\}/u);
  assert.match(workflow, /git diff --cached --exit-code/u);
  assert.match(workflow, /production_authorized=false/u);
  assert.match(workflow, /external_authority_claimed=false/u);
});

test('provider acceptance evidence is retained without publication authority', () => {
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 90/u);
  assert.match(workflow, /compression-level: 0/u);
  assert.match(workflow, /overwrite: false/u);
  assert.doesNotMatch(workflow, /release|deployment|pages|npm publish|docker push/iu);
});
