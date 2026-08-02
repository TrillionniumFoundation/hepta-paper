#!/usr/bin/env node
import path from 'node:path';
import { CAPABILITY_CATALOG } from '../legacy-capability-matrix-v3.mjs';
import {
  assertProductionCapabilityRefreshCodeProvenance,
  executeCapabilityVerification,
} from '../capability-operational-evidence.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import {
  issueProductionCapabilityArtifactWriter,
  issueProductionCapabilityVerifierWriter,
} from '../../paper-adapters/persistence/receipt-writer-broker.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../../paper-adapters/runtime/workspace-layout.mjs';

if (!process.argv.includes('--execute')) {
  throw new Error('production capability verification refresh requires --execute');
}

const root = defaultPaperAssetRoot();
const runtimeRoot = defaultPaperRuntimeRoot();
const inheritedReleaseCommit = process.env.HEPTA_RELEASE_COMMIT || null;
process.env.HEPTA_EVIDENCE_ENVIRONMENT = 'production_source_bound';
process.env.HEPTA_EVIDENCE_CLASS = 'release_conformance';
const codeProvenanceProvider = () => currentCodeProvenance({
  allowReleaseCommitEnvironment: false,
});
const codeProvenance = assertProductionCapabilityRefreshCodeProvenance({
  codeProvenance: codeProvenanceProvider(),
  declaredReleaseCommit: inheritedReleaseCommit,
});
const releaseCommit = codeProvenance.commit;

process.env.HEPTA_RELEASE_COMMIT = releaseCommit;

const clock = createSystemClock();
const store = createDefaultPaperStore({ root, runtimeRoot });
const capabilityLedger = createSqliteReceiptLedger({
  store,
  clock,
  issuerCapability: issueProductionCapabilityVerifierWriter(),
});
const artifactLedger = createSqliteReceiptLedger({
  store,
  clock,
  issuerCapability: issueProductionCapabilityArtifactWriter(),
});
const repositoryFactory = (scopeRoot) => createFilesystemArtifactRepository({
  scopeRoot,
  casRoot: path.join(runtimeRoot, 'artifact-cas'),
  repositoryId: 'production-capability-verification-cas',
  receiptLedger: artifactLedger,
  clock,
});

const result = await executeCapabilityVerification({
  runtimeRoot,
  receiptLedger: capabilityLedger,
  artifactRepositoryFactory: repositoryFactory,
  clock,
  capabilityCatalog: CAPABILITY_CATALOG,
  codeProvenance,
  codeProvenanceProvider,
  requireCleanCodeProvenance: true,
});
if (result.manifest.status !== 'capability_verification_complete') {
  throw new Error(`capability verification refresh blocked:${result.manifest.status}`);
}
store.close?.();
process.stdout.write(`${JSON.stringify({
  status: result.manifest.status,
  capabilityCount: result.manifest.capabilityCount,
  conformanceBoundCount: result.manifest.receipts.filter((receipt) => receipt.conformanceProof).length,
  operationallyBoundCount: result.manifest.receipts.filter((receipt) => receipt.operationalProof).length,
  operationalProofPending: result.manifest.receipts.filter((receipt) => !receipt.operationalProof).map((receipt) => receipt.capabilityId),
  manifestHash: result.manifest.capabilityVerificationManifestHash,
  auditWriteReceiptHash: result.writeReceipt.writeReceiptHash,
  releaseCurrentPublication: 'deferred_to_signed_isolated_verification_pointer',
  releaseCommit,
}, null, 2)}\n`);
