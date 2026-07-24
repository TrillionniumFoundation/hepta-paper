import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  BOUNDED_PDF_PAGE_TREE_LIMITS,
  inspectDeterministicPdfPageTree,
} from './deterministic-pdf-page-tree-parser.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RECEIPT_KEYS = Object.freeze([
  'campaignReleaseBundleHash', 'compiledPdfBytes', 'compiledPdfBytesBase64',
  'compiledPdfHash', 'contentEncoding', 'deterministicPdfPageInspectionReceiptHash',
  'kind', 'pageCount', 'parserPolicy', 'parserPolicyHash', 'version',
]);

export { inspectDeterministicPdfPageTree };
export const DETERMINISTIC_PDF_PAGE_TREE_PARSER_POLICY =
  'bounded-pdf-xref-page-tree-flate-v1';
export const DETERMINISTIC_PDF_PAGE_TREE_PARSER_POLICY_HASH = hashRecord(
  'DeterministicPdfPageTreeParserPolicy',
  {
    parserPolicy: DETERMINISTIC_PDF_PAGE_TREE_PARSER_POLICY,
    ...BOUNDED_PDF_PAGE_TREE_LIMITS,
    acceptedStreamFilter: 'FlateDecode',
    incrementalUpdatesAccepted: false,
    encryptedDocumentsAccepted: false,
  },
);

function sha(value) {
  const candidate = String(value || '').toLowerCase();
  return SHA256.test(candidate) ? candidate : null;
}

function canonicalPdfBytes(value) {
  const maximumBytes = BOUNDED_PDF_PAGE_TREE_LIMITS.maximumPdfBytes;
  if (typeof value !== 'string' || value.length < 4
    || value.length > Math.ceil(maximumBytes / 3) * 4) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length <= maximumBytes
    && bytes.toString('base64') === value ? bytes : null;
}

export function buildDeterministicPdfPageInspectionReceipt({
  compiledPdfBytesBase64,
  campaignReleaseBundleHash,
} = {}) {
  const bytes = canonicalPdfBytes(compiledPdfBytesBase64);
  const inspection = bytes ? inspectDeterministicPdfPageTree(bytes) : null;
  if (!bytes || !inspection || !sha(campaignReleaseBundleHash)) {
    throw new Error('deterministic_pdf_page_inspection_receipt_invalid');
  }
  const payload = {
    version: 1,
    kind: 'DeterministicPdfPageInspectionReceipt',
    parserPolicy: DETERMINISTIC_PDF_PAGE_TREE_PARSER_POLICY,
    parserPolicyHash: DETERMINISTIC_PDF_PAGE_TREE_PARSER_POLICY_HASH,
    contentEncoding: 'base64',
    compiledPdfBytesBase64,
    compiledPdfBytes: bytes.length,
    compiledPdfHash: hashBytes(bytes),
    pageCount: inspection.pageCount,
    campaignReleaseBundleHash: sha(campaignReleaseBundleHash),
  };
  return Object.freeze({
    ...payload,
    deterministicPdfPageInspectionReceiptHash:
      hashRecord('DeterministicPdfPageInspectionReceipt', payload),
  });
}

export function verifyDeterministicPdfPageInspectionReceipt(receipt, {
  compiledPdfHash = null,
  campaignReleaseBundleHash = null,
} = {}) {
  if (!hasExactObjectKeys(receipt, RECEIPT_KEYS)) return false;
  try {
    const rebuilt = buildDeterministicPdfPageInspectionReceipt(receipt);
    return JSON.stringify(rebuilt) === JSON.stringify(receipt)
      && (!compiledPdfHash || receipt.compiledPdfHash === compiledPdfHash)
      && (!campaignReleaseBundleHash
        || receipt.campaignReleaseBundleHash === campaignReleaseBundleHash);
  } catch { return false; }
}
