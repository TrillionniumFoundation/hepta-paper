const METRIC_TOKEN = Symbol('metric-token');
const METRIC_VIEW = Symbol('metric-view');
const METRIC_DESCRIPTOR = Symbol('metric-descriptor');

class MetricToken {
  constructor(index) {
    this[METRIC_TOKEN] = index;
    Object.freeze(this);
  }
}

class MetricView {
  constructor(collector, transforms = []) {
    this.collector = collector;
    this.transforms = transforms;
    this[METRIC_VIEW] = true;
    Object.freeze(this);
  }

  filter(predicate) {
    return new MetricView(this.collector, [...this.transforms, Object.freeze({ kind: 'filter', apply: predicate })]);
  }

  map(selector) {
    return new MetricView(this.collector, [...this.transforms, Object.freeze({ kind: 'map', apply: selector })]);
  }

  reduce(reducer, initialValue) {
    return this.collector.register({ kind: 'reduce', transforms: this.transforms, reducer, initialValue });
  }

  max(selector, initialValue = 0) {
    return this.collector.register({
      kind: 'max',
      transforms: [...this.transforms, Object.freeze({ kind: 'map', apply: selector })],
      initialValue,
    });
  }

  get length() {
    return this.collector.register({ kind: 'count', transforms: this.transforms, initialValue: 0 });
  }
}

function applyTransforms(value, transforms) {
  let current = value;
  for (const transform of transforms) {
    if (transform.kind === 'filter') {
      if (!transform.apply(current)) return { present: false, value: undefined };
    } else {
      current = transform.apply(current);
    }
  }
  return { present: true, value: current };
}

function resolveTokens(value, states) {
  if (value?.[METRIC_TOKEN] !== undefined) return states[value[METRIC_TOKEN]];
  if (Array.isArray(value)) return value.map((item) => resolveTokens(item, states));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveTokens(item, states)]));
}

export function createResultMetricCollector(inputResults = []) {
  const source = Array.isArray(inputResults) ? inputResults : [];
  const descriptors = [];
  const collector = {
    register(descriptor) {
      const index = descriptors.length;
      descriptors.push(Object.freeze({ ...descriptor, transforms: Object.freeze([...(descriptor.transforms || [])]) }));
      return new MetricToken(index);
    },
    resolve(summary) {
      const states = descriptors.map((descriptor) => descriptor.initialValue);
      // This is the only traversal of the source result array. Every registered
      // metric descriptor is evaluated while the current result is hot.
      for (const result of source) {
        for (const [index, descriptor] of descriptors.entries()) {
          const transformed = applyTransforms(result, descriptor.transforms);
          if (!transformed.present) continue;
          if (descriptor.kind === 'count') states[index] += 1;
          else if (descriptor.kind === 'reduce') states[index] = descriptor.reducer(states[index], transformed.value);
          else if (descriptor.kind === 'max') states[index] = Math.max(states[index], Number(transformed.value));
        }
      }
      return resolveTokens(summary, states);
    },
  };
  collector.results = new MetricView(collector);
  return collector;
}

export function isMetricResultView(value) {
  return value?.[METRIC_VIEW] === true;
}

function descriptor(kind, evaluate) {
  if (typeof evaluate !== 'function') throw new Error(`Result metric ${kind} evaluator is required`);
  return Object.freeze({ [METRIC_DESCRIPTOR]: true, kind, evaluate });
}

export const resultMetric = Object.freeze({
  count: (predicate) => descriptor('count', (results) => results.filter(predicate).length),
  reduce: (reducer, initialValue) => descriptor('reduce', (results) => results.reduce(reducer, initialValue)),
  sum: (selector) => descriptor('sum', (results) => results.reduce((total, result) => (
    total + Number(selector(result) || 0)
  ), 0)),
  max: (selector, initialValue = 0) => descriptor('max', (results) => results.max(selector, initialValue)),
});

export function registerResultMetricTable(results, table) {
  if (!isMetricResultView(results)) throw new Error('Result metric table requires a MetricView');
  if (!table || typeof table !== 'object') throw new Error('Result metric table is required');
  return Object.fromEntries(Object.entries(table).map(([name, value]) => {
    if (value?.[METRIC_DESCRIPTOR] === true) return [name, value.evaluate(results)];
    return [name, registerResultMetricTable(results, value)];
  }));
}
