import fs from 'node:fs';
import path from 'node:path';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const MAX_INDEX_FILES = 20_000;
const MAX_INDEX_BYTES = 256 * 1024 * 1024;
const DECLARATION =
  /^\s*(?:theorem|lemma|def|abbrev|class|structure|inductive)\s+([A-Za-z_][A-Za-z0-9_'.]*)/gm;

function mathlibFiles(root) {
  const candidate = path.join(root, '.lake', 'packages', 'mathlib');
  if (!fs.existsSync(candidate)) return [];
  const files = [];
  let bytes = 0;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('formal_mathlib_index_symlink_forbidden');
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile() && entry.name.endsWith('.lean')) {
        bytes += stat.size;
        if (files.length >= MAX_INDEX_FILES || bytes > MAX_INDEX_BYTES) {
          throw new Error('formal_mathlib_index_size_exceeded');
        }
        const content = fs.readFileSync(absolute, 'utf8');
        files.push(Object.freeze({
          path: path.relative(candidate, absolute).replace(/\\/g, '/'),
          hash: hashBytes(Buffer.from(content, 'utf8')),
          content,
        }));
      }
    }
  };
  visit(candidate);
  return files;
}

function dslSearchTerms(dsl) {
  const values = new Set(dsl.binders.map((binder) => binder.domain.kind));
  const visitTerm = (term) => {
    values.add(term.kind);
    if (term.left) visitTerm(term.left);
    if (term.right) visitTerm(term.right);
  };
  for (const relation of [...dsl.assumptions, dsl.conclusion]) {
    values.add(relation.relation);
    visitTerm(relation.left);
    visitTerm(relation.right);
  }
  return [...values].sort();
}

export function buildPinnedMathlibSymbolSearchReceipt({ root, dsl }) {
  const query = dslSearchTerms(dsl);
  try {
    const files = mathlibFiles(root);
    const indexManifest = Object.freeze(files.map((file) => Object.freeze({
      path: file.path,
      hash: file.hash,
    })));
    const symbols = [];
    for (const file of files) {
      for (const match of file.content.matchAll(DECLARATION)) {
        symbols.push(Object.freeze({
          name: match[1],
          sourcePath: file.path,
          sourceHash: file.hash,
        }));
      }
    }
    const ranked = symbols.map((symbol) => ({
      ...symbol,
      score: query.filter((term) => (
        symbol.name.toLowerCase().includes(term.toLowerCase())
      )).length,
    })).filter((symbol) => symbol.score > 0)
      .sort((left, right) => right.score - left.score
        || left.name.localeCompare(right.name))
      .slice(0, 64);
    const payload = {
      version: 1,
      kind: 'PinnedMathlibSymbolSearchReceipt',
      status: files.length
        ? 'pinned_mathlib_symbol_search_completed'
        : 'pinned_mathlib_symbol_index_unavailable',
      query: Object.freeze(query),
      queryHash: hashRecord('PinnedMathlibSymbolSearchQuery', query),
      indexFileCount: files.length,
      indexManifest,
      indexManifestHash: hashRecord('PinnedMathlibSymbolIndexManifest', indexManifest),
      symbolCount: symbols.length,
      results: Object.freeze(ranked),
      resultHash: hashRecord('PinnedMathlibSymbolSearchResults', ranked),
      networkAccessAllowed: false,
      blockers: Object.freeze(files.length ? [] : ['pinned_mathlib_source_index_missing']),
    };
    return Object.freeze({
      ...payload,
      pinnedMathlibSymbolSearchReceiptHash:
        hashRecord('PinnedMathlibSymbolSearchReceipt', payload),
    });
  } catch (error) {
    const payload = {
      version: 1,
      kind: 'PinnedMathlibSymbolSearchReceipt',
      status: 'pinned_mathlib_symbol_search_blocked',
      query: Object.freeze(query),
      queryHash: hashRecord('PinnedMathlibSymbolSearchQuery', query),
      indexFileCount: 0,
      indexManifest: Object.freeze([]),
      indexManifestHash: null,
      symbolCount: 0,
      results: Object.freeze([]),
      resultHash: hashRecord('PinnedMathlibSymbolSearchResults', []),
      networkAccessAllowed: false,
      blockers: Object.freeze([String(error?.message || error)]),
    };
    return Object.freeze({
      ...payload,
      pinnedMathlibSymbolSearchReceiptHash:
        hashRecord('PinnedMathlibSymbolSearchReceipt', payload),
    });
  }
}

export function verifyPinnedMathlibSymbolSearchReceipt(receipt, { dsl } = {}) {
  const { pinnedMathlibSymbolSearchReceiptHash, ...payload } = receipt || {};
  const query = dslSearchTerms(dsl);
  const manifest = Array.isArray(receipt?.indexManifest) ? receipt.indexManifest : [];
  const results = Array.isArray(receipt?.results) ? receipt.results : [];
  const manifestByPath = new Map(manifest.map((entry) => [entry?.path, entry?.hash]));
  const expectedResults = results.map((entry) => ({
    ...entry,
    score: query.filter((term) => String(entry?.name || '').toLowerCase()
      .includes(term.toLowerCase())).length,
  })).sort((left, right) => right.score - left.score
    || String(left.name).localeCompare(String(right.name)));
  return receipt?.version === 1
    && receipt?.kind === 'PinnedMathlibSymbolSearchReceipt'
    && receipt?.status === 'pinned_mathlib_symbol_search_completed'
    && receipt?.networkAccessAllowed === false
    && Array.isArray(receipt?.blockers) && receipt.blockers.length === 0
    && JSON.stringify(receipt.query) === JSON.stringify(query)
    && receipt.queryHash === hashRecord('PinnedMathlibSymbolSearchQuery', query)
    && receipt.indexFileCount === manifest.length && manifest.length > 0
    && manifest.every((entry) => typeof entry?.path === 'string'
      && /^[^/](?:.*[^/])?\.lean$/.test(entry.path)
      && /^sha256:[0-9a-f]{64}$/.test(String(entry.hash || '')))
    && new Set(manifest.map((entry) => entry.path)).size === manifest.length
    && receipt.indexManifestHash
      === hashRecord('PinnedMathlibSymbolIndexManifest', manifest)
    && results.length <= 64
    && results.every((entry) => manifestByPath.get(entry?.sourcePath) === entry?.sourceHash
      && Number.isInteger(entry?.score) && entry.score > 0)
    && JSON.stringify(results) === JSON.stringify(expectedResults)
    && receipt.resultHash === hashRecord('PinnedMathlibSymbolSearchResults', results)
    && Number.isSafeInteger(receipt.symbolCount)
    && receipt.symbolCount >= results.length
    && pinnedMathlibSymbolSearchReceiptHash
      === hashRecord('PinnedMathlibSymbolSearchReceipt', payload);
}
