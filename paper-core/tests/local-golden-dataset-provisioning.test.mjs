import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  executeLocalGoldenDatasetProvisioning,
  inspectLocalGoldenDatasetProvisioning,
} from '../../paper-adapters/automation/local-golden-dataset-provisioner.mjs';
import {
  authorizeOperatorDatasetMount,
  readOperatorDatasetHarness,
} from '../../paper-adapters/automation/operator-dataset-harness-reader.mjs';
import {
  createOperatorDatasetHarnessAuthorityReceiptVerifier,
} from '../../paper-adapters/automation/operator-dataset-harness-authority-receipt-verifier.mjs';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { executeSystemBenchmarkHarness } from '../../paper-adapters/automation/system-benchmark-harness.mjs';
import { buildCanonicalAnalysisProtocol } from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import { buildCampaignBenchmarkSelector } from '../../paper-domain/automation/campaign-benchmark-selector.mjs';
import { buildDatasetAuthorizationSet } from '../../paper-domain/automation/experiment-run-artifact-contract.mjs';
import {
  LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE,
  LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE,
  LOCAL_GOLDEN_DATASET_AUTHORITY_KIND,
  LOCAL_GOLDEN_DATASET_AUTHORITY_ROLE,
  LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS,
  verifyOperatorDatasetHarnessAuthorityReceiptStructure,
} from '../../paper-domain/automation/operator-dataset-harness-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  parseLocalGoldenDatasetProvisioningArguments,
} from '../bin/local-golden-dataset-provision.mjs';
import { resolveHeptaPaperCommand } from '../src/command-registry.mjs';

const NOW = new Date('2026-08-08T08:00:00.000Z');
const SIGNED_AT = '2026-08-08T07:59:00.000Z';
const EXPIRES_AT = '2026-08-15T07:59:00.000Z';
const FAMILY = 'ml_algorithm_benchmark';

function writeJson(candidate, value, mode = 0o600) {
  fs.writeFileSync(candidate, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.chmodSync(candidate, mode);
}

function harnessDefinition(datasetName) {
  const seedSchedule = Array.from({ length: 32 }, (_, index) => 1000 + index);
  return {
    version: 1,
    kind: 'OperatorAuthorizedDatasetBenchmarkHarness',
    benchmarkId: datasetName,
    benchmarkFamily: FAMILY,
    seedSchedule,
    minimumRepetitions: 1,
    cells: seedSchedule.map((seed) => ({
      seed,
      repetition: 1,
      cases: Array.from({ length: 8 }, (_, caseIndex) => ({
        caseId: hashRecord('LocalGoldenDatasetTestCase', { seed, caseIndex }),
        input: { primary: seed + caseIndex, secondary: caseIndex / 10 },
        ablationInput: { secondary: caseIndex / 10 },
        referenceResponse: 0,
        oracle: { label: caseIndex % 2, robustLabel: caseIndex % 2 },
      })),
    })),
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-local-golden-dataset-'));
  t.after(() => {
    try {
      const datasetRoot = path.join(root, 'dataset');
      if (fs.existsSync(datasetRoot)) fs.chmodSync(datasetRoot, 0o700);
    } catch { /* best-effort fixture thaw before deletion */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runtimeRoot = path.join(root, 'runtime');
  const controlRoot = path.join(root, 'control');
  const datasetRoot = path.join(root, 'dataset');
  const secretRoot = path.join(root, 'secrets');
  for (const directory of [runtimeRoot, controlRoot, datasetRoot, secretRoot]) {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  const datasetName = 'local-golden-ml';
  fs.writeFileSync(path.join(datasetRoot, 'train.csv'), 'feature,label\n1,0\n', { mode: 0o444 });
  fs.chmodSync(path.join(datasetRoot, 'train.csv'), 0o444);
  fs.chmodSync(datasetRoot, 0o555);

  const familyDesign = buildCampaignBenchmarkSelector({ benchmarkId: FAMILY }).experimentDesign;
  const builtProtocol = buildCanonicalAnalysisProtocol({
    benchmarkId: datasetName,
    benchmarkFamily: FAMILY,
    requiredMetrics: familyDesign.requiredMetrics,
    metricSpecs: familyDesign.metricSpecs,
  });
  const { analysisProtocolHash: _analysisProtocolHash, ...analysisProtocol } = builtProtocol;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const trustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    authorityScope: LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE,
    evidenceClass: LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS,
    academicPromotionEligible: false,
    externalTrustClaimed: false,
    keyPurpose: LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE,
    keys: [{
      keyId: 'local-golden-dataset-key',
      subjectId: 'local-golden-dataset-operator',
      algorithm: 'ed25519',
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      roles: [LOCAL_GOLDEN_DATASET_AUTHORITY_ROLE],
      keyPurpose: LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE,
      authorityScope: LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE,
      academicPromotionEligible: false,
      externalTrustClaimed: false,
      status: 'active',
    }],
  };
  const files = {
    splitAssignmentsPath: path.join(controlRoot, 'split-assignments.json'),
    harnessDefinitionPath: path.join(controlRoot, 'hidden-harness.json'),
    analysisProtocolPath: path.join(controlRoot, 'analysis-protocol.json'),
    researchSemanticsPath: path.join(controlRoot, 'research-semantics.json'),
    authorityTrustStorePath: path.join(controlRoot, 'public-trust.json'),
    authorityPrivateKeyPath: path.join(secretRoot, 'authority-private.pem'),
    mountOutputPath: path.join(controlRoot, 'dataset-mounts.json'),
  };
  writeJson(files.splitAssignmentsPath, {
    version: 1,
    kind: 'LocalGoldenDatasetSplitAssignments',
    datasetName,
    entries: [{ path: 'train.csv', split: 'train' }],
  }, 0o600);
  writeJson(files.harnessDefinitionPath, harnessDefinition(datasetName), 0o600);
  writeJson(files.analysisProtocolPath, analysisProtocol, 0o600);
  writeJson(files.researchSemanticsPath, {
    version: 1,
    kind: 'OperatorDatasetResearchSemantics',
    population: 'Rows in the frozen local golden training dataset.',
    variables: ['feature', 'label'],
    intervention: 'Apply the bounded candidate classifier.',
    comparator: 'Compare with baseline and ablation classifiers.',
    estimands: ['paired hidden-evaluation metric difference'],
    datasetConstraints: ['local operator fixture; no external dataset-owner qualification'],
    eligibleSplits: ['train'],
  }, 0o600);
  writeJson(files.authorityTrustStorePath, trustStore, 0o600);
  fs.writeFileSync(files.authorityPrivateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.chmodSync(files.authorityPrivateKeyPath, 0o600);
  const options = {
    workspaceRoot: '/repository/hepta-paper',
    protectedRoots: [],
    runtimeRoot,
    controlRoot,
    isolationId: 'golden-test-isolation',
    datasetName,
    datasetRoot,
    datasetLicenseId: 'LicenseRef-Local-Golden-Test-Terms',
    ...files,
    authorityKeyId: 'local-golden-dataset-key',
    signedAt: SIGNED_AT,
    expiresAt: EXPIRES_AT,
    now: NOW,
  };
  return { root, runtimeRoot, controlRoot, datasetRoot, trustStore, options };
}

function cliArguments(options, extras = []) {
  return [
    '--runtime-root', options.runtimeRoot,
    '--control-root', options.controlRoot,
    '--isolation-id', options.isolationId,
    '--dataset-name', options.datasetName,
    '--dataset-root', options.datasetRoot,
    '--dataset-license-id', options.datasetLicenseId,
    '--split-assignments', options.splitAssignmentsPath,
    '--harness-definition', options.harnessDefinitionPath,
    '--analysis-protocol', options.analysisProtocolPath,
    '--research-semantics', options.researchSemanticsPath,
    '--authority-trust-store', options.authorityTrustStorePath,
    '--authority-private-key', options.authorityPrivateKeyPath,
    '--authority-key-id', options.authorityKeyId,
    '--signed-at', options.signedAt,
    '--expires-at', options.expiresAt,
    '--mount-output', options.mountOutputPath,
    ...extras,
  ];
}

test('local golden dataset provisioning is explicit, registered, and rejects production roots', (t) => {
  const scenario = fixture(t);
  const route = resolveHeptaPaperCommand('operator', 'local-golden-dataset-provision');
  assert.deepEqual(route.argv, ['node', 'paper-core/bin/local-golden-dataset-provision.mjs']);
  assert.equal(route.effects.externalAction, 'none');
  assert.equal(route.effects.networkUse, 'none');
  assert.throws(() => parseLocalGoldenDatasetProvisioningArguments([
    '--action', 'execute', ...cliArguments(scenario.options),
  ]), /execute_confirmation_required/);
  assert.throws(() => inspectLocalGoldenDatasetProvisioning({
    ...scenario.options,
    runtimeRoot: '/var/lib/hepta-paper/runtime',
  }), /protected_root_forbidden:runtimeRoot/);

  const incompleteAssignments = JSON.parse(fs.readFileSync(scenario.options.splitAssignmentsPath, 'utf8'));
  incompleteAssignments.entries = [];
  writeJson(scenario.options.splitAssignmentsPath, incompleteAssignments, 0o600);
  assert.throws(() => inspectLocalGoldenDatasetProvisioning(scenario.options), /split_assignments_incomplete/);
  incompleteAssignments.entries = [{ path: 'train.csv', split: 'train' }];
  writeJson(scenario.options.splitAssignmentsPath, incompleteAssignments, 0o600);

  const publicTrust = JSON.parse(fs.readFileSync(
    scenario.options.authorityTrustStorePath, 'utf8',
  ));
  publicTrust.unscopedMaterial = 'must-not-be-persisted';
  writeJson(scenario.options.authorityTrustStorePath, publicTrust, 0o600);
  assert.throws(
    () => inspectLocalGoldenDatasetProvisioning(scenario.options),
    /public_trust_store_invalid/,
  );
});

test('provisioned authority is runtime-bound, local-only, non-promotable and deterministic', (t) => {
  const scenario = fixture(t);
  const inspected = inspectLocalGoldenDatasetProvisioning(scenario.options);
  assert.equal(inspected.plan.ready, true);
  assert.equal(inspected.plan.evidenceClass, LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS);
  assert.equal(inspected.plan.academicPromotionEligible, false);
  assert.equal(inspected.plan.externalTrustClaimed, false);
  assert.equal(fs.existsSync(scenario.options.mountOutputPath), false, 'plan must not write');

  const executeOptions = {
    ...scenario.options,
    expectedPlanId: inspected.plan.localGoldenDatasetProvisioningPlanId,
  };
  const first = executeLocalGoldenDatasetProvisioning(executeOptions);
  const second = executeLocalGoldenDatasetProvisioning(executeOptions);
  assert.deepEqual(second, first, 'same immutable inputs must produce byte-identical idempotent outputs');
  assert.equal(first.evidenceClass, LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS);
  assert.equal(first.academicPromotionEligible, false);
  assert.equal(first.externalTrustClaimed, false);

  const mountDocument = fs.readFileSync(scenario.options.mountOutputPath, 'utf8');
  assert.doesNotMatch(mountDocument, /PRIVATE KEY|"oracle"|"cases"/);
  const [mount] = JSON.parse(mountDocument);
  assert.equal(mount.authorityScope, LOCAL_GOLDEN_DATASET_AUTHORITY_SCOPE);
  assert.equal(mount.evidenceClass, LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS);
  assert.equal(mount.academicPromotionEligible, false);
  assert.equal(mount.externalTrustClaimed, false);
  assert.equal(mount.operatorDatasetAuthority.version, 4);
  assert.equal(mount.operatorDatasetAuthority.kind, LOCAL_GOLDEN_DATASET_AUTHORITY_KIND);
  assert.equal(
    mount.operatorDatasetAuthority.signatures[0].role,
    LOCAL_GOLDEN_DATASET_AUTHORITY_ROLE,
  );
  assert.equal(fs.statSync(scenario.options.mountOutputPath).mode & 0o777, 0o600);
  const installedTrustStorePath = path.join(
    scenario.runtimeRoot,
    'trust',
    'AUTHORITY_TRUST_STORE.json',
  );
  assert.equal(fs.statSync(installedTrustStorePath).mode & 0o777, 0o600);
  const installedTrustStore = JSON.parse(fs.readFileSync(installedTrustStorePath, 'utf8'));
  assert.deepEqual(installedTrustStore.keys[0].roles, [LOCAL_GOLDEN_DATASET_AUTHORITY_ROLE]);
  assert.equal(
    installedTrustStore.keys[0].keyPurpose,
    LOCAL_GOLDEN_DATASET_AUTHORITY_KEY_PURPOSE,
  );

  const selector = buildCampaignBenchmarkSelector({
    benchmarkId: scenario.options.datasetName,
    datasetMounts: [mount],
  });
  assert.equal(selector.assuranceScope, 'local-operator-hidden-evaluation-only-v1');
  assert.equal(selector.academicPromotionEligible, false);
  assert.equal(selector.externalTrustClaimed, false);
  const authorization = buildDatasetAuthorizationSet([mount]).datasets[0];
  const resolution = readOperatorDatasetHarness(mount, {
    authorityTrustStore: scenario.trustStore,
    runtimeRoot: scenario.runtimeRoot,
    now: NOW,
  });
  assert.equal(resolution.receipt.status, 'operator_dataset_harness_authority_verified', JSON.stringify(resolution.receipt.blockers));
  assert.equal(resolution.receipt.evidenceClass, LOCAL_GOLDEN_DATASET_EVIDENCE_CLASS);
  assert.equal(resolution.receipt.academicPromotionEligible, false);
  assert.equal(resolution.receipt.externalTrustClaimed, false);
  assert.equal(verifyOperatorDatasetHarnessAuthorityReceiptStructure(resolution.receipt, {
    dataset: authorization,
    selector,
  }), true);
  const verifyReceipt = createOperatorDatasetHarnessAuthorityReceiptVerifier({
    trustStoreProvider: () => scenario.trustStore,
    clock: Object.freeze({ now: () => NOW }),
  });
  assert.equal(verifyReceipt(resolution.receipt, {
    dataset: authorization,
    selector,
  }).verified, true);

  const localEnvelopePath = path.join(
    scenario.runtimeRoot,
    'private',
    'dataset-harness-envelopes',
    `${mount.benchmarkHarnessDocumentHash.slice('sha256:'.length)}.json`,
  );
  const localEnvelope = JSON.parse(fs.readFileSync(localEnvelopePath, 'utf8'));
  const {
    authorityScope: _authorityScope,
    evidenceClass: _evidenceClass,
    academicPromotionEligible: _academicPromotionEligible,
    externalTrustClaimed: _externalTrustClaimed,
    authorityKeyPurpose: _authorityKeyPurpose,
    localGoldenRuntimeScope: _localGoldenRuntimeScope,
    signatures: _signatures,
    ...localAuthorityPayload
  } = localEnvelope.authority;
  const downgradedAuthority = signAuthorityDocument({
    ...localAuthorityPayload,
    version: 3,
    kind: 'OperatorDatasetHarnessAuthority',
  }, {
    privateKeyPem: fs.readFileSync(scenario.options.authorityPrivateKeyPath),
    keyId: scenario.options.authorityKeyId,
    role: 'dataset_harness_operator',
  });
  const downgradedEnvelopePath = path.join(scenario.controlRoot, 'downgraded-envelope.json');
  writeJson(downgradedEnvelopePath, {
    ...localEnvelope,
    version: 3,
    kind: 'OperatorDatasetHarnessEnvelope',
    authority: downgradedAuthority,
  }, 0o600);
  assert.throws(() => authorizeOperatorDatasetMount({
    name: scenario.options.datasetName,
    source: scenario.datasetRoot,
    readOnly: true,
    manifestHash: mount.manifestHash,
    licenseId: scenario.options.datasetLicenseId,
  }, {
    envelopePath: downgradedEnvelopePath,
    authorityTrustStore: scenario.trustStore,
    runtimeRoot: scenario.runtimeRoot,
    now: NOW,
  }), /local_golden_dataset_(?:trust_store_forbids_nonlocal_authority|key_cannot_authorize_nonlocal_authority)/);

  const otherRuntime = path.join(scenario.root, 'other-runtime');
  const otherPrivateRoot = path.join(otherRuntime, 'private', 'dataset-harness-envelopes');
  fs.mkdirSync(otherPrivateRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(otherRuntime, 0o700);
  fs.chmodSync(path.join(otherRuntime, 'private'), 0o700);
  fs.chmodSync(otherPrivateRoot, 0o700);
  const envelopeName = `${mount.benchmarkHarnessDocumentHash.slice('sha256:'.length)}.json`;
  fs.copyFileSync(
    path.join(scenario.runtimeRoot, 'private', 'dataset-harness-envelopes', envelopeName),
    path.join(otherPrivateRoot, envelopeName),
  );
  fs.chmodSync(path.join(otherPrivateRoot, envelopeName), 0o600);
  const copiedResolution = readOperatorDatasetHarness(mount, {
    authorityTrustStore: scenario.trustStore,
    runtimeRoot: otherRuntime,
    now: NOW,
  });
  assert.equal(copiedResolution.receipt.status, 'operator_dataset_harness_authority_blocked');
  assert.ok(copiedResolution.receipt.blockers.includes(
    'local_golden_dataset_runtime_scope_mismatch',
  ));

  const tampered = { ...mount, academicPromotionEligible: true };
  assert.throws(() => buildCampaignBenchmarkSelector({
    benchmarkId: scenario.options.datasetName,
    datasetMounts: [tampered],
  }), /campaign_benchmark_dataset_authorization_invalid/);

  const blocked = executeSystemBenchmarkHarness({
    benchmarkSelector: selector,
    datasetMounts: [mount],
    experimentAttemptId: 'local-golden-nonlocal-attempt',
    sourceLineageHash: `sha256:${'1'.repeat(64)}`,
    sourceMerkleHash: `sha256:${'2'.repeat(64)}`,
    sourceWorkspaceManifestHash: `sha256:${'3'.repeat(64)}`,
    outputDirectory: path.join(scenario.controlRoot, 'blocked-output'),
    armAdapterSet: null,
    runArmBatch() { throw new Error('must_not_execute'); },
    runtimeRoot: scenario.runtimeRoot,
    localOnly: false,
  });
  assert.equal(blocked.status, 'system_benchmark_harness_blocked');
  assert.ok(blocked.blockers.includes('local_golden_dataset_authority_requires_local_only_execution'));
});
