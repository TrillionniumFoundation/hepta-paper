const runtimeRoot = process.env.HEPTA_TEST_RUNTIME_ROOT;
if (typeof runtimeRoot !== 'string' || runtimeRoot.length === 0) {
  throw new Error('test_runtime_root_missing');
}
export const defaultPaperRuntimeRoot = () => runtimeRoot;
