export function hasExactObjectKeys(value, expectedKeys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expectedKeys].sort().join('\0'));
}
