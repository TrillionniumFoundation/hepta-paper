import fs from 'node:fs';

import {
  campaignAutomationOutputDirectory,
  findCampaignManuscript,
  findEmpiricalEntrypoint,
  hashWorkspaceFile,
  materializeAutomationArtifacts,
  readWorkspaceTextIfPresent,
  resolveCampaignWorkspace,
} from './campaign-node-workspace-support.mjs';
import {
  finalizeTheoremSpecification,
  readFinalizedTheoremSpecification,
} from './theorem-specification-finalizer.mjs';
import { materializeEmpiricalAssertionAuthority } from './empirical-assertion-authority.mjs';
import { renderTrustedAutonomousManuscript } from './trusted-autonomous-manuscript-renderer.mjs';
import {
  autonomousManuscriptEvidenceRefBindings,
} from './autonomous-manuscript-ir-materialization.mjs';
import {
  readVerifiedAutonomousManuscriptAuthorityRecords,
} from './trusted-autonomous-manuscript-authority-reader.mjs';

function prepareAutonomousManuscriptEvidenceRefBindings({
  workspace,
  empiricalAssertionAuthority,
  formalVerificationReceipt = null,
} = {}) {
  const root = fs.realpathSync(resolveCampaignWorkspace(workspace));
  const {
    proposal,
    policyAuthorization,
    seedBundle,
    formalSupportAuthority,
    priorArtReceipt,
    empiricalClaimLineage,
  } = readVerifiedAutonomousManuscriptAuthorityRecords(
    root,
    formalVerificationReceipt,
  );
  return autonomousManuscriptEvidenceRefBindings({
    proposal,
    policyAuthorization,
    seedBundle,
    empiricalClaimLineage,
    empiricalAssertionAuthority,
    formalSupportAuthority,
    formalVerificationReceipt,
    priorArtReceipt,
  });
}

export function createCampaignWorkspacePrimitivesAdapter({ runtimeRoot } = {}) {
  if (!runtimeRoot) throw new Error('runtimeRoot is required');
  return Object.freeze({
    version: 1,
    kind: 'CampaignWorkspacePrimitivesAdapter',
    describe({ sourceWorkspace } = {}) {
      const workspace = resolveCampaignWorkspace(sourceWorkspace);
      return Object.freeze({ workspace, manuscript: findCampaignManuscript(workspace) });
    },
    findEmpiricalEntrypoint: ({ workspace, language }) => findEmpiricalEntrypoint(workspace, language),
    readTextIfPresent: ({ workspace, relative }) => readWorkspaceTextIfPresent(workspace, relative),
    hashFile: ({ workspace, relative }) => hashWorkspaceFile(workspace, relative),
    outputDirectory: ({ campaignId, nodeId, attemptId }) => campaignAutomationOutputDirectory({
      runtimeRoot,
      campaignId,
      nodeId,
      attemptId,
    }),
    materializeArtifacts: (input) => materializeAutomationArtifacts(input),
    prepareEmpiricalAssertionAuthority: ({ workspace, paperId, campaignId, campaignNodes }) =>
      materializeEmpiricalAssertionAuthority({
        workspace,
        paperId,
        campaignId,
        nodes: campaignNodes,
      }),
    prepareAutonomousManuscriptEvidenceRefBindings,
    renderTrustedAutonomousManuscript,
    finalizeTheoremSpecification,
    readTheoremSpecification: readFinalizedTheoremSpecification,
  });
}
