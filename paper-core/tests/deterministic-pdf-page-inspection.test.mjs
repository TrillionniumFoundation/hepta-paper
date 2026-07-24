import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import test from 'node:test';

import {
  buildDeterministicPdfPageInspectionReceipt,
  inspectDeterministicPdfPageTree,
  verifyDeterministicPdfPageInspectionReceipt,
} from '../../paper-domain/automation/deterministic-pdf-page-inspection-contract.mjs';
import {
  inspectVenueManuscriptStyleMarkers,
} from '../../paper-domain/automation/autonomous-venue-source-evidence-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const MAXIMUM_PDF_BYTES = 64 * 1024 * 1024;
const H = (label) => hashRecord('DeterministicPdfPageInspectionTest', { label });

function paddingComment(bytes) {
  if (!bytes) return Buffer.alloc(0);
  if (bytes < 2) throw new Error('pdf_test_padding_invalid');
  return Buffer.concat([
    Buffer.from('%', 'latin1'),
    Buffer.alloc(bytes - 2, 0x61),
    Buffer.from('\n', 'latin1'),
  ]);
}

function classicPdf({
  kids = [3],
  claimedCount = kids.length,
  catalogPagesObject = 2,
  pageParents = { 3: 2 },
  extraObjects = {},
  encrypted = false,
  paddingBytes = 0,
} = {}) {
  const objects = new Map([
    [1, `<< /Type /Catalog /Pages ${catalogPagesObject} 0 R >>`],
    [2, `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${claimedCount} >>`],
    ...Object.entries(pageParents).map(([id, parent]) => [
      Number(id), `<< /Type /Page /Parent ${parent} 0 R >>`,
    ]),
    ...Object.entries(extraObjects).map(([id, value]) => [Number(id), value]),
  ]);
  const maximumObject = Math.max(...objects.keys(), encrypted ? 9 : 0);
  if (encrypted && !objects.has(9)) objects.set(9, '<< /Filter /Standard >>');
  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1'), paddingComment(paddingBytes)];
  const offsets = new Map();
  let length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  for (let objectNumber = 1; objectNumber <= maximumObject; objectNumber += 1) {
    if (!objects.has(objectNumber)) continue;
    offsets.set(objectNumber, length);
    const chunk = Buffer.from(
      `${objectNumber} 0 obj\n${objects.get(objectNumber)}\nendobj\n`,
      'latin1',
    );
    chunks.push(chunk);
    length += chunk.length;
  }
  const xrefOffset = length;
  const xref = [`xref`, `0 ${maximumObject + 1}`, '0000000000 65535 f '];
  for (let objectNumber = 1; objectNumber <= maximumObject; objectNumber += 1) {
    const offset = offsets.get(objectNumber);
    xref.push(offset === undefined
      ? '0000000000 00000 f '
      : `${String(offset).padStart(10, '0')} 00000 n `);
  }
  const trailer = [
    ...xref,
    'trailer',
    `<< /Size ${maximumObject + 1} /Root 1 0 R${encrypted ? ' /Encrypt 9 0 R' : ''} >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n');
  return Buffer.concat([...chunks, Buffer.from(trailer, 'latin1')]);
}

function xrefRow(type, field1, field2) {
  const row = Buffer.alloc(7);
  row.writeUInt8(type, 0);
  row.writeUInt32BE(field1, 1);
  row.writeUInt16BE(field2, 5);
  return row;
}

function streamObject(objectNumber, dictionary, stream) {
  return Buffer.concat([
    Buffer.from(
      `${objectNumber} 0 obj\n<< ${dictionary} /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`,
      'latin1',
    ),
    stream,
    Buffer.from('\nendstream\nendobj\n', 'latin1'),
  ]);
}

function xrefStreamPdf() {
  const chunks = [Buffer.from('%PDF-1.5\n', 'latin1')];
  const offsets = [0];
  for (const [objectNumber, value] of [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R >>'],
  ]) {
    offsets[objectNumber] = chunks.reduce((total, chunk) => total + chunk.length, 0);
    chunks.push(Buffer.from(`${objectNumber} 0 obj\n${value}\nendobj\n`, 'latin1'));
  }
  offsets[4] = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const xref = deflateSync(Buffer.concat([
    xrefRow(0, 0, 65_535),
    ...[1, 2, 3, 4].map((objectNumber) => xrefRow(1, offsets[objectNumber], 0)),
  ]));
  chunks.push(streamObject(4, '/Type /XRef /Size 5 /W [1 4 2] /Root 1 0 R', xref));
  chunks.push(Buffer.from(`startxref\n${offsets[4]}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

function objectStreamPayload(entries, paddingBytes = 0) {
  const bodies = entries.map((entry) => Buffer.from(entry.value, 'latin1'));
  let relativeOffset = 0;
  const header = entries.map((entry, index) => {
    const result = `${entry.objectNumber} ${relativeOffset}`;
    relativeOffset += bodies[index].length + 1;
    return result;
  }).join(' ') + ' ';
  return Buffer.concat([
    Buffer.from(header, 'latin1'),
    ...bodies.flatMap((body) => [body, Buffer.from(' ', 'latin1')]),
    Buffer.alloc(paddingBytes, 0x20),
  ]);
}

function objectStreamPdf({ inflatedPaddingBytes = 0 } = {}) {
  const objectStream4Payload = objectStreamPayload([
    { objectNumber: 1, value: '<< /Type /Catalog /Pages 2 0 R >>' },
    { objectNumber: 2, value: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
  ], inflatedPaddingBytes);
  const objectStream5Payload = objectStreamPayload([
    { objectNumber: 3, value: '<< /Type /Page /Parent 2 0 R >>' },
  ], inflatedPaddingBytes);
  const first4 = objectStream4Payload.indexOf(Buffer.from('<<', 'latin1'));
  const first5 = objectStream5Payload.indexOf(Buffer.from('<<', 'latin1'));
  const chunks = [Buffer.from('%PDF-1.5\n', 'latin1')];
  const offsets = [];
  offsets[4] = chunks.reduce((total, chunk) => total + chunk.length, 0);
  chunks.push(streamObject(
    4,
    `/Type /ObjStm /N 2 /First ${first4}`,
    deflateSync(objectStream4Payload),
  ));
  offsets[5] = chunks.reduce((total, chunk) => total + chunk.length, 0);
  chunks.push(streamObject(
    5,
    `/Type /ObjStm /N 1 /First ${first5}`,
    deflateSync(objectStream5Payload),
  ));
  offsets[6] = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const xref = deflateSync(Buffer.concat([
    xrefRow(0, 0, 65_535),
    xrefRow(2, 4, 0),
    xrefRow(2, 4, 1),
    xrefRow(2, 5, 0),
    xrefRow(1, offsets[4], 0),
    xrefRow(1, offsets[5], 0),
    xrefRow(1, offsets[6], 0),
  ]));
  chunks.push(streamObject(6, '/Type /XRef /Size 7 /W [1 4 2] /Root 1 0 R', xref));
  chunks.push(Buffer.from(`startxref\n${offsets[6]}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

function rehashReceipt(receipt, patch) {
  const {
    deterministicPdfPageInspectionReceiptHash: _claimedHash,
    ...payload
  } = { ...receipt, ...patch };
  return {
    ...payload,
    deterministicPdfPageInspectionReceiptHash:
      hashRecord('DeterministicPdfPageInspectionReceipt', payload),
  };
}

test('deterministic PDF receipt recomputes bytes, length, hash, and page count', () => {
  const bytes = classicPdf();
  const receipt = buildDeterministicPdfPageInspectionReceipt({
    compiledPdfBytesBase64: bytes.toString('base64'),
    campaignReleaseBundleHash: H('release'),
  });
  assert.equal(receipt.pageCount, 1);
  assert.equal(verifyDeterministicPdfPageInspectionReceipt(receipt, {
    compiledPdfHash: receipt.compiledPdfHash,
    campaignReleaseBundleHash: receipt.campaignReleaseBundleHash,
  }), true);

  const changedBytes = Buffer.from(bytes);
  const objectHeader = changedBytes.indexOf(Buffer.from('1 0 obj', 'latin1'));
  changedBytes[objectHeader + 1] = 0x09;
  for (const forged of [
    rehashReceipt(receipt, { compiledPdfBytesBase64: changedBytes.toString('base64') }),
    rehashReceipt(receipt, { compiledPdfBytes: receipt.compiledPdfBytes + 1 }),
    rehashReceipt(receipt, { compiledPdfHash: H('forged-pdf') }),
    rehashReceipt(receipt, { pageCount: 20 }),
  ]) assert.equal(verifyDeterministicPdfPageInspectionReceipt(forged), false);
});

test('page-tree parser rejects Catalog, Kids, Count, parent, cycle, and duplicate splices', () => {
  assert.equal(inspectDeterministicPdfPageTree(classicPdf()).pageCount, 1);
  for (const bytes of [
    classicPdf({ catalogPagesObject: 3 }),
    classicPdf({ claimedCount: 2 }),
    classicPdf({ kids: [3, 3], claimedCount: 2 }),
    classicPdf({ kids: [2], claimedCount: 1, pageParents: {} }),
    classicPdf({ pageParents: { 3: 4 }, extraObjects: {
      4: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    } }),
    classicPdf({ catalogPagesObject: 8 }),
  ]) assert.throws(() => inspectDeterministicPdfPageTree(bytes));
});

test('PDF authority fails closed for incremental, encrypted, and unsupported-filter inputs', () => {
  const xrefStream = xrefStreamPdf();
  assert.equal(inspectDeterministicPdfPageTree(xrefStream).pageCount, 1);
  assert.throws(() => inspectDeterministicPdfPageTree(Buffer.concat([
    classicPdf(), Buffer.from('startxref\n0\n%%EOF\n', 'latin1'),
  ])));
  assert.throws(() => inspectDeterministicPdfPageTree(classicPdf({ encrypted: true })));
  const unsupported = Buffer.from(
    xrefStream.toString('latin1').replace('/FlateDecode', '/LZWDecode  '),
    'latin1',
  );
  assert.throws(() => inspectDeterministicPdfPageTree(unsupported));
});

test('PDF parser enforces cumulative inflate and the exact 64 MiB byte boundary', () => {
  assert.equal(inspectDeterministicPdfPageTree(objectStreamPdf()).pageCount, 1);
  assert.throws(() => inspectDeterministicPdfPageTree(objectStreamPdf({
    inflatedPaddingBytes: 7 * 1024 * 1024,
  })));

  let paddingBytes = MAXIMUM_PDF_BYTES - classicPdf().length;
  let boundary = classicPdf({ paddingBytes });
  for (let attempts = 0; boundary.length !== MAXIMUM_PDF_BYTES && attempts < 4; attempts += 1) {
    paddingBytes += MAXIMUM_PDF_BYTES - boundary.length;
    boundary = classicPdf({ paddingBytes });
  }
  assert.equal(boundary.length, MAXIMUM_PDF_BYTES);
  assert.equal(inspectDeterministicPdfPageTree(boundary).pageCount, 1);
  assert.throws(() => inspectDeterministicPdfPageTree(Buffer.concat([
    boundary, Buffer.from('x', 'latin1'),
  ])), /deterministic_pdf_bytes_invalid/);
});

test('PDF tokenizer rejects oversized name, numeric, and string tokens without slicing tails', () => {
  for (const bytes of [
    classicPdf({ extraObjects: {
      1: `<< /Type /Catalog /${'n'.repeat(4_097)} 1 /Pages 2 0 R >>`,
    } }),
    classicPdf({ claimedCount: '1'.repeat(65) }),
    classicPdf({ extraObjects: {
      1: `<< /Type /Catalog /Lang (${'s'.repeat(1024 * 1024 + 1)}) /Pages 2 0 R >>`,
    } }),
  ]) assert.throws(() => inspectDeterministicPdfPageTree(bytes));
});

test('venue manuscript style markers are unique source-derived observations', () => {
  const valid = [
    '\\documentclass[11pt]{article}',
    '% HEPTA_BIBLIOGRAPHY_STYLE inline-evidence-v1',
    '% HEPTA_CITATION_STYLE evidence-inline-v1',
    '\\begin{document}',
    '\\end{document}',
  ].join('\n');
  assert.deepEqual(inspectVenueManuscriptStyleMarkers(valid), {
    documentClass: 'article',
    bibliographyStyle: 'inline-evidence-v1',
    citationStyle: 'evidence-inline-v1',
  });
  assert.equal(inspectVenueManuscriptStyleMarkers(
    `${valid}\n\\documentclass{book}`,
  ).documentClass, null);
  assert.equal(inspectVenueManuscriptStyleMarkers(
    valid.replace('% HEPTA_BIBLIOGRAPHY_STYLE inline-evidence-v1\n', ''),
  ).bibliographyStyle, null);
  assert.equal(inspectVenueManuscriptStyleMarkers(
    `${valid}\n% HEPTA_CITATION_STYLE forged-v2`,
  ).citationStyle, null);
});
