import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('Qualification Subject V3 hostile state machine executes', () => {
  const result = spawnSync(
    'python3',
    ['docs/rust/tools/test_qualification_subject_v3.py'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran 12 tests/u);
  assert.match(result.stderr, /OK/u);
});

test('V3 subject and effective schemas are closed and nonactivating', () => {
  const subject = JSON.parse(read(
    'docs/qualification/schemas/qualification-subject-runtime-v3.schema.json',
  ));
  assert.equal(subject.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(subject.type, 'object');
  assert.equal(subject.additionalProperties, false);
  for (const field of [
    'repository',
    'pullRequest',
    'definitionSetHash',
    'eligibleRunSetSha256',
    'producerHistoryWatermark',
    'selectedRunSetSha256',
    'artifactSetHash',
    'requiredCheckSnapshotIdentity',
    'producerHistories',
    'authority',
    'snapshotIdentity',
  ]) assert.ok(subject.required.includes(field), field);

  const effective = JSON.parse(read(
    'docs/rust/qualification/effective-status-runtime-v2-standalone.schema.json',
  ));
  assert.equal(effective.type, 'object');
  assert.equal(effective.additionalProperties, false);
  assert.deepEqual(
    effective.properties.status,
    { const: 'source_qualified_nonactivating' },
  );
  for (const property of Object.values(effective.$defs.authority.properties)) {
    assert.deepEqual(property, { const: false });
  }
});

test('V3 collection binds exact base merge and complete run attempts', () => {
  const collector = read('docs/rust/tools/qualification_subject_v3.py');
  for (const token of [
    'base.get("sha")',
    'merge_commit_sha',
    'parents != [base_commit, args.head_commit]',
    'range(1, current_attempt + 1)',
    'noncanonical_run_mutated_after_canonical',
    'eligibleRunSetSha256',
    'artifactSetHash',
    'requiredCheckSnapshotIdentity',
    'snapshotIdentity',
  ]) assert.ok(collector.includes(token), token);
});

test('V3 derivation and revalidation are permanently wired', () => {
  const deriveWorkflow = read(
    '.github/workflows/rust-qualification-subject-v3.yml',
  );
  const revalidationWorkflow = read(
    '.github/workflows/rust-qualification-subject-v3-revalidation.yml',
  );
  assert.match(deriveWorkflow, /^  pull_request:\s*$/mu);
  assert.match(deriveWorkflow, /qualification_subject_v3\.py/u);
  assert.match(deriveWorkflow, /derive_effective_status_v2\.py/u);
  assert.match(deriveWorkflow, /verify_effective_status_v2_current\.py/u);
  assert.match(deriveWorkflow, /refs\/pull\/\$EXPECTED_PR_NUMBER\/merge/u);
  assert.match(revalidationWorkflow, /^  workflow_run:/mu);
  assert.match(revalidationWorkflow, /rust-qualification-subject-v3/u);
  assert.match(revalidationWorkflow, /current-qualification-subject\.v3\.json/u);
  assert.match(revalidationWorkflow, /source-qualification-v3-current/u);
});
