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

const RETIRED_PLUGIN_RUNNERS = new Set([
  'plugins/core/referee/run.py',
  'plugins/core/referee-revision-patch/run.py',
  'plugins/core/referee-revision-planner/run.py',
  'plugins/core/substantive-referee/run.py',
]);

const VENUE_RESOLVE_EXPLICIT_RETIREMENTS = new Set([
  'paperctl_modules/decision_points.py',
  'paperctl_modules/paper_production_final_settlement_gate.py',
  'paperctl_modules/paper_production_operator_drop_intake_preflight.py',
  'paperctl_modules/paper_production_referee_repair_packet_material_inbox_readiness_capstone.py',
  'paperctl_modules/paper_production_referee_repair_packet_readiness_capstone.py',
  'paperctl_modules/paper_production_runner_readiness_gate.py',
]);

const REFEREE_REVISE_EXPLICIT_RETIREMENTS = new Set([
  'paperctl_modules/paper_production_referee_repair_closure_prerequisite_remediation_matrix_capstone.py',
  'paperctl_modules/paper_production_referee_repair_contract_fulfillment_gate_capstone.py',
  'paperctl_modules/paper_production_referee_repair_executable_packet_spec_checklist_capstone.py',
  'paperctl_modules/paper_production_referee_repair_packet_material_evidence_candidate_validation_capstone.py',
  'paperctl_modules/paper_production_referee_repair_packet_material_promotion_quarantine_capstone.py',
  'paperctl_modules/paper_production_referee_repair_packet_material_validation_failure_matrix_capstone.py',
  'paperctl_modules/paper_production_referee_repair_packet_materialization_intake_capstone.py',
  'paperctl_modules/paper_production_referee_repair_packet_promotion_evidence_release_separation_ledger_capstone.py',
  'paperctl_modules/paper_production_referee_repair_packet_promotion_review_authorization_dry_run_ledger_capstone.py',
  'paperctl_modules/paper_production_referee_repair_packet_promotion_review_decision_intake_guard_capstone.py',
  'paperctl_modules/paper_production_referee_repair_packet_promotion_review_intake_quarantine_capstone.py',
  'paperctl_modules/paper_production_referee_repair_packet_repair_evidence_release_request_envelope_nonclosure_preflight_capstone.py',
  'paperctl_modules/paper_production_referee_repair_packet_skeleton_inventory_currentness_capstone.py',
  'paperctl_modules/paper_production_referee_repair_request_packet_contract_lint_capstone.py',
  'paperctl_modules/paper_production_referee_repair_routing_capstone.py',
  'paperctl_modules/paper_production_referee_repair_typed_evidence_contract_matrix.py',
  'paperctl_modules/paper_production_referee_repair_work_order_capstone.py',
  'paperctl_modules/paper_production_referee_revise_loop_capstone.py',
]);

const REFEREE_REVISION_DIFFERENTIAL_SOURCE = 'paperctl_modules/referee_revision.py';

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
  if (VENUE_RESOLVE_EXPLICIT_RETIREMENTS.has(entry.path)) {
    return {
      path: 'hepta-paper-workspace/migration/venue-resolve-retirements.mjs',
      symbols: ['VENUE_RESOLVE_EXPLICIT_RETIREMENTS', 'venueResolveRetirementDisposition'],
    };
  }
  if (REFEREE_REVISE_EXPLICIT_RETIREMENTS.has(entry.path)) {
    return {
      path: 'hepta-paper-workspace/migration/referee-revise-retirements.mjs',
      symbols: ['REFEREE_REVISE_EXPLICIT_RETIREMENTS', 'refereeReviseRetirementDisposition'],
    };
  }
  if (entry.path === REFEREE_REVISION_DIFFERENTIAL_SOURCE) {
    return {
      path: 'hepta-paper-workspace/paper-adapters/referee-revise/decision-routing.mjs',
      symbols: [
        'refereeRevisionRequestDecisionPlan',
        'refereeRevisionRequestConsumingSelection',
        'evidenceResyncDecisionPlan',
        'evidenceResyncConsumingSelection',
        'readyMergeBoundaryDecisionPlan',
        'readyMergeBoundaryConsumingSelection',
        'postApplyFinalGateDecisionPlan',
        'postApplyFinalGateConsumingSelection',
      ],
    };
  }
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
  venueRetirementTestHash,
  refereeRevisionDifferentialTestHash,
  refereeRetirementTestHash,
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
      const retiredPluginRunner = RETIRED_PLUGIN_RUNNERS.has(entry.path);
      const completePluginReplacement = completePluginDescriptor || retiredPluginRunner;
      const retiredVenueResolveSurface = VENUE_RESOLVE_EXPLICIT_RETIREMENTS.has(entry.path);
      const retiredRefereeReviseSurface = REFEREE_REVISE_EXPLICIT_RETIREMENTS.has(entry.path);
      const differentialRefereeRevision = entry.path === REFEREE_REVISION_DIFFERENTIAL_SOURCE;
      const completeReplacement = completePluginReplacement
        || retiredVenueResolveSurface
        || retiredRefereeReviseSurface
        || differentialRefereeRevision;
      return {
        id: candidateId(entry),
        priority: 'P1',
        capabilityFamily: entry.targetAdapter,
        migrationAction: retiredVenueResolveSurface
          ? 'retire_generated_control_evidence_surface'
          : retiredRefereeReviseSurface
            ? 'retire_generated_referee_control_evidence_surface'
            : differentialRefereeRevision
              ? 'port_referee_revision_decision_selectors_with_exact_differential_parity'
          : entry.migrationAction,
        semanticScope: completeReplacement
          ? {
            status: 'complete',
            covered: retiredVenueResolveSurface
              ? [
                'all public legacy source symbols inventoried',
                'generated report/control-evidence surface explicitly retired outside venue resolution',
                'zero source writes, process launches, and network imports',
                'zero exact source-path references from hepta production modules',
              ]
              : retiredRefereeReviseSurface
                ? [
                  'all public legacy source symbols inventoried',
                  'generated referee report/control-evidence surface explicitly retired',
                  'zero source writes, process launches, and network imports',
                  'zero exact source-path references from hepta production modules',
                ]
                : differentialRefereeRevision
                  ? [
                    'all eight public decision-plan and consuming-selection functions ported',
                    'exact Python-to-JavaScript differential parity across every decision and selection state',
                    'plan-only mutation, external-action, unsafe-command, and human-review guards preserved',
                    'deterministic fallback and selected-route behavior preserved',
                  ]
              : [
                completePluginDescriptor
                  ? 'legacy plugin descriptor identity and execution policy'
                  : 'legacy Python plugin runner explicitly retired and absent from hepta production references',
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
        behaviorTests: completePluginReplacement
          ? [{
            id: 'p1-plugin-wrapper-boundaries',
            path: 'migration/tests/p1-plugin-wrapper-boundaries.mjs',
            sha256: pluginBoundaryTestHash,
          }]
          : retiredVenueResolveSurface
            ? [{
              id: 'p1-venue-resolve-explicit-retirements',
              path: 'migration/tests/p1-venue-resolve-retirements.mjs',
              sha256: venueRetirementTestHash,
            }]
            : retiredRefereeReviseSurface
              ? [{
                id: 'p1-referee-revise-explicit-retirements',
                path: 'migration/tests/p1-referee-revise-retirements.mjs',
                sha256: refereeRetirementTestHash,
              }]
              : differentialRefereeRevision
                ? [{
                  id: 'p1-referee-revision-differential',
                  path: 'migration/tests/p1-referee-revision-differential.mjs',
                  sha256: refereeRevisionDifferentialTestHash,
                }]
            : [],
      };
    });
}
