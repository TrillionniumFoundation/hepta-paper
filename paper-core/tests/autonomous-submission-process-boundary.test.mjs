import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildAutonomousSubmissionPortalConfiguration,
  deriveAutonomousSubmissionPortalPublicConfiguration,
  readAutonomousSubmissionPortalConfiguration,
  readAutonomousSubmissionPortalPublicConfiguration,
} from '../../paper-adapters/automation/http-autonomous-submission-portal-adapter.mjs';
import {
  autonomousSubmissionPortalPublicDescriptorHash,
} from '../../paper-adapters/automation/autonomous-submission-portal-public-adapter.mjs';
import {
  prepareAutonomousSubmissionHandoff,
} from '../../paper-application/automation/autonomous-submission-delivery.mjs';
import {
  composeAutonomousResearchSubmissionServices,
} from '../../paper-composition/automation/autonomous-research-submission-composition.mjs';
import {
  composeAutonomousSubmissionDispatcherServices,
} from '../../paper-composition/automation/autonomous-submission-dispatcher-services-composition.mjs';
import {
  createAutonomousSubmissionDispatchAuthority,
} from '../../paper-composition/automation/autonomous-submission-dispatch-authority-composition.mjs';

const H = (label) => hashRecord('AutonomousSubmissionProcessBoundaryTest', { label });

function portalConfiguration(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-submission-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = buildAutonomousSubmissionPortalConfiguration({
    portalId: 'test-portal',
    endpoint: 'https://submission.example.test/v1/',
    serviceIdentityHash: H('service'),
    portalAccountIdentityHash: H('account'),
    portalTrustDomainIdentityHash: H('trust-domain'),
    tokenEnvironmentVariable: 'TEST_AUTONOMOUS_SUBMISSION_TOKEN',
  });
  const configPath = path.join(root, 'portal.json');
  fs.writeFileSync(configPath, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  const publicConfiguration = deriveAutonomousSubmissionPortalPublicConfiguration({
    configuration,
  });
  const descriptorPath = path.join(root, 'portal-descriptor.json');
  fs.writeFileSync(descriptorPath, `${JSON.stringify(publicConfiguration)}\n`, {
    mode: 0o644,
  });
  return { configuration, configPath, publicConfiguration, descriptorPath, root };
}

function verifier(request) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionRequestVerifier',
    verify: (candidate) => candidate === request,
  });
}

function handoffOutbox(request) {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionOutboxPort',
    durability: 'sqlite-transactional-outbox-v1',
    singleUseDispatchCapabilityIssued: true,
    externallyFencedMutations: true,
    prepareAutonomousSubmission({ request: candidate, portalId }) {
      assert.equal(candidate, request);
      return Object.freeze({
        request,
        portalId,
        stateReceipt: Object.freeze({
          state: 'prepared',
          submissionReceipt: null,
          externalActionPerformed: false,
          externalActionMayHaveOccurred: false,
          redrivePermitted: false,
          lookupRequired: false,
          terminal: false,
        }),
      });
    },
    beginAutonomousSubmissionAttempt() { throw new Error('dispatch_not_permitted'); },
    recordAutonomousSubmissionOutcome() { throw new Error('dispatch_not_permitted'); },
    getAutonomousSubmission() { return null; },
    listAutonomousSubmissionsForCampaign() { return Object.freeze([]); },
  });
}

test('research composition refuses private portal configuration fallback', (t) => {
  const { configPath } = portalConfiguration(t);
  const services = composeAutonomousResearchSubmissionServices({
    environment: { HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIG: configPath },
    runtimeRoot: path.dirname(configPath),
    autonomousSubmissionRequestVerifier: Object.freeze({
      kind: 'AutonomousSubmissionRequestVerifier', verify: () => true,
    }),
  });
  assert.equal(services.autonomousSubmissionPortal, null);

  const authority = createAutonomousSubmissionDispatchAuthority();
  assert.throws(() => composeAutonomousSubmissionDispatcherServices({
    environment: { HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIG: configPath },
    autonomousSubmissionRequestVerifier: services.autonomousSubmissionRequestVerifier,
    autonomousSubmissionPortalDispatchCapability: authority.portal,
  }), /autonomous_submission_portal_runtime_credentials_missing/);
});

test('research handoff persists intent without issuing a dispatch permit or network action', () => {
  const request = Object.freeze({ requestHash: H('request') });
  const report = prepareAutonomousSubmissionHandoff({
    outbox: handoffOutbox(request),
    request,
    portalId: 'test-portal',
    submissionRequestVerifier: verifier(request),
  });
  assert.equal(report.status, 'autonomous_submission_delivery_prepared');
  assert.equal(report.networkActionPerformed, false);
  assert.equal(report.externalActionPerformed, false);
  assert.equal(report.terminal, false);
});

test('research consumes only a public descriptor while dispatcher binds it to private config', (t) => {
  const {
    configuration,
    configPath,
    publicConfiguration,
    descriptorPath,
    root,
  } = portalConfiguration(t);
  const verifierPort = Object.freeze({
    kind: 'AutonomousSubmissionRequestVerifier', verify: () => true,
  });
  const publicEnvironment = {
    HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG: descriptorPath,
    HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH:
      configuration.configurationHash,
    HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH:
      autonomousSubmissionPortalPublicDescriptorHash(publicConfiguration),
  };
  const research = composeAutonomousResearchSubmissionServices({
    environment: publicEnvironment,
    runtimeRoot: root,
    autonomousSubmissionRequestVerifier: verifierPort,
  });
  assert.equal(research.autonomousSubmissionPortal.configurationHash,
    configuration.configurationHash);
  assert.equal('endpoint' in publicConfiguration, false);
  assert.equal('tokenEnvironmentVariable' in publicConfiguration, false);
  assert.throws(() => composeAutonomousResearchSubmissionServices({
    environment: {
      ...publicEnvironment,
      TEST_AUTONOMOUS_SUBMISSION_TOKEN: 'must-not-reach-research',
    },
    runtimeRoot: root,
    autonomousSubmissionRequestVerifier: verifierPort,
  }), /autonomous_submission_portal_credential_in_research_environment/);

  const authority = createAutonomousSubmissionDispatchAuthority();
  const dispatcher = composeAutonomousSubmissionDispatcherServices({
    environment: {
      ...publicEnvironment,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIG: configPath,
      TEST_AUTONOMOUS_SUBMISSION_TOKEN: 'fixture-token',
    },
    autonomousSubmissionRequestVerifier: verifierPort,
    autonomousSubmissionPortalDispatchCapability: authority.portal,
  });
  assert.equal(dispatcher.autonomousSubmissionPortal.kind,
    'AutonomousSubmissionPortalPort');

  const other = buildAutonomousSubmissionPortalConfiguration({
    ...configuration,
    portalId: 'other-portal',
  });
  const otherDescriptor = deriveAutonomousSubmissionPortalPublicConfiguration({
    configuration: other,
  });
  const otherDescriptorPath = path.join(root, 'other-portal-descriptor.json');
  fs.writeFileSync(otherDescriptorPath, `${JSON.stringify(otherDescriptor)}\n`, {
    mode: 0o644,
  });
  assert.throws(() => composeAutonomousSubmissionDispatcherServices({
    environment: {
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIG: configPath,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG: otherDescriptorPath,
      HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH:
        other.configurationHash,
      TEST_AUTONOMOUS_SUBMISSION_TOKEN: 'fixture-token',
    },
    autonomousSubmissionRequestVerifier: verifierPort,
    autonomousSubmissionPortalDispatchCapability: authority.portal,
  }), /autonomous_submission_portal_configuration_verification_failed/);
});

test('portal configuration readers enforce pins and immutable single-link files', (t) => {
  const {
    configuration,
    configPath,
    publicConfiguration,
    descriptorPath,
    root,
  } = portalConfiguration(t);
  const descriptorHash =
    autonomousSubmissionPortalPublicDescriptorHash(publicConfiguration);
  assert.deepEqual(readAutonomousSubmissionPortalConfiguration({
    configPath,
    expectedConfigurationHash: configuration.configurationHash,
  }), configuration);
  assert.deepEqual(readAutonomousSubmissionPortalPublicConfiguration({
    configPath: descriptorPath,
    expectedConfigurationHash: configuration.configurationHash,
    expectedDescriptorHash: descriptorHash,
  }), publicConfiguration);
  assert.throws(() => readAutonomousSubmissionPortalConfiguration({
    configPath,
    expectedConfigurationHash: H('wrong-private-pin'),
  }), /autonomous_submission_portal_configuration_verification_failed/);
  assert.throws(() => readAutonomousSubmissionPortalPublicConfiguration({
    configPath: descriptorPath,
    expectedConfigurationHash: configuration.configurationHash,
    expectedDescriptorHash: H('wrong-descriptor-pin'),
  }), /autonomous_submission_portal_public_configuration_verification_failed/);

  fs.chmodSync(descriptorPath, 0o666);
  assert.throws(() => readAutonomousSubmissionPortalPublicConfiguration({
    configPath: descriptorPath,
  }), /autonomous_submission_portal_public_configuration_file_invalid/);
  fs.chmodSync(descriptorPath, 0o644);

  const hardlinkPath = path.join(root, 'portal-hardlink.json');
  fs.linkSync(configPath, hardlinkPath);
  assert.throws(() => readAutonomousSubmissionPortalConfiguration({
    configPath,
  }), /autonomous_submission_portal_configuration_file_invalid/);
});
