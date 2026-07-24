export function buildDeterministicPdfFixture({
  pageCount = 1,
  marker = 'deterministic-pdf-fixture',
} = {}) {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100) {
    throw new Error('deterministic_pdf_fixture_page_count_invalid');
  }
  const safeMarker = String(marker || 'deterministic-pdf-fixture')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/[\r\n]/g, '_')
    .slice(0, 256);
  const pageObjectNumbers = Array.from(
    { length: pageCount },
    (_, index) => index + 3,
  );
  const objects = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, `<< /Type /Pages /Kids [${pageObjectNumbers
      .map((objectNumber) => `${objectNumber} 0 R`).join(' ')}] /Count ${pageCount} >>`],
    ...pageObjectNumbers.map((objectNumber) => [
      objectNumber,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
    ]),
  ]);
  const chunks = [Buffer.from(`%PDF-1.4\n% ${safeMarker}\n`, 'latin1')];
  const offsets = new Map();
  let length = chunks[0].length;
  for (const [objectNumber, value] of objects) {
    offsets.set(objectNumber, length);
    const chunk = Buffer.from(
      `${objectNumber} 0 obj\n${value}\nendobj\n`,
      'latin1',
    );
    chunks.push(chunk);
    length += chunk.length;
  }
  const xrefOffset = length;
  const maximumObjectNumber = pageObjectNumbers.at(-1);
  const xref = [
    'xref',
    `0 ${maximumObjectNumber + 1}`,
    '0000000000 65535 f ',
    ...pageObjectNumbers.map(() => null),
  ];
  for (let objectNumber = 1; objectNumber <= maximumObjectNumber; objectNumber += 1) {
    xref[objectNumber + 2] = `${String(offsets.get(objectNumber)).padStart(10, '0')} 00000 n `;
  }
  chunks.push(Buffer.from([
    ...xref,
    'trailer',
    `<< /Size ${maximumObjectNumber + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n'), 'latin1'));
  return Buffer.concat(chunks);
}
