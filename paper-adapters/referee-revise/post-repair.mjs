import path from 'node:path';
export {
  evidenceResyncConsumingSelection,
  evidenceResyncDecisionPlan,
  postApplyFinalGateConsumingSelection,
  postApplyFinalGateDecisionPlan,
  readyMergeBoundaryConsumingSelection,
  readyMergeBoundaryDecisionPlan,
  refereeRevisionRequestConsumingSelection,
  refereeRevisionRequestDecisionPlan,
} from './decision-routing.mjs';
import {
  fileRecord,
  pathWithin,
  relativePath,
} from '../../paper-core/src/runtime/file-utils.mjs';
import { normalizeText, uniqueStrings } from '../../paper-core/src/runtime/text-utils.mjs';
import { writeJsonFile } from '../artifacts/write-artifact.mjs';
import {
  buildRefereeRevisionDryRunReceipt,
  buildRefereeRevisionIssueQueue,
  buildRefereeRevisionPatchPlan,
  buildRefereeRevisionPatchExecutionPreflight,
  buildRefereeRevisionPreimageSnapshotLedger,
  buildRefereeRevisionExecutePlan,
  buildRefereeRevisionApplyModeContract,
  buildRefereeRevisionExecuteDesignPacket,
  buildRefereeRevisionRollbackLedgerDraft,
} from '../../paper-core/src/contracts/referee-planning.mjs';
import {
  buildRefereeApplyApprovalPacket,
  buildRefereePatchApplyExecution,
  buildRefereePatchApplyInvocation,
  buildRefereeAppliedPatchReceipt,
} from '../../paper-core/src/contracts/referee-application.mjs';
import {
  buildPostRepairBuildPackage,
  buildRefereeIssueResolutionProof,
  buildRepairReconciliation,
  buildRepairStateMutationReceipt,
} from '../../paper-core/src/contracts/referee-closure.mjs';
import { hashPaperRecord } from '../../paper-core/src/paper-contract-primitives.mjs';
import { heptaStorePath } from '../../paper-core/src/hepta-store.mjs';
import {
  runLatexBuildAdapter,
  runPackageAdapter,
} from '../build-package/index.mjs';
import { runResearchVerifyAdapter } from '../research-verify/index.mjs';
import {
  escapeSqlText,
  normalizePatch,
  normalizeRequest,
  sqliteExec,
  sqliteJson,
  sqlJson,
  sqlText,
} from '../referee-store.mjs';

import {
  buildAgentRepairPatchBundle,
  issueIsOpen,
  stderrLines,
  validateAndMaybeApplyPatches,
} from './repair-executor.mjs';
function withRecordHash(kind, record, fieldName) {
  const value = { ...record };
  value[fieldName] = hashPaperRecord(kind, value);
  return value;
}

function repairMainTexRow(row, agentRepairPatchBundle) {
  const targetPath = normalizeText(agentRepairPatchBundle?.targetPath || '');
  if (!targetPath || !targetPath.endsWith('.tex')) return row;
  return {
    ...row,
    task: {
      ...row.task,
      mainTex: targetPath,
    },
  };
}

async function runPostRepairRechecks({
  root,
  runtimeRoot,
  row,
  store,
  agentRepairPatchBundle = null,
  appliedPatchReceipt = null,
  execute = false,
} = {}) {
  const blockers = [];
  const warnings = [];
  if (!execute) blockers.push('post_repair_recheck_execute_required');
  if (appliedPatchReceipt?.status !== 'applied_patch_receipt_recorded') {
    blockers.push('applied_patch_receipt_not_recorded');
  }
  if (!runtimeRoot) blockers.push('runtime_root_required_for_post_repair_rechecks');
  if (blockers.length) {
    return {
      kind: 'PostRepairRecheckReport',
      paperId: row.task.paperId,
      status: 'post_repair_recheck_blocked',
      buildRecheck: null,
      packageRecheck: null,
      researchRecheck: null,
      blockers: uniqueStrings(blockers, 32),
      warnings,
    };
  }

  const recheckRow = repairMainTexRow(row, agentRepairPatchBundle);
  const buildResult = await runLatexBuildAdapter({
    root,
    row: recheckRow,
    runtimeRoot,
    execute: true,
  });
  const buildBlockers = [
    ...(buildResult.blockers || []),
    ...((buildResult.status === 'build_passed') ? [] : ['latex_build_recheck_not_passed']),
    ...(buildResult.buildArtifactAcceptance?.accepted ? [] : ['build_artifact_acceptance_missing']),
  ];
  const buildRecheck = withRecordHash('PostRepairBuildRecheck', {
    kind: 'PostRepairBuildRecheck',
    paperId: row.task.paperId,
    status: buildBlockers.length ? 'build_recheck_blocked' : 'build_recheck_passed',
    mainTex: recheckRow.task.mainTex,
    buildResultStatus: buildResult.status,
    builtPdf: buildResult.builtPdf || null,
    buildArtifactAcceptanceHash: buildResult.buildArtifactAcceptance?.paperBuildArtifactAcceptanceHash || null,
    blockers: uniqueStrings(buildBlockers, 32),
    warnings: uniqueStrings(buildResult.warnings || [], 32),
    safety: {
      sourceMutation: false,
      outputUnderRuntime: true,
      externalActionPerformed: false,
    },
  }, 'buildRecheckHash');

  let packageResult = null;
  let packageRecheck = null;
  if (buildRecheck.status === 'build_recheck_passed') {
    packageResult = await runPackageAdapter({
      root,
      row: recheckRow,
      buildResult,
      runtimeRoot,
      execute: true,
      store,
    });
    const packageBlockers = [
      ...(packageResult.blockers || []),
      ...((packageResult.status === 'package_ready') ? [] : ['package_rewrite_not_ready']),
      ...(packageResult.artifactPackage?.submitReady ? [] : ['artifact_package_not_submit_ready_after_repair']),
    ];
    packageRecheck = withRecordHash('PostRepairPackageRecheck', {
      kind: 'PostRepairPackageRecheck',
      paperId: row.task.paperId,
      status: packageBlockers.length ? 'package_rewrite_blocked' : 'package_rewrite_ready',
      packageDir: packageResult.packageDir || null,
      sourceZip: packageResult.sourceZip || null,
      packageRecord: packageResult.packageRecord || null,
      sha256Sums: packageResult.sha256Sums || null,
      artifactPackageHash: packageResult.artifactPackage?.artifactPackageHash || null,
      blockers: uniqueStrings(packageBlockers, 32),
      warnings: uniqueStrings(packageResult.warnings || [], 32),
      safety: {
        sourceMutation: false,
        writesPackage: packageBlockers.length === 0,
        outputUnderRuntime: true,
        externalActionPerformed: false,
      },
    }, 'packageRecheckHash');
  } else {
    packageRecheck = withRecordHash('PostRepairPackageRecheck', {
      kind: 'PostRepairPackageRecheck',
      paperId: row.task.paperId,
      status: 'package_rewrite_blocked',
      packageDir: null,
      blockers: ['build_recheck_not_passed'],
      warnings: [],
      safety: {
        sourceMutation: false,
        writesPackage: false,
        outputUnderRuntime: true,
        externalActionPerformed: false,
      },
    }, 'packageRecheckHash');
  }

  const researchReport = await runResearchVerifyAdapter({ root, row: recheckRow, runtimeRoot });
  const researchBlockers = [
    ...(researchReport.blockers || []),
    ...((researchReport.status === 'blocked') ? ['research_verify_recheck_blocked'] : []),
  ];
  const researchRecheck = withRecordHash('PostRepairResearchRecheck', {
    kind: 'PostRepairResearchRecheck',
    paperId: row.task.paperId,
    status: researchBlockers.length ? 'research_recheck_blocked' : 'research_recheck_passed',
    researchReportHash: researchReport.researchReportHash || null,
    researchStatus: researchReport.status,
    claimCount: researchReport.claimCount,
    proofObligationCount: researchReport.proofObligationCount,
    evidenceItemCount: researchReport.evidenceItemCount,
    reproducibilityItemCount: researchReport.reproducibilityItemCount,
    blockers: uniqueStrings(researchBlockers, 32),
    warnings: uniqueStrings(researchReport.warnings || [], 32),
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
    },
  }, 'researchRecheckHash');

  const report = withRecordHash('PostRepairRecheckReport', {
    kind: 'PostRepairRecheckReport',
    paperId: row.task.paperId,
    status: [
      buildRecheck.status,
      packageRecheck.status,
      researchRecheck.status,
    ].every((status) => ['build_recheck_passed', 'package_rewrite_ready', 'research_recheck_passed'].includes(status))
      ? 'post_repair_rechecks_passed'
      : 'post_repair_rechecks_blocked',
    mainTex: recheckRow.task.mainTex,
    buildRecheck,
    packageRecheck,
    researchRecheck,
    blockers: uniqueStrings([
      ...(buildRecheck.blockers || []),
      ...(packageRecheck.blockers || []),
      ...(researchRecheck.blockers || []),
    ], 64),
    warnings: uniqueStrings([
      ...warnings,
      ...(buildRecheck.warnings || []),
      ...(packageRecheck.warnings || []),
      ...(researchRecheck.warnings || []),
    ], 64),
    safety: {
      sourceMutation: false,
      outputUnderRuntime: true,
      externalActionPerformed: false,
      writesPackage: packageRecheck.status === 'package_rewrite_ready',
    },
  }, 'postRepairRecheckReportHash');
  const recheckPath = path.join(runtimeRoot, 'referee-repair', row.task.paperId, 'POST_REPAIR_RECHECKS.json');
  await writeJsonFile(recheckPath, report);
  return report;
}


export { withRecordHash, repairMainTexRow, runPostRepairRechecks };
