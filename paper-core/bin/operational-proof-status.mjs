#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITY_CATALOG } from '../../migration/legacy-capability-matrix-v3.mjs';
import { loadCapabilityOperationalProofs } from '../../migration/operational-proof-intake.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const proofs = loadCapabilityOperationalProofs({
  runtimeRoot: defaultPaperRuntimeRoot(),
  workspaceRoot,
  capabilityCatalog: CAPABILITY_CATALOG,
  releaseCommit: currentCodeProvenance().commit,
});
const capabilities = Object.keys(CAPABILITY_CATALOG).sort().map((capabilityId) => ({
  capabilityId,
  operationallyProven: proofs.has(capabilityId),
  operationalReceiptHashes: proofs.get(capabilityId)?.operationalReceiptHashes || [],
}));
process.stdout.write(`${JSON.stringify({
  version: 1,
  kind: 'CapabilityOperationalProofStatus',
  status: capabilities.every((item) => item.operationallyProven)
    ? 'all_capabilities_operationally_proven'
    : 'capability_operational_proof_pending',
  releaseCommit: currentCodeProvenance().commit,
  capabilityCount: capabilities.length,
  operationallyProven: capabilities.filter((item) => item.operationallyProven).length,
  operationallyPending: capabilities.filter((item) => !item.operationallyProven).length,
  externalOwnerSignatureRequired: true,
  capabilities,
}, null, 2)}\n`);
