import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalClaimsFromWorkerPlan } from '../../paper-adapters/research-verify/canonical-claim-registry-reader.mjs';
import { readFormalClaimUniverse } from '../../paper-adapters/research-verify/formal-claim-universe-reader.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

function writeWorkspace(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-universe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), source);
  }
  return root;
}

function claimBinding(source, body, claimId) {
  const byteStart = Buffer.byteLength(source.slice(0, source.indexOf(body)));
  const bytes = Buffer.from(body);
  return {
    claimId,
    manuscriptSource: {
      path: 'main.tex',
      byteStart,
      byteEnd: byteStart + bytes.length,
      contentHash: hashBytes(bytes),
    },
  };
}

test('canonical registry blocks a second standard theorem omitted from author bindings', (t) => {
  const first = 'Every first fixture is deterministic.';
  const second = 'Every second fixture is deterministic.';
  const source = [
    `\\begin{theorem}${first}\\end{theorem}`,
    '\\begin{proof}By first construction.\\end{proof}',
    `\\begin{theorem}${second}\\end{theorem}`,
    '\\begin{proof}By second construction.\\end{proof}',
  ].join('\n');
  const root = writeWorkspace(t, { 'main.tex': source });
  const registry = canonicalClaimsFromWorkerPlan({
    sourceRoot: root,
    paperTask: { mainTex: 'main.tex' },
    plan: {
      workers: [{
        type: 'formal_verifier_lake',
        parameters: { claimBindings: [claimBinding(source, first, 'claim-first')] },
      }],
    },
  });
  assert.equal(registry.formalClaimUniverse.theorems.length, 2);
  assert.equal(registry.status, 'canonical_claim_registry_blocked');
  assert.ok(registry.blockers.includes('formal_claim_universe_theorem_unbound:main.tex#formal-theorem=2'));
  assert.ok(registry.blockers.includes('formal_claim_universe_binding_count_mismatch'));
});

test('custom newtheorem environments are included in the formal claim universe', (t) => {
  const root = writeWorkspace(t, {
    'main.tex': [
      '\\newtheorem{mainresult}{Main Result}',
      '\\begin{mainresult}A custom result.\\end{mainresult}',
      '\\begin{proof}By construction.\\end{proof}',
    ].join('\n'),
  });
  const universe = readFormalClaimUniverse({ sourceRoot: root });
  assert.equal(universe.status, 'formal_claim_universe_verified', JSON.stringify(universe.blockers));
  assert.deepEqual(universe.theorems.map((entry) => entry.environment), ['mainresult']);
  assert.equal(universe.environmentDeclarations[0].starred, false);
});

test('starred newtheorem environments are included in the formal claim universe', (t) => {
  const root = writeWorkspace(t, {
    'main.tex': [
      '\\newtheorem*{unnumberedresult}{Result}',
      '\\begin{unnumberedresult}An unnumbered result.\\end{unnumberedresult}',
      '\\begin{proof}By construction.\\end{proof}',
    ].join('\n'),
  });
  const universe = readFormalClaimUniverse({ sourceRoot: root });
  assert.equal(universe.status, 'formal_claim_universe_verified', JSON.stringify(universe.blockers));
  assert.deepEqual(universe.theorems.map((entry) => entry.environment), ['unnumberedresult']);
  assert.equal(universe.environmentDeclarations[0].starred, true);
});

test('recursive includes inherit safely identifiable newtheorem aliases', (t) => {
  const root = writeWorkspace(t, {
    'main.tex': [
      '\\newtheorem{result}{Result}',
      '\\newtheorem{resultalias}[result]{Result}',
      '\\input{sections/claim}',
    ].join('\n'),
    'sections/claim.tex': [
      '\\begin{resultalias}An included aliased result.\\end{resultalias}',
      '\\begin{proof}By construction.\\end{proof}',
    ].join('\n'),
  });
  const universe = readFormalClaimUniverse({ sourceRoot: root });
  assert.equal(universe.status, 'formal_claim_universe_verified', JSON.stringify(universe.blockers));
  assert.deepEqual(universe.files.map((entry) => entry.path), ['main.tex', 'sections/claim.tex']);
  assert.deepEqual(universe.theorems.map((entry) => [entry.manuscriptPath, entry.environment]), [
    ['sections/claim.tex', 'resultalias'],
  ]);
  assert.equal(universe.environmentDeclarations.find((entry) => entry.environment === 'resultalias').aliasOf, 'result');
});

test('unparseable theorem declarations fail closed', (t) => {
  const root = writeWorkspace(t, {
    'main.tex': [
      '\\newtheorem{\\dynamicname}{Result}',
      '\\begin{theorem}A visible fallback theorem.\\end{theorem}',
      '\\begin{proof}By construction.\\end{proof}',
    ].join('\n'),
  });
  const universe = readFormalClaimUniverse({ sourceRoot: root });
  assert.equal(universe.status, 'formal_claim_universe_blocked');
  assert.ok(universe.blockers.some((item) => item.startsWith('formal_claim_universe_theorem_environment_name_unsafe:main.tex:')));
});

test('theorem-producing macro definitions are masked and fail closed instead of being counted once', (t) => {
  const source = [
    '\\newcommand{\\claimthm}[1]{\\begin{theorem}#1\\end{theorem}\\begin{proof}Complete.\\end{proof}}',
    '\\claimthm{First generated claim.}',
    '\\claimthm{Second generated claim.}',
  ].join('\n');
  const root = writeWorkspace(t, { 'main.tex': source });
  const universe = readFormalClaimUniverse({ sourceRoot: root });
  assert.equal(universe.status, 'formal_claim_universe_blocked');
  assert.equal(universe.theorems.length, 0);
  assert.ok(universe.blockers.some((item) => (
    item.startsWith('formal_claim_universe_theorem_environment_macro_construction_unsupported:main.tex:')
  )));
});

test('ordinary macros do not block an explicit theorem and proof', (t) => {
  const root = writeWorkspace(t, {
    'main.tex': [
      '\\newcommand{\\fixturevector}[1]{\\mathbf{#1}}',
      '\\providecommand{\\fixturelabel}[1]{\\textbf{#1}}',
      '\\def\\fixtureidentity#1{#1}',
      '\\begin{theorem}An explicit result.\\end{theorem}',
      '\\begin{proof}By construction.\\end{proof}',
    ].join('\n'),
  });
  const universe = readFormalClaimUniverse({ sourceRoot: root });
  assert.equal(universe.status, 'formal_claim_universe_verified', JSON.stringify(universe.blockers));
  assert.equal(universe.theorems.length, 1);
});

test('unparseable TeX macro definitions cannot consume later theorem syntax', (t) => {
  const root = writeWorkspace(t, {
    'main.tex': [
      '\\def\\broken\\begin{theorem}Visible but source is unsafe.\\end{theorem}',
      '\\begin{proof}Visible proof.\\end{proof}',
    ].join('\n'),
  });
  const universe = readFormalClaimUniverse({ sourceRoot: root });
  assert.equal(universe.status, 'formal_claim_universe_blocked');
  assert.ok(universe.blockers.some((item) => (
    item.startsWith('formal_claim_universe_theorem_environment_macro_definition_unparseable:main.tex:')
  )));
});

test('dynamic TeX control sequences fail closed instead of hiding a generated theorem', (t) => {
  const cases = [
    {
      name: 'csname',
      source: [
        '\\def\\claim#1{\\csname begin\\endcsname{theorem}#1\\csname end\\endcsname{theorem}\\csname begin\\endcsname{proof}Done.\\csname end\\endcsname{proof}}',
        '\\claim{Hidden claim.}',
      ],
    },
    {
      name: 'expandafter',
      source: ['\\expandafter\\def\\csname claim\\endcsname#1{#1}'],
    },
    {
      name: 'let',
      source: ['\\let\\claimbegin\\begin'],
    },
  ];
  for (const fixture of cases) {
    const source = [
      ...fixture.source,
      '\\begin{theorem}Visible claim.\\end{theorem}',
      '\\begin{proof}Visible proof.\\end{proof}',
    ].join('\n');
    const root = writeWorkspace(t, { 'main.tex': source });
    const universe = readFormalClaimUniverse({ sourceRoot: root });
    assert.equal(universe.status, 'formal_claim_universe_blocked', fixture.name);
    assert.deepEqual(universe.theorems.map((entry) => entry.text), ['Visible claim.'], fixture.name);
    assert.ok(universe.blockers.some((item) => (
      item.startsWith('formal_claim_universe_theorem_environment_dynamic_control_sequence_unsupported:main.tex:')
    )), `${fixture.name}: ${JSON.stringify(universe.blockers)}`);
  }
});

test('dynamic and command-style environment invocation cannot bypass begin/end enumeration', (t) => {
  const cases = [
    {
      name: 'macro environment name',
      line: '\\newcommand{\\thmname}{theorem}\\begin{\\thmname}Hidden claim.\\end{\\thmname}',
      blocker: 'theorem_environment_dynamic_invocation_unsupported',
    },
    {
      name: 'command-style environment',
      line: '\\theorem Hidden claim.\\endtheorem \\proof Hidden proof.\\endproof',
      blocker: 'theorem_environment_direct_invocation_unsupported',
    },
  ];
  for (const fixture of cases) {
    const root = writeWorkspace(t, {
      'main.tex': [
        fixture.line,
        '\\begin{theorem}Visible claim.\\end{theorem}',
        '\\begin{proof}Visible proof.\\end{proof}',
      ].join('\n'),
    });
    const universe = readFormalClaimUniverse({ sourceRoot: root });
    assert.equal(universe.status, 'formal_claim_universe_blocked', fixture.name);
    assert.deepEqual(universe.theorems.map((entry) => entry.text), ['Visible claim.'], fixture.name);
    assert.ok(universe.blockers.some((item) => (
      item.startsWith(`formal_claim_universe_${fixture.blocker}:main.tex:`)
    )), `${fixture.name}: ${JSON.stringify(universe.blockers)}`);
  }
});

test('macro-generated includes fail closed and are not mistaken for literal corpus edges', (t) => {
  for (const definition of [
    '\\newcommand{\\loadclaim}{\\input{hidden}}',
    '\\def\\loadclaim{\\include{hidden}}',
  ]) {
    const root = writeWorkspace(t, {
      'main.tex': [
        definition,
        '\\loadclaim',
        '\\begin{theorem}Visible claim.\\end{theorem}',
        '\\begin{proof}Visible proof.\\end{proof}',
      ].join('\n'),
      'hidden.tex': [
        '\\begin{theorem}Hidden claim.\\end{theorem}',
        '\\begin{proof}Hidden proof.\\end{proof}',
      ].join('\n'),
    });
    const universe = readFormalClaimUniverse({ sourceRoot: root });
    assert.equal(universe.status, 'formal_claim_universe_blocked');
    assert.deepEqual(universe.files.map((entry) => entry.path), ['main.tex']);
    assert.deepEqual(universe.theorems.map((entry) => entry.text), ['Visible claim.']);
    assert.ok(universe.blockers.some((item) => (
      item.startsWith('formal_claim_universe_theorem_environment_macro_construction_unsupported:main.tex:')
    )));
  }
});

test('xparse, expl3, and non-allowlisted TeX include families fail closed', (t) => {
  const cases = [
    {
      name: 'xparse',
      line: '\\NewDocumentCommand{\\claim}{m}{#1}',
      blocker: 'theorem_environment_extended_macro_definition_unsupported',
    },
    {
      name: 'expl3',
      line: '\\ExplSyntaxOn \\cs_new:Npn \\claim:n #1 {#1} \\ExplSyntaxOff',
      blocker: 'theorem_environment_expl3_dynamic_syntax_unsupported',
    },
    {
      name: 'subfile',
      line: '\\subfile{hidden}',
      blocker: 'theorem_environment_include_command_unsupported',
    },
    {
      name: 'import',
      line: '\\import{sections/}{hidden.tex}',
      blocker: 'theorem_environment_include_command_unsupported',
    },
  ];
  for (const fixture of cases) {
    const root = writeWorkspace(t, {
      'main.tex': [
        fixture.line,
        '\\begin{theorem}Visible claim.\\end{theorem}',
        '\\begin{proof}Visible proof.\\end{proof}',
      ].join('\n'),
      'hidden.tex': '\\begin{theorem}Hidden claim.\\end{theorem}\n\\begin{proof}Hidden proof.\\end{proof}\n',
      'sections/hidden.tex': '\\begin{theorem}Imported claim.\\end{theorem}\n\\begin{proof}Imported proof.\\end{proof}\n',
    });
    const universe = readFormalClaimUniverse({ sourceRoot: root });
    assert.equal(universe.status, 'formal_claim_universe_blocked', fixture.name);
    assert.deepEqual(universe.files.map((entry) => entry.path), ['main.tex'], fixture.name);
    assert.ok(universe.blockers.some((item) => (
      item.startsWith(`formal_claim_universe_${fixture.blocker}:main.tex:`)
    )), `${fixture.name}: ${JSON.stringify(universe.blockers)}`);
  }
});

test('non-literal input and include paths fail closed', (t) => {
  for (const include of ['\\input\\claimfile', '\\include{\\claimfile}']) {
    const root = writeWorkspace(t, {
      'main.tex': [
        include,
        '\\begin{theorem}Visible claim.\\end{theorem}',
        '\\begin{proof}Visible proof.\\end{proof}',
      ].join('\n'),
    });
    const universe = readFormalClaimUniverse({ sourceRoot: root });
    assert.equal(universe.status, 'formal_claim_universe_blocked');
    assert.ok(universe.blockers.some((item) => (
      item.startsWith('formal_claim_universe_include_not_literal:main.tex:')
      || item.startsWith('formal_claim_universe_include_path_invalid:main.tex:')
    )), JSON.stringify(universe.blockers));
  }
});

test('dynamic-looking syntax in comments does not block literal recursive includes', (t) => {
  const root = writeWorkspace(t, {
    'main.tex': [
      '% \\csname begin\\endcsname{theorem} ignored',
      '% \\subfile{ignored}',
      '\\input{sections/claim}',
    ].join('\n'),
    'sections/claim.tex': [
      '\\newcommand{\\fixturevector}[1]{\\mathbf{#1}}',
      '\\begin{theorem}Included literal claim.\\end{theorem}',
      '\\begin{proof}Included literal proof.\\end{proof}',
    ].join('\n'),
  });
  const universe = readFormalClaimUniverse({ sourceRoot: root });
  assert.equal(universe.status, 'formal_claim_universe_verified', JSON.stringify(universe.blockers));
  assert.deepEqual(universe.files.map((entry) => entry.path), ['main.tex', 'sections/claim.tex']);
  assert.deepEqual(universe.theorems.map((entry) => entry.text), ['Included literal claim.']);
});
