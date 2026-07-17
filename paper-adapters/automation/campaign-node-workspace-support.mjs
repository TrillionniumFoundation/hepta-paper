import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';
import { empiricalResultMaterializedPath } from '../../paper-domain/research/empirical-assertion-contract.mjs';
import {
  abortStagedScopedFileSync,
  commitStagedScopedFileSync,
  inspectScopedRegularFileSync,
  inspectScopedRegularFileWithRecoverySync,
  normalizeScopedRelativePath,
  stageScopedRegularFileCopySync,
} from '../runtime/scoped-file-materialization-repository.mjs';

function safePathSegment(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180) || 'unknown';
}

export function resolveCampaignWorkspace(sourceWorkspace) {
  return path.resolve(sourceWorkspace);
}

export function findCampaignManuscript(workspace) {
  for (const name of ['main.tex', 'paper.tex', 'manuscript.tex']) {
    if (fs.existsSync(path.join(workspace, name))) return name;
  }
  return 'main.tex';
}

export function findEmpiricalEntrypoint(workspace, language) {
  const candidates = {
    python: ['experiments/run.py', 'analysis.py', 'run.py'],
    node: ['experiments/run.mjs', 'analysis.mjs'],
    r: ['experiments/run.R', 'analysis.R'],
    julia: ['experiments/run.jl', 'analysis.jl'],
    lean: [null],
    latex: [findCampaignManuscript(workspace)],
  }[language] || [];
  return candidates.find((candidate) => candidate === null || fs.existsSync(path.join(workspace, candidate))) || candidates[0] || null;
}

export function readWorkspaceTextIfPresent(workspace, relative) {
  const candidate = path.join(workspace, relative);
  return fs.existsSync(candidate) ? fs.readFileSync(candidate, 'utf8') : '';
}

export function hashWorkspaceFile(workspace, relative) {
  return sha256FileSync(path.join(workspace, relative));
}

export function campaignAutomationOutputDirectory({ runtimeRoot, campaignId, nodeId, attemptId }) {
  return path.join(
    runtimeRoot,
    'automation-artifacts',
    safePathSegment(campaignId),
    safePathSegment(nodeId),
    safePathSegment(attemptId || 'direct'),
  );
}

export function materializeAutomationArtifacts({ result, outputDirectory, workspace, nodeId }) {
  const materialized = [];
  const destinationBase = path.posix.dirname(empiricalResultMaterializedPath(nodeId));
  for (const [index, artifact] of (result.artifacts || []).entries()) {
    const sourceRelative = normalizeScopedRelativePath(artifact.path);
    const source = inspectScopedRegularFileSync({ scopeRoot: outputDirectory, relative: sourceRelative });
    if (!source.exists) continue;
    const destinationRelative = `${destinationBase}/${sourceRelative}`;
    const destination = inspectScopedRegularFileWithRecoverySync({ scopeRoot: workspace, relative: destinationRelative });
    if (destination.hash === source.hash) {
      materialized.push(destinationRelative);
      continue;
    }
    const staged = stageScopedRegularFileCopySync({
      sourceRoot: outputDirectory,
      destinationRoot: workspace,
      relative: sourceRelative,
      destinationRelative,
      stageId: `campaign-artifact:${safePathSegment(nodeId)}:${result.multiLanguageEmpiricalReceiptHash || 'unreceipted'}:${index}:${source.hash}`,
      expectedHash: destination.hash,
    });
    try {
      commitStagedScopedFileSync(staged, {
        destinationRoot: workspace,
        expectedHash: destination.hash,
      });
    } catch (error) {
      abortStagedScopedFileSync(staged);
      throw error;
    }
    materialized.push(destinationRelative);
  }
  const payload = {
    version: 1,
    kind: 'AutomationArtifactMaterializationReceipt',
    nodeId,
    sourceExecutionReceiptHash: result.multiLanguageEmpiricalReceiptHash || null,
    materializedPaths: materialized,
    status: 'automation_artifacts_materialized',
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    automationArtifactMaterializationReceiptHash: hashRecord('AutomationArtifactMaterializationReceipt', payload),
  });
}

export function workspaceAttemptRelative({ campaignId, nodeId, attemptId }) {
  return [
    'campaign-attempt-workspaces',
    safePathSegment(campaignId),
    safePathSegment(nodeId),
    safePathSegment(attemptId),
  ].join('/');
}

export function workspaceAttemptPath(runtimeRoot, identity) {
  return path.resolve(runtimeRoot, ...workspaceAttemptRelative(identity).split('/'));
}
