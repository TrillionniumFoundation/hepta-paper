import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import crypto from 'node:crypto';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { buildVenueObservationSubject, verifyReviewedVenueObservationSource } from '../../paper-adapters/submission/venue-observation-verification.mjs';
import { buildExperimentExecutionContract, buildExperimentOutputManifest } from '../../paper-domain/research/experiment-evidence-binding.mjs';
import { buildExperimentAcceptanceContract } from '../../paper-domain/research/experiment-profiles.mjs';
import { buildFormalClaimBindingsManifest, buildFormalExecutionContract, buildFormalSourceManifest } from '../../paper-domain/research/formal-certificate-intake.mjs';
import { resolveReceiptIssuerPolicy } from '../../paper-domain/evidence/receipt-issuer-policy-registry.mjs';

export const h = (character) => `sha256:${character.repeat(64)}`;

const STREAM_BY_KIND = Object.freeze({
  ArtifactWriteReceipt: 'artifact-writes',
  ExperimentWorkerExecutionReceipt: 'experiment-workers',
  ExperimentReproducibilityReceipt: 'experiment-reproducibility',
  FormalVerifierAdapterReceipt: 'formal-verifier-adapters',
  FormalVerifierExecutionReceipt: 'formal-verifier-executions',
});

const WRITER_KIND_BY_KIND = Object.freeze({
  ArtifactWriteReceipt: 'content-addressed-repository',
  ExperimentWorkerExecutionReceipt: 'experiment-worker',
  ExperimentReproducibilityReceipt: 'experiment-reproducibility-verifier',
  FormalVerifierAdapterReceipt: 'formal-adapter-bootstrap',
  FormalVerifierExecutionReceipt: 'formal-verifier-runner',
});

const POLICY_BY_KIND = Object.freeze({
  ArtifactWriteReceipt: 'artifact-repository',
  ExperimentWorkerExecutionReceipt: 'experiment-worker',
  ExperimentReproducibilityReceipt: 'experiment-reproducibility',
  FormalVerifierAdapterReceipt: 'formal-adapter-bootstrap',
  FormalVerifierExecutionReceipt: 'formal-verifier-runner',
});

export function createMemoryReceiptLedger() {
  const rows = new Map();
  let counter = 0;
  return {
    add(receipt) {
      const ledgerReceiptId = `test-ledger:${++counter}:${receipt.kind}`;
      const receiptHash = receipt.writeReceiptHash || receipt.receiptHash || receipt.jobReceiptHash;
      const policyId = POLICY_BY_KIND[receipt.kind];
      const policy = resolveReceiptIssuerPolicy(policyId);
      if (!policy) throw new Error(`trusted_test_receipt_policy_missing:${receipt.kind}`);
      rows.set(ledgerReceiptId, { receipt_id: ledgerReceiptId, receipt_sha256: receiptHash, receipt_json: JSON.stringify(receipt), kind: receipt.kind, status: receipt.status || 'recorded', stream: STREAM_BY_KIND[receipt.kind] || 'test', writer_id: policy.writerId, writer_kind: WRITER_KIND_BY_KIND[receipt.kind] || policy.writerKind, writer_trusted: 1, issuer_policy_id: policyId, issuer_policy_hash: policy.issuerPolicyHash, issuer_assurance: policy.assurance });
      return { ...receipt, ledgerReceiptId };
    },
    get(id) { return rows.get(id) || null; },
    record(receipt) { return this.add(receipt); },
    list() { return [...rows.values()]; },
  };
}

export function trustedFixtureArtifactVerifier({ receipt } = {}) {
  const valid = receipt?.kind === 'ArtifactWriteReceipt'
    && receipt?.writeReceiptHash === hashRecord('ArtifactWriteReceipt', Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'writeReceiptHash')));
  return { status: valid ? 'artifact_write_receipt_source_verified' : 'artifact_write_receipt_source_blocked', blockers: valid ? [] : ['fixture_artifact_receipt_invalid'] };
}

export function sealedReceipt(kind, payload, hashField = 'receiptHash') {
  return Object.freeze({ ...payload, version: payload.version || 1, kind, [hashField]: hashRecord(kind, { ...payload, version: payload.version || 1, kind }) });
}

export function artifactWriteReceipt({ path, hash, role = 'test-artifact', manifestHash = h('f') } = {}) {
  const payload = { version: 2, kind: 'ArtifactWriteReceipt', repositoryId: 'test-cas', role, contentType: 'application/json', path, bytes: 1, hash, contentAddress: hash, manifestHash, manifestPath: `manifests/${manifestHash.slice(7)}.json`, objectCreated: true, immutableObject: true, atomic: true, scopeRoot: '/test', casRoot: '/test/.cas', scopedWriteTargetIdentityHash: h('e'), createdAt: '2026-07-13T00:00:00.000Z', externalActionPerformed: false };
  return Object.freeze({ ...payload, writeReceiptHash: hashRecord('ArtifactWriteReceipt', payload) });
}

export function trustedExperimentFixture({ profileId = null, experimentId = 'trusted-experiment', runId = 'trusted-run-1', seed = 7 } = {}) {
  const ledger = createMemoryReceiptLedger();
  const datasetHash = h('1'); const codeHash = h('2'); const resultHash = h('3');
  const outputNames = ['agent-compute-manifest.json', 'metrics.json', 'experiment-summary.md', 'experiment-reproducibility.json'];
  const outputArtifacts = outputNames.map((name, index) => {
    const receipt = ledger.add(artifactWriteReceipt({ path: name, hash: h(String.fromCharCode(53 + index)), role: `experiment-output:${experimentId}:${runId}:${name}`, manifestHash: h(String.fromCharCode(97 + index)) }));
    const { ledgerReceiptId, ...artifactWriteReceiptValue } = receipt;
    return { name, artifactWriteReceipt: artifactWriteReceiptValue, ledgerReceiptId };
  });
  const resultReceipt = ledger.add(artifactWriteReceipt({ path: 'result.json', hash: resultHash, role: `experiment-result:${experimentId}:${runId}`, manifestHash: h('d') }));
  const { ledgerReceiptId: resultLedgerReceiptId, ...resultArtifactWriteReceipt } = resultReceipt;
  const outputArtifactHashes = outputArtifacts.map((item) => item.artifactWriteReceipt.hash).sort();
  const metricPredicates = profileId
    ? buildExperimentAcceptanceContract({ profileId }).metricPredicates
    : [{ metric: 'accuracy', comparator: '>=', threshold: 0 }];
  const datasetMounts = [{ name: 'fixture-dataset', manifestHash: h('4'), licenseId: 'CC-BY-4.0', readOnly: true }];
  const experiment = { experimentId, runId, acceptanceProfileId: profileId, datasetHash, codeHash, resultHash, resultPath: 'result.json', seed, datasetManifestHash: h('4'), datasetLicenseId: 'CC-BY-4.0', datasetReadOnly: true, datasetMounts, networkPolicy: 'none', secretsAllowed: false, externalActionsAllowed: false, providerCallsAllowed: false, sourceMutationAllowed: false, sourceReadOnlyRequired: true, ephemeralWorkRootRequired: true, separateOutputRootRequired: true, metricPredicates };
  const executionContract = buildExperimentExecutionContract({ experiment, requiredOutputs: outputNames });
  const outputManifest = buildExperimentOutputManifest({ experimentId, runId, outputArtifacts: outputArtifacts.map((item) => ({ name: item.name, path: item.artifactWriteReceipt.path, hash: item.artifactWriteReceipt.hash, manifestHash: item.artifactWriteReceipt.manifestHash, writeReceiptHash: item.artifactWriteReceipt.writeReceiptHash })) });
  const isolationReceiptHash = h('e');
  const sourceMerkleHash = h('f');
  const worker = ledger.add(sealedReceipt('ExperimentWorkerExecutionReceipt', { status: 'worker_execution_completed', experimentId, runId, datasetHash, codeHash, resultHash, seed: experiment.seed, executionContractHash: executionContract.experimentExecutionContractHash, datasetContractHash: executionContract.datasetContractHash, isolationPolicyHash: executionContract.isolationPolicyHash, metricPredicateContractHash: executionContract.metricPredicateContractHash, isolationReceiptHash, networkPolicy: 'none', secretAccessPerformed: false, externalActionPerformed: false, providerCallPerformed: false, sourceMutationDetected: false, sourceMerkleHashBefore: sourceMerkleHash, sourceMerkleHashAfter: sourceMerkleHash, isolation: { kernelNetworkIsolationVerified: true, sourceReadOnlyVerified: true, ephemeralWorkRootVerified: true, separateOutputRootVerified: true }, datasetMounts, outputManifestHash: outputManifest.experimentOutputManifestHash, resultArtifactWriteReceiptHash: resultArtifactWriteReceipt.writeReceiptHash }));
  const reproducibility = ledger.add(sealedReceipt('ExperimentReproducibilityReceipt', { status: 'experiment_reproducibility_verified', experimentId, runId, seed: experiment.seed, workerReceiptHash: worker.receiptHash, resultHash, outputArtifactHashes, executionContractHash: executionContract.experimentExecutionContractHash, datasetContractHash: executionContract.datasetContractHash, isolationPolicyHash: executionContract.isolationPolicyHash, metricPredicateContractHash: executionContract.metricPredicateContractHash, isolationReceiptHash, outputManifestHash: outputManifest.experimentOutputManifestHash }));
  return {
    ledger, artifactVerifier: trustedFixtureArtifactVerifier,
    artifact: {
      kind: 'experiment', experimentId, runId, acceptanceProfileId: profileId, requiredOutputs: outputNames,
      ...experiment, metric: 'accuracy',
      workerReceipt: worker,
      resultArtifact: { artifactWriteReceipt: resultArtifactWriteReceipt, ledgerReceiptId: resultLedgerReceiptId, outputArtifacts },
      reproducibilityReceipt: reproducibility,
    },
  };
}

export function trustedVenueFixture({ paperTask, venuePlan, observedState = 'accepting_submissions', purpose = 'submission_preflight' } = {}) {
  const ledger = createMemoryReceiptLedger();
  const artifact = ledger.add(artifactWriteReceipt({ path: 'venue/portal-state.json', hash: h('b'), role: 'venue-observation', manifestHash: h('c') }));
  const { ledgerReceiptId, ...artifactWriteReceiptValue } = artifact;
  const observation = {
    purpose,
    provider: 'portal-x', portalRoute: '/submit/manuscript', venueTarget: venuePlan?.venue?.name || venuePlan?.target,
    track: 'main', deadlineState: purpose === 'submission_preflight' ? 'open' : 'closed', observedState,
    observedAt: '2026-07-13T00:00:00.000Z', expiresAt: '2026-07-13T02:00:00.000Z', reviewedBy: 'venue-observer-1',
    evidenceHashes: [h('b')], evidenceRefs: [{ path: artifactWriteReceiptValue.path, hash: artifactWriteReceiptValue.hash, artifactWriteReceipt: artifactWriteReceiptValue, ledgerReceiptId }], fetchedPortalState: true,
  };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const trustStore = { version: 1, kind: 'AuthorityTrustStore', keys: [{ keyId: 'venue-key', subjectId: 'venue-observer-1', algorithm: 'ed25519', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), roles: ['venue_observer'], status: 'active' }] };
  const subject = buildVenueObservationSubject({ paperTask, venuePlan, observation });
  const signedObservation = signAuthorityDocument({ version: 1, kind: 'ReviewedVenueObservationAuthorization', observationSubjectHash: subject.reviewedVenueObservationSubjectHash, signedAt: '2026-07-13T00:00:00.000Z', validFrom: '2026-07-13T00:00:00.000Z', expiresAt: '2026-07-13T02:00:00.000Z' }, { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), keyId: 'venue-key', role: 'venue_observer' });
  const sourceVerificationReceipt = verifyReviewedVenueObservationSource({ paperTask, venuePlan, observation, signedObservation, receiptLedger: ledger, trustStore, now: new Date('2026-07-13T01:00:00Z'), artifactVerifier: trustedFixtureArtifactVerifier });
  return { ledger, observation, signedObservation, trustStore, sourceVerificationReceipt, artifactVerifier: trustedFixtureArtifactVerifier };
}

export function trustedFormalFixture({ verifierKind = 'coq', extension = '.v', command = 'coqc', certificateKind = 'CoqFormalCertificate' } = {}) {
  const ledger = createMemoryReceiptLedger();
  const adapterReceipt = ledger.add(sealedReceipt('FormalVerifierAdapterReceipt', { status: 'formal_verifier_adapter_verified', verifierKind, command, extension }));
  const certificateHash = h('9'); const sourceHash = h('b');
  const certificateArtifact = ledger.add(artifactWriteReceipt({ path: `certificate${extension}.json`, hash: certificateHash, role: 'formal-certificate', manifestHash: h('a') }));
  const sourceArtifact = ledger.add(artifactWriteReceipt({ path: `Proof${extension}`, hash: sourceHash, role: 'formal-source', manifestHash: h('c') }));
  const { ledgerReceiptId: certificateLedgerReceiptId, ...certificateWriteReceipt } = certificateArtifact;
  const { ledgerReceiptId: sourceLedgerReceiptId, ...sourceWriteReceipt } = sourceArtifact;
  const sourceRecords = [{ path: sourceWriteReceipt.path, hash: sourceHash, artifactWriteReceipt: sourceWriteReceipt, ledgerReceiptId: sourceLedgerReceiptId }];
  const claimBindings = [{ claimId: 'claim-1', obligationId: 'obl-1', statementHash: h('c') }];
  const sourceManifest = buildFormalSourceManifest({ verifierKind, sourceRecords });
  const claimBindingsManifest = buildFormalClaimBindingsManifest({ claimBindings });
  const executionContract = buildFormalExecutionContract({ verifierKind, command, certificateHash, toolchainHash: h('d'), sourceManifestHash: sourceManifest.formalSourceManifestHash, claimBindingsHash: claimBindingsManifest.formalClaimBindingsHash, certificateWriteReceiptHash: certificateWriteReceipt.writeReceiptHash, adapterReceiptHash: adapterReceipt.receiptHash });
  const sourceMerkleHash = h('e');
  const executionReceipt = ledger.add(sealedReceipt('FormalVerifierExecutionReceipt', { status: 'formal_verifier_execution_verified', verifierKind, certificateHash, sourceHashes: [sourceHash], sourceManifestHash: sourceManifest.formalSourceManifestHash, claimBindingsHash: claimBindingsManifest.formalClaimBindingsHash, certificateWriteReceiptHash: certificateWriteReceipt.writeReceiptHash, toolchainHash: h('d'), command, adapterReceiptHash: adapterReceipt.receiptHash, executionContractHash: executionContract.formalExecutionContractHash, isolationPolicyHash: executionContract.isolationPolicyHash, isolationReceiptHash: h('f'), networkPolicy: 'none', secretAccessPerformed: false, sourceMutationDetected: false, externalActionPerformed: false, providerCallPerformed: false, commitPerformed: false, sourceMerkleHashBefore: sourceMerkleHash, sourceMerkleHashAfter: sourceMerkleHash, isolation: { kernelNetworkIsolationVerified: true, sourceReadOnlyVerified: true, ephemeralWorkRootVerified: true, separateOutputRootVerified: true }, exitCode: 0, stdoutHash: h('1'), stderrHash: h('2'), runnerId: 'trusted-formal-runner', runnerDescriptorHash: h('3') }));
  return {
    ledger, adapterReceipt, executionReceipt, claimBindings, artifactVerifier: trustedFixtureArtifactVerifier,
    certificate: { kind: certificateKind, certificateHash, toolchainHash: h('d'), artifactWriteReceipt: certificateWriteReceipt, ledgerReceiptId: certificateLedgerReceiptId },
    sourceRecords,
  };
}
