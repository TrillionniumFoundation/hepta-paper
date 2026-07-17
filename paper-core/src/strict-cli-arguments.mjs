function normalizedSet(values = []) {
  return new Set(values.map((value) => String(value)));
}

function optionToken(key) {
  return `--${key}`;
}

export function parseStrictCliArguments(argv, {
  booleanFlags = [],
  valueFlags = [],
  repeatableValueFlags = [],
  positional = true,
  maximumPositionals = Number.POSITIVE_INFINITY,
  removedFlags = {},
} = {}) {
  const booleans = normalizedSet(booleanFlags);
  const values = normalizedSet(valueFlags);
  const repeatable = normalizedSet(repeatableValueFlags);
  const removed = new Map(Object.entries(removedFlags));
  const parsed = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === '--') throw new Error('unexpected_cli_argument_separator');
    if (!token.startsWith('--')) {
      if (!positional) throw new Error(`unexpected_cli_positional:${token}`);
      parsed._.push(token);
      if (parsed._.length > maximumPositionals) throw new Error(`too_many_cli_positionals:${parsed._.length}`);
      continue;
    }

    const raw = token.slice(2);
    const separator = raw.indexOf('=');
    const key = separator < 0 ? raw : raw.slice(0, separator);
    const inlineValue = separator < 0 ? null : raw.slice(separator + 1);
    if (!key) throw new Error('empty_cli_option');
    if (removed.has(key)) throw new Error(removed.get(key));
    if (booleans.has(key)) {
      if (inlineValue !== null) throw new Error(`boolean_cli_option_does_not_take_value:${optionToken(key)}`);
      if (Object.hasOwn(parsed, key)) throw new Error(`duplicate_cli_option:${optionToken(key)}`);
      parsed[key] = true;
      continue;
    }
    if (!values.has(key) && !repeatable.has(key)) throw new Error(`unknown_cli_option:${optionToken(key)}`);

    let value = inlineValue;
    if (value === null) {
      const next = argv[index + 1];
      if (next === undefined || String(next).startsWith('--')) throw new Error(`missing_cli_option_value:${optionToken(key)}`);
      value = String(next);
      index += 1;
    }
    if (value.length === 0) throw new Error(`empty_cli_option_value:${optionToken(key)}`);
    if (repeatable.has(key)) {
      parsed[key] ||= [];
      parsed[key].push(value);
    } else {
      if (Object.hasOwn(parsed, key)) throw new Error(`duplicate_cli_option:${optionToken(key)}`);
      parsed[key] = value;
    }
  }
  return parsed;
}
