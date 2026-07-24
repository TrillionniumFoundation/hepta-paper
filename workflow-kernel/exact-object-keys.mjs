export function hasExactObjectKeys(value, expectedKeys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expectedKeys].sort().join('\0'));
}

// Security-sensitive protocol records often require an ordinary JSON object,
// not merely an object-shaped value with a class or null prototype. Callers
// pass their canonical key list in sorted order, matching the existing ABI.
export function hasExactPlainObjectKeys(value, expectedKeys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expectedKeys));
}
