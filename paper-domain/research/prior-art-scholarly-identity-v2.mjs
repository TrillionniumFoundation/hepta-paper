import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const DOI = /^10\.\d{4,9}\/[a-z0-9][a-z0-9+._;()/:\-]{0,500}$/;
const ARXIV_NEW = /^\d{4}\.\d{4,5}(?:v[1-9]\d*)?$/;
const ARXIV_OLD = /^[a-z][a-z0-9.-]*\/\d{7}(?:v[1-9]\d*)?$/;
const OPEN_ALEX = /^W[1-9]\d{0,19}$/;
const IDENTIFIER_KEYS = Object.freeze(['arxiv', 'doi', 'openAlex', 'url']);

function normalizedText(value, maximum) {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return text && text.length <= maximum ? text : null;
}

function resolverIdentifier(value, { hostnames, pathnamePrefixes, suffix = '' }) {
  const text = normalizedText(value, 2_000);
  if (!text || !/^https?:\/\//i.test(text)) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (!hostnames.includes(url.hostname.toLowerCase()) || url.username || url.password
    || url.search || url.hash) return null;
  const prefix = pathnamePrefixes.find((candidate) => url.pathname.startsWith(candidate));
  if (prefix === undefined) return null;
  let selected = url.pathname.slice(prefix.length);
  if (suffix && selected.toLowerCase().endsWith(suffix)) {
    selected = selected.slice(0, -suffix.length);
  }
  try { return decodeURIComponent(selected); } catch { return null; }
}

export function normalizePriorArtDoi(value) {
  if (value === null) return null;
  let selected = resolverIdentifier(value, {
    hostnames: ['doi.org', 'dx.doi.org'], pathnamePrefixes: ['/'],
  });
  if (selected === null) {
    selected = normalizedText(value, 512);
    if (!selected) return null;
    selected = selected.replace(/^doi\s*:\s*/i, '');
  }
  const canonical = selected.normalize('NFKC').trim().toLowerCase();
  const forbidden = [...canonical].some((character) => {
    const codePoint = character.codePointAt(0);
    return /\s/.test(character) || codePoint <= 31 || codePoint === 127;
  });
  return canonical.length <= 512 && !forbidden && DOI.test(canonical) ? canonical : null;
}

export function normalizePriorArtArxiv(value) {
  if (value === null) return null;
  let selected = resolverIdentifier(value, {
    hostnames: ['arxiv.org', 'www.arxiv.org'],
    pathnamePrefixes: ['/abs/', '/pdf/'], suffix: '.pdf',
  });
  if (selected === null) {
    selected = normalizedText(value, 512);
    if (!selected) return null;
    selected = selected.replace(/^arxiv\s*:\s*/i, '');
  }
  const canonical = selected.normalize('NFKC').trim().toLowerCase();
  return canonical.length <= 512 && (ARXIV_NEW.test(canonical) || ARXIV_OLD.test(canonical))
    ? canonical : null;
}

export function normalizePriorArtOpenAlex(value) {
  if (value === null) return null;
  let selected = resolverIdentifier(value, {
    hostnames: ['openalex.org', 'www.openalex.org'], pathnamePrefixes: ['/'],
  });
  if (selected === null) {
    selected = normalizedText(value, 512);
    if (!selected) return null;
    selected = selected.replace(/^openalex\s*:\s*/i, '');
  }
  const canonical = selected.normalize('NFKC').trim().toUpperCase();
  return OPEN_ALEX.test(canonical) ? canonical : null;
}

function normalizePriorArtUrl(value) {
  if (value === null) return null;
  const selected = normalizedText(value, 2_000);
  if (!selected) return null;
  let url;
  try { url = new URL(selected); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  url.hash = '';
  const entries = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey,
    rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  url.search = '';
  for (const [key, entryValue] of entries) url.searchParams.append(key, entryValue);
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

function arxivBaseId(value) {
  return value ? value.replace(/v[1-9]\d*$/, '') : null;
}

export function canonicalPriorArtIdentifiers(value) {
  if (!hasExactObjectKeys(value, IDENTIFIER_KEYS)) return null;
  const identifiers = Object.freeze({
    doi: normalizePriorArtDoi(value.doi),
    arxiv: normalizePriorArtArxiv(value.arxiv),
    openAlex: normalizePriorArtOpenAlex(value.openAlex),
    url: normalizePriorArtUrl(value.url),
  });
  if ((value.doi !== null && !identifiers.doi)
    || (value.arxiv !== null && !identifiers.arxiv)
    || (value.openAlex !== null && !identifiers.openAlex)
    || (value.url !== null && !identifiers.url)
    || (!identifiers.doi && !identifiers.arxiv && !identifiers.openAlex)) return null;
  return identifiers;
}

export function priorArtIdentityKeys(identifiers) {
  return Object.freeze([
    ...(identifiers.doi ? [`doi:${identifiers.doi}`] : []),
    ...(identifiers.arxiv ? [`arxiv:${arxivBaseId(identifiers.arxiv)}`] : []),
    ...(identifiers.openAlex ? [`openalex:${identifiers.openAlex}`] : []),
  ]);
}

export function primaryPriorArtIdentity(identifiers) {
  const [scheme, value] = identifiers.doi ? ['doi', identifiers.doi]
    : identifiers.arxiv ? ['arxiv', arxivBaseId(identifiers.arxiv)]
      : ['openalex', identifiers.openAlex];
  const payload = { scheme, value };
  return Object.freeze({
    ...payload,
    canonicalIdentityHash: hashRecord('PriorArtCanonicalIdentityV2', payload),
  });
}
