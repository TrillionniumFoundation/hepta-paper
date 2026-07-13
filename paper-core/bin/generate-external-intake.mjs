#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildLegacyCapabilityMatrixV3 } from '../../migration/legacy-capability-matrix-v3.mjs';
import { bootstrapPaperExecutionContext } from '../../paper-composition/bootstrap/service-bootstrap.mjs';
import { withArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { capabilityTargetBindings } from '../../migration/operational-proof-intake.mjs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

process.env.HEPTA_EVIDENCE_ENVIRONMENT = 'administrative';
process.env.HEPTA_EVIDENCE_CLASS = 'external_intake';
const runtimeRoot = defaultPaperRuntimeRoot();
const root = defaultPaperAssetRoot();
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const matrix = buildLegacyCapabilityMatrixV3({ runtimeRoot });
const provenance = currentCodeProvenance();
const context = bootstrapPaperExecutionContext({ root, runtimeRoot, mode: 'external-intake-generation', execute: false, writeReport: true });

function sha256File(file) {
  return fs.existsSync(file)
    ? `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
    : null;
}

function boundRuntimeDocument(relative) {
  const file = path.join(runtimeRoot, relative);
  return { relative, present: fs.existsSync(file), sha256: sha256File(file) };
}

await withArtifactWriteContext(context.services, async () => {
  const outputRoot = path.join(runtimeRoot, 'external-intake');
  const repository = context.services.artifactRepositoryFactory(outputRoot);
  const ownerPayload = {
    version: 2,
    kind: 'CapabilityOwnerAcceptanceRequest',
    status: 'capability_family_owner_signature_required',
    codeProvenance: provenance,
    entryCount: matrix.entries.length,
    familyCount: matrix.ownerAcceptanceFamilyManifest.families.length,
    familyManifestHash: matrix.ownerAcceptanceFamilyManifest.familyManifestHash,
    acceptedFamiliesTemplate: matrix.ownerAcceptanceFamilyManifest.families.map((family) => ({
      familyId: family.familyId,
      familyHash: family.familyHash,
      businessDecision: family.businessDecision,
      capabilityIds: family.capabilityIds,
      legacyEntryCount: family.legacyEntries.length,
      acceptedAt: null,
    })),
    requiredOutput: 'runtime/owner-acceptance/CAPABILITY_OWNER_ACCEPTANCE.json',
    requiredTrustStore: 'runtime/owner-acceptance/OWNER_TRUST_STORE.json',
    requiredRole: 'capability_owner',
    allEntriesCoveredExactlyOnce: matrix.ownerAcceptanceFamilyManifest.families
      .flatMap((family) => family.legacyEntries).length === matrix.entries.length,
    automaticAcceptanceForbidden: true,
  };
  const authorityPayload = {
    version: 1,
    kind: 'AuthorityOnboardingPacket',
    status: 'external_public_keys_and_signed_documents_required',
    codeProvenance: provenance,
    requiredRoles: ['academic_evidence_authority', 'independent_referee', 'submission_operator', 'live_executor_authorizer'],
    trustStorePath: 'runtime/trust/AUTHORITY_TRUST_STORE.json',
    publicKeysOnly: true,
    privateKeysForbidden: true,
    requiredDocuments: ['ACADEMIC_EVIDENCE_ATTESTATION.json', 'INDEPENDENT_REFEREE_VERDICT.json', 'LIVE_SUBMISSION_AUTHORIZATION.json'],
    separationOfDutiesRequired: true,
  };
  const authorityTrustStoreTemplate = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: authorityPayload.requiredRoles.map((role) => ({
      keyId: null,
      subjectId: null,
      organization: null,
      algorithm: 'ed25519',
      publicKeyPem: null,
      roles: [role],
      status: 'active',
    })),
    privateKeysForbidden: true,
    distinctSubjectsRequired: true,
  };
  const ownerTrustStoreTemplate = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: ['capability_owner', 'operational_observer'].map((role) => ({
      keyId: null,
      subjectId: null,
      organization: null,
      assurance: 'external_independent',
      independentExternalAuthority: true,
      algorithm: 'ed25519',
      publicKeyPem: null,
      roles: [role],
      status: 'active',
    })),
    privateKeysForbidden: true,
    distinctSubjectsRequired: true,
  };
  const ownerAcceptanceTemplate = {
    version: 2,
    kind: 'CapabilityOwnerAcceptance',
    familyManifestHash: matrix.ownerAcceptanceFamilyManifest.familyManifestHash,
    acceptedFamilies: ownerPayload.acceptedFamiliesTemplate,
    acceptedAt: null,
    signatures: [],
  };
  const targetBindings = capabilityTargetBindings(workspaceRoot, matrix.capabilityCatalog);
  const operationalPayload = {
    version: 1,
    kind: 'CapabilityOperationalProofPlan',
    status: 'production_bound_receipts_required',
    codeProvenance: provenance,
    applicableEntryCount: matrix.summary.operationallyNotProven + matrix.summary.operationallyProven,
    currentlyProven: matrix.summary.operationallyProven,
    capabilities: Object.keys(matrix.capabilityCatalog).sort().map((capabilityId) => ({
      capabilityId,
      legacyEntryCount: matrix.entries.filter((entry) => entry.capabilityIds.includes(capabilityId)).length,
      targetHashes: targetBindings[capabilityId],
      requiredEvidence: ['production_subject', 'production_input_hashes', 'production_execution_receipt', 'result_hash', 'replay_receipt_hash', 'replay_matched', 'release_commit', 'capability_owner_signature', 'independent_operational_observer_signature'],
      requiredOutputDirectory: `runtime/operational-proof/capabilities/${capabilityId}`,
    })),
    conformanceReceiptsCannotQualify: true,
  };
  const operationalReceiptTemplates = {
    version: 1,
    kind: 'CapabilityOperationalReceiptTemplateSet',
    releaseCommit: provenance.commit,
    templates: operationalPayload.capabilities.map((capability) => ({
      version: 2,
      kind: 'CapabilityOperationalReceipt',
      capabilityId: capability.capabilityId,
      status: 'production_runtime_observation_verified',
      executionClass: 'production_runtime_observation',
      evidenceEnvironment: 'production',
      evidenceClass: 'operational',
      productionEligible: true,
      productionSubject: { paperId: null, subjectId: null },
      inputHashes: [],
      executionReceiptHash: null,
      resultHash: null,
      replayReceiptHash: null,
      replayMatched: true,
      releaseCommit: provenance.commit,
      targetHashes: capability.targetHashes,
      signatures: [],
    })),
    syntheticOrConformanceEvidenceForbidden: true,
  };
  const paperId = 'A_Theory_of__Expectations';
  const mainTex = path.join(root, 'submission', 'AoM', paperId, 'main.tex');
  const productionChainPayload = {
    version: 1,
    kind: 'RealPaperProductionChainRequest',
    status: 'external_authorities_and_evidence_required',
    codeProvenance: provenance,
    paperId,
    subject: {
      mainTex: path.relative(root, mainTex),
      mainTexPresent: fs.existsSync(mainTex),
      mainTexHash: sha256File(mainTex),
      nativeWorkerPilot: boundRuntimeDocument(`pilots/${paperId}/REAL_PAPER_END_TO_END_PILOT_RECEIPT.json`),
      providerSandboxPilot: boundRuntimeDocument(`pilots/${paperId}/REAL_PAPER_PROVIDER_SANDBOX_RECEIPT.json`),
    },
    requiredSequence: [
      'production_bound_academic_evidence_attestation',
      'independent_referee_verdict',
      'submission_operator_authorization',
      'live_executor_authorization',
      'external_provider_receipt',
      'provider_reconciliation_and_release',
    ],
    requiredRoles: ['academic_evidence_authority', 'independent_referee', 'submission_operator', 'live_executor_authorizer'],
    separationOfDutiesRequired: true,
    privateKeysForbiddenInRepository: true,
    syntheticOrInternalSignaturesForbidden: true,
    productionExecutorRequiredOutsideRepository: true,
    externalActionAuthorizedByThisPacket: false,
    requiredOutputDirectory: `runtime/authority-inbox/${paperId}`,
  };
  const offhostWormContractPath = path.join(workspaceRoot, 'paper-core', 'config', 'offhost-worm-contract.v1.json');
  const offhostWormPayload = {
    version: 1,
    kind: 'OffhostWormOnboardingPacket',
    status: 'external_distinct_device_and_operator_required',
    codeProvenance: provenance,
    contractPath: path.relative(workspaceRoot, offhostWormContractPath),
    contractHash: sha256File(offhostWormContractPath),
    currentProtectionLevel: 'same_host_external_disk',
    offHostOrOffsiteCustodyQualified: false,
    requiredProperties: [
      'distinct_filesystem_device',
      'filesystem_immutable_objects',
      'restore_drill',
      'offline_detachment_or_object_lock_receipt',
      'independent_custody_attestation',
    ],
    requiredCommandSequence: ['npm run offhost:worm-status', 'npm run offhost:worm-snapshot -- --execute', 'npm run offhost:worm-restore-drill -- --manifest <path>'],
    internalFallbackForbidden: true,
    connectedSameHostDiskInsufficientForOffsiteQualification: true,
    completionInferredFromPacket: false,
  };
  const outputs = [];
  for (const [name, payload, role] of [
    ['OWNER_ACCEPTANCE_REQUEST.json', ownerPayload, 'owner_acceptance_request'],
    ['AUTHORITY_ONBOARDING_PACKET.json', authorityPayload, 'authority_onboarding_packet'],
    ['AUTHORITY_TRUST_STORE_TEMPLATE.json', authorityTrustStoreTemplate, 'authority_trust_store_template'],
    ['OWNER_TRUST_STORE_TEMPLATE.json', ownerTrustStoreTemplate, 'owner_trust_store_template'],
    ['CAPABILITY_OWNER_ACCEPTANCE_TEMPLATE.json', ownerAcceptanceTemplate, 'owner_acceptance_template'],
    ['OPERATIONAL_PROOF_PLAN.json', operationalPayload, 'operational_proof_plan'],
    ['OPERATIONAL_RECEIPT_TEMPLATES.json', operationalReceiptTemplates, 'operational_receipt_templates'],
    ['REAL_PAPER_PRODUCTION_CHAIN_REQUEST.json', productionChainPayload, 'real_paper_production_chain_request'],
    ['OFFHOST_WORM_ONBOARDING_PACKET.json', offhostWormPayload, 'offhost_worm_onboarding_packet'],
  ]) {
    const bound = { ...payload, documentHash: hashRecord(payload.kind, payload) };
    outputs.push(await repository.writeJson(path.join(outputRoot, name), bound, { role }));
  }
  process.stdout.write(`${JSON.stringify({
    status: 'external_intake_packets_generated',
    outputRoot,
    ownerAccepted: matrix.summary.ownerAccepted,
    operationallyProven: matrix.summary.operationallyProven,
    writeReceiptHashes: outputs.map((receipt) => receipt.writeReceiptHash),
  }, null, 2)}\n`);
});
