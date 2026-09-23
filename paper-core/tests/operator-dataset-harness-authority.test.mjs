import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import {
  authorizeOperatorDatasetMount,
  readOperatorDatasetHarness,
} from '../../paper-adapters/automation/operator-dataset-harness-reader.mjs';
import { createOperatorDatasetHarnessAuthorityReceiptVerifier } from '../../paper-adapters/automation/operator-dataset-harness-authority-receipt-verifier.mjs';
import {
  inspectStrictDatasetManifest,
  materializeDatasetSnapshot,
} from '../../paper-adapters/runtime/execution-snapshot.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { buildCanonicalAnalysisProtocol } from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import { buildCampaignBenchmarkSchedule, buildDatasetAuthorizationSet } from '../../paper-domain/automation/experiment-run-contract.mjs';
import {
  validateOperatorDatasetHarnessDefinition,
  validateOperatorDatasetAuthorityDocument,
  validateOperatorDatasetSplitManifest,
  verifyOperatorDatasetHarnessAuthorityReceiptStructure,
} from '../../paper-domain/automation/operator-dataset-harness-contract.mjs';
import { buildBatchCampaignCommand } from '../../paper-application/automation/batch-campaign-command.mjs';
import { campaignNodeOperation } from '../../paper-application/automation/campaign-node-execution-context.mjs';
import { createExperimentRegistryAuthorityVerifier } from '../../paper-domain/research/experiment-registry-authority.mjs';
import { buildPaperBatchCliOptions, parsePaperProductionArgs } from '../src/paper-production-cli-options.mjs';
import { buildDatasetRuntimeAccessReceipt } from '../../paper-adapters/runtime/dataset-runtime-access-receipt.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createSystemBenchmarkPrimitiveFixtureResolver } from '../../paper-adapters/research-verify/system-benchmark-primitive-fixture-resolver.mjs';
import { buildSystemBenchmarkCellChallenge } from '../../paper-domain/automation/system-benchmark-challenge.mjs';

const NOW = '2026-07-15T01:00:00.000Z';
const EXPIRES = '2026-07-22T01:00:00.000Z';

function harnessDefinition(name, { minimumRepetitions = 7 } = {}) {
  const seedSchedule = [17, 23, 31, 43, 59];
  return {
    version: 1,
    kind: 'OperatorAuthorizedDatasetBenchmarkHarness',
    benchmarkId: name,
    benchmarkFamily: 'ml_algorithm_benchmark',
    seedSchedule,
    minimumRepetitions,
    cells: seedSchedule.flatMap((seed) => Array.from({ length: minimumRepetitions }, (_, index) => ({
      seed,
      repetition: index + 1,
      cases: Array.from({ length: 8 }, (_, caseIndex) => ({
        caseId: hashRecord('OperatorDatasetHarnessTestCase', { seed, repetition: index + 1, caseIndex }),
        input: { primary: seed + caseIndex, secondary: index - caseIndex },
        ablationInput: { primary: seed, secondary: index },
        referenceResponse: caseIndex % 2,
        oracle: { label: caseIndex % 2, robustLabel: (caseIndex + 1) % 2 },
      })),
    }))),
  };
}

function authorityFixture(t, {
  envelopeInsideDataset = false,
  visibleTestSplit = false,
  legacyProtocol = false,
  analysisHypotheses = null,
  minimumRepetitions = 7,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-operator-dataset-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const datasetRoot = path.join(root, 'dataset');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(datasetRoot, { recursive: true });
  fs.writeFileSync(path.join(datasetRoot, 'train.csv'), 'feature,label\n1,0\n');
  fs.writeFileSync(path.join(datasetRoot, 'public.json'), '{"feature":1}\n');
  const inspection = inspectStrictDatasetManifest(datasetRoot, datasetRoot);
  assert.deepEqual(inspection.blockers, []);
  const name = 'operator-dataset';
  const definition = harnessDefinition(name, { minimumRepetitions });
  const definitionHash = validateOperatorDatasetHarnessDefinition(definition, { benchmarkId: name }).operatorDatasetHarnessDefinitionHash;
  const repositoryDesign = buildCampaignBenchmarkSelector({ benchmarkId: definition.benchmarkFamily }).experimentDesign;
  const builtAnalysisProtocol = buildCanonicalAnalysisProtocol({
    benchmarkId: name,
    benchmarkFamily: definition.benchmarkFamily,
    requiredMetrics: repositoryDesign.requiredMetrics,
    metricSpecs: repositoryDesign.metricSpecs,
    hypotheses: analysisHypotheses,
  });
  const { analysisProtocolHash, ...analysisProtocol } = builtAnalysisProtocol;
  const splitManifest = {
    version: 1,
    kind: 'OperatorDatasetSplitManifest',
    datasetName: name,
    datasetManifestHash: inspection.hash,
    entries: inspection.entries.filter((entry) => entry.type === 'file').map((entry, index) => ({
      path: entry.relative,
      sha256: entry.hash,
      split: visibleTestSplit && index === 0 ? 'test' : index === 0 ? 'train' : 'public',
    })),
  };
  let splitManifestHash = null;
  try { splitManifestHash = validateOperatorDatasetSplitManifest(splitManifest, { datasetName: name, datasetManifestHash: inspection.hash }).operatorDatasetSplitManifestHash; }
  catch (error) {
    return { root, runtimeRoot, datasetRoot, inspection, name, definition, splitManifest, validationError: error };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const authority = signAuthorityDocument({
    version: legacyProtocol ? 1 : 2,
    kind: 'OperatorDatasetHarnessAuthority',
    datasetName: name,
    datasetManifestHash: inspection.hash,
    datasetLicenseId: 'CC-BY-4.0',
    datasetSplitManifestHash: splitManifestHash,
    benchmarkHarnessDefinitionHash: definitionHash,
    ...(!legacyProtocol ? { analysisProtocolHash } : {}),
    benchmarkFamily: 'ml_algorithm_benchmark',
    seedSchedule: definition.seedSchedule,
    minimumRepetitions: definition.minimumRepetitions,
    workerExposurePolicy: 'signed-complete-dataset-file-manifest-v1',
    signedAt: NOW,
    expiresAt: EXPIRES,
  }, {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    keyId: 'dataset-harness-key',
    role: 'dataset_harness_operator',
  });
  const trustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId: 'dataset-harness-key',
      subjectId: 'dataset-harness-operator',
      algorithm: 'ed25519',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      roles: ['dataset_harness_operator'],
      status: 'active',
    }],
  };
  const envelope = legacyProtocol
    ? { version: 1, kind: 'OperatorDatasetHarnessEnvelope', authority, splitManifest, harnessDefinition: definition }
    : {
      version: 2, kind: 'OperatorDatasetHarnessEnvelope', authority, splitManifest,
      harnessDefinition: definition, analysisProtocol,
    };
  const envelopePath = envelopeInsideDataset
    ? path.join(datasetRoot, 'hidden-oracle-envelope.json')
    : path.join(root, 'host-only-envelope.json');
  fs.writeFileSync(envelopePath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  const mount = { name, source: datasetRoot, readOnly: true, manifestHash: inspection.hash, licenseId: 'CC-BY-4.0' };
  return { root, runtimeRoot, datasetRoot, inspection, name, envelope, envelopePath, trustStore, mount };
}

test('signed host-only dataset envelope produces an opaque plan handle and no public oracle/path', (t) => {
  const fixture = authorityFixture(t);
  const mount = authorizeOperatorDatasetMount(fixture.mount, {
    envelopePath: fixture.envelopePath,
    authorityTrustStore: fixture.trustStore,
    runtimeRoot: fixture.runtimeRoot,
    persistPrivateEnvelope: true,
    now: new Date(NOW),
  });
  assert.match(mount.operatorDatasetHarnessHandle, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(mount, 'operatorDatasetHarnessEnvelopePath'), false);
  assert.doesNotMatch(JSON.stringify(mount), /host-only-envelope|"oracle"/);
  const registeredEnvelope = path.join(fixture.runtimeRoot, 'private', 'dataset-harness-envelopes', `${mount.operatorDatasetHarnessHandle.slice(7)}.json`);
  const registeredIdentity = fs.lstatSync(registeredEnvelope);
  assert.equal(registeredIdentity.mode & 0o777, 0o600);
  if (typeof process.getuid === 'function') assert.equal(registeredIdentity.uid, process.getuid());
  const selector = buildCampaignBenchmarkSelector({ benchmarkId: fixture.name, datasetMounts: [mount] });
  assert.equal(selector.selectorType, 'authorized_dataset_mount');
  const resolution = readOperatorDatasetHarness(mount, {
    authorityTrustStore: fixture.trustStore,
    runtimeRoot: fixture.runtimeRoot,
    now: new Date(NOW),
  });
  assert.equal(resolution.receipt.status, 'operator_dataset_harness_authority_verified', JSON.stringify(resolution.receipt.blockers));
  assert.ok(resolution.privateDefinition?.cells?.length > 0);
  assert.doesNotMatch(JSON.stringify(resolution.receipt), /"definition"|"oracle"|host-only-envelope/);
  const publicAuthorization = buildDatasetAuthorizationSet([mount]);
  assert.doesNotMatch(JSON.stringify(publicAuthorization), /"oracle"|host-only-envelope|dataset-harness-envelopes/);
  const authorityVerifier = createOperatorDatasetHarnessAuthorityReceiptVerifier({
    trustStoreProvider: () => fixture.trustStore,
    clock: { now: () => new Date(NOW) },
  });
  const verified = authorityVerifier(resolution.receipt, {
    dataset: publicAuthorization.datasets[0],
    selector,
  });
  assert.equal(verified.status, 'operator_dataset_harness_authority_receipt_verified', JSON.stringify(verified.blockers));
  const expired = createOperatorDatasetHarnessAuthorityReceiptVerifier({
    trustStoreProvider: () => fixture.trustStore,
    clock: { now: () => new Date('2026-07-23T01:00:00.000Z') },
  })(resolution.receipt, { dataset: publicAuthorization.datasets[0], selector });
  assert.equal(expired.verified, false);
  assert.ok(expired.blockers.includes('operator_dataset_authority:authority_expired'));

  const forgedAuthorityInput = structuredClone(resolution.receipt.authority);
  forgedAuthorityInput.signatures[0].value = Buffer.alloc(64).toString('base64');
  const forgedAuthority = validateOperatorDatasetAuthorityDocument(forgedAuthorityInput, {
    datasetName: mount.name,
    datasetManifestHash: mount.manifestHash,
  });
  const forgedMount = {
    ...mount,
    operatorAuthorizationHash: forgedAuthority.operatorDatasetAuthorityDocumentHash,
    operatorDatasetAuthorityDocumentHash: forgedAuthority.operatorDatasetAuthorityDocumentHash,
    operatorDatasetAuthority: forgedAuthority.authority,
  };
  const forgedSelector = buildCampaignBenchmarkSelector({ benchmarkId: fixture.name, datasetMounts: [forgedMount] });
  const forgedDataset = buildDatasetAuthorizationSet([forgedMount]).datasets[0];
  const {
    operatorDatasetHarnessAuthorityReceiptHash: _ignoredAuthorityReceiptHash,
    ...forgedReceiptPayload
  } = {
    ...resolution.receipt,
    authority: forgedAuthority.authority,
    operatorAuthorizationHash: forgedAuthority.operatorDatasetAuthorityDocumentHash,
    operatorDatasetAuthorityDocumentHash: forgedAuthority.operatorDatasetAuthorityDocumentHash,
  };
  const forgedReceipt = {
    ...forgedReceiptPayload,
    operatorDatasetHarnessAuthorityReceiptHash: hashRecord('OperatorDatasetHarnessAuthorityReceipt', forgedReceiptPayload),
  };
  assert.equal(verifyOperatorDatasetHarnessAuthorityReceiptStructure(forgedReceipt, {
    dataset: forgedDataset,
    selector: forgedSelector,
  }), true, 'self-consistent forged receipt must reach the cryptographic boundary');
  const forgedVerification = authorityVerifier(forgedReceipt, { dataset: forgedDataset, selector: forgedSelector });
  assert.equal(forgedVerification.verified, false);
  assert.ok(forgedVerification.blockers.some((blocker) => blocker.includes('authority_signature_invalid')));
  let boundaryVerificationCount = 0;
  const boundaryVerifier = createExperimentRegistryAuthorityVerifier({
    operatorDatasetHarnessAuthorityVerifier(receipt, context) {
      boundaryVerificationCount += 1;
      return authorityVerifier(receipt, context);
    },
  });
  const boundaryRunReceipt = {
    academicPromotionEligible: true,
    analysisProtocolHash: resolution.receipt.analysisProtocolHash,
    harnessExecutionReceipt: {
      operatorDatasetHarnessAuthority: resolution.receipt,
      benchmarkSelector: selector,
      datasetAuthorizations: publicAuthorization.datasets,
    },
  };
  const boundaryResult = boundaryVerifier({
    experimentId: 'dataset-authority-boundary',
    academicPromotionEligible: true,
    evidenceBinding: {
      kind: 'CampaignExperimentEvidenceBinding',
      authorityEvidence: {
        kind: 'CampaignExperimentEvidenceAuthorityEvidence',
        experimentRunReceipt: boundaryRunReceipt,
        experimentReplayReceipt: { replayRunReceipt: boundaryRunReceipt },
      },
    },
  });
  assert.equal(boundaryVerificationCount, 2, 'registry authority must reverify original and replay receipts');
  assert.equal(boundaryResult.blockers.some((blocker) => blocker.startsWith('campaign_experiment_operator_dataset_authority_')), false);

  const sandbox = path.join(fixture.root, 'sandbox');
  fs.mkdirSync(sandbox);
  const snapshot = materializeDatasetSnapshot({
    ...mount,
    sourceType: 'directory',
    manifestEntries: fixture.inspection.entries,
  }, sandbox);
  assert.deepEqual(fs.readdirSync(snapshot.snapshotSource).sort(), ['public.json', 'train.csv']);
  assert.equal(fs.existsSync(path.join(snapshot.snapshotSource, path.basename(fixture.envelopePath))), false);

  const primitiveRunReceipt = {
    academicPromotionEligible: true,
    harnessExecutionReceipt: {
      benchmarkSelector: selector,
      datasetAuthorizations: publicAuthorization.datasets,
      operatorDatasetHarnessAuthority: resolution.receipt,
    },
  };
  const primitiveCell = buildCampaignBenchmarkSchedule(selector)[0];
  const resolverOptions = {
    runtimeRoot: fixture.runtimeRoot,
    trustStoreProvider: () => fixture.trustStore,
    clock: { now: () => new Date(NOW) },
  };
  const firstResolution = createSystemBenchmarkPrimitiveFixtureResolver(resolverOptions)({
    experimentRunReceipt: primitiveRunReceipt,
    cell: primitiveCell,
  });
  assert.equal(firstResolution.status, 'system_benchmark_primitive_fixture_resolved', JSON.stringify(firstResolution.blockers));
  assert.match(firstResolution.systemBenchmarkCellChallengeHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(firstResolution.systemBenchmarkCellOracleHash, /^sha256:[0-9a-f]{64}$/);
  const expectedPrimitiveFixture = buildSystemBenchmarkCellChallenge({
    protocol: primitiveCell.armProtocol,
    seed: primitiveCell.seed,
    repetition: primitiveCell.repetition,
    operatorDatasetHarnessDefinition: fixture.envelope.harnessDefinition,
  });
  assert.equal(firstResolution.systemBenchmarkCellChallengeHash,
    expectedPrimitiveFixture.challenge.systemBenchmarkCellChallengeHash);
  assert.equal(firstResolution.systemBenchmarkCellOracleHash,
    expectedPrimitiveFixture.oracle.systemBenchmarkCellOracleHash);
  assert.doesNotMatch(JSON.stringify(firstResolution), /"oracle"|"definition"|cases/);
  const restartedResolution = createSystemBenchmarkPrimitiveFixtureResolver(resolverOptions)({
    experimentRunReceipt: primitiveRunReceipt,
    cell: primitiveCell,
  });
  assert.equal(restartedResolution.status, 'system_benchmark_primitive_fixture_resolved');
  assert.equal(restartedResolution.systemBenchmarkCellOracleHash, firstResolution.systemBenchmarkCellOracleHash);
  const missingCellResolution = createSystemBenchmarkPrimitiveFixtureResolver(resolverOptions)({
    experimentRunReceipt: primitiveRunReceipt,
    cell: { ...primitiveCell, repetition: 999 },
  });
  assert.equal(missingCellResolution.status, 'system_benchmark_primitive_fixture_blocked');
  assert.equal(missingCellResolution.systemBenchmarkCellChallengeHash, null);
  assert.equal(missingCellResolution.systemBenchmarkCellOracleHash, null);
  assert.ok(missingCellResolution.blockers.includes(
    'primitive_fixture_source:independent_private_fixture_source_invalid',
  ));
  const missingContextResolution = createSystemBenchmarkPrimitiveFixtureResolver()({
    experimentRunReceipt: primitiveRunReceipt,
    cell: primitiveCell,
  });
  assert.equal(missingContextResolution.status, 'system_benchmark_primitive_fixture_blocked');
  assert.ok(missingContextResolution.blockers.includes('primitive_fixture_private_resolver_context_required'));
  const expiredResolution = createSystemBenchmarkPrimitiveFixtureResolver({
    ...resolverOptions,
    clock: { now: () => new Date('2026-07-23T01:00:00.000Z') },
  })({ experimentRunReceipt: primitiveRunReceipt, cell: primitiveCell });
  assert.equal(expiredResolution.status, 'system_benchmark_primitive_fixture_blocked');
  assert.ok(expiredResolution.blockers.some((blocker) => blocker.includes('authority_expired')));

  const registeredBytes = fs.readFileSync(registeredEnvelope);
  const swappedSignature = JSON.parse(registeredBytes.toString('utf8'));
  swappedSignature.authority.signatures[0].value = Buffer.alloc(64, 7).toString('base64');
  fs.writeFileSync(registeredEnvelope, `${JSON.stringify(swappedSignature)}\n`, { mode: 0o600 });
  const signatureResolution = createSystemBenchmarkPrimitiveFixtureResolver(resolverOptions)({
    experimentRunReceipt: primitiveRunReceipt,
    cell: primitiveCell,
  });
  assert.equal(signatureResolution.status, 'system_benchmark_primitive_fixture_blocked');
  assert.ok(signatureResolution.blockers.some((blocker) => blocker.includes('authority_signature_invalid')));
  fs.writeFileSync(registeredEnvelope, registeredBytes, { mode: 0o600 });
  const changedDefinition = JSON.parse(registeredBytes.toString('utf8'));
  changedDefinition.harnessDefinition.cells[0].cases[0].oracle.label = 1
    - changedDefinition.harnessDefinition.cells[0].cases[0].oracle.label;
  fs.writeFileSync(registeredEnvelope, `${JSON.stringify(changedDefinition)}\n`, { mode: 0o600 });
  const definitionResolution = createSystemBenchmarkPrimitiveFixtureResolver(resolverOptions)({
    experimentRunReceipt: primitiveRunReceipt,
    cell: primitiveCell,
  });
  assert.equal(definitionResolution.status, 'system_benchmark_primitive_fixture_blocked');
  assert.ok(definitionResolution.blockers.some((blocker) => blocker.includes('envelope_binding_invalid')));
  fs.writeFileSync(registeredEnvelope, registeredBytes, { mode: 0o600 });
});

test('signature tamper, host-path overlap, hidden-test exposure, and dataset TOCTOU all fail closed', (t) => {
  const signatureFixture = authorityFixture(t);
  const tampered = structuredClone(signatureFixture.envelope);
  tampered.authority.signatures[0].value = `${tampered.authority.signatures[0].value.slice(0, -2)}AA`;
  fs.writeFileSync(signatureFixture.envelopePath, JSON.stringify(tampered));
  assert.throws(() => authorizeOperatorDatasetMount(signatureFixture.mount, {
    envelopePath: signatureFixture.envelopePath,
    authorityTrustStore: signatureFixture.trustStore,
    now: new Date(NOW),
  }), /authority_signature_invalid/);

  const protocolFixture = authorityFixture(t);
  const protocolTamper = structuredClone(protocolFixture.envelope);
  protocolTamper.analysisProtocol.hypotheses[0].minimumEffect = 0.25;
  fs.writeFileSync(protocolFixture.envelopePath, JSON.stringify(protocolTamper));
  assert.throws(() => authorizeOperatorDatasetMount(protocolFixture.mount, {
    envelopePath: protocolFixture.envelopePath,
    authorityTrustStore: protocolFixture.trustStore,
    now: new Date(NOW),
  }), /operator_dataset_harness_envelope_binding_invalid/);

  const legacy = authorityFixture(t, { legacyProtocol: true });
  assert.throws(() => authorizeOperatorDatasetMount(legacy.mount, {
    envelopePath: legacy.envelopePath,
    authorityTrustStore: legacy.trustStore,
    now: new Date(NOW),
  }), /operator_dataset_analysis_protocol_required/);
  const compatMount = authorizeOperatorDatasetMount(legacy.mount, {
    envelopePath: legacy.envelopePath,
    authorityTrustStore: legacy.trustStore,
    now: new Date(NOW),
    allowLegacyAnalysisProtocol: true,
  });
  assert.equal(compatMount.analysisProtocolHash, null);
  assert.throws(() => buildCampaignBenchmarkSelector({ benchmarkId: legacy.name, datasetMounts: [compatMount] }),
    /campaign_benchmark_dataset_authorization_invalid/);

  const fourHypotheses = ['baseline', 'ablation'].flatMap((comparator) => [
    { hypothesisId: `primary-${comparator}`, metric: 'mean_score', comparator, alternative: 'greater', minimumEffect: 0, acceptanceRequired: true },
    { hypothesisId: `robustness-${comparator}`, metric: 'robustness_gap', comparator, alternative: 'greater', minimumEffect: 0, acceptanceRequired: true },
  ]);
  const underpowered = authorityFixture(t, { analysisHypotheses: fourHypotheses });
  assert.equal(underpowered.envelope.analysisProtocol.power.requiredPairedObservations > 35, true);
  assert.throws(() => authorizeOperatorDatasetMount(underpowered.mount, {
    envelopePath: underpowered.envelopePath,
    authorityTrustStore: underpowered.trustStore,
    now: new Date(NOW),
  }), /operator_dataset_harness_envelope_binding_invalid/);
  const expandedRepetitions = Math.ceil(
    underpowered.envelope.analysisProtocol.power.requiredPairedObservations
      / underpowered.envelope.authority.seedSchedule.length,
  );
  const expanded = authorityFixture(t, { analysisHypotheses: fourHypotheses, minimumRepetitions: expandedRepetitions });
  const expandedMount = authorizeOperatorDatasetMount(expanded.mount, {
    envelopePath: expanded.envelopePath,
    authorityTrustStore: expanded.trustStore,
    now: new Date(NOW),
  });
  const expandedSelector = buildCampaignBenchmarkSelector({ benchmarkId: expanded.name, datasetMounts: [expandedMount] });
  assert.equal(expandedSelector.experimentDesign.seedSchedule.length * expandedSelector.experimentDesign.minimumRepetitions
    >= expandedSelector.experimentDesign.analysisProtocol.power.requiredPairedObservations, true);

  const permissionsFixture = authorityFixture(t);
  fs.chmodSync(permissionsFixture.envelopePath, 0o640);
  assert.throws(() => authorizeOperatorDatasetMount(permissionsFixture.mount, {
    envelopePath: permissionsFixture.envelopePath,
    authorityTrustStore: permissionsFixture.trustStore,
    now: new Date(NOW),
  }), /operator_dataset_harness_envelope_identity_invalid/);

  const insideFixture = authorityFixture(t, { envelopeInsideDataset: true });
  assert.throws(() => authorizeOperatorDatasetMount(insideFixture.mount, {
    envelopePath: insideFixture.envelopePath,
    authorityTrustStore: insideFixture.trustStore,
    now: new Date(NOW),
  }), /operator_dataset_harness_must_be_host_only_outside_dataset/);

  const visibleTest = authorityFixture(t, { visibleTestSplit: true });
  assert.match(visibleTest.validationError?.message || '', /hidden_test_split_must_not_be_worker_visible/);

  const changedFixture = authorityFixture(t);
  const mount = authorizeOperatorDatasetMount(changedFixture.mount, {
    envelopePath: changedFixture.envelopePath,
    authorityTrustStore: changedFixture.trustStore,
    runtimeRoot: changedFixture.runtimeRoot,
    persistPrivateEnvelope: true,
    now: new Date(NOW),
  });
  fs.appendFileSync(path.join(changedFixture.datasetRoot, 'train.csv'), '2,1\n');
  const changed = readOperatorDatasetHarness(mount, {
    authorityTrustStore: changedFixture.trustStore,
    runtimeRoot: changedFixture.runtimeRoot,
    now: new Date(NOW),
  });
  assert.equal(changed.receipt.status, 'operator_dataset_harness_authority_blocked');
  assert.ok(changed.receipt.blockers.includes('operator_dataset_manifest_identity_mismatch'));

  const dockerProof = buildDatasetRuntimeAccessReceipt({
    executionBackend: 'docker', datasets: [], required: true,
    tracePath: path.join(changedFixture.root, 'missing.trace'), supervisorRoot: changedFixture.root,
  });
  assert.ok(dockerProof.blockers.includes('worker_dataset_access_trusted_supervisor_backend_unavailable'));
});

test('batch CLI and command carry only the opaque authority handle into the campaign plan', (t) => {
  const fixture = authorityFixture(t);
  const mount = authorizeOperatorDatasetMount(fixture.mount, {
    envelopePath: fixture.envelopePath,
    authorityTrustStore: fixture.trustStore,
    now: new Date(NOW),
  });
  const parsed = parsePaperProductionArgs(['batch-run', '--dataset-harness', fixture.envelopePath]);
  const options = buildPaperBatchCliOptions(parsed, { defaultRoot: fixture.root, defaultRuntimeRoot: fixture.runtimeRoot });
  assert.equal(options.datasetHarnessEnvelope, path.resolve(fixture.envelopePath));
  const command = buildBatchCampaignCommand({
    paperTask: {
      version: 'fixture', kind: 'PaperTask', paperId: 'paper-1', taskKey: 'paper-factory:paper-1',
      semanticIdentityHash: `sha256:${'a'.repeat(64)}`, paperQualityProfile: 'empirical_or_experiment',
      evidenceRefs: [],
    },
    paperState: { evidenceRefs: [] },
    sourceWorkspace: fixture.root,
    mode: 'full-campaign',
    targetScopeReceipt: { status: 'target_scope_verified', selectedPaperIds: ['paper-1'], requestedPaperIds: ['paper-1'], inventorySource: 'fixture', inventoryFallback: false },
    datasetMounts: [mount],
    benchmarkId: fixture.name,
  });
  const serialized = JSON.stringify(command.campaignPlan);
  assert.match(serialized, new RegExp(mount.operatorDatasetHarnessHandle.replace(':', '\\:')));
  assert.doesNotMatch(serialized, /host-only-envelope|"oracle"/);
  const composite = buildBatchCampaignCommand({
    paperTask: {
      version: 'fixture', kind: 'PaperTask', paperId: 'paper-2', taskKey: 'paper-factory:paper-2',
      semanticIdentityHash: `sha256:${'b'.repeat(64)}`,
      paperQualityProfiles: ['formal_theorem_or_proof', 'empirical_or_experiment'], evidenceRefs: [],
    },
    paperState: { evidenceRefs: [] }, sourceWorkspace: fixture.root, mode: 'full-campaign',
    targetScopeReceipt: { status: 'target_scope_verified', selectedPaperIds: ['paper-2'], requestedPaperIds: ['paper-2'], inventorySource: 'fixture', inventoryFallback: false },
    datasetMounts: [mount], benchmarkId: fixture.name, languages: ['lean', 'python', 'latex'],
  });
  const kinds = new Set(composite.campaignPlan.nodes.map((node) => node.kind));
  assert.equal(kinds.has('theorem-spec'), true);
  assert.equal(kinds.has('formal-author'), false, 'formal author must execute inside the atomic candidate transaction');
  assert.equal(kinds.has('formal-review'), false, 'semantic review must execute inside the atomic candidate transaction');
  assert.equal(kinds.has('formal-verify'), true);
  assert.equal([...kinds].some((kind) => /empirical/.test(kind)), true);
  const researchVerify = composite.campaignPlan.nodes.find((node) => node.kind === 'research-verify');
  const formalVerifications = composite.campaignPlan.nodes.filter((node) => node.kind === 'formal-verify');
  const replayNodeIds = composite.campaignPlan.nodes
    .filter((node) => /^(?:empirical-reproduce|revalidate-empirical-reproduce)(?:-|$)/.test(node.kind))
    .map((node) => node.nodeId);
  assert.equal(campaignNodeOperation('formal-verify'), 'formal-verification');
  assert.equal(campaignNodeOperation(researchVerify.kind), 'research-verification');
  for (const formalVerify of formalVerifications) {
    assert.equal(formalVerify.role, 'formal-candidate');
    assert.equal(formalVerify.dependencies.length, 1);
    const theoremSpecification = composite.campaignPlan.nodes
      .find((node) => node.nodeId === formalVerify.dependencies[0]);
    assert.equal(theoremSpecification?.kind, 'theorem-spec');
    assert.equal(theoremSpecification?.roundIndex, formalVerify.roundIndex);
    assert.ok(researchVerify.dependencies.includes(formalVerify.nodeId));
  }
  assert.ok(replayNodeIds.every((nodeId) => researchVerify.dependencies.includes(nodeId)));
});
