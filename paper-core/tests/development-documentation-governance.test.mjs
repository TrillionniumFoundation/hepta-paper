import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const validatorPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../docs/tools/validate-development-docs.mjs',
);
const currentStatusPath = path.join(root, 'paper-core/docs/CURRENT_STATUS.md');
const packageJsonPath = path.join(root, 'package.json');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('development documentation validator executes the canonical fail-closed contract', () => {
  const result = spawnSync(process.execPath, [validatorPath], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'development_documentation_valid');
  assert.equal(report.planVersion, '1.1');
  for (const field of [
    'documents',
    'capabilities',
    'modules',
    'workItems',
    'milestones',
    'risks',
    'workloads',
  ]) {
    assert.equal(Number.isSafeInteger(report[field]), true, field);
    assert.equal(report[field] > 0, true, field);
  }
});

test('development documentation validator retains independent governance guards', () => {
  const source = fs.readFileSync(validatorPath, 'utf8');
  for (const required of [
    /strict_json_schema\.py/u,
    /central_state_write/u,
    /openCriticalGates/u,
    /module cycle|cycle/u,
    /forbidden historical|historical document path forbidden/u,
    /canonicalDocuments/u,
    /machineRecords/u,
    /externalBlockerIds/u,
    /minimumEvidenceTier|minimumQualificationTier/u,
  ]) assert.match(source, required);

  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /node docs\/tools\/validate-development-docs\.mjs/u);
  const codeowners = read('.github/CODEOWNERS');
  assert.match(codeowners, /^\/docs\/\s+@/mu);
});


test('every required qualification producer always reports on pull requests', () => {
  const manifest = JSON.parse(read('docs/rust/qualification/source-check-producers.v1.json'));
  const workflowPaths = new Set(manifest.producers.map((producer) => producer.workflowPath));
  assert.ok(workflowPaths.size > 0);

  for (const workflowPath of [...workflowPaths].sort()) {
    const workflow = read(workflowPath);
    const triggerMatch = workflow.match(/^on:\n([\s\S]*?)(?=^(?:permissions|concurrency|env|jobs):)/mu);
    assert.ok(triggerMatch, `${workflowPath}: missing bounded on block`);
    const triggerBlock = triggerMatch[0];
    assert.match(triggerBlock, /^  pull_request:\s*$/mu, workflowPath);
    assert.doesNotMatch(
      triggerBlock,
      /^  pull_request:\s*\n    (?:paths|paths-ignore|types|branches|branches-ignore):/mu,
      `${workflowPath}: required producer pull_request trigger must always report`,
    );
  }
});

test('current Node status keeps the exact release-state marker and no legacy tree survives', () => {
  const version = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version;
  const marker = `This is the normative status for the unreleased v${version} development candidate.`;
  const statusLines = fs.readFileSync(currentStatusPath, 'utf8').split(/\r?\n/u);
  assert.equal(statusLines.filter((line) => line === marker).length, 1);

  for (const relative of [
    'paper-core/docs/history',
    'docs/codex',
    'docs/rust/evidence',
  ]) {
    assert.equal(fs.existsSync(path.join(root, relative)), false, relative);
  }

  const documentManifest = JSON.parse(read('docs/system/truth/document-manifest.v1.json'));
  assert.equal(documentManifest.historyPolicy, 'git_history_only');
});
