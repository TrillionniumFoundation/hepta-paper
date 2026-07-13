import path from 'node:path';
import { assertFormalVerifierPort } from '../../paper-ports/formal-verifier-port.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { evaluateFormalClaimBindings } from '../../paper-domain/research/formal-claim-binding-policy.mjs';
import { analyzeLeanTypeContract, leanSourceDeclarationRecords } from './lean-source-contracts.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';

async function fileReceipt(root, relative) {
  const absolute = path.join(root, relative);
  const read = readScopedFileSync({ scopeRoot: root, candidate: absolute });
  if (read.status !== 'scoped_file_read_verified') throw new Error(read.blockers.join(','));
  return { path: relative, hash: hashBytes(read.content), bytes: read.bytes, scopedFileReadReceiptHash: read.scopedFileReadReceiptHash };
}

function declarationFromAudit(claim, execution, sourceDeclaration = null) {
  const stdout = String(execution?.stdout || '');
  const stderr = String(execution?.stderr || '');
  const line = stdout.split(/\r?\n/).find((item) => {
    const value = item.trim();
    return value === claim.theoremName || value.startsWith(`${claim.theoremName} `) || value.startsWith(`${claim.theoremName}:`);
  });
  const auditSignature = line ? line.trim().slice(claim.theoremName.length).replace(/^\s*:\s*/, '').trim() : '';
  const contract = sourceDeclaration || analyzeLeanTypeContract(auditSignature);
  const axiomLine = stdout.split(/\r?\n/).find((item) => /axioms?:/i.test(item)) || '';
  const bracket = /\[([^\]]*)\]/.exec(axiomLine);
  const axioms = bracket ? bracket[1].split(',').map((item) => item.trim()).filter(Boolean) : [];
  return {
    name: claim.theoremName,
    typeHash: contract.typeHash || null,
    normalizedType: contract.normalizedType || null,
    premises: contract.premises || [],
    conclusion: contract.conclusion || null,
    sourceStatementHash: sourceDeclaration?.statementHash || null,
    buildVerified: Boolean(execution?.ok && line),
    conditional: contract.conditional === true,
    conclusionAssumedAsPremise: contract.conclusionAssumedAsPremise === true,
    vacuous: contract.vacuous === true,
    verifiedObligations: sourceDeclaration ? [claim.theoremName] : [],
    axioms,
    hasSorry: /\bsorryAx\b|declaration uses 'sorry'/i.test(`${stdout}\n${stderr}`),
    hasAdmit: /\badmit\b/i.test(`${stdout}\n${stderr}`),
    auditReceiptHash: execution?.receiptHash || null,
  };
}

export function createLakeFormalVerifier({ projectRoot, commandRunner, executable = 'lake' } = {}) {
  return assertFormalVerifierPort({
    version: 2,
    kind: 'LakeFormalVerifierAdapter',
    verifierId: 'lean-lake-source-bound-certificate-v2',
    async verify({ expectedInputs = [], timeoutMs = 120000, claimBindings = [], declarationReports = [], allowedAxioms = [] } = {}) {
      const blockers = [];
      const required = ['lakefile.lean', 'lean-toolchain', 'lake-manifest.json'];
      const projectFiles = [];
      for (const relative of required) {
        try { projectFiles.push(await fileReceipt(projectRoot, relative)); }
        catch { blockers.push(`formal_project_file_missing:${relative}`); }
      }
      for (const expected of expectedInputs) {
        try {
          const actual = await fileReceipt(projectRoot, expected.path);
          if (actual.hash !== expected.hash) blockers.push(`formal_input_hash_mismatch:${expected.path}`);
          projectFiles.push(actual);
        } catch { blockers.push(`formal_input_missing:${expected.path}`); }
      }
      if (blockers.length) return { status: 'formal_verifier_blocked', blockers };
      const execution = await commandRunner.run({
        executable,
        args: ['build'],
        cwd: projectRoot,
        timeoutMs,
        outputPaths: ['.lake'],
        env: {
          ELAN_HOME: process.env.ELAN_HOME || `${process.env.HOME || ''}/.elan`,
          ELAN_TOOLCHAIN: process.env.ELAN_TOOLCHAIN || 'leanprover/lean4:v4.30.0',
        },
      });
      let effectiveDeclarations = declarationReports;
      if (execution.ok && claimBindings.length && !effectiveDeclarations.length) {
        effectiveDeclarations = [];
        for (const claim of claimBindings) {
          const auditFile = String(claim.auditFile || '');
          const auditBound = auditFile && projectFiles.some((file) => file.path === auditFile);
          const sourceFile = String(claim.sourceFile || '');
          const sourceBound = sourceFile && projectFiles.some((file) => file.path === sourceFile);
          let sourceDeclaration = null;
          if (sourceBound) {
            const sourceRead = readScopedFileSync({ scopeRoot: projectRoot, candidate: path.join(projectRoot, sourceFile) });
            if (sourceRead.status === 'scoped_file_read_verified') {
              sourceDeclaration = leanSourceDeclarationRecords(sourceRead.content.toString('utf8')).find((item) => item.name === claim.theoremName) || null;
            }
          }
          if (!auditBound || (sourceFile && !sourceBound) || (sourceFile && !sourceDeclaration)) {
            effectiveDeclarations.push({ name: claim.theoremName, typeHash: sourceDeclaration?.typeHash || null, sourceStatementHash: sourceDeclaration?.statementHash || null, buildVerified: false, conditional: sourceDeclaration?.conditional === true, conclusionAssumedAsPremise: sourceDeclaration?.conclusionAssumedAsPremise === true, axioms: [], auditReceiptHash: null });
            continue;
          }
          const audit = await commandRunner.run({ executable, args: ['env', 'lean', auditFile], cwd: projectRoot, timeoutMs, outputPaths: [], env: { ELAN_HOME: process.env.ELAN_HOME || `${process.env.HOME || ''}/.elan`, ELAN_TOOLCHAIN: process.env.ELAN_TOOLCHAIN || 'leanprover/lean4:v4.30.0' } });
          effectiveDeclarations.push(declarationFromAudit(claim, audit, sourceDeclaration));
        }
      }
      const claimBindingReport = execution.ok && claimBindings.length
        ? evaluateFormalClaimBindings({ claims: claimBindings, declarations: effectiveDeclarations, allowedAxioms })
        : null;
      const status = !execution.ok
        ? 'formal_certificate_blocked'
        : !claimBindingReport
          ? 'formal_build_verified'
          : claimBindingReport.status === 'formal_claim_binding_verified'
            ? 'formal_claim_verified'
            : 'formal_claim_binding_blocked';
      const bundle = {
        version: 1,
        kind: 'FormalCertificateBundle',
        verifierId: 'lean-lake-source-bound-certificate-v2',
        status,
        projectFiles: projectFiles.sort((a, b) => a.path.localeCompare(b.path)),
        toolchainHash: projectFiles.find((file) => file.path === 'lean-toolchain')?.hash || null,
        manifestHash: projectFiles.find((file) => file.path === 'lake-manifest.json')?.hash || null,
        executionReceiptHash: execution.receiptHash || null,
        isolation: execution.isolation || null,
        claimBindingReport,
        blockers: execution.ok ? (claimBindingReport?.blockers || []) : ['lake_build_failed', ...(execution.blockers || [])],
        externalActionPerformed: false,
      };
      return { ...bundle, certificateBundleHash: hashRecord('FormalCertificateBundle', bundle) };
    },
    async replay({ certificateBundle } = {}) {
      if (!['formal_build_verified', 'formal_claim_verified'].includes(certificateBundle?.status)) return { status: 'formal_certificate_replay_blocked', blockers: ['certificate_bundle_not_verified'] };
      const current = [];
      for (const expected of certificateBundle.projectFiles || []) {
        try { current.push(await fileReceipt(projectRoot, expected.path)); }
        catch { return { status: 'formal_certificate_replay_blocked', blockers: [`formal_input_missing:${expected.path}`] }; }
      }
      const mismatches = current.filter((actual) => certificateBundle.projectFiles.find((expected) => expected.path === actual.path)?.hash !== actual.hash);
      return { status: mismatches.length ? 'formal_certificate_replay_blocked' : certificateBundle.status === 'formal_claim_verified' ? 'formal_claim_replay_verified' : 'formal_build_replay_verified', blockers: mismatches.map((item) => `formal_input_hash_mismatch:${item.path}`) };
    },
  });
}
