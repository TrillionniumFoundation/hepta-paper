import fs from 'node:fs';
import path from 'node:path';
import {
  buildEvidenceBoundManuscriptIrDraft,
  EVIDENCE_BOUND_MANUSCRIPT_IR_DRAFT_PATH,
  EVIDENCE_BOUND_MANUSCRIPT_IR_PATH,
  finalizeEvidenceBoundManuscriptIr,
  verifyEvidenceBoundManuscriptIr,
} from '../../paper-domain/research/evidence-bound-manuscript-ir.mjs';
import {
  priorArtEvidenceHashes,
  verifyPriorArtEvidenceReceipt,
} from '../../paper-domain/research/prior-art-evidence-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import {
  inspectAutonomousManuscriptSubstantiveAgentProse,
} from '../../paper-domain/automation/trusted-autonomous-manuscript-render-contract.mjs';
import {
  buildEvidenceEntailmentSourceDocument,
} from '../../paper-domain/research/evidence-entailment-source-document.mjs';
import {
  evidenceEntailmentClaimClassesForEvidenceKind,
} from '../../paper-domain/research/evidence-entailment-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export { inspectAutonomousManuscriptSubstantiveAgentProse };

function binding(kind, hash) {
  return SHA256.test(String(hash || '')) ? Object.freeze({ kind, hash }) : null;
}

function uniqueBindings(values) {
  const seen = new Set();
  return Object.freeze(values.filter(Boolean).filter((value) => {
    const key = `${value.kind}:${value.hash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function proposalClaimHashes(proposal) {
  return (proposal?.claims || []).map((claim) => binding(
    'proposal_claim_record',
    hashRecord('AutonomousResearchClaimRecord', claim),
  ));
}

export function autonomousManuscriptAuthorityBindings({
  proposal,
  policyAuthorization,
  seedBundle,
  empiricalClaimLineage = null,
  empiricalAssertionAuthority = null,
  formalSupportAuthority = null,
  formalVerificationReceipt = null,
  priorArtReceipt = null,
} = {}) {
  return uniqueBindings([
    binding('proposal', proposal?.machineProposedScientificClaimSetHash),
    ...proposalClaimHashes(proposal),
    binding('policy_authorization', policyAuthorization?.autonomousResearchPolicyAuthorizationHash),
    binding('seed_bundle', seedBundle?.autonomousResearchSeedContractBundleHash),
    binding('empirical_claim_lineage', empiricalClaimLineage?.autonomousEmpiricalClaimLineageHash),
    binding('empirical_assertion_authority', empiricalAssertionAuthority?.empiricalAssertionAuthorityHash),
    ...(empiricalAssertionAuthority?.entries || []).flatMap((entry) => [
      binding('empirical_assertion_authority_entry', entry.empiricalAssertionAuthorityEntryHash),
      binding('empirical_manuscript_claim', entry.manuscriptClaimHash),
      binding('empirical_analysis_protocol', entry.analysisProtocolHash),
      binding('empirical_original_execution', entry.originalRunReceiptHash),
      binding('empirical_original_analysis', entry.originalAnalysisEvaluationHash),
      binding('empirical_original_artifact', entry.originalResultArtifactHash),
      binding('empirical_replay_execution', entry.replayRunReceiptHash),
      binding('empirical_replay_analysis', entry.replayAnalysisEvaluationHash),
      binding('empirical_replay_artifact', entry.replayResultArtifactHash),
    ]),
    binding('formal_support_authority',
      formalSupportAuthority?.autonomousFormalSupportSurfaceAuthorityHash),
    binding('formal_verification', formalVerificationReceipt?.campaignFormalVerificationReceiptHash),
    ...(formalVerificationReceipt?.formalReplayReceipts || [])
      .map((receipt) => binding('formal_kernel_replay', receipt?.formalReplayReceiptHash
        || receipt?.formalClaimReplayReceiptHash)),
    ...priorArtEvidenceHashes(priorArtReceipt).map((hash) => binding('prior_art', hash)),
  ]);
}

function sourceDocument({
  evidenceKind,
  evidenceHash = null,
  recordHashTag,
  recordHashField = null,
  record,
}) {
  if (!record) return null;
  return buildEvidenceEntailmentSourceDocument({
    evidenceKind,
    evidenceHash,
    recordHashTag,
    recordHashField,
    record,
  });
}

function priorArtSourceDocuments(priorArtReceipt) {
  if (!priorArtReceipt) return [];
  const receiptTag = priorArtReceipt.version === 2
    ? 'PriorArtEvidenceReceiptV2' : 'PriorArtEvidenceReceipt';
  const workTag = priorArtReceipt.version === 2
    ? 'PriorArtWorkRecordV2' : 'PriorArtWorkRecord';
  return [
    sourceDocument({
      evidenceKind: 'prior_art',
      recordHashTag: receiptTag,
      recordHashField: 'priorArtEvidenceReceiptHash',
      record: priorArtReceipt,
    }),
    ...(priorArtReceipt.works || []).map((work) => sourceDocument({
      evidenceKind: 'prior_art',
      recordHashTag: workTag,
      recordHashField: 'priorArtWorkRecordHash',
      record: work,
    })),
  ];
}

function formalReplayRecords(value, rows = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return rows;
  seen.add(value);
  if (value.kind === 'FormalCertificateReplayReceipt'
    && value.formalCertificateReplayReceiptHash) rows.push(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    formalReplayRecords(child, rows, seen);
  }
  return rows;
}

function formalVerificationSourceRecord(value) {
  if (!value) return null;
  const {
    workspaceAttemptIntegration: _workspaceAttemptIntegration,
    ...record
  } = value;
  return Object.freeze(record);
}

export function autonomousManuscriptEvidenceSourceDocuments({
  proposal,
  policyAuthorization,
  seedBundle,
  empiricalClaimLineage = null,
  empiricalAssertionAuthority = null,
  formalSupportAuthority = null,
  formalVerificationReceipt = null,
  priorArtReceipt = null,
} = {}) {
  const documents = [
    sourceDocument({
      evidenceKind: 'proposal',
      recordHashTag: 'MachineProposedScientificClaimSet',
      recordHashField: 'machineProposedScientificClaimSetHash',
      record: proposal,
    }),
    ...(proposal?.claims || []).map((claim) => sourceDocument({
      evidenceKind: 'proposal_claim_record',
      evidenceHash: hashRecord('AutonomousResearchClaimRecord', claim),
      recordHashTag: 'AutonomousResearchClaimRecord',
      record: claim,
    })),
    sourceDocument({
      evidenceKind: 'policy_authorization',
      recordHashTag: 'AutonomousResearchPolicyAuthorization',
      recordHashField: 'autonomousResearchPolicyAuthorizationHash',
      record: policyAuthorization,
    }),
    sourceDocument({
      evidenceKind: 'seed_bundle',
      recordHashTag: 'AutonomousResearchSeedContractBundle',
      recordHashField: 'autonomousResearchSeedContractBundleHash',
      record: seedBundle,
    }),
    sourceDocument({
      evidenceKind: 'empirical_claim_lineage',
      recordHashTag: 'AutonomousEmpiricalClaimLineage',
      recordHashField: 'autonomousEmpiricalClaimLineageHash',
      record: empiricalClaimLineage,
    }),
    sourceDocument({
      evidenceKind: 'empirical_assertion_authority',
      recordHashTag: 'EmpiricalAssertionAuthority',
      recordHashField: 'empiricalAssertionAuthorityHash',
      record: empiricalAssertionAuthority,
    }),
    ...(empiricalAssertionAuthority?.entries || []).map((entry) => sourceDocument({
      evidenceKind: 'empirical_assertion_authority_entry',
      recordHashTag: 'EmpiricalAssertionAuthorityEntry',
      recordHashField: 'empiricalAssertionAuthorityEntryHash',
      record: entry,
    })),
    sourceDocument({
      evidenceKind: 'formal_support_authority',
      recordHashTag: 'AutonomousFormalSupportSurfaceAuthority',
      recordHashField: 'autonomousFormalSupportSurfaceAuthorityHash',
      record: formalSupportAuthority,
    }),
    sourceDocument({
      evidenceKind: 'formal_verification',
      recordHashTag: 'CampaignFormalVerificationReceipt',
      recordHashField: 'campaignFormalVerificationReceiptHash',
      record: formalVerificationSourceRecord(formalVerificationReceipt),
    }),
    ...formalReplayRecords(formalVerificationReceipt).map((receipt) => sourceDocument({
      evidenceKind: 'formal_kernel_replay',
      recordHashTag: 'FormalCertificateReplayReceipt',
      recordHashField: 'formalCertificateReplayReceiptHash',
      record: receipt,
    })),
    ...priorArtSourceDocuments(priorArtReceipt),
  ].filter(Boolean);
  const unique = new Map(documents.map((document) => [
    `${document.evidenceKind}:${document.evidenceHash}`,
    document,
  ]));
  return Object.freeze([...unique.values()]);
}

export function autonomousManuscriptEvidenceRefBindings(input = {}) {
  const authorityBindings = autonomousManuscriptAuthorityBindings(input);
  const sourceDocuments = autonomousManuscriptEvidenceSourceDocuments(input);
  const sourceDocumentKeys = new Set(sourceDocuments.map((document) => (
    `${document.evidenceKind}:${document.evidenceHash}`
  )));
  return Object.freeze(authorityBindings.flatMap((authorityBinding) => {
    const claimClasses = evidenceEntailmentClaimClassesForEvidenceKind(
      authorityBinding.kind,
    );
    return sourceDocumentKeys.has(`${authorityBinding.kind}:${authorityBinding.hash}`)
      && claimClasses.length
      ? [Object.freeze({
        kind: authorityBinding.kind,
        hash: authorityBinding.hash,
        claimClasses,
      })]
      : [];
  }));
}

function defaultTitle(proposal) {
  const objective = String(proposal?.objective || '').replace(/\s+/g, ' ').trim();
  if (objective && objective.length <= 180) return objective;
  return `Evidence-bound autonomous study of ${proposal?.protocolFamily || 'a declared research protocol'}`;
}

function priorArtBlocks(priorArtReceipt) {
  const verification = verifyPriorArtEvidenceReceipt(priorArtReceipt);
  const declaredLimitations = priorArtReceipt.coverageLimitations.slice(0, 4).join(' ');
  if (verification.ready && priorArtReceipt.works.length) {
    const selected = priorArtReceipt.works.slice(0, 32);
    return [Object.freeze({
      type: 'citation',
      blockId: 'related-work-evidence',
      text: `The machine-readable prior-art snapshot identified the following directly relevant works. Coverage remains limited to the recorded queries, providers, and corpus snapshots. Declared retrieval limitations: ${declaredLimitations}`,
      workIds: Object.freeze(selected.map((work) => work.workId)),
      evidenceRefs: Object.freeze([
        priorArtReceipt.priorArtEvidenceReceiptHash,
        ...selected.map((work) => work.priorArtWorkRecordHash),
      ]),
    })];
  }
  return [Object.freeze({
    type: 'prose',
    blockId: 'related-work-limitation',
    claimClass: 'limitation',
    text: `No exhaustive prior-art or novelty conclusion is made. Related-work coverage is limited by the structured receipt. Declared retrieval limitations: ${declaredLimitations}`,
    evidenceRefs: Object.freeze([priorArtReceipt.priorArtEvidenceReceiptHash]),
  })];
}

export function buildDefaultAutonomousManuscriptIrDraft({
  proposal,
  policyAuthorization,
  seedBundle,
  priorArtReceipt,
} = {}) {
  const proposalHash = proposal?.machineProposedScientificClaimSetHash;
  const policyHash = policyAuthorization?.autonomousResearchPolicyAuthorizationHash;
  const seedHash = seedBundle?.autonomousResearchSeedContractBundleHash;
  if (![proposalHash, policyHash, seedHash, priorArtReceipt?.priorArtEvidenceReceiptHash]
    .every((hash) => SHA256.test(String(hash || '')))) {
    throw new Error('autonomous_manuscript_ir_seed_authority_invalid');
  }
  return buildEvidenceBoundManuscriptIrDraft({
    paperId: proposal.paperId,
    title: defaultTitle(proposal),
    sections: [
      {
        sectionId: 'abstract',
        heading: 'Abstract',
        blocks: [{
          type: 'prose', blockId: 'abstract-scope', claimClass: 'scope',
          text: `This study evaluates the declared objective within the ${proposal.protocolFamily} protocol. Scientific claims are restricted to hash-bound formal and empirical evidence.`,
          evidenceRefs: [proposalHash, policyHash],
        }],
      },
      {
        sectionId: 'related-work',
        heading: 'Related Work',
        blocks: priorArtBlocks(priorArtReceipt),
      },
      {
        sectionId: 'methods',
        heading: 'Methods and Preregistered Claims',
        blocks: [{
          type: 'prose', blockId: 'methods-authority', claimClass: 'method',
          text: 'The treatment, control, ablation, metrics, stopping rules, formal obligations, and replay requirements are fixed by the policy-authorized seed contracts before outcome promotion.',
          evidenceRefs: [seedHash, policyHash],
        }, {
          type: 'slot', blockId: 'empirical-claims-slot', slot: 'empirical_claims',
        }],
      },
      {
        sectionId: 'formal-assurance',
        heading: 'Formal Assurance',
        blocks: [{
          type: 'slot', blockId: 'formal-support-slot', slot: 'formal_support',
        }],
      },
      {
        sectionId: 'results',
        heading: 'Results',
        blocks: [{
          type: 'slot', blockId: 'empirical-results-slot', slot: 'empirical_results',
        }],
      },
      {
        sectionId: 'reproducibility',
        heading: 'Reproducibility and Evidence',
        blocks: [{
          type: 'prose', blockId: 'reproducibility-authority', claimClass: 'reproducibility',
          text: 'The release binds code, runtime, dataset authority, protocol, raw observations, recomputation, formal verification, and rendered manuscript surfaces by cryptographic hash.',
          evidenceRefs: [seedHash],
        }],
      },
      {
        sectionId: 'limitations',
        heading: 'Limitations',
        blocks: [{
          type: 'prose', blockId: 'open-world-limitations', claimClass: 'limitation',
          text: 'Successful execution does not prove exhaustive novelty, universal scientific truth, unrestricted theorem discovery, natural-language and Lean semantic identity, external validity, or venue acceptance.',
          evidenceRefs: [policyHash, priorArtReceipt.priorArtEvidenceReceiptHash],
        }],
      },
    ],
  });
}

function readJsonWithFileHash(root, relative, blocker) {
  const read = readScopedFileSync({ scopeRoot: root, candidate: path.join(root, relative) });
  if (read.status !== 'scoped_file_read_verified' || read.bytes > 8 * 1024 * 1024) {
    throw new Error(blocker);
  }
  try {
    return Object.freeze({
      document: JSON.parse(read.content.toString('utf8')),
      fileHash: hashBytes(read.content),
    });
  }
  catch { throw new Error(blocker); }
}

function readJson(root, relative, blocker) {
  return readJsonWithFileHash(root, relative, blocker).document;
}

export function finalizeAutonomousManuscriptIrInWorkspace({
  workspace,
  proposal,
  policyAuthorization,
  seedBundle,
  priorArtReceipt,
  empiricalClaimLineage = null,
  empiricalAssertionAuthority = null,
  formalSupportAuthority = null,
  formalVerificationReceipt = null,
  agentExecutionReceipt = null,
  agentExecutionReceipts = [],
  requireAgentAuthoredProse = false,
} = {}) {
  const root = fs.realpathSync(path.resolve(workspace || ''));
  const draftPath = path.resolve(root, EVIDENCE_BOUND_MANUSCRIPT_IR_DRAFT_PATH);
  const canonicalPath = path.resolve(root, EVIDENCE_BOUND_MANUSCRIPT_IR_PATH);
  if (!isPathWithin(root, draftPath) || !isPathWithin(root, canonicalPath)) {
    throw new Error('autonomous_manuscript_ir_path_invalid');
  }
  const defaultDraft = buildDefaultAutonomousManuscriptIrDraft({
    proposal, policyAuthorization, seedBundle, priorArtReceipt,
  });
  const draftSource = fs.existsSync(draftPath)
    ? readJsonWithFileHash(root, EVIDENCE_BOUND_MANUSCRIPT_IR_DRAFT_PATH,
      'autonomous_manuscript_ir_draft_invalid')
    : Object.freeze({ document: defaultDraft, fileHash: null });
  const draft = draftSource.document;
  const sourceDraftFileHash = draftSource.fileHash;
  const substantiveProseInspection = requireAgentAuthoredProse
    ? inspectAutonomousManuscriptSubstantiveAgentProse({
      draft,
      systemSeedDraft: defaultDraft,
    }) : null;
  if (requireAgentAuthoredProse && substantiveProseInspection.valid !== true) {
    throw new Error(`autonomous_manuscript_ir_substantive_agent_prose_required:${
      substantiveProseInspection.blockers.join(',')}`);
  }
  const authorityBindings = autonomousManuscriptAuthorityBindings({
    proposal,
    policyAuthorization,
    seedBundle,
    empiricalClaimLineage,
    empiricalAssertionAuthority,
    formalSupportAuthority,
    formalVerificationReceipt,
    priorArtReceipt,
  });
  const candidates = [...new Map([
    agentExecutionReceipt,
    ...(Array.isArray(agentExecutionReceipts) ? agentExecutionReceipts : []),
  ].filter((receipt) => receipt?.agentExecutionReceiptHash)
    .map((receipt) => [receipt.agentExecutionReceiptHash, receipt])).values()];
  let selectedAgentExecutionReceipt = null;
  let ir = null;
  for (const candidate of candidates) {
    const attempt = finalizeEvidenceBoundManuscriptIr({
      draft,
      authorityBindings,
      priorArtReceipt,
      agentExecutionReceipt: candidate,
      sourceDraftFileHash,
    });
    if (attempt.authorship?.agentModifiedDraft === true) {
      selectedAgentExecutionReceipt = candidate;
      ir = attempt;
      break;
    }
  }
  if (!ir) {
    if (requireAgentAuthoredProse) {
      throw new Error('autonomous_manuscript_ir_agent_authorship_required');
    }
    if (JSON.stringify(draft) !== JSON.stringify(defaultDraft)) {
      throw new Error('autonomous_manuscript_ir_agent_receipt_required');
    }
    ir = finalizeEvidenceBoundManuscriptIr({
      draft,
      authorityBindings,
      priorArtReceipt,
      sourceDraftFileHash,
    });
  }
  if (ir.status !== 'evidence_bound_manuscript_ir_verified') {
    throw new Error(`autonomous_manuscript_ir_finalize_blocked:${ir.blockers.join(',')}`);
  }
  const verification = verifyEvidenceBoundManuscriptIr(ir, {
    paperId: proposal.paperId,
    authorityBindings,
    priorArtReceipt,
    agentExecutionReceipt: selectedAgentExecutionReceipt,
    sourceDraftFileHash,
    requireAgentAuthoredProse,
  });
  if (!verification.valid) {
    throw new Error(`autonomous_manuscript_ir_authorship_blocked:${verification.blockers.join(',')}`);
  }
  writeDurableJsonSync(canonicalPath, ir);
  if (!fs.existsSync(draftPath)) writeDurableJsonSync(draftPath, draft);
  return Object.freeze({
    ir,
    irPath: EVIDENCE_BOUND_MANUSCRIPT_IR_PATH,
    authorityBindings,
    agentExecutionReceipt: selectedAgentExecutionReceipt,
    agentDraft: draft,
    systemSeedDraft: defaultDraft,
    sourceDraftFileHash,
    substantiveProseInspection,
  });
}

export function readAutonomousManuscriptIr({ workspace } = {}) {
  const root = fs.realpathSync(path.resolve(workspace || ''));
  return readJson(root, EVIDENCE_BOUND_MANUSCRIPT_IR_PATH,
    'autonomous_manuscript_ir_canonical_invalid');
}
