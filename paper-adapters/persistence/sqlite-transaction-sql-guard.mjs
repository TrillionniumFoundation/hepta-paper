// Statement boundaries follow SQLite's public-domain sqlite3_complete() state
// machine (complete.c), including CREATE [TEMP] TRIGGER ... ; END; bodies.
// This is a transaction-control guard, not a replacement for SQLite's SQL parser.
const CONTROL = new Set(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);
const TOKEN = Object.freeze({ SEMI: 0, OTHER: 2, EXPLAIN: 3, CREATE: 4, TEMP: 5, TRIGGER: 6, END: 7 });
const KEYWORD_TOKENS = Object.freeze({ EXPLAIN: 3, CREATE: 4, TEMP: 5, TEMPORARY: 5, TRIGGER: 6, END: 7 });
const TRANSITIONS = [
  [1, 0, 2, 3, 4, 2, 2, 2], // no token yet
  [1, 1, 2, 3, 4, 2, 2, 2], // between complete statements
  [1, 2, 2, 2, 2, 2, 2, 2], // ordinary statement
  [1, 3, 3, 2, 4, 2, 2, 2], // EXPLAIN prefix
  [1, 4, 2, 2, 2, 4, 5, 2], // CREATE [TEMP|TEMPORARY]
  [6, 5, 5, 5, 5, 5, 5, 5], // trigger body
  [6, 6, 5, 5, 5, 5, 5, 7], // trigger body after semicolon
  [1, 7, 5, 5, 5, 5, 5, 5], // trigger body after ; END
];
const identifierCharacter = (character) => character !== undefined
  && (/[A-Za-z0-9_$]/.test(character) || character.charCodeAt(0) >= 0x80);

/** Reject transaction ownership changes in a scoped synchronous unit of work. */
export function assertNoSqliteTransactionControl(sql) {
  if (typeof sql !== 'string') throw new TypeError('sqlite_transaction_sql_text_required');
  let state = 0;
  let offset = 0;
  while (offset < sql.length) {
    const character = sql[offset];
    if (/[ \r\t\n\f]/.test(character) || character === '\uFEFF') { offset += 1; continue; }
    if (character === '-' && sql[offset + 1] === '-') {
      const end = sql.indexOf('\n', offset + 2);
      offset = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (character === '/' && sql[offset + 1] === '*') {
      const end = sql.indexOf('*/', offset + 2);
      offset = end < 0 ? sql.length : end + 2;
      continue;
    }
    let token = TOKEN.OTHER;
    if (character === ';') {
      token = TOKEN.SEMI;
      offset += 1;
    } else if (character === '[') {
      const end = sql.indexOf(']', offset + 1);
      offset = end < 0 ? sql.length : end + 1;
    } else if (["'", '"', '`'].includes(character)) {
      offset += 1;
      while (offset < sql.length) {
        if (sql[offset] !== character) { offset += 1; continue; }
        if (sql[offset + 1] === character) { offset += 2; continue; }
        offset += 1;
        break;
      }
    } else if (identifierCharacter(character)) {
      const start = offset;
      while (identifierCharacter(sql[offset])) offset += 1;
      const word = sql.slice(start, offset).toUpperCase();
      if ((state === 0 || state === 1) && CONTROL.has(word)) {
        throw new Error('sqlite_transaction_control_statement_forbidden');
      }
      token = KEYWORD_TOKENS[word] ?? TOKEN.OTHER;
    } else {
      offset += 1;
    }
    state = TRANSITIONS[state][token];
  }
}
