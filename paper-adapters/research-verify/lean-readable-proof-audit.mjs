import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_'.]*(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/;
const AUDIT_KEYS = Object.freeze([
  'axiomAuditPresent', 'axioms', 'claimId', 'executionReceiptHash', 'kind',
  'leanProofPrintAuditHash', 'machineExtractionScope', 'printedIdentifiers',
  'proofPrintText', 'proofPrintTextHash', 'sourceFile', 'sourceFileHash',
  'sourceStatementHash', 'status', 'theoremName', 'theoremTypeHash',
  'usedDeclarationCandidates', 'version',
]);
const KEYWORDS = new Set([
  'abbrev', 'and', 'as', 'at', 'by', 'class', 'def', 'deriving', 'do', 'else',
  'end', 'example', 'exists', 'false', 'for', 'forall', 'from', 'fun', 'have',
  'if', 'import', 'in', 'inductive', 'instance', 'let', 'match', 'namespace',
  'open', 'private', 'protected', 'return', 'show', 'some', 'structure', 'then',
  'theorem', 'true', 'universe', 'variable', 'where', 'with',
]);

function marker(kind, theoremName) {
  return `HEPTA_READABLE_PROOF_${kind}:${theoremName}`;
}

export function readableProofAuditDirectives(theoremNames = []) {
  return [...new Set(theoremNames.map(String))].sort().flatMap((theoremName) => {
    if (!SAFE_NAME.test(theoremName)) throw new Error('readable_proof_theorem_name_invalid');
    return [
      `#eval IO.println "${marker('BEGIN', theoremName)}"`,
      `set_option pp.explicit true in #print ${theoremName}`,
      `#eval IO.println "${marker('END', theoremName)}"`,
    ];
  }).join('\n');
}

function proofPrintFor(stdout, theoremName) {
  const lines = String(stdout || '').replace(/\r\n/g, '\n').split('\n');
  const begin = lines.findIndex((line) => line.includes(marker('BEGIN', theoremName)));
  if (begin < 0) return null;
  const relativeEnd = lines.slice(begin + 1)
    .findIndex((line) => line.includes(marker('END', theoremName)));
  if (relativeEnd < 0) return null;
  const value = lines.slice(begin + 1, begin + 1 + relativeEnd).join('\n').trim();
  return value && value.includes(theoremName) ? value : null;
}

function identifiers(value) {
  return [...new Set(String(value || '').match(/[A-Za-z_][A-Za-z0-9_'.]*/g) || [])]
    .filter((item) => !KEYWORDS.has(item.toLowerCase()))
    .sort();
}

function declarationCandidates(values, theoremName) {
  return values.filter((value) => value !== theoremName && (
    value.includes('.') || /^[A-Z]/.test(value)
    || ['congrArg', 'Eq', 'False', 'True', 'rfl'].includes(value)
  ));
}

function sourceHashFor(projectFiles, sourceFile) {
  const matches = (projectFiles || []).filter((file) => (
    (file.projectPath ?? file.path) === sourceFile
  ));
  return matches.length === 1 ? matches[0].hash : null;
}

export function extractLeanReadableProofAudits({
  stdout,
  claimBindings = [],
  declarations = [],
  projectFiles = [],
  executionReceiptHash = null,
} = {}) {
  const declarationByName = new Map((declarations || []).map((item) => [item.name, item]));
  return Object.freeze((claimBindings || []).map((binding) => {
    const theoremName = String(binding?.theoremName || '');
    const proofPrintText = proofPrintFor(stdout, theoremName);
    const declaration = declarationByName.get(theoremName) || null;
    const sourceFile = String(binding?.sourceFile || '');
    const sourceFileHash = sourceHashFor(projectFiles, sourceFile);
    const printedIdentifiers = proofPrintText ? identifiers(proofPrintText) : [];
    const blockers = [
      ...(!proofPrintText ? ['lean_proof_print_output_missing'] : []),
      ...(!declaration?.buildVerified ? ['lean_proof_declaration_not_kernel_verified'] : []),
      ...(!declaration?.axiomAuditPresent ? ['lean_proof_axiom_audit_missing'] : []),
      ...(!sourceFileHash ? ['lean_proof_source_file_hash_missing'] : []),
      ...(!SHA256.test(String(executionReceiptHash || ''))
        ? ['lean_proof_execution_receipt_hash_missing'] : []),
    ];
    const payload = {
      version: 1,
      kind: 'LeanReadableProofPrintAudit',
      status: blockers.length
        ? 'lean_readable_proof_print_blocked'
        : 'lean_readable_proof_print_verified',
      claimId: String(binding?.claimId || ''),
      theoremName,
      theoremTypeHash: declaration?.typeHash || null,
      sourceFile,
      sourceFileHash,
      sourceStatementHash: declaration?.sourceStatementHash || null,
      proofPrintText,
      proofPrintTextHash: proofPrintText
        ? hashBytes(Buffer.from(proofPrintText, 'utf8')) : null,
      printedIdentifiers: Object.freeze(printedIdentifiers),
      usedDeclarationCandidates: Object.freeze(
        declarationCandidates(printedIdentifiers, theoremName),
      ),
      axioms: Object.freeze([...(declaration?.axioms || [])].sort()),
      axiomAuditPresent: declaration?.axiomAuditPresent === true,
      executionReceiptHash: executionReceiptHash || null,
      machineExtractionScope:
        'lean-kernel-elaborated-declaration-pretty-print-reference-graph-v1',
    };
    return Object.freeze({
      ...payload,
      leanProofPrintAuditHash: hashRecord('LeanReadableProofPrintAudit', payload),
    });
  }));
}

export function verifyLeanReadableProofPrintAudit(value, {
  claimBinding = null,
  declaration = null,
  sourceFileHash = null,
  executionReceiptHash = null,
} = {}) {
  if (!hasExactObjectKeys(value, AUDIT_KEYS)) return false;
  const { leanProofPrintAuditHash: claimedHash, ...payload } = value;
  if (value.version !== 1 || value.kind !== 'LeanReadableProofPrintAudit'
    || value.status !== 'lean_readable_proof_print_verified'
    || !value.claimId || !SAFE_NAME.test(String(value.theoremName || ''))
    || !SHA256.test(String(value.theoremTypeHash || ''))
    || !SHA256.test(String(value.sourceFileHash || ''))
    || !SHA256.test(String(value.sourceStatementHash || ''))
    || !SHA256.test(String(value.proofPrintTextHash || ''))
    || !SHA256.test(String(value.executionReceiptHash || ''))
    || value.proofPrintTextHash !== hashBytes(Buffer.from(value.proofPrintText, 'utf8'))
    || !String(value.proofPrintText).includes(value.theoremName)
    || !Array.isArray(value.printedIdentifiers)
    || JSON.stringify(value.printedIdentifiers) !== JSON.stringify(identifiers(value.proofPrintText))
    || !Array.isArray(value.usedDeclarationCandidates)
    || JSON.stringify(value.usedDeclarationCandidates)
      !== JSON.stringify(declarationCandidates(value.printedIdentifiers, value.theoremName))
    || !Array.isArray(value.axioms) || value.axiomAuditPresent !== true
    || value.machineExtractionScope
      !== 'lean-kernel-elaborated-declaration-pretty-print-reference-graph-v1'
    || claimedHash !== hashRecord('LeanReadableProofPrintAudit', payload)) return false;
  if (claimBinding && (value.claimId !== claimBinding.claimId
    || value.theoremName !== claimBinding.theoremName
    || value.sourceFile !== claimBinding.sourceFile)) return false;
  if (declaration && (value.theoremTypeHash !== declaration.typeHash
    || value.sourceStatementHash !== declaration.sourceStatementHash
    || JSON.stringify(value.axioms) !== JSON.stringify([...(declaration.axioms || [])].sort()))) {
    return false;
  }
  return (!sourceFileHash || value.sourceFileHash === sourceFileHash)
    && (!executionReceiptHash || value.executionReceiptHash === executionReceiptHash);
}

export function leanReadableProofAuditSetHash(audits) {
  return hashRecord('LeanReadableProofPrintAuditSemanticSet', (audits || []).map((audit) => ({
    status: audit.status,
    claimId: audit.claimId,
    theoremName: audit.theoremName,
    theoremTypeHash: audit.theoremTypeHash,
    sourceFile: audit.sourceFile,
    sourceFileHash: audit.sourceFileHash,
    sourceStatementHash: audit.sourceStatementHash,
    proofPrintTextHash: audit.proofPrintTextHash,
    printedIdentifiers: audit.printedIdentifiers,
    usedDeclarationCandidates: audit.usedDeclarationCandidates,
    axioms: audit.axioms,
    axiomAuditPresent: audit.axiomAuditPresent,
    machineExtractionScope: audit.machineExtractionScope,
  })));
}
