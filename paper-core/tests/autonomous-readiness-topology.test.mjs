import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  autonomousResearchCommandExitCode,
} from '../../paper-application/automation/autonomous-research-cli-policy.mjs';
import {
  createAutonomousResearchSupervisorAutonomyFence,
} from '../../paper-application/automation/autonomous-research-supervisor-autonomy-fence.mjs';
import {
  inspectExternalResearchQualificationProcessConfiguration,
} from '../../paper-adapters/automation/external-research-qualification-process-adapter.mjs';
import { preflightAutonomousEmpiricalRuntimes } from '../../paper-adapters/automation/autonomous-empirical-runtime-preflight.mjs';
import { AUTOMATION_RUNTIME_IMAGES } from '../../paper-adapters/automation/runtime-image-registry.mjs';
import { composeAutonomousResearchCampaignAction } from '../../paper-composition/automation/autonomous-research-campaign-composition.mjs';
import {
  evaluateAutonomousResearchResidentPrerequisites,
} from '../../paper-composition/automation/autonomous-research-resident-prerequisite-inspection.mjs';
import {
  evaluateExternalQualificationServiceReadiness,
  evaluateUnattendedCampaignLaunchReadiness,
} from '../../paper-composition/automation/autonomous-research-readiness-inspections.mjs';

const H = (label) => hashRecord('AutonomousReadinessTopologyTestHash', { label });

function withHash(kind, hashField, payload) {
  return Object.freeze({ ...payload, [hashField]: hashRecord(kind, payload) });
}

function commandInspectionHash(command) {
  return hashRecord('ExternalResearchQualificationProcessCommandInspection', command);
}

function releaseInspection({
  publicKeySpkiHash = H('release-public-key'),
  trustedKeys: suppliedTrustedKeys = null,
  activeKeyId = 'release-key:test',
} = {}) {
  const trustedKeys = suppliedTrustedKeys || Object.freeze([Object.freeze({
    keyId: 'release-key:test',
    keyVersion: 'legacy-v1',
    subjectId: 'release-attestor:test',
    organization: 'Release Office',
    role: 'research_execution_release_attestor',
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    revokedAt: null,
    publicKeySpkiHash,
  })]);
  const activeKey = trustedKeys.find((key) => key.keyId === activeKeyId);
  return withHash(
    'ResearchExecutionReleaseAttestorConfigurationInspection',
    'researchExecutionReleaseAttestorConfigurationInspectionHash',
    {
      version: 1,
      kind: 'ResearchExecutionReleaseAttestorConfigurationInspection',
      status: 'research_execution_release_attestor_ready',
      ready: true,
      inspectedAt: '2026-07-15T10:00:00.000Z',
      keyId: activeKey.keyId,
      keyVersion: activeKey.keyVersion,
      subjectId: activeKey.subjectId,
      organization: activeKey.organization,
      role: activeKey.role,
      algorithm: activeKey.algorithm,
      publicKeySpkiHash: activeKey.publicKeySpkiHash,
      effectiveFrom: activeKey.effectiveFrom,
      expiresAt: activeKey.expiresAt,
      trustSetVersion: 1,
      trustSetHash: hashRecord('ResearchExecutionReleaseAttestorTrustSet', {
        version: 1,
        keys: trustedKeys,
      }),
      trustedKeys,
      backendKind: 'local-file',
      backendId: 'local-file:release-key:test',
      backendVersion: 'legacy-v1',
      backendProductionEligible: false,
      backendCommandIdentityHash: H('release-local-file-command'),
      backendProbeCommandIdentityHash: null,
      hardwareProtected: false,
      privateKeyExportable: true,
      externalSignerProcess: false,
      credentialMaterialReadByMainProcess: true,
      backendProbeAttestorPublicKeySpkiHash: null,
      backendDescriptorHash: hashRecord('ResearchExecutionReleaseSignerBackendDescriptor', {
        version: 1,
        kind: 'ResearchExecutionReleaseSignerBackendDescriptor',
        backendKind: 'local-file',
        backendId: 'local-file:release-key:test',
        backendVersion: 'legacy-v1',
        algorithm: 'ed25519',
        hardwareProtected: false,
        privateKeyExportable: true,
        externalSignerProcess: false,
        productionEligible: false,
        activeKeyId: activeKey.keyId,
        activeKeyVersion: activeKey.keyVersion,
        activePublicKeySpkiHash: activeKey.publicKeySpkiHash,
        trustSetHash: hashRecord('ResearchExecutionReleaseAttestorTrustSet', {
          version: 1,
          keys: trustedKeys,
        }),
        commandIdentityHash: H('release-local-file-command'),
        probeCommandIdentityHash: null,
        probeAttestorPublicKeySpkiHash: null,
        credentialMaterialReadByMainProcess: true,
      }),
      privateKeyDisclosed: false,
      blockers: Object.freeze([]),
    },
  );
}

function qualificationConfigurationInspection({
  publicKeySpkiHash = H('release-public-key'),
  trustedSigners: suppliedTrustedSigners = null,
  activeKeyId = 'release-key:test',
  verifierOrganization = 'Verification Office',
  maximumQualificationCostUsd = 2,
  qualificationCostAuthority = 'operator_declared_worst_case_usd',
} = {}) {
  const defaultTrustedSigner = {
    keyId: 'release-key:test',
    keyVersion: 'legacy-v1',
    subjectId: 'release-attestor:test',
    organization: 'Release Office',
    role: 'research_execution_release_attestor',
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    revokedAt: null,
  };
  const trustedSigners = suppliedTrustedSigners || Object.freeze([Object.freeze({
    ...defaultTrustedSigner,
    publicKeySpkiHash,
  })]);
  const activeTrustedSigner = trustedSigners.find((key) => key.keyId === activeKeyId);
  const { publicKeySpkiHash: activePublicKeySpkiHash, ...trustedSigner } =
    activeTrustedSigner;
  const verifierAttestor = {
    keyId: 'verifier-key:test',
    keyVersion: 'legacy-v1',
    subjectId: 'verifier-attestor:test',
    organization: verifierOrganization,
    role: 'external_qualification_independent_verifier',
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    revokedAt: null,
  };
  const verifierPublicKeySpkiHash = H('verifier-public-key');
  const trustedSignerTrustSetHash = hashRecord(
    'ResearchExecutionReleaseAttestorTrustSet',
    { version: 1, keys: trustedSigners },
  );
  const qualifierCommandIdentityHash = H('qualifier-command');
  const verifierCommandIdentityHash = H('verifier-command');
  const qualifierServiceId = 'qualifier:test';
  const verifierServiceId = 'verifier:test';
  const qualifierPrincipalId = 'qualifier-principal:test';
  const verifierPrincipalId = 'verifier-principal:test';
  const qualifierCommandInspection = {
    serviceId: qualifierServiceId,
    principalId: qualifierPrincipalId,
    commandIdentityHash: qualifierCommandIdentityHash,
    executableContentHash: H('qualifier-executable'),
    credentialRootIdentityHash: H('qualifier-root'),
    credentialRootContentsIdentityHash: H('qualifier-root-contents'),
    childEnvironmentIdentityHash: H('qualifier-environment'),
    interpreterIdentityHash: H('qualifier-interpreter'),
    credentialUid: 1001,
  };
  const verifierCommandInspection = {
    serviceId: verifierServiceId,
    principalId: verifierPrincipalId,
    commandIdentityHash: verifierCommandIdentityHash,
    executableContentHash: H('verifier-executable'),
    credentialRootIdentityHash: H('verifier-root'),
    credentialRootContentsIdentityHash: H('verifier-root-contents'),
    childEnvironmentIdentityHash: H('verifier-environment'),
    interpreterIdentityHash: H('verifier-interpreter'),
    credentialUid: 1002,
  };
  const trustIdentityHash = hashRecord('ExternalResearchQualificationTrustIdentity', {
    trustedSignerTrustSetVersion: 1,
    trustedSignerTrustSetHash,
    trustedSigners,
    verifierAttestor,
    verifierAttestorPublicKeySpkiHash: verifierPublicKeySpkiHash,
  });
  const configurationIdentityHash = hashRecord(
    'ExternalResearchQualificationConfigurationIdentity',
    {
      qualifierCommandIdentityHash,
      verifierCommandIdentityHash,
      maximumQualificationCostUsd,
      qualificationCostAuthority,
      trustIdentityHash,
    },
  );
  const clientServiceIdentityHash = hashRecord(
    'ExternalResearchQualificationClientServiceIdentity',
    {
      configurationIdentityHash,
      commandIdentityHash: qualifierCommandIdentityHash,
      serviceId: qualifierServiceId,
      principalId: qualifierPrincipalId,
    },
  );
  const verifierServiceIdentityHash = hashRecord(
    'ExternalResearchQualificationVerifierServiceIdentity',
    {
      configurationIdentityHash,
      commandIdentityHash: verifierCommandIdentityHash,
      serviceId: verifierServiceId,
      principalId: verifierPrincipalId,
      trustIdentityHash,
    },
  );
  return withHash(
    'ExternalResearchQualificationProcessConfigurationInspection',
    'externalResearchQualificationProcessConfigurationInspectionHash',
    {
      version: 1,
      kind: 'ExternalResearchQualificationProcessConfigurationInspection',
      status: 'external_research_qualification_process_configuration_ready',
      ready: true,
      qualifierServiceId,
      verifierServiceId,
      qualifierPrincipalId,
      verifierPrincipalId,
      qualifierCommandIdentityHash,
      verifierCommandIdentityHash,
      qualifierCommandInspectionHash: commandInspectionHash(qualifierCommandInspection),
      verifierCommandInspectionHash: commandInspectionHash(verifierCommandInspection),
      qualifierExecutableContentHash: qualifierCommandInspection.executableContentHash,
      verifierExecutableContentHash: verifierCommandInspection.executableContentHash,
      qualifierCredentialRootIdentityHash:
        qualifierCommandInspection.credentialRootIdentityHash,
      verifierCredentialRootIdentityHash:
        verifierCommandInspection.credentialRootIdentityHash,
      qualifierCredentialRootContentsIdentityHash:
        qualifierCommandInspection.credentialRootContentsIdentityHash,
      verifierCredentialRootContentsIdentityHash:
        verifierCommandInspection.credentialRootContentsIdentityHash,
      qualifierChildEnvironmentIdentityHash:
        qualifierCommandInspection.childEnvironmentIdentityHash,
      verifierChildEnvironmentIdentityHash:
        verifierCommandInspection.childEnvironmentIdentityHash,
      qualifierInterpreterIdentityHash: qualifierCommandInspection.interpreterIdentityHash,
      verifierInterpreterIdentityHash: verifierCommandInspection.interpreterIdentityHash,
      qualifierCredentialUid: qualifierCommandInspection.credentialUid,
      verifierCredentialUid: verifierCommandInspection.credentialUid,
      configurationIdentityHash,
      trustIdentityHash,
      clientServiceIdentityHash,
      verifierServiceIdentityHash,
      maximumQualificationCostUsd,
      qualificationCostAuthority,
      independentVerifierConfigured: true,
      authoritativeLookupSupported: true,
      authoritativeLookupVerifierConfigured: true,
      authoritativeLookupVerificationTrustSetHash: trustedSignerTrustSetHash,
      independentVerifierResponseAttestationRequired: true,
      privateSigningKeyLoaded: false,
      trustedSignerTrustSetVersion: 1,
      trustedSignerTrustSetHash,
      trustedSigners,
      trustedSignerKeyId: trustedSigner.keyId,
      trustedSignerKeyVersion: trustedSigner.keyVersion,
      trustedSignerSubjectId: trustedSigner.subjectId,
      trustedSignerOrganization: trustedSigner.organization,
      trustedSignerRole: trustedSigner.role,
      trustedSignerAlgorithm: trustedSigner.algorithm,
      trustedSignerStatus: trustedSigner.status,
      trustedSignerEffectiveFrom: trustedSigner.effectiveFrom,
      trustedSignerExpiresAt: trustedSigner.expiresAt,
      trustedSignerRevokedAt: trustedSigner.revokedAt,
      trustedSignerPublicKeySpkiHash: activePublicKeySpkiHash,
      verifierAttestorKeyId: verifierAttestor.keyId,
      verifierAttestorKeyVersion: verifierAttestor.keyVersion,
      verifierAttestorSubjectId: verifierAttestor.subjectId,
      verifierAttestorOrganization: verifierAttestor.organization,
      verifierAttestorRole: verifierAttestor.role,
      verifierAttestorAlgorithm: verifierAttestor.algorithm,
      verifierAttestorStatus: verifierAttestor.status,
      verifierAttestorEffectiveFrom: verifierAttestor.effectiveFrom,
      verifierAttestorExpiresAt: verifierAttestor.expiresAt,
      verifierAttestorRevokedAt: verifierAttestor.revokedAt,
      verifierAttestorPublicKeySpkiHash: verifierPublicKeySpkiHash,
      blockers: Object.freeze([]),
    },
  );
}

function principalPreflights() {
  const authorCapability = withHash(
    'CodexResearchAuthorCapabilityReceipt',
    'codexResearchAuthorCapabilityReceiptHash',
    {
      version: 1,
      kind: 'CodexResearchAuthorCapabilityReceipt',
      status: 'codex_research_author_capability_ready',
      provider: 'openai',
      model: 'author-model',
      credentialRootIdentityHash: H('author-root'),
      credentialConfigIdentityHash: H('author-config'),
    },
  );
  const reviewerCapability = withHash(
    'CodexFormalReviewerCapabilityReceipt',
    'codexFormalReviewerCapabilityReceiptHash',
    {
      version: 1,
      kind: 'CodexFormalReviewerCapabilityReceipt',
      status: 'codex_formal_reviewer_capability_ready',
      provider: 'openai',
      model: 'reviewer-model',
      credentialRootIdentityHash: H('reviewer-root'),
      credentialConfigIdentityHash: H('reviewer-config'),
      authorCredentialRootIdentityHash: authorCapability.credentialRootIdentityHash,
      credentialIndependenceVerified: true,
      assuranceScope: 'filesystem_credential_root_and_principal_separation',
    },
  );
  return Object.freeze({
    author: Object.freeze({
      effectivePrincipalId: 'codex-research-author:readiness-fixture',
      codexHome: '/fixture/author',
      capabilityReceipt: authorCapability,
    }),
    reviewer: Object.freeze({
      effectivePrincipalId: 'codex-formal-reviewer:readiness-fixture',
      codexHome: '/fixture/reviewer',
      capabilityReceipt: reviewerCapability,
    }),
  });
}

function empiricalRuntimeInspection() {
  return preflightAutonomousEmpiricalRuntimes({
    spawnSyncImpl(_command, args) {
      const runtime = [AUTOMATION_RUNTIME_IMAGES.python, AUTOMATION_RUNTIME_IMAGES.r]
        .find((candidate) => candidate.image === args[2]);
      return {
        status: runtime ? 0 : 1,
        stdout: runtime ? JSON.stringify([{ Id: runtime.imageDigest }]) : '',
      };
    },
  });
}

function writeFile(candidate, content, mode) {
  fs.writeFileSync(candidate, content, { mode });
  fs.chmodSync(candidate, mode);
}

function processReadinessFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-readiness-topology-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'assets');
  const runtimeRoot = path.join(base, 'runtime');
  const qualifierCredentialRoot = path.join(base, 'qualifier-credentials');
  const verifierCredentialRoot = path.join(base, 'verifier-credentials');
  for (const directory of [root, runtimeRoot, qualifierCredentialRoot, verifierCredentialRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  writeFile(path.join(qualifierCredentialRoot, 'credential'),
    'qualifier-readiness-private-credential\n', 0o600);
  writeFile(path.join(verifierCredentialRoot, 'credential'),
    'verifier-readiness-private-credential\n', 0o600);
  const marker = path.join(base, 'external-process-invoked');
  const qualifierExecutable = path.join(base, 'qualifier.mjs');
  const verifierExecutable = path.join(base, 'verifier.mjs');
  writeFile(qualifierExecutable, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    'fs.writeFileSync(process.argv[2], \'qualifier invoked\');',
  ].join('\n'), 0o700);
  writeFile(verifierExecutable, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    'fs.writeFileSync(process.argv[2], \'verifier invoked\');',
    '// distinct executable identity',
  ].join('\n'), 0o700);
  const releaseKeys = crypto.generateKeyPairSync('ed25519');
  const verifierKeys = crypto.generateKeyPairSync('ed25519');
  const releasePrivateKeyPath = path.join(base, 'release-private.pem');
  const releasePublicKeyPath = path.join(base, 'release-public.pem');
  const verifierPublicKeyPath = path.join(base, 'verifier-public.pem');
  writeFile(releasePrivateKeyPath,
    releaseKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o600);
  writeFile(releasePublicKeyPath,
    releaseKeys.publicKey.export({ type: 'spki', format: 'pem' }), 0o600);
  writeFile(verifierPublicKeyPath,
    verifierKeys.publicKey.export({ type: 'spki', format: 'pem' }), 0o600);
  const releaseConfigPath = path.join(base, 'release-attestor.json');
  writeFile(releaseConfigPath, JSON.stringify({
    version: 1,
    kind: 'ResearchExecutionReleaseAttestorConfiguration',
    keyId: 'release-key:readiness',
    subjectId: 'release-attestor:readiness',
    organization: 'Readiness Release Office',
    algorithm: 'ed25519',
    role: 'research_execution_release_attestor',
    status: 'active',
    revoked: false,
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    attestationLifetimeSeconds: 86400,
    privateKeyPath: releasePrivateKeyPath,
  }), 0o600);
  const qualificationConfigPath = path.join(base, 'external-qualification.json');
  writeFile(qualificationConfigPath, JSON.stringify({
    version: 3,
    kind: 'ExternalResearchQualificationProcessConfiguration',
    status: 'active',
    maximumQualificationCostUsd: 2,
    qualificationCostAuthority: 'operator_declared_worst_case_usd',
    qualifier: {
      serviceId: 'external-qualifier:readiness',
      principalId: 'external-qualifier-principal:readiness',
      protocol: 'external-qualification-json-stdio-v1',
      executable: qualifierExecutable,
      credentialRoot: qualifierCredentialRoot,
      args: [marker],
      environmentAllowlist: [],
      timeoutMs: 5000,
    },
    verifier: {
      serviceId: 'independent-verifier:readiness',
      principalId: 'independent-verifier-principal:readiness',
      protocol: 'external-qualification-json-stdio-v1',
      executable: verifierExecutable,
      credentialRoot: verifierCredentialRoot,
      args: [marker],
      environmentAllowlist: [],
      timeoutMs: 5000,
    },
    trustedSignerTrustSet: {
      version: 1,
      kind: 'ResearchExecutionReleaseAttestorTrustSet',
      keys: [{
      keyId: 'release-key:readiness',
      keyVersion: 'legacy-v1',
      subjectId: 'release-attestor:readiness',
      organization: 'Readiness Release Office',
      role: 'research_execution_release_attestor',
      algorithm: 'ed25519',
      status: 'active',
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      expiresAt: '2027-07-01T00:00:00.000Z',
      revokedAt: null,
      publicKeyPath: releasePublicKeyPath,
      }],
    },
    verifierAttestor: {
      keyId: 'verifier-key:readiness',
      keyVersion: 'legacy-v1',
      subjectId: 'verifier-attestor:readiness',
      organization: 'Independent Verification Office',
      role: 'external_qualification_independent_verifier',
      algorithm: 'ed25519',
      status: 'active',
      effectiveFrom: '2026-07-01T00:00:00.000Z',
      expiresAt: '2027-07-01T00:00:00.000Z',
      revokedAt: null,
      publicKeyPath: verifierPublicKeyPath,
    },
  }), 0o600);
  return {
    root,
    runtimeRoot,
    marker,
    releaseConfigPath,
    qualificationConfigPath,
  };
}

test('resident prerequisites keep renewable receipts in bootstrap mode and hard-block config drift', () => {
  const configurationInspection = qualificationConfigurationInspection();
  const configuration = {
    configurationIdentityHash: configurationInspection.configurationIdentityHash,
    trustIdentityHash: configurationInspection.trustIdentityHash,
    clientServiceIdentityHash: configurationInspection.clientServiceIdentityHash,
    verifierServiceIdentityHash: configurationInspection.verifierServiceIdentityHash,
    maximumQualificationCostUsd: configurationInspection.maximumQualificationCostUsd,
    qualificationCostAuthority: configurationInspection.qualificationCostAuthority,
    trustedSigner: null,
    publicKey: null,
  };
  const runtimeReproducibilityStatus = {
    ready: false,
    configuration: {
      ready: true,
      configurationIdentityHash: H('runtime-config'),
      trustIdentityHash: H('runtime-trust'),
      maximumVerificationCostUsd: 2,
      verificationCostAuthority: 'operator_declared_worst_case_usd',
    },
    inspection: null,
  };
  const input = {
    configurationInspection,
    configuration,
    runtimeReproducibilityStatus,
    externalActionRecoveryInspection: {
      ready: true,
      signedCapabilityVerified: true,
      configurationIdentityHash: H('external-action-recovery-config'),
    },
    codeProvenance: { version: 2, worktreeStateHash: H('current-worktree') },
    now: new Date('2026-07-15T10:00:00.000Z'),
  };
  const renewable = evaluateAutonomousResearchResidentPrerequisites(input);
  assert.equal(renewable.infrastructureReady, true);
  assert.equal(renewable.globalQualificationReady, false);
  assert.equal(renewable.operationMode, 'bootstrap-only');
  assert.match(renewable.globalQualificationBlockers.join(','),
    /full_qualification_pointer_not_ready/);
  assert.match(renewable.globalQualificationBlockers.join(','),
    /runtime_reproducibility_receipt_not_current/);

  const expiredPointer = evaluateAutonomousResearchResidentPrerequisites({
    ...input,
    qualificationPointer: {
      qualificationStateHash: H('expired-qualification-state'),
      qualificationStateGeneration: 1,
      receipt: {
        issuedAt: '2026-07-14T08:00:00.000Z',
        expiresAt: '2026-07-14T09:00:00.000Z',
      },
    },
  });
  assert.equal(expiredPointer.infrastructureReady, true);
  assert.equal(expiredPointer.operationMode, 'bootstrap-only');
  assert.match(expiredPointer.globalQualificationBlockers.join(','),
    /full_qualification_receipt_not_current/);

  const configurationDrift = evaluateAutonomousResearchResidentPrerequisites({
    ...input,
    configuration: { ...configuration, maximumQualificationCostUsd: 0.01 },
  });
  assert.equal(configurationDrift.infrastructureReady, false);
  assert.equal(configurationDrift.operationMode, 'blocked');
  assert.match(configurationDrift.infrastructureBlockers.join(','),
    /external_qualification_v3_configuration_not_ready/);

  const stateCostAuthorityDrift = evaluateAutonomousResearchResidentPrerequisites({
    ...input,
    qualificationPointer: {
      qualificationStateHash: H('qualification-state'),
      qualificationStateGeneration: 1,
      receipt: {},
    },
    qualificationState: {
      autonomousExternalQualificationStateHash: H('qualification-state'),
      generation: 1,
      recovery: {
        status: 'qualification_verified',
        configurationIdentityHash: configuration.configurationIdentityHash,
        trustIdentityHash: configuration.trustIdentityHash,
        clientServiceIdentityHash: configuration.clientServiceIdentityHash,
        verifierServiceIdentityHash: configuration.verifierServiceIdentityHash,
        recoveryConfigurationIdentityHash: H('stale-cost-authority'),
      },
    },
  });
  assert.equal(stateCostAuthorityDrift.infrastructureReady, true);
  assert.equal(stateCostAuthorityDrift.operationMode, 'bootstrap-only');
  assert.match(stateCostAuthorityDrift.globalQualificationBlockers.join(','),
    /qualification_state_configuration_drift/);

  const rehash = (source, mutate) => {
    const receipt = structuredClone(source);
    mutate(receipt);
    const identity = {
      externalQualificationConfigurationInspectionHash:
        receipt.externalQualificationConfigurationInspectionHash,
      externalQualificationConfigurationIdentityHash:
        receipt.externalQualificationConfigurationIdentityHash,
      externalQualificationTrustIdentityHash:
        receipt.externalQualificationTrustIdentityHash,
      externalQualificationMaximumCostUsd: receipt.externalQualificationMaximumCostUsd,
      externalQualificationCostAuthority: receipt.externalQualificationCostAuthority,
      runtimeImageReproducibilityConfigurationIdentityHash:
        receipt.runtimeImageReproducibilityConfigurationIdentityHash,
      runtimeImageReproducibilityTrustIdentityHash:
        receipt.runtimeImageReproducibilityTrustIdentityHash,
      codeWorktreeStateHash: receipt.codeWorktreeStateHash,
    };
    receipt.autonomousResearchResidentPrerequisiteIdentityHash = hashRecord(
      'AutonomousResearchResidentPrerequisiteIdentity', identity,
    );
    delete receipt.autonomousResearchResidentPrerequisiteReceiptHash;
    receipt.autonomousResearchResidentPrerequisiteReceiptHash = hashRecord(
      'AutonomousResearchResidentPrerequisiteReceipt', receipt,
    );
    return receipt;
  };
  const assertRejected = (receipt) => assert.throws(() =>
    createAutonomousResearchSupervisorAutonomyFence({
      required: true,
      inspectPrerequisites: () => receipt,
      clock: { now: () => new Date(input.now) },
    }).inspectStartup(), /full_prerequisite_receipt_invalid/);
  assert.doesNotThrow(() => createAutonomousResearchSupervisorAutonomyFence({
    required: true,
    inspectPrerequisites: () => renewable,
    clock: { now: () => new Date(input.now) },
  }).inspectStartup());
  assertRejected(rehash(renewable, (receipt) => { delete receipt.status; }));
  assertRejected(rehash(renewable, (receipt) => { receipt.externalActionPerformed = true; }));
  assertRejected(rehash(renewable, (receipt) => {
    receipt.blockers = [...receipt.infrastructureBlockers];
  }));
  assertRejected(rehash(renewable, (receipt) => {
    receipt.externalQualificationConfigurationInspectionHash = null;
  }));
  assertRejected(rehash(renewable, (receipt) => {
    receipt.externalQualificationMaximumCostUsd = null;
    receipt.externalQualificationCostAuthority = null;
  }));
  const forgedFull = rehash(renewable, (receipt) => {
    receipt.status = 'autonomous_research_resident_prerequisites_ready';
    receipt.ready = true;
    receipt.globalQualificationReady = true;
    receipt.operationMode = 'full';
    receipt.globalQualificationBlockers = [];
    receipt.blockers = [];
    receipt.fullResearchQualificationExpiresAt = null;
    receipt.runtimeImageReproducibilityExpiresAt = null;
  });
  assertRejected(forgedFull);
  assertRejected(rehash(forgedFull, (receipt) => {
    receipt.fullResearchQualificationExpiresAt = '2026-07-15T09:59:59.000Z';
    receipt.runtimeImageReproducibilityExpiresAt = '2026-07-15T09:59:59.000Z';
  }));
});

test('action-aware full-ready policy never treats prepare postconditions as launch preconditions', () => {
  const forgedLegacyReady = {
    fullAutomaticResearchWritingReady: true,
    qualificationEligibility: { fullAutomaticResearchWritingReady: true },
    unattendedCampaignLaunchReady: true,
    externalQualificationServiceReady: false,
  };
  assert.equal(autonomousResearchCommandExitCode({
    action: 'prepare', report: forgedLegacyReady, requireFullReady: true,
  }), 2);
  assert.equal(autonomousResearchCommandExitCode({
    action: 'prepare',
    report: { unattendedCampaignLaunchReady: true, externalQualificationServiceReady: true },
    requireFullReady: true,
  }), 0);
  for (const action of ['launch', 'status', 'resume']) {
    assert.equal(autonomousResearchCommandExitCode({
      action,
      report: {
        unattendedCampaignLaunchReady: true,
        externalQualificationServiceReady: true,
        campaignFullyQualified: false,
      },
      requireFullReady: true,
    }), 2);
    assert.equal(autonomousResearchCommandExitCode({
      action, report: { campaignFullyQualified: true }, requireFullReady: true,
    }), 0);
  }
  assert.equal(autonomousResearchCommandExitCode({
    action: 'converge', report: { campaignFullyQualified: true }, requireFullReady: false,
  }), 2);
  assert.equal(autonomousResearchCommandExitCode({
    action: 'converge',
    report: {
      campaignFullyQualified: true,
      status: 'autonomous_research_campaign_completed_and_qualified',
    },
  }), 0);
  assert.equal(autonomousResearchCommandExitCode({
    action: 'converge',
    launchMode: 'golden-bootstrap',
    report: { boundedGoldenQualificationPublished: true },
    requireBoundedGoldenReady: true,
  }), 0);
  assert.equal(autonomousResearchCommandExitCode({
    action: 'converge',
    launchMode: 'production-run',
    report: { boundedGoldenQualificationPublished: true },
    requireBoundedGoldenReady: true,
  }), 2);
});

test('unattended launch and qualification service readiness replay independent hash domains', () => {
  const providerHash = H('provider');
  const release = releaseInspection();
  assert.equal(evaluateUnattendedCampaignLaunchReadiness({
    loopPreparation: {
      autonomousExecutionLaunchReady: true,
      autonomousResearchProviderConfigurationHash: providerHash,
    },
    runtimePrincipalPreflight: {
      status: 'autonomous_research_runtime_principals_ready',
      autonomousResearchProviderConfigurationHash: providerHash,
      blockers: [],
    },
    providerConfigurationHash: providerHash,
    releaseAttestorInspection: release,
  }), true);
  assert.equal(evaluateUnattendedCampaignLaunchReadiness({
    loopPreparation: {
      autonomousExecutionLaunchReady: true,
      autonomousResearchProviderConfigurationHash: providerHash,
    },
    runtimePrincipalPreflight: {
      status: 'autonomous_research_runtime_principals_ready',
      autonomousResearchProviderConfigurationHash: providerHash,
      blockers: [],
    },
    providerConfigurationHash: H('different-provider'),
    releaseAttestorInspection: release,
  }), false);

  const {
    researchExecutionReleaseAttestorConfigurationInspectionHash: _releaseHash,
    ...expiredReleasePayload
  } = structuredClone(release);
  expiredReleasePayload.inspectedAt = '2027-07-01T00:00:00.000Z';
  const fullyRehashedExpiredRelease = withHash(
    'ResearchExecutionReleaseAttestorConfigurationInspection',
    'researchExecutionReleaseAttestorConfigurationInspectionHash',
    expiredReleasePayload,
  );
  assert.equal(evaluateUnattendedCampaignLaunchReadiness({
    loopPreparation: {
      autonomousExecutionLaunchReady: true,
      autonomousResearchProviderConfigurationHash: providerHash,
    },
    runtimePrincipalPreflight: {
      status: 'autonomous_research_runtime_principals_ready',
      autonomousResearchProviderConfigurationHash: providerHash,
      blockers: [],
    },
    providerConfigurationHash: providerHash,
    releaseAttestorInspection: fullyRehashedExpiredRelease,
  }), false);

  const {
    researchExecutionReleaseAttestorConfigurationInspectionHash: _algorithmHash,
    ...wrongAlgorithmPayload
  } = structuredClone(release);
  wrongAlgorithmPayload.algorithm = 'forged-ed25519';
  assert.equal(evaluateUnattendedCampaignLaunchReadiness({
    loopPreparation: {
      autonomousExecutionLaunchReady: true,
      autonomousResearchProviderConfigurationHash: providerHash,
    },
    runtimePrincipalPreflight: {
      status: 'autonomous_research_runtime_principals_ready',
      autonomousResearchProviderConfigurationHash: providerHash,
      blockers: [],
    },
    providerConfigurationHash: providerHash,
    releaseAttestorInspection: withHash(
      'ResearchExecutionReleaseAttestorConfigurationInspection',
      'researchExecutionReleaseAttestorConfigurationInspectionHash',
      wrongAlgorithmPayload,
    ),
  }), false);

  const matching = evaluateExternalQualificationServiceReadiness({
    configurationInspection: qualificationConfigurationInspection(),
    releaseAttestorInspection: release,
  });
  assert.equal(matching.ready, true);
  assert.equal(matching.releaseSignerBindingVerified, true);
  assert.equal(hashRecord('ExternalQualificationServiceInspection',
    Object.fromEntries(Object.entries(matching)
      .filter(([key]) => key !== 'externalQualificationServiceInspectionHash'))),
  matching.externalQualificationServiceInspectionHash);

  const nullOrganizationKeys = Object.freeze(release.trustedKeys.map((key) => Object.freeze({
    ...key,
    organization: null,
  })));
  assert.equal(evaluateExternalQualificationServiceReadiness({
    configurationInspection: qualificationConfigurationInspection({
      trustedSigners: nullOrganizationKeys,
    }),
    releaseAttestorInspection: release,
  }).ready, false);
  assert.equal(evaluateExternalQualificationServiceReadiness({
    configurationInspection: qualificationConfigurationInspection({
      verifierOrganization: '  RELEASE   OFFICE  ',
    }),
    releaseAttestorInspection: release,
  }).ready, false);
  const preprovisionedKeys = Object.freeze([Object.freeze({
    ...release.trustedKeys[0],
    status: 'active',
  }), Object.freeze({
    ...release.trustedKeys[0],
    keyId: 'release-key:next',
    keyVersion: 'v2',
    status: 'retiring',
    effectiveFrom: '2026-07-10T00:00:00.000Z',
    expiresAt: '2027-08-01T00:00:00.000Z',
    publicKeySpkiHash: H('release-next-public-key'),
  })].sort((left, right) => `${left.keyId}:${left.keyVersion}`
    .localeCompare(`${right.keyId}:${right.keyVersion}`)));
  const preprovisionedConfiguration = qualificationConfigurationInspection({
    trustedSigners: preprovisionedKeys,
    activeKeyId: 'release-key:test',
  });
  const releaseOnlyCutoverKeys = Object.freeze(preprovisionedKeys.map((key) => Object.freeze({
    ...key,
    status: key.keyId === 'release-key:next' ? 'active' : 'retiring',
  })));
  const releaseOnlyCutover = releaseInspection({
    trustedKeys: releaseOnlyCutoverKeys,
    activeKeyId: 'release-key:next',
  });
  assert.notEqual(
    preprovisionedConfiguration.trustedSignerTrustSetHash,
    releaseOnlyCutover.trustSetHash,
  );
  const cutoverReady = evaluateExternalQualificationServiceReadiness({
    configurationInspection: preprovisionedConfiguration,
    releaseAttestorInspection: releaseOnlyCutover,
  });
  assert.equal(cutoverReady.ready, true);
  assert.equal(cutoverReady.releaseSignerBindingVerified, true);

  const canonicalConfiguration = qualificationConfigurationInspection();
  const {
    externalResearchQualificationProcessConfigurationInspectionHash: _ignoredHash,
    ...identityTamperPayload
  } = structuredClone(canonicalConfiguration);
  identityTamperPayload.qualifierServiceId = 'qualifier:fully-rehashed-substitute';
  const outerRehashedIdentityTamper = {
    ...identityTamperPayload,
    externalResearchQualificationProcessConfigurationInspectionHash: hashRecord(
      'ExternalResearchQualificationProcessConfigurationInspection',
      identityTamperPayload,
    ),
  };
  const identityTamperBlocked = evaluateExternalQualificationServiceReadiness({
    configurationInspection: outerRehashedIdentityTamper,
    releaseAttestorInspection: release,
  });
  assert.equal(identityTamperBlocked.ready, false);
  assert.ok(identityTamperBlocked.blockers.includes(
    'external_qualification_process_configuration_not_ready',
  ));

  const {
    externalResearchQualificationProcessConfigurationInspectionHash: _commandHash,
    ...commandTamperPayload
  } = structuredClone(canonicalConfiguration);
  commandTamperPayload.qualifierExecutableContentHash = H('replacement-executable');
  const commandTamperBlocked = evaluateExternalQualificationServiceReadiness({
    configurationInspection: withHash(
      'ExternalResearchQualificationProcessConfigurationInspection',
      'externalResearchQualificationProcessConfigurationInspectionHash',
      commandTamperPayload,
    ),
    releaseAttestorInspection: release,
  });
  assert.equal(commandTamperBlocked.ready, false);
  assert.ok(commandTamperBlocked.blockers.includes(
    'external_qualification_process_configuration_not_ready',
  ));

  const {
    externalResearchQualificationProcessConfigurationInspectionHash: _attestationHash,
    ...attestationTamperPayload
  } = structuredClone(canonicalConfiguration);
  attestationTamperPayload.independentVerifierResponseAttestationRequired = false;
  const attestationTamperBlocked = evaluateExternalQualificationServiceReadiness({
    configurationInspection: withHash(
      'ExternalResearchQualificationProcessConfigurationInspection',
      'externalResearchQualificationProcessConfigurationInspectionHash',
      attestationTamperPayload,
    ),
    releaseAttestorInspection: release,
  });
  assert.equal(attestationTamperBlocked.ready, false);
  assert.ok(attestationTamperBlocked.blockers.includes(
    'external_qualification_process_configuration_not_ready',
  ));

  const differentKey = crypto.generateKeyPairSync('ed25519').publicKey;
  const fullyRehashedDifferentKey = qualificationConfigurationInspection({
    publicKeySpkiHash: hashBytes(differentKey.export({ type: 'spki', format: 'der' })),
  });
  assert.equal(fullyRehashedDifferentKey.trustedSignerKeyId, release.keyId);
  const blocked = evaluateExternalQualificationServiceReadiness({
    configurationInspection: fullyRehashedDifferentKey,
    releaseAttestorInspection: release,
  });
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.includes('external_qualification_release_signer_binding_invalid'));
});

test('configuration inspection is hash-bound and missing configuration fails closed', () => {
  const inspection = inspectExternalResearchQualificationProcessConfiguration({ environment: {} });
  const {
    externalResearchQualificationProcessConfigurationInspectionHash: claimedHash,
    ...payload
  } = inspection;
  assert.equal(inspection.ready, false);
  assert.ok(inspection.blockers.includes('external_qualification_configuration_path_required'));
  assert.equal(hashRecord(
    'ExternalResearchQualificationProcessConfigurationInspection',
    payload,
  ), claimedHash);
  const missingPath = path.join(os.tmpdir(), 'private-external-qualification-config.json');
  const unreadable = inspectExternalResearchQualificationProcessConfiguration({
    configPath: missingPath,
    environment: {},
  });
  assert.deepEqual(unreadable.blockers, [
    'external_qualification_configuration_inspection_failed',
  ]);
  assert.equal(JSON.stringify(unreadable).includes(missingPath), false);
});

test('prepare inspects matching qualification configuration without invoking either process', async (t) => {
  const fixture = processReadinessFixture(t);
  const preflights = principalPreflights();
  const environment = {
    ...process.env,
    HEPTA_RESEARCH_AUTHOR_MODEL: 'author-model',
    HEPTA_FORMAL_REVIEW_MODEL: 'reviewer-model',
    HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG: fixture.releaseConfigPath,
    HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG: fixture.qualificationConfigPath,
  };
  const report = await composeAutonomousResearchCampaignAction({
    action: 'prepare',
    launchMode: 'golden-bootstrap',
    paperId: 'readiness-zero-process-paper',
    root: fixture.root,
    runtimeRoot: fixture.runtimeRoot,
    environment,
    preflightAuthor: () => preflights.author,
    preflightReviewer: () => preflights.reviewer,
    preflightEmpiricalRuntime: () => empiricalRuntimeInspection(),
    createdAt: '2026-07-15T10:00:00.000Z',
  });
  assert.equal(report.releaseAttestorInspection.ready, true);
  assert.equal(report.externalQualificationServiceReady, true, JSON.stringify(
    report.externalQualificationServiceInspection,
  ));
  assert.equal(report.externalQualificationServiceInspection.releaseSignerBindingVerified, true);
  assert.equal(report.campaignFullyQualified, false);
  assert.equal(report.fullAutomaticResearchWritingReady, false);
  assert.equal(fs.existsSync(fixture.marker), false);

  const identities = {
    configurationIdentityHash: H('injected-config'),
    trustIdentityHash: H('injected-trust'),
  };
  const injectedClient = {
    kind: 'ExternalResearchQualificationClient',
    ...identities,
    serviceIdentityHash: H('injected-client'),
    async requestQualification() { fs.writeFileSync(fixture.marker, 'client called'); },
    async lookupQualification() { fs.writeFileSync(fixture.marker, 'client lookup called'); },
  };
  const injectedVerifier = {
    kind: 'IndependentExternalResearchQualificationVerifier',
    ...identities,
    serviceIdentityHash: H('injected-verifier'),
    async verify() { fs.writeFileSync(fixture.marker, 'verifier called'); },
    async verifyLookup() { fs.writeFileSync(fixture.marker, 'verifier lookup called'); },
  };
  await assert.rejects(() => composeAutonomousResearchCampaignAction({
    action: 'prepare',
    launchMode: 'golden-bootstrap',
    paperId: 'readiness-source-conflict-paper',
    root: fixture.root,
    runtimeRoot: fixture.runtimeRoot,
    environment,
    externalQualificationClient: injectedClient,
    externalQualificationVerifier: injectedVerifier,
  }), /autonomous_research_external_qualification_service_source_conflict/);
  const injectedEnvironment = { ...environment };
  delete injectedEnvironment.HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG;
  const injectedReport = await composeAutonomousResearchCampaignAction({
    action: 'prepare',
    launchMode: 'golden-bootstrap',
    paperId: 'readiness-injected-pair-paper',
    root: fixture.root,
    runtimeRoot: fixture.runtimeRoot,
    environment: injectedEnvironment,
    externalQualificationClient: injectedClient,
    externalQualificationVerifier: injectedVerifier,
    preflightAuthor: () => preflights.author,
    preflightReviewer: () => preflights.reviewer,
    preflightEmpiricalRuntime: () => empiricalRuntimeInspection(),
    createdAt: '2026-07-15T10:00:00.000Z',
  });
  assert.equal(injectedReport.externalQualificationServiceInspection.source, 'paired_injection');
  assert.equal(injectedReport.externalQualificationServiceInspection.injectedServicePairValid, true);
  assert.equal(injectedReport.externalQualificationServiceReady, false);
  assert.ok(injectedReport.externalQualificationServiceInspection.blockers.includes(
    'external_qualification_injected_service_configuration_inspection_required',
  ));
  await assert.rejects(() => composeAutonomousResearchCampaignAction({
    action: 'prepare',
    launchMode: 'golden-bootstrap',
    paperId: 'readiness-half-pair-paper',
    root: fixture.root,
    runtimeRoot: fixture.runtimeRoot,
    environment: {},
    externalQualificationClient: injectedClient,
  }), /autonomous_research_external_qualification_services_incomplete/);
  assert.equal(fs.existsSync(fixture.marker), false);
});
