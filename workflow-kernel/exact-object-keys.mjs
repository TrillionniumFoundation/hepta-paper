export function hasExactObjectKeys(value, expectedKeys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expectedKeys].sort().join('\0'));
}

// Security-sensitive protocol records often require an ordinary JSON object,
// not merely an object-shaped value with a class or null prototype. Callers
// Key order is never authority-bearing; compare canonical sorted inventories.
export function hasExactPlainObjectKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  return Array.isArray(expectedKeys)
    && ownKeys.every((key) => typeof key === 'string')
    && JSON.stringify([...ownKeys].sort())
      === JSON.stringify([...expectedKeys].sort())
    && ownKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(descriptor && Object.hasOwn(descriptor, 'value')
        && descriptor.enumerable === true);
    });
}
