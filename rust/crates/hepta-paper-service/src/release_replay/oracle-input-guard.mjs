// Shared byte/depth/node/schema bounds for the two fixed oracle programs.
import replayInputFs from 'node:fs';
export function readBoundedReplayInput(family) {
  const maximumBytes = 4 * 1024 * 1024;
  const chunks = [];
  let observed = 0;
  while (observed < maximumBytes) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, maximumBytes - observed));
    const count = replayInputFs.readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    observed += count;
    chunks.push(buffer.subarray(0, count));
  }
  if (observed === maximumBytes) throw new Error('release_replay_oracle_input_budget_exhausted');
  const corpus = JSON.parse(Buffer.concat(chunks, observed).toString('utf8'));
  const pending = [[corpus, 0]];
  let nodes = 0;
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (++nodes > 100000 || depth > 32) throw new Error('release_replay_oracle_structure_budget_exhausted');
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push([child, depth + 1]);
    }
  }
  const fields = family === 'production'
    ? ['version', 'createdAt', 'baseSnapshots', 'extendedSnapshots', 'artifactCases', 'frontierCases', 'shardCases']
    : ['version', 'baseCaseCount', 'cases'];
  if (!corpus || Array.isArray(corpus) || typeof corpus !== 'object' || corpus.version !== 1
      || JSON.stringify(Object.keys(corpus).sort()) !== JSON.stringify(fields.sort())) {
    throw new Error('release_replay_oracle_corpus_invalid');
  }
  const lists = family === 'production' ? fields.filter(name => !['version', 'createdAt'].includes(name)) : ['cases'];
  if (lists.some(name => !Array.isArray(corpus[name]) || corpus[name].length > 1024)) {
    throw new Error('release_replay_oracle_corpus_invalid');
  }
  if (family === 'production' && (typeof corpus.createdAt !== 'string'
      || [...corpus.baseSnapshots, ...corpus.extendedSnapshots, ...corpus.artifactCases]
        .some(row => Buffer.byteLength(JSON.stringify(row)) > 64 * 1024)
      || corpus.shardCases.some(row => !row || typeof row !== 'object' || Array.isArray(row)
        || JSON.stringify(Object.keys(row).sort()) !== '["frontier","workerLimit"]'))) {
    throw new Error('release_replay_oracle_corpus_invalid');
  }
  if (family === 'referee' && (!Number.isSafeInteger(corpus.baseCaseCount) || corpus.baseCaseCount < 0
      || corpus.baseCaseCount > corpus.cases.length || corpus.cases.some(row => !row || Array.isArray(row)
      || typeof row !== 'object' || JSON.stringify(Object.keys(row).sort()) !== '["args","name"]'
      || typeof row.name !== 'string' || !Array.isArray(row.args) || row.args.length > 5))) {
    throw new Error('release_replay_oracle_corpus_invalid');
  }
  return corpus;
}
