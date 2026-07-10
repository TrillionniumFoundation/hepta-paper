#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildLegacyCapabilityMatrixV3 } from '../../migration/legacy-capability-matrix-v3.mjs';
import { bootstrapPaperExecutionContext } from '../../paper-application/bootstrap/service-bootstrap.mjs';
import { withArtifactWriteContext } from '../../paper-adapters/artifacts/artifact-write-context.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

process.env.HEPTA_EVIDENCE_ENVIRONMENT = 'administrative';
process.env.HEPTA_EVIDENCE_CLASS = 'external_intake';
const runtimeRoot = defaultPaperRuntimeRoot();
const root = defaultPaperAssetRoot();
const matrix = buildLegacyCapabilityMatrixV3({ runtimeRoot });
const provenance = currentCodeProvenance();
const context = bootstrapPaperExecutionContext({ root, runtimeRoot, mode: 'external-intake-generation', execute: false, writeReport: true });
await withArtifactWriteContext(context.services, async () => {
  const outputRoot = path.join(runtimeRoot, 'external-intake');
  const repository = context.services.artifactRepositoryFactory(outputRoot);
  const ownerPayload = {
    version: 1,
    kind: 'CapabilityOwnerAcceptanceRequest',
    status: 'owner_signature_required',
    codeProvenance: provenance,
    entryCount: matrix.entries.length,
    acceptedEntriesTemplate: matrix.entries.map((entry) => ({
      legacyMatrixEntryId: entry.legacyMatrixEntryId,
      sourceSha256: entry.source.sha256,
      businessDecision: entry.businessDecision,
      capabilityIds: entry.capabilityIds,
      acceptedAt: null,
    })),
    requiredOutput: 'runtime/owner-acceptance/CAPABILITY_OWNER_ACCEPTANCE.json',
    requiredTrustStore: 'runtime/owner-acceptance/OWNER_TRUST_STORE.json',
    requiredRole: 'capability_owner',
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
      requiredEvidence: ['production_input_hashes', 'production_execution_receipt', 'result_hash', 'replay_result', 'release_commit'],
    })),
    conformanceReceiptsCannotQualify: true,
  };
  const outputs = [];
  for (const [name, payload, role] of [
    ['OWNER_ACCEPTANCE_REQUEST.json', ownerPayload, 'owner_acceptance_request'],
    ['AUTHORITY_ONBOARDING_PACKET.json', authorityPayload, 'authority_onboarding_packet'],
    ['OPERATIONAL_PROOF_PLAN.json', operationalPayload, 'operational_proof_plan'],
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
