import { fail } from './source-evidence-git-inputs.mjs';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const JSON_WHITESPACE = '\t\n\r ';

class StrictJsonParser {
  constructor(text, label) {
    this.text = text;
    this.label = label;
    this.index = 0;
  }

  parse() {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) this.error('trailing_bytes');
    return value;
  }

  error(code) {
    fail('strict_json_invalid', `${this.label}:${code}@${this.index}`);
  }

  skipWhitespace() {
    while (this.index < this.text.length && JSON_WHITESPACE.includes(this.text[this.index])) {
      this.index += 1;
    }
  }

  parseValue() {
    this.skipWhitespace();
    const token = this.text[this.index];
    if (token === '{') return this.parseObject();
    if (token === '[') return this.parseArray();
    if (token === '"') return this.parseString();
    if (token === '-' || /[0-9]/u.test(token ?? '')) return this.parseNumber();
    if (this.text.startsWith('true', this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith('false', this.index)) {
      this.index += 5;
      return false;
    }
    if (this.text.startsWith('null', this.index)) {
      this.index += 4;
      return null;
    }
    this.error('unexpected_token');
  }

  parseObject() {
    const result = Object.create(null);
    const keys = new Set();
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      if (this.text[this.index] !== '"') this.error('object_key_required');
      const key = this.parseString();
      if (keys.has(key)) this.error(`duplicate_key:${key}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ':') this.error('colon_required');
      this.index += 1;
      result[key] = this.parseValue();
      this.skipWhitespace();
      if (this.text[this.index] === '}') {
        this.index += 1;
        return result;
      }
      if (this.text[this.index] !== ',') this.error('object_comma_required');
      this.index += 1;
      this.skipWhitespace();
    }
    this.error('unterminated_object');
  }

  parseArray() {
    const result = [];
    this.index += 1;
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      result.push(this.parseValue());
      this.skipWhitespace();
      if (this.text[this.index] === ']') {
        this.index += 1;
        return result;
      }
      if (this.text[this.index] !== ',') this.error('array_comma_required');
      this.index += 1;
      this.skipWhitespace();
    }
    this.error('unterminated_array');
  }

  parseString() {
    const start = this.index;
    this.index += 1;
    let escapedValue = false;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (!escapedValue && code === 0x22) {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index));
        } catch {
          this.error('string_decode');
        }
      }
      if (!escapedValue && code < 0x20) this.error('control_character');
      if (!escapedValue && code === 0x5c) {
        escapedValue = true;
        this.index += 1;
        continue;
      }
      escapedValue = false;
      this.index += 1;
    }
    this.error('unterminated_string');
  }

  parseNumber() {
    const fragment = this.text.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(fragment);
    if (!match) this.error('number_syntax');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.error('non_finite_number');
    return value;
  }
}

export function parseStrictJson(text, label = 'JSON') {
  if (typeof text !== 'string') fail('json_text_required', label);
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BYTES) fail('json_byte_limit', label);
  return new StrictJsonParser(text, label).parse();
}

