import { registerHooks } from 'node:module';

import {
  importAutonomousResearchReleaseBindingForTest,
  importCampaignReleaseContractsForTest,
} from './raw-event-recomputation-sandbox-test-seam.mjs';

const GRAPH = 'raw-event-recomputation-fixture-v1';
const moduleUrl = (relative) => new URL(relative, import.meta.url);
const testUrl = (url) => {
  const result = new URL(url.href);
  result.searchParams.set('hepta_test_graph', GRAPH);
  return result;
};

const RELEASE_BINDING = moduleUrl(
  '../../../paper-domain/automation/autonomous-research-release-binding-contract.mjs',
);
const CAMPAIGN_RELEASE = moduleUrl(
  '../../../paper-domain/automation/campaign-release-contracts.mjs',
);
const EXTERNAL_EVIDENCE = moduleUrl(
  '../../../paper-domain/automation/external-research-qualification-verification-evidence-contract.mjs',
);
const EXTERNAL_POLICY = moduleUrl(
  '../../../paper-domain/automation/external-research-qualification-verification-policy-contract.mjs',
);
const EXTERNAL_ATTESTATION = moduleUrl(
  '../../../paper-adapters/automation/external-research-qualification-verifier-attestation.mjs',
);
const EXTERNAL_PROCESS_ADAPTER = moduleUrl(
  '../../../paper-adapters/automation/external-research-qualification-process-adapter.mjs',
);
const EXTERNAL_LOCAL_VERIFIER = moduleUrl(
  '../../../paper-adapters/automation/external-research-qualification-local-verifier.mjs',
);
const FULL_RELEASE_INSPECTION = moduleUrl(
  '../../../paper-domain/automation/full-research-release-qualification-inspection.mjs',
);
const FULL_QUALIFICATION = moduleUrl(
  '../../../paper-domain/automation/full-research-qualification-contract.mjs',
);
const SUBMISSION_QUALIFICATION = moduleUrl(
  '../../../paper-domain/automation/autonomous-submission-qualification-inspection.mjs',
);
const LOCAL_VENUE_INSPECTOR = moduleUrl(
  '../../../paper-adapters/automation/local-autonomous-venue-compliance-inspector.mjs',
);
const VENUE_COMPLIANCE = moduleUrl(
  '../../../paper-domain/automation/autonomous-venue-compliance-contract.mjs',
);
const RESEARCH_CLOSURE = moduleUrl(
  '../../../paper-domain/automation/research-closure-receipt-contract.mjs',
);
const AUTONOMOUS_SUBMISSION = moduleUrl(
  '../../../paper-domain/automation/autonomous-submission-contract.mjs',
);
const SUBMISSION_RESEARCH_CLOSURE = moduleUrl(
  '../../../paper-domain/automation/autonomous-submission-research-closure.mjs',
);
const EXTERNAL_SIGNED_EVIDENCE_FIXTURE = moduleUrl(
  './external-qualification-signed-evidence.data.mjs',
);

const RELEASE_BINDING_TEST = testUrl(RELEASE_BINDING);
const CAMPAIGN_RELEASE_TEST = testUrl(CAMPAIGN_RELEASE);
const EXTERNAL_EVIDENCE_TEST = testUrl(EXTERNAL_EVIDENCE);
const EXTERNAL_POLICY_TEST = testUrl(EXTERNAL_POLICY);
const EXTERNAL_ATTESTATION_TEST = testUrl(EXTERNAL_ATTESTATION);
const EXTERNAL_PROCESS_ADAPTER_TEST = testUrl(EXTERNAL_PROCESS_ADAPTER);
const EXTERNAL_LOCAL_VERIFIER_TEST = testUrl(EXTERNAL_LOCAL_VERIFIER);
const FULL_RELEASE_INSPECTION_TEST = testUrl(FULL_RELEASE_INSPECTION);
const FULL_QUALIFICATION_TEST = testUrl(FULL_QUALIFICATION);
const SUBMISSION_QUALIFICATION_TEST = testUrl(SUBMISSION_QUALIFICATION);
const LOCAL_VENUE_INSPECTOR_TEST = testUrl(LOCAL_VENUE_INSPECTOR);
const VENUE_COMPLIANCE_TEST = testUrl(VENUE_COMPLIANCE);
const RESEARCH_CLOSURE_TEST = testUrl(RESEARCH_CLOSURE);
const AUTONOMOUS_SUBMISSION_TEST = testUrl(AUTONOMOUS_SUBMISSION);
const SUBMISSION_RESEARCH_CLOSURE_TEST = testUrl(SUBMISSION_RESEARCH_CLOSURE);
const EXTERNAL_SIGNED_EVIDENCE_FIXTURE_TEST = testUrl(
  EXTERNAL_SIGNED_EVIDENCE_FIXTURE,
);

const edge = (parent, target) => [parent.href, target.href].join('\n');
const redirects = new Map([
  [edge(EXTERNAL_EVIDENCE_TEST, EXTERNAL_POLICY), EXTERNAL_POLICY_TEST.href],
  [edge(EXTERNAL_ATTESTATION_TEST, EXTERNAL_EVIDENCE), EXTERNAL_EVIDENCE_TEST.href],
  [edge(EXTERNAL_PROCESS_ADAPTER_TEST, FULL_QUALIFICATION),
    FULL_QUALIFICATION_TEST.href],
  [edge(EXTERNAL_PROCESS_ADAPTER_TEST, EXTERNAL_POLICY),
    EXTERNAL_POLICY_TEST.href],
  [edge(EXTERNAL_PROCESS_ADAPTER_TEST, EXTERNAL_EVIDENCE),
    EXTERNAL_EVIDENCE_TEST.href],
  [edge(EXTERNAL_PROCESS_ADAPTER_TEST, EXTERNAL_ATTESTATION),
    EXTERNAL_ATTESTATION_TEST.href],
  [edge(EXTERNAL_PROCESS_ADAPTER_TEST, EXTERNAL_LOCAL_VERIFIER),
    EXTERNAL_LOCAL_VERIFIER_TEST.href],
  [edge(EXTERNAL_LOCAL_VERIFIER_TEST, FULL_QUALIFICATION),
    FULL_QUALIFICATION_TEST.href],
  [edge(EXTERNAL_LOCAL_VERIFIER_TEST, EXTERNAL_POLICY),
    EXTERNAL_POLICY_TEST.href],
  [edge(EXTERNAL_LOCAL_VERIFIER_TEST, EXTERNAL_ATTESTATION),
    EXTERNAL_ATTESTATION_TEST.href],
  [edge(EXTERNAL_SIGNED_EVIDENCE_FIXTURE_TEST, EXTERNAL_PROCESS_ADAPTER),
    EXTERNAL_PROCESS_ADAPTER_TEST.href],
  [edge(EXTERNAL_SIGNED_EVIDENCE_FIXTURE_TEST, EXTERNAL_ATTESTATION),
    EXTERNAL_ATTESTATION_TEST.href],
  [edge(EXTERNAL_SIGNED_EVIDENCE_FIXTURE_TEST, EXTERNAL_EVIDENCE),
    EXTERNAL_EVIDENCE_TEST.href],
  [edge(EXTERNAL_SIGNED_EVIDENCE_FIXTURE_TEST, EXTERNAL_POLICY),
    EXTERNAL_POLICY_TEST.href],
  [edge(EXTERNAL_POLICY_TEST, RELEASE_BINDING), RELEASE_BINDING_TEST.href],
  [edge(EXTERNAL_POLICY_TEST, FULL_RELEASE_INSPECTION), FULL_RELEASE_INSPECTION_TEST.href],
  [edge(FULL_RELEASE_INSPECTION_TEST, RELEASE_BINDING), RELEASE_BINDING_TEST.href],
  [edge(FULL_QUALIFICATION_TEST, FULL_RELEASE_INSPECTION), FULL_RELEASE_INSPECTION_TEST.href],
  [edge(SUBMISSION_QUALIFICATION_TEST, FULL_QUALIFICATION), FULL_QUALIFICATION_TEST.href],
  [edge(SUBMISSION_QUALIFICATION_TEST, EXTERNAL_EVIDENCE), EXTERNAL_EVIDENCE_TEST.href],
  [edge(LOCAL_VENUE_INSPECTOR_TEST, VENUE_COMPLIANCE), VENUE_COMPLIANCE_TEST.href],
  [edge(VENUE_COMPLIANCE_TEST, RELEASE_BINDING), RELEASE_BINDING_TEST.href],
  [edge(RESEARCH_CLOSURE_TEST, RELEASE_BINDING), RELEASE_BINDING_TEST.href],
  [edge(RESEARCH_CLOSURE_TEST, CAMPAIGN_RELEASE), CAMPAIGN_RELEASE_TEST.href],
  [edge(RESEARCH_CLOSURE_TEST, FULL_QUALIFICATION), FULL_QUALIFICATION_TEST.href],
  [edge(RESEARCH_CLOSURE_TEST, SUBMISSION_QUALIFICATION),
    SUBMISSION_QUALIFICATION_TEST.href],
  [edge(RESEARCH_CLOSURE_TEST, VENUE_COMPLIANCE), VENUE_COMPLIANCE_TEST.href],
  [edge(AUTONOMOUS_SUBMISSION_TEST, RELEASE_BINDING), RELEASE_BINDING_TEST.href],
  [edge(AUTONOMOUS_SUBMISSION_TEST, VENUE_COMPLIANCE), VENUE_COMPLIANCE_TEST.href],
  [edge(AUTONOMOUS_SUBMISSION_TEST, SUBMISSION_QUALIFICATION),
    SUBMISSION_QUALIFICATION_TEST.href],
  [edge(AUTONOMOUS_SUBMISSION_TEST, SUBMISSION_RESEARCH_CLOSURE),
    SUBMISSION_RESEARCH_CLOSURE_TEST.href],
  [edge(SUBMISSION_RESEARCH_CLOSURE_TEST, RESEARCH_CLOSURE), RESEARCH_CLOSURE_TEST.href],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const replacement = redirects.get([context.parentURL, resolved.url].join('\n'));
    return replacement ? { shortCircuit: true, url: replacement } : resolved;
  },
});

export {
  importAutonomousResearchReleaseBindingForTest,
  importCampaignReleaseContractsForTest,
};

export const importExternalResearchQualificationEvidenceForTest = () =>
  import(EXTERNAL_EVIDENCE_TEST.href);
export const importExternalResearchQualificationPolicyForTest = () =>
  import(EXTERNAL_POLICY_TEST.href);
export const importExternalResearchQualificationAttestationForTest = () =>
  import(EXTERNAL_ATTESTATION_TEST.href);
export const importExternalResearchQualificationProcessAdapterForTest = () =>
  import(EXTERNAL_PROCESS_ADAPTER_TEST.href);
export const importExternalQualificationSignedEvidenceForTest = () =>
  import(EXTERNAL_SIGNED_EVIDENCE_FIXTURE_TEST.href);
export const importFullResearchQualificationForTest = () =>
  import(FULL_QUALIFICATION_TEST.href);
export const importLocalAutonomousVenueComplianceInspectorForTest = () =>
  import(LOCAL_VENUE_INSPECTOR_TEST.href);
export const importAutonomousVenueComplianceContractForTest = () =>
  import(VENUE_COMPLIANCE_TEST.href);
export const importResearchClosureReceiptContractForTest = () =>
  import(RESEARCH_CLOSURE_TEST.href);
export const importAutonomousSubmissionContractForTest = () =>
  import(AUTONOMOUS_SUBMISSION_TEST.href);
