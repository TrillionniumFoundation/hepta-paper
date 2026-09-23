import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  EXTERNAL_INTAKE_OUTPUT_SPECS,
  finalizeExternalIntakeDocuments,
  withCleanExternalIntakeCodeProvenance,
} from '../../paper-composition/bootstrap/external-intake-generation-policy.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const workspaceRoot = path.resolve(import.meta.dirname, '../..');
const entrypoint = path.join(workspaceRoot, 'paper-core/bin/generate-external-intake.mjs');

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function createCleanRepository(temporaryRoot) {
  const repositoryRoot = path.join(temporaryRoot, 'repository');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  fs.writeFileSync(path.join(repositoryRoot, 'package.json'), JSON.stringify({
    name: 'external-intake-provenance-fixture',
    version: '1.2.3',
  }));
  fs.writeFileSync(path.join(repositoryRoot, 'tracked.txt'), 'tracked\n');
  runGit(repositoryRoot, ['init', '--quiet']);
  runGit(repositoryRoot, ['add', 'package.json', 'tracked.txt']);
  runGit(repositoryRoot, [
    '-c', 'user.name=External Intake Test',
    '-c', 'user.email=external-intake@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ]);
  return repositoryRoot;
}

test('external intake help is side-effect free', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-external-intake-help-'));
  const runtimeRoot = path.join(temporaryRoot, 'runtime');
  const assetRoot = path.join(temporaryRoot, 'assets');
  try {
    const result = spawnSync(process.execPath, [entrypoint, '--help'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot,
        HEPTA_PAPER_ASSET_ROOT: assetRoot,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Error|unknown_cli_option/);
    assert.match(result.stdout, /Generates external authority/);
    assert.equal(fs.existsSync(runtimeRoot), false);
    assert.equal(fs.existsSync(assetRoot), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('external intake rejects unknown CLI options without writes', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-external-intake-cli-'));
  const runtimeRoot = path.join(temporaryRoot, 'runtime');
  try {
    const result = spawnSync(process.execPath, [entrypoint, '--unknown'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown_cli_option:--unknown/);
    assert.equal(fs.existsSync(runtimeRoot), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('external intake provenance ignores release override and rejects dirty trees before writes', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-external-intake-provenance-'));
  const repositoryRoot = createCleanRepository(temporaryRoot);
  const outputRoot = path.join(temporaryRoot, 'external-intake');
  const actualCommit = runGit(repositoryRoot, ['rev-parse', 'HEAD']);
  const priorReleaseCommit = process.env.HEPTA_RELEASE_COMMIT;
  let inspectorOptions;
  let generationCount = 0;
  try {
    process.env.HEPTA_RELEASE_COMMIT = 'f'.repeat(40);
    const clean = await withCleanExternalIntakeCodeProvenance({
      workspaceRoot: repositoryRoot,
      codeProvenanceInspector(options) {
        inspectorOptions = options;
        return currentCodeProvenance(options);
      },
      generate(provenance, assertProvenanceStillCurrent) {
        generationCount += 1;
        assertProvenanceStillCurrent();
        return provenance;
      },
    });
    assert.equal(inspectorOptions.allowReleaseCommitEnvironment, false);
    assert.equal(clean.commit, actualCommit);
    assert.notEqual(clean.commit, process.env.HEPTA_RELEASE_COMMIT);
    assert.equal(clean.treeDirty, false);
    assert.equal(generationCount, 1);

    fs.writeFileSync(path.join(repositoryRoot, 'untracked.txt'), 'dirty\n');
    await assert.rejects(() => withCleanExternalIntakeCodeProvenance({
      workspaceRoot: repositoryRoot,
      codeProvenanceInspector: currentCodeProvenance,
      generate() {
        generationCount += 1;
        fs.mkdirSync(outputRoot, { recursive: true });
      },
    }), /external_intake_clean_worktree_required/);
    assert.equal(generationCount, 1);
    assert.equal(fs.existsSync(outputRoot), false);
  } finally {
    if (priorReleaseCommit === undefined) delete process.env.HEPTA_RELEASE_COMMIT;
    else process.env.HEPTA_RELEASE_COMMIT = priorReleaseCommit;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('external intake finalization binds full provenance and hashes all nine documents', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-external-intake-documents-'));
  try {
    const repositoryRoot = createCleanRepository(temporaryRoot);
    const provenance = currentCodeProvenance({
      workspaceRoot: repositoryRoot,
      allowReleaseCommitEnvironment: false,
    });
    const payloads = Object.fromEntries(EXTERNAL_INTAKE_OUTPUT_SPECS.map(({ name }, index) => [
      name,
      {
        version: 1,
        kind: `ExternalIntakeTestDocument${index + 1}`,
        ...(name === 'OPERATIONAL_RECEIPT_TEMPLATES.json'
          ? {
            releaseCommit: provenance.commit,
            templates: [{ releaseCommit: provenance.commit }],
          }
          : {}),
      },
    ]));
    const documents = finalizeExternalIntakeDocuments({
      payloads,
      codeProvenance: provenance,
    });
    assert.equal(documents.length, 9);
    assert.deepEqual(
      documents.map(({ name, role }) => ({ name, role })),
      EXTERNAL_INTAKE_OUTPUT_SPECS,
    );
    for (const { document } of documents) {
      const { documentHash, ...payload } = document;
      assert.deepEqual(document.codeProvenance, provenance);
      assert.equal(document.codeProvenance.treeDirty, false);
      assert.equal(document.codeProvenance.commit, provenance.commit);
      assert.equal(documentHash, hashRecord(payload.kind, payload));
    }
    const operational = documents.find(({ name }) => (
      name === 'OPERATIONAL_RECEIPT_TEMPLATES.json'
    )).document;
    assert.equal(operational.releaseCommit, provenance.commit);
    assert.deepEqual(operational.codeProvenance, provenance);
    assert.throws(() => finalizeExternalIntakeDocuments({
      payloads: {
        ...payloads,
        'OPERATIONAL_RECEIPT_TEMPLATES.json': {
          ...payloads['OPERATIONAL_RECEIPT_TEMPLATES.json'],
          releaseCommit: 'f'.repeat(40),
        },
      },
      codeProvenance: provenance,
    }), /external_intake_operational_template_commit_mismatch/);
    assert.throws(() => finalizeExternalIntakeDocuments({
      payloads: {
        ...payloads,
        'OPERATIONAL_RECEIPT_TEMPLATES.json': {
          ...payloads['OPERATIONAL_RECEIPT_TEMPLATES.json'],
          templates: [{ releaseCommit: 'f'.repeat(40) }],
        },
      },
      codeProvenance: provenance,
    }), /external_intake_operational_template_commit_mismatch/);
    assert.throws(() => finalizeExternalIntakeDocuments({
      payloads: { ...payloads, 'OWNER_ACCEPTANCE_REQUEST.json': undefined },
      codeProvenance: provenance,
    }), /external_intake_payload_invalid:OWNER_ACCEPTANCE_REQUEST\.json/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('external intake detects a clean provenance change immediately before writes', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-external-intake-race-'));
  try {
    const repositoryRoot = createCleanRepository(temporaryRoot);
    const provenance = currentCodeProvenance({
      workspaceRoot: repositoryRoot,
      allowReleaseCommitEnvironment: false,
    });
    let inspectionCount = 0;
    let writeCount = 0;
    await assert.rejects(() => withCleanExternalIntakeCodeProvenance({
      workspaceRoot: repositoryRoot,
      codeProvenanceInspector() {
        inspectionCount += 1;
        return inspectionCount === 1
          ? provenance
          : Object.freeze({ ...provenance, tags: Object.freeze(['changed']) });
      },
      generate(_initial, assertProvenanceStillCurrent) {
        assertProvenanceStillCurrent();
        writeCount += 1;
      },
    }), /external_intake_code_provenance_changed_during_generation/);
    assert.equal(inspectionCount, 2);
    assert.equal(writeCount, 0);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
