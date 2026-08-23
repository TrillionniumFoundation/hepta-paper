import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateFullProductionReadiness,
  FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS,
  FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED,
  FULL_PRODUCTION_OWNER_FAMILY_MANIFEST_HASH,
  inspectPackageRetentionRecoveryReadinessResponse,
} from '../../paper-application/automation/full-production-readiness-policy.mjs';
import {
  queryFullProductionReadiness,
} from '../../paper-composition/automation/full-production-readiness-composition.mjs';
import {
  LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT,
  LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST,
} from '../../paper-adapters/governance/legacy-owner-acceptance-contract.mjs';
import { fileSha256HashSync }
  from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';
import {
  runFullProductionReadiness,
} from '../bin/full-production-readiness.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const INSPECTED_AT = '2026-08-21T00:00:00.000Z';
const FINALIZED_AT = '2026-08-21T00:00:01.000Z';
const OBSERVED_AT = '2026-08-21T00:00:02.000Z';
const VALID_UNTIL = '2026-08-21T00:04:00.000Z';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const OFFHOST_CONTRACT_ID = 'fixture-offhost-worm-contract';

function packageReadiness({ ready = true } = {}) {
  const payload = {
    version: 2,
    kind: 'PackageRetentionRecoveryReadiness',
    status: ready
      ? 'package_retention_recovery_authority_ready'
      : 'package_retention_recovery_authority_unavailable',
    recoveryAuthorityConfigured: true,
    recoveryAuthorityReadinessVerifierConfigured: true,
    recoveryAuthorityReadinessVerifierOperational: true,
    recoveryAuthorityAuthenticated: ready,
    recoveryAuthoritySnapshotHash: ready ? HASH_A : null,
    recoveryAuthorityInspectionHash: ready ? HASH_B : null,
    recoveryAuthorityValidUntil: ready ? VALID_UNTIL : null,
    deletionLeasePortConfigured: true,
    deletionLeasePortOperational: true,
    lifecycleLockConfigured: true,
    lifecycleLockOperational: true,
    inspectedAt: INSPECTED_AT,
    finalizedAt: FINALIZED_AT,
    deletionFailClosedWhenUnavailable: true,
    blockers: ready ? [] : ['package_retention_recovery_authority_self_check_expired'],
  };
  return {
    status: 'paper_campaign_retention-recovery-readiness',
    result: {
      ...payload,
      packageRetentionRecoveryReadinessHash:
        hashRecord('PackageRetentionRecoveryReadiness', payload),
    },
  };
}

function automationReport(overrides = {}) {
  return {
    version: 2,
    kind: 'AutomationPlaneStatus',
    status: 'automation_plane_production_ready',
    productionReady: true,
    fullyAutonomousResearchSystemReady: true,
    fullyAutonomousResearchSystemStatus:
      'generic_domain_autonomous_research_system_ready',
    liveProviderCanaryRequested: true,
    liveProviderCanaryReady: true,
    liveReleaseAttestorVerificationRequested: true,
    researchExecutionReleaseAttestorProductionReady: true,
    runtimeImageReproducibilityReady: true,
    runtimeImageReproducibility: { requiredProfiles: ['python', 'pythonGpu', 'r'] },
    gpuScientificRuntimeReady: true,
    gpuPdeOperationalProofReady: true,
    gpuPdeProductionQualificationReady: true,
    gpuDeepLearningOperationalProofReady: true,
    gpuDeepLearningProductionQualificationReady: true,
    fullResearchQualification: { paperId: 'strict-acceptance-golden-paper' },
    ...overrides,
  };
}

function packageInspection({ ready = true } = {}) {
  return inspectPackageRetentionRecoveryReadinessResponse({
    response: packageReadiness({ ready }),
    observedAt: OBSERVED_AT,
  });
}

function offhostInspection(overrides = {}) {
  return {
    version: 1,
    kind: 'OffhostWormTargetStatus',
    status: 'offhost_worm_target_ready',
    contractId: OFFHOST_CONTRACT_ID,
    custodyRequired: true,
    custodyDeclaredQualified: true,
    offHostOrOffsiteCustodyQualified: true,
    custodyStatus: 'offhost_or_offsite_custody_qualified',
    custodyEvidenceStatus: 'offhost_worm_custody_evidence_verified',
    custodyEvidenceBundleHash: HASH_A,
    custodyTrustStoreHash: HASH_B,
    storageIdentityHash: HASH_A,
    custodyEvidenceExpiresAt: VALID_UNTIL,
    blockers: [],
    ...overrides,
  };
}

function ownerInspection(overrides = {}) {
  return {
    version: 1,
    kind: 'IndependentExternalOwnerAcceptanceInspection',
    status: 'independent_external_owner_acceptance_ready',
    externallyAccepted: LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT,
    required: LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT,
    familyManifestBound: true,
    familyManifestHash: LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST.familyManifestHash,
    localAdminAccepted: 0,
    automaticAcceptanceForbidden: true,
    ...overrides,
  };
}

function operationalInspection(overrides = {}) {
  const required = Object.keys(CAPABILITY_CATALOG).length;
  const verified = overrides.verified ?? required;
  const capabilities = Object.keys(CAPABILITY_CATALOG).sort().map((capabilityId, index) => ({
    capabilityId,
    verified: index < verified,
    operationalReceiptHashes: index < verified ? [HASH_A] : [],
    issuerAssurances: index < verified ? ['external_independent'] : [],
  }));
  return {
    version: 1,
    kind: 'IndependentProductionOperationalProofInspection',
    status: 'independent_production_operational_proof_ready',
    releaseCommit: 'a'.repeat(40),
    verified,
    required,
    capabilities,
    externalIndependentRequired: true,
    conformanceCannotQualify: true,
    ...overrides,
  };
}

function aggregate(overrides = {}) {
  return evaluateFullProductionReadiness({
    automationReport: automationReport(),
    packageRetentionRecoveryInspection: packageInspection(),
    offhostWormCustodyInspection: offhostInspection(),
    independentExternalOwnerAcceptanceInspection: ownerInspection(),
    independentProductionOperationalProofInspection: operationalInspection(),
    offhostWormContractId: OFFHOST_CONTRACT_ID,
    observedAt: OBSERVED_AT,
    ...overrides,
  });
}

function commandFixture(t, { executable = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-full-production-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const command = path.join(root, 'package-readiness');
  fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: executable ? 0o555 : 0o444 });
  fs.chmodSync(command, executable ? 0o555 : 0o444);
  return { root, command, hash: fileSha256HashSync(command) };
}

function completeOperationalProofs() {
  return new Map(Object.keys(CAPABILITY_CATALOG).map((capabilityId) => [
    capabilityId,
    {
      capabilityId,
      operationalReceiptHashes: [HASH_A],
      issuerAssurances: ['external_independent'],
    },
  ]));
}

function externalOwnerAcceptanceMap() {
  return new Map(Array.from(
    { length: LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT },
    (_, index) => [`legacy-${index}`, {
      issuerAssurance: 'external_independent',
      acceptanceClass: 'external_independent_owner_acceptance',
    }],
  ));
}

function compositionOptions(t, runProcess) {
  const { root: fixtureRoot, command, hash } = commandFixture(t);
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const ownerRoot = path.join(fixtureRoot, 'capabilities-public');
  fs.mkdirSync(ownerRoot, { recursive: true, mode: 0o700 });
  const ownerDocument = {
    version: 2,
    kind: 'CapabilityOwnerAcceptance',
    familyManifestHash: LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST.familyManifestHash,
    acceptedFamilies: LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST.families.map((family) => ({
      familyId: family.familyId,
    })),
  };
  const ownerTrustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [],
  };
  const ownerTrustStorePath = path.join(ownerRoot, 'OWNER_TRUST_STORE.json');
  const ownerAcceptanceDocumentPath = path.join(
    ownerRoot,
    'CAPABILITY_OWNER_ACCEPTANCE.json',
  );
  fs.writeFileSync(ownerTrustStorePath, `${JSON.stringify(ownerTrustStore)}\n`, { mode: 0o444 });
  fs.writeFileSync(
    ownerAcceptanceDocumentPath,
    `${JSON.stringify(ownerDocument)}\n`,
    { mode: 0o444 },
  );
  fs.chmodSync(ownerTrustStorePath, 0o444);
  fs.chmodSync(ownerAcceptanceDocumentPath, 0o444);
  const instants = [
    new Date(OBSERVED_AT),
    new Date(OBSERVED_AT),
    new Date(OBSERVED_AT),
  ];
  return {
    root: '/srv/hepta-paper/assets',
    runtimeRoot,
    packageRecoveryReadinessCommand: command,
    packageRecoveryReadinessCommandSha256: hash,
    packageRecoveryReadinessCommandRequiredUid:
      typeof process.getuid === 'function' ? process.getuid() : 0,
    testOnlyPackageRecoveryReadinessCommandTrustRoot: fixtureRoot,
    ownerTrustStore: ownerTrustStorePath,
    ownerTrustStoreSha256: fileSha256HashSync(ownerTrustStorePath),
    ownerAcceptanceDocument: ownerAcceptanceDocumentPath,
    ownerAcceptanceDocumentSha256: fileSha256HashSync(ownerAcceptanceDocumentPath),
    ownerReferenceRequiredUid: typeof process.getuid === 'function' ? process.getuid() : 0,
    environment: {
      PATH: process.env.PATH,
      HOME: '/tmp/restricted-home',
      OPENAI_API_KEY: 'must-not-leak',
      HEPTA_PRIVATE_PROVIDER_TOKEN: 'must-not-leak',
    },
    liveProviderCanaryRequested: true,
    activeReleaseAttestorVerification: true,
    clock: { now: () => instants.shift() || new Date(OBSERVED_AT) },
    automationReadinessQuery: () => ({ report: automationReport(), exitCode: 0 }),
    runProcess,
    offhostWormVerifier: ({ contract }) => offhostInspection({ contractId: contract.contractId }),
    operationalProofLoader: () => completeOperationalProofs(),
    ownerAcceptanceDocumentVerifier: () => externalOwnerAcceptanceMap(),
    codeProvenanceReader: () => ({ commit: 'a'.repeat(40) }),
  };
}

test('full production policy requires all five independent readiness axes', () => {
  const ready = aggregate();
  assert.equal(ready.fullProductionReady, true);
  assert.equal(ready.fullProductionStatus, 'full_production_ready');
  assert.deepEqual(ready.blockers, []);
  const { fullProductionReadinessStatusHash, ...payload } = ready;
  assert.equal(
    fullProductionReadinessStatusHash,
    hashRecord('FullProductionReadinessStatus', payload),
  );

  const cases = [
    ['automation', {
      automationReport: automationReport({ liveProviderCanaryRequested: false }),
    }, 'automation_plane_not_full_production_ready'],
    ['automation-status', {
      automationReport: automationReport({ status: 'automation_plane_blocked' }),
    }, 'automation_plane_not_full_production_ready'],
    ['package', {
      packageRetentionRecoveryInspection: packageInspection({ ready: false }),
    }, 'package_retention_recovery_not_ready'],
    ['offhost', {
      offhostWormCustodyInspection: offhostInspection({
        status: 'offhost_worm_target_blocked', blockers: ['missing'],
      }),
    }, 'offhost_worm_custody_not_ready'],
    ['owner', {
      independentExternalOwnerAcceptanceInspection: ownerInspection({
        status: 'independent_external_owner_acceptance_blocked',
        externallyAccepted: LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT - 1,
      }),
    }, 'independent_external_owner_acceptance_not_ready'],
    ['operational', {
      independentProductionOperationalProofInspection: operationalInspection({
        status: 'independent_production_operational_proof_blocked',
        verified: Object.keys(CAPABILITY_CATALOG).length - 1,
      }),
    }, 'independent_production_operational_proof_not_ready'],
  ];
  for (const [name, inputs, blocker] of cases) {
    const result = aggregate(inputs);
    assert.equal(result.fullProductionReady, false, name);
    assert.deepEqual(result.blockers, [blocker], name);
  }
});

test('local-admin owner acceptance cannot satisfy independent external acceptance', () => {
  const result = aggregate({
    independentExternalOwnerAcceptanceInspection: ownerInspection({
      status: 'independent_external_owner_acceptance_blocked',
      externallyAccepted: 0,
      localAdminAccepted: LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT,
    }),
  });
  assert.equal(result.independentExternalOwnerAcceptanceReady, false);
  assert.deepEqual(result.blockers, ['independent_external_owner_acceptance_not_ready']);
});

test('aggregate policy fixes owner and operational proof cardinality and assurance contracts', () => {
  assert.equal(FULL_PRODUCTION_OWNER_ACCEPTANCE_REQUIRED,
    LEGACY_OWNER_ACCEPTANCE_ENTRY_COUNT);
  assert.equal(FULL_PRODUCTION_OWNER_FAMILY_MANIFEST_HASH,
    LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST.familyManifestHash);
  assert.deepEqual(FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS,
    Object.keys(CAPABILITY_CATALOG).sort());

  assert.throws(() => aggregate({
    independentExternalOwnerAcceptanceInspection: ownerInspection({
      externallyAccepted: 1,
      required: 1,
    }),
  }), /full_production_owner_acceptance_inspection_invalid/);

  for (const inspection of [
    ownerInspection({ status: 'independent_external_owner_acceptance_blocked' }),
    ownerInspection({ automaticAcceptanceForbidden: false }),
    ownerInspection({ familyManifestHash: HASH_A }),
  ]) {
    assert.equal(aggregate({
      independentExternalOwnerAcceptanceInspection: inspection,
    }).independentExternalOwnerAcceptanceReady, false);
  }

  const singleCapability = operationalInspection().capabilities.slice(0, 1);
  assert.throws(() => aggregate({
    independentProductionOperationalProofInspection: operationalInspection({
      required: 1,
      verified: 1,
      capabilities: singleCapability,
    }),
  }), /full_production_operational_proof_inspection_invalid/);
  assert.throws(() => aggregate({
    independentProductionOperationalProofInspection: operationalInspection({
      verified: FULL_PRODUCTION_OPERATIONAL_CAPABILITY_IDS.length - 1,
      capabilities: operationalInspection().capabilities.slice(0, -1),
    }),
  }), /full_production_operational_proof_inspection_invalid/);
  const duplicateCapabilities = operationalInspection().capabilities.map((item) => ({ ...item }));
  duplicateCapabilities.at(-1).capabilityId = duplicateCapabilities[0].capabilityId;
  assert.throws(() => aggregate({
    independentProductionOperationalProofInspection: operationalInspection({
      capabilities: duplicateCapabilities,
    }),
  }), /full_production_operational_proof_inspection_invalid/);

  const wrongAssurance = operationalInspection();
  wrongAssurance.capabilities[0].issuerAssurances = ['local_admin_delegated'];
  assert.equal(aggregate({
    independentProductionOperationalProofInspection: wrongAssurance,
  }).independentProductionOperationalProofReady, false);
  assert.equal(aggregate({
    independentProductionOperationalProofInspection: operationalInspection({
      status: 'independent_production_operational_proof_blocked',
    }),
  }).independentProductionOperationalProofReady, false);
});

test('aggregate policy binds the complete qualified WORM custody shape and contract', () => {
  for (const inspection of [
    offhostInspection({ version: 2 }),
    offhostInspection({ contractId: 'substituted-contract' }),
    offhostInspection({ custodyDeclaredQualified: false }),
    offhostInspection({ custodyStatus: 'offhost_or_offsite_custody_blocked' }),
    offhostInspection({ custodyEvidenceBundleHash: null }),
    offhostInspection({ custodyTrustStoreHash: null }),
    offhostInspection({ storageIdentityHash: null }),
  ]) {
    const result = aggregate({ offhostWormCustodyInspection: inspection });
    assert.equal(result.offhostWormCustodyReady, false);
    assert.deepEqual(result.blockers, ['offhost_worm_custody_not_ready']);
  }
});

test('package readiness protocol verifies its v2 self-hash and freshness', () => {
  assert.equal(packageInspection().ready, true);
  assert.equal(inspectPackageRetentionRecoveryReadinessResponse({
    response: packageReadiness(),
    observedAt: VALID_UNTIL,
  }).ready, false);
  assert.equal(packageInspection({ ready: false }).ready, false);
  const tampered = packageReadiness();
  tampered.result.recoveryAuthorityAuthenticated = false;
  assert.throws(
    () => inspectPackageRetentionRecoveryReadinessResponse({
      response: tampered,
      observedAt: OBSERVED_AT,
    }),
    /full_production_package_readiness_protocol_invalid/,
  );
  const excessiveLifetime = packageReadiness();
  excessiveLifetime.result.recoveryAuthorityValidUntil =
    '2026-08-21T00:05:00.001Z';
  const {
    packageRetentionRecoveryReadinessHash: _ignoredLifetimeHash,
    ...excessiveLifetimePayload
  } = excessiveLifetime.result;
  excessiveLifetime.result.packageRetentionRecoveryReadinessHash = hashRecord(
    'PackageRetentionRecoveryReadiness',
    excessiveLifetimePayload,
  );
  assert.throws(
    () => inspectPackageRetentionRecoveryReadinessResponse({
      response: excessiveLifetime,
      observedAt: OBSERVED_AT,
    }),
    /full_production_package_readiness_protocol_invalid/,
  );
  assert.throws(
    () => inspectPackageRetentionRecoveryReadinessResponse({
      response: { status: 'wrong', result: {} },
      observedAt: OBSERVED_AT,
    }),
    /full_production_package_readiness_protocol_invalid/,
  );

  const forgedAggregateInspection = {
    ...packageInspection(),
    readiness: {
      ...packageInspection().readiness,
      packageRetentionRecoveryReadinessHash: HASH_A,
    },
  };
  assert.equal(aggregate({
    packageRetentionRecoveryInspection: forgedAggregateInspection,
  }).packageRetentionRecoveryReady, false);
  assert.equal(aggregate({
    packageRetentionRecoveryInspection: {
      kind: 'PackageRetentionRecoveryReadinessInspection',
      ready: true,
    },
  }).packageRetentionRecoveryReady, false);
});

test('composition runs the pinned package launcher with fixed args and a restricted environment',
  async (t) => {
    let captured;
    let pinnedSource;
    const options = compositionOptions(t, async (request) => {
      captured = request;
      pinnedSource = fs.readFileSync(request.inheritedDescriptors[0], 'utf8');
      return {
        exitCode: 0,
        stdout: JSON.stringify(packageReadiness()),
        stderr: 'ExperimentalWarning: node:sqlite is experimental\n',
        timedOut: false,
        aborted: false,
        outputTruncated: false,
        error: null,
      };
    });
    const output = await queryFullProductionReadiness(options);
    assert.equal(output.fullProductionReady, true);
    assert.equal(captured.executable, '/proc/self/fd/3');
    assert.equal(captured.inheritedDescriptors.length, 1);
    assert.match(pinnedSource, /^#!\/bin\/sh/u);
    assert.deepEqual(captured.args, [
      '--action', 'retention-recovery-readiness',
      '--root', '/srv/hepta-paper/assets',
      '--runtime-root', options.runtimeRoot,
    ]);
    assert.equal(captured.env.OPENAI_API_KEY, undefined);
    assert.equal(captured.env.HEPTA_PRIVATE_PROVIDER_TOKEN, undefined);
    assert.equal(captured.env.HOME, '/tmp/restricted-home');
  });

test('composition executes the descriptor-pinned launcher with the bounded production runner',
  async (t) => {
    const options = compositionOptions(t, undefined);
    fs.chmodSync(options.packageRecoveryReadinessCommand, 0o755);
    fs.writeFileSync(
      options.packageRecoveryReadinessCommand,
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(packageReadiness())}'\n`,
    );
    fs.chmodSync(options.packageRecoveryReadinessCommand, 0o555);
    options.packageRecoveryReadinessCommandSha256 = fileSha256HashSync(
      options.packageRecoveryReadinessCommand,
    );
    const output = await queryFullProductionReadiness(options);
    assert.equal(output.fullProductionReady, true);
  });

test('composition runs package first and final observation rechecks package and WORM expiry',
  async (t) => {
    const events = [];
    const child = async () => {
      events.push('package');
      return {
        exitCode: 0,
        stdout: JSON.stringify(packageReadiness()),
        stderr: '',
        timedOut: false,
        aborted: false,
        outputTruncated: false,
        error: null,
      };
    };
    const packageExpiry = compositionOptions(t, child);
    packageExpiry.clock = {
      now: (() => {
        const values = [
          new Date(OBSERVED_AT),
          new Date('2026-08-21T00:03:59.000Z'),
          new Date(VALID_UNTIL),
        ];
        return () => values.shift() || new Date(VALID_UNTIL);
      })(),
    };
    packageExpiry.automationReadinessQuery = () => {
      events.push('automation');
      return { report: automationReport(), exitCode: 0 };
    };
    packageExpiry.offhostWormVerifier = ({ contract }) => {
      events.push('worm');
      return offhostInspection({
        contractId: contract.contractId,
        custodyEvidenceExpiresAt: '2026-08-21T00:05:00.000Z',
      });
    };
    const packageExpired = await queryFullProductionReadiness(packageExpiry);
    assert.deepEqual(events, ['package', 'automation', 'worm']);
    assert.equal(packageExpired.packageRetentionRecoveryReady, false);
    assert.equal(packageExpired.offhostWormCustodyReady, true);

    const wormExpiry = compositionOptions(t, child);
    wormExpiry.clock = {
      now: (() => {
        const values = [
          new Date(OBSERVED_AT),
          new Date(OBSERVED_AT),
          new Date('2026-08-21T00:00:03.000Z'),
        ];
        return () => values.shift() || new Date('2026-08-21T00:00:03.000Z');
      })(),
    };
    wormExpiry.offhostWormVerifier = ({ contract }) => offhostInspection({
      contractId: contract.contractId,
      custodyEvidenceExpiresAt: '2026-08-21T00:00:02.500Z',
    });
    const wormExpired = await queryFullProductionReadiness(wormExpiry);
    assert.equal(wormExpired.packageRetentionRecoveryReady, true);
    assert.equal(wormExpired.offhostWormCustodyReady, false);
  });

test('composition detects launcher pathname replacement while retaining the original descriptor',
  async (t) => {
    let options;
    let pinnedSource;
    options = compositionOptions(t, async (request) => {
      pinnedSource = fs.readFileSync(request.inheritedDescriptors[0], 'utf8');
      fs.renameSync(
        options.packageRecoveryReadinessCommand,
        `${options.packageRecoveryReadinessCommand}.original`,
      );
      fs.writeFileSync(
        options.packageRecoveryReadinessCommand,
        '#!/bin/sh\necho substituted\n',
        { mode: 0o555 },
      );
      fs.chmodSync(options.packageRecoveryReadinessCommand, 0o555);
      return {
        exitCode: 0,
        stdout: JSON.stringify(packageReadiness()),
        stderr: '',
        timedOut: false,
        aborted: false,
        outputTruncated: false,
        error: null,
      };
    });
    await assert.rejects(
      queryFullProductionReadiness(options),
      /full_production_package_readiness_command_reference_drift/,
    );
    assert.equal(pinnedSource, '#!/bin/sh\nexit 0\n');
  });

test('composition hash-pins root-owned owner evidence and rejects substitution or escape',
  async (t) => {
    const success = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(packageReadiness()),
      stderr: '',
      timedOut: false,
      aborted: false,
      outputTruncated: false,
      error: null,
    });
    const wrongHash = compositionOptions(t, success);
    await assert.rejects(queryFullProductionReadiness({
      ...wrongHash,
      ownerTrustStoreSha256: HASH_B,
    }), /full_production_owner_reference_invalid/);
    await assert.rejects(queryFullProductionReadiness({
      ...wrongHash,
      ownerAcceptanceDocument: wrongHash.packageRecoveryReadinessCommand,
      ownerAcceptanceDocumentSha256: wrongHash.packageRecoveryReadinessCommandSha256,
    }), /full_production_owner_reference_invalid/);

    const drift = compositionOptions(t, success);
    drift.operationalProofLoader = () => {
      fs.renameSync(drift.ownerTrustStore, `${drift.ownerTrustStore}.original`);
      fs.writeFileSync(drift.ownerTrustStore, '{}\n', { mode: 0o444 });
      fs.chmodSync(drift.ownerTrustStore, 0o444);
      return completeOperationalProofs();
    };
    await assert.rejects(
      queryFullProductionReadiness(drift),
      /capability_proof_(?:path|file)_changed_after_read/,
    );

    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      const productionOwnerPolicy = compositionOptions(t, success);
      delete productionOwnerPolicy.ownerReferenceRequiredUid;
      await assert.rejects(
        queryFullProductionReadiness(productionOwnerPolicy),
        /full_production_owner_reference_invalid/,
      );
    }
  });

test('composition classifies package child failures and malformed output as infrastructure',
  async (t) => {
    const failures = [
      { exitCode: 1, stdout: '{}', timedOut: false, aborted: false, outputTruncated: false },
      { exitCode: null, stdout: '', timedOut: true, aborted: false, outputTruncated: false },
      { exitCode: 0, stdout: '{}', timedOut: false, aborted: false, outputTruncated: true },
      { exitCode: 0, stdout: 'not-json', timedOut: false, aborted: false, outputTruncated: false },
    ];
    for (const failure of failures) {
      await assert.rejects(
        queryFullProductionReadiness(compositionOptions(t, async () => ({
          stderr: '', error: null, ...failure,
        }))),
        /full_production_package_readiness_(?:child|command|protocol)/,
      );
    }
  });

test('composition rejects wrong hashes, non-executable files and symlink launchers', async (t) => {
  const base = compositionOptions(t, async () => ({
    exitCode: 0,
    stdout: JSON.stringify(packageReadiness()),
    stderr: '',
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    error: null,
  }));
  await assert.rejects(
    queryFullProductionReadiness({
      ...base,
      packageRecoveryReadinessCommandSha256: HASH_B,
    }),
    /full_production_package_readiness_command_reference_drift/,
  );
  fs.chmodSync(base.packageRecoveryReadinessCommand, 0o444);
  await assert.rejects(
    queryFullProductionReadiness(base),
    /full_production_package_readiness_command_reference_invalid/,
  );
  fs.chmodSync(base.packageRecoveryReadinessCommand, 0o555);
  const symlink = `${base.packageRecoveryReadinessCommand}.link`;
  fs.symlinkSync(base.packageRecoveryReadinessCommand, symlink);
  await assert.rejects(
    queryFullProductionReadiness({
      ...base,
      packageRecoveryReadinessCommand: symlink,
    }),
    /full_production_package_readiness_command_reference_invalid/,
  );
});

test('composition production policy rejects a current-uid package authority command',
  async (t) => {
    if (typeof process.getuid !== 'function' || process.getuid() === 0) return;
    const options = compositionOptions(t, async () => ({
      exitCode: 0,
      stdout: JSON.stringify(packageReadiness()),
      stderr: '',
      timedOut: false,
      aborted: false,
      outputTruncated: false,
      error: null,
    }));
    delete options.packageRecoveryReadinessCommandRequiredUid;
    delete options.testOnlyPackageRecoveryReadinessCommandTrustRoot;
    await assert.rejects(
      queryFullProductionReadiness(options),
      /full_production_package_readiness_command_reference_invalid/,
    );
  });

test('full production CLI uses exit 2 only for complete semantic not-ready output', async () => {
  const writes = [];
  const blocked = aggregate({
    independentProductionOperationalProofInspection: operationalInspection({
      status: 'independent_production_operational_proof_blocked',
      verified: 0,
    }),
  });
  const common = {
    stdout: { write: (value) => writes.push(value) },
    environment: {},
    query: async () => blocked,
  };
  assert.equal((await runFullProductionReadiness({
    ...common,
    argv: [
      '--package-recovery-readiness-command', '/usr/local/bin/package-ready',
      '--package-recovery-readiness-command-sha256', HASH_A,
    ],
  })).exitCode, 0);
  assert.equal((await runFullProductionReadiness({
    ...common,
    argv: [
      '--package-recovery-readiness-command', '/usr/local/bin/package-ready',
      '--package-recovery-readiness-command-sha256', HASH_A,
      '--require-full-production',
    ],
  })).exitCode, 2);
  assert.equal(JSON.parse(writes.at(-1)).fullProductionReady, false);
  await assert.rejects(
    runFullProductionReadiness({
      ...common,
      argv: ['--require-full-production'],
      query: async () => { throw new Error('infrastructure_failed'); },
    }),
    /infrastructure_failed/,
  );
});
