import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCapabilityOperationalEvidence } from './capability-operational-evidence.mjs';
import { verifyAuthoritySignatures } from '../paper-core/src/authority-signatures.mjs';
import { hashRecord } from '../workflow-kernel/record-hash.mjs';

const migrationRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(migrationRoot, '..');
const matrixV2Path = path.join(migrationRoot, 'legacy-semantic-migration-matrix.json');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export const CAPABILITY_DECISIONS = Object.freeze({
  PERMANENT_RETIREMENT: 'permanent_retirement',
  SUPERSEDED_WITH_COVERAGE: 'superseded_with_coverage',
  CAPABILITY_REIMPLEMENTATION: 'capability_reimplementation',
});

const PERMANENT_RETIREMENT_ACTIONS = new Set([
  'extract_review_heuristics_into_referee_review',
  'replace_plugin_wrapper_with_native_paper_adapter',
  'retire_generated_control_evidence_surface',
  'retire_generated_referee_control_evidence_surface',
  'retired_generated_build_misclassified_control_evidence_surface',
  'retired_generated_submission_control_evidence_surface',
  'retired_synthetic_submission_input_authority',
  'retired_legacy_direct_source_mutation_executor',
  'retired_research_local_e2e_smoke_harness',
  'retired_research_smoke_fixture',
]);

const SUPERSEDED_ACTIONS = new Set([
  'retired_legacy_submission_schema_superseded_by_native_lifecycle',
  'retired_legacy_research_source_mutation_or_patch_queue_control_plane',
]);

export const CAPABILITY_CATALOG = Object.freeze({
  'research.claim-registry': { boundedContext: 'research', target: 'paper-domain/research/claim-registry.mjs' },
  'research.gap-planner': { boundedContext: 'research', target: 'paper-application/research/gap-planner.mjs' },
  'research.evidence-ingestor': { boundedContext: 'research', target: 'paper-domain/research/evidence-ingestor.mjs' },
  'research.evidence-quality-gate': { boundedContext: 'research', target: 'paper-domain/research/evidence-quality-gate.mjs' },
  'research.experiment-registry': { boundedContext: 'research', target: 'paper-domain/research/experiment-registry.mjs' },
  'research.formal-verifier': { boundedContext: 'research', target: 'paper-ports/formal-verifier-port.mjs' },
  'research.change-proposal': { boundedContext: 'research', target: 'paper-domain/research/change-proposal.mjs' },
  'runtime.sandboxed-worker-runner': { boundedContext: 'runtime', target: 'paper-ports/worker-runner-port.mjs' },
  'runtime.artifact-repository': { boundedContext: 'runtime', target: 'paper-ports/artifact-repository-port.mjs' },
  'runtime.job-receipt-store': { boundedContext: 'runtime', target: 'paper-ports/job-receipt-store-port.mjs' },
  'submission.executor-port': { boundedContext: 'submission', target: 'paper-ports/submission-executor-port.mjs' },
  'submission.delivery-runtime': { boundedContext: 'submission', target: 'paper-domain/submission/delivery-runtime.mjs' },
  'submission.release-lock': { boundedContext: 'submission', target: 'paper-domain/submission/release-lock.mjs' },
  'repair.safe-apply': { boundedContext: 'repair', target: 'paper-adapters/referee-revise/repair-executor.mjs' },
});

function conformanceTestPath(capabilityId) {
  return `migration/tests/capabilities/${capabilityId}.test.mjs`;
}

function capabilityIdsFor(entry, decision) {
  const sourcePath = entry.source.path;
  if (decision === CAPABILITY_DECISIONS.PERMANENT_RETIREMENT) return [];
  if (/runner_execution_contract/.test(sourcePath)) {
    return ['runtime.job-receipt-store', 'runtime.artifact-repository'];
  }
  if (/external_submission_handoff_bundle/.test(sourcePath)) {
    return ['submission.executor-port', 'submission.delivery-runtime'];
  }
  if (/external_submission|portal_capability|submission_(handoff|lifecycle|intake)|external_auth|release_lock/.test(sourcePath)) {
    return ['submission.delivery-runtime', 'submission.release-lock'];
  }
  if (/formal_verifier|theorem_proof|lean_/.test(sourcePath)) {
    return ['research.formal-verifier', 'runtime.sandboxed-worker-runner', 'runtime.artifact-repository'];
  }
  if (/source_apply|patch_queue|manuscript_patch|merge|candidate_note|source_(gate|authorization|post_apply)/.test(sourcePath)) {
    return ['research.change-proposal', 'repair.safe-apply', 'runtime.artifact-repository'];
  }
  if (/experiment|benchmark|dataset/.test(sourcePath)) {
    return ['research.experiment-registry', 'research.evidence-quality-gate'];
  }
  if (/evidence|certificate/.test(sourcePath)) {
    return ['research.evidence-ingestor', 'research.evidence-quality-gate', 'runtime.artifact-repository'];
  }
  if (/gap|bridge|claim|candidate|planner|plan/.test(sourcePath)) {
    return ['research.claim-registry', 'research.gap-planner', 'runtime.job-receipt-store'];
  }
  if (/research_compute_executor/.test(sourcePath)) {
    return ['runtime.sandboxed-worker-runner', 'runtime.job-receipt-store'];
  }
  return ['research.claim-registry', 'research.evidence-quality-gate'];
}

function decisionFor(entry) {
  if (PERMANENT_RETIREMENT_ACTIONS.has(entry.migrationAction)) {
    return CAPABILITY_DECISIONS.PERMANENT_RETIREMENT;
  }
  if (SUPERSEDED_ACTIONS.has(entry.migrationAction)) {
    return CAPABILITY_DECISIONS.SUPERSEDED_WITH_COVERAGE;
  }
  return CAPABILITY_DECISIONS.CAPABILITY_REIMPLEMENTATION;
}

function coverageRequirements(decision, capabilityIds) {
  if (decision === CAPABILITY_DECISIONS.PERMANENT_RETIREMENT) {
    return ['source_hash_bound', 'public_symbols_inventoried', 'production_reference_absent', 'owner_acceptance_required'];
  }
  return [
    'source_hash_bound',
    'capability_contract_test',
    'negative_side_effect_test',
    'target_hash_bound',
    'owner_acceptance_required',
    ...capabilityIds.map((id) => `capability:${id}`),
  ];
}

function capabilityTargets(capabilityIds) {
  return capabilityIds.map((id) => {
    const catalog = CAPABILITY_CATALOG[id];
    const absoluteTarget = path.join(workspaceRoot, catalog.target);
    return {
      id,
      ...catalog,
      sha256: fs.existsSync(absoluteTarget) ? sha256File(absoluteTarget) : null,
    };
  });
}

function ownerAcceptanceMap(runtimeRoot) {
  if (!runtimeRoot) return new Map();
  try {
    const document = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'owner-acceptance', 'CAPABILITY_OWNER_ACCEPTANCE.json'), 'utf8'));
    const trustStore = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'owner-acceptance', 'OWNER_TRUST_STORE.json'), 'utf8'));
    if (document?.kind !== 'CapabilityOwnerAcceptance' || document?.version !== 1) return new Map();
    const verification = verifyAuthoritySignatures({
      document,
      trustStore,
      requiredRoles: ['capability_owner'],
      minSignatures: 1,
    });
    if (!verification.cryptographicSignaturesVerified) return new Map();
    const evidenceHash = hashRecord('CapabilityOwnerAcceptance', document);
    return new Map((document.acceptedEntries || []).map((entry) => [entry.legacyMatrixEntryId, {
      ...entry,
      evidenceHash,
      subjectId: verification.verifiedSubjectIds[0] || null,
    }]));
  } catch {
    return new Map();
  }
}

function coverageTests(entry, decision, capabilityIds) {
  const legacyTests = (entry.behaviorTests || []).map((test) => ({
    ...test,
    coverageClass: 'legacy_disposition_or_differential',
  }));
  if (decision === CAPABILITY_DECISIONS.PERMANENT_RETIREMENT) return legacyTests;
  return [
    ...legacyTests,
    ...capabilityIds.map((capabilityId) => {
      const testPath = conformanceTestPath(capabilityId);
      return {
        id: `conformance:${capabilityId}`,
        capabilityId,
        path: testPath,
        sha256: sha256File(path.join(workspaceRoot, testPath)),
        coverageClass: decision === CAPABILITY_DECISIONS.SUPERSEDED_WITH_COVERAGE
          ? 'capability_specific_gap_or_differential'
          : 'capability_specific_conformance',
      };
    }),
  ];
}

export function buildLegacyCapabilityMatrixV3({ matrixV2 = null, operationalEvidence = null, runtimeRoot = null } = {}) {
  const source = matrixV2 || JSON.parse(fs.readFileSync(matrixV2Path, 'utf8'));
  const verificationReceipts = validateCapabilityOperationalEvidence({
    runtimeRoot: runtimeRoot || path.join(workspaceRoot, 'runtime'),
    evidence: operationalEvidence,
  });
  const acceptedById = ownerAcceptanceMap(runtimeRoot || path.join(workspaceRoot, 'runtime'));
  const retiredEntries = source.entries.filter((entry) => entry.verificationClass === 'explicit_retirement');
  const entries = retiredEntries.map((entry) => {
    const businessDecision = decisionFor(entry);
    const capabilityIds = capabilityIdsFor(entry, businessDecision);
    const implementationReceipts = capabilityIds
      .map((id) => verificationReceipts.get(id))
      .filter(Boolean);
    const implementationVerified = businessDecision !== CAPABILITY_DECISIONS.PERMANENT_RETIREMENT
      && implementationReceipts.length === capabilityIds.length;
    const operationallyProven = implementationVerified && implementationReceipts.every((receipt) => (
      receipt.operationalProof === true
      && Array.isArray(receipt.operationalReceiptHashes)
      && receipt.operationalReceiptHashes.length > 0
    ));
    const ownerAcceptance = acceptedById.get(entry.id) || null;
    const ownerAccepted = Boolean(ownerAcceptance
      && ownerAcceptance.businessDecision === businessDecision
      && ownerAcceptance.sourceSha256 === entry.source.sha256);
    return {
      id: `v3-${entry.id}`,
      legacyMatrixEntryId: entry.id,
      source: entry.source,
      priorDisposition: entry.migrationAction,
      businessDecision,
      capabilityIds,
      capabilityTargets: capabilityTargets(capabilityIds),
      decision_mapped: {
        satisfied: true,
        status: 'decision_mapped',
        decision: businessDecision,
      },
      contract_defined: {
        satisfied: businessDecision === CAPABILITY_DECISIONS.PERMANENT_RETIREMENT
          || capabilityIds.every((id) => fs.existsSync(path.join(workspaceRoot, CAPABILITY_CATALOG[id].target))),
        status: businessDecision === CAPABILITY_DECISIONS.PERMANENT_RETIREMENT
          ? 'retirement_contract_defined'
          : 'capability_contract_defined',
      },
      implementation_verified: {
        applicable: businessDecision !== CAPABILITY_DECISIONS.PERMANENT_RETIREMENT,
        satisfied: implementationVerified,
        status: businessDecision === CAPABILITY_DECISIONS.PERMANENT_RETIREMENT
          ? 'not_applicable_permanent_retirement'
          : implementationVerified
            ? 'executed_capability_receipts_verified'
            : 'executed_capability_receipts_missing_or_invalid',
        capabilityReceiptHashes: implementationReceipts.map((receipt) => receipt.capabilityVerificationReceiptHash),
        ledgerReceiptIds: implementationReceipts.map((receipt) => receipt.ledgerReceiptId),
        testResults: implementationReceipts.map((receipt) => ({
          capabilityId: receipt.capabilityId,
          result: receipt.test.result,
          testHash: receipt.test.sha256,
          targetHashes: receipt.targets.map((target) => target.sha256),
        })),
      },
      operationally_proven: {
        applicable: businessDecision !== CAPABILITY_DECISIONS.PERMANENT_RETIREMENT,
        satisfied: operationallyProven,
        status: businessDecision === CAPABILITY_DECISIONS.PERMANENT_RETIREMENT
          ? 'not_applicable_permanent_retirement'
          : operationallyProven
            ? 'production_bound_operational_receipts_verified'
            : 'production_bound_operational_receipts_pending',
        operationalReceiptHashes: implementationReceipts.flatMap((receipt) => receipt.operationalReceiptHashes || []),
      },
      owner_accepted: {
        required: true,
        satisfied: ownerAccepted,
        status: ownerAccepted ? 'cryptographically_verified_owner_acceptance' : 'pending_owner_acceptance',
        subjectId: ownerAccepted ? ownerAcceptance.subjectId : null,
        acceptedAt: ownerAccepted ? ownerAcceptance.acceptedAt : null,
        evidenceHash: ownerAccepted ? ownerAcceptance.evidenceHash : null,
      },
      coverageRequirements: coverageRequirements(businessDecision, capabilityIds),
      coverageTests: coverageTests(entry, businessDecision, capabilityIds),
    };
  });
  const byDecision = Object.fromEntries(Object.values(CAPABILITY_DECISIONS).map((decision) => [
    decision,
    entries.filter((entry) => entry.businessDecision === decision).length,
  ]));
  return {
    version: 3,
    kind: 'LegacyCapabilityMigrationMatrix',
    sourceMatrixVersion: source.version,
    policy: {
      sourceFilesAreNotCapabilities: true,
      lineForLineMigrationForbidden: true,
      legacyRuntimeImportsForbidden: true,
      ownerAcceptanceRequiredForRetirement: true,
      capabilityCoverageRequiredForSupersession: true,
      implementationVerificationRequiresExecutedReceipt: true,
      operationalProofCannotBeInferredFromConformance: true,
    },
    capabilityCatalog: CAPABILITY_CATALOG,
    summary: {
      entryCount: entries.length,
      byDecision,
      decisionMapped: entries.filter((entry) => entry.decision_mapped.satisfied).length,
      contractsDefined: entries.filter((entry) => entry.contract_defined.satisfied).length,
      implementationVerified: entries.filter((entry) => entry.implementation_verified.satisfied).length,
      implementationNotApplicable: entries.filter((entry) => !entry.implementation_verified.applicable).length,
      operationallyProven: entries.filter((entry) => entry.operationally_proven.satisfied).length,
      operationallyNotProven: entries.filter((entry) => entry.operationally_proven.applicable && !entry.operationally_proven.satisfied).length,
      ownerAccepted: entries.filter((entry) => entry.owner_accepted.satisfied).length,
      ownerAcceptancePending: entries.filter((entry) => !entry.owner_accepted.satisfied).length,
      uniqueCapabilityCount: new Set(entries.flatMap((entry) => entry.capabilityIds)).size,
    },
    entries,
  };
}

export const LEGACY_CAPABILITY_MATRIX_V3 = buildLegacyCapabilityMatrixV3();
