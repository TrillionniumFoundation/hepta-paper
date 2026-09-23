import { inflateSync } from 'node:zlib';
import {
  BoundedPdfTokenizer,
  BOUNDED_PDF_TOKEN_LIMITS,
  MAXIMUM_BOUNDED_PDF_OBJECTS,
  PDF_WHITESPACE_CODES,
  pdfInteger,
  pdfNameValue,
  pdfReference,
} from './bounded-pdf-tokenizer.mjs';

const MAXIMUM_PDF_BYTES = 64 * 1024 * 1024;
const MAXIMUM_INFLATED_OBJECT_STREAM_BYTES = 8 * 1024 * 1024;
const MAXIMUM_TOTAL_INFLATED_BYTES = 12 * 1024 * 1024;
const MAXIMUM_OBJECT_LOADS = 100_000;
const MAXIMUM_PARSE_WORK_UNITS = 64 * 1024 * 1024;

export const BOUNDED_PDF_PAGE_TREE_LIMITS = Object.freeze({
  ...BOUNDED_PDF_TOKEN_LIMITS,
  maximumPdfBytes: MAXIMUM_PDF_BYTES,
  maximumPdfObjects: MAXIMUM_BOUNDED_PDF_OBJECTS,
  maximumInflatedObjectStreamBytes: MAXIMUM_INFLATED_OBJECT_STREAM_BYTES,
  maximumTotalInflatedBytes: MAXIMUM_TOTAL_INFLATED_BYTES,
  maximumObjectLoads: MAXIMUM_OBJECT_LOADS,
  maximumParseWorkUnits: MAXIMUM_PARSE_WORK_UNITS,
  maximumPageTreeDepth: 128,
  maximumPages: 100_000,
  acceptedPdfVersions: '1.0-1.7',
});

function parsingContext(bytes) {
  const budget = {
    inflatedBytes: 0,
    objectLoads: 0,
    workUnits: 0,
    inflate(bytesRead) {
      this.inflatedBytes += bytesRead;
      if (this.inflatedBytes > MAXIMUM_TOTAL_INFLATED_BYTES) {
        throw new Error('pdf_total_inflate_budget_exceeded');
      }
    },
    objectLoad() {
      this.objectLoads += 1;
      if (this.objectLoads > MAXIMUM_OBJECT_LOADS) {
        throw new Error('pdf_object_load_budget_exceeded');
      }
    },
    work(units) {
      this.workUnits += Math.max(1, Number(units) || 0);
      if (this.workUnits > MAXIMUM_PARSE_WORK_UNITS) {
        throw new Error('pdf_parse_work_budget_exceeded');
      }
    },
  };
  return { bytes, source: bytes.toString('latin1'), budget };
}

function streamFilterSupported(dictionary) {
  const filter = dictionary?.get('Filter');
  return pdfNameValue(filter) === 'FlateDecode'
    && !dictionary.has('DecodeParms') && !dictionary.has('DP');
}

function parseIndirectObjectAt(context, offset) {
  const { bytes, source, budget } = context;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) {
    throw new Error('pdf_indirect_object_offset_invalid');
  }
  budget.objectLoad();
  const tokenizer = new BoundedPdfTokenizer(bytes, offset, source);
  const objectNumber = tokenizer.rawInteger();
  const generation = tokenizer.rawInteger();
  if (pdfInteger(objectNumber, 1) === null || pdfInteger(generation) === null
    || !tokenizer.keyword('obj')) throw new Error('pdf_indirect_object_header_invalid');
  const value = tokenizer.value();
  tokenizer.skip();
  let stream = null;
  if (tokenizer.keyword('stream')) {
    if (!(value instanceof Map)) throw new Error('pdf_stream_dictionary_required');
    const length = pdfInteger(value.get('Length'));
    if (length === null || length > MAXIMUM_INFLATED_OBJECT_STREAM_BYTES) {
      throw new Error('pdf_stream_length_invalid');
    }
    if (tokenizer.source.startsWith('\r\n', tokenizer.position)) tokenizer.position += 2;
    else if (['\r', '\n'].includes(tokenizer.source[tokenizer.position])) {
      tokenizer.position += 1;
    } else throw new Error('pdf_stream_eol_invalid');
    const end = tokenizer.position + length;
    if (end > bytes.length) throw new Error('pdf_stream_truncated');
    stream = bytes.subarray(tokenizer.position, end);
    tokenizer.position = end;
    if (tokenizer.source.startsWith('\r\n', tokenizer.position)) tokenizer.position += 2;
    else if (['\r', '\n'].includes(tokenizer.source[tokenizer.position])) {
      tokenizer.position += 1;
    }
    if (!tokenizer.keyword('endstream')) throw new Error('pdf_stream_end_invalid');
  }
  if (!tokenizer.keyword('endobj')) throw new Error('pdf_indirect_object_end_invalid');
  budget.work(tokenizer.position - offset);
  return Object.freeze({ objectNumber, generation, value, stream });
}

function readBigEndian(bytes, offset, width) {
  if (width === 0) return 0;
  if (width > 6 || offset + width > bytes.length) throw new Error('pdf_xref_width_invalid');
  let value = 0;
  for (let index = 0; index < width; index += 1) value = value * 256 + bytes[offset + index];
  if (!Number.isSafeInteger(value)) throw new Error('pdf_xref_value_invalid');
  return value;
}

function inflatePdfStream(stream, context) {
  try {
    const inflated = inflateSync(stream, {
      maxOutputLength: MAXIMUM_INFLATED_OBJECT_STREAM_BYTES,
    });
    context.budget.inflate(inflated.length);
    context.budget.work(inflated.length);
    return inflated;
  } catch {
    throw new Error('pdf_flate_stream_invalid');
  }
}

function parseXrefStream(context, offset) {
  const object = parseIndirectObjectAt(context, offset);
  const dictionary = object.value;
  if (!(dictionary instanceof Map) || pdfNameValue(dictionary.get('Type')) !== 'XRef'
    || !object.stream || !streamFilterSupported(dictionary)
    || dictionary.has('Prev') || dictionary.has('XRefStm')
    || dictionary.has('Encrypt')) throw new Error('pdf_xref_stream_invalid');
  const widths = dictionary.get('W');
  const size = pdfInteger(dictionary.get('Size'), 1);
  const index = dictionary.get('Index') || [0, size];
  if (!Array.isArray(widths) || widths.length !== 3
    || widths.some((width) => pdfInteger(width) === null)
    || widths.reduce((total, width) => total + width, 0) < 1
    || size === null || size > MAXIMUM_BOUNDED_PDF_OBJECTS
    || !Array.isArray(index) || index.length < 2 || index.length % 2 !== 0) {
    throw new Error('pdf_xref_stream_shape_invalid');
  }
  const ranges = [];
  let entryCount = 0;
  for (let cursor = 0; cursor < index.length; cursor += 2) {
    const start = pdfInteger(index[cursor]);
    const count = pdfInteger(index[cursor + 1]);
    if (start === null || count === null || start + count > size) {
      throw new Error('pdf_xref_index_invalid');
    }
    ranges.push([start, count]);
    entryCount += count;
  }
  if (entryCount > MAXIMUM_BOUNDED_PDF_OBJECTS) {
    throw new Error('pdf_xref_entries_exceeded');
  }
  const inflated = inflatePdfStream(object.stream, context);
  const rowBytes = widths.reduce((total, width) => total + width, 0);
  if (inflated.length !== entryCount * rowBytes) throw new Error('pdf_xref_bytes_invalid');
  const entries = new Map();
  let cursor = 0;
  for (const [start, count] of ranges) {
    for (let indexOffset = 0; indexOffset < count; indexOffset += 1) {
      const type = widths[0] === 0 ? 1 : readBigEndian(inflated, cursor, widths[0]);
      cursor += widths[0];
      const field1 = readBigEndian(inflated, cursor, widths[1]);
      cursor += widths[1];
      const field2 = readBigEndian(inflated, cursor, widths[2]);
      cursor += widths[2];
      const objectNumber = start + indexOffset;
      if (![0, 1, 2].includes(type) || entries.has(objectNumber)) {
        throw new Error('pdf_xref_entry_invalid');
      }
      entries.set(objectNumber, Object.freeze({ type, field1, field2 }));
    }
  }
  return Object.freeze({ entries, trailer: dictionary });
}

function parseClassicXref(context, offset) {
  const tokenizer = new BoundedPdfTokenizer(context.bytes, offset, context.source);
  if (!tokenizer.keyword('xref')) throw new Error('pdf_xref_table_invalid');
  const entries = new Map();
  while (true) {
    tokenizer.skip();
    if (tokenizer.keyword('trailer')) break;
    const start = tokenizer.rawInteger();
    const count = tokenizer.rawInteger();
    if (pdfInteger(start) === null || pdfInteger(count, 1) === null
      || start + count > MAXIMUM_BOUNDED_PDF_OBJECTS) {
      throw new Error('pdf_xref_section_invalid');
    }
    for (let cursor = 0; cursor < count; cursor += 1) {
      const field1 = tokenizer.rawInteger();
      const field2 = tokenizer.rawInteger();
      tokenizer.skip();
      const state = tokenizer.source[tokenizer.position];
      tokenizer.position += 1;
      if (pdfInteger(field1) === null || pdfInteger(field2) === null
        || !['f', 'n'].includes(state) || entries.has(start + cursor)) {
        throw new Error('pdf_xref_table_entry_invalid');
      }
      entries.set(start + cursor, Object.freeze({
        type: state === 'n' ? 1 : 0,
        field1,
        field2,
      }));
    }
  }
  const trailer = tokenizer.value();
  if (!(trailer instanceof Map) || trailer.has('Prev') || trailer.has('XRefStm')
    || trailer.has('Encrypt')) throw new Error('pdf_trailer_invalid');
  context.budget.work(tokenizer.position - offset);
  return Object.freeze({ entries, trailer });
}

function compressedObjectValues(context, xref, objectStreamNumber, cache) {
  if (cache.has(objectStreamNumber)) return cache.get(objectStreamNumber);
  const entry = xref.get(objectStreamNumber);
  if (entry?.type !== 1) throw new Error('pdf_object_stream_xref_invalid');
  const object = parseIndirectObjectAt(context, entry.field1);
  const dictionary = object.value;
  const count = dictionary instanceof Map ? pdfInteger(dictionary.get('N'), 1) : null;
  const first = dictionary instanceof Map ? pdfInteger(dictionary.get('First'), 1) : null;
  if (object.objectNumber !== objectStreamNumber || object.generation !== entry.field2
    || pdfNameValue(dictionary?.get('Type')) !== 'ObjStm' || !object.stream
    || !streamFilterSupported(dictionary) || count === null
    || count > MAXIMUM_BOUNDED_PDF_OBJECTS || first === null) {
    throw new Error('pdf_object_stream_invalid');
  }
  const inflated = inflatePdfStream(object.stream, context);
  if (first > inflated.length) throw new Error('pdf_object_stream_header_invalid');
  const tokenizer = new BoundedPdfTokenizer(inflated);
  const headers = [];
  for (let index = 0; index < count; index += 1) {
    const objectNumber = tokenizer.rawInteger();
    const relativeOffset = tokenizer.rawInteger();
    if (pdfInteger(objectNumber, 1) === null || pdfInteger(relativeOffset) === null
      || (headers.length && relativeOffset < headers.at(-1).relativeOffset)) {
      throw new Error('pdf_object_stream_index_invalid');
    }
    headers.push({ objectNumber, relativeOffset });
  }
  tokenizer.skip();
  const headerRemainder = inflated.subarray(tokenizer.position, first);
  if (tokenizer.position > first
    || [...headerRemainder].some((byte) => !PDF_WHITESPACE_CODES.has(byte))) {
    throw new Error('pdf_object_stream_first_invalid');
  }
  const values = new Map();
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const start = first + header.relativeOffset;
    const end = index + 1 < headers.length
      ? first + headers[index + 1].relativeOffset : inflated.length;
    if (start < first || end < start || end > inflated.length
      || values.has(header.objectNumber)) throw new Error('pdf_object_stream_slice_invalid');
    const valueTokenizer = new BoundedPdfTokenizer(inflated.subarray(start, end));
    const value = valueTokenizer.value();
    valueTokenizer.skip();
    if (valueTokenizer.position !== valueTokenizer.source.length) {
      throw new Error('pdf_object_stream_value_trailing_bytes');
    }
    values.set(header.objectNumber, Object.freeze({ value, index }));
  }
  cache.set(objectStreamNumber, values);
  return values;
}

function createObjectLoader(context, entries) {
  const objectCache = new Map();
  const objectStreamCache = new Map();
  return (reference) => {
    const selected = pdfReference(reference);
    if (!selected) throw new Error('pdf_object_reference_invalid');
    const key = `${selected.objectNumber}:${selected.generation}`;
    if (objectCache.has(key)) return objectCache.get(key);
    const entry = entries.get(selected.objectNumber);
    let value = null;
    if (entry?.type === 1) {
      const object = parseIndirectObjectAt(context, entry.field1);
      if (object.objectNumber !== selected.objectNumber
        || object.generation !== selected.generation
        || entry.field2 !== selected.generation) throw new Error('pdf_xref_object_mismatch');
      value = object.value;
    } else if (entry?.type === 2 && selected.generation === 0) {
      const values = compressedObjectValues(
        context,
        entries,
        entry.field1,
        objectStreamCache,
      );
      const compressed = values.get(selected.objectNumber);
      if (!compressed || compressed.index !== entry.field2) {
        throw new Error('pdf_compressed_object_mismatch');
      }
      value = compressed.value;
    } else throw new Error('pdf_object_xref_missing');
    objectCache.set(key, value);
    context.budget.work(1);
    return value;
  };
}

function countPages(load, rootReference) {
  const catalog = load(rootReference);
  if (!(catalog instanceof Map) || pdfNameValue(catalog.get('Type')) !== 'Catalog') {
    throw new Error('pdf_catalog_invalid');
  }
  const pageRoot = pdfReference(catalog.get('Pages'));
  if (!pageRoot) throw new Error('pdf_page_root_missing');
  const pageRootDictionary = load(pageRoot);
  if (!(pageRootDictionary instanceof Map)
    || pdfNameValue(pageRootDictionary.get('Type')) !== 'Pages'
    || pageRootDictionary.has('Parent')) throw new Error('pdf_page_root_invalid');
  const visited = new Set();
  const walk = (reference, depth = 0, parentReference = null) => {
    if (depth > 128 || visited.size > MAXIMUM_BOUNDED_PDF_OBJECTS) {
      throw new Error('pdf_page_tree_limit_exceeded');
    }
    const selected = pdfReference(reference);
    const key = `${selected?.objectNumber}:${selected?.generation}`;
    if (!selected || visited.has(key)) throw new Error('pdf_page_tree_cycle_or_duplicate');
    visited.add(key);
    const dictionary = load(selected);
    if (!(dictionary instanceof Map)) throw new Error('pdf_page_tree_object_invalid');
    const type = pdfNameValue(dictionary.get('Type'));
    const parent = pdfReference(dictionary.get('Parent'));
    if (depth === 0 ? parent !== null : (
      !parent || parent.objectNumber !== parentReference?.objectNumber
        || parent.generation !== parentReference?.generation
    )) throw new Error('pdf_page_parent_binding_invalid');
    if (type === 'Page') return 1;
    if (type !== 'Pages') throw new Error('pdf_page_tree_type_invalid');
    const kids = dictionary.get('Kids');
    const claimedCount = pdfInteger(dictionary.get('Count'), 1);
    if (!Array.isArray(kids) || kids.length < 1
      || kids.length > MAXIMUM_BOUNDED_PDF_OBJECTS || claimedCount === null) {
      throw new Error('pdf_pages_node_invalid');
    }
    const actualCount = kids.reduce(
      (total, kid) => total + walk(kid, depth + 1, selected),
      0,
    );
    if (claimedCount !== actualCount) throw new Error('pdf_page_count_mismatch');
    return actualCount;
  };
  return walk(pageRoot);
}

export function inspectDeterministicPdfPageTree(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > MAXIMUM_PDF_BYTES) {
    throw new Error('deterministic_pdf_bytes_invalid');
  }
  const context = parsingContext(bytes);
  const { source } = context;
  if (!/^%PDF-1\.[0-7][\r\n]/.test(source)) throw new Error('pdf_header_invalid');
  const footerMatches = [...source.matchAll(/startxref\s+(\d+)\s+%%EOF\s*/g)];
  const footer = footerMatches.at(-1) || null;
  if (footerMatches.length !== 1 || !footer
    || footer.index + footer[0].length !== source.length) {
    throw new Error('pdf_incremental_or_footer_invalid');
  }
  const xrefOffset = Number(footer[1]);
  if (!Number.isSafeInteger(xrefOffset) || xrefOffset < 9 || xrefOffset >= bytes.length) {
    throw new Error('pdf_startxref_invalid');
  }
  const xref = source.startsWith('xref', xrefOffset)
    ? parseClassicXref(context, xrefOffset) : parseXrefStream(context, xrefOffset);
  if (xref.entries.size < 2 || xref.entries.size > MAXIMUM_BOUNDED_PDF_OBJECTS
    || xref.trailer.has('Encrypt') || xref.trailer.has('Prev')) {
    throw new Error('pdf_xref_authority_invalid');
  }
  const rootReference = pdfReference(xref.trailer.get('Root'));
  const pageCount = countPages(createObjectLoader(context, xref.entries), rootReference);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100_000) {
    throw new Error('pdf_page_count_invalid');
  }
  return Object.freeze({ pageCount });
}
