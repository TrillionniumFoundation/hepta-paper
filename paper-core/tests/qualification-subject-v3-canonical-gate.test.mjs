import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('canonical effective source workflow derives Qualification Subject V3', () => {
  const workflow = read('.github/workflows/rust-effective-source-qualification.yml');
  assert.match(workflow, /^  pull_request:\s*$/mu);
  assert.match(workflow, /refs\/pull\/\$EXPECTED_PR_NUMBER\/merge/u);
  assert.match(workflow, /EXPECTED_BASE_SHA/u);
  assert.match(workflow, /EXPECTED_MERGE_SHA/u);
  assert.match(workflow, /run-qualification-subject-v3\.sh/u);
  assert.match(workflow, /rust-effective-source-/u);
});

test('shared runner preserves legacy capability derivation beneath V3', () => {
  const runner = read('docs/rust/tools/run-qualification-subject-v3.sh');
  assert.match(runner, /derive-effective-status\.py/u);
  assert.match(runner, /effective-status\.v1\.json/u);
  assert.match(runner, /qualification_subject_v3\.py/u);
  assert.match(runner, /effective-status\.v2\.json/u);
  assert.match(runner, /verify_effective_status_v2_current\.py/u);
});
