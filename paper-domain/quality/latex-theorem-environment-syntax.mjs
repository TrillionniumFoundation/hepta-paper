export const STANDARD_THEOREM_ENVIRONMENTS = Object.freeze([
  'theorem',
  'lemma',
  'proposition',
  'corollary',
  'inputcondition',
]);

const SAFE_ENVIRONMENT_NAME = /^[A-Za-z][A-Za-z0-9:_-]*\*?$/;
const SAFE_COUNTER_NAME = /^[A-Za-z][A-Za-z0-9:@_-]*$/;
const SAFE_MACRO_NAME = /^\\[A-Za-z@]+$/;
const NEW_THEOREM_COMMAND = /\\newtheorem(?![A-Za-z@])/g;
const UNSUPPORTED_THEOREM_COMMAND = /\\(?:declaretheorem|spnewtheorem|newshadetheorem)(?![A-Za-z@])/g;
const LATEX_MACRO_DEFINITION_COMMAND = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand)(?![A-Za-z@])/g;
const TEX_MACRO_DEFINITION_COMMAND = /\\(def|gdef|edef|xdef)(?![A-Za-z@])/g;
const DYNAMIC_CONTROL_SEQUENCE_COMMAND = /\\(?:csname|endcsname|expandafter|let)(?![A-Za-z@])/g;
const XPARSE_DEFINITION_COMMAND = /\\(?:New|Renew|Provide|Declare)(?:Expandable)?Document(?:Command|Environment)(?![A-Za-z@])/g;
const EXPL3_DYNAMIC_COMMAND = /\\(?:ExplSyntax(?:On|Off)|[A-Za-z]+(?:_[A-Za-z]+)+:[A-Za-z]*|(?:use|exp_args):[A-Za-z]+)(?![A-Za-z@])/g;
const ENVIRONMENT_DEFINITION_COMMAND = /\\(?:newenvironment|renewenvironment)(?![A-Za-z@])/g;
const INCLUDE_COMMAND = /\\(?:input|include)(?![A-Za-z@])/g;
const INCLUDE_LIKE_COMMAND = /\\([A-Za-z@]*(?:input|include|import|subfile)[A-Za-z@]*)(?![A-Za-z@])/gi;
const NON_SOURCE_INCLUDE_COMMANDS = new Set(['includegraphics', 'includeonly', 'inputencoding']);
const SAFE_LITERAL_INCLUDE_VALUE = /^[A-Za-z0-9._/-]+$/;
const ENVIRONMENT_TOKEN = /\\(begin|end)\s*\{([^{}\r\n]+)\}(?:\s*\[[^\]\r\n]*\])?/g;
const ENVIRONMENT_COMMAND = /\\(begin|end)(?![A-Za-z@])\s*/g;

function escapedAt(source, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

export function maskLatexComments(source) {
  const chars = String(source || '').split('');
  let comment = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === '\n' || char === '\r') {
      comment = false;
      continue;
    }
    if (!comment && char === '%' && !escapedAt(chars, index)) comment = true;
    if (comment) chars[index] = ' ';
  }
  return chars.join('');
}

function whitespaceEnd(source, start) {
  let cursor = start;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  return cursor;
}

function delimited(source, start, open, close) {
  if (source[start] !== open) return null;
  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    if (escapedAt(source, cursor)) continue;
    if (source[cursor] === open) depth += 1;
    if (source[cursor] !== close) continue;
    depth -= 1;
    if (depth === 0) {
      return Object.freeze({
        start,
        end: cursor + 1,
        value: source.slice(start + 1, cursor),
      });
    }
  }
  return null;
}

function declarationBlocker(code, offset) {
  return Object.freeze({ code, offset });
}

function controlSequence(source, start) {
  if (source[start] !== '\\') return null;
  let cursor = start + 1;
  if (/[A-Za-z@]/.test(source[cursor] || '')) {
    while (cursor < source.length && /[A-Za-z@]/.test(source[cursor])) cursor += 1;
  } else if (cursor < source.length) cursor += 1;
  else return null;
  return Object.freeze({ value: source.slice(start, cursor), end: cursor });
}

function latexMacroDefinition(masked, match) {
  let cursor = whitespaceEnd(masked, match.index + match[0].length);
  if (masked[cursor] === '*') cursor = whitespaceEnd(masked, cursor + 1);
  let macroName = null;
  if (masked[cursor] === '{') {
    const nameGroup = delimited(masked, cursor, '{', '}');
    if (!nameGroup) return null;
    macroName = nameGroup.value.trim();
    cursor = whitespaceEnd(masked, nameGroup.end);
  } else {
    const nameToken = controlSequence(masked, cursor);
    if (!nameToken) return null;
    macroName = nameToken.value;
    cursor = whitespaceEnd(masked, nameToken.end);
  }
  for (let optionalIndex = 0; optionalIndex < 2 && masked[cursor] === '['; optionalIndex += 1) {
    const optional = delimited(masked, cursor, '[', ']');
    if (!optional) return null;
    cursor = whitespaceEnd(masked, optional.end);
  }
  const body = delimited(masked, cursor, '{', '}');
  if (!body) return null;
  return Object.freeze({
    command: match[1],
    macroName: SAFE_MACRO_NAME.test(macroName) ? macroName : null,
    offsetStart: match.index,
    offsetEnd: body.end,
    bodyStart: body.start + 1,
    bodyEnd: body.end - 1,
  });
}

function texMacroDefinition(masked, match) {
  let cursor = whitespaceEnd(masked, match.index + match[0].length);
  const nameToken = controlSequence(masked, cursor);
  if (!nameToken) return null;
  cursor = nameToken.end;
  while (cursor < masked.length && masked[cursor] !== '{') cursor += 1;
  const parameterText = masked.slice(nameToken.end, cursor);
  if (!/^(?:\s*#[1-9])*\s*$/.test(parameterText)) return null;
  const body = delimited(masked, cursor, '{', '}');
  if (!body) return null;
  return Object.freeze({
    command: match[1],
    macroName: SAFE_MACRO_NAME.test(nameToken.value) ? nameToken.value : null,
    offsetStart: match.index,
    offsetEnd: body.end,
    bodyStart: body.start + 1,
    bodyEnd: body.end - 1,
  });
}

function parseMacroDefinitions(masked) {
  const definitions = [];
  const blockers = [];
  LATEX_MACRO_DEFINITION_COMMAND.lastIndex = 0;
  for (const match of masked.matchAll(LATEX_MACRO_DEFINITION_COMMAND)) {
    const definition = latexMacroDefinition(masked, match);
    if (definition?.macroName) definitions.push(definition);
    else blockers.push(declarationBlocker('theorem_environment_macro_definition_unparseable', match.index));
  }
  TEX_MACRO_DEFINITION_COMMAND.lastIndex = 0;
  for (const match of masked.matchAll(TEX_MACRO_DEFINITION_COMMAND)) {
    const definition = texMacroDefinition(masked, match);
    if (definition?.macroName) definitions.push(definition);
    else blockers.push(declarationBlocker('theorem_environment_macro_definition_unparseable', match.index));
  }
  return Object.freeze({
    definitions: definitions.sort((left, right) => left.offsetStart - right.offsetStart),
    blockers,
  });
}

function maskMacroDefinitionBodies(source, definitions) {
  const chars = String(source || '').split('');
  for (const definition of definitions) {
    for (let index = definition.bodyStart; index < definition.bodyEnd; index += 1) {
      if (chars[index] !== '\r' && chars[index] !== '\n') chars[index] = ' ';
    }
  }
  return chars.join('');
}

function environmentConstruction(body, formalEnvironmentSet) {
  NEW_THEOREM_COMMAND.lastIndex = 0;
  if ([...body.matchAll(NEW_THEOREM_COMMAND)].some((match) => !escapedAt(body, match.index))) return true;
  UNSUPPORTED_THEOREM_COMMAND.lastIndex = 0;
  if ([...body.matchAll(UNSUPPORTED_THEOREM_COMMAND)].some((match) => !escapedAt(body, match.index))) return true;
  INCLUDE_COMMAND.lastIndex = 0;
  if ([...body.matchAll(INCLUDE_COMMAND)].some((match) => !escapedAt(body, match.index))) return true;
  INCLUDE_LIKE_COMMAND.lastIndex = 0;
  if ([...body.matchAll(INCLUDE_LIKE_COMMAND)].some((match) => (
    !escapedAt(body, match.index) && !NON_SOURCE_INCLUDE_COMMANDS.has(match[1].toLowerCase())
  ))) return true;
  DYNAMIC_CONTROL_SEQUENCE_COMMAND.lastIndex = 0;
  if ([...body.matchAll(DYNAMIC_CONTROL_SEQUENCE_COMMAND)].some((match) => !escapedAt(body, match.index))) return true;
  XPARSE_DEFINITION_COMMAND.lastIndex = 0;
  if ([...body.matchAll(XPARSE_DEFINITION_COMMAND)].some((match) => !escapedAt(body, match.index))) return true;
  EXPL3_DYNAMIC_COMMAND.lastIndex = 0;
  if ([...body.matchAll(EXPL3_DYNAMIC_COMMAND)].some((match) => !escapedAt(body, match.index))) return true;
  ENVIRONMENT_DEFINITION_COMMAND.lastIndex = 0;
  if ([...body.matchAll(ENVIRONMENT_DEFINITION_COMMAND)].some((match) => !escapedAt(body, match.index))) return true;
  ENVIRONMENT_COMMAND.lastIndex = 0;
  for (const match of body.matchAll(ENVIRONMENT_COMMAND)) {
    if (escapedAt(body, match.index)) continue;
    const cursor = whitespaceEnd(body, match.index + match[0].length);
    const environmentGroup = delimited(body, cursor, '{', '}');
    if (!environmentGroup) return true;
    const environment = environmentGroup.value.trim();
    if (!SAFE_ENVIRONMENT_NAME.test(environment)) return true;
    if (environment === 'proof' || formalEnvironmentSet.has(environment)) return true;
  }
  const directEnvironmentCommands = new Set(['proof', ...formalEnvironmentSet]);
  for (const match of body.matchAll(/\\([A-Za-z@]+)(?![A-Za-z@])/g)) {
    if (escapedAt(body, match.index)) continue;
    if (directEnvironmentCommands.has(match[1]) || (
      match[1].startsWith('end') && directEnvironmentCommands.has(match[1].slice(3))
    )) return true;
  }
  return false;
}

function unsupportedSourceSyntax(masked) {
  const blockers = [];
  const collect = (pattern, code, predicate = () => true) => {
    pattern.lastIndex = 0;
    for (const match of masked.matchAll(pattern)) {
      if (!escapedAt(masked, match.index) && predicate(match)) {
        blockers.push(declarationBlocker(code, match.index));
      }
    }
  };
  collect(
    DYNAMIC_CONTROL_SEQUENCE_COMMAND,
    'theorem_environment_dynamic_control_sequence_unsupported',
  );
  collect(
    XPARSE_DEFINITION_COMMAND,
    'theorem_environment_extended_macro_definition_unsupported',
  );
  collect(
    EXPL3_DYNAMIC_COMMAND,
    'theorem_environment_expl3_dynamic_syntax_unsupported',
  );
  collect(
    ENVIRONMENT_DEFINITION_COMMAND,
    'theorem_environment_definition_command_unsupported',
  );
  collect(
    INCLUDE_LIKE_COMMAND,
    'theorem_environment_include_command_unsupported',
    (match) => !['input', 'include'].includes(match[1].toLowerCase())
      && !NON_SOURCE_INCLUDE_COMMANDS.has(match[1].toLowerCase()),
  );
  return blockers;
}

function unsupportedEnvironmentInvocationSyntax(masked, formalEnvironmentSet) {
  const blockers = [];
  ENVIRONMENT_COMMAND.lastIndex = 0;
  for (const match of masked.matchAll(ENVIRONMENT_COMMAND)) {
    if (escapedAt(masked, match.index)) continue;
    const cursor = whitespaceEnd(masked, match.index + match[0].length);
    const environmentGroup = delimited(masked, cursor, '{', '}');
    if (!environmentGroup || !SAFE_ENVIRONMENT_NAME.test(environmentGroup.value.trim())) {
      blockers.push(declarationBlocker(
        'theorem_environment_dynamic_invocation_unsupported',
        match.index,
      ));
    }
  }
  const directEnvironmentCommands = new Set(['proof', ...formalEnvironmentSet]);
  for (const match of masked.matchAll(/\\([A-Za-z@]+)(?![A-Za-z@])/g)) {
    if (escapedAt(masked, match.index)) continue;
    if (directEnvironmentCommands.has(match[1]) || (
      match[1].startsWith('end') && directEnvironmentCommands.has(match[1].slice(3))
    )) {
      blockers.push(declarationBlocker(
        'theorem_environment_direct_invocation_unsupported',
        match.index,
      ));
    }
  }
  return blockers;
}

function unsupportedLiteralIncludeSyntax(masked) {
  const blockers = [];
  INCLUDE_COMMAND.lastIndex = 0;
  let match;
  while ((match = INCLUDE_COMMAND.exec(masked)) !== null) {
    if (escapedAt(masked, match.index)) continue;
    let cursor = whitespaceEnd(masked, match.index + match[0].length);
    if (masked[cursor] !== '{') {
      blockers.push(declarationBlocker('theorem_environment_dynamic_include_unsupported', match.index));
      continue;
    }
    const end = masked.indexOf('}', cursor + 1);
    const value = end < 0 ? '' : masked.slice(cursor + 1, end).trim();
    if (end < 0 || value.includes('{') || !SAFE_LITERAL_INCLUDE_VALUE.test(value)) {
      blockers.push(declarationBlocker('theorem_environment_dynamic_include_unsupported', match.index));
      continue;
    }
    cursor = end + 1;
    INCLUDE_COMMAND.lastIndex = cursor;
  }
  return blockers;
}

export function analyzeTheoremEnvironmentMacroDefinitions(source, { theoremEnvironments = [] } = {}) {
  const commentsMasked = maskLatexComments(source);
  const parsed = parseMacroDefinitions(commentsMasked);
  const { definitions } = parsed;
  const formalEnvironmentSet = new Set([...STANDARD_THEOREM_ENVIRONMENTS, ...theoremEnvironments]);
  const maskedSource = maskMacroDefinitionBodies(commentsMasked, definitions);
  const blockers = [
    ...parsed.blockers,
    ...unsupportedSourceSyntax(commentsMasked),
    ...unsupportedEnvironmentInvocationSyntax(maskedSource, formalEnvironmentSet),
    ...unsupportedLiteralIncludeSyntax(maskedSource),
  ];
  for (const definition of definitions) {
    const body = commentsMasked.slice(definition.bodyStart, definition.bodyEnd);
    if (environmentConstruction(body, formalEnvironmentSet)) {
      blockers.push(declarationBlocker('theorem_environment_macro_construction_unsupported', definition.offsetStart));
    }
  }
  return Object.freeze({
    definitions: Object.freeze(definitions),
    blockers: Object.freeze(blockers),
    maskedSource,
  });
}

function parseDeclaration(masked, start) {
  let cursor = whitespaceEnd(masked, start + '\\newtheorem'.length);
  const starred = masked[cursor] === '*';
  if (starred) cursor = whitespaceEnd(masked, cursor + 1);

  const environmentGroup = delimited(masked, cursor, '{', '}');
  if (!environmentGroup) return { blocker: declarationBlocker('theorem_environment_declaration_unparseable', start) };
  const environment = environmentGroup.value.trim();
  if (!SAFE_ENVIRONMENT_NAME.test(environment)) {
    return { blocker: declarationBlocker('theorem_environment_name_unsafe', start), end: environmentGroup.end };
  }
  cursor = whitespaceEnd(masked, environmentGroup.end);

  let aliasOf = null;
  if (masked[cursor] === '[') {
    const aliasGroup = delimited(masked, cursor, '[', ']');
    if (!aliasGroup) return { blocker: declarationBlocker('theorem_environment_declaration_unparseable', start) };
    aliasOf = aliasGroup.value.trim();
    if (!SAFE_COUNTER_NAME.test(aliasOf)) {
      return { blocker: declarationBlocker('theorem_environment_alias_unsafe', start), end: aliasGroup.end };
    }
    cursor = whitespaceEnd(masked, aliasGroup.end);
  }

  const captionGroup = delimited(masked, cursor, '{', '}');
  if (!captionGroup) return { blocker: declarationBlocker('theorem_environment_declaration_unparseable', start) };
  if (!captionGroup.value.trim()) {
    return { blocker: declarationBlocker('theorem_environment_caption_missing', start), end: captionGroup.end };
  }
  cursor = whitespaceEnd(masked, captionGroup.end);

  let within = null;
  if (masked[cursor] === '[') {
    const withinGroup = delimited(masked, cursor, '[', ']');
    if (!withinGroup) return { blocker: declarationBlocker('theorem_environment_declaration_unparseable', start) };
    within = withinGroup.value.trim();
    if (!SAFE_COUNTER_NAME.test(within)) {
      return { blocker: declarationBlocker('theorem_environment_parent_counter_unsafe', start), end: withinGroup.end };
    }
    cursor = withinGroup.end;
  }
  if (starred && (aliasOf || within)) {
    return { blocker: declarationBlocker('theorem_environment_starred_counter_configuration_invalid', start), end: cursor };
  }
  if (aliasOf && within) {
    return { blocker: declarationBlocker('theorem_environment_alias_and_parent_counter_conflict', start), end: cursor };
  }
  return {
    declaration: Object.freeze({
      environment,
      starred,
      aliasOf,
      within,
      offsetStart: start,
      offsetEnd: cursor,
    }),
    end: cursor,
  };
}

export function parseNewTheoremDeclarations(source) {
  const macroSyntax = analyzeTheoremEnvironmentMacroDefinitions(source);
  const masked = macroSyntax.maskedSource;
  const declarations = [];
  const blockers = [];
  NEW_THEOREM_COMMAND.lastIndex = 0;
  let match;
  while ((match = NEW_THEOREM_COMMAND.exec(masked)) !== null) {
    const parsed = parseDeclaration(masked, match.index);
    if (parsed.declaration) declarations.push(parsed.declaration);
    if (parsed.blocker) blockers.push(parsed.blocker);
    NEW_THEOREM_COMMAND.lastIndex = Math.max(NEW_THEOREM_COMMAND.lastIndex, parsed.end || (match.index + match[0].length));
  }
  UNSUPPORTED_THEOREM_COMMAND.lastIndex = 0;
  for (const unsupported of masked.matchAll(UNSUPPORTED_THEOREM_COMMAND)) {
    blockers.push(declarationBlocker('theorem_environment_declaration_unsupported', unsupported.index));
  }
  return Object.freeze({
    declarations: Object.freeze(declarations),
    blockers: Object.freeze(blockers),
  });
}

export function analyzeLatexTheoremEnvironments(source) {
  const parsed = parseNewTheoremDeclarations(source);
  const theoremEnvironments = new Set(STANDARD_THEOREM_ENVIRONMENTS);
  for (const declaration of parsed.declarations) theoremEnvironments.add(declaration.environment);
  const macroSyntax = analyzeTheoremEnvironmentMacroDefinitions(source, { theoremEnvironments });
  const masked = macroSyntax.maskedSource;
  let theoremStatementCount = 0;
  let proofEnvironmentCount = 0;
  const theoremProofPairingBlockers = [];
  let openTheorem = null;
  let theoremAwaitingProof = null;
  let openProof = null;
  ENVIRONMENT_TOKEN.lastIndex = 0;
  for (const match of masked.matchAll(ENVIRONMENT_TOKEN)) {
    const environment = match[2].trim();
    const theoremEnvironment = theoremEnvironments.has(environment);
    if (!theoremEnvironment && environment !== 'proof') continue;
    if (match[1] === 'begin') {
      if (theoremEnvironment) {
        theoremStatementCount += 1;
        if (openTheorem || openProof || theoremAwaitingProof) {
          theoremProofPairingBlockers.push(declarationBlocker('theorem_proof_pairing_theorem_before_prior_proof', match.index));
        }
        openTheorem = { environment, offset: match.index };
      } else {
        proofEnvironmentCount += 1;
        if (openTheorem || openProof || !theoremAwaitingProof) {
          theoremProofPairingBlockers.push(declarationBlocker('theorem_proof_pairing_orphan_proof', match.index));
        }
        openProof = { offset: match.index };
      }
      continue;
    }
    if (theoremEnvironment) {
      if (!openTheorem || openTheorem.environment !== environment) {
        theoremProofPairingBlockers.push(declarationBlocker('theorem_proof_pairing_unmatched_theorem_end', match.index));
      } else {
        theoremAwaitingProof = openTheorem;
        openTheorem = null;
      }
    } else if (!openProof) {
      theoremProofPairingBlockers.push(declarationBlocker('theorem_proof_pairing_unmatched_proof_end', match.index));
    } else {
      openProof = null;
      theoremAwaitingProof = null;
    }
  }
  if (openTheorem || theoremAwaitingProof) {
    theoremProofPairingBlockers.push(declarationBlocker('theorem_proof_pairing_missing_proof', openTheorem?.offset ?? theoremAwaitingProof?.offset ?? masked.length));
  }
  if (openProof) theoremProofPairingBlockers.push(declarationBlocker('theorem_proof_pairing_unclosed_proof', openProof.offset));
  return Object.freeze({
    theoremEnvironments: Object.freeze([...theoremEnvironments].sort()),
    declarations: parsed.declarations,
    macroDefinitions: macroSyntax.definitions,
    blockers: Object.freeze([...parsed.blockers, ...macroSyntax.blockers]),
    theoremStatementCount,
    proofEnvironmentCount,
    theoremProofPairingBlockers: Object.freeze(theoremProofPairingBlockers),
  });
}
