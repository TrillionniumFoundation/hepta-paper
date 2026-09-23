function isJsonContainer(value) {
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function enumerableDataValues(value) {
  const values = [];
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    values.push(descriptor.value);
  }
  return values;
}

export function deepFreezeJsonValue(value) {
  if (!value || typeof value !== 'object') return value;
  const pending = [value];
  const seen = new WeakSet();
  while (pending.length) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) continue;
    if (!isJsonContainer(candidate)) {
      throw new Error('deep_freeze_json_value_non_json_container');
    }
    const values = enumerableDataValues(candidate);
    if (!values) throw new Error('deep_freeze_json_value_accessor_forbidden');
    seen.add(candidate);
    Object.freeze(candidate);
    pending.push(...values);
  }
  return value;
}

export function isDeeplyFrozenJsonValue(value) {
  if (!value || typeof value !== 'object') return true;
  const pending = [value];
  const seen = new WeakSet();
  while (pending.length) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) continue;
    if (!isJsonContainer(candidate) || !Object.isFrozen(candidate)) return false;
    const values = enumerableDataValues(candidate);
    if (!values) return false;
    seen.add(candidate);
    pending.push(...values);
  }
  return true;
}
