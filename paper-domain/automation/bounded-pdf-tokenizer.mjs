export const MAXIMUM_BOUNDED_PDF_OBJECTS = 200_000;
export const PDF_WHITESPACE_CODES = new Set([0, 9, 10, 12, 13, 32]);
const MAXIMUM_PDF_NAME_BYTES = 4_096;
const MAXIMUM_PDF_NUMBER_BYTES = 64;
const MAXIMUM_PDF_STRING_BYTES = 1024 * 1024;
const INTEGER_TOKEN = /[+-]?\d+/y;
const NUMBER_TOKEN = /[+-]?(?:\d+\.\d*|\.\d+|\d+)/y;

export const BOUNDED_PDF_TOKEN_LIMITS = Object.freeze({
  maximumPdfNameBytes: MAXIMUM_PDF_NAME_BYTES,
  maximumPdfNumberBytes: MAXIMUM_PDF_NUMBER_BYTES,
  maximumPdfStringBytes: MAXIMUM_PDF_STRING_BYTES,
  maximumPdfValueDepth: 64,
});

function pdfWhitespace(character) {
  return character !== undefined && PDF_WHITESPACE_CODES.has(character.charCodeAt(0));
}

function pdfDelimiter(character) {
  return pdfWhitespace(character) || '()<>[]{}/%'.includes(character || '');
}

export function pdfNameValue(value) {
  return value?.type === 'name' ? value.value : null;
}

export function pdfReference(value) {
  return value?.type === 'ref'
    && Number.isSafeInteger(value.objectNumber) && value.objectNumber > 0
    && Number.isSafeInteger(value.generation) && value.generation >= 0
    ? value : null;
}

export function pdfInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum ? value : null;
}

export class BoundedPdfTokenizer {
  constructor(bytes, position = 0, source = null) {
    this.bytes = bytes;
    this.source = source || bytes.toString('latin1');
    this.position = position;
  }

  skip() {
    while (this.position < this.source.length) {
      const character = this.source[this.position];
      if (pdfWhitespace(character)) {
        this.position += 1;
      } else if (character === '%') {
        while (this.position < this.source.length
          && !['\r', '\n'].includes(this.source[this.position])) this.position += 1;
      } else break;
    }
  }

  keyword(keyword) {
    this.skip();
    if (!this.source.startsWith(keyword, this.position)) return false;
    const next = this.source[this.position + keyword.length] || '';
    if (next && !pdfDelimiter(next)) return false;
    this.position += keyword.length;
    return true;
  }

  rawInteger() {
    this.skip();
    INTEGER_TOKEN.lastIndex = this.position;
    const match = INTEGER_TOKEN.exec(this.source);
    if (!match) return null;
    if (match[0].length > MAXIMUM_PDF_NUMBER_BYTES) {
      throw new Error('pdf_integer_token_too_large');
    }
    this.position += match[0].length;
    const value = Number(match[0]);
    return Number.isSafeInteger(value) ? value : null;
  }

  value(depth = 0) {
    if (depth > 64) throw new Error('pdf_value_depth_exceeded');
    this.skip();
    const character = this.source[this.position];
    if (this.source.startsWith('<<', this.position)) return this.dictionary(depth + 1);
    if (character === '[') return this.array(depth + 1);
    if (character === '/') return this.pdfName();
    if (character === '(') return this.literalString();
    if (character === '<') return this.hexString();
    if (this.source.startsWith('true', this.position)) {
      this.position += 4;
      return true;
    }
    if (this.source.startsWith('false', this.position)) {
      this.position += 5;
      return false;
    }
    if (this.source.startsWith('null', this.position)) {
      this.position += 4;
      return null;
    }
    NUMBER_TOKEN.lastIndex = this.position;
    const numberMatch = NUMBER_TOKEN.exec(this.source);
    if (!numberMatch) throw new Error('pdf_value_token_invalid');
    if (numberMatch[0].length > MAXIMUM_PDF_NUMBER_BYTES) {
      throw new Error('pdf_number_token_too_large');
    }
    this.position += numberMatch[0].length;
    const first = Number(numberMatch[0]);
    if (!Number.isFinite(first)) throw new Error('pdf_number_invalid');
    const afterFirst = this.position;
    if (Number.isSafeInteger(first) && first >= 0) {
      const second = this.rawInteger();
      if (second !== null && second >= 0 && this.keyword('R')) {
        return Object.freeze({ type: 'ref', objectNumber: first, generation: second });
      }
      this.position = afterFirst;
    }
    return first;
  }

  pdfName() {
    if (this.source[this.position] !== '/') throw new Error('pdf_name_invalid');
    this.position += 1;
    const start = this.position;
    while (this.position < this.source.length
      && !pdfDelimiter(this.source[this.position])) {
      this.position += 1;
      if (this.position - start > MAXIMUM_PDF_NAME_BYTES) {
        throw new Error('pdf_name_too_large');
      }
    }
    const encoded = this.source.slice(start, this.position);
    if (!encoded) throw new Error('pdf_name_empty');
    const decoded = encoded.replace(/#([0-9A-Fa-f]{2})/g, (_match, hex) => (
      String.fromCharCode(Number.parseInt(hex, 16))
    ));
    return Object.freeze({ type: 'name', value: decoded });
  }

  literalString() {
    this.position += 1;
    const start = this.position;
    let depth = 1;
    while (this.position < this.source.length && depth > 0) {
      const character = this.source[this.position];
      this.position += 1;
      if (character === '\\') {
        if (this.position < this.source.length) this.position += 1;
      } else if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      if (this.position - start > MAXIMUM_PDF_STRING_BYTES) {
        throw new Error('pdf_literal_string_too_large');
      }
    }
    if (depth !== 0) throw new Error('pdf_literal_string_unterminated');
    return Object.freeze({ type: 'string' });
  }

  hexString() {
    this.position += 1;
    const start = this.position;
    while (this.position < this.source.length && this.source[this.position] !== '>') {
      const character = this.source[this.position];
      if (!/[0-9A-Fa-f]/.test(character) && !pdfWhitespace(character)) {
        throw new Error('pdf_hex_string_invalid');
      }
      this.position += 1;
      if (this.position - start > MAXIMUM_PDF_STRING_BYTES) {
        throw new Error('pdf_hex_string_too_large');
      }
    }
    if (this.position >= this.source.length || this.position === start) {
      throw new Error('pdf_hex_string_unterminated');
    }
    this.position += 1;
    return Object.freeze({ type: 'string' });
  }

  array(depth) {
    this.position += 1;
    const result = [];
    while (result.length <= MAXIMUM_BOUNDED_PDF_OBJECTS) {
      this.skip();
      if (this.source[this.position] === ']') {
        this.position += 1;
        return Object.freeze(result);
      }
      result.push(this.value(depth));
    }
    throw new Error('pdf_array_too_large');
  }

  dictionary(depth) {
    this.position += 2;
    const result = new Map();
    while (result.size <= MAXIMUM_BOUNDED_PDF_OBJECTS) {
      this.skip();
      if (this.source.startsWith('>>', this.position)) {
        this.position += 2;
        return result;
      }
      const key = pdfNameValue(this.pdfName());
      if (result.has(key)) throw new Error('pdf_dictionary_key_duplicate');
      result.set(key, this.value(depth));
    }
    throw new Error('pdf_dictionary_too_large');
  }
}
