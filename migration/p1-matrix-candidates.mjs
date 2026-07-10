import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const COMPLETE_PLUGIN_DESCRIPTORS = new Set([
  'plugins/core/compile/plugin.yaml',
  'plugins/core/evidence-check/plugin.yaml',
  'plugins/core/external/plugin.yaml',
  'plugins/core/packager/plugin.yaml',
  'plugins/core/referee/plugin.yaml',
  'plugins/core/referee-revision-patch/plugin.yaml',
  'plugins/core/referee-revision-planner/plugin.yaml',
  'plugins/core/report/plugin.yaml',
  'plugins/core/section-writer/plugin.yaml',
  'plugins/core/substantive-referee/plugin.yaml',
  'plugins/core/venue/plugin.yaml',
]);

const TARGETS = Object.freeze({
  'paper-adapters/venue-resolve': {
    path: 'hepta-paper-workspace/paper-adapters/venue-resolve/index.mjs',
    symbols: ['runVenueResolveAdapter'],
  },
  'paper-adapters/submission': {
    path: 'hepta-paper-workspace/paper-adapters/submission/index.mjs',
    symbols: ['buildSubmissionLifecycle'],
  },
  'paper-adapters/build-package': {
    path: 'hepta-paper-workspace/paper-adapters/build-package/index.mjs',
    symbols: ['runLatexBuildAdapter', 'runPackageAdapter'],
  },
  'paper-adapters/referee-revise': {
    path: 'hepta-paper-workspace/paper-adapters/referee-revise/index.mjs',
    symbols: ['runRefereeReviseAdapter'],
  },
  'paper-adapters/research-verify': {
    path: 'hepta-paper-workspace/paper-adapters/research-verify/index.mjs',
    symbols: ['runResearchVerifyAdapter'],
  },
  'paper-adapters/submission/venue-resolve': {
    path: 'hepta-paper-workspace/paper-adapters/submission/index.mjs',
    symbols: ['buildSubmissionLifecycle'],
  },
  'paper-adapters/referee-review': {
    path: 'hepta-paper-workspace/paper-adapters/referee-review/index.mjs',
    symbols: ['runRefereeReviewAdapter'],
  },
  'paper-adapters/referee-review/referee-revise': {
    path: 'hepta-paper-workspace/paper-adapters/referee-review/index.mjs',
    symbols: ['runRefereeReviewAdapter'],
  },
});

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sourceSymbols(file, relative) {
  const text = fs.readFileSync(file, 'utf8');
  if (/\.ya?ml$/i.test(relative)) {
    const preferred = [
      'id',
      'type',
      'enabled',
      'read_only',
      'execution_mode',
      'writes_external_state',
      'command',
    ];
    return preferred.filter((key) => new RegExp(`^${key}:`, 'm').test(text));
  }
  const definitions = [...text.matchAll(/^(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)]
    .map((match) => match[1]);
  const publicDefinitions = definitions.filter((name) => !name.startsWith('_'));
  if (publicDefinitions.length) return publicDefinitions.slice(0, 16);
  if (definitions.length) return definitions.slice(0, 16);
  return [...text.matchAll(/^([A-Z][A-Z0-9_]*)\s*=/gm)].map((match) => match[1]).slice(0, 16);
}

function targetFor(entry) {
  if (entry.path === 'plugins/core/report/plugin.yaml') {
    return {
      path: 'hepta-paper-workspace/paper-core/src/paper-batch-runner.mjs',
      symbols: ['runPaperBatch', 'PAPER_BATCH_MODES'],
    };
  }
  if (entry.path === 'plugins/core/section-writer/plugin.yaml') {
    return {
      path: 'hepta-paper-workspace/paper-adapters/proposal/index.mjs',
      symbols: ['runPaperProposalAdapter'],
    };
  }
  if (entry.path === 'plugins/core/substantive-referee/plugin.yaml'
    || entry.path === 'plugins/core/substantive-referee/run.py') {
    return {
      path: 'hepta-paper-workspace/paper-adapters/referee-review/index.mjs',
      symbols: ['runRefereeReviewAdapter'],
    };
  }
  if (entry.path === 'plugins/core/venue/plugin.yaml') {
    return TARGETS['paper-adapters/venue-resolve'];
  }
  if (entry.path === 'plugins/core/external/plugin.yaml') {
    return TARGETS['paper-adapters/submission'];
  }
  return TARGETS[entry.targetAdapter] || {
    path: 'hepta-paper-workspace/paper-core/src/paper-batch-runner.mjs',
    symbols: ['runPaperBatch'],
  };
}

function candidateId(entry) {
  const slug = entry.path.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
  const hash = String(entry.hash || '').replace(/^sha256:/, '').slice(0, 12);
  return `p1-${slug}-${hash}`;
}

export function buildP1MatrixCandidates({
  root,
  entries,
  pluginBoundaryTestHash,
} = {}) {
  return entries
    .filter((entry) => entry.priority === 'P1')
    .filter((entry) => !['quarantine_not_migrate', 'retire_not_migrate'].includes(entry.migrationAction))
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => {
      const sourceFile = path.resolve(root, entry.path);
      const target = targetFor(entry);
      const targetFile = path.resolve(root, target.path);
      const completePluginDescriptor = COMPLETE_PLUGIN_DESCRIPTORS.has(entry.path);
      return {
        id: candidateId(entry),
        priority: 'P1',
        capabilityFamily: entry.targetAdapter,
        migrationAction: entry.migrationAction,
        semanticScope: completePluginDescriptor
          ? {
            status: 'complete',
            covered: [
              'legacy plugin descriptor identity and execution policy',
              'native adapter export and local-only execution boundary',
              'legacy external/write semantics explicitly blocked or retired',
              'unbound model calls and direct manuscript mutation explicitly retired',
            ],
            open: [],
          }
          : {
            status: 'partial',
            covered: [
              'exact legacy source hash',
              'legacy top-level symbol inventory',
              'assigned native capability family',
              'exact current target hash and exported target symbols',
            ],
            open: [
              'hash-bound behavioral equivalence or explicit retirement test',
              'complete symbol-to-symbol semantic coverage review',
            ],
          },
        source: {
          path: entry.path,
          sha256: String(entry.hash || '').replace(/^sha256:/, ''),
          symbols: sourceSymbols(sourceFile, entry.path),
        },
        target: {
          path: target.path,
          sha256: sha256File(targetFile),
          symbols: target.symbols,
        },
        behaviorTests: completePluginDescriptor
          ? [{
            id: 'p1-plugin-wrapper-boundaries',
            path: 'migration/tests/p1-plugin-wrapper-boundaries.mjs',
            sha256: pluginBoundaryTestHash,
          }]
          : [],
      };
    });
}
