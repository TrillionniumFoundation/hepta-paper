import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { executeAutonomousResearchCampaign } from '../../paper-application/automation/autonomous-research-campaign.mjs';
import {
  createExternalResearchQualificationProcessAdapter,
  inspectExternalResearchQualificationProcessConfiguration,
  verifyExternalQualificationReleaseSignerAuthority,
} from '../../paper-adapters/automation/external-research-qualification-process-adapter.mjs';
import { readExternalResearchQualificationProcessConfiguration } from '../../paper-adapters/automation/external-research-qualification-process-identity.mjs';
import { verifyExternalResearchQualificationLocally } from '../../paper-adapters/automation/external-research-qualification-local-verifier.mjs';
import {
  FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
  fullResearchQualificationSigningPayloadHash,
} from '../../paper-domain/automation/full-research-qualification-contract.mjs';
import {
  REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
  RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE,
} from '../../paper-domain/automation/runtime-image-reproducibility-receipt-contract.mjs';
import { MANUSCRIPT_RELEASE_PROOF_FIELDS } from '../../paper-domain/automation/full-research-release-qualification-inspection.mjs';
import {
  EXTERNAL_RESEARCH_QUALIFICATION_NATIVE_FORMAL_INTAKE_VERSION,
  EXTERNAL_RESEARCH_QUALIFICATION_VERIFICATION_POLICY_VERSION,
  INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_REQUEST_VERSION,
  INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_RESPONSE_VERSION,
} from '../../paper-domain/automation/external-research-qualification-verification-policy-contract.mjs';
import {
  genericManuscriptReleaseFixture,
} from './support/autonomous-research-generalization-fixture.mjs';
import { exerciseExternalQualificationSignedEvidence } from './support/external-qualification-signed-evidence.data.mjs';
import {
  productionReleaseInspection,
} from './support/external-qualification-release-inspection-builder.mjs';

const H = (label) => hashRecord('AutonomousExternalQualificationTestHash', { label });

function memoryQualificationStateStore({ read, write }) {
  return deepFreezeJsonValue({
    kind: 'AutonomousResearchQualificationStateRepository',
    durable: true,
    compareAndSwap: true,
    systemOwnedRuntimeState: true,
    readExternalQualificationState: read,
    compareAndSwapExternalQualificationState({ expectedStateHash, state }) {
      assert.equal(
        read()?.autonomousExternalQualificationStateHash || null,
        expectedStateHash,
      );
      write(structuredClone(state));
      return state;
    },
  });
}

function receipt({
  privateKey,
  signer,
  releaseHash,
  qualifiedFixture,
  issuedAt,
  expiresAt,
}) {
  const { releaseBinding, preparation } = qualifiedFixture;
  const unsigned = {
    version: 1,
    kind: 'FullResearchGoldenMicroCampaignQualificationReceipt',
    status: 'full_research_golden_micro_campaign_qualified',
    externalActionPerformed: true,
    campaignId: releaseBinding.campaignId,
    paperId: releaseBinding.paperId,
    campaignReleaseBundleHash: releaseHash,
    proposalHash: preparation.proposal.machineProposedScientificClaimSetHash,
    policyAuthorizationHash:
      preparation.policyAuthorization.autonomousResearchPolicyAuthorizationHash,
    seedBindingHash: preparation.seedBinding.autonomousResearchSeedBindingHash,
    qualificationScope: releaseBinding.qualificationScope,
    genericContentCanaryVerified: releaseBinding.genericContentCanaryVerified,
    ...Object.fromEntries(MANUSCRIPT_RELEASE_PROOF_FIELDS.map((field) => (
      [field, releaseBinding[field]]
    ))),
    independentHypothesisPriorArtReviewVerified: true,
    independentHypothesisPriorArtReceiptHash:
      releaseBinding.priorArtEvidenceReceiptHash,
    priorArtEvidenceReceipt: releaseBinding.priorArtEvidenceReceipt,
    runtimeImageReproducibilityReceiptHash: H(`runtime-reproducibility:${releaseHash}`),
    runtimeImageReproducibilityRequiredProfiles:
      REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES,
    runtimeImageReproducibilityDefinitionManifestHashes: Object.fromEntries(
      REQUIRED_RUNTIME_IMAGE_REPRODUCIBILITY_PROFILES.map((profile) => (
        [profile, H(`runtime-definition:${profile}`)]
      )),
    ),
    empiricalFamilyPluginPackageHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.empiricalFamilyPluginPackageHash,
    empiricalFamilyPluginRegistryHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.empiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginStartupInspectionHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .empiricalFamilyPluginStartupInspectionHash,
    activeEmpiricalProductionProfileHashes:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE.activeProductionProfileHashes,
    runtimeImageReproducibilityActivePluginScopeHash:
      RUNTIME_IMAGE_REPRODUCIBILITY_ACTIVE_PLUGIN_SCOPE
        .runtimeImageReproducibilityActivePluginScopeHash,
    issuedAt,
    expiresAt,
    signer,
  };
  const signature = crypto.sign(
    null,
    Buffer.from(fullResearchQualificationSigningPayloadHash(unsigned), 'utf8'),
    privateKey,
  ).toString('base64');
  const signed = { ...unsigned, signature };
  return Object.freeze({
    ...signed,
    fullResearchQualificationReceiptHash:
      hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', signed),
  });
}

function resignQualificationReceipt(receiptValue, privateKey, mutate) {
  const {
    signature: _signature,
    fullResearchQualificationReceiptHash: _receiptHash,
    ...unsigned
  } = receiptValue;
  const changed = mutate(structuredClone(unsigned));
  const signature = crypto.sign(
    null,
    Buffer.from(fullResearchQualificationSigningPayloadHash(changed), 'utf8'),
    privateKey,
  ).toString('base64');
  const signed = { ...changed, signature };
  return Object.freeze({
    ...signed,
    fullResearchQualificationReceiptHash:
      hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', signed),
  });
}

function writeFile(candidate, value, mode) {
  fs.writeFileSync(candidate, value, { mode });
  fs.chmodSync(candidate, mode);
}

function processFixture(t, {
  receiptValue,
  trustedSignerValues = null,
  maximumQualificationCostUsd = 1.5,
  qualificationCostAuthority = 'operator_declared_worst_case_usd',
  lookupSignerPrivateKey = null,
  verifierBehavior = 'policy-v3',
  verifierAttestorStatus = 'active',
  verifierAttestorEffectiveFrom = '2026-07-01T00:00:00.000Z',
  verifierAttestorExpiresAt = '2027-07-01T00:00:00.000Z',
}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-external-qualification-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const receiptPath = path.join(base, 'receipt.json');
  const verifierPrivateKeyPath = path.join(base, 'verifier-private.pem');
  const verifierPublicKeyPath = path.join(base, 'verifier-public.pem');
  const qualifierScript = path.join(base, 'qualifier.cjs');
  const verifierScript = path.join(base, 'verifier.cjs');
  const configPath = path.join(base, 'external-qualification.json');
  const qualifierCredentialRoot = path.join(base, 'qualifier-credentials');
  const verifierCredentialRoot = path.join(base, 'verifier-credentials');
  fs.mkdirSync(qualifierCredentialRoot, { mode: 0o700 });
  fs.mkdirSync(verifierCredentialRoot, { mode: 0o700 });
  writeFile(path.join(qualifierCredentialRoot, 'credential'),
    'qualifier-private-credential\n', 0o600);
  const lookupSignerPrivateKeyPath = path.join(
    qualifierCredentialRoot,
    'lookup-signer-private.pem',
  );
  if (lookupSignerPrivateKey) {
    writeFile(lookupSignerPrivateKeyPath, lookupSignerPrivateKey, 0o600);
  }
  writeFile(path.join(verifierCredentialRoot, 'credential'),
    'verifier-private-credential\n', 0o600);
  const verifierKeys = crypto.generateKeyPairSync('ed25519');
  const verifierSigner = {
    keyId: 'independent-verifier-key:test',
    keyVersion: 'legacy-v1',
    subjectId: 'independent-verifier:test',
    organization: 'Independent Verification Test',
    role: 'external_qualification_independent_verifier',
    algorithm: 'ed25519',
    status: verifierAttestorStatus,
    effectiveFrom: verifierAttestorEffectiveFrom,
    expiresAt: verifierAttestorExpiresAt,
    revokedAt: null,
  };
  writeFile(receiptPath, `${JSON.stringify(receiptValue)}\n`, 0o600);
  const signerValues = trustedSignerValues || [{
    ...receiptValue.signer,
    publicKeyPem: receiptValue.publicKeyPem,
  }];
  const trustedSignerKeys = signerValues.map((value, index) => {
    const publicKeyPath = path.join(base, `qualification-public-${index}.pem`);
    writeFile(publicKeyPath, value.publicKeyPem, 0o600);
    const { publicKeyPem: _publicKeyPem, ...signerValue } = value;
    return Object.freeze({ ...signerValue, publicKeyPath });
  });
  writeFile(verifierPrivateKeyPath,
    verifierKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o600);
  writeFile(verifierPublicKeyPath,
    verifierKeys.publicKey.export({ type: 'spki', format: 'pem' }), 0o600);
  writeFile(qualifierScript, `#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function hashRecord(kind, value) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(stable({ kind, value }))).digest('hex');
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  delete value.publicKeyPem;
  if (request.kind === 'ExternalResearchQualificationLookupRequest') {
    const observedAt = '2026-07-15T12:30:00.000Z';
    const payload = {
      version: 1,
      kind: 'ExternalResearchQualificationLookupResponse',
      serviceId: request.serviceId,
      configurationIdentityHash: request.configurationIdentityHash,
      trustIdentityHash: request.trustIdentityHash,
      clientServiceIdentityHash: request.clientServiceIdentityHash,
      requestHash: request.requestHash,
      idempotencyKey: request.request.idempotencyKey,
      status: 'qualification_found',
      receipt: value,
      terminalFailureCodes: [],
      observedAt,
      signedAt: observedAt,
      signer: value.signer,
    };
    const lookupStatusHash = hashRecord('ExternalResearchQualificationLookupStatus', payload);
    const signingPayloadHash = hashRecord('ExternalResearchQualificationLookupStatusSigningPayload', { lookupStatusHash });
    const signature = crypto.sign(null, Buffer.from(signingPayloadHash, 'utf8'), fs.readFileSync(process.argv[3], 'utf8')).toString('base64');
    process.stdout.write(JSON.stringify({ ...payload, lookupStatusHash, signature }));
    return;
  }
  process.stdout.write(JSON.stringify({ version: 1, kind: 'ExternalResearchQualificationResponse', serviceId: request.serviceId, requestHash: request.requestHash, receipt: value }));
});
`, 0o700);
  writeFile(verifierScript, `#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function hashRecord(kind, value) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(stable({ kind, value }))).digest('hex');
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const receipt = request.receipt;
  const releaseBundle = request.campaignReleaseAuthority.releaseBundle;
  const releaseBinding = releaseBundle.autonomousResearchReleaseBinding;
  const policy = request.verificationPolicy;
  const policyHash = request.verificationPolicyHash;
  const structuredPriorArtEvidenceVerified =
    receipt.priorArtEvidenceReceipt?.version === 2
    && releaseBinding.priorArtEvidenceReceipt?.version === 2
    && receipt.independentHypothesisPriorArtReceiptHash
      === receipt.priorArtEvidenceReceipt.priorArtEvidenceReceiptHash
    && receipt.independentHypothesisPriorArtReceiptHash
      === releaseBinding.priorArtEvidenceReceiptHash
    && JSON.stringify(receipt.priorArtEvidenceReceipt)
      === JSON.stringify(releaseBinding.priorArtEvidenceReceipt);
  const formalIntakes =
    releaseBundle.researchReport?.capabilities?.formalCertificateIntakes;
  const nativeFormalCertificateIntakeV4Verified =
    request.version === ${INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_REQUEST_VERSION}
    && policy?.version === ${EXTERNAL_RESEARCH_QUALIFICATION_VERIFICATION_POLICY_VERSION}
    && policy?.nativeFormalCertificateIntakeVersion
      === ${EXTERNAL_RESEARCH_QUALIFICATION_NATIVE_FORMAL_INTAKE_VERSION}
    && Array.isArray(formalIntakes) && formalIntakes.length > 0
    && formalIntakes.every((intake) => {
      const { genericFormalCertificateIntakeHash: claimedHash, ...payload } =
        intake || {};
      return intake?.version === 4
      && intake?.kind === 'GenericFormalCertificateIntake'
      && intake.status === 'formal_certificate_intake_verified'
      && /^sha256:[0-9a-f]{64}$/.test(String(claimedHash || ''))
      && hashRecord('GenericFormalCertificateIntake', payload) === claimedHash
      && intake.authoritativeFormalReceiptVerified === true
      && intake.trustedNativeFormalReceiptVerified === true
      && intake.sourceSnapshotVerified === true
      && Array.isArray(intake.blockers) && intake.blockers.length === 0
      && intake.externalActionPerformed === false;
    });
  const recursiveReleaseClosureRequirementSatisfied =
    policy?.recursiveReleaseClosureRequired === false
    || (releaseBinding.version === 4
      && releaseBinding.researchReportHash === releaseBundle.researchReportHash
      && releaseBundle.researchReportHash
        === releaseBundle.researchReport?.researchReportHash
      && nativeFormalCertificateIntakeV4Verified);
  const inspection = {
    version: 1,
    kind: 'FullResearchQualificationInspection',
    status: 'full_research_qualification_verified',
    ready: true,
    receiptAccepted: true,
    campaignId: receipt.campaignId,
    paperId: receipt.paperId,
    campaignReleaseBundleHash: receipt.campaignReleaseBundleHash,
    qualificationReceiptHash: receipt.fullResearchQualificationReceiptHash,
    runtimeImageReproducibilityReceiptHash: receipt.runtimeImageReproducibilityReceiptHash,
    runtimeImageReproducibilityRequiredProfiles: receipt.runtimeImageReproducibilityRequiredProfiles,
    runtimeImageReproducibilityDefinitionManifestHashes: receipt.runtimeImageReproducibilityDefinitionManifestHashes,
    empiricalFamilyPluginPackageHash: receipt.empiricalFamilyPluginPackageHash,
    empiricalFamilyPluginRegistryHash: receipt.empiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginStartupInspectionHash: receipt.empiricalFamilyPluginStartupInspectionHash,
    activeEmpiricalProductionProfileHashes: receipt.activeEmpiricalProductionProfileHashes,
    runtimeImageReproducibilityActivePluginScopeHash: receipt.runtimeImageReproducibilityActivePluginScopeHash,
    proposalHash: receipt.proposalHash,
    policyAuthorizationHash: receipt.policyAuthorizationHash,
    seedBindingHash: receipt.seedBindingHash,
    qualificationScope: receipt.qualificationScope,
    genericContentCanaryVerified: receipt.genericContentCanaryVerified,
    trustedAutonomousManuscriptRenderReceiptHash: receipt.trustedAutonomousManuscriptRenderReceiptHash,
    evidenceBoundManuscriptIrHash: receipt.evidenceBoundManuscriptIrHash,
    manuscriptIrFileHash: receipt.manuscriptIrFileHash,
    renderedManuscriptHash: receipt.renderedManuscriptHash,
    agentExecutionReceiptHash: receipt.agentExecutionReceiptHash,
    isolatedAgentMergeReceiptHash: receipt.isolatedAgentMergeReceiptHash,
    agentAuthoredSourceDraftHash: receipt.agentAuthoredSourceDraftHash,
    agentAuthoredSourceDraftFileHash: receipt.agentAuthoredSourceDraftFileHash,
    agentWorkspacePostimageBindingHash: receipt.agentWorkspacePostimageBindingHash,
    venueProfileSelectionHash: receipt.venueProfileSelectionHash,
    submissionMetadataReceiptHash: receipt.submissionMetadataReceiptHash,
    independentHypothesisPriorArtReviewVerified: true,
    independentHypothesisPriorArtReceiptHash: receipt.independentHypothesisPriorArtReceiptHash,
    verificationPolicyHash: policyHash,
    structuredPriorArtEvidenceVerified,
    nativeFormalCertificateIntakeV4Verified,
    releaseBindingVersion: policy?.releaseBindingVersion,
    launchMode: policy?.launchMode,
    recursiveReleaseClosureRequired: policy?.recursiveReleaseClosureRequired,
    recursiveReleaseClosureRequirementSatisfied,
    allowBoundedGoldenCapability: policy?.allowBoundedGoldenCapability,
    blockers: [],
  };
  const behavior = ${JSON.stringify(verifierBehavior)};
  if (behavior === 'policy-hash-tamper') {
    inspection.verificationPolicyHash = 'sha256:' + 'a'.repeat(64);
  }
  if (behavior === 'structured-prior-art-false') {
    inspection.structuredPriorArtEvidenceVerified = false;
  }
  if (behavior === 'native-v4-false') {
    inspection.nativeFormalCertificateIntakeV4Verified = false;
  }
  if (behavior === 'legacy-native-v3-attestation') {
    delete inspection.nativeFormalCertificateIntakeV4Verified;
    inspection.nativeFormalCertificateIntakeV3Verified = true;
  }
  if (behavior === 'legacy-no-policy') {
    delete inspection.verificationPolicyHash;
    delete inspection.structuredPriorArtEvidenceVerified;
    delete inspection.nativeFormalCertificateIntakeV4Verified;
    delete inspection.releaseBindingVersion;
    delete inspection.launchMode;
    delete inspection.recursiveReleaseClosureRequired;
    delete inspection.recursiveReleaseClosureRequirementSatisfied;
    delete inspection.allowBoundedGoldenCapability;
  }
  const payload = {
    version: behavior === 'legacy-no-policy' ? 1
      : behavior === 'legacy-response-v2' ? 2
        : ${INDEPENDENT_EXTERNAL_RESEARCH_QUALIFICATION_RESPONSE_VERSION},
    kind: 'IndependentExternalResearchQualificationVerificationResponse',
    verifierId: request.verifierId,
    requestHash: request.requestHash,
    signedAt: request.verifiedAt,
    signer: ${JSON.stringify(verifierSigner)},
    inspection,
  };
  if (behavior !== 'legacy-no-policy') {
    payload.verificationPolicyHash = behavior === 'policy-hash-tamper'
      ? 'sha256:' + 'b'.repeat(64) : policyHash;
  }
  const responseHash = hashRecord('IndependentExternalResearchQualificationVerificationResponse', payload);
  const signingPayloadHash = hashRecord('IndependentExternalResearchQualificationVerificationResponseSigningPayload', payload);
  const signature = crypto.sign(null, Buffer.from(signingPayloadHash, 'utf8'), fs.readFileSync(process.argv[2], 'utf8')).toString('base64');
  process.stdout.write(JSON.stringify({ ...payload, responseHash, signature }));
});
`, 0o700);
  const configuration = {
    version: 3,
    kind: 'ExternalResearchQualificationProcessConfiguration',
    status: 'active',
    maximumQualificationCostUsd,
    qualificationCostAuthority,
    qualifier: {
      serviceId: 'external-qualifier:test',
      principalId: 'external-qualifier-principal:test',
      protocol: 'external-qualification-json-stdio-v1',
      executable: qualifierScript,
      credentialRoot: qualifierCredentialRoot,
      args: [receiptPath, ...(lookupSignerPrivateKey ? [lookupSignerPrivateKeyPath] : [])],
      environmentAllowlist: [],
      timeoutMs: 10_000,
    },
    verifier: {
      serviceId: 'independent-verifier:test',
      principalId: 'independent-verifier-principal:test',
      protocol: 'external-qualification-json-stdio-v1',
      executable: verifierScript,
      credentialRoot: verifierCredentialRoot,
      args: [verifierPrivateKeyPath],
      environmentAllowlist: [],
      timeoutMs: 10_000,
    },
    trustedSignerTrustSet: {
      version: 1,
      kind: 'ResearchExecutionReleaseAttestorTrustSet',
      keys: trustedSignerKeys,
    },
    verifierAttestor: {
      ...verifierSigner,
      publicKeyPath: verifierPublicKeyPath,
    },
  };
  writeFile(configPath, `${JSON.stringify(configuration, null, 2)}\n`, 0o600);
  return {
    base,
    configPath,
    configuration,
    receiptPath,
    verifierPrivateKeyPath,
    verifierSigner,
  };
}

function qualifiedReleaseFixture({
  campaignId,
  paperId,
  objective = 'Verify the external qualification trust boundary.',
} = {}) {
  const campaignPlanHash = H(`campaign-plan:${campaignId}`);
  return genericManuscriptReleaseFixture({
    campaignId,
    paperId,
    campaignPlanHash,
    objective,
    protocolFamily: 'ml_algorithm_benchmark',
    externalSubmission: true,
  });
}

function releaseAuthority(releaseHash, qualifiedFixture) {
  const {
    releaseBinding: autonomousResearchReleaseBinding,
    researchReport,
  } = qualifiedFixture;
  const {
    campaignId,
    paperId,
    campaignPlanHash,
  } = autonomousResearchReleaseBinding;
  const proposalClaimToTheoremBinding = researchReport
    ?.capabilities?.proposalClaimToTheoremBinding || null;
  return Object.freeze({
    status: 'current_completed_release',
    campaignStatus: 'completed',
    packageNodeStatus: 'completed',
    campaignId,
    paperId,
    campaignReleaseBundleHash: releaseHash,
    releaseBundle: {
      campaignPlanHash,
      campaignReleaseBundleHash: releaseHash,
      status: 'campaign_release_bundle_prepared',
      autonomousResearchReleaseBindingHash:
        autonomousResearchReleaseBinding.autonomousResearchReleaseBindingHash,
      autonomousResearchReleaseBinding,
      researchReport,
      researchReportHash: researchReport?.researchReportHash || null,
      campaignResearchSourceSnapshotHash:
        researchReport?.campaignResearchSourceSnapshotHash || null,
      proposalClaimToTheoremBindingHash:
        proposalClaimToTheoremBinding?.proposalClaimToTheoremBindingHash || null,
    },
  });
}

test('local qualification verifier owns malformed-envelope fail-closed behavior', async () => {
  const blockedCalls = [];
  const blocked = await verifyExternalResearchQualificationLocally({
    receipt: null,
    campaignReleaseAuthority: null,
    preparation: null,
    independentVerificationEvidence: null,
    observedAt: new Date('2026-07-15T12:30:00.000Z'),
    configuration: Object.freeze({
      verifier: Object.freeze({ serviceId: 'direct-local-verifier:test' }),
    }),
    fullVerificationContextProvider: null,
    freshlyIssuedReceipts: new Set(),
    now: () => new Date('2026-07-15T12:30:00.000Z'),
    blockedInspection(blockers, envelope, verifierId, failureCodes, configuration) {
      blockedCalls.push({ blockers, envelope, verifierId, failureCodes, configuration });
      return Object.freeze({ ready: false, blockers, failureCodes, verifierId });
    },
    envelopeFailureCodes: (blockers) => blockers.map((blocker) => `direct:${blocker}`),
    verifyDetachedSignature: () => false,
    verifyReleaseAttestation: () => false,
  });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.verifierId, 'direct-local-verifier:test');
  assert.equal(blockedCalls.length, 1);
  assert.ok(blocked.blockers.length > 0);
  assert.deepEqual(blocked.failureCodes, blocked.blockers.map((item) => `direct:${item}`));
});

test('process qualifier and distinct verifier enforce signature, time, and current release binding', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signer = Object.freeze({
    keyId: 'qualification-key:test',
    keyVersion: 'legacy-v1',
    subjectId: 'external-attestor:test',
    organization: 'External Qualification Test',
    role: FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    revokedAt: null,
  });
  const campaignId = 'autonomous-research:process-qualified';
  const paperId = 'process-qualified';
  const releaseHash = H('current-release');
  const qualifiedFixture = qualifiedReleaseFixture({
    campaignId,
    paperId,
  });
  const { preparation } = qualifiedFixture;
  const validReceipt = receipt({
    privateKey,
    signer,
    releaseHash,
    qualifiedFixture,
    issuedAt: '2026-07-15T12:00:00.000Z',
    expiresAt: '2026-07-15T13:00:00.000Z',
  });
  const receiptValue = {
    ...validReceipt, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
  const fixture = processFixture(t, {
    receiptValue,
    lookupSignerPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  assert.throws(() => readExternalResearchQualificationProcessConfiguration(
    { configPath: fixture.configPath, environment: { PATH: '' } },
  ), /external_qualification_interpreter_not_found/);
  const fixedVerifierCredentialTime = new Date('2026-07-15T11:59:00.000Z');
  fs.utimesSync(
    fixture.verifierPrivateKeyPath,
    fixedVerifierCredentialTime,
    fixedVerifierCredentialTime,
  );
  let now = new Date('2026-07-15T12:30:00.000Z');
  const adapter = createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
    clock: { now: () => now },
  });
  assert.equal(adapter.inspection.independentVerifierConfigured, true);
  assert.equal(adapter.inspection.privateSigningKeyLoaded, false);
  assert.equal(adapter.inspection.maximumQualificationCostUsd, 1.5);
  assert.equal(
    adapter.inspection.qualificationCostAuthority,
    'operator_declared_worst_case_usd',
  );
  assert.equal(adapter.client.maximumQualificationCostUsd, 1.5);
  assert.equal(adapter.verifier.maximumQualificationCostUsd, 1.5);
  const authority = releaseAuthority(releaseHash, qualifiedFixture);
  const issued = await adapter.client.requestQualification({ campaignId, paperId, releaseHash });
  const missingInputBlocked = await adapter.verifier.verify();
  assert.equal(missingInputBlocked.ready, false);

  const implicitClockAdapter = createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
  });
  const implicitClockBlocked = await implicitClockAdapter.verifier.verify();
  assert.equal(implicitClockBlocked.ready, false);

  const stringClockAdapter = createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
    clock: { now: () => now.toISOString() },
  });
  const stringClockBlocked = await stringClockAdapter.verifier.verify();
  assert.equal(stringClockBlocked.ready, false);

  const invalidClockAdapter = createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
    clock: { now: () => 'not-an-instant' },
  });
  const invalidClockBlocked = await invalidClockAdapter.verifier.verify();
  assert.equal(invalidClockBlocked.ready, false);

  const unavailableAdapter = createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
    clock: { now: () => now.toISOString() },
    runProcess: async () => { throw null; },
  });
  const unavailable = await unavailableAdapter.verifier.verify({
    receipt: issued,
    campaignReleaseAuthority: authority,
    preparation,
  });
  assert.equal(unavailable.ready, false);
  assert.ok(unavailable.failureCodes.includes(
    'external_qualification.independent_verifier_unavailable',
  ));
  const missingReceiptAdapter = createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
    clock: { now: () => now },
    runProcess: async ({ stdin }) => {
      const request = JSON.parse(stdin);
      const response = JSON.stringify({
        version: 1,
        kind: 'ExternalResearchQualificationResponse',
        serviceId: request.serviceId,
        requestHash: request.requestHash,
        receipt: null,
      });
      return { exitCode: 0, stdout: response, stdoutBytes: Buffer.byteLength(response) };
    },
  });
  await assert.rejects(
    () => missingReceiptAdapter.client.requestQualification({ campaignId, paperId, releaseHash }),
    /external_qualification_response_binding_invalid/,
  );
  const expectedLookupRequest = Object.freeze({
    campaignId,
    paperId,
    campaignReleaseBundleHash: releaseHash,
    idempotencyKey: H('lookup-idempotency'),
    qualificationCycle: 1,
    qualificationEpoch: 1,
    qualificationAttempt: 1,
    qualificationTotalAttempt: 1,
    sideEffectPermitHash: H('lookup-side-effect-permit'),
  });
  const lookupCandidate = await adapter.client.lookupQualification(
    expectedLookupRequest,
  );
  assert.equal(lookupCandidate.authoritative, undefined);
  assert.equal(lookupCandidate.signatureVerified, undefined);
  const verifiedLookup = adapter.verifier.verifyLookup({
    candidate: lookupCandidate,
    expectedRequest: expectedLookupRequest,
  });
  assert.equal(verifiedLookup.status, 'qualification_found');
  assert.equal(verifiedLookup.receipt.fullResearchQualificationReceiptHash,
    validReceipt.fullResearchQualificationReceiptHash);
  assert.equal(verifiedLookup.sideEffectPermitHash,
    expectedLookupRequest.sideEffectPermitHash);
  const permitTamper = structuredClone(lookupCandidate);
  permitTamper.request.sideEffectPermitHash = H('tampered-side-effect-permit');
  assert.throws(() => adapter.verifier.verifyLookup({
    candidate: permitTamper,
    expectedRequest: expectedLookupRequest,
  }), /lookup_response_binding_invalid/);
  assert.throws(() => adapter.verifier.verifyLookup({
    candidate: Object.freeze({
      authoritative: true,
      signatureVerified: true,
      requestDigestVerified: true,
      status: 'qualification_found',
      receipt: validReceipt,
    }),
    expectedRequest: expectedLookupRequest,
  }), /lookup_response_binding_invalid/);
  const verified = await adapter.verifier.verify({
    receipt: issued,
    campaignReleaseAuthority: authority,
    preparation,
  });
  assert.equal(verified.ready, false);
  assert.ok(
    verified.blockers.includes('external_qualification_full_verification_context_required'),
    JSON.stringify(verified),
  );

  for (const verifierBehavior of [
    'legacy-no-policy', 'legacy-response-v2', 'legacy-native-v3-attestation',
    'policy-hash-tamper', 'structured-prior-art-false', 'native-v4-false',
  ]) {
    const policyAttackFixture = processFixture(t, {
      receiptValue,
      verifierBehavior,
    });
    const policyAttackAdapter = createExternalResearchQualificationProcessAdapter({
      configPath: policyAttackFixture.configPath,
      cwd: policyAttackFixture.base,
      clock: { now: () => now },
    });
    const blocked = await policyAttackAdapter.verifier.verify({
      receipt: issued,
      campaignReleaseAuthority: authority,
      preparation,
    });
    assert.equal(blocked.ready, false, verifierBehavior);
    assert.ok(blocked.failureCodes.includes(
      'external_qualification.independent_verification_binding_invalid',
    ), verifierBehavior);
  }

  const fullConfiguration = readExternalResearchQualificationProcessConfiguration({
    configPath: fixture.configPath,
    environment: process.env,
  });

  const currentQualificationKey = fullConfiguration.trustedSigners[0];
  const releaseAttestorInspection = productionReleaseInspection({
    trustedKeys: fullConfiguration.trustedSigners,
    activeKey: currentQualificationKey,
  });
  const authorityWithReleaseSigner = Object.freeze({
    ...authority,
    releaseBundle: Object.freeze({
      ...authority.releaseBundle,
      researchExecutionReleaseAttestation: Object.freeze({
        ...signer,
        signedAt: issued.issuedAt,
      }),
    }),
  });
  const fullDomainAdapter = createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
    clock: { now: () => now },
    fullVerificationContextProvider: async () => Object.freeze({
      releaseAttestorInspection,
    }),
  });
  const fullDomainBlocked = await fullDomainAdapter.verifier.verify({
    receipt: issued,
    campaignReleaseAuthority: authorityWithReleaseSigner,
    preparation,
  });
  assert.equal(fullDomainBlocked.ready, false);
  assert.ok(fullDomainBlocked.blockers.includes(
    'external_qualification_full_domain_verification_failed',
  ));

  const priorQualifiedFixture = qualifiedReleaseFixture({
    campaignId,
    paperId,
    objective: 'A superseded machine hypothesis for the same paper identifier',
  });
  const priorReceipt = receipt({
    privateKey,
    signer,
    releaseHash,
    qualifiedFixture: priorQualifiedFixture,
    issuedAt: '2026-07-15T12:00:00.000Z',
    expiresAt: '2026-07-15T13:00:00.000Z',
  });
  const priorAuthority = releaseAuthority(releaseHash, priorQualifiedFixture);
  await exerciseExternalQualificationSignedEvidence({
    t,
    fixture,
    fullConfiguration,
    receiptValue,
    issued,
    authority,
    preparation,
    now,
    adapter,
    processFixture,
    donorReceipt: priorReceipt,
    donorAuthority: priorAuthority,
    donorPreparation: priorQualifiedFixture.preparation,
  });

  const verifierPrivateKey = fs.readFileSync(fixture.verifierPrivateKeyPath, 'utf8');
  const attackerVerifierKey = crypto.generateKeyPairSync('ed25519').privateKey
    .export({ type: 'pkcs8', format: 'pem' });
  assert.equal(Buffer.byteLength(attackerVerifierKey), Buffer.byteLength(verifierPrivateKey));
  writeFile(fixture.verifierPrivateKeyPath, attackerVerifierKey, 0o600);
  fs.utimesSync(
    fixture.verifierPrivateKeyPath,
    fixedVerifierCredentialTime,
    fixedVerifierCredentialTime,
  );
  assert.equal(
    fs.statSync(fixture.verifierPrivateKeyPath).mtimeMs,
    fixedVerifierCredentialTime.getTime(),
  );
  const verifierAttestationBlocked = await adapter.verifier.verify({
    receipt: issued,
    campaignReleaseAuthority: authority,
    preparation,
  });
  assert.equal(verifierAttestationBlocked.ready, false);
  assert.ok(verifierAttestationBlocked.blockers.some((blocker) => blocker.includes(
    'external_qualification_process_identity_changed',
  )));
  writeFile(fixture.verifierPrivateKeyPath, verifierPrivateKey, 0o600);

  const attackerSigned = { ...issued, signature: Buffer.alloc(64, 7).toString('base64') };
  const tamperedSignature = {
    ...attackerSigned,
    fullResearchQualificationReceiptHash:
      hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', attackerSigned),
  };
  const signatureBlocked = await adapter.verifier.verify({
    receipt: tamperedSignature,
    campaignReleaseAuthority: authority,
    preparation,
  });
  assert.equal(signatureBlocked.ready, false);
  assert.ok(signatureBlocked.blockers.includes('external_qualification_signature_invalid'));

  const priorArtBlocked = await adapter.verifier.verify({
    receipt: resignQualificationReceipt(issued, privateKey, (candidate) => {
      candidate.independentHypothesisPriorArtReviewVerified = false;
      return candidate;
    }),
    campaignReleaseAuthority: authority,
    preparation,
  });
  assert.equal(priorArtBlocked.ready, false);
  assert.ok(priorArtBlocked.blockers.includes(
    'external_qualification_independent_hypothesis_prior_art_qualification_invalid',
  ));
  assert.ok(priorArtBlocked.failureCodes.includes(
    'external_qualification.prior_art_qualification_invalid',
  ));

  const scopeBlocked = await adapter.verifier.verify({
    receipt: resignQualificationReceipt(issued, privateKey, (candidate) => {
      candidate.qualificationScope = 'attacker-selected-release-scope';
      return candidate;
    }),
    campaignReleaseAuthority: authority,
    preparation,
  });
  assert.equal(scopeBlocked.ready, false);
  assert.ok(scopeBlocked.blockers.includes(
    'external_qualification_release_scope_not_eligible',
  ));
  assert.ok(scopeBlocked.failureCodes.includes(
    'external_qualification.release_scope_not_eligible',
  ));

  const manuscriptProofBlocked = await adapter.verifier.verify({
    receipt: resignQualificationReceipt(issued, privateKey, (candidate) => {
      candidate.renderedManuscriptHash = H('attacker-rendered-manuscript');
      return candidate;
    }),
    campaignReleaseAuthority: authority,
    preparation,
  });
  assert.equal(manuscriptProofBlocked.ready, false);
  assert.ok(manuscriptProofBlocked.blockers.includes(
    'external_qualification_manuscript_release_proof_mismatch',
  ));
  assert.ok(manuscriptProofBlocked.failureCodes.includes(
    'external_qualification.manuscript_release_proof_mismatch',
  ));

  const releaseBlocked = await adapter.verifier.verify({
    receipt: issued,
    campaignReleaseAuthority:
      releaseAuthority(H('replacement-release'), qualifiedFixture),
    preparation,
  });
  assert.equal(releaseBlocked.ready, false);
  assert.ok(releaseBlocked.blockers.includes('external_qualification_current_release_pointer_mismatch'));

  const substitutionBlocked = await adapter.verifier.verify({
    receipt: priorReceipt,
    campaignReleaseAuthority: authority,
    preparation,
  });
  assert.equal(substitutionBlocked.ready, false);
  assert.ok(substitutionBlocked.blockers.includes(
    'external_qualification_autonomous_preparation_binding_mismatch',
  ));

  now = new Date('2026-07-15T13:00:00.000Z');
  const expired = await adapter.verifier.verify({
    receipt: issued,
    campaignReleaseAuthority: authority,
    preparation,
  });
  assert.equal(expired.ready, false);
  assert.ok(expired.blockers.includes('external_qualification_receipt_outside_time_window'));
});

test('campaign never caches an envelope-only receipt and rejects stale cached receipts', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signer = Object.freeze({
    keyId: 'qualification-key:cache-test',
    keyVersion: 'legacy-v1',
    subjectId: 'external-attestor:cache-test',
    organization: 'Cache Qualification Test',
    role: FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    revokedAt: null,
  });
  const campaignId = 'autonomous-research:cache-revalidation';
  const paperId = 'cache-revalidation';
  const releaseHash = H('cache-release');
  const qualifiedFixture = qualifiedReleaseFixture({
    campaignId,
    paperId,
  });
  const { preparation } = qualifiedFixture;
  const validReceipt = receipt({
    privateKey,
    signer,
    releaseHash,
    qualifiedFixture,
    issuedAt: '2026-07-15T14:00:00.000Z',
    expiresAt: '2026-07-15T15:00:00.000Z',
  });
  const fixture = processFixture(t, {
    receiptValue: {
      ...validReceipt,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    },
  });
  let now = new Date('2026-07-15T14:30:00.000Z');
  const adapter = createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
    clock: { now: () => now },
  });
  const campaign = {
    campaignId,
    paperId,
    status: 'completed',
    spec: { autonomousResearchPreparation: preparation },
  };
  const campaignStore = {
    createCampaign() { throw new Error('unexpected create'); },
    getCampaign() { return campaign; },
    listNodes() { return []; },
    resumeCampaign() { throw new Error('unexpected resume'); },
  };
  let cachedState = null;
  const qualificationStateStore = memoryQualificationStateStore({
    read() { return cachedState; },
    write(value) { cachedState = value; },
  });
  const common = {
    campaignId,
    campaignStore,
    campaignReleaseAuthorityReader: () => releaseAuthority(releaseHash, qualifiedFixture),
    externalQualificationClient: adapter.client,
    externalQualificationVerifier: adapter.verifier,
    qualificationStateStore,
    autonomousSubmissionRequestVerifier: { kind: 'AutonomousSubmissionRequestVerifier', verify: () => false },
    autonomousSubmissionOutbox: { kind: 'AutonomousSubmissionHandoffOutboxPort', durability: 'sqlite-transactional-outbox-v1', externallyFencedMutations: false, prepareAutonomousSubmission() { throw new Error('unexpected submission'); }, getAutonomousSubmission() { return null; }, listAutonomousSubmissionsForCampaign() { return []; } },
  };
  const envelopeOnly = await executeAutonomousResearchCampaign({ ...common, action: 'resume' });
  assert.notEqual(envelopeOnly.status, 'autonomous_research_campaign_completed_and_qualified');
  assert.equal(envelopeOnly.externalQualification.status, 'qualification_external_service_blocked');
  assert.equal(cachedState.version, 4);
  assert.equal(cachedState.receipt, null);
  assert.equal(cachedState.recovery.status, 'qualification_terminal_blocked');
  assert.equal(cachedState.verifiedInspection, null);
  cachedState = {
    version: 2,
    kind: 'AutonomousExternalQualificationState',
    campaignId,
    paperId,
    campaignReleaseBundleHash: releaseHash,
    receipt: validReceipt,
  };

  const missingVerifier = await executeAutonomousResearchCampaign({
    ...common,
    action: 'status',
    externalQualificationClient: null,
    externalQualificationVerifier: null,
  });
  assert.notEqual(missingVerifier.status, 'autonomous_research_campaign_completed_and_qualified');
  assert.equal(missingVerifier.externalQualification.status,
    'qualification_external_state_invalid');

  now = new Date('2026-07-15T15:00:00.000Z');
  const staleStatus = await executeAutonomousResearchCampaign({ ...common, action: 'status' });
  assert.notEqual(staleStatus.status, 'autonomous_research_campaign_completed_and_qualified');
  assert.equal(staleStatus.externalQualification.status,
    'qualification_external_state_invalid');
  assert.equal(staleStatus.qualificationEligibility.fullAutomaticResearchWritingReady, false);

  now = new Date('2026-07-15T14:30:00.000Z');
  const forgedPayload = {
    ...validReceipt,
    signature: Buffer.alloc(64, 3).toString('base64'),
  };
  delete forgedPayload.fullResearchQualificationReceiptHash;
  const forgedReceipt = {
    ...forgedPayload,
    fullResearchQualificationReceiptHash:
      hashRecord('FullResearchGoldenMicroCampaignQualificationReceipt', forgedPayload),
  };
  writeFile(fixture.receiptPath, `${JSON.stringify(forgedReceipt)}\n`, 0o600);
  const forgedAdapter = createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
    clock: { now: () => now },
  });
  let forgedCache = null;
  const forgedAttempt = await executeAutonomousResearchCampaign({
    ...common,
    action: 'resume',
    externalQualificationClient: forgedAdapter.client,
    externalQualificationVerifier: forgedAdapter.verifier,
    qualificationStateStore: memoryQualificationStateStore({
      read() { return forgedCache; },
      write(value) { forgedCache = value; },
    }),
  });
  assert.notEqual(forgedAttempt.status, 'autonomous_research_campaign_completed_and_qualified');
  assert.equal(forgedAttempt.externalQualification.status, 'qualification_external_service_blocked');
  assert.equal(forgedCache.version, 4);
  assert.equal(forgedCache.receipt, null);
  assert.equal(forgedCache.recovery.status, 'qualification_terminal_blocked');
  assert.equal(forgedCache.verifiedInspection, null);
});

test('configuration v3 binds qualifier and verifier total cost authority into identity', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signer = Object.freeze({
    keyId: 'qualification-key:cost-authority',
    keyVersion: 'legacy-v1',
    subjectId: 'external-attestor:cost-authority',
    organization: 'External Qualification Cost Authority',
    role: FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    revokedAt: null,
  });
  const qualifiedFixture = qualifiedReleaseFixture({
    campaignId: 'autonomous-research:qualification-cost-authority',
    paperId: 'qualification-cost-authority',
  });
  const value = receipt({
    privateKey,
    signer,
    releaseHash: H('qualification-cost-authority-release'),
    qualifiedFixture,
    issuedAt: '2026-07-15T14:00:00.000Z',
    expiresAt: '2026-07-15T15:00:00.000Z',
  });
  const fixture = processFixture(t, {
    receiptValue: {
      ...value,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    },
  });
  const original = readExternalResearchQualificationProcessConfiguration({
    configPath: fixture.configPath,
    environment: process.env,
  });
  assert.equal(original.maximumQualificationCostUsd, 1.5);
  assert.equal(original.qualificationCostAuthority, 'operator_declared_worst_case_usd');

  const writeConfiguration = (configuration) => writeFile(
    fixture.configPath,
    `${JSON.stringify(configuration, null, 2)}\n`,
    0o600,
  );
  writeConfiguration({ ...fixture.configuration, maximumQualificationCostUsd: 2.25 });
  const repriced = readExternalResearchQualificationProcessConfiguration({
    configPath: fixture.configPath,
    environment: process.env,
  });
  assert.notEqual(repriced.configurationIdentityHash, original.configurationIdentityHash);

  for (const invalid of [
    { ...fixture.configuration, version: 2 },
    { ...fixture.configuration, maximumQualificationCostUsd: 0 },
    { ...fixture.configuration, maximumQualificationCostUsd: 1000.01 },
    {
      ...fixture.configuration,
      maximumQualificationCostUsd: 1,
      qualificationCostAuthority: 'externally_operated_zero_cost',
    },
  ]) {
    writeConfiguration(invalid);
    assert.throws(() => readExternalResearchQualificationProcessConfiguration({
      configPath: fixture.configPath,
      environment: process.env,
    }), /external_qualification_configuration_invalid/);
  }

  writeConfiguration({
    ...fixture.configuration,
    maximumQualificationCostUsd: 0,
    qualificationCostAuthority: 'externally_operated_zero_cost',
  });
  const zeroCost = readExternalResearchQualificationProcessConfiguration({
    configPath: fixture.configPath,
    environment: process.env,
  });
  assert.equal(zeroCost.maximumQualificationCostUsd, 0);
  assert.equal(zeroCost.qualificationCostAuthority, 'externally_operated_zero_cost');
});

test('configuration rejects a qualifier posing as its own independent verifier', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signer = Object.freeze({
    keyId: 'qualification-key:separation-test',
    keyVersion: 'legacy-v1',
    subjectId: 'external-attestor:separation-test',
    organization: 'Release Qualification Separation Test',
    role: FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    revokedAt: null,
  });
  const qualifiedFixture = qualifiedReleaseFixture({
    campaignId: 'autonomous-research:separation',
    paperId: 'separation',
  });
  const value = receipt({
    privateKey,
    signer,
    releaseHash: H('separation-release'),
    qualifiedFixture,
    issuedAt: '2026-07-15T14:00:00.000Z',
    expiresAt: '2026-07-15T15:00:00.000Z',
  });
  const fixture = processFixture(t, {
    receiptValue: { ...value, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) },
  });
  const configuration = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
  configuration.verifier = {
    ...configuration.verifier,
    executable: configuration.qualifier.executable,
    args: [...configuration.qualifier.args, '--pretend-independent-verifier'],
  };
  writeFile(fixture.configPath, `${JSON.stringify(configuration, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
  }), /external_qualification_independent_verifier_required/);

  const sharedCredentialConfigPath = path.join(fixture.base, 'shared-credential-config.json');
  writeFile(sharedCredentialConfigPath, `${JSON.stringify({
    ...fixture.configuration,
    verifier: {
      ...fixture.configuration.verifier,
      credentialRoot: fixture.configuration.qualifier.credentialRoot,
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: sharedCredentialConfigPath,
    cwd: fixture.base,
  }), /external_qualification_independent_verifier_required/);

  const emptyCredentialRoot = path.join(fixture.base, 'empty-credential-root');
  fs.mkdirSync(emptyCredentialRoot, { mode: 0o700 });
  const emptyCredentialConfigPath = path.join(
    fixture.base,
    'empty-credential-config.json',
  );
  writeFile(emptyCredentialConfigPath, `${JSON.stringify({
    ...fixture.configuration,
    qualifier: {
      ...fixture.configuration.qualifier,
      credentialRoot: emptyCredentialRoot,
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: emptyCredentialConfigPath,
    cwd: fixture.base,
  }), /external_qualification_credential_root_contents_invalid/);

  const zeroByteCredentialRoot = path.join(fixture.base, 'zero-byte-credential-root');
  fs.mkdirSync(zeroByteCredentialRoot, { mode: 0o700 });
  writeFile(path.join(zeroByteCredentialRoot, 'empty-token'), '', 0o600);
  const zeroByteCredentialConfigPath = path.join(
    fixture.base,
    'zero-byte-credential-config.json',
  );
  writeFile(zeroByteCredentialConfigPath, `${JSON.stringify({
    ...fixture.configuration,
    verifier: {
      ...fixture.configuration.verifier,
      credentialRoot: zeroByteCredentialRoot,
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: zeroByteCredentialConfigPath,
    cwd: fixture.base,
  }), /external_qualification_credential_root_contents_invalid/);

  const copiedQualifierCredentialRoot = path.join(
    fixture.base,
    'copied-qualifier-credentials',
  );
  const copiedVerifierCredentialRoot = path.join(
    fixture.base,
    'copied-verifier-credentials',
  );
  fs.mkdirSync(copiedQualifierCredentialRoot, { mode: 0o700 });
  fs.mkdirSync(copiedVerifierCredentialRoot, { mode: 0o700 });
  writeFile(path.join(copiedQualifierCredentialRoot, 'qualifier-token'),
    'same-private-credential\n', 0o600);
  writeFile(path.join(copiedVerifierCredentialRoot, 'renamed-verifier-token'),
    'same-private-credential\n', 0o600);
  writeFile(path.join(copiedVerifierCredentialRoot, 'unrelated-material'),
    'different-private-credential\n', 0o600);
  const copiedCredentialConfigPath = path.join(
    fixture.base,
    'copied-credential-config.json',
  );
  writeFile(copiedCredentialConfigPath, `${JSON.stringify({
    ...fixture.configuration,
    qualifier: {
      ...fixture.configuration.qualifier,
      credentialRoot: copiedQualifierCredentialRoot,
    },
    verifier: {
      ...fixture.configuration.verifier,
      credentialRoot: copiedVerifierCredentialRoot,
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: copiedCredentialConfigPath,
    cwd: fixture.base,
  }), /external_qualification_independent_verifier_required/);

  const missingVerifierOrganizationPath = path.join(
    fixture.base,
    'missing-verifier-organization-config.json',
  );
  writeFile(missingVerifierOrganizationPath, `${JSON.stringify({
    ...fixture.configuration,
    verifierAttestor: {
      ...fixture.configuration.verifierAttestor,
      organization: null,
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: missingVerifierOrganizationPath,
    cwd: fixture.base,
  }), /external_qualification_verifier_attestor_invalid/);

  const missingReleaseOrganizationPath = path.join(
    fixture.base,
    'missing-release-organization-config.json',
  );
  writeFile(missingReleaseOrganizationPath, `${JSON.stringify({
    ...fixture.configuration,
    trustedSignerTrustSet: {
      ...fixture.configuration.trustedSignerTrustSet,
      keys: fixture.configuration.trustedSignerTrustSet.keys.map((key, index) => (
        index === 0 ? { ...key, organization: null } : key
      )),
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: missingReleaseOrganizationPath,
    cwd: fixture.base,
  }), /external_qualification_trusted_signer_invalid/);

  const sharedOrganizationConfigPath = path.join(
    fixture.base,
    'shared-organization-config.json',
  );
  writeFile(sharedOrganizationConfigPath, `${JSON.stringify({
    ...fixture.configuration,
    verifierAttestor: {
      ...fixture.configuration.verifierAttestor,
      organization: `${signer.organization.toUpperCase()}  `,
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: sharedOrganizationConfigPath,
    cwd: fixture.base,
  }), /external_qualification_independent_verifier_organization_required/);

  const privateKeyPath = path.join(fixture.base, 'forbidden-private-key.pem');
  const privateConfigPath = path.join(fixture.base, 'private-key-config.json');
  writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o600);
  writeFile(privateConfigPath, `${JSON.stringify({
    ...fixture.configuration,
    trustedSignerTrustSet: {
      ...fixture.configuration.trustedSignerTrustSet,
      keys: fixture.configuration.trustedSignerTrustSet.keys.map((key, index) => (
        index === 0 ? { ...key, publicKeyPath: privateKeyPath } : key
      )),
    },
  }, null, 2)}\n`, 0o600);
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: privateConfigPath,
    cwd: fixture.base,
  }), /external_qualification_trusted_signer_public_key_invalid/);
});

test('configuration rejects one Ed25519 signer key under different PEM encodings', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signer = Object.freeze({
    keyId: 'qualification-key:spki-separation-test',
    keyVersion: 'legacy-v1',
    subjectId: 'external-attestor:spki-separation-test',
    organization: 'SPKI Separation Test',
    role: FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    revokedAt: null,
  });
  const qualifiedFixture = qualifiedReleaseFixture({
    campaignId: 'autonomous-research:spki-separation',
    paperId: 'spki-separation',
  });
  const value = receipt({
    privateKey,
    signer,
    releaseHash: H('spki-separation-release'),
    qualifiedFixture,
    issuedAt: '2026-07-15T14:00:00.000Z',
    expiresAt: '2026-07-15T15:00:00.000Z',
  });
  const canonicalPem = publicKey.export({ type: 'spki', format: 'pem' });
  const fixture = processFixture(t, {
    receiptValue: { ...value, publicKeyPem: canonicalPem },
  });
  const alternatePublicKeyPath = path.join(fixture.base, 'same-spki-different-pem.pem');
  const alternatePem = canonicalPem.replaceAll('\n', '\r\n');
  assert.notEqual(alternatePem, canonicalPem);
  writeFile(alternatePublicKeyPath, alternatePem, 0o600);
  assert.deepEqual(
    crypto.createPublicKey(alternatePem).export({ type: 'spki', format: 'der' }),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const configuration = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
  configuration.verifierAttestor.publicKeyPath = alternatePublicKeyPath;
  writeFile(fixture.configPath, `${JSON.stringify(configuration, null, 2)}\n`, 0o600);

  const inspection = inspectExternalResearchQualificationProcessConfiguration({
    configPath: fixture.configPath,
    environment: process.env,
  });
  assert.equal(inspection.ready, false);
  assert.ok(inspection.blockers.includes(
    'external_qualification_independent_verifier_attestor_required',
  ));
  assert.throws(() => createExternalResearchQualificationProcessAdapter({
    configPath: fixture.configPath,
    cwd: fixture.base,
  }), /external_qualification_independent_verifier_attestor_required/);
});

test('preprovisioned trust survives release-only cutover and enforces active, retiring, future, and revoked authority', async (t) => {
  const oldKeys = crypto.generateKeyPairSync('ed25519');
  const nextKeys = crypto.generateKeyPairSync('ed25519');
  const oldSigner = Object.freeze({
    keyId: 'qualification-key:rotation-old',
    keyVersion: 'v1',
    subjectId: 'external-attestor:rotation',
    organization: 'External Qualification Rotation',
    role: FULL_RESEARCH_QUALIFICATION_ATTESTOR_ROLE,
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
    revokedAt: null,
  });
  const nextSigner = Object.freeze({
    ...oldSigner,
    keyId: 'qualification-key:rotation-next',
    keyVersion: 'v2',
    status: 'retiring',
    effectiveFrom: '2026-07-15T12:00:00.000Z',
    expiresAt: '2026-09-01T00:00:00.000Z',
  });
  const qualifiedFixture = qualifiedReleaseFixture({
    campaignId: 'autonomous-research:rotation-authority',
    paperId: 'rotation-authority',
  });
  const activeReceipt = receipt({
    privateKey: nextKeys.privateKey,
    signer: nextSigner,
    releaseHash: H('rotation-release'),
    qualifiedFixture,
    issuedAt: '2026-07-15T12:30:00.000Z',
    expiresAt: '2026-07-15T13:30:00.000Z',
  });
  const fixture = processFixture(t, {
    receiptValue: {
      ...activeReceipt,
      publicKeyPem: nextKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    },
    trustedSignerValues: [{
      ...oldSigner,
      publicKeyPem: oldKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    }, {
      ...nextSigner,
      publicKeyPem: nextKeys.publicKey.export({ type: 'spki', format: 'pem' }),
    }],
  });
  const configuration = readExternalResearchQualificationProcessConfiguration({
    configPath: fixture.configPath,
    environment: process.env,
  });
  const cutoverKeys = Object.freeze(configuration.trustedSigners.map((key) => Object.freeze({
    ...key,
    status: key.keyId === nextSigner.keyId ? 'active' : 'retiring',
  })));
  const currentActive = cutoverKeys.find((key) => key.status === 'active');
  const cutover = productionReleaseInspection({
    trustedKeys: cutoverKeys,
    activeKey: currentActive,
  });
  assert.equal(verifyExternalQualificationReleaseSignerAuthority({
    inspection: cutover,
    configuration,
    signer: nextSigner,
    signedAt: '2026-07-15T12:30:00.000Z',
    freshlyIssued: true,
  }), true);
  assert.equal(verifyExternalQualificationReleaseSignerAuthority({
    inspection: cutover,
    configuration,
    signer: oldSigner,
    signedAt: '2026-07-15T12:30:00.000Z',
    freshlyIssued: true,
  }), false);
  assert.equal(verifyExternalQualificationReleaseSignerAuthority({
    inspection: cutover,
    configuration,
    signer: oldSigner,
    signedAt: '2026-07-15T11:59:59.000Z',
  }), true);
  assert.equal(verifyExternalQualificationReleaseSignerAuthority({
    inspection: cutover,
    configuration,
    signer: oldSigner,
    signedAt: '2026-07-15T12:00:00.000Z',
  }), false);
  assert.equal(verifyExternalQualificationReleaseSignerAuthority({
    inspection: cutover,
    configuration,
    signer: nextSigner,
    signedAt: '2026-07-15T11:59:59.000Z',
  }), false);
  const revokedKeys = Object.freeze(cutoverKeys.map((key) => Object.freeze({
    ...key,
    ...(key.keyId === nextSigner.keyId
      ? { revokedAt: '2026-07-15T12:15:00.000Z' } : {}),
  })));
  const revoked = productionReleaseInspection({
    trustedKeys: revokedKeys,
    activeKey: revokedKeys.find((key) => key.keyId === nextSigner.keyId),
  });
  assert.equal(verifyExternalQualificationReleaseSignerAuthority({
    inspection: revoked,
    configuration,
    signer: nextSigner,
    signedAt: '2026-07-15T12:10:00.000Z',
    freshlyIssued: true,
  }), false);
});
