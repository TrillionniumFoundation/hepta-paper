import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  issueAutonomousResearchSupervisorDispatchAuthorization,
} from '../../../paper-application/automation/autonomous-research-supervisor-dispatch-authorization.mjs';
import { signAuthorityDocument } from '../../../paper-adapters/authority/authority-signatures.mjs';
import {
  verifyAutonomousResearchGlobalGoldenQualificationAuthority,
} from '../../../paper-domain/automation/autonomous-research-global-golden-qualification-authority-contract.mjs';
import {
  buildAutonomousResearchMachineIntake,
  buildAutonomousResearchRecurringGoldenTemplate,
} from '../../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
} from '../../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';
import {
  buildCanonicalAnalysisProtocol,
} from '../../../paper-domain/automation/analysis-protocol-contract.mjs';
import {
  buildCampaignBenchmarkSelector,
} from '../../../paper-domain/automation/campaign-benchmark-selector.mjs';
import {
  validateOperatorDatasetAuthorityDocument,
} from '../../../paper-domain/automation/operator-dataset-harness-contract.mjs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';
import {
  bindGenericGoldenPreparationFixture,
  genericManuscriptReleaseFixture,
} from './autonomous-research-generalization-fixture.mjs';

const H = (label) => hashRecord('AutonomousCampaignTestHash', { label });

export function authorizedDatasetMount(base, name = 'autonomous-dataset') {
  const source = path.join(base, name);
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'dataset.json'), '{}\n');
  const benchmarkFamily = 'ml_algorithm_benchmark';
  const repositoryDesign = buildCampaignBenchmarkSelector({
    benchmarkId: benchmarkFamily,
  }).experimentDesign;
  const builtProtocol = buildCanonicalAnalysisProtocol({
    benchmarkId: name,
    benchmarkFamily,
    requiredMetrics: repositoryDesign.requiredMetrics,
    metricSpecs: repositoryDesign.metricSpecs,
  });
  const { analysisProtocolHash, ...analysisProtocol } = builtProtocol;
  const datasetManifestHash = H(`dataset-manifest:${name}`);
  const splitManifestHash = H(`dataset-split:${name}`);
  const benchmarkHarnessDefinitionHash = H(`dataset-harness:${name}`);
  const signed = signAuthorityDocument({
    version: 2,
    kind: 'OperatorDatasetHarnessAuthority',
    datasetName: name,
    datasetManifestHash,
    datasetLicenseId: 'CC-BY-4.0',
    datasetSplitManifestHash: splitManifestHash,
    benchmarkHarnessDefinitionHash,
    analysisProtocolHash,
    benchmarkFamily,
    seedSchedule: [17, 23, 31, 43, 59],
    minimumRepetitions: 7,
    workerExposurePolicy: 'signed-complete-dataset-file-manifest-v1',
    signedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
  }, {
    privateKeyPem: crypto.generateKeyPairSync('ed25519').privateKey
      .export({ type: 'pkcs8', format: 'pem' }),
    keyId: `dataset-key:${name}`,
    role: 'dataset_harness_operator',
  });
  const validated = validateOperatorDatasetAuthorityDocument(signed);
  return Object.freeze({
    name,
    source,
    readOnly: true,
    manifestHash: datasetManifestHash,
    licenseId: 'CC-BY-4.0',
    operatorAuthorizationHash:
      validated.operatorDatasetAuthorityDocumentHash,
    operatorDatasetAuthorityDocumentHash:
      validated.operatorDatasetAuthorityDocumentHash,
    operatorDatasetAuthority: validated.authority,
    splitManifestHash,
    benchmarkHarnessDocumentHash: H(`dataset-document:${name}`),
    benchmarkHarnessDefinitionHash,
    analysisProtocol,
    analysisProtocolHash,
    benchmarkFamily,
    benchmarkSeedSchedule: [17, 23, 31, 43, 59],
    benchmarkMinimumRepetitions: 7,
  });
}

export function qualifiedGoldenContext({
  basePreparation,
  datasetMount,
} = {}) {
  const objective = basePreparation.proposal.objective;
  const protocolFamily = basePreparation.proposal.protocolFamily;
  const sourcePaperId = basePreparation.proposal.paperId;
  const providerConfigurationHash = H(`golden-provider:${sourcePaperId}`);
  const sourceAuthorityHash = H(`golden-source:${sourcePaperId}`);
  const template = buildAutonomousResearchRecurringGoldenTemplate({
    templateId: `qualification-${sourcePaperId}`,
    epochDurationMs: 12 * 60 * 60 * 1000,
    objective,
    protocolFamily,
    datasetMounts: [datasetMount],
    providerConfigurationHash,
    revisionRounds: 1,
    refereeCount: 3,
  });
  const epochKey = basePreparation.createdAt.replace(/[-:.]/g, '');
  const paperId = `golden:${template.templateId}:${epochKey}`;
  const campaignId = `autonomous-research:${paperId}`;
  const machineIntake = buildAutonomousResearchMachineIntake({
    intakeId: `intake:${paperId}`,
    paperId,
    campaignId,
    launchMode: 'golden-bootstrap',
    objective,
    protocolFamily,
    datasetMounts: [datasetMount],
    budgets: template.budgets,
    providerConfigurationHash,
    revisionRounds: 1,
    refereeCount: 3,
    admissionCreatedAt: basePreparation.createdAt,
    recurringGoldenProvenance: {
      version: 1,
      kind: 'AutonomousResearchRecurringGoldenProvenance',
      templateId: template.templateId,
      templateHash: template.templateHash,
      epochStart: basePreparation.createdAt,
      epochDurationMs: template.epochDurationMs,
      sourceAuthorityHash,
    },
  });
  const machineIntakeAdmission =
    buildAutonomousResearchMachineIntakeAdmission({
      intake: machineIntake,
      sourceKind: 'recurring-golden',
      sourceAuthorityHash,
    });
  const preparation = bindGenericGoldenPreparationFixture({
    basePreparation,
    machineIntake,
    machineIntakeAdmission,
    campaignPlanHash: H(`preparation-plan:${campaignId}`),
  });
  const executionAdmissionPayload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchCampaignExecutionAdmission',
    status: 'autonomous_research_campaign_admitted_not_authorized',
    initialCampaignStatus: 'paused',
    launchMode: preparation.launchMode,
    supervisorDispatchAuthorizationRequired: true,
    autonomousResearchMachineIntakeHash: machineIntake.intakeHash,
    autonomousResearchMachineIntakeAdmissionHash:
      machineIntakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
    providerConfigurationHash:
      preparation.autonomousResearchProviderConfigurationHash,
  });
  const executionAdmission = Object.freeze({
    ...executionAdmissionPayload,
    autonomousResearchCampaignExecutionAdmissionHash: hashRecord(
      'AutonomousResearchCampaignExecutionAdmission',
      executionAdmissionPayload,
    ),
  });
  const planPayload = Object.freeze({
    version: 4,
    kind: 'PaperCampaignPlan',
    campaignId,
    paperId,
    autonomousResearchPreparation: preparation,
    autonomousResearchMachineIntake: machineIntake,
    autonomousResearchMachineIntakeHash: machineIntake.intakeHash,
    autonomousResearchMachineIntakeAdmission: machineIntakeAdmission,
    autonomousResearchMachineIntakeAdmissionHash:
      machineIntakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
    executionAdmission,
  });
  const campaignPlanHash = hashRecord('PaperCampaignPlan', planPayload);
  const fixture = genericManuscriptReleaseFixture({
    campaignId,
    paperId,
    campaignPlanHash,
    launchMode: 'golden-bootstrap',
    objective,
    protocolFamily,
    externalSubmission: true,
    machineIntake,
    machineIntakeAdmission,
    bindingPreparation: preparation,
    policyAuthorizationHash:
      preparation.policyAuthorization
        .autonomousResearchPolicyAuthorizationHash,
    seedBindingHash:
      preparation.seedBinding.autonomousResearchSeedBindingHash,
  });
  assert.equal(fixture.releaseBinding.genericContentCanaryVerified, true);
  assert.equal(
    fixture.releaseBinding.fullResearchQualificationEligible,
    false,
  );
  const globalAuthorityVerification =
    verifyAutonomousResearchGlobalGoldenQualificationAuthority(
      fixture.releaseBinding.globalGoldenQualificationAuthority,
      {
        campaignId,
        paperId,
        campaignPlanHash,
        launchMode: preparation.launchMode,
        providerConfigurationHash:
          preparation.autonomousResearchProviderConfigurationHash,
        autonomousResearchLoopPreparationReportHash:
          preparation.autonomousResearchLoopPreparationReportHash,
        capabilityScopeManifestHash:
          preparation.capabilityScopeManifest
            .autonomousResearchCapabilityScopeManifestHash,
        autonomousResearchMachineIntakeAdmissionHash:
          preparation.autonomousResearchMachineIntakeAdmissionHash,
      },
    );
  assert.deepEqual(globalAuthorityVerification.blockers, []);
  const campaign = Object.freeze({
    campaignId,
    paperId,
    status: 'completed',
    spec: Object.freeze({ ...planPayload, campaignPlanHash }),
  });
  const campaignReleaseBundleHash = H(`release:${campaignId}`);
  const authority = Object.freeze({
    status: 'current_completed_release',
    campaignStatus: 'completed',
    packageNodeStatus: 'completed',
    campaignId,
    paperId,
    campaignReleaseBundleHash,
    releaseBundle: Object.freeze({
      campaignPlanHash,
      campaignReleaseBundleHash,
      autonomousResearchReleaseBindingHash:
        fixture.releaseBinding.autonomousResearchReleaseBindingHash,
      autonomousResearchReleaseBinding: fixture.releaseBinding,
      researchReport: Object.freeze({
        promotionEligibility: Object.freeze({
          status: 'research_promotion_ready',
          blockers: Object.freeze([]),
        }),
      }),
    }),
  });
  return Object.freeze({ authority, campaign, campaignId, preparation });
}

export function machineDispatchOptions(campaign, action) {
  const now = new Date();
  const ownerId = `qualification-test:${campaign.campaignId}`;
  const leaseToken = `lease:${campaign.campaignId}:${action}`;
  const leaseGeneration = 1;
  const leaseExpiresAt =
    new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const campaignLease = Object.freeze({
    campaignId: campaign.campaignId,
    ownerId,
    leaseToken,
    leaseGeneration,
    expiresAt: leaseExpiresAt,
  });
  const providerCanaryState = Object.freeze({
    campaignId: campaign.campaignId,
    dispatchCount: 1,
    policy: Object.freeze({ providerCanaryIntervalMs: 5 * 60 * 1000 }),
    lastProviderCanaryStatus: 'verified',
    lastProviderCanaryReceiptHash:
      H(`canary:${campaign.campaignId}:${action}`),
    lastProviderCanaryAt: now.toISOString(),
    leaseOwner: ownerId,
    leaseToken,
    leaseGeneration,
    leaseExpiresAt,
  });
  const residentLease = Object.freeze({
    ownerId,
    leaseToken: `resident:${campaign.campaignId}:${action}`,
    leaseGeneration,
    expiresAt: leaseExpiresAt,
  });
  const residentLeaseContext = Object.freeze({
    kind: 'AutonomousResearchResidentLeaseContext',
    stage: 'before_campaign_dispatch',
    ownerId,
    leaseGeneration,
    leaseExpiresAt,
    lease: residentLease,
    assertCurrent() { return residentLease; },
  });
  return Object.freeze({
    supervisorDispatchAuthorization:
      issueAutonomousResearchSupervisorDispatchAuthorization({
        campaignId: campaign.campaignId,
        campaignPlanHash: campaign.spec.campaignPlanHash,
        launchMode: campaign.spec.autonomousResearchPreparation.launchMode,
        action,
        providerConfigurationHash:
          campaign.spec.autonomousResearchPreparation
            .autonomousResearchProviderConfigurationHash,
        campaignLease,
        residentLeaseContext,
        providerCanaryState,
        now,
        assertCampaignLease() { return campaignLease; },
        readCampaignState() { return providerCanaryState; },
      }),
    runtime: Object.freeze({
      clock: Object.freeze({ now: () => new Date(now) }),
    }),
  });
}
