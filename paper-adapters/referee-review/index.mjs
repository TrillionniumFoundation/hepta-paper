import path from 'node:path';
import {
  ensureDir,
  fileRecord,
  pathWithin,
  readTextIfExists,
  relativePath,
  sha256Text,
} from '../../workflow-kernel/runtime/file-utils.mjs';
import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { writeJsonFile } from '../artifacts/write-artifact.mjs';
import {
  buildAgentRefereeReviewReport,
  buildRefereeIssueQueueMaterialization,
  buildRefereeReviewIntake,
} from '../../paper-domain/contracts/referee-planning.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { heptaStorePath } from '../../paper-adapters/persistence/store-paths.mjs';
import {
  sqliteExec,
  sqliteJson,
  sqlJson,
  sqlText,
} from '../referee-store.mjs';

function stderrLines(value, limit = 8) {
  return String(value || '')
    .split('\n')
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .slice(0, limit);
}

function sourceLineFor(text, patterns = []) {
  const lines = String(text || '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (patterns.some((pattern) => pattern.test(line))) {
      return index + 1;
    }
  }
  return 1;
}

function hasAny(text, patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function hasAgentRepairNotes(text) {
  return hasAny(text, [
    /HEPTA_REFEREE_REPAIR_AGENT_NOTES_BEGIN/i,
    /Agent Referee Repair Notes/i,
  ]);
}

function hasClaimEvidenceBoundaryRepair(text) {
  return hasAgentRepairNotes(text) && hasAny(text, [
    /claim-boundary repair/i,
    /claim boundaries/i,
    /evidence-bounded response/i,
    /does not introduce new empirical claims, theorem claims, or venue-submission readiness/i,
    /claims without a recorded certificate are treated as assumptions, limitations, or repair targets/i,
  ]);
}

function hasProofObligationBoundaryRepair(text) {
  return hasAgentRepairNotes(text) && hasAny(text, [
    /Proof and claim-boundary repair/i,
    /proof obligations/i,
    /theorem-level, proof-sketch, or certificate-dependent language remains conditional/i,
    /proof-sketch.*conditional/i,
    /proof.*verification/i,
  ]);
}

function hasReproducibilityScopeRepair(text) {
  return hasAgentRepairNotes(text) && hasAny(text, [
    /reproducibility note/i,
    /reproducibility contract/i,
    /local reproducibility/i,
    /local package artifacts/i,
    /package rewrite/i,
    /research\/evidence recheck/i,
    /research verify recheck/i,
    /post-repair verification/i,
  ]);
}

function requestKey(paperId, category) {
  const digest = sha256Text(`${paperId}:${category}`).replace(/^sha256:/, '').slice(0, 12);
  return `hepta_agent_review:${category}:${digest}`;
}

function finding({
  paperId,
  category,
  severity = 'medium',
  riskClass,
  objection,
  sourceLocator,
  evidenceLocator = '',
  proposedFix,
  evidenceNeeded,
  verification,
  patchScope = 'single_main_tex_repair',
}) {
  const key = requestKey(paperId, category);
  return {
    id: key,
    requestKey: key,
    status: 'requested',
    severity,
    riskClass,
    objection,
    sourceLocator,
    evidenceLocator,
    proposedFix,
    evidenceNeeded,
    verification,
    patchScope,
  };
}

function agentReviewFindings({ row, mainTexRel, mainTexText }) {
  const text = String(mainTexText || '');
  const lower = text.toLowerCase();
  const paperId = row.task.paperId;
  const findings = [];
  const locator = (line) => `${mainTexRel}:${Math.max(1, Number(line) || 1)}`;
  const hasClaimLanguage = hasAny(text, [
    /\bwe\s+(show|prove|establish|demonstrate|derive|guarantee)\b/i,
    /\b(theorem|lemma|proposition|corollary|claim)\b/i,
    /\b(convergence|optimal|robust|bound|guarantee)\b/i,
  ]);
  const hasEvidenceRefs = (row.task.evidenceRefs || []).length > 1;
  const claimLine = sourceLineFor(text, [
    /\bwe\s+(show|prove|establish|demonstrate|derive|guarantee)\b/i,
    /\b(theorem|lemma|proposition|corollary|claim)\b/i,
    /\b(convergence|optimal|robust|bound|guarantee)\b/i,
  ]);
  if ((hasClaimLanguage || !hasEvidenceRefs) && !hasClaimEvidenceBoundaryRepair(text)) {
    findings.push(finding({
      paperId,
      category: 'claim_evidence_boundary',
      severity: 'high',
      riskClass: 'claim_evidence_boundary',
      objection: 'Main-text contribution or guarantee language needs an explicit local evidence boundary before reviewed submission.',
      sourceLocator: locator(claimLine),
      evidenceLocator: (row.task.evidenceRefs || [])[0]?.path || '',
      proposedFix: 'Add an agent referee repair note that narrows unsupported claims to verified artifacts, local assumptions, or follow-up obligations.',
      evidenceNeeded: 'Post-repair research verify report and claim/evidence mapping.',
      verification: 'Run referee-revise, research verify recheck, and issue-resolution proof mapping before submission readiness.',
    }));
  }

  const hasProofLanguage = hasAny(text, [/\b(theorem|lemma|proposition|corollary)\b/i]);
  const hasProofBlock = hasAny(text, [/\\begin\{proof\}/i, /\bproof\b/i]);
  if ((hasProofLanguage || !hasProofBlock) && !hasProofObligationBoundaryRepair(text)) {
    findings.push(finding({
      paperId,
      category: 'proof_obligation_boundary',
      severity: hasProofLanguage ? 'high' : 'medium',
      riskClass: 'proof_obligation_boundary',
      objection: 'Proof-level statements require explicit proof-obligation handling and must not be treated as accepted without a checked local artifact.',
      sourceLocator: locator(sourceLineFor(text, [/\b(theorem|lemma|proposition|corollary|proof)\b/i])),
      evidenceLocator: '',
      proposedFix: 'Record theorem or proof-sketch language as checked, assumed, limited, or pending in the repair note and preserve the corresponding verification obligation.',
      evidenceNeeded: 'Proof obligation contract or explicit limitation text in the repaired manuscript.',
      verification: 'Post-repair build and research recheck must preserve proof-obligation status.',
    }));
  }

  const experimentLike = hasAny(text, [/\b(experiment|simulation|empirical|dataset|baseline|ablation|result)\b/i]);
  const reproducible = hasAny(text, [/\b(seed|hyperparameter|repository|code|data availability|reproducib)\b/i]);
  if ((experimentLike || !reproducible) && !hasReproducibilityScopeRepair(text)) {
    findings.push(finding({
      paperId,
      category: 'reproducibility_scope',
      severity: experimentLike ? 'medium' : 'low',
      riskClass: 'reproducibility_scope',
      objection: 'Experimental or artifact-dependent claims need a reproducibility boundary tied to local package artifacts.',
      sourceLocator: locator(sourceLineFor(text, [/\b(experiment|simulation|empirical|dataset|baseline|ablation|result|reproducib)\b/i])),
      evidenceLocator: '',
      proposedFix: 'Add a local reproducibility note describing which artifacts are available and which claims remain protocol-dependent.',
      evidenceNeeded: 'Reproducibility contract and package checksum recheck.',
      verification: 'Package rewrite and research verify recheck must remain clean after repair.',
    }));
  }

  if (!/\\section\*?\{limitations?\}/i.test(text) && !lower.includes('limitation')) {
    findings.push(finding({
      paperId,
      category: 'limitations_section_boundary',
      severity: 'medium',
      riskClass: 'limitations_section_boundary',
      objection: 'A reviewed submission candidate should carry an explicit limitations or claim-boundary section before final handoff.',
      sourceLocator: locator(sourceLineFor(text, [/\\section\*?\{(conclusion|discussion|experiments?|method|introduction)\}/i])),
      evidenceLocator: '',
      proposedFix: 'Add an agent referee repair note or limitations paragraph that prevents overclaiming beyond local evidence.',
      evidenceNeeded: 'Repaired source and build recheck.',
      verification: 'Post-repair PDF build must include the limitations or repair-note boundary.',
    }));
  }

  return findings.slice(0, 4);
}

async function materializeFindings({
  dbPath,
  store = null,
  row,
  reviewReport,
  runtimeRoot,
} = {}) {
  const materializedIssueRows = [];
  const existingIssueRows = [];
  const errors = [];
  const warnings = [];
  const findings = reviewReport?.findings || [];
  if (!findings.length) return { materializedIssueRows, existingIssueRows, errors, warnings };
  const reportPath = runtimeRoot
    ? relativePath(path.dirname(dbPath), path.join(runtimeRoot, 'referee-review', row.task.paperId, 'AGENT_REFEREE_REVIEW_REPORT.json'))
    : '';
  const statements = ['begin immediate;'];
  for (const item of findings) {
    const existing = sqliteJson(
      store,
      [
        'select request_id,request_key,status from referee_revision_requests',
        `where slug=${sqlText(row.task.paperId)}`,
        `and request_key=${sqlText(item.requestKey)}`,
        'limit 1;',
      ].join(' '),
    )[0] || null;
    if (existing) {
      existingIssueRows.push({
        requestId: existing.request_id,
        requestKey: existing.request_key,
        status: existing.status,
        action: 'already_present',
      });
      continue;
    }
    const metadata = {
      source: 'hepta_agent_referee_review',
      reviewerId: reviewReport.reviewerId,
      severity: item.severity,
      reviewReportHash: reviewReport.agentRefereeReviewReportHash,
      materializedAt: new Date().toISOString(),
      findingId: item.id,
    };
    statements.push([
      'insert into referee_revision_requests',
      '(',
      'slug,request_key,matrix_rank,status,risk_class,objection,source_locator,',
      'evidence_locator,proposed_fix,evidence_needed,verification,patch_scope,',
      'source_report_path,assignee,state_reason,metadata_json,last_transition_at',
      ') values (',
      [
        sqlText(row.task.paperId),
        sqlText(item.requestKey),
        '0',
        sqlText('requested'),
        sqlText(item.riskClass),
        sqlText(item.objection),
        sqlText(item.sourceLocator || ''),
        sqlText(item.evidenceLocator || ''),
        sqlText(item.proposedFix),
        sqlText(item.evidenceNeeded || ''),
        sqlText(item.verification),
        sqlText(item.patchScope || 'single_main_tex_repair'),
        sqlText(reportPath),
        sqlText('openclaw-agent'),
        sqlText('materialized_by_agent_referee_review'),
        sqlJson(metadata),
        'datetime(\'now\')',
      ].join(','),
      ');',
    ].join(' '));
    materializedIssueRows.push({
      requestId: null,
      requestKey: item.requestKey,
      status: 'requested',
      action: 'inserted',
    });
  }
  statements.push('commit;');
  if (materializedIssueRows.length) {
    const result = sqliteExec(store, statements.join('\n'));
    if (!result.ok) {
      errors.push(...stderrLines(result.stderr, 8));
      materializedIssueRows.length = 0;
    } else {
      for (const rowItem of materializedIssueRows) {
        const refreshed = sqliteJson(
          store,
          [
            'select request_id,status from referee_revision_requests',
            `where slug=${sqlText(row.task.paperId)}`,
            `and request_key=${sqlText(rowItem.requestKey)}`,
            'limit 1;',
          ].join(' '),
        )[0] || null;
        if (refreshed) {
          rowItem.requestId = refreshed.request_id;
          rowItem.status = refreshed.status;
        }
      }
    }
  } else {
    warnings.push('agent_referee_review_findings_already_materialized');
  }
  return { materializedIssueRows, existingIssueRows, errors, warnings };
}

export async function runRefereeReviewAdapter({
  root,
  runtimeRoot = null,
  row,
  execute = false,
  reviewerId = 'openclaw-agent-referee-reviewer',
  reviewScope = 'agent_referee_review',
  store = null,
} = {}) {
  if (!store) throw new Error('Referee review requires StorePort injection');
  const dbPath = heptaStorePath(root, runtimeRoot);
  const mainTexRel = normalizeText(row.task.mainTex || '');
  const mainTexAbs = mainTexRel ? path.join(root, mainTexRel) : null;
  const blockers = [];
  if (!mainTexRel) blockers.push('main_tex_required_for_agent_referee_review');
  if (mainTexAbs && !pathWithin(root, mainTexAbs)) blockers.push('main_tex_outside_repo_root');
  const mainTexText = mainTexAbs && !blockers.length ? await readTextIfExists(mainTexAbs) : null;
  if (mainTexRel && mainTexText === null) blockers.push('main_tex_not_readable_for_agent_referee_review');
  const sourceRecord = mainTexAbs && mainTexText !== null ? await fileRecord(root, mainTexAbs, 'referee_review_main_tex') : null;
  const intake = buildRefereeReviewIntake({
    paperTask: row.task,
    sourceRecord,
    evidenceRefs: row.task.evidenceRefs || [],
    reviewScope,
  });
  const findings = blockers.length || intake.status !== 'referee_review_intake_ready'
    ? []
    : agentReviewFindings({ row, mainTexRel, mainTexText });
  const reviewReport = buildAgentRefereeReviewReport({
    paperTask: row.task,
    intake,
    findings,
    reviewerId,
  });
  let materializationInputs = {
    materializedIssueRows: [],
    existingIssueRows: [],
    errors: [],
    warnings: [],
  };
  if (execute && reviewReport.status === 'agent_referee_review_ready') {
    materializationInputs = await materializeFindings({
      dbPath,
      store,
      row,
      reviewReport,
      runtimeRoot,
    });
  }
  const materialization = buildRefereeIssueQueueMaterialization({
    paperTask: row.task,
    reviewReport,
    execute: Boolean(execute),
    sqliteWritePerformed: materializationInputs.materializedIssueRows.length > 0,
    ...materializationInputs,
    blockers,
  });
  if (runtimeRoot && execute) {
    const reviewDir = path.join(runtimeRoot, 'referee-review', row.task.paperId);
    await ensureDir(reviewDir);
    await writeJsonFile(path.join(reviewDir, 'REFEREE_REVIEW_INTAKE.json'), intake);
    await writeJsonFile(path.join(reviewDir, 'AGENT_REFEREE_REVIEW_REPORT.json'), reviewReport);
    await writeJsonFile(path.join(reviewDir, 'REFEREE_ISSUE_QUEUE_MATERIALIZATION.json'), materialization);
  }
  const report = {
    version: 1,
    kind: 'RefereeReviewAdapterReport',
    paperId: row.task.paperId,
    taskKey: row.task.taskKey,
    status: materialization.status,
    findingCount: reviewReport.findingCount,
    materializedIssueCount: materialization.materializedIssueRows.length,
    existingIssueCount: materialization.existingIssueRows.length,
    intake,
    reviewReport,
    materialization,
    blockers: uniqueStrings([...(blockers || []), ...(materialization.blockers || [])], 32),
    warnings: uniqueStrings(materialization.warnings || [], 32),
    source: {
      sqlite: 'hepta-paper-workspace/runtime/hepta-paper.sqlite',
      table: 'referee_revision_requests',
      runtimeDir: runtimeRoot ? relativePath(root, path.join(runtimeRoot, 'referee-review', row.task.paperId)) : null,
    },
    safety: {
      deterministicLocalReview: true,
      modelCallPerformed: false,
      sourceMutation: false,
      sqliteWrites: Boolean(materialization.safety?.writesSqlite),
      externalActionPerformed: false,
      importsOldControlPlane: false,
    },
  };
  return {
    ...report,
    refereeReviewAdapterReportHash: hashPaperRecord('RefereeReviewAdapterReport', report),
  };
}
