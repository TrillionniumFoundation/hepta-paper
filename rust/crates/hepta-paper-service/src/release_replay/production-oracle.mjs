// Fixed differential observer. It evaluates the actual Node implementation and
// archived Python bytes on the same supplied corpus. It never grants authority.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.version !== 'v22.23.1' || process.versions.icu !== '78.2'
    || process.versions.cldr !== '48.0') throw new Error('release_replay_node_profile_unqualified');
const root = process.argv[1];
const corpus = readBoundedReplayInput('production');
const production = await import(pathToFileURL(path.join(root, 'migration/retirement/production-state-compat.mjs')));
const legacy = await import(pathToFileURL(path.join(root, 'migration/legacy-reference-fixture.mjs')));
const evaluate = (snapshots) => {
  const evaluations = snapshots.map(production.evaluateLegacyProductionSnapshot);
  const singleAudits = snapshots.map((snapshot) => production.buildLegacyProductionAudit({
    paperSnapshots: [snapshot], label: 'single', createdAt: corpus.createdAt,
  }));
  return {
    evaluations,
    summary: production.summarizeLegacyProductionEvaluations(evaluations),
    audit: production.buildLegacyProductionAudit({
      paperSnapshots: snapshots, label: 'differential', createdAt: corpus.createdAt,
      skipped: ['fixture-skip'],
    }),
    singleFrontiers: singleAudits.map(production.legacyRepairLoopFrontier),
  };
};
const actual = {
  base: evaluate(corpus.baseSnapshots),
  extended: evaluate(corpus.extendedSnapshots),
  artifactCases: corpus.artifactCases.map(production.resolveLegacyArtifactLabel),
  frontierCases: corpus.frontierCases.map(production.legacyRepairLoopFrontier),
  shardCases: corpus.shardCases.map((row) => production.legacyRepairLoopFrontierSlugShard(row.frontier, row.workerLimit)),
};
const reference = legacy.materializeLegacyDifferentialReference();
try {
  const python = spawnSync('/usr/bin/python3', ['-I', '-B', '-c', String.raw`
import importlib.util, json, sys
payload = json.load(sys.stdin)
spec = importlib.util.spec_from_file_location('legacy_production', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
snapshots = payload['baseSnapshots']
evaluations = [module.evaluate_paper(row) for row in snapshots]
singles = [module.audit_report([row], label='single', created_at=payload['createdAt']) for row in snapshots]
json.dump({'base': {'evaluations': evaluations, 'summary': module.summarize(evaluations),
    'audit': module.audit_report(snapshots, label='differential', created_at=payload['createdAt'], skipped=['fixture-skip']),
    'singleFrontiers': [module.repair_loop_frontier(row) for row in singles]},
    'artifactCases': [module.resolve_artifact_label(requested_label=row.get('requestedLabel',''),
       latest_label=row.get('latestLabel',''), requested_package_count=row.get('requestedPackageCount',0),
       requested_present_count=row.get('requestedPresentCount')) for row in payload['artifactCases'][:4]]}, sys.stdout)
`, path.join(reference.root, 'paperctl_modules/paper_production_core.py')], {
    input: JSON.stringify(corpus), encoding: 'utf8', timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (python.status !== 0 || python.error) throw new Error(`release_replay_python_oracle_failed:${python.stderr || python.error}`);
  process.stdout.write(JSON.stringify({
    profile: { node: process.version, icu: process.versions.icu, cldr: process.versions.cldr },
    archiveReference: reference.verification,
    archivedPython: JSON.parse(python.stdout),
    actual,
  }) + '\n');
} finally {
  reference.cleanup();
}
