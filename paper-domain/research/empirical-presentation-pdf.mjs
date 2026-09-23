function decimal(value, digits = 3) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('empirical_presentation_number_invalid');
  return number.toFixed(digits).replace(/(?:\.0+|(?:(\.[0-9]*?)0+))$/, '$1') || '0';
}

function pdfText(value) {
  return String(value || '').replace(/([\\()])/g, '\\$1').replace(/[^\x20-\x7e]/g, '?');
}

function pdfDocument(objects) {
  const header = '%PDF-1.4\n% HEPTA deterministic empirical presentation\n';
  let source = header;
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(source, 'latin1'));
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source, 'latin1');
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source, 'latin1');
}

export function canonicalEmpiricalPresentationPdf(entries) {
  const rowHeight = 24;
  const height = Math.max(240, 104 + entries.length * rowHeight);
  const left = 74;
  const right = 554;
  const plotWidth = right - left;
  const values = entries.flatMap((entry) => [entry.original.result.estimate, entry.replay.result.estimate]);
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const span = maximum - minimum || 1;
  const x = (value) => left + ((Number(value) - minimum) / span) * plotWidth;
  const zero = x(0);
  const commands = [
    '0.4 w',
    '0 0 0 RG',
    `${decimal(left)} 56 m ${decimal(right)} 56 l S`,
    `${decimal(zero)} 50 m ${decimal(zero)} ${decimal(height - 54)} l S`,
    `BT /F1 12 Tf 74 ${decimal(height - 30)} Td (${pdfText('Registry-bound original and isolated deterministic rerun estimates')}) Tj ET`,
    `BT /F1 8 Tf 74 38 Td (${pdfText(`scale ${String(minimum)} to ${String(maximum)}`)}) Tj ET`,
  ];
  entries.forEach((entry, index) => {
    const y = height - 72 - index * rowHeight;
    const originalX = x(entry.original.result.estimate);
    const replayX = x(entry.replay.result.estimate);
    commands.push(
      '0.18 0.45 0.78 rg',
      `${decimal(Math.min(zero, originalX))} ${decimal(y)} ${decimal(Math.max(1, Math.abs(originalX - zero)))} 7 re f`,
      '0.82 0.36 0.20 rg',
      `${decimal(Math.min(zero, replayX))} ${decimal(y - 9)} ${decimal(Math.max(1, Math.abs(replayX - zero)))} 7 re f`,
      '0 0 0 rg',
      `BT /F1 7 Tf 12 ${decimal(y)} Td (${pdfText(`C${index + 1} O=${String(entry.original.result.estimate)} R=${String(entry.replay.result.estimate)} ${entry.verdict}`)}) Tj ET`,
    );
  });
  const stream = `${commands.join('\n')}\n`;
  return pdfDocument([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${decimal(height)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}
