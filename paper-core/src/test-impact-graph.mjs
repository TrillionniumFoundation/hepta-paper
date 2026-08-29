import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { relativeModuleSpecifiers } from '../verification/javascript-module-specifiers.mjs';

const PORTABLE_TEST = /^(?:paper-core|migration)\/tests\/.*\.test\.mjs$/;
const DOCUMENTATION = /^(?:README|RELEASE|CHANGELOG)\.md$|^(?:docs|paper-core\/docs|paper-adapters)\/.*\.md$/;
const RUST_ISOLATED = /^(?:rust\/|\.github\/workflows\/(?:rust-[^/]+|exact-head-source-validation)\.ya?ml$|docs\/rust\/qualification\/)/;
const GLOBAL_IMPACT = Object.freeze([
  /^\.github\//,
  /^package(?:-lock)?\.json$/,
  /^core\//,
  /^runtime-images\//,
  /^paper-core\/config\//,
  /^paper-core\/verification\//,
  /^migration\/(?:legacy-|compatibility-|capability-)/,
  /^paper-core\/src\/(?:architecture-entrypoint-manifest|command-registry(?:-catalog|-support-routes)?|test-suite-manifest)\.mjs$/,
]);

function repositoryPath(value) {
  const normalized = path.posix.normalize(String(value || '').replaceAll('\\', '/'))
    .replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/')
    || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`test_impact_repository_path_invalid:${value || '<empty>'}`);
  }
  return normalized;
}

function resolveModule(importer, specifier, moduleSet) {
  const base = path.posix.normalize(path.posix.join(
    path.posix.dirname(importer),
    specifier,
  ));
  return [base, `${base}.mjs`, path.posix.join(base, 'index.mjs')]
    .find((candidate) => moduleSet.has(candidate)) || null;
}

function sourceReferences(importer, source, fileSet) {
  const references = new Set();
  const pattern = /(['"])([^'"\r\n]+)\1/g;
  for (const match of String(source || '').matchAll(pattern)) {
    const value = match[2];
    if (!value.includes('/') || value.includes('*')) continue;
    let candidate = null;
    if (value.startsWith('.')) {
      candidate = path.posix.normalize(path.posix.join(
        path.posix.dirname(importer),
        value,
      ));
    } else if (/^(?:paper-[^/]+|workflow-kernel|migration|runtime-images|core)\//.test(value)) {
      candidate = path.posix.normalize(value);
    }
    if (candidate && fileSet.has(candidate)) references.add(candidate);
  }
  return [...references].sort();
}

export function isPortableTestFile(file) {
  return PORTABLE_TEST.test(repositoryPath(file));
}

export function buildTestImpactGraph({ files, readSource }) {
  if (!Array.isArray(files) || typeof readSource !== 'function') {
    throw new Error('test_impact_graph_input_invalid');
  }
  const repositoryFiles = Object.freeze([...new Set(files.map(repositoryPath))].sort());
  const fileSet = new Set(repositoryFiles);
  const modules = repositoryFiles.filter((file) => file.endsWith('.mjs'));
  const moduleSet = new Set(modules);
  const tests = Object.freeze(repositoryFiles.filter(isPortableTestFile));
  const edges = [];
  const testReferences = [];
  for (const importer of modules) {
    const source = String(readSource(importer) || '');
    for (const specifier of relativeModuleSpecifiers(source)) {
      const dependency = resolveModule(importer, specifier, moduleSet);
      if (dependency) edges.push(Object.freeze({ importer, dependency }));
    }
    if (isPortableTestFile(importer)) {
      testReferences.push(Object.freeze({
        test: importer,
        references: Object.freeze(sourceReferences(importer, source, fileSet)),
      }));
    }
  }
  edges.sort((left, right) => left.importer.localeCompare(right.importer)
    || left.dependency.localeCompare(right.dependency));
  testReferences.sort((left, right) => left.test.localeCompare(right.test));
  const payload = {
    version: 1,
    kind: 'TestImpactGraph',
    status: 'test_impact_graph_ready',
    repositoryFileCount: repositoryFiles.length,
    moduleCount: modules.length,
    testCount: tests.length,
    repositoryFiles,
    tests,
    edges: Object.freeze(edges),
    testReferences: Object.freeze(testReferences),
  };
  return Object.freeze({
    ...payload,
    testImpactGraphHash: hashRecord('TestImpactGraph', payload),
  });
}

function fullFallbackRequired(changedFiles) {
  return changedFiles.filter((file) => (
    !RUST_ISOLATED.test(file)
      && (GLOBAL_IMPACT.some((pattern) => pattern.test(file))
        || (!file.endsWith('.mjs') && !DOCUMENTATION.test(file)))
  ));
}

export function selectImpactedTests({ graph, changedFiles }) {
  if (graph?.status !== 'test_impact_graph_ready' || !Array.isArray(changedFiles)) {
    throw new Error('test_impact_selection_input_invalid');
  }
  const changed = Object.freeze([...new Set(changedFiles.map(repositoryPath))].sort());
  const globalFallbackFiles = fullFallbackRequired(changed);
  const reverse = new Map();
  for (const { importer, dependency } of graph.edges) {
    const importers = reverse.get(dependency) || [];
    importers.push(importer);
    reverse.set(dependency, importers);
  }
  const reached = new Set(changed);
  const pending = [...changed];
  while (pending.length) {
    const dependency = pending.pop();
    for (const importer of reverse.get(dependency) || []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      pending.push(importer);
    }
  }
  const selected = new Set(graph.tests.filter((testFile) => reached.has(testFile)));
  for (const entry of graph.testReferences) {
    if (entry.references.some((reference) => changed.includes(reference))) {
      selected.add(entry.test);
    }
  }
  const testSet = new Set(graph.tests);
  for (const file of changed) {
    if (testSet.has(file)) selected.add(file);
  }
  const referencedByTest = new Set(graph.testReferences.flatMap((entry) => (
    entry.references.map((reference) => `${reference}\0${entry.test}`)
  )));
  const moduleMapsToTest = (file) => {
    const visited = new Set([file]);
    const queue = [file];
    while (queue.length) {
      const dependency = queue.pop();
      for (const importer of reverse.get(dependency) || []) {
        if (testSet.has(importer)) return true;
        if (!visited.has(importer)) {
          visited.add(importer);
          queue.push(importer);
        }
      }
    }
    return graph.tests.some((testFile) => (
      referencedByTest.has(`${file}\0${testFile}`)
    ));
  };
  const unmappedModules = changed.filter((file) => (
    file.endsWith('.mjs')
      && !testSet.has(file)
      && !DOCUMENTATION.test(file)
      && !moduleMapsToTest(file)
  ));
  const fallbackFiles = Object.freeze([
    ...new Set([...globalFallbackFiles, ...unmappedModules]),
  ].sort());
  const fullFallback = fallbackFiles.length > 0;
  const selectedTests = Object.freeze(
    (fullFallback ? [...graph.tests] : [...selected]).sort(),
  );
  const payload = {
    version: 1,
    kind: 'TestImpactSelection',
    status: fullFallback
      ? 'test_impact_selection_full_fallback'
      : selectedTests.length
        ? 'test_impact_selection_ready'
        : 'test_impact_selection_no_tests_required',
    testImpactGraphHash: graph.testImpactGraphHash,
    changedFiles: changed,
    fullFallback,
    fallbackFiles,
    selectedTestCount: selectedTests.length,
    totalTestCount: graph.testCount,
    selectedTests,
  };
  return Object.freeze({
    ...payload,
    testImpactSelectionHash: hashRecord('TestImpactSelection', payload),
  });
}

export function shardImpactedTests(tests, { shardCount = 1, shardIndex = 0 } = {}) {
  if (!Array.isArray(tests) || !Number.isSafeInteger(shardCount)
    || shardCount < 1 || shardCount > 8 || !Number.isSafeInteger(shardIndex)
    || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error('test_impact_shard_configuration_invalid');
  }
  return Object.freeze([...new Set(tests.map(repositoryPath))]
    .sort()
    .filter((testFile) => {
      const digest = hashRecord('TestImpactShardAssignment', { testFile })
        .slice('sha256:'.length, 'sha256:'.length + 8);
      return Number.parseInt(digest, 16) % shardCount === shardIndex;
    }));
}
