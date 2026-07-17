import path from 'node:path';

export function heptaStorePath(root, runtimeRoot = null) {
  return path.join(
    runtimeRoot ? path.resolve(runtimeRoot) : path.join(path.resolve(root), 'hepta-paper-workspace', 'runtime'),
    'hepta-paper.sqlite',
  );
}
