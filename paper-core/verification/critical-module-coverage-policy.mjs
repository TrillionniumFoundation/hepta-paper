const DEFAULT_THRESHOLD = Object.freeze({
  lines: 40,
  functions: 25,
  maxUncoveredBranchBlocks: 180,
});

const TRUST_BOUNDARY_THRESHOLD = Object.freeze({
  lines: 55,
  functions: 40,
  maxUncoveredBranchBlocks: 48,
});

const MAXIMUM_AUDITED_BRANCH_CAP = 120;
const AUDITED_EXCEPTION_KIND = 'audited_large_branch_surface';
const EXACT_OVERRIDE_KEYS = Object.freeze([
  'auditKind',
  'functions',
  'lines',
  'maxUncoveredBranchBlocks',
  'rationale',
  'reviewedAttackSurface',
  'trustBoundary',
]);

function exception({
  lines,
  functions,
  maxUncoveredBranchBlocks,
  trustBoundary,
  reviewedAttackSurface,
  rationale,
}) {
  return Object.freeze({
    lines,
    functions,
    maxUncoveredBranchBlocks,
    trustBoundary,
    auditKind: AUDITED_EXCEPTION_KIND,
    reviewedAttackSurface: Object.freeze([...reviewedAttackSurface]),
    rationale,
  });
}

export const CRITICAL_COVERAGE_TARGET_OVERRIDES = Object.freeze({
  'paper-adapters/automation/workspace-attempt-repository.mjs': exception({
    lines: 80,
    functions: 85,
    maxUncoveredBranchBlocks: 110,
    trustBoundary: false,
    reviewedAttackSurface: ['path-containment', 'attempt-fencing', 'rollback'],
    rationale:
      'Large filesystem transaction adapter; direct tests cover containment, fencing, no-clobber publication, rollback, and crash cleanup.',
  }),
  'paper-adapters/automation/isolated-agent-executor.mjs': exception({
    lines: 75,
    functions: 80,
    maxUncoveredBranchBlocks: 60,
    trustBoundary: false,
    reviewedAttackSurface: ['workspace-isolation', 'merge-receipt', 'abort'],
    rationale:
      'Large isolation adapter with platform-specific cleanup branches; direct tests cover escape rejection, abort propagation, and merge authority.',
  }),
  'paper-application/automation/campaign-node-executor.mjs': exception({
    lines: 55,
    functions: 50,
    maxUncoveredBranchBlocks: 110,
    trustBoundary: false,
    reviewedAttackSurface: ['node-admission', 'attempt-fencing', 'receipt-binding'],
    rationale:
      'Central typed node dispatcher has a broad node-kind matrix; tests cover admission, authority binding, stale attempts, and terminal receipts.',
  }),
  'paper-adapters/runtime/scoped-file-materialization-repository.mjs': exception({
    lines: 80,
    functions: 90,
    maxUncoveredBranchBlocks: 70,
    trustBoundary: false,
    reviewedAttackSurface: ['path-containment', 'symlink-defense', 'crash-recovery'],
    rationale:
      'Filesystem materializer has OS-error and recovery branches; tests cover symlink, traversal, no-clobber, identity drift, and interrupted writes.',
  }),
  'paper-adapters/automation/system-benchmark-harness.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 56,
    trustBoundary: true,
    reviewedAttackSurface: ['dataset-authority', 'process-receipt', 'output-integrity'],
    rationale:
      'Multi-language benchmark authority retains runtime-specific validation branches; integrity tests attack dataset, process, and output bindings.',
  }),
  'paper-application/automation/autonomous-research-campaign.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 81,
    trustBoundary: true,
    reviewedAttackSurface: ['campaign-admission', 'release-binding', 'abort'],
    rationale:
      'Campaign aggregate spans typed node families and terminal states; boundary tests cover invalid admission, release lineage, stale state, and aborts.',
  }),
  'paper-domain/automation/autonomous-submission-contract.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 55,
    trustBoundary: true,
    reviewedAttackSurface: ['submission-binding', 'receipt-integrity', 'replay'],
    rationale:
      'Submission contract validates several venue-specific optional projections; tests cover binding tamper, receipt reseal, and replay isolation.',
  }),
  'paper-adapters/automation/autonomous-research-state-database-inventory.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 57,
    trustBoundary: true,
    reviewedAttackSurface: ['database-identity', 'symlink-defense', 'schema-drift'],
    rationale:
      'State inventory handles multiple database families and file identities; tests cover path substitution, schema drift, and incomplete inventory.',
  }),
  'paper-adapters/automation/autonomous-research-state-backup-repository.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 49,
    trustBoundary: true,
    reviewedAttackSurface: ['snapshot-integrity', 'journal-replay', 'no-clobber'],
    rationale:
      'Backup repository retains backend error branches; tests cover signed snapshots, finalized-journal replay, collision, and marker tampering.',
  }),
  'paper-composition/automation/autonomous-research-external-capability-composition.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 53,
    trustBoundary: true,
    reviewedAttackSurface: ['principal-separation', 'credential-aliasing', 'authority-wiring'],
    rationale:
      'External authority composition has provider-version matrices; tests cover missing trust, aliased credentials, identity separation, and wiring.',
  }),
  'paper-adapters/automation/http-external-research-replay-adapter.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 61,
    trustBoundary: true,
    reviewedAttackSurface: ['signed-recovery', 'pre-abort', 'response-tamper'],
    rationale:
      'Versioned HTTP replay protocol retains transport failure branches; tests cover pre-abort zero-fetch, signed recovery, expiry, and response tamper.',
  }),
  'paper-adapters/automation/http-reviewer-receipt-signer-adapter.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 71,
    trustBoundary: true,
    reviewedAttackSurface: ['opaque-secret', 'signed-recovery', 'pre-abort'],
    rationale:
      'Versioned signer protocol includes credential and recovery matrices; tests cover opaque-file secrets, zero-fetch abort, signatures, and lookup.',
  }),
  'paper-adapters/automation/http-recoverable-reviewer-executor-adapter.mjs': exception({
    lines: 80,
    functions: 75,
    maxUncoveredBranchBlocks: 66,
    trustBoundary: true,
    reviewedAttackSurface: ['workspace-snapshot', 'signed-recovery', 'pre-abort'],
    rationale:
      'Recoverable reviewer protocol is a large signed HTTP state machine; direct tests cover snapshot drift, tamper, definitive-not-found, and abort.',
  }),
  'paper-domain/automation/strict-full-auto-acceptance-plan.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 57,
    trustBoundary: true,
    reviewedAttackSurface: ['configuration-injection', 'path-containment', 'authority-reference'],
    rationale:
      'Strict acceptance plan validates a large immutable configuration schema; tests cover secret injection, escaped paths, missing authority, and hash drift.',
  }),
  'paper-adapters/automation/local-autonomous-venue-compliance-inspector.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 52,
    trustBoundary: true,
    reviewedAttackSurface: ['venue-policy', 'template-binding', 'artifact-integrity'],
    rationale:
      'Venue inspection supports heterogeneous policy profiles; tests cover signed profiles, template substitution, missing artifacts, and hash mismatch.',
  }),
  'paper-domain/automation/autonomous-research-release-binding-contract.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 51,
    trustBoundary: true,
    reviewedAttackSurface: ['release-lineage', 'claim-binding', 'outer-reseal'],
    rationale:
      'Release binding validates a wide immutable evidence projection; tests cover claim substitution, lineage mismatch, missing authority, and resealing.',
  }),
  'paper-domain/automation/autonomous-formal-support-registry.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 52,
    trustBoundary: true,
    reviewedAttackSurface: ['profile-registry', 'kernel-binding', 'unsupported-domain'],
    rationale:
      'Formal support registry contains explicit domain and kernel matrices; tests cover unsupported profiles, kernel mismatch, and registry tampering.',
  }),
  'paper-adapters/research-verify/lake-formal-verifier.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 55,
    trustBoundary: true,
    reviewedAttackSurface: ['source-containment', 'toolchain-binding', 'process-failure'],
    rationale:
      'Lean verifier retains platform and process diagnostic branches; tests cover source escape, toolchain mismatch, timeout, and proof failure.',
  }),
  'paper-adapters/research-verify/trusted-formal-producer.mjs': exception({
    lines: 55,
    functions: 40,
    maxUncoveredBranchBlocks: 66,
    trustBoundary: true,
    reviewedAttackSurface: ['formal-receipt', 'source-lineage', 'claim-manifest'],
    rationale:
      'Trusted formal producer validates a broad certificate projection; tests cover receipt replacement, source drift, missing lineage, and manifest tamper.',
  }),
});

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify([...expected].sort());
}

function validThreshold(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

export function validateCriticalCoveragePolicy({
  trustTargets,
  targetOverrides = CRITICAL_COVERAGE_TARGET_OVERRIDES,
} = {}) {
  if (!(trustTargets instanceof Set)
    || !targetOverrides || typeof targetOverrides !== 'object'
    || Array.isArray(targetOverrides)) {
    throw new Error('critical_coverage_policy_invalid');
  }
  for (const [relative, override] of Object.entries(targetOverrides)) {
    const baseline = trustTargets.has(relative)
      ? TRUST_BOUNDARY_THRESHOLD : DEFAULT_THRESHOLD;
    if (!relative.endsWith('.mjs') || !exactKeys(override, EXACT_OVERRIDE_KEYS)
      || override.auditKind !== AUDITED_EXCEPTION_KIND
      || override.trustBoundary !== trustTargets.has(relative)
      || !validThreshold(override.lines)
      || !validThreshold(override.functions)
      || override.lines < baseline.lines
      || override.functions < baseline.functions
      || !Number.isSafeInteger(override.maxUncoveredBranchBlocks)
      || override.maxUncoveredBranchBlocks < 0
      || override.maxUncoveredBranchBlocks > MAXIMUM_AUDITED_BRANCH_CAP
      || !Array.isArray(override.reviewedAttackSurface)
      || override.reviewedAttackSurface.length < 2
      || override.reviewedAttackSurface.some((item) => (
        typeof item !== 'string' || item.length < 3
      ))
      || new Set(override.reviewedAttackSurface).size
        !== override.reviewedAttackSurface.length
      || typeof override.rationale !== 'string'
      || override.rationale.length < 80) {
      throw new Error(`critical_coverage_target_override_invalid:${relative}`);
    }
  }
  return true;
}

export function buildCriticalCoverageTargetThresholds({ trustTargets } = {}) {
  validateCriticalCoveragePolicy({ trustTargets });
  return new Map(Object.entries(CRITICAL_COVERAGE_TARGET_OVERRIDES).map(
    ([relative, override]) => Object.freeze([
      relative,
      Object.freeze({
        lines: override.lines,
        functions: override.functions,
        maxUncoveredBranchBlocks: override.maxUncoveredBranchBlocks,
      }),
    ]),
  ));
}

export const CRITICAL_COVERAGE_DEFAULT_THRESHOLD = DEFAULT_THRESHOLD;
export const CRITICAL_COVERAGE_TRUST_BOUNDARY_THRESHOLD =
  TRUST_BOUNDARY_THRESHOLD;
export const CRITICAL_COVERAGE_MAXIMUM_AUDITED_BRANCH_CAP =
  MAXIMUM_AUDITED_BRANCH_CAP;
