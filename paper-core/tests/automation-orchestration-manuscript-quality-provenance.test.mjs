import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runManuscriptQualityChecks } from '../../paper-adapters/automation/manuscript-quality-checks.mjs';

function temporary(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('manuscript empirical provenance covers the recursive TeX corpus and every numeric result claim', (t) => {
  const root = temporary(t, 'hepta-quality-provenance-corpus-');
  fs.mkdirSync(path.join(root, 'sections'), { recursive: true });
  fs.writeFileSync(path.join(root, 'results.json'), '{"accuracy":0.91,"latency":12}\n');
  fs.writeFileSync(path.join(root, 'main.tex'), '\\input{sections/results}\n');
  fs.writeFileSync(path.join(root, 'sections', 'results.tex'), [
    '% HEPTA_RESULT results.json#accuracy=0.91',
    'The observed accuracy was 91\\%.',
    'The observed latency was 12 ms.',
  ].join('\n'));
  const unbound = runManuscriptQualityChecks({ workspacePath: root, requiresEmpiricalArtifacts: true });
  assert.ok(unbound.blockers.includes('empirical_numeric_claim_provenance_missing'));
  assert.deepEqual(unbound.details.manuscriptCorpusFiles, ['main.tex', 'sections/results.tex']);
  assert.equal(unbound.details.unboundEmpiricalNumericClaims.length, 1);
  assert.equal(unbound.details.unboundEmpiricalNumericClaims[0].sourcePath, 'sections/results.tex');

  fs.writeFileSync(path.join(root, 'sections', 'results.tex'), [
    '% HEPTA_RESULT results.json#accuracy=0.91',
    'The observed accuracy was 91\\%.',
    '% HEPTA_RESULT results.json#latency=12',
    'The observed latency was 12 ms.',
  ].join('\n'));
  const bound = runManuscriptQualityChecks({ workspacePath: root, requiresEmpiricalArtifacts: true });
  assert.equal(bound.passed, true, JSON.stringify(bound.blockers));
  assert.equal(bound.details.resultProvenanceMarkerCount, 2);
  assert.deepEqual(bound.details.unboundEmpiricalNumericClaims, []);
});

test('empirical manuscript checks reject keyword-free numbers and fake figure bytes', (t) => {
  const root = temporary(t, 'hepta-quality-adversarial-provenance-');
  fs.mkdirSync(path.join(root, 'automation-results'));
  fs.writeFileSync(path.join(root, 'automation-results', 'results.json'), '{"score":0.734}\n');
  fs.writeFileSync(path.join(root, 'fake.png'), 'not-a-real-figure');
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '% HEPTA_RESULT automation-results/results.json#score=0.734',
    'Filler prose.',
    'Filler prose.',
    'Filler prose.',
    'Our method reached 73.4 percent.',
    'The ablation dominates every alternative in practice.',
    '\\includegraphics{fake.png}',
  ].join('\n'));
  const receipt = runManuscriptQualityChecks({
    workspacePath: root,
    requiresEmpiricalArtifacts: true,
  });
  assert.equal(receipt.passed, false);
  assert.ok(receipt.blockers.includes('empirical_numeric_claim_provenance_missing'));
  assert.ok(receipt.blockers.includes('empirical_assertion_provenance_missing'));
  assert.ok(receipt.blockers.includes('invalid_figure_artifacts'));
  assert.ok(receipt.blockers.includes('empirical_figure_artifacts_unsupported'));
});

test('manuscript quality checks bind canonical CSV metrics by name and reject partial numeric coverage', (t) => {
  const root = temporary(t, 'hepta-manuscript-csv-provenance-');
  fs.writeFileSync(path.join(root, 'results.csv'), 'metric,value\naccuracy,0.91\nlatency_ms,27\n');
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '% HEPTA_RESULT results.csv#accuracy=0.91',
    '% HEPTA_RESULT results.csv#latency_ms=27',
    'The empirical result has accuracy 0.91 and latency 27 ms.',
  ].join('\n'));

  const complete = runManuscriptQualityChecks({ workspacePath: root, requiresEmpiricalArtifacts: true });
  assert.equal(complete.passed, true, JSON.stringify(complete.blockers));

  fs.writeFileSync(path.join(root, 'main.tex'), [
    '% HEPTA_RESULT results.csv#accuracy=0.91',
    'The empirical result has accuracy 0.91 and latency 27 ms.',
  ].join('\n'));
  const partial = runManuscriptQualityChecks({ workspacePath: root, requiresEmpiricalArtifacts: true });
  assert.equal(partial.passed, false);
  assert.ok(partial.blockers.includes('empirical_numeric_claim_provenance_missing'));
});

test('manuscript quality checks reject result and TeX-input symlinks that escape the workspace', (t) => {
  const root = temporary(t, 'hepta-manuscript-symlink-provenance-');
  const outside = temporary(t, 'hepta-manuscript-symlink-outside-');
  fs.writeFileSync(path.join(outside, 'results.json'), '{"score":0.95}\n');
  fs.writeFileSync(path.join(outside, 'claims.tex'), 'The empirical result is 0.95.\n');
  fs.symlinkSync(path.join(outside, 'results.json'), path.join(root, 'results.json'));
  fs.symlinkSync(path.join(outside, 'claims.tex'), path.join(root, 'claims.tex'));
  fs.writeFileSync(path.join(root, 'main.tex'), [
    '% HEPTA_RESULT results.json#score=0.95',
    '\\input{claims}',
  ].join('\n'));

  const receipt = runManuscriptQualityChecks({ workspacePath: root, requiresEmpiricalArtifacts: true });
  assert.equal(receipt.passed, false);
  assert.ok(receipt.blockers.includes('claim_result_provenance_mismatch'));
  assert.ok(receipt.blockers.includes('missing_table_or_input_artifacts'));
});
